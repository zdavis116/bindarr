// DECK VIEW — built to the approved mockup (sketches/009-deck-view).
//
// Zach on the previous screen: "this is horrible so cluttered. The mockup was
// so clean and simple." He reviewed this mock line by line and approved it, so
// the mock is the SPEC here, not the inspiration -- the mistake that produced
// three rounds of rework on Collection and the deck list.
//
// WHAT IS DELIBERATELY ABSENT, agreed before building: checkout / in-play, the
// printing picker, card categories, playtest. Zach: "a play test would be nice
// eventually but for now it would be unused."

import { useState, useMemo, useEffect, useRef } from 'react';
import CardSearchResult from './CardSearchResult.jsx';
import { ChevronLeft, Search, X, AlertTriangle, Plus, Minus,
         Trash2, Lightbulb, ArrowDownToLine, ChevronDown, BarChart3 } from 'lucide-react';
import { useT } from '../utils/i18n';
import DeckCompareModal from './DeckCompareModal';
import { useIsDesktop } from '../utils/breakpoints';
import CurveTab from './CurveTab';
import { formatPrice } from '../utils/formatPrice';
import ExportModal from './ExportModal';
import CardInspectorModal from './CardInspectorModal';
import { Z_BACKDROP, Z_MODAL } from '../utils/zLayers';

// SECTIONING LIVES IN ONE PLACE: deckListSections.js.
//
// It used to live here, and the compare screen grew a near-copy that silently
// disagreed (no Battle section, plural labels). Both screens now call the same
// function, so "organize it like the deck view" is enforced by construction
// rather than by me matching it by eye.
import { groupIntoSections } from './deckListSections.js';
import { isBasicLand } from '../utils/basicLands';

// The section order, the type PRIORITY (Land beats Creature beats Artifact) and
// the type_line parsing all moved into deckListSections.js, which the compare
// screen calls too. A copy here is exactly what let the two disagree.

// The formats buildDeckExport ACTUALLY produces. Verified against
// utils/deckText.js rather than assumed:
//
//   buylist + brackets     -> "1 Sol Ring [C21] 263"   (Moxfield, Archidekt)
//   buylist + parentheses  -> "1 Sol Ring (C21) 263"   (MTG Arena, Manapool)
//   plain                  -> "1 Sol Ring"             (a shop's search box)
//
// Named for where they are pasted, because that is the question being asked.
// The mock drew five chips including Manapool; four of them would have emitted
// identical text, which is worse than three honest ones -- an export that looks
// richer than it is hands over the wrong format silently.
// 30px tap targets: this row is used one-handed while holding cards.
const QTY_BTN = {
  width: 30, height: 30, borderRadius: 'var(--radius-sm)', border: 0,
  background: 'var(--surface-3)', color: 'var(--text-primary)',
  display: 'grid', placeItems: 'center', cursor: 'pointer', flexShrink: 0,
};


