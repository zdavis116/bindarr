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
import { ChevronLeft, Search, X, AlertTriangle, Plus, Minus,
         Trash2, Lightbulb, ArrowDownToLine, ChevronDown } from 'lucide-react';
import { useT } from '../utils/i18n';
import { formatPrice } from '../utils/formatPrice';
import ExportModal from './ExportModal';
import CardInspectorModal from './CardInspectorModal';
import { Z_BACKDROP, Z_MODAL } from '../utils/zLayers';

// Moxfield's order: the commander first because it is the deck's premise, then
// the types in the order a deck list is normally read.
const TYPE_ORDER = ['Commander', 'Creature', 'Instant', 'Sorcery', 'Artifact',
                    'Enchantment', 'Planeswalker', 'Battle', 'Land'];

// The card types we section by. Read from type_line, NOT from the `types`
// column -- that column holds COLOURS in this database, which is what made the
// Collection type filter a second colour picker.
const CARD_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant',
                    'Land', 'Planeswalker', 'Sorcery'];

function sectionFor(card) {
  if (card.board === 'commander') return 'Commander';
  // Everything before the em dash is the card type(s); after it is subtypes
  // (Goblin, Equipment), which would produce a section per creature type.
  const line = (card.type_line || '').split('—')[0];
  // A "Legendary Artifact Creature" belongs under Creature: the most specific
  // type is what a player looks for. TYPE_ORDER decides which wins.
  for (const ty of TYPE_ORDER) {
    if (ty !== 'Commander' && line.includes(ty)) return ty;
  }
  return CARD_TYPES.find(ty => line.includes(ty)) || 'Other';
}

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

function DeckView({ deck, onBack, onChanged, showToast }) {
  const { t } = useT();

  const [tab, setTab] = useState('all');
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
  const searchRef = useRef(null);

  const cards = useMemo(() => deck?.cards || [], [deck]);

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

  const sections = useMemo(() => {
    const by = new Map();
    for (const c of shown) {
      const s = sectionFor(c);
      if (!by.has(s)) by.set(s, []);
      by.get(s).push(c);
    }
    const order = [...TYPE_ORDER, 'Other'];
    return order.filter(s => by.has(s)).map(name => ({
      name,
      cards: by.get(name),
      // Count CARDS, not rows: 34 Mountains is 34.
      count: by.get(name).reduce((n, c) => n + (c.quantity || 0), 0),
    }));
  }, [shown]);

  // Add a card. Zach: "we need a search to add cards to the deck."
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

  // Absolute-quantity write, shared by the +/- controls and the board moves.
  // Returns true on success so callers can decide whether to refresh.
  const writeCard = async (entry, { quantity, board }) => {
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

  const missingCards = deckCards.filter(c => (c.quantity_missing || 0) > 0);



  if (!deck) return null;

  const TABS = [
    { id: 'all', label: t('deck.tabAll'), n: counts.total },
    { id: 'have', label: t('deck.tabOwned'), n: counts.owned },
    { id: 'need', label: t('deck.tabMissing'), n: counts.missing },
    { id: 'consider', label: t('deck.tabConsidering'), n: counts.considering },
  ];

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
        {[deck.format, t('deck.cardCount', { count: target })].filter(Boolean).join(' · ')}
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
                {t('deck.toFinish')}
              </div>
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
              {label} {n}
            </button>
          );
        })}
      </div>

      {/* ADD A CARD: always visible, not behind a "+". Adding cards is the main
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

      {(searching || results.length > 0) && (
        <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-glass)',
                      borderRadius: 'var(--radius-md)', marginBottom: '0.75rem', overflow: 'hidden' }}>
          {searching && !results.length ? (
            <div style={{ padding: '0.75rem 0.85rem', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              {t('common.loading')}
            </div>
          ) : results.map(c => (
            <button key={c.id} onClick={() => addCard(c)}
              style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', width: '100%',
                       minHeight: 52, padding: '0.6rem 0.85rem', border: 0,
                       borderBottom: '1px solid var(--border-glass)', background: 'transparent',
                       color: 'var(--text-primary)', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: '0.88rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c.name}
                </span>
                <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)',
                               whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {/* SET CODE, COLLECTOR NUMBER, and a foil-only marker.
                      Four rows of one name in one set are four different
                      printings; without the number they cannot be told
                      apart, and this app records the exact printing. */}
                  {(c.set_id || '').toUpperCase()}
                  {c.number ? ` #${c.number}` : ''}
                  {Array.isArray(c.finishes) && c.finishes.length === 1
                   && c.finishes[0] === 'foil' ? ` · ${t('deck.foilOnly')}` : ''}
                  {c.set_name ? ` · ${c.set_name}` : ''}
                </span>
              </span>
              {/* THREE DIFFERENT FACTS, and conflating any two of them is what
                  confused Zach about Tony Stark:
                    - in THIS deck        -- counted from the deck on screen
                    - owned               -- copies he physically has
                    - free / reserved     -- copies not already claimed by
                                             ANOTHER deck
                  in_deck_qty from the API is across ALL decks (see
                  routes/collection.js:46), so it must never be labelled "this
                  deck". */}
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
            </button>
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

      {/* CARD LIST, grouped by type. */}
      {sections.length === 0 ? (
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
                           background: missing ? 'rgba(255,159,10,.06)' : 'var(--surface-1)' }}>
                  {/* TAP TO INSPECT. Art + name only: the quantity controls
                      are outside this button, because on a phone they sit
                      millimetres apart and one of them changes a record. */}
                  <button
                    type="button"
                    onClick={() => setInspecting(card)}
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
                        {card.name}
                      </span>
                      <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                        {card.set_name}
                      </span>
                    </span>
                  </button>
                  {missing > 0 && (
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
                <button key={c.id} onClick={() => swapCommander(c)} disabled={busy}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', width: '100%',
                           minHeight: 52, padding: '0.5rem 0.7rem', border: 0, background: 'transparent',
                           color: 'var(--text-primary)', font: 'inherit', textAlign: 'left',
                           cursor: busy ? 'wait' : 'pointer' }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600 }}>{c.name}</span>
                    <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      {/* Same reasoning as the add-card search: commanders
                          have multiple printings too, and the deck records
                          the exact one. */}
                      {(c.set_id || '').toUpperCase()}{c.number ? ` #${c.number}` : ''}
                      {c.set_name ? ` · ${c.set_name}` : ''}
                    </span>
                  </span>
                </button>
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

      {/* CARD DETAIL, read-only. A deck card is not a collection entry, so the
          inspector must not be allowed to write through this id. */}
      {inspecting && (
        <CardInspectorModal
          card={inspecting}
          readOnly
          onClose={() => setInspecting(null)}
          showToast={showToast}
        />
      )}

      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        cards={missingCards}
        title={t('deck.buylist')}
        showToast={showToast}
      />

    </div>
  );
}

export default DeckView;
