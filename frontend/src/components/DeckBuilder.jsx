import { useState, useEffect } from 'react';
import { Z_MODAL } from '../utils/zLayers';
import { X, AlertTriangle, ChevronDown } from 'lucide-react';
import { shuffleArray } from '../utils/shuffle';

import CheckoutWizardModal from './CheckoutWizardModal';
import { useBackGuard } from '../utils/useBackGuard';
import { buildDeckExport, parseDeckLine, BRACKET_STYLES, DEFAULT_BRACKET_STYLE } from '../utils/deckText';
import { useT } from '../utils/i18n';
import { finishLabel } from './deckSections';
import DeckList from './DeckList';
import NewDeckModal from './NewDeckModal';
import DeckView from './DeckView';

// Basic lands are exempt from the four-copy deck rule.

// Total copies of a card (matched by name) already in a deck's card list.
//
// Matched by NAME on purpose, and this is the one place name-matching is
// correct: Magic's four-copy rule is about the card name, so four different
// printings of Lightning Bolt is still four Lightning Bolts. Everywhere else in
// this file identity means (printing, finish).

// The identity of an import LINE, for matching a user's printing choice back to
// the line it was made on.
//
// Keyed on the lowercased card name, which is what a bare (Case C) line is: a
// name with no printing. Explicit lines never need a key because they never ask
// a question.
function importLineKey(name) {
  return String(name || '').trim().toLowerCase();
}


// The printing + finish a row is pinned to. Under exact-only identity this is
// not decoration -- it is the card's identity, so it is always visible rather
// than hidden behind a hover or a detail view. The user has to be able to match
// it against the physical card in their hand.
//
// On a deck row it is also the control that REPINS the entry to a different
// printing, which is why it can take an onClick. Text import fills a line from
// whatever printings the user has free, so a mixed-printing result is normal;
// this is how they make it uniform afterwards if they want to.