// Both timestamp shapes appear in moxfield_synced_at: Moxfield's ISO string on
// decks synced since the format fix, and SQLite's '2026-09-04 12:04:21' on
// older rows. Safari returns NaN for the space form, so it is normalised rather
// than trusted. Same rule as DeckList's copy; duplicated deliberately rather
// than exported, because these two files share no util module today.
function relativeSync(raw, t) {
  if (!raw) return '';
  const iso = String(raw).includes('T') ? raw : String(raw).replace(' ', 'T') + 'Z';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return t('moxfield.justNow');
  if (mins < 60) return t('moxfield.minsAgo', { count: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return t('moxfield.hoursAgo', { count: hrs });
  return t('moxfield.daysAgo', { count: Math.round(hrs / 24) });
}

function DeckView({ deck, onBack, onChanged, showToast }) {
  const { t } = useT();

  const [tab, setTab] = useState('all');
  const [syncingMoxfield, setSyncingMoxfield] = useState(false);
  const [moxPlan, setMoxPlan] = useState(null);
  const [moxDetail, setMoxDetail] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // One in-flight write at a time: two overlapping absolute-quantity
  // writes can land out of order and persist the older number.
  const [busy, setBusy] = useState(false);
  // The card being inspected. Read-only: see the note above the modal.
  const [inspecting, setInspecting] = useState(null);
  const [commanderOpen, setCommanderOpen] = useState(false);
  const [commanderSearch, setCommanderSearch] = useState('');
  const [commanderResults, setCommanderResults] = useState([]);
  // { card, removing, message } while the server is asking whether it may
  // remove off-colour cards. Null the rest of the time.
  const [swapConfirm, setSwapConfirm] = useState(null);
  // Rows that could use a printing he owns AND has free right now.
  // Null until fetched; the banner only appears when there is something to do.
  const [repoint, setRepoint] = useState(null);
  const [repointBusy, setRepointBusy] = useState(false);
  // "See changes" on the repoint banner, matching the Moxfield drift panel:
  // false = collapsed, true = the list of cards it would switch is expanded
  // inline. Zach: "Can this work just like the moxfield sync?"
  const [repointDetail, setRepointDetail] = useState(false);

  // Apply the bulk repoint. Lives here rather than inline on the button so
  // there is ONE named path to the write -- easy to grep, and a later edit
  // cannot quietly add a second one.
  const applyRepointAll = async () => {
    setRepointBusy(true);
    try {
      const res = await fetch(`/api/decks/${deck.id}/repoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || t('deck.repointFailed'));
        return;
      }
      // The server's own count, not the length of the list we showed.
      showToast(t('deck.repointDone', { count: data.changed }));
      setRepoint(null);
      onChanged && onChanged();
    } catch {
      showToast(t('deck.repointFailed'));
    } finally {
      setRepointBusy(false);
    }
  };
  // Bumped whenever anything changes what a deck row asks for, so the
  // candidate count refetches.
  const [repointVersion, setRepointVersion] = useState(0);
  const searchRef = useRef(null);

  const cards = useMemo(() => deck?.cards || [], [deck]);

  const isDesktop = useIsDesktop();
  const sidePaneRef = useRef(null);

  // WHICH CARD THE RIGHT PANE IS SHOWING.
  //
  // Separate state from `inspecting` on purpose. `inspecting` means "the user
  // opened a modal"; this means "the pane has a subject", and the pane always
  // has one -- it defaults to the commander on load. Sharing one state would
  // make the phone open a modal on load.
  const [selectedCardId, setSelectedCardId] = useState(null);

  // The commander is the default subject. Falls back to the first card for a
  // deck with no command zone (a 60-card deck), and is null only for an empty
  // deck, which is the one case the pane does not render.
  // DISMISSED, as distinct from "nothing selected".
  //
  // The pane falls back to the commander when nothing is selected, which is
  // what makes it useful on load -- but it also means clearing the selection
  // cannot close it. Without a separate flag, closing the pane would instantly
  // reopen it on the commander.
  //
  // Zach: "being able to close the right panel... I would like to be hide it."
  // So dismissal is its own state, and ANY new selection clears it -- tapping a
  // card is the way back, exactly as it is on the collection screen.
  const [detailDismissed, setDetailDismissed] = useState(false);

  // SELECTING A CARD, from anywhere in the deck view.
  //
  // One function because "tap a card" must mean the same thing on every list
  // in this screen, and because tapping the ALREADY-SELECTED card toggles the
  // pane shut (Zach asked for both an X and click-again). Two call sites doing
  // this inline is how they would drift.
  const selectDeckCard = (id) => {
    setDetailDismissed(prev => {
      const sameCard = String(selectedCardId) === String(id);
      // Re-tapping the open card closes it; any other tap opens that card.
      if (sameCard && !prev) return true;
      return false;
    });
    setSelectedCardId(id);
  };

  const detailCard = useMemo(() => {
    if (!isDesktop) return null;
    if (detailDismissed) return null;
    const pick = selectedCardId
      ? cards.find(c => String(c.id) === String(selectedCardId))
      : null;
    const fallback = cards.find(c => c.board === 'commander') || cards[0] || null;
    const chosen = pick || fallback;
    if (!chosen) return null;
    // The inspector keys off the CARD id (a card_cache row), but remove and
    // repoint act on the deck_cards row. Both travel, explicitly named, so the
    // pane cannot delete a collection row that happens to share an id -- the
    // exact confusion the modal's onRemoveFromDeck comment warns about.
    return { ...chosen, deckCardId: chosen.id };
  }, [isDesktop, selectedCardId, cards, detailDismissed]);

  // HOW FAR DOWN THE PAGE THE DETAIL PANE STARTS.
  //
  // The pane needs a definite height so its header can pin and its Remove
  // button can anchor to the bottom. That height is "the viewport minus where
  // the pane begins" -- and where it begins is not a constant: the deck title,
  // the drift banner and the progress block above it all vary.
  //
  // THE PANE HEIGHT IS A CONSTANT, so there is nothing to measure.
  //
  // `.deck-panes-side` is `position: sticky; top: 1rem`, which means its
  // viewport top IS 1rem once stuck. The height is `calc(100dvh - 2rem)` in
  // index.css -- no JS, no custom property, nothing that can go stale.
  //
  // This effect used to measure getBoundingClientRect().top into --pane-top.
  // That number is only correct BEFORE the pane sticks; scrolled down, the
  // real top drops to the sticky offset while the variable keeps its initial
  // value, and the pane GROWS. Measured on the collection pane at 1473x736:
  // 497px at rest, 704px after scrolling, bottom at y=720 in a 736 viewport.
  // Zach: "when I scroll down the collection with the right pane open it grows
  // bigger to the point it gets cut off... it should stay the same size from
  // the START."
  //
  // The same measurement previously caused the opposite failure -- read as a
  // PAGE offset it hit 6152px and collapsed the pane to 0px tall ("the whole
  // side panel or card modal disappears"). Two bugs in opposite directions
  // from one variable that never needed to exist.
  //
  // The note about a hard-coded `100vh - 6rem` running 153px past the fold
  // predates `position: sticky` on this element. A non-sticky column really
  // did need its offset subtracted; a sticky one does not.

  // Considering is a different SET of cards, not a filter of the deck. Zach:
  // "Move considering to the chips like owned and missing." They sit outside
  // the 100 and outside the cost to finish -- a maybe must never move the
  // percentage.
  const deckCards = useMemo(() => cards.filter(c => c.board !== 'considering'), [cards]);
  const considering = useMemo(() => cards.filter(c => c.board === 'considering'), [cards]);

  const counts = useMemo(() => {
    const total = deckCards.reduce((n, c) => n + (c.quantity || 0), 0);
    // AVAILABLE, not owned: a copy sleeved into another deck cannot fill this
    // deck's slot, so counting it would report a deck as more finished than it
    // is. quantity_available is owned minus what other decks have claimed.
    const owned = deckCards.reduce((n, c) => n + Math.min(c.quantity || 0, c.quantity_available || 0), 0);
    const missing = deckCards.reduce((n, c) => n + (c.quantity_missing || 0), 0);
    return {
      total,
      owned,
      missing,
      considering: considering.reduce((n, c) => n + (c.quantity || 0), 0),
    };
  }, [deckCards, considering]);

  const target = deck?.target_size || 100;
  const pct = target ? Math.min(100, Math.round((counts.owned / target) * 100)) : 0;

  // Cost to finish, from the price the SERVER sends. Not computed from an
  // invented field -- the multi-deck buylist read $0.00 for two rounds because
  // I made up a `price` key that no endpoint returns.
  const costToFinish = useMemo(
    () => deckCards.reduce((sum, c) => sum + (c.quantity_missing || 0) * (c.price_trend || 0), 0),
    [deckCards]);

  // TWO TOTALS, BOTH TRUE, AND THE DIFFERENCE MADE VISIBLE.
  //
  // Zach: "where does that 142.51 come from that is on the deck... but when I go
  // to buylist it shows 126. Shouldn't it be 126? Or is that 142.51 the total
  // for the exact printings?"
  //
  // He read it correctly, and the two figures reconcile to the cent:
  //   $142.51 the printings the decklist names
  //   -$15.26 savings from 25 cheaper printings of the same cards
  //   =$127.25 the estimate
  //
  // The bug was that nothing said so. Two totals for the same 49 cards on
  // adjacent screens, with no label explaining that they answer different
  // questions, is the same failure as a price that appears nowhere on the
  // vendor's page: defensible and still misleading.
  //
  // He chose to keep the as-listed figure as the headline and show the saving
  // rather than silently apply it -- the header answers "can I afford to finish
  // this deck", and a saving he can see is worth more than one he cannot.
  const [cheapest, setCheapest] = useState(null);
  useEffect(() => {
    if (!deck?.id || counts.missing === 0) { setCheapest(null); return; }
    let cancelled = false;
    (async () => {
      try {
        // No ?source: the endpoint uses the SHOP HE SELECTED, the same shop
        // the as-listed figure above it comes from.
        //
        // Zach caught this comparing two shops in one subtraction: with Card
        // Kingdom selected the header read "$232.68 to finish, as listed" over
        // "$127.66 cheapest printings - saves $105.02". The first was Card
        // Kingdom, the second Mana Pool, and the saving was fiction. The real
        // Card Kingdom cheapest is $213.21 -- a $19 saving, not $105.
        const r = await fetch(`/api/decks/${deck.id}/buylist/estimate`);
        if (r.ok && !cancelled) {
          const d = await r.json();
          // Only meaningful when it actually differs: an identical number shown
          // twice with a "saves $0.00" note is noise.
          setCheapest(Number.isFinite(d.items) ? d.items : null);
        }
      } catch { /* the second line simply does not render */ }
    })();
    return () => { cancelled = true; };
  }, [deck?.id, counts.missing]);

  const savings = (cheapest !== null && costToFinish > cheapest + 0.005)
    ? costToFinish - cheapest
    : null;

  // Rules to show. Zach cut two: the "short of 100" warning ("the percentage
  // and bar show that already") and the green all-clear ("I can assume that by
  // not seeing any errors/warnings"). What is left only appears when something
  // is actually wrong.
  // Warnings arrive as { code, deck_card_id, message } -- verified against
  // backend/src/utils/deckRules.js, not assumed. Reading `.text` would have
  // rendered a column of blank warning rows: present, alarming, and empty.
  //
  // MISSING_COPIES is filtered out: the Missing tab and the cost-to-finish
  // already say it, and Zach cut the equivalent "short of 100" warning for
  // exactly that reason -- a row that repeats what is above it trains you to
  // skim the rows that matter.
  const rules = useMemo(() => (deck?.warnings || [])
    .filter(w => w?.code !== 'MISSING_COPIES')
    .map(w => (typeof w === 'string'
      ? { level: 'warn', message: w }
      : { level: w.level || 'warn', message: w.message })), [deck]);

  const shown = useMemo(() => {
    if (tab === 'consider') return considering;
    // Owned and Missing must be COMPLEMENTARY: a card belongs to exactly one.
    // Defining Owned as "nothing missing" guarantees that, where a separate
    // quantity_owned test let a card qualify for both.
    if (tab === 'have') return deckCards.filter(c => (c.quantity_missing || 0) === 0);
    if (tab === 'need') return deckCards.filter(c => (c.quantity_missing || 0) > 0);
    return deckCards;
  }, [tab, deckCards, considering]);

  // Grouping is the SHARED rule (deckListSections), not a local copy. Only the
  // count is added here, and it keeps this screen's meaning: a deck row always
  // carries a quantity, so an absent one is a bug rather than a singleton.
  const sections = useMemo(() => groupIntoSections(shown).map((s) => ({
    name: s.name,
    cards: s.cards,
    // Count CARDS, not rows: 34 Mountains is 34.
    count: s.cards.reduce((n, c) => n + (c.quantity || 0), 0),
  })), [shown]);

  // Add a card. Zach: "we need a search to add cards to the deck."
  // WHAT COULD BE REPOINTED.
  //
  // 39 of Zach's 87 Tony Stark rows want a printing he does not own while a
  // copy sits on the shelf: Moxfield gave the deck specific printings, ManaBox
  // gave the collection different ones. Neither is wrong, they disagree.
  //
  // Read-only. Nothing changes until he taps.
  // WHAT THE SYNC WOULD DO, fetched when the deck has drifted.
  //
  // The banner's counts and breakdown come from the plan endpoint, not from
  // anything computed here: the preview must name the same printings the apply
  // will store, and planSync now resolves the owned-copy preference so the two
  // agree by construction.
  useEffect(() => {
    if (!deck?.moxfield_public_id || !deck?.moxfield_changed) {
      setMoxPlan(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/moxfield/decks/${deck.moxfield_public_id}/plan`)
      .then(r => (r.ok ? r.json() : null))
      .then(body => { if (!cancelled && body) setMoxPlan(body); })
      // A Moxfield outage must not blank the deck. The banner still offers
      // Sync now; only the breakdown is unavailable.
      .catch(() => {});
    return () => { cancelled = true; };
  }, [deck?.moxfield_public_id, deck?.moxfield_changed, deck?.moxfield_synced_at]);

  useEffect(() => {
    if (!deck?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/decks/${deck.id}/repoint-candidates`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setRepoint(data);
      } catch { /* the banner simply does not appear */ }
    })();
    return () => { cancelled = true; };
    // An explicit counter, not deck.updated_at: nothing touches that column on
    // repoint (the routes write deck_cards only), so the effect never re-ran
    // and the count stayed stale until a manual refresh. Second time today an
    // effect has keyed on a value that does not move when its subject does.
  }, [deck?.id, repointVersion]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/search?name=${encodeURIComponent(q)}&game=mtg`);
        const data = res.ok ? await res.json() : [];
        if (!cancelled) setResults(Array.isArray(data) ? data.slice(0, 8) : []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  useEffect(() => {
    const q = commanderSearch.trim();
    if (!commanderOpen || q.length < 2) { setCommanderResults([]); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?name=${encodeURIComponent(q)}&game=mtg&commanders=1`);
        const data = res.ok ? await res.json() : [];
        if (!cancelled) setCommanderResults(Array.isArray(data) ? data.slice(0, 8) : []);
      } catch {
        if (!cancelled) setCommanderResults([]);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [commanderSearch, commanderOpen]);

  const addCard = async (card) => {
    try {
      const res = await fetch(`/api/decks/${deck.id}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          desired_card_id: card.id,
          desired_finish: 'nonfoil',
          board: 'mainboard',
          quantity: 1,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || t('deck.addFailed'));
      showToast(t('deck.cardAdded', { name: card.name }), 'success');
      setQuery(''); setResults([]);
      onChanged && onChanged();
    } catch (err) {
      showToast(err.message || t('deck.addFailed'), 'error');
    }
  };

  // CORRECT A CARD'S ROLE.
  //
  // Keyed on ORACLE id, so fixing Goldspan Dragon once fixes it in every deck
  // that plays it rather than once per deck.
  //
  // onChanged() refetches the deck rather than patching local state: the role
  // feeds the chart, the legend counts and the filter, and three derived
  // numbers updated by hand is three chances to disagree with the server about
  // what the deck contains.
  const overrideRole = async (card, role) => {
    if (busy) return false;
    setBusy(true);
    try {
      const res = await fetch(`/api/decks/card-role/${encodeURIComponent(card.oracle_id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || t('deck.saveFailed'));
      onChanged && onChanged();
      return true;
    } catch (err) {
      // showToast, like every other handler in this file. This said
      // setError(...), which does not exist here -- so the one path that was
      // supposed to REPORT a failed role save threw its own ReferenceError
      // instead, and the user saw nothing at all. Found by eslint no-undef
      // while chasing the deck-list click bug.
      showToast(err.message || t('deck.saveFailed'), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const writeCard = async (entry, { quantity, board }) => {
    // Absolute-quantity write, shared by the +/- controls and the board moves.
    // Returns true on success so callers can decide whether to refresh.
    if (busy) return false;
    setBusy(true);
    try {
      const res = await fetch(`/api/decks/${deck.id}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          desired_card_id: entry.desired_card_id,
          desired_finish: entry.desired_finish || 'nonfoil',
          board: board ?? entry.board,
          quantity: quantity ?? entry.quantity,
          // Names the row being edited, so the singleton rule excludes it
          // rather than counting it as a duplicate of itself.
          replacing_deck_card_id: entry.id,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || t('deck.saveFailed'));
      onChanged && onChanged();
      return true;
    } catch (err) {
      showToast(err.message || t('deck.saveFailed'), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Removing the last copy is a DELETE, not quantity 0 -- the server rejects a
  // zero requirement, and "take this out of the deck" is a different intent
  // from "I want none of it".
  const removeCard = async (entry) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/decks/${deck.id}/cards/${entry.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || t('deck.saveFailed'));
      }
      onChanged && onChanged();
    } catch (err) {
      showToast(err.message || t('deck.saveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const changeQty = (entry, delta) => {
    const next = (entry.quantity || 1) + delta;
    if (next <= 0) return removeCard(entry);
    return writeCard(entry, { quantity: next });
  };

  // Considering <-> deck, both directions. Zach: "I definitely will be moving
  // cards from consider to deck and vice versa".
  const moveBoard = (entry) =>
    writeCard(entry, { board: entry.board === 'considering' ? 'mainboard' : 'considering' });

  const commander = deckCards.find(c => c.board === 'commander') || null;

  const swapCommander = async (card, confirmRemove = false) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/decks/${deck.id}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          desired_card_id: card.id,
          desired_finish: 'nonfoil',
          board: 'commander',
          quantity: 1,
          // Only when REPLACING one. Adding a second commander to a deck that
          // has one is not an edit and must be judged as a new entry.
          ...(commander ? { replacing_deck_card_id: commander.id } : {}),
          ...(confirmRemove ? { confirm_remove_off_identity: true } : {}),
        }),
      });
      const body = await res.json().catch(() => null);

      // 409 IS A QUESTION, NOT A FAILURE. Nothing has been written. The server
      // is telling us which cards fall outside the new commander's colours.
      if (res.status === 409 && Array.isArray(body?.removing)) {
        setSwapConfirm({ card, removing: body.removing, message: body.error });
        return;
      }
      if (!res.ok) throw new Error(body?.error || t('deck.saveFailed'));

      setSwapConfirm(null);
      setCommanderSearch('');
      setCommanderResults([]);
      setCommanderOpen(false);
      showToast(t('deck.commanderSwapped', { name: card.name }), 'success');
      onChanged && onChanged();
    } catch (err) {
      showToast(err.message || t('deck.saveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  // Copies of a printing in THIS deck. The API's in_deck_qty counts every
  // deck, which is the right number for availability and the wrong one for
  // "is it already here".
  // Decks OTHER than this one that have claimed a copy. in_deck_qty counts
  // every deck, including the one on screen, so this deck's own claim is
  // subtracted -- otherwise a card already added here would be reported as
  // being somewhere else too.
  const elsewhere = (c) => Math.max(0, (c.in_deck_qty || 0) - hereQty(c.id));

  const hereQty = (cardId) => deckCards
    .filter(c => c.desired_card_id === cardId)
    .reduce((n, c) => n + (c.quantity || 0), 0);

  const confirmDelete = async () => {
    // NAMES the deck and states its size. A deck is minutes of work to
    // rebuild, and an unnamed "are you sure" reads the same whether it holds
    // two cards or a hundred.
    const total = deckCards.reduce((n, c) => n + (c.quantity || 0), 0);
    if (!window.confirm(t('deck.confirmDelete', { name: deck.name, count: total }))) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/decks/${deck.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || t('deck.deleteFailed'));
      }
      showToast(t('deck.deleted'), 'success');
      onBack();
    } catch (err) {
      showToast(err.message || t('deck.deleteFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  // Compare against a pre-built deck for sale. Zach: "compare with decks I
  // have already built to see if it makes sense to maybe use some of those
  // cards in my deck."
  const [compareOpen, setCompareOpen] = useState(false);

  const missingCards = deckCards.filter(c => (c.quantity_missing || 0) > 0);



  if (!deck) return null;

  const TABS = [
    { id: 'all', label: t('deck.tabAll'), n: counts.total },
    { id: 'have', label: t('deck.tabOwned'), n: counts.owned },
    { id: 'need', label: t('deck.tabMissing'), n: counts.missing },
    { id: 'consider', label: t('deck.tabConsidering'), n: counts.considering },
  ];

  // CURVE SITS ON ITS OWN ROW, ABOVE THE FILTERS.
  //
  // Zach: "curve kind of hidden which makes me feel like it shouldn't be right
  // there... you can put it above the other row."
  //
  // It was the fifth chip in a row that already scrolls sideways on a phone,
  // so it fell off the edge. It is also a different KIND of control: the other
  // four filter which cards you are looking at, this one changes what the
  // screen is about. Same row on desktop -- he asked for the two widths to
  // mirror each other.
  const isCurve = tab === 'curve';

  return (
    // Clears the pinned mobile nav (72px + the home indicator). Without it
    // the last thing on the page -- the delete button -- sits under the nav.
    <div style={{ paddingBottom: `calc(72px + env(safe-area-inset-bottom, 0px) + 1rem)` }}>
      {/* HEADER */}
      <button onClick={onBack}
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', border: 0,
                 background: 'transparent', color: 'var(--accent-blue)', font: 'inherit',
                 fontSize: '0.95rem', cursor: 'pointer', minHeight: 40, padding: 0, marginBottom: '0.4rem' }}>
        <ChevronLeft size={18} />{t('deck.decks')}
      </button>

      {/* The title is the commander control, as in the mock: name + chevron.
          Only for decks that HAVE a commander -- a Standard deck has no
          command zone, so the affordance must not exist there. */}
      {commander ? (
        <button onClick={() => setCommanderOpen(true)}
          style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', border: 0,
                   background: 'transparent', padding: 0, cursor: 'pointer',
                   color: 'var(--text-primary)', font: 'inherit', textAlign: 'left' }}>
          <h2 style={{ fontSize: '1.45rem', fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}>
            {deck.name}
          </h2>
          <ChevronDown size={17} style={{ opacity: 0.4, flexShrink: 0 }} />
        </button>
      ) : (
        <h2 style={{ fontSize: '1.45rem', fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}>
          {deck.name}
        </h2>
      )}
      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2, marginBottom: '0.9rem' }}>
        {[deck.format,
          t('deck.cardCount', { count: target }),
          // Mock: "Commander · 100 cards · last synced 2 minutes ago". Only on
          // Moxfield decks -- a local deck has no sync to report.
          deck.moxfield_public_id
            ? (deck.moxfield_synced_at
                ? t('deck.lastSynced', { when: relativeSync(deck.moxfield_synced_at, t) })
                : t('decks.neverSynced'))
            : null
        ].filter(Boolean).join(' · ')}
      </div>

      {/* PROGRESS + RULES: one block answers "how close am I" and "is anything
          wrong". Legality is part of "is this deck ready", not a separate
          subject. */}
      <div style={{ background: 'var(--surface-1)', borderRadius: 'var(--radius-md)', padding: '0.95rem', marginBottom: '0.8rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.7rem' }}>
          <div>
            <div style={{ fontSize: '1.95rem', fontWeight: 700, letterSpacing: '-0.04em', lineHeight: 1 }}>
              {pct}<small style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', marginLeft: 3, letterSpacing: 0 }}>
                {t('deck.pctBuilt')}
              </small>
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 3 }}>
              {t('deck.ownedOfTarget', { owned: counts.owned, target })}
            </div>
          </div>
          {costToFinish > 0 && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '1.15rem', fontWeight: 700, letterSpacing: '-0.02em' }}>
                ${formatPrice(costToFinish)}
              </div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 2 }}>
                {savings !== null ? t('deck.toFinishAsListed') : t('deck.toFinish')}
              </div>
              {savings !== null && (
                <div style={{ fontSize: '0.68rem', color: 'var(--accent-green, #30d158)',
                              marginTop: 2, whiteSpace: 'nowrap' }}>
                  {t('deck.toFinishCheapest', {
                    price: formatPrice(cheapest), saved: formatPrice(savings) })}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ height: 6, background: 'var(--surface-3)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent-green)',
                        borderRadius: 3, transition: 'width .5s cubic-bezier(.2,.8,.3,1)' }} />
        </div>

        {/* Rendered ONLY when there is something wrong. An empty rules block
            still draws its border-top, which reads as a broken layout rather
            than a clean deck. */}
        {rules.length > 0 && (
          <div style={{ marginTop: '0.8rem', borderTop: '1px solid var(--border-glass)',
                        paddingTop: '0.7rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
            {rules.map((r, i) => (
              <div key={i} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.78rem', lineHeight: 1.35 }}>
                <span style={{ width: 15, height: 15, borderRadius: '50%', flex: '0 0 15px',
                               display: 'grid', placeItems: 'center', marginTop: 1,
                               background: r.level === 'error' ? 'rgba(255,69,58,.16)' : 'rgba(255,159,10,.16)',
                               color: r.level === 'error' ? 'var(--accent-red)' : 'var(--accent-yellow)' }}>
                  <AlertTriangle size={9} strokeWidth={3} />
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>{r.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* CARDS THAT COULD USE A PRINTING HE OWNS.
          Moxfield gave the deck specific printings; ManaBox gave the
          collection different ones. Neither is wrong -- they disagree, and the
          deck then reports a card missing while a copy sits on the shelf.
          Appears only when there is something to fix, and goes once fixed. */}
      {repoint && repoint.auto_applicable > 0 && counts.missing > 0 && (
        <div style={{
          background: 'rgba(74,222,128,0.10)',
          border: '1px solid rgba(74,222,128,0.28)',
          borderRadius: 'var(--radius-md)', padding: '0.85rem 1rem',
          marginBottom: '0.9rem'
        }}>
          <div style={{ fontSize: '0.92rem', fontWeight: 700, marginBottom: '0.2rem' }}>
            {t('deck.repointTitle', { count: repoint.auto_applicable })}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)',
                        marginBottom: '0.7rem', lineHeight: 1.45 }}>
            {t('deck.repointBody')}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {/* THE MOXFIELD SHAPE, because he asked for it by name.
                Zach: "Can this work just like the moxfield sync? Where I can
                just click see changes and see it that way"

                So: act / see changes / dismiss, and the detail expands INLINE
                under the banner rather than opening a dialog. Same classes as
                the drift panel (.mfx-group-label / .mfx-row), because "like
                the moxfield sync" means USE ITS MARKUP, not build something
                that resembles it -- a lookalike drifts the moment one of them
                is restyled.

                The earlier version of this put the preview in a modal. That
                showed the right facts but was a second pattern for the same
                job, and he has said before he dislikes redundant surfaces. */}
            <button
              className="btn btn-primary"
              style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}
              disabled={repointBusy}
              onClick={applyRepointAll}
            >
              {repointBusy ? t('deck.repointApplying') : t('deck.repointApply')}
            </button>
            <button
              className="btn btn-secondary"
              style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}
              onClick={() => setRepointDetail(v => !v)}
            >
              {repointDetail ? t('deck.driftHideChanges') : t('deck.driftSeeChanges')}
            </button>
            <button
              className="btn btn-secondary"
              style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}
              onClick={() => setRepoint(null)}
            >
              {t('deck.repointDismiss')}
            </button>
          </div>

          {/* WHAT ACTUALLY CHANGES, in the drift panel's own markup.
              One row per card: the printing the deck asks for now, the one it
              would move to, and -- when the copies are already sleeved into
              another deck -- a warning. That last fact is the one that would
              have stopped his precon card being taken.

              quantity_owned, NOT owned_qty: deckRepoint.js builds these rows
              and the card sheet's printings list uses a different shape.
              Reading the wrong key fails silently, showing no warning at all,
              which looks exactly like "nothing is committed elsewhere". */}
          {repointDetail ? (
            <div style={{ marginTop: '0.6rem' }}>
              <div className="mfx-group-label">{t('deck.repointGroupSwitching')}</div>
              {(repoint.candidates || []).filter(c => c.unambiguous).map((c) => {
                const to = c.alternatives?.[0];
                const owned = to?.quantity_owned ?? 0;
                const avail = to?.quantity_available ?? owned;
                const spoken = Math.max(0, owned - avail);
                return (
                  <div className="mfx-row" key={c.deck_card_id}>
                    <span className="mfx-row-name">
                      {c.quantity > 1 ? `${c.quantity}× ` : ''}{c.name}
                    </span>
                    <span className="mfx-row-meta">
                      {/* SET CODE AND NUMBER ONLY.
                          .mfx-row-meta is nowrap and does not shrink -- it was
                          sized for the drift panel's "AKH #123 · main". Adding
                          the full set name ("The Lost Caverns of Ixalan
                          Commander") overflowed the row on a phone: the name
                          clipped at the screen edge and the card name wrapped.
                          The code IS the identifier he matches against the
                          card in hand, so the long name was the redundant
                          half. Do not restyle the shared class for one
                          caller -- that drifts both panels. */}
                      {`${String(c.wants?.set_id || '').toUpperCase()} #${c.wants?.number}`}
                      {' → '}
                      {`${String(to?.set_id || '').toUpperCase()} #${to?.number}`}
                    </span>
                    {spoken > 0 ? (
                      <span className="mfx-inuse-tag">
                        {t('deck.repointInUse', { count: spoken })}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      )}

      {/* MOXFIELD HAS CHANGES -- built to sketches/015, which he approved.
          Detection lives on the deck row; the ACTION has to live here, or the
          badge is a dead end: told the deck is stale on a screen with no way
          forward.

          Never automatic. He presses Sync now. A decklist changing under him
          with nothing to point at is the silent state change he has ruled
          out. */}
      {deck?.moxfield_public_id && deck?.moxfield_changed ? (
        <div style={{
          background: 'linear-gradient(180deg, rgba(210,153,34,.10), rgba(210,153,34,.04))',
          border: '1px solid rgba(210,153,34,.32)', borderRadius: '12px',
          padding: '0.9rem', marginBottom: '0.9rem'
        }}>
          <div style={{ fontWeight: 650, fontSize: '0.92rem', marginBottom: '0.25rem' }}>
            {t('deck.moxfieldDriftedTitle')}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
            {t('deck.moxfieldDrifted')}
          </div>

          {/* COUNTS. Only chips with a non-zero count, so the row says what
              changed rather than listing every category every time. */}
          {moxPlan ? (
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', margin: '0.65rem 0' }}>
              {moxPlan.add.length ? (
                <span className="mfx-chip add">
                  <b>+{moxPlan.add.length}</b> {t('deck.driftAdded')}
                </span>
              ) : null}
              {moxPlan.remove.length ? (
                <span className="mfx-chip rm">
                  <b>&minus;{moxPlan.remove.length}</b> {t('deck.driftRemoved')}
                </span>
              ) : null}
              {moxPlan.moveBoard.length ? (
                <span className="mfx-chip mv">
                  <b>{moxPlan.moveBoard.length}</b> {t('deck.driftMoved')}
                </span>
              ) : null}
              {moxPlan.requantify.length ? (
                <span className="mfx-chip qty">
                  <b>{moxPlan.requantify.length}</b> {t('deck.driftRequantified')}
                </span>
              ) : null}
            </div>
          ) : null}

          {/* THE REASSURANCE LINE. The single most important sentence in this
              banner: his repointing survives a sync, and he has asked about
              that more than once. */}
          {moxPlan ? (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
              {t('deck.driftPrintingsKept', { count: moxPlan.uses_owned || 0 })}
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: '0.45rem', marginTop: '0.65rem' }}>
            <button
              className="btn btn-primary"
              disabled={syncingMoxfield}
              onClick={async () => {
                setSyncingMoxfield(true);
                try {
                  const res = await fetch(
                    `/api/moxfield/decks/${deck.moxfield_public_id}/sync`,
                    { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                  const body = await res.json();
                  if (!res.ok) throw new Error(body.error || t('moxfield.syncFailed'));
                  showToast?.(t('moxfield.syncedSummary', {
                    added: body.added, removed: body.removed,
                    moved: body.moved, preferred: body.printing_preferred
                  }));
                  setMoxPlan(null);
                  setMoxDetail(false);
                  onChanged?.();
                } catch (err) {
                  showToast?.(err.message);
                } finally {
                  setSyncingMoxfield(false);
                }
              }}
            >
              {syncingMoxfield ? t('moxfield.syncing') : t('deck.driftSyncNow')}
            </button>
            <button className="btn btn-secondary" onClick={() => setMoxDetail(v => !v)}>
              {moxDetail ? t('deck.driftHideChanges') : t('deck.driftSeeChanges')}
            </button>
          </div>

          {/* WHAT ACTUALLY CHANGES, grouped as in the mock. Every field here
              comes from the plan endpoint -- set_id, number, board, and the
              owned-copy flag planSync now resolves -- rather than being
              inferred in the client. */}
          {moxDetail && moxPlan ? (
            <div style={{ marginTop: '0.5rem' }}>
              {/* EVERY GROUP THE CHIPS COUNT MUST HAVE A ROW HERE.
                  Zach: "when I click see changes it doesn't show me any
                  changes. It looks like it only happens on quantity changes but
                  I should be able to see all changes. Even if it's a count of 2
                  going to 1."

                  requantify was counted in the chips and in `changes`, but had
                  no group in this list -- so a drift made ONLY of quantity
                  changes announced itself and then showed an empty panel. A
                  banner that says "1 quantity changed" and cannot say WHICH is
                  worse than no banner: it reports a state change he cannot
                  inspect before approving.

                  Derived from the plan's own keys rather than a hand-written
                  list, so a future group added to planSync cannot be silently
                  dropped here again. */}
              {[['add', t('deck.driftGroupAdding')],
                ['remove', t('deck.driftGroupRemoving')],
                ['moveBoard', t('deck.driftGroupMoving')],
                ['requantify', t('deck.driftGroupRequantifying')]].map(([key, label]) => (
                  moxPlan[key]?.length ? (
                    <div key={key}>
                      <div className="mfx-group-label">{label}</div>
                      {moxPlan[key].map((row, i) => (
                        <div className="mfx-row" key={`${key}${i}`}>
                          <span className="mfx-row-name">{row.name}</span>
                          <span className="mfx-row-meta">
                            {key === 'moveBoard'
                              ? `${String(row.keeps_printing?.set_id || '').toUpperCase()} #${row.keeps_printing?.number} · ${row.from_board} → ${row.to_board}`
                              : key === 'requantify'
                                // THE NUMBERS THEMSELVES. "1 quantity changed"
                                // does not tell him whether he is gaining or
                                // losing a copy -- 2 → 1 does.
                                ? `${String(row.keeps_printing?.set_id || row.set_id || '').toUpperCase()} #${row.keeps_printing?.number ?? row.number} · ${row.board} · ${row.from} → ${row.to}`
                                : `${String((row.owned_printing?.set_id ?? row.set_id) || '').toUpperCase()} #${row.owned_printing?.number ?? row.number} · ${row.board}`}
                          </span>
                          {row.uses_owned_copy ? (
                            <span className="mfx-owned-tag">{t('deck.driftUsingYourCopy')}</span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null
                ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* THE TWO-PANE REGION, on desktop only.
          Left: search, tabs, the card list. Right: card detail that follows
          your selection. Below 1024px this is one column and the detail opens
          as the modal it has always been -- the grid simply collapses, so the
          phone is untouched. */}
      {/* THE CURVE LAYOUT APPLIES ONLY WHEN NOTHING IS SELECTED.
          Gated on selectedCardId, NOT detailCard: detailCard falls back to the
          commander so the pane is never empty on desktop, which means it is
          never null and this class would never have applied. Measured: the
          list stayed at x=255 under the chart instead of taking the right
          pane. */}
      <div className={`deck-panes${tab === 'curve' && !(isDesktop && selectedCardId) ? ' deck-panes-curve' : ''}`}>
        <div className="deck-panes-main">
      {/* SEARCH SITS ABOVE THE TABS.
          The mockup puts it there, and the order is the point: search spans
          every tab (it adds a card to the deck regardless of which filter you
          are looking at), so placing it under the tabs implied it searched
          within the selected one.

          Same element, same behaviour, moved -- this is a reorder, not a
          rewrite.

          ADD A CARD: always visible, not behind a "+". Adding cards is the main
          thing you do on this screen. */}
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.55rem',
                      background: 'var(--surface-1)', border: '1px solid var(--border-glass)',
                      borderRadius: 'var(--radius-md)', padding: '0 0.85rem', height: 44, marginBottom: '0.75rem' }}>
        <Search size={17} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)}
               placeholder={t('deck.addCardPlaceholder')}
               style={{ border: 0, outline: 'none', background: 'transparent', flex: 1,
                        color: 'var(--text-primary)', font: 'inherit', fontSize: '0.95rem' }} />
        {query && (
          <button onClick={() => { setQuery(''); setResults([]); }} aria-label={t('common.close')}
                  style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>
            <X size={15} />
          </button>
        )}
      </label>

      {/* CURVE — its own row, above the filters. See the note by isCurve. */}
      <div className="deck-analyse-row">
        <button
          type="button"
          className={`deck-analyse-btn${isCurve ? ' on' : ''}`}
          aria-pressed={isCurve}
          onClick={() => setTab(isCurve ? 'all' : 'curve')}
        >
          <BarChart3 size={15} />
          {t('deck.tabCurve')}
        </button>
        {/* COMPARE IS A DECK-LEVEL ACTION, not a Missing-tab one.
            I first put it beside Export, which lives inside
            `tab === 'need' && missingCards.length > 0` -- so it rendered on no
            other tab and I reported it shipped without looking. It belongs in
            this row, which already holds the control that changes what the
            screen is ABOUT rather than which cards are filtered. */}
        <button
          type="button"
          className="deck-analyse-btn"
          onClick={() => setCompareOpen(true)}
        >
          {t('deck.comparePremade')}
        </button>
      </div>

      {/* TABS */}
      <div style={{ display: 'flex', gap: '0.35rem', overflowX: 'auto', paddingBottom: 2, marginBottom: '0.75rem' }}>
        {TABS.map(({ id, label, n }) => {
          const on = tab === id;
          return (
            <button key={id} onClick={() => setTab(id)} role="tab" aria-selected={on}
              style={{ flex: '0 0 auto', padding: '0.4rem 0.8rem', borderRadius: 'var(--radius-sm)',
                       border: `1px solid ${on ? 'var(--accent-blue)' : 'var(--border-glass)'}`,
                       background: on ? 'var(--accent-blue)' : 'var(--surface-1)',
                       color: on ? 'var(--text-on-accent)' : 'var(--text-secondary)',
                       font: 'inherit', fontSize: '0.8rem', fontWeight: 600,
                       whiteSpace: 'nowrap', cursor: 'pointer' }}>
              {label}{n == null ? '' : ` ${n}`}
            </button>
          );
        })}
      </div>

      {/* CURVE replaces the card list, it does not sit above it: it IS a view
          of the same cards. Rendered before the search results block so the
          add-a-card flow still works from this tab. */}
      {tab === 'curve' && (
        <CurveTab
          cards={deckCards}
          commander={deckCards.find(c => c.board === 'commander')
            || deckCards.find(c => /legendary creature/i.test(c.type_line || ''))}
          onSelectCard={(c) => {
            // Same routing as every other row on this screen: the pinned pane
            // on desktop, the modal on the phone.
            if (isDesktop) selectDeckCard(c.id);
            else setInspecting(c);
          }}
          onOverrideRole={overrideRole}
        />
      )}

      {(searching || results.length > 0) && (
        <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-glass)',
                      borderRadius: 'var(--radius-md)', marginBottom: '0.75rem', overflow: 'hidden' }}>
          {searching && !results.length ? (
            <div style={{ padding: '0.75rem 0.85rem', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              {t('common.loading')}
            </div>
          ) : results.map(c => (
            <CardSearchResult
              key={c.id}
              card={c}
              t={t}
              onSelect={addCard}
              trailing={
                <span style={{ flexShrink: 0, textAlign: 'right' }}>
                {hereQty(c.id) > 0 && (
                  <span style={{ display: 'block', fontSize: '0.68rem', fontWeight: 700,
                                 color: 'var(--accent-blue)' }}>
                    {t('deck.alreadyHere', { count: hereQty(c.id) })}
                  </span>
                )}
                {c.owned_qty > 0 ? (
                  <span style={{ display: 'block', fontSize: '0.68rem',
                                 color: c.available_qty > 0 ? 'var(--accent-green)' : 'var(--accent-yellow)' }}>
                    {c.available_qty > 0
                      // Copies genuinely free for this deck.
                      ? t('deck.freeOfOwned', { free: c.available_qty, owned: c.owned_qty })
                      // None free. Say WHERE they went and HOW MANY decks are
                      // involved -- and if more decks claim it than he owns,
                      // say that outright rather than implying it is fine.
                      : (elsewhere(c) > c.owned_qty
                          // `count` is what selects the plural form; the other
                          // names are only interpolated.
                          ? t('deck.overCommitted', {
                              count: elsewhere(c), owned: c.owned_qty, decks: elsewhere(c) })
                          : t('deck.usedInDecks', {
                              count: elsewhere(c), owned: c.owned_qty, decks: elsewhere(c) }))}
                  </span>
                ) : (
                  <span style={{ display: 'block', fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                    {t('deck.notOwned')}
                  </span>
                )}
              </span>
              }
            />
          ))}
        </div>
      )}

      {/* Considering states its exclusion where it is relevant. */}
      {tab === 'consider' && (
        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginBottom: '0.6rem' }}>
          {t('deck.consideringNote')}
        </div>
      )}

      {/* THE MISSING TAB IS THE BUYLIST. No separate panel -- the list of what
          you need and the thing you buy from are the same list. */}
      {tab === 'need' && missingCards.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem',
                      background: 'rgba(255,159,10,.09)', border: '1px solid rgba(255,159,10,.25)',
                      borderRadius: 'var(--radius-md)', padding: '0.75rem 0.8rem', marginBottom: '0.75rem' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>
              {t('deck.cardsToBuy', { count: counts.missing })}
            </div>
            {costToFinish > 0 && (
              <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: 1 }}>
                ${formatPrice(costToFinish)}
                {savings !== null && (
                  <span style={{ color: 'var(--accent-green, #30d158)' }}>
                    {' · '}{t('deck.toFinishCheapest', {
                      price: formatPrice(cheapest), saved: formatPrice(savings) })}
                  </span>
                )}
              </div>
            )}
          </div>
          <button onClick={() => setExportOpen(true)}
            style={{ flexShrink: 0, background: 'var(--accent-yellow)', color: '#1a1a1a', border: 0,
                     borderRadius: 'var(--radius-sm)', padding: '0.55rem 0.8rem', font: 'inherit',
                     fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', minHeight: 38 }}>
            {t('deck.export')}
          </button>
        </div>
      )}

      {/* CARD LIST, grouped by type. Hidden on the Curve tab, which shows its
          own list filtered by whatever you tapped on the chart -- two lists of
          the same cards on one screen is the redundant surface Zach dislikes. */}
      {tab === 'curve' ? null : sections.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'var(--text-secondary)',
                      background: 'var(--surface-1)', borderRadius: 'var(--radius-md)' }}>
          {tab === 'consider' ? t('deck.noConsidering')
            : tab === 'need' ? t('deck.nothingMissing')
            : t('deck.noCards')}
        </div>
      ) : sections.map(section => (
        <div key={section.name}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                        padding: '0.9rem 2px 0.4rem', position: 'sticky', top: 0,
                        background: 'var(--bg-primary)', zIndex: 5 }}>
            <b style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.05em',
                        textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
              {section.name}
            </b>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{section.count}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            {section.cards.map(card => {
              const missing = card.quantity_missing || 0;
              return (
                <div key={card.id}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.65rem',
                           padding: '0.5rem 0.65rem', borderRadius: 11,
                           background: isDesktop && detailCard && String(detailCard.id) === String(card.id)
                             ? 'rgba(10,132,255,.12)'
                             : missing ? 'rgba(255,159,10,.06)' : 'var(--surface-1)' }}>
                  {/* TAP TO INSPECT. Art + name only: the quantity controls
                      are outside this button, because on a phone they sit
                      millimetres apart and one of them changes a record.

                      On desktop the same click fills the right pane instead of
                      opening a modal over the list you are working through. */}
                  <button
                    type="button"
                    onClick={() => (isDesktop ? selectDeckCard(card.id) : setInspecting(card))}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.6rem',
                      flex: 1, minWidth: 0, padding: 0, border: 0,
                      background: 'transparent', font: 'inherit',
                      textAlign: 'left', color: 'inherit', cursor: 'pointer',
                    }}
                  >
                    {card.image_url && (
                      <img src={card.image_url} alt="" loading="lazy"
                           style={{ width: 34, height: 47, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }} />
                    )}
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600,
                                     whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {/* Both faces, as every Magic site shows them. Falls
                            back to the front-face name for single-faced cards,
                            where display_name is deliberately null. */}
                        {card.display_name || card.name}
                      </span>
                      {/* BASIC LANDS SHOW NO SET.
                          Zach: "it's confusing because I don't actually own 6
                          of the one msh set". The owned count comes from the
                          whole pool, so naming one printing beside it states
                          something false.

                          This was the FIRST place the rule was fixed, and it
                          was written inline here. The same complaint then came
                          back for the collection list, the grid tile and the
                          inspector header -- three more rounds for one rule,
                          because each surface owned its own copy of the
                          answer. It now reads the shared one. */}
                      {!isBasicLand(card) && (
                        <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                          {card.set_name}
                        </span>
                      )}
                    </span>
                  </button>
                  {/* CONSIDERING ROWS SHOW THE SAME BADGE WHEN UNOWNED.
                      deckIdentity sets quantity_missing = 0 for considering --
                      correct, since a card he is merely weighing is not a gap
                      in the deck, and the buy-list reads that same field. The
                      badge therefore needs its own rule here: on the
                      considering board, show the price when he owns none.
                      Zach: "that way at a quick glance I can tell what I own". */}
                  {(missing > 0
                    || (card.board === 'considering' && !(card.quantity_owned > 0))) && (
                    <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '0.15rem 0.5rem',
                                   borderRadius: 20, flexShrink: 0,
                                   background: 'rgba(255,159,10,.16)', color: 'var(--accent-yellow)' }}>
                      {card.price_trend ? `$${formatPrice(card.price_trend)}` : t('deck.needed')}
                    </span>
                  )}

                  {/* MOVE between the deck and Considering, both directions. */}
                  <button
                    onClick={() => moveBoard(card)}
                    disabled={busy || card.board === 'commander'}
                    title={card.board === 'considering' ? t('deck.moveToDeck') : t('deck.moveToConsidering')}
                    aria-label={card.board === 'considering' ? t('deck.moveToDeck') : t('deck.moveToConsidering')}
                    style={{ width: 30, height: 30, flexShrink: 0, borderRadius: 'var(--radius-sm)',
                             border: 0, background: 'transparent', color: 'var(--text-muted)',
                             display: card.board === 'commander' ? 'none' : 'grid', placeItems: 'center',
                             cursor: busy ? 'wait' : 'pointer' }}
                  >
                    {card.board === 'considering'
                      ? <ArrowDownToLine size={14} />
                      : <Lightbulb size={14} />}
                  </button>

                  {/* QUANTITY. The commander is excluded: a deck has exactly
                      one, and the server swaps it rather than counting it. */}
                  {card.board !== 'commander' && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                      <button
                        onClick={() => changeQty(card, -1)} disabled={busy}
                        aria-label={t('deck.decrease')}
                        style={QTY_BTN}
                      >
                        {card.quantity === 1 ? <Trash2 size={12} /> : <Minus size={13} />}
                      </button>
                      <span style={{ minWidth: 18, textAlign: 'center', fontSize: '0.8rem',
                                     fontWeight: 600, color: 'var(--text-primary)' }}>
                        {card.quantity}
                      </span>
                      <button
                        onClick={() => changeQty(card, 1)} disabled={busy}
                        aria-label={t('deck.increase')}
                        style={QTY_BTN}
                      >
                        <Plus size={13} />
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
        </div>

        {/* RIGHT PANE: card detail that follows the selection.
            Zach: "the right hand side should show individual card detail so it
            doesnt have to open up a modal. Like initial load of deck view shows
            the commander but as you click different cards it shows that card."

            Same CardInspectorModal the phone opens, with inline -- not a second
            card-detail component that would drift from it.

            `key` forces a remount when the card changes. Without it the
            inspector keeps its own fetched state (deckUse, switched printing)
            across a selection change, which is exactly the stale-printing bug
            it already has a guard for; remounting makes it impossible rather
            than guarded. */}
        {isDesktop && detailCard && !(tab === 'curve' && !selectedCardId) ? (
          <div className="deck-panes-side" ref={sidePaneRef}>
            <CardInspectorModal
              key={detailCard.id || detailCard.card_id}
              card={detailCard}
              inline
              readOnly
              deckId={deck?.id}
              deckCardId={detailCard.deckCardId ?? null}
              onRepointed={() => { onChanged && onChanged(); setRepointVersion(v => v + 1); }}
              /* CLOSING THE PANE ACTUALLY CLOSES IT.
                 This was `() => {}` -- a no-op -- so the deck view's pane could
                 not be dismissed at all while the collection's could. Zach
                 asked for one behaviour everywhere: "this pane setup and
                 functionally should be the same for every pane including when
                 in the deck view."

                 Clearing the selection is what hides the pane, because the
                 wrapper above renders on `detailCard`. The deck's own default
                 (the commander) returns the next time a card is tapped. */
              onClose={() => { setSelectedCardId(null); setDetailDismissed(true); }}
              showToast={showToast}
              onRemoveFromDeck={removeCard}
              deckName={deck?.name || null}
            />
          </div>
        ) : null}
      </div>

      {/* COMMANDER SWAP */}
      {commanderOpen && (
        <>
          <div onClick={() => { setCommanderOpen(false); setCommanderSearch(''); }}
               style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: Z_BACKDROP }} />
          <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: Z_MODAL,
                        background: 'var(--surface-1)', borderTopLeftRadius: 20, borderTopRightRadius: 20,
                        maxHeight: '70vh', display: 'flex', flexDirection: 'column',
                        paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
            <div style={{ width: 38, height: 4, borderRadius: 2, background: 'var(--surface-3)', margin: '10px auto 4px' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.4rem 1rem 0.6rem' }}>
              <b style={{ fontSize: '1rem' }}>{t('deck.changeCommander')}</b>
              <button onClick={() => { setCommanderOpen(false); setCommanderSearch(''); }}
                      style={{ border: 0, background: 'transparent', color: 'var(--accent-blue)',
                               font: 'inherit', fontWeight: 600, cursor: 'pointer', minHeight: 44, padding: '0 0.25rem' }}>
                {t('common.close')}
              </button>
            </div>
            <div style={{ padding: '0 1rem 0.6rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem',
                              background: 'var(--surface-2)', border: '1px solid var(--border-glass)',
                              borderRadius: 'var(--radius-md)', padding: '0 0.8rem', height: 44 }}>
                <Search size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <input autoFocus value={commanderSearch} onChange={e => setCommanderSearch(e.target.value)}
                       placeholder={t('deck.commanderSearch')}
                       style={{ border: 0, outline: 'none', background: 'transparent', flex: 1,
                                color: 'var(--text-primary)', font: 'inherit', fontSize: '0.92rem' }} />
              </label>
            </div>
            <div style={{ overflowY: 'auto', padding: '0 0.6rem 1rem' }}>
              {commanderResults.map(c => (
                <CardSearchResult
                  key={c.id}
                  card={c}
                  t={t}
                  disabled={busy}
                  onSelect={swapCommander}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {/* THE SWAP WOULD REMOVE CARDS. The server refused and told us which --
          so the confirmation NAMES them. "11 cards will be removed" and the
          actual list are different amounts of information when you are
          deciding whether to go ahead. */}
      {swapConfirm && (
        <>
          <div onClick={() => setSwapConfirm(null)}
               style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: Z_BACKDROP }} />
          <div style={{ position: 'fixed', left: '1rem', right: '1rem', top: '50%',
                        transform: 'translateY(-50%)', zIndex: Z_MODAL, maxWidth: 460,
                        margin: '0 auto', background: 'var(--surface-1)',
                        borderRadius: 'var(--radius-md)', padding: '1.1rem',
                        maxHeight: '76vh', display: 'flex', flexDirection: 'column' }}>
            <b style={{ fontSize: '1.02rem', display: 'block', marginBottom: '0.5rem' }}>
              {t('deck.swapRemovesTitle', { name: swapConfirm.card.name })}
            </b>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.7rem' }}>
              {t('deck.swapRemovesBody', { count: swapConfirm.removing.length })}
            </div>
            <div style={{ overflowY: 'auto', marginBottom: '0.9rem', background: 'var(--surface-2)',
                          borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.7rem' }}>
              {swapConfirm.removing.map((r, i) => (
                <div key={i} style={{ fontSize: '0.82rem', padding: '0.2rem 0' }}>
                  {r.name || r}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {/* Cancel first and visually dominant: the destructive path
                  should never be the one your thumb lands on by default. */}
              <button onClick={() => setSwapConfirm(null)}
                style={{ flex: 1, minHeight: 46, border: 0, borderRadius: 'var(--radius-md)',
                         background: 'var(--surface-3)', color: 'var(--text-primary)',
                         font: 'inherit', fontSize: '0.92rem', fontWeight: 600, cursor: 'pointer' }}>
                {t('common.cancel')}
              </button>
              <button onClick={() => swapCommander(swapConfirm.card, true)} disabled={busy}
                style={{ flex: 1, minHeight: 46, border: 0, borderRadius: 'var(--radius-md)',
                         background: 'var(--accent-red)', color: '#fff',
                         font: 'inherit', fontSize: '0.92rem', fontWeight: 600,
                         cursor: busy ? 'wait' : 'pointer' }}>
                {t('deck.swapAnyway')}
              </button>
            </div>
          </div>
        </>
      )}

      {/* DELETE. Zach: "Doesn't appear a way to delete decks."
          It existed only as a long-press on the deck-list row, with nothing on
          screen saying so -- the tenth control on this project that rendered,
          worked, and could not be found.
          It lives HERE rather than on the list because this screen shows what
          is about to be destroyed, and a list row is a mis-tap waiting to
          happen. */}
      <div className="deck-delete-row">
      <button
        onClick={confirmDelete}
        disabled={busy}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.45rem',
          width: '100%', minHeight: 46, marginTop: '1.5rem',
          borderRadius: 'var(--radius-md)', border: '1px solid var(--accent-red)',
          background: 'transparent', color: 'var(--accent-red)',
          font: 'inherit', fontSize: '0.9rem', fontWeight: 600,
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        <Trash2 size={15} />
        {t('deck.deleteDeck')}
      </button>
      </div>

      {/* CARD DETAIL, read-only. A deck card is not a collection entry, so the
          inspector must not be allowed to write through this id. */}
      {inspecting && (
        <CardInspectorModal
          card={inspecting}
          readOnly
          /* PER-CARD REPOINT. Zach: "I might not want to do all 34, some I
             might want to leave as that printing." The sheet needs to know
             WHICH deck row it is looking at to offer the swap; from the
             collection there is no requirement and no button. */
          deckId={deck?.id}
          deckCardId={inspecting?.id}
          onRepointed={() => {
            onChanged && onChanged();
            // Recount: one row fewer needs repointing now.
            setRepointVersion(v => v + 1);
          }}
          onClose={() => setInspecting(null)}
          showToast={showToast}
          /* Delete from a deck means REMOVE THE REQUIREMENT, not destroy the
             card. Zach: "The delete when coming from deck view should delete
             the card from the deck not the collection otherwise seems weird."
             Passing the action in rather than letting the modal guess: it has
             no deck context, and its own delete targets a collection row. */
          /* removeCard already calls onChanged(), which reloads the deck --
             I invented a loadDeck() that does not exist. Checked rather than
             assumed this time. */
          onRemoveFromDeck={removeCard}
          deckName={deck?.name || null}
        />
      )}

      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        cards={missingCards}
        title={t('deck.buylist')}
        showToast={showToast}
        deckId={deck?.id || null}
      />

      {compareOpen && (
        <DeckCompareModal
          deck={deck}
          onClose={() => setCompareOpen(false)}
          showToast={showToast}
        />
      )}

    </div>
  );
}

export default DeckView;
