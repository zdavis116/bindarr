import { useState, useEffect, useRef } from 'react';
import { Z_MODAL } from '../utils/zLayers';
import { RefreshCw, X, Trash2, Star, Maximize2, ExternalLink } from 'lucide-react';
import { displayName, secondaryName } from '../utils/cardName';
import CardImageZoom from './CardImageZoom';
import CardEntryFields from './CardEntryFields';
import AddToDeckSelect from './AddToDeckSelect';
import { useBackGuard } from '../utils/useBackGuard';
import { useT } from '../utils/i18n';
import { isBasicLand as isBasicLandCard } from '../utils/basicLands';

// MTG color identity pip colors (WUBRG), approximating the printed mana colors.
const MTG_COLOR_BG = {
  White: '#f8f6d8', Blue: '#0e68ab', Black: '#2b2422', Red: '#d3202a', Green: '#00733e'
};
const MTG_COLOR_FG = {
  White: '#3a3520', Blue: '#fff', Black: '#fff', Red: '#fff', Green: '#fff'
};


// Shared card detail popup used by Dashboard and CollectionList.
// Self-contained: owns its edit form (PUT) and delete (DELETE) so every screen
// gets the same rich view + edit without duplicating the form. onUpdate() lets
// the parent refetch after a change. onViewStorage is optional (hidden if absent).
// Which deck row this sheet was opened from, when it came from a deck.
// Present only in the deck view: from the collection there is no deck context
// and no requirement to repoint.
function CardInspectorModal({
  card, onClose, onUpdate, onDeleted, showToast,
  startInEdit = false,
  readOnly = false,
  // The deck_cards row this sheet was opened from, and a callback to reload
  // the deck after a swap. Absent from the collection view.
  deckCardId = null,
  deckId = null,
  onRepointed = null,
  // REMOVE FROM THIS DECK, supplied only by the deck view.
  //
  // Delete cannot be one function: from the collection it destroys a physical
  // record, from a deck it drops a requirement. handleDelete targets
  // `entry_id || id`, and from a deck that id is a deck_cards row -- so
  // reusing it would delete a COLLECTION row whose id happened to match.
  // The caller owns its own context and passes the right action in.
  onRemoveFromDeck = null,
  deckName = null,
  // RENDER IN PLACE INSTEAD OF OVER THE PAGE.
  //
  // The desktop deck view shows card detail in a pinned right-hand pane:
  // Zach: "the right hand side should show individual card detail so it
  // doesnt have to open up a modal."
  //
  // Same component, not a second one. Everything below this line -- printing
  // switching, the stale-printing guard, double-faced flipping, per-card
  // repoint, remove-from-deck -- is the behaviour that took several rounds to
  // get right, and a parallel "inline card detail" component would have to
  // re-earn all of it and then drift from it.
  //
  // `inline` removes exactly two things: the fixed backdrop and the close
  // button. The pane has no backdrop to dismiss and is never empty, so a
  // close control would leave a hole where the detail was.
  inline = false,
}) {
  const { t } = useT();

  // Basic lands are fungible across printings (see deckIdentity), so set,
  // number and finish are cosmetic for them -- and showing a set beside a
  // pooled count states something false.
  //
  // The rule is imported, not re-implemented. It used to be an inline
  // startsWith() here, a name list in scanStaging.js and a SQL LIKE on the
  // server: three answers to one question, which is how they drift apart.
  const isBasicLand = isBasicLandCard(card);
  const [mode, setMode] = useState('view');
  const [q, setQ] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('nonfoil');
  const [purchasePrice, setPurchasePrice] = useState(0);
  const [isTrade, setIsTrade] = useState(0);
  const [favorite, setFavorite] = useState(0);
  const [listType, setListType] = useState('collection');
  const [notes, setNotes] = useState('');
  const [isFullScreen, setIsFullScreen] = useState(false);
  const hasToggledRef = useRef(false);

  useBackGuard(isFullScreen, () => setIsFullScreen(false));

  const targetEntryId = card?.entry_id || card?.id;
  // Which face is showing. Only meaningful when the card HAS a back face.
  const [showBack, setShowBack] = useState(false);

  // THREE TABS, each answering one question:
  //   card  -- what is this thing, and what does it do?
  //   yours -- what do I physically have, and where?
  //   decks -- who wants it, and can they all have it?
  //
  // The current screen interleaved all three, which is why the flip control
  // had nowhere to live and why "add to a deck" sat next to rules text.
  const [tab, setTab] = useState('card');
  const [deckUse, setDeckUse] = useState(null);
  const [deckUseLoading, setDeckUseLoading] = useState(false);
  // Every printing of this card, for the Yours tab. Same request as the
  // decks data -- both need the oracle id resolved, so one call serves both.
  const printings = deckUse?.printings || null;

  // THE CARD, from the server, with the caller's object underneath.
  //
  // The caller passes a collection row from one screen and a deck requirement
  // from the other, and they carry different fields -- a collection row has no
  // oracle_text and no mana_cost, so the Card tab silently lost its rules text
  // and mana cost from that screen while the deck view showed both.
  //
  // Which printing the sheet was switched to, if any. Declared HERE rather
  // than further down because `view` below reads it -- a const used above its
  // declaration is a temporal dead zone throw on every open, not a warning.
  const [switchedCardId, setSwitchedCardId] = useState(null);

  // WHAT THE SHEET IS SHOWING.
  //
  // Server values WIN. A card's rules text is a fact about the card, not about
  // the row that referenced it, so it must not depend on which screen you
  // opened. The caller keeps only what the server cannot know: which
  // collection entry this is, and which deck board it sits on.
  //
  // WHILE SWITCHING PRINTINGS, `card` IS THE WRONG CARD.
  //
  // Zach: "when I click on it 1 the card doesn't update right away I have to
  // exit card detail and go back in."
  //
  // switchPrinting sets switchedCardId and clears deckUse so the fetch reloads.
  // But `card` is the prop -- still the printing he came FROM -- so between the
  // click and the response landing, this merge fell back to it and the sheet
  // showed the old printing's image, set code and price. It looked like nothing
  // had happened, which is why leaving and re-entering "fixed" it.
  //
  // Falling back to a stale card is worse than showing nothing: a sheet that
  // confidently displays the wrong printing is how someone buys the wrong card.
  // While a switch is in flight the sheet keeps only the fields the server has
  // not replaced yet, and the switched-to id, so nothing asserts a fact about
  // the previous printing.
  const switching = Boolean(switchedCardId) && deckUse?.card_id !== switchedCardId;
  const view = deckUse?.card
    ? { ...card, ...deckUse.card }
    : (switching ? { ...card, id: switchedCardId, card_id: switchedCardId } : card);

  // THE FACE CURRENTLY SHOWN, for a double-faced card.
  //
  // Zach: "if Tony stark is showing that's the card info that should show. If
  // I flip Tony stark to invincible iron man then that info should show."
  //
  // Scryfall stores the two faces joined: type_line and mana_cost as
  // "front // back", oracle_text as "=== Face ===" blocks. Splitting here
  // rather than at import keeps one row per printing and one source of truth --
  // the same reason the ownership rule lives in SQL and not in three
  // components.
  //
  // A single-faced card has no separator, so every split yields one part and
  // this collapses to exactly what it renders today.
  // COLOURS, PARSED. The API stores these as a JSON string; every consumer
  // that forgot to parse rendered nothing and left an empty element behind.
  const cardColors = (() => {
    const raw = view?.types;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    }
    return [];
  })();

  const faceIndex = showBack && view?.back_image_url ? 1 : 0;
  const facePart = (val) => {
    if (typeof val !== 'string') return val;
    const parts = val.split(' // ');
    return parts.length > 1 ? (parts[faceIndex] ?? parts[0]) : val;
  };
  // RULES TEXT FOR THE FACE(S) ON SCREEN.
  //
  // normalizeCard stores multi-face text as "=== Face ===\n<text>" blocks. A
  // card you can FLIP (transform, modal DFC) shows one block at a time, because
  // the picture only shows one side and the text must agree with the picture.
  //
  // But an ADVENTURE, SPLIT, FLIP or PREPARE card is ONE piece of cardboard with
  // both halves printed on it -- Scryfall gives it a single top-level image and
  // no back_image_url, so faceIndex is permanently 0 and the second block was
  // silently dropped.
  //
  // Zach: "now I cant see the roost seek description in the card description.
  // That needs to be added for all cards that way." Sagu Wildling // Roost Seek
  // is layout "adventure": you can read Roost Seek right there on the art, but
  // the pane showed only the creature half.
  //
  // So: no back image means nothing to flip to, which means show EVERY face --
  // with its header kept, since two rules blocks need labels to be readable.
  const faceRules = (() => {
    const txt = view?.oracle_text;
    if (typeof txt !== 'string') return txt;
    const blocks = txt.split(/\n\n(?==== )/);
    if (blocks.length < 2) return txt;
    // One-piece-of-cardboard layouts: no flip, so show both halves.
    if (!view?.back_image_url) {
      return blocks
        .map(b => b.replace(/^=== (.+?) ===\n/, '$1\n'))
        .join('\n\n');
    }
    const blk = blocks[faceIndex] ?? blocks[0];
    // The face header is redundant once only one face is shown -- the card
    // name above already says which face you are looking at.
    return blk.replace(/^=== .+? ===\n/, '');
  })();
  // THE TYPE LINE, matching whatever the rules text shows.
  //
  // A flippable card shows the face you are looking at. A one-piece card
  // (adventure, split, flip, prepare) has no flip, so it shows BOTH halves --
  // otherwise Sagu Wildling reads "Creature — Dragon" while the rules text
  // underneath plainly includes a Sorcery.
  const faceTypeLine = (() => {
    const full = view?.type_line;
    if (typeof full !== 'string') return full;
    if (full.includes(' // ') && !view?.back_image_url) return full;
    return faceIndex === 1
      ? (view?.back_type_line || facePart(full))
      : facePart(full);
  })();
  // THE MANA COST BADGE beside the colour pips.
  //
  // For a one-piece card the two halves have DIFFERENT costs -- Sagu Wildling
  // is {4}{G}, Roost Seek is {G} -- and a single badge can only be one of them.
  // Showing both, joined, matches the type line right above it, which already
  // reads "Creature — Dragon // Sorcery — Omen".
  const faceManaCost = (() => {
    const full = view?.mana_cost;
    if (typeof full !== 'string') return full;
    if (full.includes(' // ') && !view?.back_image_url) {
      // Drop empty halves: a transform card's back has no cost of its own, and
      // "{4}{G} // " would render a trailing separator for nothing.
      const parts = full.split(' // ').map(s => s.trim()).filter(Boolean);
      return parts.join(' // ');
    }
    return facePart(full);
  })();

  // YOUR copies of THIS printing, from the server -- the one source both
  // callers share. Falls back to the caller's own numbers while the
  // request is in flight, so the rows do not flash empty.
  const ownedEntry = deckUse?.owned_entries?.[0] || null;
  const ownedCopies = (deckUse?.owned_entries || [])
    .reduce((n, e) => n + (e.quantity || 0), 0) || (card?.quantity ?? 0);

  // HOW MANY OF *THIS* PRINTING ARE ACTUALLY FREE.
  //
  // Read from the server's printings list rather than recomputed: it already
  // derives committed_qty and quantity_available from deck_cards, and a second
  // calculation here would be a second opinion about physical cards. That is
  // exactly how the completion ring and missing_cost drifted apart earlier in
  // this project -- two rules for one question, both plausible, one wrong.
  const thisPrinting = (deckUse?.printings || [])
    .find(p => p.id === (deckUse?.card_id || catalogueId)) || null;
  const thisPrintingCommitted = thisPrinting?.committed_qty || 0;
  const thisPrintingAvailable = thisPrinting?.quantity_available
    ?? Math.max(0, ownedCopies - thisPrintingCommitted);

  // IS THIS DECK'S SLOT ALREADY FILLED?
  //
  // Zach: "buy on mana pool should only show for cards that are missing when
  // in deck view because why would I want to buy a card I already own for a
  // deck."
  //
  // Read off the SAME per-deck `covered` flag the Decks tab renders, matched
  // by deck name, so the buy button and the row above it cannot disagree about
  // whether he is short. Computing "do I need this" a second way here is the
  // duplicate-answer failure this codebase keeps rediscovering.
  //
  // Defaults to FALSE when the deck is not in the list: an unknown state must
  // show the buy link rather than hide it. Hiding it wrongly removes an action
  // silently; showing it wrongly costs a glance.
  const deckCovered = Boolean(
    deckName
    && (deckUse?.decks || []).some(d => d.deck_name === deckName && d.covered)
  );

  useEffect(() => {
  }, []);

  useEffect(() => {
    if (!card) return;
    hasToggledRef.current = false;
    // readOnly wins: a deck card has no collection entry to edit.
    setMode(startInEdit && !readOnly ? 'edit' : 'view');
    // Always open on the front: carrying the flipped state into the next
    // card would show a face the user did not ask for.
    setShowBack(false);
    setTab('card');
    setDeckUse(null);
    deckFetchFor.current = null;
    setQ(card.quantity ?? 1);
    setCondition(card.condition || 'Near Mint');
    setPrinting(card.finish || 'nonfoil');
    setPurchasePrice(card.purchase_price || 0);
    setIsTrade(card.is_trade ? 1 : 0);
    setFavorite(card.favorite ? 1 : 0);
    setListType(card.list_type || 'collection');
    setNotes(card.notes || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset form only when the entry changes, not on every card mutation
  }, [targetEntryId, startInEdit, readOnly]);

  // Load the Decks tab on demand. Most opens never leave the Card tab, so
  // fetching this up front would cost a request per card view for data that is
  // usually not looked at.
  // IN-FLIGHT GUARD AS A REF, NOT STATE.
  //
  // This effect used to list deckUseLoading as a dependency AND set it, so it
  // cancelled its own request: setting the flag re-ran the effect, the
  // previous run's cleanup set cancelled = true, and the response that
  // arrived afterwards was thrown away by a closure that no longer trusted
  // itself. setDeckUse was never called and the spinner ran forever.
  //
  // "A request is in flight" is not something the UI renders, so it must not
  // drive a re-render or re-run.
  // PER-MOUNT, NOT PER-CARD-ID.
  //
  // This used to be cleared only by the reset effect, which keys on
  // targetEntryId -- so closing and REOPENING THE SAME CARD left the ref set,
  // the guard returned early forever, and the sheet never loaded again.
  // Zach: "when I went out and back in now it won't load".
  //
  // A ref created at mount is fresh every time the modal opens, and the id
  // comparison still prevents a refetch loop while it is open.
  // THE CATALOGUE ID, derived once.
  //
  // Held outside the fetch effect so the effect depends on a single primitive
  // rather than reading three fields off `card`. Depending on `card` itself
  // would refetch on every mutation of that object -- the edit form writes
  // card.quantity in place -- and depending on the three fields separately is
  // a longer way to say the same thing.
  //
  // A collection row carries card_id; a deck entry carries desired_card_id and
  // puts its own row id in `id`. Falling through to `id` from a deck sends a
  // deck_cards row number to a card_cache lookup: 404, and an empty tab.
  // Which printing the sheet is showing. Normally the card it was opened with;
  // after tapping a row in Other printings, that printing instead.
  //
  // A single value in front of the fetch, rather than a second path -- the
  // sheet has already been bitten twice by two sources of truth for one field.
  const openedWith = card?.card_id || card?.desired_card_id || card?.id;
  const catalogueId = switchedCardId || openedWith;

  // Bumped by invalidateDeckUse so the fetch effect can depend on a real
  // input instead of on the state it writes.
  const [deckRefresh, setDeckRefresh] = useState(0);

  const deckFetchFor = useRef(null);

  // REFETCH WHEN THE CARD'S DECK MEMBERSHIP CHANGES.
  //
  // Zach: "when I do add to deck the in your deck section doesn't update".
  // Adding to a deck changes what this endpoint would return, so the cached
  // response has to be dropped -- otherwise the tab shows the state from
  // before the add.
  // Switch the sheet to another printing of the same card.
  //
  // Zach: "I would like a way to switch to that card in that view."
  //
  // Sets the target and lets the existing open-fetch reload everything.
  // Patching the visible fields instead would leave Yours and Decks describing
  // the printing he navigated away from -- two sources of truth for one sheet,
  // which this component has already been bitten by twice.
  // A newly opened card clears any printing override -- otherwise the sheet
  // opens on whatever was last switched to.
  useEffect(() => { setSwitchedCardId(null); }, [openedWith]);
  // Clear the printing picker between entries, or it carries the previous
  // card's choice into the next edit.
  useEffect(() => { setEditCardId(null); }, [targetEntryId, openedWith]);

  // USE THIS PRINTING IN THE DECK.
  //
  // Different from switchPrinting, which only changes what the SHEET shows.
  // This changes what the deck asks for, so his owned copy satisfies it.
  //
  // Only offered when the sheet was opened from a deck: from the collection
  // there is no requirement to repoint.
  const [repointing, setRepointing] = useState(null);
  // Which printing the edit form will save. Seeded from the entry being
  // edited, so leaving the field alone changes nothing.
  const [editCardId, setEditCardId] = useState(null);

  // Declared before switchPrinting; the reference below resolves at TAP time,
  // by which point both consts are bound.

  // CONFIRM BEFORE SWITCHING, showing WHICH printing.
  //
  // Zach: "when updating my deck to use cards with printings I own can I see
  // what card we are referring to before doing it. I just accidentally
  // switched a card to a printing I own but its in use with a precon deck that
  // I dont want to remove from that." And: "I just meant letting me see what
  // printing your switching a card too. Just like the sync from moxfield."
  //
  // The Moxfield sync shows what it is about to do and waits. This did not: a
  // tap on a row in a list committed immediately, which is how a single
  // mis-tap moved a card out of a precon he had no intention of touching.
  //
  // The confirm names the card and shows FROM -> TO, because "are you sure?"
  // alone would not have prevented his mistake; seeing which printing would.
  const [confirmRepoint, setConfirmRepoint] = useState(null);

  const assignPrintingToDeck = async (pr) => {
    if (!deckId || !deckCardId) return;
    setRepointing(pr.id);
    try {
      const res = await fetch(`/api/decks/${deckId}/repoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deck_card_id: deckCardId,
          card_id: pr.id,
          // The finish he OWNS this printing in, not the one the deck asked
          // for -- the whole point is to use the physical card on the shelf.
          // The finish he OWNS it in when he owns it -- the point is to use
          // the physical card. For a printing he does not own there is no
          // owned finish, so keep what the deck already asked for rather than
          // silently dropping to nonfoil.
          finish: pr.owned_finish || deckUse?.desired_finish
                  || card?.desired_finish || 'nonfoil'
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The server re-checks availability, so a copy claimed since this
        // sheet opened is refused here rather than silently taken.
        showToast(data.error === 'checked_out'
          ? t('inspector.repointFailed')
          : (data.error || t('inspector.repointFailed')));
        return;
      }
      showToast(t('inspector.repointed', {
        set: String(pr.set_id || '').toUpperCase(), number: pr.number
      }));
      // Tell the deck to reload, then MOVE THE SHEET to the printing he chose.
      // Closing here threw him back to the deck list, so checking his own
      // choice meant reopening the card -- and it made an edit feel like a
      // commit-and-leave when he may well want to switch again.
      onRepointed && onRepointed();
      switchPrinting(pr);
    } catch {
      showToast(t('inspector.repointFailed'));
    } finally {
      setRepointing(null);
      setConfirmRepoint(null);
    }
  };

  const switchPrinting = (pr) => {
    if (!pr || pr.id === (deckUse?.card_id || catalogueId)) return;
    setTab('card');
    // `view` is DERIVED (deckUse?.card merged over card), so clearing deckUse
    // clears it. I wrote setView(null) -- a setter that does not exist. The
    // build compiled it fine because it sits inside a handler; lint caught it.
    setDeckUse(null);
    deckFetchFor.current = null;
    setSwitchedCardId(pr.id);
  };

  const invalidateDeckUse = () => {
    deckFetchFor.current = null;
    setDeckUse(null);
    setDeckRefresh(n => n + 1);
  };

  // LOCK THE PAGE BEHIND THE MODAL.
  //
  // Zach: "the whole window wants to scroll". Opening a modal does not stop
  // the body scrolling, so a flick anywhere -- including on the dimmed
  // backdrop -- drags the page underneath. That reads as the modal being too
  // big even when it fits, because the thing that moves is the window.
  //
  // The previous scroll position is restored on close: locking with
  // overflow:hidden alone makes the page jump to the top when it is released.
  useEffect(() => {
    // NOT WHEN INLINE. The pane is part of the page, not over it -- locking
    // the body here would freeze the deck list the pane sits beside, so
    // clicking a card would stop you scrolling to the next one.
    if (inline) return undefined;
    const { body } = document;
    const previous = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => { body.style.overflow = previous; };
  }, [inline]);

  useEffect(() => {
    // FETCHED FOR EVERY TAB, INCLUDING THE ONE YOU LAND ON.
    //
    // This used to skip the Card tab, on the theory that most opens never
    // leave it. But the Card tab is the DEFAULT, so the merge never ran on
    // first open and the sheet fell back to the caller's object -- which from
    // the collection has no oracle_text and no mana_cost. Same card, two
    // screens, two answers, for the sake of avoiding one request.
    // THE CARD_CACHE ID, not the collection entry id. Opened from the
    // collection, card.id is undefined and card.entry_id is the collection row
    // (206) -- card_id holds the catalogue id the endpoint needs. Sending the
    // entry id returned 404, so deckUse stayed null and BOTH the Decks tab and
    // the Yours tab's other-printings list rendered nothing.
    // The catalogue id, from EITHER shape. A collection row carries card_id;
    // a deck entry carries desired_card_id and puts its own row id in `id`.
    // Falling back to `id` from a deck sends a deck_cards row number to a
    // card_cache lookup -- 404, and an empty tab.
    if (!catalogueId) return;
    if (deckFetchFor.current === catalogueId) return;

    deckFetchFor.current = catalogueId;
    let cancelled = false;
    setDeckUseLoading(true);
    // Routers mount at bare /api -- see server.js:250.
    fetch(`/api/card/${catalogueId}/decks`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d) setDeckUse(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setDeckUseLoading(false); });
    return () => { cancelled = true; };
    // DEPENDENCIES THE EFFECT ACTUALLY READS.
    //
    // This used to list `deckUse` -- the state this effect SETS -- and relied
    // on an early return to stop the loop. That is the same self-triggering
    // shape as the bug that once made this tab spin forever, held in check by
    // a guard instead of by design.
    //
    // `deckRefresh` is an explicit "reload was requested" counter, so the
    // effect depends on an input rather than on its own output. It also listed
    // `tab`, which it stopped reading when the Card tab began needing this
    // response, and omitted desired_card_id, which it does read -- switching
    // between two deck entries could reuse the previous card's data.
  }, [catalogueId, deckRefresh]);

  const handleClose = () => {
    if (hasToggledRef.current && onUpdate) {
      onUpdate();
    }
    onClose && onClose();
  };

  useBackGuard(!!card, handleClose);

  if (!card) return null;

  const handleSave = async (e) => {
    e.preventDefault();
    if (!targetEntryId) return;
    // A deck card is NOT a collection entry. Saving one would PUT to
    // /api/collection/<deck_cards.id> and rewrite whichever collection row
    // shares that number -- silently, and on a card the user is not looking at.
    if (readOnly) {
      showToast && showToast(t('card.viewOnly'), 'error');
      return;
    }
    try {
      const res = await fetch(`/api/collection/${targetEntryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quantity: parseInt(q, 10),
          condition,
          printing,
          // WHICH PRINTING this copy is. Zach: "I need to edit a card's set
          // that is in my collection." Only sent when he actually picked a
          // different one -- the route treats undefined as "leave it alone".
          ...(editCardId && editCardId !== (ownedEntry?.card_id || catalogueId)
              ? { card_id: editCardId } : {}),
          purchase_price: parseFloat(purchasePrice) || 0,
          list_type: listType,
          is_trade: isTrade ? 1 : 0,
          favorite: favorite ? 1 : 0,
          notes
        })
      });
      if (res.ok) {
        card.quantity = parseInt(q, 10);
        card.condition = condition;
        card.printing = printing;
        card.purchase_price = parseFloat(purchasePrice) || 0;
        card.list_type = listType;
        card.is_trade = isTrade ? 1 : 0;
        card.favorite = favorite ? 1 : 0;
        card.notes = notes;
        showToast && showToast(t('inspector.entryUpdated'));
        onUpdate && onUpdate();
        onClose();
      } else {
        showToast && showToast(t('inspector.errUpdate'));
      }
    } catch (err) {
      console.error(err);
      showToast && showToast(t('inspector.errEdit'));
    }
  };

  const handleQuickToggle = async (field, value) => {
    if (!targetEntryId) return;
    const nextFavorite = field === 'favorite' ? (value ? 1 : 0) : (favorite ? 1 : 0);
    const nextIsTrade = field === 'is_trade' ? (value ? 1 : 0) : (isTrade ? 1 : 0);
    const nextListType = field === 'list_type' ? value : listType;

    // Optimistic UI & prop object updates
    if (field === 'is_trade') { setIsTrade(nextIsTrade); card.is_trade = nextIsTrade; }
    if (field === 'favorite') { setFavorite(nextFavorite); card.favorite = nextFavorite; }
    if (field === 'list_type') { setListType(nextListType); card.list_type = nextListType; }

    const payload = {
      quantity: parseInt(q, 10),
      condition,
      printing,
      purchase_price: parseFloat(purchasePrice) || 0,
      list_type: nextListType,
      is_trade: nextIsTrade,
      favorite: nextFavorite
    };

    try {
      const res = await fetch(`/api/collection/${targetEntryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        hasToggledRef.current = true;
        showToast && showToast(t('inspector.cardUpdated'));
      } else {
        // revert on fail
        if (field === 'is_trade') { setIsTrade(isTrade); card.is_trade = isTrade; }
        if (field === 'favorite') { setFavorite(favorite); card.favorite = favorite; }
        if (field === 'list_type') { setListType(listType); card.list_type = listType; }
        showToast && showToast(t('inspector.errUpdate'));
      }
    } catch (err) {
      console.error(err);
      if (field === 'is_trade') { setIsTrade(isTrade); card.is_trade = isTrade; }
      if (field === 'favorite') { setFavorite(favorite); card.favorite = favorite; }
      if (field === 'list_type') { setListType(listType); card.list_type = listType; }
      showToast && showToast(t('inspector.errUpdateGeneric'));
    }
  };

  const handleAddToDeck = async (deckId) => {
    if (!targetEntryId || !deckId) return;
    try {
      const res = await fetch('/api/collection/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_ids: [targetEntryId], action: 'add_to_deck', value: deckId })
      });
      const data = await res.json().catch(() => ({}));
      showToast && showToast(res.ok ? (data.message || t('inspector.addedToDeck')) : (data.error || t('inspector.errAddDeck')));
      // The Decks tab now shows stale data: this card is in one more deck than
      // the cached response says. Zach: "when I do add to deck the in your
      // deck section doesn't update".
      if (res.ok) invalidateDeckUse();
    } catch (err) {
      console.error(err);
      showToast && showToast(t('inspector.errAddDeckGeneric'));
    }
  };

  // Remove this card from the DECK it was opened from. Distinct from
  // handleDelete, which destroys a collection record.
  const handleRemoveFromDeck = async () => {
    if (!onRemoveFromDeck) return;
    const label = deckName
      ? t('inspector.confirmRemoveFromDeck', { name: view.name, deck: deckName })
      : t('inspector.confirmRemoveFromDeckShort', { name: view.name });
    if (!window.confirm(label)) return;
    await onRemoveFromDeck(card);
    onClose();
  };

  const handleDelete = async () => {
    if (!targetEntryId) return;
    if (!window.confirm(t('collection.confirmDeleteCard', { name: card.name }))) return;
    try {
      const res = await fetch(`/api/collection/${targetEntryId}`, { method: 'DELETE' });
      if (res.ok) {
        showToast && showToast(t('collection.cardRemoved', { name: card.name }));
        onDeleted && onDeleted(targetEntryId);
        onUpdate && onUpdate();
        onClose();
      } else {
        showToast && showToast(t('collection.errDelete'));
      }
    } catch (err) {
      console.error(err);
      showToast && showToast(t('common.errBackend'));
    }
  };

  const cardNumber = card.number || card.collector_number || card.card_number || '';

  // THE PANEL'S CONTENTS, shared by both shapes.
  //
  // Held in a variable rather than duplicated into the two return branches so
  // the modal and the inline pane can never render different card detail --
  // which is the whole reason this is one component and not two.
  const panelBody = (
    <>
      {/* CLOSE, IN THE FLOW.
          This was position:absolute at top:1rem of the panel, and Zach
          reported it missing twice for two different reasons: first the
          panel scrolled and carried it off, then the header outgrew the
          viewport and took it off the top. An absolute button has no
          relationship to the layout -- it goes wherever the panel's top
          goes, including off-screen.
          As a flex row it cannot be anywhere the panel is not.

          SHOWN INLINE TOO, AS OF 2026-09-23. It used to be modal-only, on the
          reasoning that "the pane always shows a card (the commander on load),
          so closing it would leave an empty column and no way back."

          Zach: "being able to close the right panel card description like if I
          am looking for a card click it and then navigate away and the card
          isnt on screen anymore I would like to be hide it."

          The premise was what was wrong, not the logic: the pane does NOT have
          to keep occupying the column. Closing it now removes it and gives the
          width back to the list, and the way back is tapping any card -- which
          is how it was opened in the first place. Each pane owns that
          behaviour, because each owns its own selection state; this button
          only reports the intent. */}
      {(!inline || onClose) && (
        /* LAYOUT LIVES IN THE CLASS, NOT IN A style PROP.
           These were inline styles, and an inline style CANNOT be overridden
           by a stylesheet -- so the pane had no way to place this row
           differently from the modal, and the button ended up floating in the
           middle of the pane. The modal's rules are now .ci-close-row and the
           pane's override is .card-inspector-inline .ci-close-row. */
        <div className="ci-close-row">
          <button
            type="button"
            className="btn btn-secondary btn-icon-only"
            onClick={handleClose}
            aria-label={t('common.close')}
            style={{ borderRadius: '50%' }}
          >
            <X size={16} />
          </button>
        </div>
      )}


        {/* Left side: Main Card Image Focus */}
        {/* flex: 0 0 auto -- the column must NOT shrink to fit its content.
            With `0 1 auto` its basis was the content's CURRENT height, so a
            re-render measured the shrunken image and shrank it further. The
            image now has a fixed height, so the column has a stable size and
            the scroller absorbs any overflow instead. */}
        <div className="ci-image-col" style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div
            className="ci-image-wrap"
            onClick={() => setIsFullScreen(true)}
            title={t('inspector.zoomHint')}
            style={{
              position: 'relative',
              // A FIXED HEIGHT, NOT A CAP.
              //
              // This was maxHeight, which is a ceiling rather than a size: the
              // actual height came from whatever space the flex layout offered,
              // and the column's flex-basis:auto then MEASURED that height on
              // the next render. Each tab switch or flip re-measured the
              // already-shrunken image, took it as the new preferred size and
              // shrank again -- Zach: "shrinks sometimes shrinks multiple
              // times". It never recovered, because nothing pushed back up.
              //
              // A height in viewport units is the same number before and after
              // a re-render, so there is nothing left to ratchet.
              // 30% smaller, at Zach's request: "can the image maybe shrink
              // 30% it's taking up to much of the screen". BOTH caps scale
              // together -- shrinking only one would make the card 30% smaller
              // on a tall phone and unchanged on a short one.
              height: 'min(24vh, 239px)',
              width: 'auto',
              aspectRatio: 0.718,
              flex: '0 0 auto',
              minHeight: 0,
              cursor: 'pointer',
              display: 'flex',
            }}
          >
            <img
              src={showBack && view.back_image_url ? view.back_image_url : view.image_url}
              alt={showBack && view.back_name ? view.back_name : view.name}
              style={{
                // Fill the wrapper, which now HAS a size. The image no longer
                // decides anything: it cannot feed a measurement back into the
                // layout that produced it.
                height: '100%',
                width: '100%',
                objectFit: 'contain',
                borderRadius: 'var(--radius-md)',
                boxShadow: '0 12px 36px rgba(0,0,0,0.6), 0 0 20px rgba(255,255,255,0.05)',
                transition: 'transform 0.2s ease'
              }}
            />
            <div style={{
              position: 'absolute',
              bottom: '0.6rem',
              right: '0.6rem',
              background: 'rgba(0,0,0,0.65)',
              backdropFilter: 'blur(6px)',
              padding: '0.25rem 0.5rem',
              borderRadius: 'var(--radius-sm)',
              color: '#fff',
              fontSize: '0.65rem',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              pointerEvents: 'none',
              border: '1px solid rgba(255,255,255,0.15)'
            }}>
              <Maximize2 size={12} />
              <span>{t('inspector.fullScreen')}</span>
            </div>
          </div>
        </div>

        {/* Right side: Information / Edit */}
        <div className="ci-info-col" style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: '0.75rem', justifyContent: 'flex-start' }}>
          {/* HEADER -- stays put while the body scrolls. The close button,
              the art and the tabs must stay reachable no matter how long
              the rules text is. */}
          <div className="ci-head">
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
              {card.list_type === 'wishlist' && (
                <span style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.2rem 0.5rem', borderRadius: '4px', backgroundColor: 'rgba(6, 182, 212, 0.15)', color: '#06b6d4', border: '1px solid rgba(6, 182, 212, 0.3)' }}>
                  {t('inspector.wishlistItem')}
                </span>
              )}
              {card.is_trade === 1 && (
                <span style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.2rem 0.5rem', borderRadius: '4px', backgroundColor: 'rgba(74, 222, 128, 0.15)', color: 'var(--type-grass)', border: '1px solid rgba(74, 222, 128, 0.3)' }}>
                  {t('inspector.forTrade')}
                </span>
              )}
            </div>

            {/* Large type is the name printed large on the card. See
                utils/cardName.js -- one rule, so the inspector and the grid can
                never disagree about what a card is called. */}
            <h3 style={{ fontSize: '1.65rem', color: 'var(--text-strong)', fontWeight: 800, lineHeight: 1.15, marginBottom: '0.25rem' }}>
              {/* The face's own name. Everything else on this tab follows
                  the flip; a fixed heading would be the only thing left
                  disagreeing with the picture. */}
              {faceIndex === 1 && view.back_name
                ? view.back_name
                : displayName(view)}
            </h3>
            {/* TYPE LINE, DIRECTLY UNDER THE NAME. Zach: "we need to move
                the type line to below name of card." It used to open the Card
                tab, which put the tab bar between a card's name and its type
                -- two halves of one identity, separated by navigation. */}
            <div style={{
              fontSize: '0.85rem',
              color: 'var(--text-secondary)',
              lineHeight: 1.35,
              marginTop: '0.15rem',
            }}>
              {faceTypeLine}
            </div>

            {secondaryName(view) && (
              <p style={{
                color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 500,
                marginBottom: '0.25rem',
              }}>
                {faceIndex === 1 && view.back_name
                  ? (view.name || secondaryName(view))
                  : secondaryName(view)}
              </p>
            )}
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: 500 }}>
              {/* NO SET, NO COLLECTOR NUMBER, FOR A BASIC LAND.
                  Zach, with the header screenshotted and underlined: "I can
                  still see the set here for basic lands can you remove it for
                  only basic lands as well."

                  THIS IS THE WORST PLACE IT SURVIVED, not merely the last.
                  The owned count directly below it is the POOLED total across
                  every printing (see isBasicLand just below), so the header
                  read "The Lost Caverns of Ixalan • #395 • x3 owned" while
                  those 3 Islands came from three different sets. The set code
                  was not clutter next to that number, it was a false claim
                  about which cards it counted -- the same "true number under
                  the wrong label" shape as the deck-quantity and oracle-total
                  bugs this very header was already fixed for twice.

                  Rarity stays: it is a fact about the card, not about which
                  printing this is, and it is what keeps the line from being
                  empty. */}
              {isBasicLand ? '' : card.set_name}
              {!isBasicLand && cardNumber ? ` • #${cardNumber}` : ''}
              {card.rarity ? `${isBasicLand ? '' : ' • '}${card.rarity}` : ''}
              {/* OWNED COUNT, FROM THE SERVER.
                  This read `card.quantity ?? 1` -- the CALLER's object. From a
                  deck that is how many the DECK WANTS, so a deck requirement
                  rendered as "x1 owned" for a card Zach does not own. His two
                  screenshots disagreed with each other and the header was the
                  wrong one. The `?? 1` default also turned missing data into a
                  claim of ownership.
                  deckUse.owned is what the Decks tab already trusts. */}
              {/* THIS printing, not the oracle-wide total. The header sits
                  beside a set code, so an oracle count reads as a claim about
                  that specific printing -- it said "The List #CON-31 ... x1
                  owned" for a printing Zach does not own. Same shape as the
                  deck-quantity bug: a true number under the wrong label. */}
              {/* BASIC LANDS COUNT THE WHOLE POOL.
                  A Mountain is a Mountain: the deck draws from all 44, so the
                  per-printing figure is the misleading one here. deckUse.owned
                  is the oracle-wide total the Decks tab already trusts. */}
              {deckUse ? ` • ${t('inspector.owned', {
                count: (isBasicLand ? deckUse.owned : deckUse.ownedThisPrinting) ?? 0
              })}` : ''}
            </p>

            {/* FLIP, BELOW THE IDENTITY LINE -- NOT ON THE ART.
                Zach: "the flip toggle practically covers all the card art that
                shouldnt be that way. Maybe the flip should be under the mythic
                - 1x owned since there is space there."

                It was absolutely positioned bottom-right INSIDE the image
                wrapper, and its label is the other face's full name -- "The
                Sensational She-Hulk" -- so the button was as wide as the card
                and sat across the artwork. The control for looking at the card
                was covering the card.

                Here it is a normal element in the flow, under the set/rarity
                line, which is the dead space he pointed at. Rendered only when
                there IS a second face: a single-faced card must not grow a
                button that does nothing. */}
            {view.back_image_url && (
              <button
                type="button"
                onClick={() => setShowBack(v => !v)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                  marginTop: '0.5rem',
                  minHeight: 32, padding: '0 0.7rem',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-glass)',
                  background: 'var(--surface-2)', color: 'var(--text-primary)',
                  font: 'inherit', fontSize: '0.78rem', fontWeight: 600,
                  cursor: 'pointer',
                  // The face name can be long ("The Sensational She-Hulk"), and
                  // in a narrow pane an unclamped label would push the header
                  // wider than the column. Truncate the NAME, never the icon:
                  // the icon is what makes it recognisably a flip control.
                  maxWidth: '100%',
                }}
              >
                <RefreshCw size={13} style={{ flexShrink: 0 }} />
                <span style={{
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {showBack ? view.name : view.back_name}
                </span>
              </button>
            )}

            {/* THREE TABS. Each answers a different question, which is the
                only thing that justifies a tap: what the card IS, what you
                OWN, and which decks WANT it.

                No counts on the labels. Zach: "can remove the numbers from the
                tabs seems pointless". */}
            {/* HEADER ENDS HERE: badges, name, type line, set. The tabs that
                follow are a SIBLING, see the note below. */}
          </div>

            <div className="ci-tabs" style={{
              display: 'flex', gap: 4, marginTop: '0.5rem', marginBottom: '0.35rem',
              background: 'var(--bg-secondary)', padding: 3, borderRadius: 10,
              border: '1px solid var(--border-glass)',
            }}>
              {[['card', t('inspector.tabCard')],
                ['yours', t('inspector.tabYours')],
                ['decks', t('inspector.tabDecks')]].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  style={{
                    flex: 1, minHeight: 36, border: 0, borderRadius: 8,
                    background: tab === id ? 'var(--bg-tertiary)' : 'transparent',
                    color: tab === id ? 'var(--text-primary)' : 'var(--text-secondary)',
                    font: 'inherit', fontSize: '0.82rem', fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          {/* THE TABS CLOSE OUTSIDE .ci-head, deliberately.
              They used to be nested inside it, which made them a
              grandchild of .ci-info-col -- so on the desktop deck view they
              could not be made to span the pane by CSS alone. Two attempts
              proved it: `display:contents` on .ci-head broke the header
              apart (an empty badge wrapper took the slot beside the art and
              pushed the name below it), and a negative margin slid the tabs
              under the card image, hiding the "Card" tab. Measured both.

              As a SIBLING of .ci-head they are a direct child of the info
              column and can simply be a full-width row of the pane's grid.
              Nothing changes in the modal: .ci-info-col is a flex column
              there, and the tabs sit in exactly the same place in the same
              order as before. */}
          {/* THE ONLY SCROLLING REGION. Zach: "I think it would make sense
              for the section below the 3 tabs to be the scrollable area." */}
          <div className="ci-scroll">


            {/* ============================ CARD TAB ============================
                What this thing is and what it does. Built from the mockup
                rather than from whatever the old layout left behind. */}
            {tab === 'card' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>

                {/* TYPE LINE, from type_line -- NOT from `subtypes`, which is
                    type_line split on non-letters and rejoined with spaces
                    (scryfallApi.js:220). For a double-faced card that welds
                    both faces together and drops every separator, which is
                    exactly what Zach's screenshot showed. */}
                {/* COLOUR PIPS.
                    `types` arrives as a JSON STRING ('["Black"]'), not an
                    array, so Array.isArray was false and this mapped over
                    nothing -- no pips on ANY card. Worse, the wrapper still
                    rendered: a zero-height flex child with the tab's 0.6rem
                    gap on both sides, doubling the space above the rules text.
                    Zach circled that gap twice.
                    Parsed here, and the wrapper only renders when it has
                    something to show. */}
                {view.supertype === 'MTG' && (cardColors.length > 0 || faceManaCost) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                    {cardColors.map(color => (
                      <span key={color} className={`mtg-color-pip mtg-color-${color.toLowerCase()}`} style={{
                        fontSize: '0.6rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em',
                        padding: '0.15rem 0.45rem', borderRadius: '999px',
                        background: MTG_COLOR_BG[color] || 'rgba(255,255,255,0.1)',
                        color: MTG_COLOR_FG[color] || '#fff', border: '1px solid rgba(0,0,0,0.2)'
                      }}>{color}</span>
                    ))}
                    {/* MANA COST, beside the colours.
                        Zach: "get rid of the bottom grid and add mana value
                        next to the red blue chips in that margin". It was the
                        only row in that grid not already on screen -- rarity
                        is in the header and colour identity IS these pips. */}
                    {faceManaCost && (
                      <span style={{
                        fontSize: '0.72rem', fontWeight: 700,
                        padding: '0.15rem 0.5rem', borderRadius: '999px',
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border-glass)',
                        color: 'var(--text-primary)',
                        marginLeft: cardColors.length ? '0.15rem' : 0,
                      }}>
                        {faceManaCost}
                      </span>
                    )}
                  </div>
                )}

                {/* A genuinely colourless card still says so -- but only when
                    the card really has no colours, not when the field failed
                    to parse. Those are different facts and the old code could
                    not tell them apart. */}
                {view.supertype === 'MTG' && cardColors.length === 0 && (
                  <div>
                    <span style={{ fontSize: '0.6rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.15rem 0.45rem', borderRadius: '999px', background: 'rgba(180,180,180,0.25)', color: '#eee' }}>
                      {t('inspector.colorless')}
                    </span>
                  </div>
                )}

                {/* RULES TEXT, BOTH FACES. The mockup shows them together so
                    you never flip merely to read the back. normalizeCard stores
                    them as "=== Face ===\n<text>" blocks joined by a blank
                    line, so the face headers are already there to split on. */}
                {faceRules && (
                  <div style={{
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)',
                    borderRadius: 'var(--radius-md)', padding: '0.75rem',
                    fontSize: '0.82rem', lineHeight: 1.55, color: 'var(--text-primary)',
                    whiteSpace: 'pre-wrap',
                  }}>
                    {faceRules}
                  </div>
                )}

                {/* RULINGS. Zach: "I would like to add to the card tab a ruling
                    section so I can see all rulings made for that card."

                    COLLAPSED BY DEFAULT, like Other printings. Library of Leng
                    has 9 rulings and Doubling Season has 5; open by default
                    they would push the rules text -- the thing you opened the
                    card to read -- off the top of a 390px screen. The count on
                    the closed row says whether opening it is worth it.

                    Rendered only when there ARE rulings. Every basic land has
                    none, and an empty "Rulings (0)" row is a control that
                    teaches you to ignore it. */}
                {Array.isArray(deckUse?.rulings) && deckUse.rulings.length > 0 && (
                  <details className="ci-printings ci-rulings">
                    <summary style={{
                      fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.06em',
                      textTransform: 'uppercase', color: 'var(--text-muted)',
                      marginBottom: '0.4rem', cursor: 'pointer',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                      gap: '0.5rem', listStyle: 'none',
                    }}>
                      <span>{t('inspector.rulings', { count: deckUse.rulings.length })}</span>
                      <span style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0 }}>
                        {t('inspector.rulingsHint')}
                      </span>
                    </summary>
                    <div className="ci-printings-body">
                      <div style={{
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border-glass)',
                        borderRadius: 'var(--radius-md)',
                      }}>
                        {deckUse.rulings.map((r, i) => (
                          <div key={`${r.published_at}-${i}`} style={{
                            padding: '0.6rem 0.75rem',
                            borderTop: i ? '1px solid var(--border-glass)' : 0,
                            fontSize: '0.78rem', lineHeight: 1.5,
                            color: 'var(--text-primary)',
                          }}>
                            {/* THE DATE MATTERS. A 2024 ruling supersedes a 2006
                                one -- Doubling Season's planeswalker rulings
                                were rewritten when the rules changed. Undated
                                advice would read as equally current. */}
                            {r.published_at && (
                              <div style={{
                                fontSize: '0.66rem', fontWeight: 700,
                                color: 'var(--text-muted)', marginBottom: '0.25rem',
                              }}>
                                {r.published_at}
                              </div>
                            )}
                            {r.comment}
                          </div>
                        ))}
                      </div>
                    </div>
                  </details>
                )}

              </div>
            )}
          


          {mode === 'edit' ? (
            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {listType === 'wishlist' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(74,222,128,0.1)', padding: '0.6rem 0.9rem', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(74,222,128,0.2)' }}>
                  <input type="checkbox" checked={listType === 'collection'} onChange={(e) => setListType(e.target.checked ? 'collection' : 'wishlist')} id="markOwned" style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                  <label htmlFor="markOwned" style={{ cursor: 'pointer', margin: 0, fontWeight: 700, color: 'var(--type-grass)', fontSize: '0.85rem' }}>
                    {t('inspector.markObtained')}
                  </label>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(255,255,255,0.02)', padding: '0.6rem 0.9rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                  <input type="checkbox" checked={isTrade === 1} onChange={(e) => setIsTrade(e.target.checked ? 1 : 0)} id="isTrade" style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                  <label htmlFor="isTrade" style={{ cursor: 'pointer', margin: 0, fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.85rem' }}>
                    {t('inspector.listedInTrade')}
                  </label>
                </div>
              )}

              {/* surface="edit": this form describes a card he ALREADY OWNS.
                  The finish here is a record of a physical object, so it must
                  never be rewritten by the picker — only flagged. */}
              {/* WHICH PRINTING THIS COPY IS.
                  Zach: "I need to edit a card's set that is in my collection."
                  Reuses the printings the sheet already fetched for the Yours
                  tab rather than adding a second source of truth.

                  Only offered when editing a real collection row -- a wishlist
                  entry has no physical card whose printing could be wrong.

                  AND NOT FOR BASIC LANDS. "Which printing is this Mountain"
                  is not a question with consequences: the pooled ownership
                  count is identical either way, so the control would be a
                  decision that changes nothing. */}
              {!isBasicLand && listType !== 'wishlist' && (deckUse?.printings || []).length > 1 && (
                <div className="form-group">
                  <label>{t('inspector.editPrinting')}</label>
                  <select
                    className="select-control"
                    style={{ width: '100%' }}
                    value={editCardId || ownedEntry?.card_id || catalogueId || ''}
                    onChange={(e) => setEditCardId(e.target.value)}
                  >
                    {(deckUse?.printings || []).map(pr => (
                      <option key={pr.id} value={pr.id}>
                        {/* Set code, number and owned count FIRST: those
                            identify the printing and must survive truncation
                            on a narrow screen. The set name is the part that
                            can be cut. */}
                        {String(pr.set_id || '').toUpperCase()} #{pr.number}
                        {(pr.owned_qty || 0) > 0 ? ` · own ${pr.owned_qty}` : ''}
                        {pr.set_name ? ` · ${pr.set_name}` : ''}
                      </option>
                    ))}
                  </select>
                  <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)',
                              margin: '0.35rem 0 0' }}>
                    {t('inspector.editPrintingHint')}
                  </p>
                </div>
              )}

              <CardEntryFields
                game={card.game || card.supertype}
                surface="edit"
                quantity={q} purchasePrice={purchasePrice} condition={condition} printing={printing}
                onQuantity={setQ} onPurchasePrice={setPurchasePrice} onCondition={setCondition} onPrinting={setPrinting}
                finishes={card.finishes}
              />

              <div className="form-group">
                <label>{t('nav.notes')}</label>
                <textarea
                  className="input-control"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t('inspector.notesPlaceholder')}
                  rows={3}
                  style={{ resize: 'vertical', fontFamily: 'inherit' }}
                />
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setMode('view')} style={{ flex: 1 }}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 2 }}>{t('inspector.saveChanges')}</button>
              </div>
            </form>
          ) : (
            <>
              {/* Price Panel -- YOURS: what your copies are worth. */}
              {tab === 'yours' && (<>

                {/* THIS PRINTING. Scoped deliberately: Bindarr records the
                    exact physical card, so "how many do I own" is a question
                    about MSH #80, not about Tony Stark in general. */}
                  <div style={{
                  background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)',
                  borderRadius: 'var(--radius-md)', overflow: 'hidden', marginBottom: '0.85rem',
                }}>
                  {[
                    // FROM THE SERVER, not from the caller's object. The
                    // collection passes a collection row and the deck view
                    // passes a deck requirement -- different shapes, different
                    // fields -- so reading them directly made the SAME CARD
                    // look different depending on which screen opened it.
                    // Zach: "The card detail view should be no different
                    // between collection and deck view."
                    //
                    // owned_entries comes from the endpoint both tabs already
                    // call, so the two callers cannot diverge. Same technique
                    // as the shared search row: identical by construction
                    // rather than by my remembering to update two places.
                    [t('inspector.finish'), ownedEntry?.finish
                      || card.finish || card.desired_finish || 'nonfoil'],
                    [t('inspector.condition'), ownedEntry?.condition || null],
                    // THE PRICE MUST COME FROM THE CHAIN, NOT THE RAW CATALOGUE.
                    //
                    // Zach: "when I click on it 1 the card doesn't update right
                    // away... 2 when I go back in the value row says 24 cents.
                    // When I navigate to mana pool it says value for card is 24
                    // cents but then it shows cheapest list at 15 cents so I
                    // feel like we are using 2 different values I would think
                    // we should be showing the cheapest one."
                    //
                    // He was right, and it was two different values. `card` is
                    // the raw card_cache row -- its price_trend is SCRYFALL's
                    // number and never passed through resolvePricedCard. So the
                    // printings list showed Mana Pool's $0.15 while the Value
                    // row above it showed something else entirely, on the same
                    // sheet, for the same card.
                    //
                    // thisPrinting comes from /card/:id/decks, which prices
                    // through the chain. One source of truth per sheet.
                    // THE PRICE, THE CONDITION, AND A BADGE FOR THE SHOP.
                    //
                    // Zach: "the value section is to long winded. I think just
                    // saying the price and quality is good enough. You could
                    // maybe put a badge on it like mana pool or card kingdom".
                    //
                    // It had grown to "$22.75 · Mana Pool LP · 10 in stock ·
                    // item price, before shipping" -- four facts in one run-on
                    // string that wrapped onto two lines in a 390px modal. Each
                    // was added for a real reason, but together they buried the
                    // number the row exists to show.
                    //
                    // So: the PRICE and the CONDITION are the answer, and the
                    // shop becomes a badge -- recognisable at a glance without
                    // spending a word. Stock and the shipping caveat are gone
                    // from this row; stock is visible on the Buy button's
                    // destination anyway, and "before shipping" is true of
                    // every price Bindarr shows, so stating it per-row taught
                    // nothing.
                    [t('inspector.value'), (thisPrinting?.price_trend ?? card.price_trend) && ownedCopies
                      ? (
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                          justifyContent: 'flex-end', flexWrap: 'wrap',
                        }}>
                          <span>
                            {`$${(Number(thisPrinting?.price_trend ?? card.price_trend) * ownedCopies).toFixed(2)}`}
                            {/* The condition the price is FOR. Zach accepts LP
                                or NM only, so which one he is looking at
                                decides whether the number is worth acting on.
                                It stays inline with the price because it
                                QUALIFIES the price -- a badge would imply it
                                describes the shop. */}
                            {thisPrinting?.price_condition
                              ? ` ${thisPrinting.price_condition}`
                              : ''}
                          </span>
                          {thisPrinting?.price_source_label && (
                            <span style={{
                              fontSize: '0.62rem', fontWeight: 700,
                              letterSpacing: '0.02em',
                              padding: '0.12rem 0.4rem',
                              borderRadius: 999,
                              background: 'var(--surface-2)',
                              border: '1px solid var(--border-glass)',
                              color: 'var(--text-secondary)',
                              whiteSpace: 'nowrap',
                            }}>
                              {thisPrinting.price_source_label}
                            </span>
                          )}
                        </span>
                      )
                      : null],
                    // AVAILABILITY OF *THIS* PRINTING, on the tab that claims
                    // to describe what he owns.
                    //
                    // The other-printings list below now distinguishes owned
                    // from available, and this panel is the same question about
                    // the printing the sheet is actually open on -- so leaving
                    // it out would mean the row for a printing is more honest
                    // than the panel about it. Zach's AKH Mountain: 6 owned, 6
                    // sleeved, 0 free.
                    //
                    // AVAILABILITY OF *THIS* PRINTING, ALWAYS SHOWN.
                    //
                    // Zach: "there is an available to use section in the yours
                    // tab for some cards (ones in decks) and not for other
                    // cards (not in decks) available to use should always show."
                    //
                    // It used to render only when something was committed, on
                    // the reasoning that "0 in decks" is a fact with no
                    // consequence and this tab is dense. That was wrong, and
                    // the failure is the interesting kind: a row that comes and
                    // goes is not a row you can READ, it is one you have to
                    // NOTICE. Scanning a binder card by card, "Available: 4"
                    // present on one card and absent on the next reads as
                    // missing data, not as zero -- so the honest answer was
                    // being delivered as an ambiguity.
                    //
                    // A row that is always there has a stable position, which
                    // is what makes a number glanceable.
                    //
                    // THE PARENTHETICAL ONLY APPEARS WHEN IT SAYS SOMETHING.
                    // Zach: "for cards not in a deck the count should reflect
                    // appropriately and for cards in decks it should reflect
                    // appropriately but also with (x in decks) in parenthesis."
                    // So an uncommitted card reads "4 of 4" and a committed one
                    // reads "1 of 4 (3 in decks)" -- never "(0 in decks)",
                    // which is noise dressed as information.
                    [t('inspector.availableToUse'),
                      thisPrintingCommitted > 0
                        ? (thisPrintingAvailable > 0
                            ? t('inspector.availableOfOwnedInDecks', {
                                available: thisPrintingAvailable,
                                owned: ownedCopies,
                                committed: thisPrintingCommitted })
                            : t('inspector.allInDecks', { count: thisPrintingCommitted }))
                        : t('inspector.availableOfOwned', {
                            available: thisPrintingAvailable, owned: ownedCopies })],
                  ].filter(([, v]) => v).map(([k, v], i) => (
                    <div key={k} style={{
                      display: 'flex', justifyContent: 'space-between', gap: '0.75rem',
                      padding: '0.6rem 0.75rem', minHeight: 42, fontSize: '0.82rem',
                      borderTop: i ? '1px solid var(--border-glass)' : 0,
                    }}>
                      <span style={{ color: 'var(--text-secondary)' }}>{k}</span>
                      <span style={{ fontWeight: 600, textAlign: 'right' }}>{v}</span>
                    </div>
                  ))}
                </div>

                {/* THE BUY LINK MOVED TO THE ANCHORED FOOTER, beside Edit Card.
                    Zach: "I think the buy on mana pool should be a little
                    button next to edit card."

                    It used to be a full-width button here, mid-scroll, which
                    made it both the widest thing on the tab and something you
                    had to scroll to. Both it and Edit Card are ACTIONS on this
                    card, so they belong together at the bottom where actions
                    live -- and neither should cost a scroll.

                    The stock count survives the move: a price with nothing
                    behind it is a quote rather than an offer. It renders as a
                    separate line under the footer, because putting it inside a
                    "little button" would make the button wide again. */}

                {/* SAY THAT THIS IS THE ITEM PRICE.
                    Zach found a $32.99 LP copy sitting below a $33.73 NM one on
                    Mana Pool's own page, because the LP seller charges $5.99
                    shipping and the NM seller includes it. Both numbers are
                    real; they answer different questions.

                    Neither public price feed carries shipping (13 fields, none
                    of them shipping-related), so the honest thing is to label
                    what this number IS rather than imply it is what he will
                    pay. Delivered cost depends on the whole order and comes
                    from the optimizer. */}
                {/* The "item price, before shipping" caption and the stock
                    count now render ON the Value row above -- see the comment
                    there. They were standalone divs positioned against the
                    old full-width Buy button, and were left floating when it
                    moved into the anchored footer. */}

                {/* OTHER PRINTINGS. The mockup's reason for existing: Zach
                    found four "identical" Tony Starks that were different
                    printings between $6.50 and $76.94. Telling them apart is
                    the difference between buying the right card and the wrong
                    one. Loaded with the Decks tab data, which already knows
                    every printing of this oracle id.

                    NOT FOR BASIC LANDS. Zach: "I don't care about printings at
                    all." The list exists to help choose between printings that
                    differ in price and identity; for a Mountain there is
                    nothing to choose, every copy fills the same slot, and the
                    app already pools his ownership across all of them. Showing
                    ~200 Mountain printings here would be the single largest
                    list in the app and would not answer a question he has. */}
                {!isBasicLand && printings && printings.length > 1 && (
                  /* THE WRAPPER CARRIES THE HEIGHT DOWN.
                     It was an unclassed div with only an inline margin. The
                     list sizes itself from the space left in .ci-scroll, and
                     that chain is only as good as its weakest link -- an
                     unclassed div in the middle sizes to its content and the
                     list below it becomes unbounded again. Classed, and the
                     margin moved into the class so a stylesheet can reach it
                     (inline styles cannot be overridden). */
                  <div className="ci-printings-section">
                    {/* COLLAPSIBLE, DEFAULT CLOSED.
                        Zach: "other printings should be a dropdown I can toggle
                        so I can hide the other printings. It should default
                        closed and then I can toggle it open."

                        This list is the longest thing on the tab -- MSH alone
                        gave Jennifer Walters three rows -- and it pushed Edit
                        Card off the bottom of the pane. Open by default, it
                        made the ANSWER (what do I own, what is it worth) cost a
                        scroll past a list that is only needed when choosing
                        between printings.

                        A <details> element rather than a useState toggle: the
                        browser owns the open/closed state and the disclosure
                        semantics, which means keyboard and screen readers work
                        without this component reimplementing either. */}
                    <details className="ci-printings">
                      <summary style={{
                        fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.06em',
                        textTransform: 'uppercase', color: 'var(--text-muted)',
                        marginBottom: '0.4rem', cursor: 'pointer',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                        gap: '0.5rem',
                        // The default triangle is replaced by a rotating chevron
                        // in CSS (.ci-printings), so the marker is hidden here.
                        listStyle: 'none',
                      }}>
                        {/* THE COUNT IS ON THE CLOSED ROW. A collapsed section
                            that says only "Other printings" hides whether there
                            is anything worth opening; "Other printings (3)" is
                            a reason to tap or not to. */}
                        <span>
                          {t('inspector.otherPrintings')}
                          {` (${printings.filter(pr => pr.id !== (deckUse?.card_id || catalogueId)).length})`}
                        </span>
                        {/* States the fact plainly rather than leaving him to
                            infer it from an absence. */}
                        <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: 'none' }}>
                          {/* Only when it is TRUE. It was unconditional,
                              printed over a list containing the printing he
                              owns. */}
                          {(deckUse?.printings || []).some(pr => (pr.owned_qty || 0) > 0)
                            ? t('inspector.ownSomeOfThese')
                            : t('inspector.ownNoneOfThese')}
                        </span>
                      </summary>
                    {/* THE BODY WRAPPER EXISTS FOR LAYOUT, not decoration.
                        A <details> element does not pass a bounded height to
                        its children -- measured at 58px tall with a 374px
                        scrollHeight, the list spilling out below it. This
                        plain div inside the details is the flex column that
                        actually constrains the list. */}
                    <div className="ci-printings-body">
                    {/* INLINE STYLES HERE CANNOT BE OVERRIDDEN BY THE
                        STYLESHEET, so only the decoration lives inline and the
                        SIZING lives in .ci-printings-list.

                        `overflow: hidden` used to be in this style prop. It
                        beat the stylesheet's `overflow-y: auto` outright --
                        computed style read `hidden` in every measurement --
                        so the list could never scroll, could never be capped,
                        and grew until it pushed Edit Card off the screen. The
                        border radius still needs clipping, which `overflow-y:
                        auto` + `overflow-x: hidden` in the class provides. */}
                    <div className="ci-printings-list" style={{
                      background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)',
                      borderRadius: 'var(--radius-md)',
                    }}>
                      {/* Exclude the printing CURRENTLY in use, not the one
                          the sheet was opened with. `card` is the caller's
                          object and stops being the shown printing the moment
                          he switches -- which listed the row he just chose and
                          hid the one he moved away from. catalogueId is what
                          the sheet is actually showing. */}
                      {printings.filter(pr => pr.id !== (deckUse?.card_id || catalogueId))
                        .map((pr, i) => {
                          let fin = [];
                          try { fin = Array.isArray(pr.finishes) ? pr.finishes : JSON.parse(pr.finishes || '[]'); }
                          catch { fin = []; }
                          const foilOnly = fin.length === 1 && fin[0] === 'foil';
                          return (
                            <button
                              key={pr.id}
                              type="button"
                              /* TAP ASKS FIRST, from a deck.
                                 It used to commit immediately, which is how a
                                 single mis-tap moved one of his cards out of a
                                 precon. Now it opens a confirm naming the card
                                 and showing which printing it would switch to.
                                 From the collection there is no deck row to
                                 repoint, so it just shows the printing -- the
                                 only meaning that context has, and nothing is
                                 changed, so nothing needs confirming. */
                              onClick={() => (deckCardId
                                ? setConfirmRepoint(pr)
                                : switchPrinting(pr))}
                              disabled={repointing === pr.id}
                              style={{
                              display: 'flex', justifyContent: 'space-between', gap: '0.75rem',
                              padding: '0.6rem 0.75rem', minHeight: 44, fontSize: '0.82rem',
                              borderTop: i ? '1px solid var(--border-glass)' : 0,
                              borderLeft: 0, borderRight: 0, borderBottom: 0,
                              width: '100%', textAlign: 'left', font: 'inherit',
                              cursor: 'pointer',
                              // An owned printing is the one he is looking for,
                              // so it has to be findable at a glance.
                              background: (pr.owned_qty || 0) > 0
                                ? 'var(--accent-blue-soft, rgba(10,132,255,0.12))'
                                : 'transparent',
                              color: 'inherit',
                            }}>
                              <span style={{ minWidth: 0 }}>
                                <span style={{ display: 'block', fontWeight: 600 }}>
                                  {(pr.set_id || '').toUpperCase()} #{pr.number}
                                </span>
                                <span style={{ display: 'block', fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                                  {pr.set_name}
                                  {foilOnly && ` · ${t('card.foilOnly')}`}
                                </span>
                              </span>
                              <span style={{ display: 'flex', alignItems: 'center',
                                             gap: '0.5rem', flexShrink: 0 }}>
                                {(pr.owned_qty || 0) > 0 && (() => {
                                  // OWNED IS NOT THE SAME AS AVAILABLE.
                                  //
                                  // Zach: "one of those own printings could be
                                  // used in another deck which can cause
                                  // confusion. What it should show is that I
                                  // own it but it's used in another deck if it
                                  // technically isn't available."
                                  //
                                  // This said "You own 6" for his AKH Mountain
                                  // while all 6 were sleeved in decks. Reading
                                  // that in a deck he is building means picking
                                  // a printing he cannot actually put in it --
                                  // and he only finds out at the table, against
                                  // cardboard. A wrong record costs a recount;
                                  // this was the app producing one.
                                  //
                                  // quantity_available is the server's own
                                  // owned - committed, the same figure the deck
                                  // view reserves against. Computing it here
                                  // instead would be a second opinion about
                                  // physical cards, which is how two screens
                                  // start disagreeing.
                                  const owned = pr.owned_qty || 0;
                                  const avail = pr.quantity_available ?? owned;
                                  const spoken = Math.max(0, owned - avail);
                                  if (spoken === 0) {
                                    return (
                                      <span style={{
                                        fontSize: '0.68rem', fontWeight: 700,
                                        color: 'var(--accent-blue)', whiteSpace: 'nowrap'
                                      }}>
                                        {t('inspector.youOwn', { count: owned })}
                                      </span>
                                    );
                                  }
                                  // NONE FREE reads differently from SOME FREE,
                                  // because the decisions differ: one means buy
                                  // another copy, the other means you have one
                                  // to spare. A single "3 in decks" line would
                                  // make him do that subtraction himself, every
                                  // time, on a phone.
                                  return (
                                    <span style={{
                                      fontSize: '0.68rem', fontWeight: 700,
                                      whiteSpace: 'nowrap', textAlign: 'right',
                                      color: avail > 0 ? 'var(--accent-blue)' : 'var(--text-muted)'
                                    }}>
                                      <span style={{ display: 'block' }}>
                                        {t('inspector.youOwn', { count: owned })}
                                      </span>
                                      <span style={{
                                        display: 'block', fontWeight: 600,
                                        color: avail > 0 ? 'var(--text-muted)' : 'var(--accent-orange, #ff9f0a)'
                                      }}>
                                        {avail > 0
                                          ? t('inspector.someInDecks', { count: avail })
                                          : t('inspector.allInDecks', { count: spoken })}
                                      </span>
                                    </span>
                                  );
                                })()}
                                <span style={{ color: 'var(--text-muted)' }}>
                                {pr.price_trend ? `$${Number(pr.price_trend).toFixed(2)}` : '—'}
                              </span>
                              {/* BUY THIS PRINTING.
                                  Zach: "a button that takes you right to the
                                  card in manapool".

                                  A SIBLING, NOT A NESTED LINK. This row is a
                                  <button> that repoints the deck to this
                                  printing; an <a> inside it is invalid HTML and
                                  browsers resolve the double click target
                                  unpredictably. Rendered as a span with its own
                                  handler, and stopPropagation so opening the
                                  marketplace can never silently also change
                                  which printing his deck asks for. */}
                              {pr.price_url && (
                                <span
                                  role="link"
                                  tabIndex={0}
                                  title={t('inspector.buyOn', { source: pr.price_source_label })}
                                  aria-label={t('inspector.buyOn', { source: pr.price_source_label })}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    window.open(pr.price_url, '_blank', 'noopener,noreferrer');
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.stopPropagation();
                                      e.preventDefault();
                                      window.open(pr.price_url, '_blank', 'noopener,noreferrer');
                                    }
                                  }}
                                  style={{
                                    display: 'inline-flex', alignItems: 'center',
                                    padding: '0.15rem 0.35rem', borderRadius: 6,
                                    color: 'var(--accent-blue, #0a84ff)', cursor: 'pointer',
                                  }}
                                >
                                  <ExternalLink size={13} />
                                </span>
                              )}
                              </span>
                            </button>
                          );
                        })}
                    </div>
                    </div>
                    </details>
                  </div>
                )}

              {/* The legacy price/chart/specs panel lived here. Removed at
                  Zach's request -- "Why is that view still in the yours section
                  it should go just should be edit button section." It is not in
                  the mockup and it repeated what the blocks above already say:
                  Condition twice, Location twice under two different names.

                  Market price and the marketplace links are reachable from the
                  Edit view, which is where changing a card belongs. */}
                {/* ACTIONS FOR A CARD YOU OWN.
                    Zach: "This is where edit card should be and only be here
                    when coming from the collection and this is where favorite
                    and delete should live as well." Editing, favouriting and
                    deleting all act on a COLLECTION ROW, so they belong on the
                    tab that describes it -- and only when one exists. */}
                {/* ANCHORED ACTIONS. Zach: "Edit Card should always be visible
                    at the bottom no need to scroll to it. And I think the buy
                    on mana pool should be a little button next to edit card."

                    .ci-footer-acts is the existing sticky footer the deck
                    view's Remove-from-deck button already uses -- reused, not
                    reinvented, so both panes anchor the same way and a change
                    to one cannot leave the other scrolling.

                    Edit Card FLEXES and the rest are fixed-width icons: the
                    primary action should absorb the spare room, and "a little
                    button" is exactly an icon-sized one. */}
                {(ownedEntry && !readOnly) || thisPrinting?.price_url || onRemoveFromDeck ? (
                  <div className="ci-footer-acts">
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      {ownedEntry && !readOnly && (
                        <button
                          className="btn btn-primary"
                          style={{ flex: 1 }}
                          onClick={() => setMode('edit')}
                        >
                          {t('inspector.editCard')}
                        </button>
                      )}
                      {/* REMOVE FROM DECK TAKES EDIT'S PLACE in the deck view.
                          Zach: "Remove from deck should be like the edit
                          button." `readOnly` hides Edit there, so this is the
                          primary action: it flexes, and Buy sits beside it as
                          the small secondary -- the same pairing as the
                          collection, rather than a second full-width bar. */}
                      {onRemoveFromDeck && (
                        <button
                          type="button"
                          className="btn btn-danger"
                          style={{
                            flex: 1,
                            display: 'inline-flex', alignItems: 'center',
                            justifyContent: 'center', gap: '0.35rem',
                          }}
                          onClick={handleRemoveFromDeck}
                        >
                          <Trash2 size={16} />
                          {t('inspector.removeFromDeck')}
                        </button>
                      )}
                {/* BUY, ONLY WITH A REAL URL AND ONLY IF HE NEEDS THE CARD.
                          A link built from set code and number would 404 on
                          anything the marketplace does not carry, and a dead
                          buy button is worse than none. Kept as an <a> so
                          middle-click and "open in new tab" behave properly.

                          IN A DECK, HIDDEN WHEN THE SLOT IS ALREADY FILLED.
                          Zach: "buy on mana pool should only show for cards
                          that are missing when in deck view because why would
                          I want to buy a card I already own for a deck."
                          `deckUse.covered` is the same field the deck list
                          uses to decide whether a row reads "Not owned", so
                          the button and the row cannot disagree. Outside a
                          deck (the collection) there is no slot to fill, so
                          the buy link always shows. */}
                      {thisPrinting?.price_url && !(onRemoveFromDeck && deckCovered) && (
                        <a
                          href={thisPrinting.price_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn btn-secondary"
                          title={t('inspector.buyOn', { source: thisPrinting.price_source_label })}
                          aria-label={t('inspector.buyOn', { source: thisPrinting.price_source_label })}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                            // Grows to a labelled button when it is the ONLY
                            // action, and stays small beside whichever primary
                            // is present -- Edit Card in the collection, Remove
                            // from deck in the deck view.
                            flex: ((ownedEntry && !readOnly) || onRemoveFromDeck) ? '0 0 auto' : 1,
                            justifyContent: 'center',
                            color: 'var(--accent-blue, #0a84ff)',
                            textDecoration: 'none',
                          }}
                        >
                          <ExternalLink size={15} />
                          {!(ownedEntry && !readOnly) && t('inspector.buyOn', {
                            source: thisPrinting.price_source_label })}
                        </a>
                      )}
                      {ownedEntry && !readOnly && (
                        <>
                          <button
                            type="button"
                            className={`btn ${favorite === 1 ? 'btn-primary' : 'btn-secondary'} btn-icon-only`}
                            style={{ borderRadius: 'var(--radius-sm)', padding: '0.6rem' }}
                            onClick={() => handleQuickToggle('favorite', favorite === 1 ? 0 : 1)}
                            title={t(favorite === 1 ? 'inspector.unfavorite' : 'inspector.favorite')}
                          >
                            <Star size={16} fill={favorite === 1 ? '#facc15' : 'none'} />
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger btn-icon-only"
                            style={{ borderRadius: 'var(--radius-sm)', padding: '0.6rem' }}
                            onClick={handleDelete}
                            title={t('inspector.deleteCard')}
                          >
                            <Trash2 size={16} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ) : null}

                {/* Remove from deck lives in the footer action row above,
                    beside Buy -- see the comment there. It used to render
                    again here as a separate full-width bar, which is what Zach
                    photographed: two stacked footers competing for the same
                    job. One surface, one button. */}

              </>)}

              {/* DECKS -- who wants this card, and can they all have it. */}
              {tab === 'decks' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {deckUseLoading && (
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                      {t('common.loading')}
                    </div>
                  )}

                  {/* SHORTFALL, and only for REAL requirements. Zach: "that
                      warning should only show if its in the main deck". A
                      considering entry is a shopping note -- the server does
                      not count it for missing copies or deck size, and neither
                      does this. */}
                  {deckUse && deckUse.reserved > deckUse.owned && (
                    <div style={{
                      padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-md)',
                      background: 'rgba(255,214,10,.1)',
                      border: '1px solid rgba(255,214,10,.3)',
                      color: 'var(--accent-yellow)', fontSize: '0.8rem', lineHeight: 1.45,
                    }}>
                      {t('inspector.shortfall', { owned: deckUse.owned, reserved: deckUse.reserved })}
                    </div>
                  )}

                  {deckUse && deckUse.decks.length === 0 && (
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                      {t('inspector.noDecks')}
                    </div>
                  )}

                  {deckUse && deckUse.decks.length > 0 && (<>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                    fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.06em',
                    textTransform: 'uppercase', color: 'var(--text-muted)',
                    marginBottom: '0.4rem',
                  }}>
                    <span>{t('inspector.inYourDecks')}</span>
                  </div>
                    <div style={{
                      background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-glass)', overflow: 'hidden',
                    }}>
                      {deckUse.decks.map((d, i) => (
                        <div key={`${d.deck_id}-${d.board}-${i}`} style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          gap: '0.6rem', padding: '0.65rem 0.75rem', minHeight: 46,
                          borderTop: i ? '1px solid var(--border-glass)' : 0,
                        }}>
                          <span style={{ minWidth: 0 }}>
                            <span style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600,
                                           whiteSpace: 'nowrap', overflow: 'hidden',
                                           textOverflow: 'ellipsis' }}>
                              {d.deck_name}
                            </span>
                            {/* THE PRINTING EACH DECK WANTS. Two decks can want
                                different printings at very different prices --
                                Zach's Tony Stark deck wants MSH #80 at $6.50
                                and his Hashaton deck wants MSH #363 at $25.30.
                                A row saying only the deck name hides that. */}
                            <span style={{ display: 'block', fontSize: '0.7rem',
                                           color: 'var(--text-muted)' }}>
                              {t('inspector.deckWants', {
                                printing: `${(d.set_id || '').toUpperCase()} #${d.number}`,
                              })}
                              {d.price_trend ? ` · $${Number(d.price_trend).toFixed(2)}` : ''}
                            </span>
                          </span>
                          {/* Considering is LABELLED, not flagged as a fault.
                              Zach: "if we are going to show a card in a deck
                              even if its in considering then we should note
                              that." */}
                          {/* Considering is LABELLED, not flagged as a fault.
                              A real requirement says whether it is COVERED --
                              the question the tab exists to answer. */}
                          {/* THE SERVER DECIDES, per requirement, in claim
                              order. Rendering "Covered" for every real
                              requirement was a label rather than a
                              calculation: with one copy owned and two decks
                              wanting it, both rows claimed Covered while the
                              banner directly above said one was short. */}
                          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                            <span style={{
                              fontSize: '0.7rem', fontWeight: 600,
                              color: d.board === 'considering'
                                ? 'var(--text-muted)'
                                : (d.covered ? 'var(--accent-green)' : 'var(--accent-yellow)'),
                            }}>
                              {d.board === 'considering'
                                ? t('inspector.considering')
                                : (d.covered ? t('inspector.covered') : t('inspector.short'))}
                            </span>
                            {/* REMOVE FROM THIS DECK, on the deck's own row.
                                Zach: "Maybe a delete in each row for the decks
                                it shows in." Better than one modal-wide
                                delete: the tab lists several decks, so a
                                single button would need a picker to say WHICH.
                                Shown only for the deck the sheet was opened
                                from -- the collection has no deck context to
                                act with. */}
                            {onRemoveFromDeck && deckName === d.deck_name && (
                              <button
                                type="button"
                                className="btn btn-danger btn-icon-only"
                                style={{ borderRadius: 'var(--radius-sm)', padding: '0.35rem' }}
                                onClick={handleRemoveFromDeck}
                                title={t('inspector.removeFromDeck')}
                                aria-label={t('inspector.removeFromDeck')}
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>)}

                  {deckUse && (<>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                    fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.06em',
                    textTransform: 'uppercase', color: 'var(--text-muted)',
                    marginBottom: '0.4rem',
                  }}>
                      <span>{t('inspector.availability')}</span>
                    </div>
                    <div style={{
                      background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-glass)', overflow: 'hidden',
                    }}>
                      {[[t('inspector.reservedCount'), deckUse.reserved],
                        [t('inspector.freeCount'), deckUse.free]].map(([k, v], i) => (
                        <div key={k} style={{
                          display: 'flex', justifyContent: 'space-between',
                          padding: '0.6rem 0.75rem', minHeight: 42,
                          borderTop: i ? '1px solid var(--border-glass)' : 0,
                          fontSize: '0.82rem',
                        }}>
                          <span style={{ color: 'var(--text-secondary)' }}>{k}</span>
                          <span style={{ fontWeight: 600 }}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </>)}

                  {/* ADD TO A DECK -- only here. Zach: "on the card tab remove
                      the add to deck button should only show on the deck tab."
                      The action needs its context: on this tab you can see who
                      already wants the card and how many are free before
                      committing another copy. Hidden in read-only mode, where
                      the card is a deck entry rather than a collection row. */}
                  {/* ADD TO A DECK -- the Decks tab's primary action, styled
                      like Edit on the Yours tab. Zach: "Just an add to deck
                      button styled just like the edit." */}
                  {!readOnly && (
                    <div style={{ marginTop: '0.25rem' }}>
                {/* STYLED AS THE PRIMARY ACTION, matching Edit on the Yours
                    tab. Zach: "please make it the same as the edit button".
                    The values live here rather than in a stylesheet because
                    this component takes a `style` prop -- and an inline style
                    silently beat my .ci-add-deck rule last time, leaving it a
                    140px dropdown beside a full-width button. */}
                <AddToDeckSelect
                  onAdd={handleAddToDeck}
                  placeholder={t('inspector.addToDeck')}
                  className="btn btn-primary"
                  style={{
                    width: '100%',
                    maxWidth: 'none',
                    minHeight: 42,
                    fontSize: '0.95rem',
                    fontWeight: 600,
                    padding: '0 0.9rem',
                    textAlign: 'center',
                    textAlignLast: 'center',
                    appearance: 'none',
                    WebkitAppearance: 'none',
                    cursor: 'pointer',
                  }}
                />
                    </div>
                  )}
                </div>
              )}

            </>
          )}
        </div>
                </div>
    </>
  );

  // THE CONFIRM, shown before any printing switch from a deck.
  //
  // Zach: "letting me see what printing your switching a card too. Just like
  // the sync from moxfield." So it names the card and shows FROM -> TO rather
  // than asking a bare "are you sure?" -- the set and number are the whole
  // point, because that is what he could not see when he mis-tapped.
  //
  // Rendered in BOTH return shapes below (inline pane and full modal): a
  // confirm that only exists on the phone would leave the desktop committing
  // silently, which is where the mistake actually happened.
  const repointConfirm = confirmRepoint ? (() => {
    const from = printings?.find(p => p.id === (deckUse?.card_id || catalogueId));
    const to = confirmRepoint;
    const fmt = (p) => (p
      ? `${String(p.set_id || '').toUpperCase()} #${p.number}`
      : '—');
    return (
      <div className="ci-confirm-backdrop" onClick={() => setConfirmRepoint(null)}>
        <div className="ci-confirm" onClick={(e) => e.stopPropagation()}>
          <div className="ci-confirm-title">{t('inspector.confirmRepointTitle')}</div>
          {/* THE CARD, named. He was not sure which card he was acting on. */}
          <div className="ci-confirm-card">{view?.name}</div>
          <div className="ci-confirm-swap">
            <span className="ci-confirm-from">
              <span className="ci-confirm-label">{t('inspector.confirmFrom')}</span>
              <span className="ci-confirm-pr">{fmt(from)}</span>
              <span className="ci-confirm-set">{from?.set_name || ''}</span>
            </span>
            <span className="ci-confirm-arrow">→</span>
            <span className="ci-confirm-to">
              <span className="ci-confirm-label">{t('inspector.confirmTo')}</span>
              <span className="ci-confirm-pr">{fmt(to)}</span>
              <span className="ci-confirm-set">{to?.set_name || ''}</span>
            </span>
          </div>
          {/* WHERE THE COPY IS COMING FROM. The server already knows a copy is
              committed elsewhere; not saying so is what let a precon card get
              taken. owned - available is the count already sleeved. */}
          {(() => {
            const owned = to?.owned_qty || 0;
            const avail = to?.quantity_available ?? owned;
            const spoken = Math.max(0, owned - avail);
            if (spoken <= 0) return null;
            return (
              <div className="ci-confirm-warn">
                {t('inspector.confirmInUse', { count: spoken })}
              </div>
            );
          })()}
          <div className="ci-confirm-actions">
            <button type="button" className="btn btn-secondary"
              onClick={() => setConfirmRepoint(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-primary"
              disabled={repointing === to?.id}
              onClick={() => assignPrintingToDeck(to)}>
              {repointing === to?.id
                ? t('inspector.confirmSwitching') : t('inspector.confirmSwitch')}
            </button>
          </div>
        </div>
      </div>
    );
  })() : null;

  // INLINE: the same panel, in a grid column instead of over the page.
  if (inline) {
    return (
      <div className="glass-panel card-inspector card-inspector-inline">
        {panelBody}
        {repointConfirm}
        {isFullScreen && (
          <CardImageZoom src={view.image_url} alt={view.name} onClose={() => setIsFullScreen(false)} />
        )}
      </div>
    );
  }

  return (
    <div className="modal-overlay" style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      // ROOM TO BREATHE. A full-bleed overlay puts a 90vh panel flush against
      // the viewport edges, so any browser chrome or dynamic toolbar tips it
      // over. The safe-area insets matter on a phone with a notch or a home
      // bar, where the usable height is smaller than the reported height.
      padding: 'max(0.75rem, env(safe-area-inset-top, 0px)) 0.75rem '
             + 'max(0.75rem, env(safe-area-inset-bottom, 0px))',
      boxSizing: 'border-box',
      // The overlay itself must never scroll -- .ci-scroll is the only
      // scrolling region in this modal.
      overflow: 'hidden',
      zIndex: Z_MODAL
    }} onClick={handleClose}>
      <div className="glass-panel card-inspector" onClick={(e) => e.stopPropagation()}>
        {panelBody}
      </div>

      {repointConfirm}

      {isFullScreen && (
        <CardImageZoom src={view.image_url} alt={view.name} onClose={() => setIsFullScreen(false)} />
      )}
    </div>
  );
}

export default CardInspectorModal;