const TONE_STYLES = {
  ok: { background: 'rgba(74, 222, 128, 0.15)', color: '#4ade80', border: '1px solid rgba(74, 222, 128, 0.3)' },
  warn: { background: 'rgba(234, 179, 8, 0.15)', color: '#fbbf24', border: '1px solid rgba(234, 179, 8, 0.3)' },
  unavailable: { background: 'rgba(239, 68, 68, 0.15)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.35)' },
  muted: { background: 'var(--surface-2)', color: 'var(--text-secondary)', border: '1px solid var(--border-glass)' }
};
function DeckBuilder({ showToast, focusDeckId, onFocusDeckHandled }) {
  const { t } = useT();
  const [decks, setDecks] = useState([]);
  // Written by runResultsSource / refreshResultsPanel, which are reachable
  // from loadDeckDetails -- the deck view's onChanged refresh.
  const [activeDeck, setActiveDeck] = useState(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('list'); // 'list' or 'detail'

  // THE MULTI-DECK BUYLIST SELECTION (PR 7).
  //
  // He picks the decks; there is no automatic "all decks" view. Zach: "I dont
  // want a per collection per say I want to be able to select all the decks I
  // want to make a buy list for." Selecting every deck is simply one selection
  // he might make.
  //
  // Held as transient screen state and NOT persisted: he explicitly asked for
  // no saved selections or presets, so a selection lives as long as the screen.
  
  // Deck View & Display Modes // 'list' | 'grid'
  const [previewCard, setPreviewCard] = useState(null);

  // Deck Creation States & Constants


  const [showCreateModal, setShowCreateModal] = useState(false);

  // COMMANDER SELECTION, for the Commander format only.
  //
  // `newDeckCommanders` holds up to two chosen commanders, each an EXACT
  // identity ({ desired_card_id, desired_finish, name, set_name, number,
  // image_url }) -- the same shape every other deck entry has. A commander is
  // a physical card in a deck box like any other, and the card the user is
  // most likely to care about the exact printing of, so it is never stored as
  // a bare name.
  //
  // Two slots rather than one is not future-proofing: partner pairs and
  // Backgrounds are ordinary, and The Prismatic Piper is never a legal solo
  // commander, so a single slot would have been wrong on day one.

  // THE COMMANDER REFUSAL AND ITS OVERRIDE.
  //
  // An illegal commander is REFUSED by the server, not warned about, because
  // it is the deck's foundation rather than its contents: the user cannot fix
  // it by continuing to work, and every other card would be validated against
  // a colour identity that can never be legal.
  //
  // But the refusal is OVERRIDABLE, and only this one is. Pairing legality is
  // detected by parsing oracle text, and Wizards prints new pairing mechanics
  // regularly -- so the app can be wrong here in a way it can never be wrong
  // about singleton. Without a way through, an unrecognised new mechanic would
  // permanently block a legal deck.
  //
  // `commanderRefusal` holds the server's refusal so the user can read WHAT
  // was refused and WHY before deciding. It is null until the server refuses:
  // there is no pre-armed override, no ticked checkbox, and no default path
  // through. Silence is not consent -- the user must type a reason and press
  // the override button, and the reason is recorded so the parser can learn
  // the mechanic it failed to recognise.
  // The swap that was refused, held so an override can RE-SEND EXACTLY the
  // same write. Re-deriving it from the search results at confirm time would
  // risk overriding a different card than the one the refusal describes.

  // THE SWAP THAT WILL REMOVE CARDS, held so the panel can NAME them.
  //
  // Zach: "You should allow the swap with a warning that it will remove any
  // cards from the deck that are no longer valid." This is that warning's
  // state. It is null until the server says the swap would remove something,
  // and it carries the exact list -- names, printings, count -- because the
  // user has to be able to reconcile it against a physical binder before
  // agreeing. "Some cards will be removed" is not informed consent.
  //
  // Like the override above, there is no pre-armed confirmation and no default
  // path through: the user must press the confirm button, which re-sends the
  // identical write with the confirmation flag set.

  // Whether the deck being created is a Commander deck. Every commander
  // control on the modal is gated on this, so other formats show no extra
  // field, run no extra validation, and look exactly as they did.

  // Swap the commander of an EXISTING deck. Held here so the deck view can
  // open the same search panel the create modal uses rather than growing a
  // second one. // { replacing } | null
  
  // Card Search States inside editor
  const deckSearchGame = 'mtg';

  // WHAT THE RESULTS PANEL IS CURRENTLY SHOWING (PR 6I items 1 and 4b).
  //
  // null = nothing open. { mode: 'browse' } = the Browse Collection listing.
  // { mode: 'search', query } = a catalogue search.
  //
  // Two things need this, and neither could be done without it:
  //
  //  1. STALE COUNTS (item 1). After a deck mutation the open panel still shows
  //     pre-mutation "In Deck" and "Available" figures. To re-read them from the
  //     server the app has to know which request produced the list. Nudging the
  //     numbers locally instead was explicitly rejected: availability now spans
  //     every deck, its reservations and its allocations, so a client-side
  //     adjustment would be a SECOND implementation of that rule and would drift
  //     from the real one. Re-fetching keeps exactly one implementation, on the
  //     server, where all the inputs live.
  //
  //  2. CLOSING THE PANEL (item 4b). "Is the browse panel open" was previously
  //     only implied by searchResults being non-empty, so there was nothing to
  //     set to closed — which is precisely why the button could not toggle.
  const resultsSource = null;

  // Deck Selection Menu Controls
  // Kept as a constant: filteredDecks still reads it, but the control that
  // set it lived in the replaced list section. DeckList does its own search.
  const deckSearchTerm = '';
  const deckStatusFilter = 'all'; // 'all' | 'ready' | 'in_progress' | 'in_play'
  const deckSortBy = 'created-desc'; // 'created_desc' | 'created_asc' | 'name_asc' | 'cards_desc' // 'grid' | 'table'

  // Draw Simulator States
  const [showSimulator, setShowSimulator] = useState(false);
  const [simulatorDeck, setSimulatorDeck] = useState([]);
  const [hand, setHand] = useState([]);
  const [mulliganCount, setMulliganCount] = useState(0);

  // Import / Export Modals
  const [showImportModal, setShowImportModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportFormat, setExportFormat] = useState(null); // null = auto by deck game

  // HOW THE BUYLIST WRITES A SET CODE — "[CMM]" or "(CMM)" (PR 7C).
  //
  // Held HERE, once, above BOTH the per-deck panel and the multi-deck panel,
  // because the two must never disagree. If each panel owned its own toggle he
  // could copy one list in brackets and the other in parentheses on the same
  // shopping trip and only discover it at the counter. One piece of state is
  // what makes that unreachable, rather than merely unlikely.
  //
  // Persisted in localStorage, which is where this app ALREADY keeps UI
  // preferences (theme, search_page_size, bindarr_ui_lang, scanner settings) —
  // no new persistence layer is invented for it. A bad or absent stored value
  // falls through to the default rather than producing a third format.
  // Read once at mount. Nothing writes it any more, so calling it state would
  // overstate what it does.
  const buylistBracketStyle = (() => {
    const stored = localStorage.getItem('buylist_bracket_style');
    return BRACKET_STYLES.includes(stored) ? stored : DEFAULT_BRACKET_STYLE;
  })();
  // The server's buylist for the open deck (PR 7). `null` means "not loaded or
  // the fetch failed" and is deliberately distinct from a loaded-but-empty
  // list, which is the positive claim "you own every card in this deck".
  const [buylist, setBuylist] = useState(null);
  const [importText, setImportText] = useState('');
  const [importComparison, setImportComparison] = useState(null);
  // The server's copy-level accounting for the previewed paste. Kept beside the
  // per-line plan rather than recomputed from it: "how many cards will this
  // actually add" must have exactly one definition, and the server owns it.
  const [importSummary, setImportSummary] = useState(null);
  const [comparingImport, setComparingImport] = useState(false);

  // Checkout States
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const checkoutLocations = [];
  const checkoutMode = 'checkout'; // 'checkout' | 'checkin'
  const checkoutDeckId = null; // deck the open modal acts on

  // True while an add/qty write is in flight. Blocks overlapping clicks that
  // would otherwise each compute a new quantity from the same stale render and
  // clobber one another (last-writer-wins on the server upsert).

  // Exact printing + finish picker state.
  //
  // Under exact-only identity, "add Lightning Bolt" is not a complete
  // instruction -- the server needs to know WHICH Lightning Bolt. When the user
  // owns exactly one (printing, finish) variant there is nothing to ask, so we
  // add it straight away. When they own several, this holds the search result
  // we are asking about and the variants they can choose from. It is a small
  // inline panel inside the existing Add Cards list, not a separate screen. // { card, variants, board }

  // Repin an EXISTING deck entry to a different printing.
  //
  // Holds { entryId, variants } for the one row being edited. The picker it
  // opens is the same inline panel the Add Cards list uses, rendered inside the
  // deck row itself rather than on a new screen, and it lists only printings
  // the user OWNS -- with the count that is actually FREE, not the raw owned
  // count. Those differ whenever another deck holds copies, and the free number
  // is the one that answers "if I switch to this printing, will my deck
  // actually be filled".

  // Printing choices made on the IMPORT preview, for lines the user owns no
  // free copies of (Case C).
  //
  // Keyed by line name -> { variant }. Held here, unwritten, until the user
  // confirms the import: a choice made in a preview is an intention, and
  // writing it before they press the button would make the preview itself
  // mutate the deck.
  //
  // No per-choice quantity is stored, because a choice always covers the whole
  // line: the server only asks when it owns nothing free of that card, so there
  // is never an owned part of the line to carve out.
  const [importChoices, setImportChoices] = useState({});

  // Which import preview line currently has its picker open. One at a time,
  // same as the deck-row picker above -- the list is long and several open
  // pickers turn it into a wall.
  const [importPicker, setImportPicker] = useState(null);

  // Which card-type sections are collapsed. Collapsed is the exception, so the
  // set holds the collapsed ones and an unknown section renders open -- a new
  // section type can never appear hidden.


  useBackGuard(showCreateModal, () => setShowCreateModal(false));
  useBackGuard(showSimulator, () => setShowSimulator(false));
  useBackGuard(!!activeDeck, () => setActiveDeck(null));

  useEffect(() => {
    fetchDecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchDecks = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/decks');
      if (response.ok) {
        const data = await response.json();
        setDecks(data);
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errLoadDecks'));
    } finally {
      setLoading(false);
    }
  };

  // Search for a commander, across the whole card database rather than only
  // the collection.
  //
  // Scope is deliberate and differs from the Add Cards search. A commander is
  // chosen when the deck is created -- often before the card has been bought --
  // so restricting the search to owned cards would make it impossible to start
  // building a deck around a commander you are about to acquire. Ownership is
  // still reported afterwards by the deck's ordinary Missing badge, which is
  // where every other unowned card in the app is reported.
  //
  // `commanders=1` asks the server to return ONLY cards that can actually be a
  // commander. The filter lives on the server and reuses isLegalCommanderCard,
  // the same rule that REFUSES an illegal commander at create time -- so the
  // picker can no longer offer a choice the app is about to reject. Filtering
  // here in the client would be a second, divergent notion of the rule.

  // Turn a search result into a commander choice.
  //
  // A finish is required, and it comes from the printing's own finish list --
  // its only finish when it has exactly one, otherwise nonfoil as that
  // printing's ordinary default. This is the same rule the import path uses
  // for an explicitly-named printing, so the app never invents a finish a
  // printing does not offer.



  // Reset every field the create modal owns. One function rather than a list
  // of setters repeated at each exit, because a field forgotten in one of
  // those lists leaks into the next deck the user creates.

  // `override` is passed ONLY when the user has explicitly confirmed a refusal
  // and typed a reason. It is a parameter rather than component state read at
  // send time so there is no path where a stale confirmation from an earlier
  // attempt silently applies to a different pair of commanders.

  // Send parsed decklist lines to the server's import endpoint.
  //
  // Parsing stays here (it is a text-format concern); resolution and allocation
  // are the server's. `apply: false` previews, `apply: true` commits, and both
  // go through the SAME server code, so the preview cannot promise an
  // allocation the import then does differently.
  //
  // `choices` maps a line key to { variant, quantity }: a printing the user
  // picked in the preview, and how many copies that choice covers. Applying a
  // choice rewrites that line to CARRY the printing -- exactly the shape a
  // decklist line that named a printing in the first place has -- so the chosen
  // copies go down the server's Case A path. One mechanism, not two: the user
  // picking a printing and the text stating one are the same fact arriving by
  // different routes.
  //
  // A choice only ever exists for a line the user owns NO free copies of (the
  // server asks in that case and only that case), so the choice always covers
  // the WHOLE line. There is no owned remainder to keep separate: a partial
  // line is resolved server-side by extending the printing he already owns, and
  // never reaches the picker at all.
  const postImport = async (deckId, text, { apply, choices = {} }) => {
    const lines = [];
    for (const raw of text.split('\n')) {
      const p = parseDeckLine(raw.trim());
      if (!p) continue;

      const line = { name: p.name, quantity: p.qty };
      if (p.set) line.set = p.set;
      if (p.number) line.number = p.number;
      if (p.finish) line.finish = p.finish;

      const chosen = !p.set ? choices[importLineKey(p.name)] : null;
      if (!chosen) {
        lines.push(line);
        continue;
      }

      lines.push({
        name: p.name,
        quantity: p.qty,
        set: chosen.variant.set_id,
        number: chosen.variant.number,
        finish: chosen.variant.finish
      });
    }
    if (lines.length === 0) return null;

    const response = await fetch(`/api/decks/${deckId}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines, board: 'mainboard', apply })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      showToast(data.error || t('deck.errNoMatches'));
      return null;
    }
    return response.json();
  };


  // Open a deck requested by another screen (Home's "decks in progress").
  // Waits for the list to load, then clears the request -- otherwise returning
  // to this tab later would silently re-open the same deck.
  useEffect(() => {
    if (!focusDeckId || !decks.length) return;
    loadDeckDetails(focusDeckId);
    onFocusDeckHandled && onFocusDeckHandled();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusDeckId, decks.length]);

  const loadDeckDetails = async (deckId) => {
    try {
      setLoading(true);
      const response = await fetch(`/api/decks/${deckId}`);
      if (response.ok) {
        const data = await response.json();
        // Also get checkout status from deck list
        const deckMeta = decks.find(d => d.id === deckId);
        setActiveDeck({ ...data, checked_out: deckMeta?.checked_out || 0, checked_out_at: deckMeta?.checked_out_at || null });

        setViewMode('detail');

        // RE-READ THE OPEN RESULTS PANEL TOO (PR 6I item 1).
        //
        // Put HERE, and not at each mutation, on purpose. Every deck mutation in
        // this file already ends by calling loadDeckDetails to re-read the deck
        // -- delete, add, quantity change, re-pin, board move, commander swap
        // removals, import. Hanging the panel refresh off that one choke point
        // makes the spec's "after ANY mutation that can change availability"
        // true by construction, instead of true only for the mutations someone
        // remembered to annotate. A future mutation gets it for free, which is
        // the failure mode that produced this bug: the delete path simply had
        // no line telling the panel anything had happened.
        //
        // Not awaited: the deck itself is already on screen and correct, and
        // blocking the whole view on a secondary panel's fetch would make every
        // delete feel slower than it is.
        refreshResultsPanel();
        // THE BUYLIST IS REFRESHED FROM THE SAME CHOKE POINT, and for the same
        // reason: every deck mutation already ends here, so "the buylist is
        // current after any change that can move a shortfall" is true by
        // construction rather than true only where somebody remembered. A
        // stale buylist is worse than none — it is a shopping list for a deck
        // he no longer has.
        refreshBuylist(deckId);
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errLoadDetails'));
    } finally {
      setLoading(false);
    }
  };

  // Write ONE exact requirement.
  //
  // The single choke point for every deck write in this file. Both
  // desired_card_id and desired_finish are always sent and never defaulted: a
  // defaulted finish is the app silently choosing a physical object on the
  // user's behalf, who then finds the wrong version when they walk to the
  // binder. `quantity` is the ABSOLUTE new count, not a delta, so a retried or
  // double-tapped request cannot double the requirement.

  // Fetch the exact (printing, finish) variants of a card the user owns.

  // "Add this card" from the results list.
  //
  // THE RULE, stated once: NEVER RE-ASK A QUESTION THE USER JUST ANSWERED.
  //
  // A Browse Collection row is already ONE exact printing and finish -- "Sol
  // Ring (Commander Masters · #410)" and "Sol Ring (Commander 2021 · #263)"
  // are separate rows. Clicking + on one of them IS the answer to "which
  // physical card". Opening a picker that lists both printings again asks the
  // user to repeat the click they just made, on a panel that cannot tell them
  // anything the row did not already say.
  //
  // So a row that carries its own exact identity (`exact`, set by
  // groupOwnedByVariant) is added straight away. The picker survives for the
  // case it was actually built for: a NAME-scoped search result, which names a
  // printing but no finish, or nothing owned at all -- there the app genuinely
  // does not know which physical object is meant, and guessing would put the
  // wrong card in the deck.

  // Commit a chosen exact variant, incrementing whatever is already there.

  // Open the repin picker for one deck row.
  //
  // Loads the printings the user owns of this Oracle card, each with the count
  // that is actually free. Loaded on demand rather than with the deck, because
  // availability is a fact about the whole collection at this instant and a
  // copy fetched with the deck would be stale by the time the user clicked.

  // Repin an existing entry to a chosen printing+finish.
  //
  // Implemented as ONE atomic server-side replace, because the entry's identity
  // IS (printing, finish): changing them makes it a different requirement, and
  // the server needs to be told WHICH ROW is changing.
  //
  // This used to be an add followed by a delete -- two requests -- and the
  // ordering was chosen to make the failure mode a visible duplicate rather
  // than a silent disappearance. That was the right call for two requests, but
  // the better answer is not to have two: between them the deck really does
  // hold two copies of one card name, which in a Commander deck is a state the
  // server itself calls illegal, and if the delete never lands (dropped
  // connection, server restart) it holds them permanently. Naming the row lets
  // the server do both halves in one transaction, so there is no window at all
  // and a refusal rolls the whole edit back.
  //
  // The quantity carried over is the requirement's own quantity, unchanged. The
  // user asked to change WHICH card, not HOW MANY -- and if the new printing
  // has fewer free copies, the row's existing Missing badge says so rather than
  // the app silently shrinking the deck.

  // Change the quantity of an EXISTING requirement.
  //
  // Takes the whole entry rather than a card id, because a card id is no longer
  // unique within a deck: the same printing can legitimately sit on the
  // mainboard and the sideboard, in nonfoil and in foil. The entry carries the
  // exact identity to re-send.

  // Move an entry between boards -- in practice, toggling a card in and out of
  // 'considering'.
  //
  // This is the ONLY way "considering" is expressed. A DECK is never in a
  // considering state; a single card is. Board is part of the requirement's
  // uniqueness key, so a move is a rewrite of the row rather than an in-place
  // update -- and it goes through the same atomic server-side replace the
  // re-pin and the commander swap use.
  //
  // It used to be a write followed by a separate delete. Between those two
  // requests the card sat on BOTH boards at once, and if the delete never
  // landed it stayed on both -- so the deck's own arithmetic would count a card
  // the user owns one of, twice. Naming the row being moved closes the window.

  // Remove a requirement by its deck_cards.id, for the same reason quantity
  // edits take the whole entry: card id alone no longer identifies one row.
  //
  // THIS NEVER APPLIES TO A COMMANDER. Per Zach (2026-08-19) a commander is
  // swapped, never deleted, and the server refuses a commander delete outright
  // with COMMANDER_DELETE_UNSUPPORTED. handleUpdateCardQty intercepts the
  // commander case before it reaches here and opens the swap panel instead, so
  // the user never sees that refusal in normal use.
  //
  // The refusal is still SHOWN rather than swallowed, because the server is the
  // authority: if some other path ever reaches here with a commander row, the
  // user must read what the app actually said instead of a silent no-op. Its
  // message names the swap as the way forward, which is exactly what they need.
  //
  // The stranding warning that used to be handled here has moved WITH the
  // operation it belongs to -- it now only arrives on the swap request, and
  // swapCommander/the inline removal panel handle it. There is no second
  // implementation of the same conversation.

  const handleDeleteDeck = async (deckId, name) => {
    if (!window.confirm(t('deck.confirmDelete', { name }))) return;

    try {
      const response = await fetch(`/api/decks/${deckId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast(t('deck.deleted'));
        fetchDecks();
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errDelete'));
    }
  };

  // Browse the collection: one row per EXACT (printing, finish) the user owns.
  //
  // GET /api/collection returns one row per PHYSICAL CARD -- three copies of a
  // Swamp are three rows, deliberately, because checkout allocates specific
  // copies (server.js splitStackedEntries). Showing that raw here would give
  // the user three identical-looking Swamp rows to choose between with no way
  // to tell them apart.
  //
  // So the rows are grouped for DISPLAY only, keyed on (card_id, finish) --
  // which is exactly the app's deck identity. Nothing is merged in the
  // database and splitStackedEntries is untouched; this is a `reduce` over a
  // read.
  //
  // The key includes the FINISH. A foil Sol Ring and a nonfoil Sol Ring of the
  // same printing are two different physical objects that do not substitute
  // for each other, so they are two rows -- and the row carries its finish so
  // the FOIL badge can distinguish them on screen.
  //
  // The consequence that matters for requirement 1: every row in this list is
  // now ONE exact printing and finish, so clicking + on it is already a
  // complete instruction. Nothing has to be asked.

  // Run whatever the results panel is showing, and put the answer on screen.
  //
  // Split out of handleSearchCards so the SAME request can be re-issued after a
  // mutation without going through the event handler. That is what makes item 1
  // a re-read rather than a local fixup: the panel is refilled from the server's
  // answer, so its In Deck and Available figures are the server's current ones
  // by construction.
  const runResultsSource = async (source) => {
    if (!source) return;
    if (source.mode === 'browse') {
      const res = await fetch(`/api/collection?game=${deckSearchGame}`);
      if (!res.ok) throw new Error('browse failed');
      return;
    }
    const response = await fetch(
      `/api/search?name=${encodeURIComponent(source.query)}&scope=database&game=${deckSearchGame}`
    );
    if (!response.ok) {
      const err = new Error('search failed');
      err.status = response.status;
      throw err;
    }
  };

  // Re-read the open results panel from the server (PR 6I item 1).
  //
  // Called after EVERY mutation that can change availability. It is deliberately
  // a no-op when nothing is open, so callers do not each have to check — a
  // condition repeated at nine call sites is a condition that will be forgotten
  // at the tenth.
  //
  // SILENT ON FAILURE, and that is a considered choice rather than laziness: the
  // mutation itself already succeeded and reported. A toast here would tell the
  // user their delete failed when it did not. The visible consequence of a
  // failed refresh is a panel showing figures that are one step behind, which is
  // exactly the state they were in before this fix — no worse, and recoverable
  // by searching again.
  const refreshResultsPanel = async () => {
    if (!resultsSource) return;
    try {
      await runResultsSource(resultsSource);
    } catch (err) {
      console.error('Could not refresh the open results panel:', err);
    }
  };


  // Dismiss the results panel (PR 6I item 4b). Clearing the rows AND the source
  // together, so "nothing is showing" is one fact rather than two that can
  // disagree.

  // --- CHECKOUT / RETURN ---


  // Closing the guide via X / back = cancel: revert the toggle we just committed
  // by calling the opposite endpoint. (Done button keeps the status.)
  const handleCheckoutCancel = async () => {
    const id = checkoutDeckId;
    setShowCheckoutModal(false);
    if (!id) return;
    const undo = checkoutMode === 'checkout' ? 'return' : 'checkout';
    try {
      const res = await fetch(`/api/decks/${id}/${undo}`, { method: 'PUT' });
      if (!res.ok) { showToast(t('deck.errUndo')); return; }
      if (activeDeck && activeDeck.id === id) {
        const back = checkoutMode === 'checkout';
        setActiveDeck(prev => ({ ...prev, checked_out: back ? 0 : 1, checked_out_at: back ? null : new Date().toISOString() }));
      }
      fetchDecks();
      showToast(t(checkoutMode === 'checkout' ? 'deck.checkoutCanceled' : 'deck.returnCanceled'));
    } catch (err) {
      console.error(err);
      showToast(t('deck.errUndo'));
    }
  };

  // --- DRAW SIMULATOR LOGIC ---
  const startSimulator = () => {
    if (!activeDeck || deckCards.length === 0) {
      showToast(t('deck.errEmptyDeck'));
      return;
    }

    // Expand cards into full array based on quantities. Considering entries are
    // excluded: you cannot draw a card you have not put in the deck.
    const fullDeck = [];
    deckCards.forEach(c => {
      for (let i = 0; i < c.quantity; i++) {
        fullDeck.push({ ...c });
      }
    });

    const shuffled = shuffleArray(fullDeck);
    setSimulatorDeck(shuffled);
    setHand(shuffled.slice(0, 7));
    setMulliganCount(0);
    setShowSimulator(true);
  };

  const handleMulligan = () => {
    const shuffled = shuffleArray(simulatorDeck);
    const nextMulligan = mulliganCount + 1;
    const drawCount = Math.max(1, 7 - nextMulligan);
    setSimulatorDeck(shuffled);
    setHand(shuffled.slice(0, drawCount));
    setMulliganCount(nextMulligan);
  };

  const handleDrawCard = () => {
    const nextIndex = hand.length;
    if (nextIndex >= simulatorDeck.length) {
      showToast(t('deck.errNoCardsLeft'));
      return;
    }
    setHand([...hand, simulatorDeck[nextIndex]]);
  };

  // --- EXPORT & IMPORT LOGIC ---
  const effectiveExportFormat = exportFormat || 'mtga';

  // THE BUYLIST, FETCHED FROM THE SERVER (PR 7).
  //
  // Not derived from `deckCards` on the client, deliberately. The shortfall is
  // computed AFTER other saved decks' reservations, and that arithmetic lives
  // once on the server (deckIdentity.buylistForDeck). Re-deriving it here
  // would create a second answer to "must I buy this card", and the one the
  // user acts on would depend on which screen they happened to open.
  const refreshBuylist = async (deckId) => {
    if (!deckId) return;
    try {
      const response = await fetch(`/api/decks/${deckId}/buylist`);
      if (!response.ok) throw new Error('buylist failed');
      setBuylist(await response.json());
    } catch (err) {
      console.error(err);
      // Left as null rather than emptied: an empty buylist MEANS "you own
      // everything", which is a claim we cannot make when the fetch failed.
      setBuylist(null);
    }
  };

  // The MULTI-DECK buylist, also fetched from the server, for the same reason.
  //
  // The aggregate is a SUM OF PER-DECK SHORTFALLS (deckIdentity.buylistForDecks)
  // — never "what these decks want minus what I own", which would double-count
  // a single copy wanted by two decks. That arithmetic is not repeated here.
  //
  // LIVE, NOT ON A BUTTON (PR 7B). Ticking a deck IS the instruction, so there
  // is nothing left to confirm; the old "Build buylist" button asked him a
  // question whose answer was already on screen. The sequencing that makes live
  // updating safe — debounce, discarding stale answers, never requesting an
  // empty selection — lives in buylistSync.js, where it can be tested against
  // the actual out-of-order interleavings. See that file's header.




  // The multi-deck buylist as text, reusing the SAME exporter as the per-deck
  // one so the two can never describe different purchases — including the
  // bracket style, which is one piece of state shared by both (PR 7C).

  // The buylist as text, from the SERVER's lines.
  //
  // buildDeckExport is reused rather than a second formatter, so the copied
  // text and the on-screen panel cannot describe different purchases. The
  // server's items already carry `quantity` as the shortfall, so it is mapped
  // onto the shape the exporter expects rather than recomputed.
  const buylistText = () => buildDeckExport(
    (buylist?.items || []).map(item => ({ ...item, quantity_missing: item.quantity })),
    'buylist',
    { bracketStyle: buylistBracketStyle }
  );


  const handleExportDeckText = () => {
    if (!activeDeck) return '';
    // The buylist option reads the SERVER's list; every other format describes
    // the deck itself. That split is the whole point of the two outputs: an
    // EXPORT lists all planned cards including the missing ones (a decklist is
    // what the deck IS), while the buylist lists only the gap.
    if (effectiveExportFormat === 'buylist') return buylistText();
    return buildDeckExport(deckCards, effectiveExportFormat);
  };

  const handleCopyExportText = () => {
    const text = handleExportDeckText();
    navigator.clipboard.writeText(text)
      .then(() => showToast(t('deck.copied')))
      .catch(() => showToast(t('deck.errCopy')));
  };

  // Copy the buylist and open TCGplayer Mass Entry — user pastes (their mass
  // entry page has no documented prefill URL param, so clipboard + open is the
  // reliable path).
  //
  // PR 7: the text now comes from the SERVER's buylist rather than being
  // re-derived from the open deck's card list. The old client-side derivation
  // could not see other decks' reservations, so it under-reported what he
  // actually had to buy — the copied list was short exactly where it mattered.
  const handleOpenMassEntry = () => {
    const text = buylistText();
    if (!text) { showToast(t('deck.nothingToBuy')); return; }
    navigator.clipboard.writeText(text).catch(() => {});
    window.open('https://www.tcgplayer.com/massentry?productline=Magic', '_blank', 'noopener');
    showToast(t('deck.buylistCopied'));
  };

  // Discard everything about the current import attempt.
  //
  // The preview, the pending printing choices and the open picker are one unit
  // of state: keeping choices alive after the text changed would apply a
  // printing the user picked for a line that no longer exists.
  const resetImportState = () => {
    setImportComparison(null);
    setImportSummary(null);
    setImportChoices({});
    setImportPicker(null);
  };

  // Preview what the import WILL do, without doing it.
  //
  // The server returns a per-line plan: which owned printings it would spend,
  // how many copies came from the collection, what is short, and -- for lines
  // it has no basis to decide (Case C) -- the printing choices to offer.
  // Nothing is recomputed here: the numbers on this screen are the same numbers
  // the import will act on, because they came out of the same call.
  //
  // Re-previewing after a choice is deliberate. A choice turns a bare line into
  // an explicit one, which changes what the line will do, and the preview must
  // keep telling the truth about that rather than showing a stale plan.
  const handleCompareImport = async (choices = importChoices) => {
    if (!importText.trim() || !activeDeck) return;
    setComparingImport(true);
    try {
      const result = await postImport(activeDeck.id, importText, { apply: false, choices });
      setImportComparison(result ? result.lines : []);
      setImportSummary(result ? result.summary : null);
    } catch (err) {
      console.error(err);
      showToast(t('deck.errNoMatches'));
    } finally {
      setComparingImport(false);
    }
  };

  // Record the printing the user picked for one import line, then re-preview.
  //
  // The choice is remembered against the line, not written to the deck: this is
  // still the preview, and the user has not pressed Import yet.
  const chooseImportPrinting = async (item, variant) => {
    const next = {
      ...importChoices,
      [importLineKey(item.name)]: { variant }
    };
    setImportChoices(next);
    setImportPicker(null);
    await handleCompareImport(next);
  };

  // Commit the import.
  //
  // Lines still AWAITING a printing choice are refused rather than imported.
  // The alternative -- import them against something -- is precisely the
  // auto-pinning this feature exists to remove: the app would be choosing a
  // physical card the user never named. Refusing costs one extra click; the
  // silent version costs a trip to the binder for a card that is not there.
  const handleImportDeck = async () => {
    if (!activeDeck) return;

    const undecided = (importComparison || []).filter(l => l.needs_choice);
    if (undecided.length > 0) {
      showToast(t('deck.importNeedsChoices', { count: undecided.length }));
      return;
    }

    const result = await postImport(activeDeck.id, importText, { apply: true, choices: importChoices });
    if (!result) return;

    // THE COMPLETION MESSAGE USES THE SERVER'S NUMBERS, NOT RE-DERIVED ONES.
    //
    // This used to count LINES whose status was not 'unresolved' and call them
    // imported, which counted a line still awaiting a printing choice as a
    // success. Combined with the guard above reading the PREVIEW, a paste could
    // report "imported" for copies that were never written -- the user read a
    // clean preview, read a clean toast, and got a short deck.
    //
    // The server states copies written and copies unresolved as one fact, so
    // the toast can only say what actually happened.
    const summary = result.summary || {};
    if (!summary.written_copies) {
      showToast(t('deck.errNoMatches'));
      return;
    }

    showToast(t('deck.importedCopies', { count: summary.written_copies }));

    // Copies the app could not place are reported alongside, never absorbed.
    // Leaving a card out is recoverable only if the user is told about it.
    //
    // Refusals are reported SEPARATELY from unresolved copies. They are a
    // different problem with a different fix -- an unresolved copy needs a
    // printing chosen, a refused copy cannot go in this deck at all -- and one
    // combined number would tell the user to do something that will not work.
    if (summary.refused_copies > 0) {
      showToast(t('deck.importRefusedToast', { count: summary.refused_copies }));
    }
    if (summary.unresolved_copies > summary.refused_copies) {
      showToast(t('deck.importUnresolvedCopies', {
        count: summary.unresolved_copies - summary.refused_copies
      }));
    }

    // Both, in this order: the deck the user is looking at, then the list they
    // will return to. Reloading only the deck leaves the list showing the row
    // as it was BEFORE the import wrote anything.
    await loadDeckDetails(activeDeck.id);
    await fetchDecks();
    setImportText('');
    setImportComparison(null);
    setImportSummary(null);
    setImportChoices({});
    setImportPicker(null);
    setShowImportModal(false);
  };


  // DROP ONE HALF OF A PARTNER PAIR: a swap of the zone from two commanders to
  // one.
  //
  // Reuses the SAME confirmation panel the replacement swap uses, because it is
  // the same conversation: the server answers with COMMANDER_SWAP_REMOVES_CARDS
  // and the identical payload, so the existing panel renders it unchanged. The
  // only difference is what the confirm button re-sends.
  //
  // `commanderRefusedSwap` carries { dropping } instead of { replacing, card },
  // so the panel's confirm knows which request to repeat. Remembering the
  // attempt rather than reading current state matters for the same reason it
  // does on the swap: the list the user agreed to must describe the write that
  // then happens.


  // Swap a commander on an EXISTING deck.
  //
  // ONE atomic server-side replace, for exactly the reason repinEntryPrinting
  // is. This was an add-then-remove pair of requests, ordered so a failure left
  // a visible extra commander rather than a deck with none. But the window
  // between the two requests is a command zone holding two commanders, and the
  // server now refuses a zone it judges illegal -- so swapping to a different
  // printing of the SAME commander could not succeed at all, because the add
  // half was a second copy by name. Naming the row being replaced makes it one
  // write: the zone never transiently holds both, and a refusal rolls the whole
  // swap back with the commander the user already had left in place.

  // The cards that are actually IN the deck.
  //
  // Considering entries are excluded from every count, chart and total on this
  // screen. They are cards the user is thinking about, not cards in the deck;
  // counting them would make a finished 100-card Commander deck report 107 and
  // read as illegal. They still render, in their own section, with live
  // availability -- they are just not part of the deck's arithmetic.
  const deckCards = activeDeck ? activeDeck.cards.filter(c => c.board !== 'considering') : [];

  // Card type read off the cached Scryfall type_line, which is the same source
  // the deck list sections use. One definition of "what type is this card"
  // rather than one per screen.

  // --- CHART DATA GENERATION ---



  // --- SELECTION MENU METRICS & FILTERING ---

  const filteredDecks = decks.filter(deck => {
    const q = deckSearchTerm.trim().toLowerCase();
    const matchesSearch = !q ||
      deck.name.toLowerCase().includes(q) ||
      (deck.description && deck.description.toLowerCase().includes(q));



    let matchesStatus = true;
    if (deckStatusFilter === 'ready') matchesStatus = deck.total_cards === (deck.target_size || 60);
    else if (deckStatusFilter === 'in_progress') matchesStatus = (deck.total_cards || 0) < (deck.target_size || 60);
    else if (deckStatusFilter === 'in_play') matchesStatus = !!deck.checked_out;

    return matchesSearch && matchesStatus;
  }).sort((a, b) => {
    if (deckSortBy === 'name_asc') return a.name.localeCompare(b.name);
    if (deckSortBy === 'cards_desc') return (b.total_cards || 0) - (a.total_cards || 0);
    if (deckSortBy === 'created_asc') return new Date(a.created_at) - new Date(b.created_at);
    return new Date(b.created_at) - new Date(a.created_at);
  });

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      
      {/* 1. SELECTION MENU VIEW OF ALL DECKS */}
      {/* DECK LIST -- now its own component, built against the approved
          mockup (sketches/003-deck-list). Zach: "the deck list in the mock was
          perfect please go to that."

          Extracted rather than restyled in place. The 621 lines it replaces
          held a grid/table toggle, a filter row, an inline create form, the
          multi-deck selection bar and the buylist panel, all interleaved with
          the detail view in one 4,351-line file.

          The buylist LOGIC is unchanged: same /api/decks/buylist endpoint, same
          buylistSync sequencing, same one-copy-per-deck arithmetic measured on
          dev (two decks wanting one Sol Ring -> quantity 2).

          filteredDecks and its search/sort state are kept: DeckList does its own
          text search, but the surrounding screen still owns the deck fetch. */}
      {viewMode === 'list' && (
        <DeckList
          decks={filteredDecks}
          loading={loading}
          onOpenDeck={loadDeckDetails}
          onNewDeck={() => setShowCreateModal(true)}
          onDeleteDeck={handleDeleteDeck}
          showToast={showToast}
        />
      )}

      {/* 2. DECK EDITOR / DETAIL VIEW */}
      {/* DECK VIEW -- its own component, built to the mockup Zach reviewed
          line by line and approved (sketches/009-deck-view).

          Replaces 1,056 lines that held the card list, the missing panel, the
          export area, checkout, the printing picker, categories and playtest
          in one screen. Zach: "this is horrible so cluttered. The mockup was
          so clean and simple."

          KEPT, at his direction: quantity editing, commander swap, and moving
          cards between the deck and Considering.
          DROPPED: checkout / in-play, the printing picker, card categories,
          playtest.

          The old handlers below are now unreferenced. They are NOT deleted in
          this commit: an automated sweep of them produced four syntax errors
          by cutting into neighbouring code, and dead code is recoverable where
          deleted capability is not. They come out in a separate, verified
          pass. */}
      {viewMode === 'detail' && activeDeck && (
        <DeckView
          deck={activeDeck}
          onBack={() => setViewMode('list')}
          onChanged={() => loadDeckDetails(activeDeck.id)}
          showToast={showToast}
        />
      )}

      {/* --- POPUPS & MODALS --- */}

      {/* A. Create Deck Modal */}
      {/* NEW DECK -- its own component now, built against the approved mockup
          (sketches/005-new-deck). Zach: "the add new deck modal is completely
          wrong why didn't we follow the mock for that??"

          He was right: I rebuilt the deck LIST and left this untouched, so
          tapping "New deck" dropped out of the new design into the old one.

          FORMAT COMES FIRST because it decides whether the commander question
          exists at all. Commander and Bracket are HIDDEN for formats that do
          not have them, not greyed -- a disabled field still makes you stop and
          work out why it is there. */}
      <NewDeckModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        showToast={showToast}
        onCreate={async (payload) => {
          // The decklist is NOT part of the create call -- POST /api/decks
          // does not read it, and sending an unread field makes it look saved.
          const { decklist, ...deckFields } = payload;

          const res = await fetch('/api/decks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(deckFields),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok) throw new Error(body?.error || t('deck.createFailed'));

          // DO NOT CLOSE YET. The deck row exists, but an import may still have
          // 100 lines to write, and dismissing here shows a finished-looking
          // screen over a list that has not been refreshed. The modal holds
          // its saving state until the work is actually done.

          // THE DECK EXISTS NOW, so a failed import is not a failed create.
          // Reported separately for that reason: losing the decklist is
          // annoying, losing the deck would be worse, and conflating them
          // would suggest the whole thing failed.
          let imported = null;
          let needsChoices = false;
          if (decklist && body?.id) {
            try {
              // PREVIEW FIRST. A bare card name with no set code is ambiguous
              // -- "Lightning Bolt" has 65 printings -- and this app records
              // the exact printing you own. The server refuses to guess and
              // returns needs_choice instead; applying straight away threw
              // those lines away.
              const preview = await postImport(body.id, decklist, { apply: false });
              const needsChoice = (preview?.lines || []).filter(l => l.needs_choice);

              if (needsChoice.length === 0) {
                imported = await postImport(body.id, decklist, { apply: true });
              } else {
                // Hand over to the picker that already exists rather than
                // dropping the lines. The deck is created and holds whatever
                // was unambiguous; the rest is one screen away, not lost.
                setImportText(decklist);
                // The modal reads the LINES array, not the whole response
                // (line 1263). Passing the envelope would render nothing.
                setImportComparison(preview?.lines || []);
                setImportChoices({});
                setShowImportModal(true);
                needsChoices = true;
                showToast(
                  t('deck.importNeedsChoices', { count: needsChoice.length }),
                  'error',
                );
              }
            } catch (err) {
              showToast(err?.message || t('deck.importFailed'), 'error');
            }
          }

          if (imported) {
            // Real field names, verified at routes/decks.js:1752.
            const written = imported.summary?.written_copies ?? 0;
            const unresolved = imported.summary?.unresolved_copies ?? 0;
            // STATES WHAT DID NOT LAND. A silent partial import leaves a deck
            // that looks complete and is not -- the wrong-record failure, and
            // the one Zach minds most.
            showToast(
              unresolved > 0
                ? t('deck.importedPartial', { count: written, unresolved })
                : t('deck.importedAll', { count: written }),
              unresolved > 0 ? 'error' : 'success',
            );
          } else {
            showToast(t('deck.created'), 'success');
          }

          // REFRESH AFTER THE IMPORT SETTLES, not before it.
          //
          // fetchDecks() was already awaited here, but it ran before the
          // import had written anything, so the new row showed an empty deck
          // at 0% until a manual reload. The list must reflect what is
          // actually in the database now.
          await fetchDecks();

          // NOW the modal can go: the deck exists, the import has finished,
          // and the list behind it holds the real numbers.
          setShowCreateModal(false);

          // Do NOT navigate away while the printing picker is open: he has
          // lines to resolve, and the deck view would hide them.
          if (body?.id && !needsChoices) loadDeckDetails(body.id);
        }}
      />

      {/* B. Draw Hand Simulator Modal */}
      {showSimulator && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: Z_MODAL }}>
          <div className="glass-panel" style={{ maxWidth: '1000px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', position: 'relative' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setShowSimulator(false)} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>

            <div>
              <h3 style={{ fontSize: '1.25rem', color: 'var(--text-strong)', margin: 0 }}>{t('deck.handSimulator')}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.2rem' }}>
                Test your deck consistency. Shuffled deck. Mulligan count: <strong style={{ color: 'var(--accent-red)' }}>{mulliganCount}</strong>. Hand size: <strong>{hand.length}</strong> cards.
              </p>
            </div>

            {/* Hand Area */}
            <div style={{ 
              background: 'rgba(0,0,0,0.4)', 
              minHeight: '220px', 
              borderRadius: 'var(--radius-md)', 
              border: '1px solid var(--border-glass)', 
              display: 'flex', 
              flexWrap: 'wrap', 
              justifyContent: 'center', 
              alignItems: 'center', 
              gap: '1rem', 
              padding: '1.5rem' 
            }}>
              {hand.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{t('deck.noCardsDrawn')}</div>
              ) : (
                hand.map((card, idx) => (
                  <div key={idx} style={{ 
                    width: '130px', 
                    aspectRatio: 0.718, 
                    borderRadius: '8px', 
                    overflow: 'hidden', 
                    boxShadow: '0 4px 10px rgba(0,0,0,0.5)',
                    animation: 'draw-card-anim 0.3s ease-out forwards',
                    border: '1px solid var(--border-glass)',
                    position: 'relative',
                    cursor: 'pointer'
                  }} onClick={() => setPreviewCard(card)}>
                    <img src={card.image_url} alt={card.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                ))
              )}
            </div>

            {/* Control buttons */}
            <div style={{ display: 'flex', justifyContent: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={startSimulator} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {t('deck.reshuffle')}
              </button>
              <button 
                className="btn btn-secondary" 
                onClick={handleMulligan} 
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                disabled={hand.length === 0}
              >
                Mulligan (Draw {Math.max(1, 7 - (mulliganCount + 1))})
              </button>
              <button 
                className="btn btn-primary" 
                onClick={handleDrawCard} 
                style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                disabled={hand.length >= simulatorDeck.length}
              >
                {t('deck.drawOne')}
              </button>
            </div>

            <style>{`
              @keyframes draw-card-anim {
                from { transform: translateY(30px) scale(0.85); opacity: 0; }
                to { transform: translateY(0) scale(1); opacity: 1; }
              }
              @keyframes shimmer-gold {
                0% { background-position: 0% center; }
                100% { background-position: 200% center; }
              }
            `}</style>
          </div>
        </div>
      )}

      {/* C. Export Modal */}
      {showExportModal && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: Z_MODAL }}>
          <div className="glass-panel" style={{ maxWidth: '500px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '1.75rem', position: 'relative' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setShowExportModal(false)} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>
            <h3 style={{ fontSize: '1.2rem', color: 'var(--text-strong)', marginBottom: '0.5rem' }}>{t('deck.exportTitle')}</h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>{t('deck.exportHintBody')}</p>
            <select
              className="input-control"
              style={{ width: '100%', marginBottom: '1rem', fontSize: '0.85rem' }}
              value={effectiveExportFormat}
              onChange={e => setExportFormat(e.target.value)}
            >

              <option value="mtga">{t('deck.formatMtga')}</option>
              <option value="plain">Plain text (qty + name)</option>
              <option value="buylist">Buylist – cards you still need</option>
            </select>
            {effectiveExportFormat === 'buylist' && (
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '-0.5rem', marginBottom: '1rem' }}>
                {t('deck.buylistHint')}
              </p>
            )}
            <textarea
              readOnly
              className="input-control"
              style={{ width: '100%', height: '220px', fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' }}
              value={handleExportDeckText()}
            />
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowExportModal(false)}>{t('common.close')}</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleCopyExportText}>{t('deck.copyClipboard')}</button>
              {effectiveExportFormat === 'buylist' && (
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleOpenMassEntry}>{t('deck.copyOpenTcg')}</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* D. Import Modal with Collection Comparison */}
      {showImportModal && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: Z_MODAL }}>
          <div className="glass-panel" style={{ maxWidth: '600px', width: '100%', padding: '1.75rem', position: 'relative', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => { setShowImportModal(false); resetImportState(); }} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>
            <h3 style={{ fontSize: '1.2rem', color: 'var(--text-strong)', marginBottom: '0.5rem' }}>{t('deck.importTitle')}</h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>Paste decklist lines (e.g. <code>4 Lightning Bolt</code> or <code>2 Counterspell</code>):</p>
            
            <textarea
              className="input-control"
              style={{ width: '100%', minHeight: '120px', maxHeight: '180px', fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' }}
              placeholder={`4 Pikachu\n2 Ultra Ball\n1 Boss's Orders`}
              value={importText}
              onChange={e => { setImportText(e.target.value); resetImportState(); }}
            />

            {/* Comparison results table */}
            {comparingImport ? (
              <div style={{ padding: '1.5rem', textAlign: 'center' }}>
                <div className="spinner" style={{ margin: '0 auto 0.5rem auto' }}></div>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('deck.comparing')}</span>
              </div>
            ) : importComparison && (
              <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1, overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  <span>Collection Availability Breakdown:</span>
                  <span style={{ color: 'var(--accent-yellow)', fontWeight: 700 }}>
                    {importComparison.filter(i => i.status === 'full').length}/{importComparison.length} lines fully owned
                  </span>
                </div>
                {/* THE COPY-LEVEL TOTAL.
                    The line counts above answer "how many of my lines are
                    fine", which is not the question the user actually has. The
                    question is "how many cards will this put in my deck", and
                    a paste can have every line look fine while copies go
                    unplaced -- two lines naming one card in two different ways
                    each ask the collection separately.
                    So the copies are stated plainly, from the server's own
                    accounting, and any copy that cannot be placed is named here
                    BEFORE the user commits rather than discovered afterwards. */}
                {importSummary && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    <span>
                      {importSummary.planned_copies} of {importSummary.requested_copies} requested cards will be added
                    </span>
                    {importSummary.unresolved_copies > 0 && (
                      <span style={{ color: 'var(--accent-yellow)', fontWeight: 700 }}>
                        {importSummary.unresolved_copies} still need a printing
                      </span>
                    )}
                  </div>
                )}

                {/* REFUSED LINES, STATED BEFORE THE IMPORT COMMITS.
                    A refusal is not a warning and it is not a shortfall: the
                    card cannot go in this deck at all, and no amount of
                    choosing a printing will change that. So it gets its own
                    red block above the line list rather than being folded into
                    the yellow "needs a printing" count -- which would send the
                    user hunting for a picker that is not there.

                    Every refused line is NAMED with its reason. That is the
                    whole promise of pre-flight validation: the user sees what
                    will happen before it happens, and nothing is dropped
                    quietly. */}
                {importSummary && importSummary.lines_refused > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.35)', borderRadius: 'var(--radius-sm)', padding: '0.5rem' }}>
                    <span style={{ fontSize: '0.72rem', fontWeight: 800, color: '#f87171', display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <AlertTriangle size={12} />
                      {t('deck.importRefusedHeading', { count: importSummary.refused_copies })}
                    </span>
                    {(importSummary.refusals || []).map((refusal, i) => (
                      <span key={i} style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                        {refusal.reason}
                      </span>
                    ))}
                  </div>
                )}
                <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '180px', overflowY: 'auto' }}>
                  {importComparison.map((item, idx) => (
                    <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.75rem', padding: '0.25rem 0.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '4px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{item.name}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Req: {item.requested}</span>
                          <span style={{
                            padding: '2px 6px',
                            borderRadius: '10px',
                            fontWeight: 700,
                            fontSize: '0.65rem',
                            ...(TONE_STYLES[
                              item.status === 'full' ? 'ok'
                                : item.status === 'partial' ? 'warn'
                                  // MISSING IS RED HERE TOO (Zach, 2026-08-18:
                                  // "missing should show red not yellow").
                                  //
                                  // The same word on the same table has to mean
                                  // the same thing on every screen. Fixing only
                                  // the deck row badge would leave this pill
                                  // amber on the screen the user reads BEFORE
                                  // committing an import -- the one place the
                                  // shortfall is most worth acting on.
                                  //
                                  // 'partial' stays amber deliberately: some
                                  // copies WILL be allocated, so it is a
                                  // different answer, not a softer one.
                                  : item.status === 'missing' ? 'unavailable'
                                    : 'unavailable'
                            ])
                          }}>
                            {item.status === 'full' ? `Owned (${item.allocated})`
                              : item.status === 'partial' ? `Partial (${item.allocated}/${item.requested})`
                                : item.status === 'missing' ? `Missing (${item.shortfall})`
                                  : item.status === 'refused' ? t('deck.importRefusedBadge')
                                    : 'Not found'}
                          </span>
                        </div>
                      </div>

                      {/* The reason this line will not import, on the line
                          itself as well as in the summary above. The summary
                          answers "what is wrong with this paste"; this answers
                          "why is THIS line red", which is the question the user
                          has while looking at it. */}
                      {item.refused && item.refusal_reason && (
                        <span style={{ fontSize: '0.68rem', color: '#f87171' }}>
                          {item.refusal_reason}
                        </span>
                      )}
                      {/* Which physical printings this line will actually
                          spend. Shown before the import commits, because a
                          mixed-printing allocation is a decision about the
                          user's physical cards and they should see it rather
                          than discover it in the deck afterwards.

                          Every badge here names a printing that is either
                          OWNED or was EXPLICITLY STATED by the line. Nothing
                          the app chose on its own can appear -- when it has no
                          basis to choose it asks below instead. */}
                      {(item.allocations || []).length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                          {item.allocations.map((allocation, i) => (
                            <span key={i} style={{
                              fontSize: '0.6rem',
                              fontWeight: 700,
                              padding: '1px 6px',
                              borderRadius: '4px',
                              background: 'rgba(255,255,255,0.06)',
                              color: allocation.owned ? 'var(--text-secondary)' : '#fbbf24',
                              border: '1px solid var(--border-glass)',
                              whiteSpace: 'nowrap'
                            }}>
                              {allocation.quantity}x {allocation.set_name} • #{allocation.number} · {finishLabel(allocation.desired_finish)}
                              {allocation.owned ? '' : ` · ${t('deck.importNotOwned')}`}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* CASE C: the line named a card but not a printing, and
                          the user owns NO free copies to infer one from. That
                          is the only situation the app has nothing to go on, so
                          it is the only one that asks -- using the same
                          printing picker as the Add Cards flow and the deck
                          rows, in place, rather than a new screen.

                          A line he owns SOME of never reaches here: the server
                          extends the printing he already owns to cover the rest
                          and the extra copies show up as an unowned allocation
                          badge above, exactly like a card he has not bought.

                          Left unanswered the line is not imported; it is also
                          not dropped, because it is sitting right here waiting.
                          A chosen line collapses back into an ordinary
                          allocation badge above on the next preview. */}
                      {item.needs_choice && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => setImportPicker(
                              importPicker === importLineKey(item.name) ? null : importLineKey(item.name)
                            )}
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.25rem 0.5rem', fontSize: '0.68rem', textAlign: 'left' }}
                          >
                            <span style={{ color: 'var(--accent-yellow)', fontWeight: 700 }}>
                              {t('deck.choosePrinting')} ({item.choice_quantity})
                            </span>
                            <ChevronDown size={11} />
                          </button>

                          {importPicker === importLineKey(item.name) && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', background: 'rgba(0,0,0,0.25)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.4rem', maxHeight: '150px', overflowY: 'auto' }}>
                              {(item.choices || []).length === 0 ? (
                                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                                  {t('deck.noPrintingsKnown')}
                                </span>
                              ) : item.choices.map(variant => (
                                <button
                                  key={`${variant.desired_card_id}-${variant.finish}`}
                                  type="button"
                                  className="btn btn-secondary"
                                  onClick={() => chooseImportPrinting(item, variant)}
                                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.3rem 0.5rem', fontSize: '0.72rem', textAlign: 'left' }}
                                >
                                  <span style={{ color: 'var(--text-strong)' }}>
                                    {variant.set_name} • #{variant.number}
                                  </span>
                                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                    <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)', border: '1px solid var(--border-glass)' }}>
                                      {finishLabel(variant.finish)}
                                    </span>
                                    <span style={{ color: 'var(--text-muted)' }}>
                                      {`${variant.available_qty} free`}
                                    </span>
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => { setShowImportModal(false); resetImportState(); }}>{t('common.cancel')}</button>
              {!importComparison ? (
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => handleCompareImport()} disabled={!importText.trim()}>{t('deck.compare')}</button>
              ) : (
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleImportDeck}>{t('deck.importMatched')}</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* E. High-Res Card Art Preview Popover */}
      {previewCard && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setPreviewCard(null)}>
          <div className="glass-panel" style={{ maxWidth: '340px', padding: '1rem', position: 'relative', textAlign: 'center', animation: 'draw-card-anim 0.25s ease-out forwards' }} onClick={e => e.stopPropagation()}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setPreviewCard(null)} style={{ position: 'absolute', top: '0.5rem', right: '0.5rem', borderRadius: '50%', zIndex: 10 }}>
              <X size={16} />
            </button>
            <img
              src={previewCard.image_url}
              alt={previewCard.name}
              style={{ width: '100%', borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }}
            />
            <h4 style={{ color: 'var(--text-strong)', margin: '0.75rem 0 0.25rem 0', fontSize: '1rem' }}>{previewCard.name}</h4>
            <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.75rem' }}>
              {previewCard.set_name} • #{previewCard.number} ({previewCard.rarity || 'Common'})
            </p>
          </div>
        </div>
      )}

      {/* Checkout Locator Modal */}
      {showCheckoutModal && (
        <CheckoutWizardModal
          locationsData={checkoutLocations}
          mode={checkoutMode}
          onCancel={handleCheckoutCancel}
          onClose={() => setShowCheckoutModal(false)}
        />
      )}

    </div>
  );
}

export default DeckBuilder;
