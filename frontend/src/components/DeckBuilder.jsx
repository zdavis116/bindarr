import { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, X, ChevronLeft, Play, BarChart2, Search, LogOut, PackageCheck, LayoutGrid, List, Download, Upload, Eye, Filter, CheckCircle, AlertTriangle, Layers, Swords, Gamepad2, SlidersHorizontal, ArrowRight, FolderPlus, FileText, ChevronDown, ChevronRight, Lightbulb, ShoppingCart } from 'lucide-react';
import { ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import { shuffleArray } from '../utils/shuffle';

import CheckoutWizardModal from './CheckoutWizardModal';
import { useBackGuard } from '../utils/useBackGuard';
import { buildDeckExport, parseDeckLine, BRACKET_STYLES, DEFAULT_BRACKET_STYLE } from '../utils/deckText';
import { useT } from '../utils/i18n';
import { groupDeckCards, sectionCount, sectionForTypeLine, requirementStatus, finishLabel } from './deckSections';
import CardTile, { FinishBadge } from './CardTile';
import MissingCardsPanel from './MissingCardsPanel';
import { createBuylistSync } from './buylistSync';

// Basic lands are exempt from the four-copy deck rule.
const isBasicEnergyOrLand = (card) => {
  if (!card) return false;
  const subs = card.subtypes || [];
  const basicTypes = ['Basic', 'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'];
  return (subs.includes('Land') || card.supertype === 'Land') && basicTypes.some(t => subs.includes(t) || card.name === t);
};

// Total copies of a card (matched by name) already in a deck's card list.
//
// Matched by NAME on purpose, and this is the one place name-matching is
// correct: Magic's four-copy rule is about the card name, so four different
// printings of Lightning Bolt is still four Lightning Bolts. Everywhere else in
// this file identity means (printing, finish).
const deckCountByName = (deckCards, name) =>
  (deckCards || []).filter(c => c.name === name).reduce((s, c) => s + c.quantity, 0);

// The badge that carries a row's reservation/ownership state, in the same
// pill styling the rest of the app uses for status.
const TONE_STYLES = {
  ok: { background: 'rgba(74, 222, 128, 0.15)', color: '#4ade80', border: '1px solid rgba(74, 222, 128, 0.3)' },
  warn: { background: 'rgba(234, 179, 8, 0.15)', color: '#fbbf24', border: '1px solid rgba(234, 179, 8, 0.3)' },
  unavailable: { background: 'rgba(239, 68, 68, 0.15)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.35)' },
  muted: { background: 'var(--surface-2)', color: 'var(--text-secondary)', border: '1px solid var(--border-glass)' }
};

// The identity of an import LINE, for matching a user's printing choice back to
// the line it was made on.
//
// Keyed on the lowercased card name, which is what a bare (Case C) line is: a
// name with no printing. Explicit lines never need a key because they never ask
// a question.
function importLineKey(name) {
  return String(name || '').trim().toLowerCase();
}

function StatusBadge({ card }) {
  const status = requirementStatus(card);
  if (!status.label) return null;
  const tone = TONE_STYLES[status.tone] || TONE_STYLES.muted;
  return (
    <span style={{
      fontSize: '0.62rem',
      fontWeight: 800,
      padding: '2px 7px',
      borderRadius: '10px',
      whiteSpace: 'nowrap',
      ...tone
    }}>
      {status.label}
    </span>
  );
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
function PrintingBadge({ card, onClick }) {
  const interactive = typeof onClick === 'function';
  return (
    <span
      onClick={interactive ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      title={interactive ? 'Change printing' : undefined}
      style={{
        fontSize: '0.6rem',
        fontWeight: 700,
        padding: '1px 6px',
        borderRadius: '4px',
        background: 'rgba(255,255,255,0.06)',
        color: 'var(--text-secondary)',
        border: '1px solid var(--border-glass)',
        whiteSpace: 'nowrap',
        cursor: interactive ? 'pointer' : undefined
      }}
    >
      {finishLabel(card.desired_finish)}
    </span>
  );
}


function DeckBuilder({ showToast }) {
  const { t } = useT();
  const [decks, setDecks] = useState([]);
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
  const [selectMode, setSelectMode] = useState(false);
  const [selectedDeckIds, setSelectedDeckIds] = useState([]);
  const [multiBuylist, setMultiBuylist] = useState(null);
  const [multiBuylistLoading, setMultiBuylistLoading] = useState(false);
  
  // Deck View & Display Modes
  const [cardDisplayMode, setCardDisplayMode] = useState('list'); // 'list' | 'grid'
  const [previewCard, setPreviewCard] = useState(null);

  // Deck Creation States & Constants

  const MTG_FORMATS = ['Commander / EDH', 'Standard', 'Modern', 'Pioneer', 'Legacy', 'Vintage', 'Pauper'];
  const DECK_CATEGORIES = ['Competitive', 'Casual', 'Tournament', 'Theorycraft', 'Proxy', 'Trade'];
  const DECK_ACCENT_COLORS = [
    { name: 'Gold', hex: '#eab308' },
    { name: 'Red', hex: '#ef4444' },
    { name: 'Blue', hex: '#3b82f6' },
    { name: 'Green', hex: '#10b981' },
    { name: 'Purple', hex: '#a855f7' },
    { name: 'Slate', hex: '#64748b' },
    { name: 'Pink', hex: '#ec4899' },
    { name: 'Orange', hex: '#f97316' },
  ];

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newDeckName, setNewDeckName] = useState('');
  const [newDeckDesc, setNewDeckDesc] = useState('');

  const [newDeckFormat, setNewDeckFormat] = useState('Commander / EDH');
  const [newDeckCategory, setNewDeckCategory] = useState('Competitive');
  const [newDeckAccentColor, setNewDeckAccentColor] = useState('#eab308');
  const [newDeckTargetSize, setNewDeckTargetSize] = useState(100);
  const [newDeckImportText, setNewDeckImportText] = useState('');
  const [showImportDecklistArea, setShowImportDecklistArea] = useState(false);

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
  const [newDeckCommanders, setNewDeckCommanders] = useState([]);
  const [commanderQuery, setCommanderQuery] = useState('');
  const [commanderResults, setCommanderResults] = useState([]);
  const [commanderSearching, setCommanderSearching] = useState(false);

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
  const [commanderRefusal, setCommanderRefusal] = useState(null);
  const [commanderOverrideReason, setCommanderOverrideReason] = useState('');
  // The swap that was refused, held so an override can RE-SEND EXACTLY the
  // same write. Re-deriving it from the search results at confirm time would
  // risk overriding a different card than the one the refusal describes.
  const [commanderRefusedSwap, setCommanderRefusedSwap] = useState(null);

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
  const [commanderSwapRemoval, setCommanderSwapRemoval] = useState(null);

  // Whether the deck being created is a Commander deck. Every commander
  // control on the modal is gated on this, so other formats show no extra
  // field, run no extra validation, and look exactly as they did.
  const isCommanderFormat = (format) => /commander|edh/i.test(String(format || ''));
  const newDeckIsCommander = isCommanderFormat(newDeckFormat);

  // Swap the commander of an EXISTING deck. Held here so the deck view can
  // open the same search panel the create modal uses rather than growing a
  // second one.
  const [commanderSwap, setCommanderSwap] = useState(null); // { replacing } | null
  
  // Card Search States inside editor
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
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
  const [resultsSource, setResultsSource] = useState(null);

  // Deck Selection Menu Controls
  const [deckSearchTerm, setDeckSearchTerm] = useState('');
  const [deckStatusFilter, setDeckStatusFilter] = useState('all'); // 'all' | 'ready' | 'in_progress' | 'in_play'
  const [deckSortBy, setDeckSortBy] = useState('created_desc'); // 'created_desc' | 'created_asc' | 'name_asc' | 'cards_desc'
  const [deckSelectionViewMode, setDeckSelectionViewMode] = useState('table'); // 'grid' | 'table'

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
  const [buylistBracketStyle, setBuylistBracketStyleState] = useState(() => {
    const stored = localStorage.getItem('buylist_bracket_style');
    return BRACKET_STYLES.includes(stored) ? stored : DEFAULT_BRACKET_STYLE;
  });
  const setBuylistBracketStyle = (style) => {
    if (!BRACKET_STYLES.includes(style)) return;
    setBuylistBracketStyleState(style);
    localStorage.setItem('buylist_bracket_style', style);
  };
  // The server's buylist for the open deck (PR 7). `null` means "not loaded or
  // the fetch failed" and is deliberately distinct from a loaded-but-empty
  // list, which is the positive claim "you own every card in this deck".
  const [buylist, setBuylist] = useState(null);
  const [buylistLoading, setBuylistLoading] = useState(false);
  const [importText, setImportText] = useState('');
  const [importComparison, setImportComparison] = useState(null);
  // The server's copy-level accounting for the previewed paste. Kept beside the
  // per-line plan rather than recomputed from it: "how many cards will this
  // actually add" must have exactly one definition, and the server owns it.
  const [importSummary, setImportSummary] = useState(null);
  const [comparingImport, setComparingImport] = useState(false);

  // Checkout States
  const [checkingOut, setCheckingOut] = useState(false);
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const [checkoutLocations, setCheckoutLocations] = useState([]);
  const [checkoutMode, setCheckoutMode] = useState('checkout'); // 'checkout' | 'checkin'
  const [checkoutDeckId, setCheckoutDeckId] = useState(null); // deck the open modal acts on

  // True while an add/qty write is in flight. Blocks overlapping clicks that
  // would otherwise each compute a new quantity from the same stale render and
  // clobber one another (last-writer-wins on the server upsert).
  const [savingCard, setSavingCard] = useState(false);

  // Exact printing + finish picker state.
  //
  // Under exact-only identity, "add Lightning Bolt" is not a complete
  // instruction -- the server needs to know WHICH Lightning Bolt. When the user
  // owns exactly one (printing, finish) variant there is nothing to ask, so we
  // add it straight away. When they own several, this holds the search result
  // we are asking about and the variants they can choose from. It is a small
  // inline panel inside the existing Add Cards list, not a separate screen.
  const [variantPicker, setVariantPicker] = useState(null); // { card, variants, board }
  const [loadingVariants, setLoadingVariants] = useState(false);

  // Repin an EXISTING deck entry to a different printing.
  //
  // Holds { entryId, variants } for the one row being edited. The picker it
  // opens is the same inline panel the Add Cards list uses, rendered inside the
  // deck row itself rather than on a new screen, and it lists only printings
  // the user OWNS -- with the count that is actually FREE, not the raw owned
  // count. Those differ whenever another deck holds copies, and the free number
  // is the one that answers "if I switch to this printing, will my deck
  // actually be filled".
  const [printingEditor, setPrintingEditor] = useState(null);

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
  const [collapsedSections, setCollapsedSections] = useState(() => new Set());

  const toggleSection = (key) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

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
  const searchCommanders = async (query) => {
    if (!query.trim()) { setCommanderResults([]); return; }
    setCommanderSearching(true);
    try {
      const res = await fetch(`/api/search?name=${encodeURIComponent(query)}&game=mtg&commanders=1`);
      if (res.ok) setCommanderResults(await res.json());
      else showToast(t('deck.errSearch'));
    } catch (err) {
      console.error(err);
      showToast(t('deck.errSearch'));
    } finally {
      setCommanderSearching(false);
    }
  };

  // Turn a search result into a commander choice.
  //
  // A finish is required, and it comes from the printing's own finish list --
  // its only finish when it has exactly one, otherwise nonfoil as that
  // printing's ordinary default. This is the same rule the import path uses
  // for an explicitly-named printing, so the app never invents a finish a
  // printing does not offer.
  const commanderChoiceFromCard = (card) => {
    const finishes = Array.isArray(card.finishes) ? card.finishes : [];
    const finish = finishes.length === 1
      ? finishes[0]
      : (finishes.includes('nonfoil') ? 'nonfoil' : (finishes[0] || 'nonfoil'));
    return {
      desired_card_id: card.id,
      desired_finish: finish,
      name: card.name,
      set_name: card.set_name,
      number: card.number,
      image_url: card.image_url,
      oracle_id: card.oracle_id
    };
  };

  const addCommanderChoice = (card) => {
    // Changing the commanders INVALIDATES any refusal on screen. Without this
    // the user could read a refusal about one pair, swap a card, and then
    // "override" a complaint that no longer describes what they have chosen --
    // and the recorded reason would name the wrong mechanic, poisoning the
    // very feedback loop the reason exists to feed.
    setCommanderRefusal(null);
    setCommanderOverrideReason('');
    const choice = commanderChoiceFromCard(card);
    setNewDeckCommanders(prev => {
      if (prev.length >= 2) return prev;
      // The same card twice is not a partner pair. Refused here as well as on
      // the server, so the user finds out at the moment they click rather than
      // when the create fails.
      if (prev.some(c => c.desired_card_id === choice.desired_card_id
        && c.desired_finish === choice.desired_finish)) return prev;
      return [...prev, choice];
    });
    setCommanderQuery('');
    setCommanderResults([]);
  };

  const removeCommanderChoice = (index) => {
    // Same reason as addCommanderChoice: a refusal describes a specific pair,
    // so changing the pair must retire it.
    setCommanderRefusal(null);
    setCommanderOverrideReason('');
    setNewDeckCommanders(prev => prev.filter((_, i) => i !== index));
  };

  // Reset every field the create modal owns. One function rather than a list
  // of setters repeated at each exit, because a field forgotten in one of
  // those lists leaks into the next deck the user creates.
  const resetCreateForm = () => {
    setNewDeckName('');
    setNewDeckDesc('');
    setNewDeckFormat('Commander / EDH');
    setNewDeckCategory('Competitive');
    setNewDeckAccentColor('#eab308');
    setNewDeckTargetSize(100);
    setNewDeckImportText('');
    setShowImportDecklistArea(false);
    setNewDeckCommanders([]);
    setCommanderQuery('');
    setCommanderResults([]);
    setCommanderRefusal(null);
    setCommanderOverrideReason('');
  };

  // `override` is passed ONLY when the user has explicitly confirmed a refusal
  // and typed a reason. It is a parameter rather than component state read at
  // send time so there is no path where a stale confirmation from an earlier
  // attempt silently applies to a different pair of commanders.
  const handleCreateDeck = async (e, override = null) => {
    e.preventDefault();
    if (!newDeckName.trim()) return;

    // A Commander deck without a commander is refused here as well as on the
    // server. The client check exists so the user is told before the round
    // trip; the server check exists because the client is not the authority.
    if (newDeckIsCommander && newDeckCommanders.length === 0) {
      showToast(t('deck.commanderRequired'));
      return;
    }

    try {
      const response = await fetch('/api/decks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          name: newDeckName, 
          description: newDeckDesc,
          format: newDeckFormat,
          category: newDeckCategory,
          accent_color: newDeckAccentColor,
          target_size: newDeckTargetSize,
          // Sent only for Commander. Other formats post exactly the body they
          // posted before this change.
          ...(newDeckIsCommander ? {
            commanders: newDeckCommanders.map(c => ({
              desired_card_id: c.desired_card_id,
              desired_finish: c.desired_finish
            })),
            // Present ONLY on an explicitly confirmed retry. Its absence is
            // what makes the server refuse, which is the point: there must be
            // no request shape where the override happens by default.
            ...(override ? { commander_override: override } : {})
          } : {})
        })
      });

      if (response.ok) {
        const created = await response.json().catch(() => ({}));
        showToast(t('deck.created'));

        // Quick import runs AFTER the deck exists, through the server's import
        // endpoint. It allocates from printings the user actually owns and has
        // free, and honours any printing a line explicitly names, so an
        // ordinary decklist paste just works.
        //
        // What it CANNOT do here is ask. There is no preview on the create
        // modal, so lines the app has no basis to decide (bare name, nothing
        // owned) are left out of the deck rather than pinned to a guess, and
        // the user is told how many so they can finish them from the deck's own
        // Import screen where the picker lives. Leaving a card out is visible
        // and recoverable; putting in the wrong physical card is neither.
        if (newDeckImportText.trim() && created.id) {
          const result = await postImport(created.id, newDeckImportText, { apply: true });
          if (result) {
            // Same rule as the deck Import screen: report COPIES, using the
            // server's own accounting, so the message cannot overstate what
            // reached the deck. Counting lines here previously called a line
            // that allocated nothing a success.
            const summary = result.summary || {};
            if (summary.written_copies > 0) {
              showToast(t('deck.importedCopies', { count: summary.written_copies }));
            }
            if (summary.unresolved_copies > 0) {
              showToast(t('deck.importUnresolvedCopies', { count: summary.unresolved_copies }));
            }
          }
        }

        setShowCreateModal(false);
        resetCreateForm();
        fetchDecks();
      } else {
        // The server states WHY a create was refused (no commander, too many,
        // a duplicated partner). Showing its message rather than a generic
        // failure is the difference between the user fixing it and the user
        // clicking the same button again.
        const data = await response.json().catch(() => ({}));

        // A refusal the server marks OVERRIDABLE is held on the form rather
        // than thrown away in a toast, so the user can read what was refused
        // and decide. A toast would vanish before they could act on it, and
        // acting on it is the entire point.
        //
        // Only `overridable` refusals get this treatment. Singleton and the
        // other fixed rules do NOT set it, so they fall through to the plain
        // toast and stay un-overridable -- the app cannot be wrong about them,
        // so there is nothing for the user to confirm.
        if (data.overridable) {
          setCommanderRefusal(data);
          // The reason box starts EMPTY on every new refusal. Carrying a
          // previous reason forward would be the app pre-filling the user's
          // justification, which is exactly the "pre-ticked checkbox" the
          // spec rules out.
          setCommanderOverrideReason('');
          return;
        }

        setCommanderRefusal(null);
        showToast(data.error || t('deck.errCreate'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errCreateGeneric'));
    }
  };

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
  const writeRequirement = async ({ desired_card_id, desired_finish, board = 'mainboard', quantity, commander_override = null, replacing_deck_card_id = null, confirm_remove_off_identity = false }) => {
    if (!activeDeck) return false;
    const response = await fetch(`/api/decks/${activeDeck.id}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        desired_card_id, desired_finish, board, quantity,
        // Sent only on an explicitly confirmed retry, exactly as on create.
        ...(commander_override ? { commander_override } : {}),
        // Sent only when this write EDITS an existing row -- a re-pin, a finish
        // change, a commander re-printing. It tells the server which row the
        // user is changing, so the singleton rule excludes that row instead of
        // counting it as a duplicate of itself, and so the replace lands as one
        // atomic write rather than an add followed by a delete.
        ...(replacing_deck_card_id ? { replacing_deck_card_id } : {}),
        // The user has SEEN the named list of cards a commander swap will
        // remove and agreed to it. Sent only on that confirmed retry -- its
        // absence means the server asks first, which is the whole point.
        ...(confirm_remove_off_identity ? { confirm_remove_off_identity: true } : {})
      })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      // A COMMANDER SWAP THAT WILL REMOVE CARDS is not an error -- it is the
      // server asking a question, with the exact cards named. Handed back to
      // the caller so the swap panel can show the list and take a confirmation,
      // rather than being flattened into a toast the user cannot act on.
      if (data.code === 'COMMANDER_SWAP_REMOVES_CARDS') {
        setCommanderSwapRemoval(data);
        return false;
      }
      // An overridable commander refusal is handed back to the caller instead
      // of being flattened into a toast, so the swap flow can offer the same
      // explicit confirmation the create modal does. Everything else keeps
      // the existing behaviour untouched.
      if (data.overridable) {
        setCommanderRefusal(data);
        setCommanderOverrideReason('');
        return false;
      }
      showToast(data.error || 'Failed to save card.');
      return false;
    }
    return true;
  };

  // Fetch the exact (printing, finish) variants of a card the user owns.
  const fetchVariants = async (oracleId) => {
    if (!oracleId) return [];
    const res = await fetch(`/api/decks/printings/${encodeURIComponent(oracleId)}`);
    if (!res.ok) return [];
    return res.json();
  };

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
  const handleAddCardToDeck = async (card, board = 'mainboard') => {
    if (!activeDeck || savingCard) return;

    // The row already IS an exact (printing, finish). Nothing to ask.
    if (card.exact && card.finish) {
      await addExactVariant({
        desired_card_id: card.desired_card_id || card.id,
        name: card.name,
        set_name: card.set_name,
        number: card.number,
        image_url: card.image_url,
        finish: card.finish,
        owned_qty: card.owned_qty
      }, board);
      return;
    }

    setLoadingVariants(true);
    try {
      const variants = await fetchVariants(card.oracle_id);

      if (variants.length === 0) {
        // Nothing owned in any printing. The search result itself still names
        // an exact printing, but we do not know a finish for it, so we ask
        // rather than assume. Finishes come from the printing's own list.
        setVariantPicker({
          card,
          board,
          variants: (card.finishes || ['nonfoil']).map(finish => ({
            desired_card_id: card.id,
            name: card.name,
            set_name: card.set_name,
            number: card.number,
            image_url: card.image_url,
            finish,
            owned_qty: 0
          }))
        });
        return;
      }

      if (variants.length === 1) {
        await addExactVariant(variants[0], board);
        return;
      }

      setVariantPicker({ card, board, variants });
    } catch (err) {
      console.error(err);
      showToast(t('search.errAddCard'));
    } finally {
      setLoadingVariants(false);
    }
  };

  // Commit a chosen exact variant, incrementing whatever is already there.
  const addExactVariant = async (variant, board = 'mainboard') => {
    if (!activeDeck || savingCard) return;

    const existing = activeDeck.cards.find(c =>
      c.desired_card_id === variant.desired_card_id &&
      c.desired_finish === variant.finish &&
      c.board === board
    );
    const newQty = existing ? existing.quantity + 1 : 1;

    setSavingCard(true);
    try {
      const ok = await writeRequirement({
        desired_card_id: variant.desired_card_id,
        desired_finish: variant.finish,
        board,
        quantity: newQty
      });
      if (ok) {
        showToast(t('deck.addedCard', { name: variant.name }));
        setVariantPicker(null);
        await loadDeckDetails(activeDeck.id);
      }
    } catch (err) {
      console.error(err);
      showToast(t('search.errAddCard'));
    } finally {
      setSavingCard(false);
    }
  };

  // Open the repin picker for one deck row.
  //
  // Loads the printings the user owns of this Oracle card, each with the count
  // that is actually free. Loaded on demand rather than with the deck, because
  // availability is a fact about the whole collection at this instant and a
  // copy fetched with the deck would be stale by the time the user clicked.
  const openPrintingEditor = async (entry) => {
    if (!entry?.oracle_id) return;
    setLoadingVariants(true);
    try {
      const variants = await fetchVariants(entry.oracle_id);
      setPrintingEditor({ entryId: entry.id, variants });
    } catch (err) {
      console.error(err);
      showToast(t('search.errAddCard'));
    } finally {
      setLoadingVariants(false);
    }
  };

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
  const repinEntryPrinting = async (entry, variant) => {
    if (!activeDeck || savingCard) return;
    if (entry.desired_card_id === variant.desired_card_id
      && entry.desired_finish === variant.finish) {
      setPrintingEditor(null);
      return;
    }

    setSavingCard(true);
    try {
      // An existing row for the printing being moved TO is merged into, so the
      // re-pin does not lose the copies already required against it.
      const existing = activeDeck.cards.find(c =>
        c.desired_card_id === variant.desired_card_id &&
        c.desired_finish === variant.finish &&
        c.board === entry.board &&
        c.id !== entry.id
      );
      const ok = await writeRequirement({
        desired_card_id: variant.desired_card_id,
        desired_finish: variant.finish,
        board: entry.board,
        quantity: (existing ? existing.quantity : 0) + entry.quantity,
        replacing_deck_card_id: entry.id
      });
      if (!ok) return;

      setPrintingEditor(null);
      await loadDeckDetails(activeDeck.id);
    } catch (err) {
      console.error(err);
      showToast(t('deck.errQuantity'));
    } finally {
      setSavingCard(false);
    }
  };

  // Change the quantity of an EXISTING requirement.
  //
  // Takes the whole entry rather than a card id, because a card id is no longer
  // unique within a deck: the same printing can legitimately sit on the
  // mainboard and the sideboard, in nonfoil and in foil. The entry carries the
  // exact identity to re-send.
  const handleUpdateCardQty = async (entry, newQty) => {
    if (!activeDeck || savingCard) return;

    // Guard against NaN/garbage from a manual quantity input before it reaches
    // the server as an invalid quantity.
    if (!Number.isFinite(newQty)) return;

    if (newQty <= 0) {
      // A COMMANDER IS SWAPPED, NEVER DELETED (Zach, 2026-08-19). The server
      // refuses the delete outright, so leaving this control wired to it would
      // give the user a button that always errors.
      //
      // ADAPTED IN PLACE rather than removed: the control keeps its position,
      // its styling and its meaning ("get rid of this card"), and routes to the
      // operation that can actually express the user's intent.
      //
      // TWO CASES, because the zone's size decides what "get rid of this one"
      // can mean:
      //
      //   A PARTNER PAIR -> dropping one leaves a legal single-commander zone,
      //     so this IS a supported change. It goes through dropCommander, which
      //     is the same plan-and-confirm path as a replacement swap and names
      //     any cards the narrowed identity would strand.
      //   THE ONLY COMMANDER -> there is nothing to drop to. The deck must keep
      //     a commander, so the control opens the swap panel to pick the
      //     replacement instead of erroring.
      if (entry.board === 'commander') {
        const commanderCount = (activeDeck.cards || [])
          .filter(c => c.board === 'commander').length;
        if (commanderCount > 1) {
          dropCommander(entry);
          return;
        }
        setCommanderResults([]);
        setCommanderQuery('');
        setCommanderSwap({ replacing: entry });
        showToast(t('deck.commanderSwapOnly'));
        return;
      }
      handleRemoveCard(entry.id);
      return;
    }

    // The four-copy rule is a legality warning, and the server also reports it,
    // but blocking the increment here keeps the user from making a change the
    // deck health panel will immediately scold them for. Ownership is NOT
    // checked: planning a deck you have not finished buying is the normal case,
    // and the row's own badge already reports the shortfall.
    if (newQty > entry.quantity
      && !isBasicEnergyOrLand(entry)
      && deckCountByName(activeDeck.cards, entry.name) >= 4) {
      showToast(t('deck.errCopyLimit', { count: 4, name: entry.name }));
      return;
    }

    setSavingCard(true);
    try {
      const ok = await writeRequirement({
        desired_card_id: entry.desired_card_id,
        desired_finish: entry.desired_finish,
        board: entry.board,
        quantity: newQty
      });
      if (ok) await loadDeckDetails(activeDeck.id);
    } catch (err) {
      console.error(err);
      showToast(t('deck.errQuantity'));
    } finally {
      setSavingCard(false);
    }
  };

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
  const handleMoveBoard = async (entry, board) => {
    if (!activeDeck || savingCard || entry.board === board) return;
    setSavingCard(true);
    try {
      const existing = activeDeck.cards.find(c =>
        c.desired_card_id === entry.desired_card_id &&
        c.desired_finish === entry.desired_finish &&
        c.board === board
      );
      const ok = await writeRequirement({
        desired_card_id: entry.desired_card_id,
        desired_finish: entry.desired_finish,
        board,
        quantity: (existing ? existing.quantity : 0) + entry.quantity,
        replacing_deck_card_id: entry.id
      });
      if (!ok) return;

      await loadDeckDetails(activeDeck.id);
    } catch (err) {
      console.error(err);
      showToast(t('deck.errQuantity'));
    } finally {
      setSavingCard(false);
    }
  };

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
  const handleRemoveCard = async (deckCardId) => {
    if (!activeDeck) return;

    try {
      const response = await fetch(`/api/decks/${activeDeck.id}/cards/${deckCardId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      if (response.ok) {
        showToast(t('deck.cardRemoved'));
        loadDeckDetails(activeDeck.id);
        return;
      }

      const data = await response.json().catch(() => ({}));
      // Every refusal carries a message worth reading -- "a commander is
      // swapped, not deleted" is actionable, and flattening it to a generic
      // error would hide the way forward.
      showToast(data.error || t('loc.errRemoveCard'));
    } catch (err) {
      console.error(err);
      showToast(t('loc.errRemoveCard'));
    }
  };

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
  const groupOwnedByVariant = (rows) => {
    const byVariant = new Map();
    for (const item of rows) {
      const finish = item.finish || 'nonfoil';
      const key = `${item.card_id}|${finish}`;
      const existing = byVariant.get(key);
      if (existing) {
        existing.owned_qty += (item.quantity || 1);
        continue;
      }
      byVariant.set(key, {
        id: item.card_id,
        oracle_id: item.oracle_id,
        name: item.name,
        set_name: item.set_name,
        number: item.number || item.collector_number || item.card_number || '',
        image_url: item.image_url,
        rarity: item.rarity,
        price_trend: item.price_trend,
        owned_qty: item.quantity || 1,
        // THE CROSS-DECK COMMITMENT, carried through from the server.
        //
        // NOT accumulated like owned_qty. Ownership is summed because each row
        // is one physical card, but in_deck_qty is already the TOTAL for this
        // (printing, finish) across every deck -- the server computed it once
        // per variant. Adding it up per collection row would multiply it by the
        // number of copies owned and claim far more was committed than exists.
        in_deck_qty: item.in_deck_qty ?? 0,
        // The exact identity this row IS. Carried explicitly so the add path
        // can send it straight to the server rather than re-deriving it from
        // a search result that has no finish.
        finish,
        desired_card_id: item.card_id,
        exact: true,
        supertype: item.supertype,
        subtypes: item.subtypes,
        types: item.types,
        type_line: item.type_line,
        finishes: item.finishes,
        colors: item.colors,
        cmc: item.cmc
      });
    }
    return [...byVariant.values()];
  };

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
      setSearchResults(groupOwnedByVariant(await res.json()));
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
    setSearchResults(await response.json());
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

  const handleSearchCards = async (e, forceBrowse = false) => {
    if (e) e.preventDefault();

    // BROWSE COLLECTION IS A TOGGLE (PR 6I item 4b). Pressing the button while
    // the browse listing is open closes it. Previously the button only ever
    // opened the panel, so once open there was no way to dismiss it at all --
    // which matters most on a phone, where it occupies most of the screen.
    if (forceBrowse && resultsSource?.mode === 'browse') {
      closeResultsPanel();
      return;
    }

    const source = (forceBrowse || !searchQuery.trim())
      ? { mode: 'browse' }
      : { mode: 'search', query: searchQuery };

    try {
      setSearching(true);
      // Any new result list invalidates an open picker: it was asking about a
      // card that may no longer be on screen.
      setVariantPicker(null);
      // SCOPE=DATABASE, NOT COLLECTION, for the search branch. This is the whole
      // of PR 6G item 5.
      //
      // The search was hardcoded to `scope=collection`, so it could only ever
      // return cards the user already owned. Searching for anything else came
      // back empty -- which reads exactly like "no such card" -- and that is
      // why unowned cards could not be added as requirements. The backend
      // route already defaults to the full catalogue and always could; the
      // client was the thing narrowing it.
      //
      // Owned and unowned stay DISTINGUISHABLE because every row carries
      // `owned_qty` from the server, which the row's "Owned: N" badge below
      // already renders -- an unowned card simply reads "Owned: 0". Since
      // PR 6I item 3 the owned ones also sort to the top, so his own printing
      // is on screen rather than several scrolls down a 104k-card catalogue.
      await runResultsSource(source);
      // Recorded only AFTER the request succeeded, so a failed search does not
      // leave the panel claiming to show something it never loaded.
      setResultsSource(source);
    } catch (err) {
      console.error(err);
      showToast(t(err.status === 429 ? 'deck.errRateLimit' : 'deck.errSearch'));
    } finally {
      setSearching(false);
    }
  };

  // Dismiss the results panel (PR 6I item 4b). Clearing the rows AND the source
  // together, so "nothing is showing" is one fact rather than two that can
  // disagree.
  const closeResultsPanel = () => {
    setSearchResults([]);
    setResultsSource(null);
    setVariantPicker(null);
  };

  // --- CHECKOUT / RETURN ---
  const handleCheckout = async (deck = null) => {
    const targetDeck = deck || activeDeck;
    if (!targetDeck) return;
    try {
      setCheckingOut(true);
      const res = await fetch(`/api/decks/${targetDeck.id}/checkout`, { method: 'PUT' });
      if (res.ok) {
        showToast(t('deck.checkedOut', { name: targetDeck.name }));
        if (activeDeck && activeDeck.id === targetDeck.id) {
          setActiveDeck(prev => ({ ...prev, checked_out: 1, checked_out_at: new Date().toISOString() }));
        }
        fetchDecks();

        const locRes = await fetch(`/api/decks/${targetDeck.id}/locations`);
        if (locRes.ok) {
          const locData = await locRes.json();
          setCheckoutLocations(locData);
          setCheckoutMode('checkout');
          setCheckoutDeckId(targetDeck.id);
          setShowCheckoutModal(true);
        }
      } else {
        const errData = await res.json().catch(() => null);
        if (errData && errData.details && errData.details.length > 0) {
          showToast(t('deck.errCheckout', { detail: errData.details[0], extra: errData.details.length > 1 ? t('deck.andMore', { count: errData.details.length - 1 }) : '' }));
        } else {
          showToast(errData?.error || 'Failed to check out deck.');
        }
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errCheckoutGeneric'));
    } finally {
      setCheckingOut(false);
    }
  };

  const handleReturn = async (deck = null) => {
    const targetDeck = deck || activeDeck;
    if (!targetDeck) return;
    try {
      setCheckingOut(true);
      // Capture where each card lives before flipping the flag, so the check-in
      // guide can show where to return them (cards stay in their slots either
      // way, but fetch first to be safe).
      const locRes = await fetch(`/api/decks/${targetDeck.id}/locations`);
      const locData = locRes.ok ? await locRes.json() : null;
      const res = await fetch(`/api/decks/${targetDeck.id}/return`, { method: 'PUT' });
      if (res.ok) {
        showToast(t('deck.returned', { name: targetDeck.name }));
        if (activeDeck && activeDeck.id === targetDeck.id) {
          setActiveDeck(prev => ({ ...prev, checked_out: 0, checked_out_at: null }));
        }
        fetchDecks();
        if (locData) {
          setCheckoutLocations(locData);
          setCheckoutMode('checkin');
          setCheckoutDeckId(targetDeck.id);
          setShowCheckoutModal(true);
        }
      } else {
        showToast(t('deck.errReturn'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errReturnGeneric'));
    } finally {
      setCheckingOut(false);
    }
  };

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
    setBuylistLoading(true);
    try {
      const response = await fetch(`/api/decks/${deckId}/buylist`);
      if (!response.ok) throw new Error('buylist failed');
      setBuylist(await response.json());
    } catch (err) {
      console.error(err);
      // Left as null rather than emptied: an empty buylist MEANS "you own
      // everything", which is a claim we cannot make when the fetch failed.
      setBuylist(null);
    } finally {
      setBuylistLoading(false);
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
  const buylistSyncRef = useRef(null);
  if (buylistSyncRef.current === null) {
    buylistSyncRef.current = createBuylistSync({
      fetchBuylist: async (deckIds) => {
        const response = await fetch('/api/decks/buylist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deck_ids: deckIds })
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error || 'buylist failed');
        return payload;
      },
      onState: ({ loading, buylist, error }) => {
        setMultiBuylistLoading(loading);
        setMultiBuylist(buylist);
        if (error) showToast(error.message || t('deck.multiBuylistFailed'), 'error');
      }
    });
  }

  // THE SELECTION DRIVES THE LIST. Anything that changes selectedDeckIds —
  // a checkbox, a row tap, leaving the mode — flows through here, so "the list
  // matches the ticks" is true by construction rather than true wherever
  // somebody remembered to call a refresh.
  useEffect(() => {
    if (!selectMode) return;
    buylistSyncRef.current.select(selectedDeckIds);
  }, [selectMode, selectedDeckIds]);

  // Dropped on unmount so a late answer cannot land on a screen that is gone.
  useEffect(() => () => buylistSyncRef.current?.dispose(), []);

  const toggleDeckSelected = (deckId) => {
    setSelectedDeckIds(current => current.includes(deckId)
      ? current.filter(id => id !== deckId)
      : [...current, deckId]);
    // The list itself is dropped and refetched by the effect above; nothing to
    // clear by hand here, which is the point — one path, not two.
  };

  const exitBuylistMode = () => {
    setSelectMode(false);
    setSelectedDeckIds([]);
    buylistSyncRef.current.reset();
  };

  // The multi-deck buylist as text, reusing the SAME exporter as the per-deck
  // one so the two can never describe different purchases — including the
  // bracket style, which is one piece of state shared by both (PR 7C).
  const multiBuylistText = () => buildDeckExport(
    (multiBuylist?.items || []).map(item => ({ ...item, quantity_missing: item.quantity })),
    'buylist',
    { bracketStyle: buylistBracketStyle }
  );

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

  const handleCopyBuylist = () => {
    const text = buylistText();
    if (!text) { showToast(t('deck.nothingToBuy')); return; }
    navigator.clipboard.writeText(text)
      .then(() => showToast(t('deck.buylistCopied')))
      .catch(() => showToast(t('deck.errCopy')));
  };

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

    await loadDeckDetails(activeDeck.id);
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
  const dropCommander = async (commander, confirmRemove = false) => {
    if (!activeDeck || savingCard) return;
    setSavingCard(true);
    try {
      const response = await fetch(`/api/decks/${activeDeck.id}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          drop_commander_deck_card_id: commander.id,
          ...(confirmRemove ? { confirm_remove_off_identity: true } : {})
        })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (data.code === 'COMMANDER_SWAP_REMOVES_CARDS') {
          setCommanderRefusedSwap({ dropping: commander });
          setCommanderSwapRemoval(data);
          return;
        }
        showToast(data.error || t('deck.errQuantity'));
        return;
      }

      setCommanderRefusal(null);
      setCommanderOverrideReason('');
      setCommanderRefusedSwap(null);
      setCommanderSwapRemoval(null);
      setCommanderSwap(null);
      await loadDeckDetails(activeDeck.id);
    } catch (err) {
      console.error(err);
      showToast(t('deck.errQuantity'));
    } finally {
      setSavingCard(false);
    }
  };


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
  const swapCommander = async (replacing, card, override = null, confirmRemove = false) => {
    if (!activeDeck || savingCard) return;
    const choice = commanderChoiceFromCard(card);

    if (replacing
      && replacing.desired_card_id === choice.desired_card_id
      && replacing.desired_finish === choice.desired_finish) {
      setCommanderSwap(null);
      return;
    }

    setSavingCard(true);
    try {
      const ok = await writeRequirement({
        desired_card_id: choice.desired_card_id,
        desired_finish: choice.desired_finish,
        board: 'commander',
        quantity: 1,
        commander_override: override,
        // Only when REPLACING one. Adding a second commander to a deck that
        // has one is not an edit, and must still be judged as a new entry.
        replacing_deck_card_id: replacing ? replacing.id : null,
        confirm_remove_off_identity: confirmRemove
      });
      // A refused write leaves the command zone untouched, so there is nothing
      // to undo -- and the old commander is still in place, because the
      // replace is one transaction on the server rather than two requests here.
      if (!ok) {
        // A refused swap remembers WHAT was attempted, so the override
        // re-sends the identical write rather than whatever is selected by
        // the time the user finishes typing their reason. The same applies to
        // the removal confirmation: the list the user agreed to must describe
        // the write that then happens.
        setCommanderRefusedSwap({ replacing, card });
        return;
      }

      // The swap succeeded, so any refusal panel on screen is stale.
      setCommanderRefusal(null);
      setCommanderOverrideReason('');
      setCommanderRefusedSwap(null);
      setCommanderSwapRemoval(null);

      setCommanderSwap(null);
      setCommanderQuery('');
      setCommanderResults([]);
      await loadDeckDetails(activeDeck.id);
    } catch (err) {
      console.error(err);
      showToast(t('deck.errQuantity'));
    } finally {
      setSavingCard(false);
    }
  };

  // The cards that are actually IN the deck.
  //
  // Considering entries are excluded from every count, chart and total on this
  // screen. They are cards the user is thinking about, not cards in the deck;
  // counting them would make a finished 100-card Commander deck report 107 and
  // read as illegal. They still render, in their own section, with live
  // availability -- they are just not part of the deck's arithmetic.
  const deckCards = activeDeck ? activeDeck.cards.filter(c => c.board !== 'considering') : [];
  const consideringCards = activeDeck ? activeDeck.cards.filter(c => c.board === 'considering') : [];

  // Card type read off the cached Scryfall type_line, which is the same source
  // the deck list sections use. One definition of "what type is this card"
  // rather than one per screen.
  const cardGroup = (card) => sectionForTypeLine(card.type_line);

  const GROUP_ORDER = ['Creatures', 'Planeswalker', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Lands', 'Other'];

  // --- CHART DATA GENERATION ---
  const getSupertypeChartData = () => {
    if (!activeDeck) return [];
    const counts = {};
    deckCards.forEach(c => {
      const g = cardGroup(c);
      counts[g] = (counts[g] || 0) + c.quantity;
    });
    return GROUP_ORDER
      .filter(key => counts[key] > 0)
      .map(key => ({ name: key, value: counts[key] }));
  };

  const getManaCurveData = () => {
    if (!activeDeck) return [];
    const counts = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7+': 0 };
    deckCards.forEach(c => {
      const val = c.cmc !== undefined && c.cmc !== null ? c.cmc : null;
      if (val !== null) {
        const bucket = val >= 7 ? '7+' : String(Math.floor(val));
        if (counts[bucket] !== undefined) counts[bucket] += c.quantity;
      }
    });
    return Object.keys(counts).map(cost => ({ cost, count: counts[cost] }));
  };

  const getEnergyChartData = () => {
    if (!activeDeck) return [];
    const map = {};
    deckCards.forEach(c => {
      const subs = c.subtypes || [];
      const isLand = cardGroup(c) === 'Lands';
      if (isLand) {
        const basicLandTypes = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
        const foundType = basicLandTypes.find(t => subs.includes(t) || c.name.includes(t));
        const label = foundType ? `Land (${foundType})` : 'Land (Nonbasic)';
        map[label] = (map[label] || 0) + c.quantity;
      } else {
        const colors = c.color_identity || [];
        if (colors.length === 0) {
          map.Colorless = (map.Colorless || 0) + c.quantity;
        } else {
          colors.forEach(col => {
            const colorName = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' }[col] || col;
            map[colorName] = (map[colorName] || 0) + c.quantity;
          });
        }
      }
    });
    return Object.keys(map).map(key => ({ name: key, value: map[key] }));
  };

  const totalDeckCardsCount = deckCards.reduce((sum, c) => sum + c.quantity, 0);
  const targetDeckCardsCount = activeDeck?.target_size || 60;
  const supertypeData = getSupertypeChartData();
  const energyData = getEnergyChartData();
  const manaCurveData = getManaCurveData();

  const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

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
      {viewMode === 'list' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          
          {/* Top Banner Header & Primary Action */}
          <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', padding: '1.25rem 1.5rem', background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.7), rgba(15, 23, 42, 0.8))', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
            <div>
              <h2 style={{ fontSize: '1.4rem', color: 'var(--text-strong)', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
                <Layers size={22} style={{ color: 'var(--accent-yellow)' }} />
                {t('deck.vaultTitle')}
              </h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
                {t('deck.vaultSubtitle')}
              </p>
            </div>
            <button 
              className="btn btn-primary" 
              onClick={() => setShowCreateModal(true)}
              style={{ padding: '0.6rem 1.25rem', fontSize: '0.9rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem', boxShadow: '0 4px 14px rgba(234, 179, 8, 0.25)' }}
            >
              <Plus size={18} /> {t('deck.createDeck')}
            </button>
          </div>

          {/* Search, Filters, Sorting & View Toolbar */}
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1rem 1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
              
              {/* Search input */}
              <div style={{ position: 'relative', flex: '1 1 240px', minWidth: '220px' }}>
                <Search size={16} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  className="input-control"
                  placeholder={t('deck.filterPlaceholder')}
                  value={deckSearchTerm}
                  onChange={e => setDeckSearchTerm(e.target.value)}
                  style={{ paddingLeft: '2.25rem', width: '100%', fontSize: '0.85rem' }}
                />
                {deckSearchTerm && (
                  <button
                    className="btn btn-secondary btn-icon-only"
                    onClick={() => setDeckSearchTerm('')}
                    style={{ position: 'absolute', right: '0.4rem', top: '50%', transform: 'translateY(-50%)', width: '20px', height: '20px', padding: 0, fontSize: '0.7rem' }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border-glass)' }}>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                {/* Status Filter */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Filter size={14} style={{ color: 'var(--text-muted)' }} />
                  <select
                    className="select-control"
                    value={deckStatusFilter}
                    onChange={e => setDeckStatusFilter(e.target.value)}
                    style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', height: 'auto' }}
                  >
                    <option value="all">{t('deck.allStatuses')}</option>
                    <option value="ready">Battle Ready (60 Cards)</option>
                    <option value="in_progress">Building (&lt; 60 Cards)</option>
                    <option value="in_play">Currently In Play 🎮</option>
                  </select>
                </div>

                {/* Sort Order */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <SlidersHorizontal size={14} style={{ color: 'var(--text-muted)' }} />
                  <select
                    className="select-control"
                    value={deckSortBy}
                    onChange={e => setDeckSortBy(e.target.value)}
                    style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', height: 'auto' }}
                  >
                    <option value="created_desc">{t('deck.sortNewest')}</option>
                    <option value="created_asc">{t('deck.sortOldest')}</option>
                    <option value="name_asc">Name (A-Z)</option>
                    <option value="cards_desc">{t('deck.sortMostCards')}</option>
                  </select>
                </div>
              </div>

              {/* MULTI-DECK BUYLIST entry point. Named for the OUTCOME, not the
                  mechanism: he opens this because he wants a shopping list, and
                  picking decks is a step inside that, not the point of it. The
                  previous label ("Select decks") described the first interaction
                  and left the purpose unstated until he was already inside.
                  Once active the same button becomes the way out, so the mode
                  can always be left from where it was entered. */}
              <button
                type="button"
                className={`btn ${selectMode ? 'btn-primary' : 'btn-secondary'}`}
                style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                onClick={() => {
                  if (selectMode) { exitBuylistMode(); return; }
                  setSelectMode(true);
                }}
                title={t('deck.multiBuylistTitle')}
              >
                <ShoppingCart size={13} /> {t(selectMode ? 'deck.multiBuylistCancel' : 'deck.multiBuylistSelect')}
              </button>

              {/* View Mode Toggle: Grid vs Table */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', background: 'var(--surface-2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                <button
                  type="button"
                  className={`btn ${deckSelectionViewMode === 'grid' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                  onClick={() => setDeckSelectionViewMode('grid')}
                  title={t('deck.gridView')}
                >
                  <LayoutGrid size={13} /> Grid
                </button>
                <button
                  type="button"
                  className={`btn ${deckSelectionViewMode === 'table' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                  onClick={() => setDeckSelectionViewMode('table')}
                  title={t('deck.tableView')}
                >
                  <List size={13} /> Table
                </button>
              </div>

            </div>
          </div>

          {/* MULTI-DECK BUYLIST: the selection bar and its result.
              Sits between the toolbar and the deck list, so the deck list
              itself is untouched. Only rendered while selecting. */}
          {selectMode && (
            <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1rem 1.25rem' }}>
              {/* NO "BUILD" AND NO "CLEAR" (PR 7B).
                  The list follows the ticks live, so a build button would ask
                  him to confirm something he already said — the same mistake as
                  the printing picker removed in PR 6F. And "Clear" is just
                  unticking every deck, which now empties the list by itself.
                  The ONLY way out is the toolbar button he entered from, so the
                  flow has one exit rather than three competing controls. Fewer
                  buttons is also less width on a phone. */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-strong)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <ShoppingCart size={15} style={{ color: 'var(--accent-yellow)' }} />
                    {t('deck.multiBuylistTitle')}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {t('deck.multiBuylistStepHint')}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {t('deck.multiBuylistSelected', { count: selectedDeckIds.length })}
                  </span>
                </div>
              </div>

              {selectedDeckIds.length === 0 && (
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
                  {t('deck.multiBuylistEmptyHint')}
                </p>
              )}

              {multiBuylistLoading && <div className="spinner" style={{ margin: '1rem auto' }}></div>}

              {multiBuylist && !multiBuylistLoading && (
                <MissingCardsPanel
                  buylist={multiBuylist}
                  loading={false}
                  bracketStyle={buylistBracketStyle}
                  onBracketStyleChange={setBuylistBracketStyle}
                  onCopy={() => {
                    navigator.clipboard.writeText(multiBuylistText());
                    showToast(t('deck.buylistCopied'), 'success');
                  }}
                  onOpenMassEntry={() => {
                    navigator.clipboard.writeText(multiBuylistText());
                    window.open('https://www.tcgplayer.com/massentry', '_blank', 'noopener');
                  }}
                />
              )}
            </div>
          )}

          {/* Decks Display Section */}
          {loading ? (
            <div className="spinner" style={{ margin: '3rem auto' }}></div>
          ) : filteredDecks.length === 0 ? (
            <div className="glass-panel" style={{ textAlign: 'center', padding: '3.5rem 1.5rem', color: 'var(--text-secondary)' }}>
              <Layers size={36} style={{ color: 'var(--text-muted)', marginBottom: '0.75rem', opacity: 0.5 }} />
              <h3 style={{ color: 'var(--text-strong)', fontSize: '1.05rem', marginBottom: '0.25rem' }}>{t('deck.noMatches')}</h3>
              <p style={{ fontSize: '0.85rem' }}>{t('deck.noMatchesHint')}</p>
              {(deckSearchTerm || deckStatusFilter !== 'all') && (
                <button
                  className="btn btn-secondary"
                  style={{ marginTop: '1rem', fontSize: '0.8rem' }}
                  onClick={() => { setDeckSearchTerm(''); setDeckStatusFilter('all'); }}
                >
                  {t('deck.clearFilters')}
                </button>
              )}
            </div>
          ) : deckSelectionViewMode === 'grid' ? (
            /* --- GRID VIEW --- */
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.25rem' }}>
              {filteredDecks.map(deck => {
                const targetSize = deck.target_size || 60;
                const totalCards = deck.total_cards || 0;
                const isComplete = totalCards >= targetSize;
                const percent = Math.min(100, Math.round((totalCards / targetSize) * 100));
                const accentColor = deck.accent_color || '#ef4444';
                // SELECTED FOR THE BUYLIST. A ticked checkbox alone is too easy
                // to miss, and the cost of missing it is real: he shops for a
                // deck he did not mean to include. The card itself therefore
                // carries the state, in the app's EXISTING "active" language —
                // the same yellow already used for In Play, the picking rows
                // and the printing editor.
                //
                // Border COLOR changes, never border WIDTH, and the ring is an
                // INSET box-shadow: both are zero-width, so a selected card
                // occupies exactly the same box as an unselected one and
                // cannot reintroduce the PR 6I horizontal overflow on a phone.
                const isSelected = selectMode && selectedDeckIds.includes(deck.id);

                return (
                  <div
                    key={deck.id}
                    className="glass-panel"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      gap: '1rem',
                      padding: '1.25rem',
                      // FLAT SURFACES, matching the approved mockup
                      // (sketches/003-deck-list). The gradients were doing two
                      // jobs at once -- decoration AND state -- so a selected
                      // deck and a checked-out deck differed only by opacity of
                      // the same wash. State now changes the BORDER, which is
                      // readable at arm's length and survives OLED dimming.
                      borderRadius: 'var(--radius-md)',
                      border: isSelected
                        ? '2px solid var(--accent-blue)'
                        : deck.checked_out
                          ? '1px solid var(--accent-yellow)'
                          : '1px solid var(--border-glass)',
                      boxShadow: 'none',
                      position: 'relative',
                      overflow: 'hidden',
                      cursor: 'pointer',
                      transition: 'var(--transition-smooth)',
                      background: isSelected ? 'var(--surface-2)' : 'var(--surface-1)'
                    }}
                    /* In select mode a card TOGGLES instead of opening. The
                       deck list is adapted in place, not replaced. */
                    onClick={() => selectMode ? toggleDeckSelected(deck.id) : loadDeckDetails(deck.id)}
                    // Hover only lightens the surface. The old version lifted
                    // the card and threw a coloured shadow, which on true black
                    // reads as a rendering artefact rather than depth. Nothing
                    // to restore on leave, so selection can no longer be erased
                    // by a stray hover.
                    onMouseEnter={e => {
                      if (!isSelected) e.currentTarget.style.background = 'var(--surface-2)';
                    }}
                    onMouseLeave={e => {
                      if (!isSelected) e.currentTarget.style.background = 'var(--surface-1)';
                    }}
                  >
                    {/* SELECTION CHECKBOX, only while selecting. The card keeps
                        its existing layout; this sits over the accent line. */}
                    {selectMode && (
                      <div style={{ position: 'absolute', top: '10px', right: '10px', zIndex: 2 }}>
                        <input
                          type="checkbox"
                          checked={selectedDeckIds.includes(deck.id)}
                          onChange={() => toggleDeckSelected(deck.id)}
                          onClick={e => e.stopPropagation()}
                          aria-label={deck.name}
                          style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--accent-yellow)' }}
                        />
                      </div>
                    )}

                    {/* In Play Banner */}
                    {deck.checked_out ? (
                      <div style={{
                        marginTop: '4px',
                        background: 'linear-gradient(90deg, rgba(234,179,8,0.9), rgba(245,158,11,0.85))',
                        padding: '4px 10px',
                        borderRadius: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '0.65rem',
                        fontWeight: 800,
                        color: '#000',
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase'
                      }}>
                        <Gamepad2 size={12} />
                        <span>{t('deck.inPlay')}</span>
                        {deck.checked_out_at && (
                          <span style={{ marginLeft: 'auto', opacity: 0.8, fontWeight: 600 }}>
                            since {new Date(deck.checked_out_at).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    ) : null}

                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.15rem', fontWeight: 800, margin: 0, letterSpacing: '-0.01em' }}>
                              {deck.name}
                            </h3>
                            <span style={{
                              fontSize: '0.6rem',
                              fontWeight: 800,
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                              padding: '0.1rem 0.45rem',
                              borderRadius: '4px',
                              background: 'rgba(239,68,68,0.15)',
                              color: '#f87171',
                              border: '1px solid rgba(239,68,68,0.3)',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '3px'
                            }}>
                              <Swords size={10} /> MTG
                            </span>

                            {deck.format && (
                              <span style={{
                                fontSize: '0.6rem',
                                fontWeight: 700,
                                padding: '0.1rem 0.4rem',
                                borderRadius: '4px',
                                background: 'rgba(255,255,255,0.06)',
                                color: 'var(--text-secondary)',
                                border: '1px solid var(--border-glass)'
                              }}>
                                {deck.format}
                              </span>
                            )}

                            {deck.category && (
                              <span style={{
                                fontSize: '0.6rem',
                                fontWeight: 700,
                                padding: '0.1rem 0.4rem',
                                borderRadius: '4px',
                                background: 'rgba(59, 130, 246, 0.12)',
                                color: '#60a5fa',
                                border: '1px solid rgba(59, 130, 246, 0.25)'
                              }}>
                                {deck.category}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Status Badge */}
                        <span style={{
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          padding: '0.2rem 0.5rem',
                          borderRadius: '12px',
                          backgroundColor: isComplete ? 'rgba(74, 222, 128, 0.15)' : 'rgba(59, 130, 246, 0.15)',
                          color: isComplete ? '#4ade80' : '#60a5fa',
                          border: isComplete ? '1px solid rgba(74, 222, 128, 0.3)' : '1px solid rgba(59, 130, 246, 0.3)',
                          whiteSpace: 'nowrap'
                        }}>
                          {t(isComplete ? 'deck.statusReady' : 'deck.statusBuilding')}
                        </span>
                      </div>

                      <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginTop: '0.6rem', minHeight: '34px', lineHeight: '1.4' }}>
                        {deck.description || 'No description provided.'}
                      </p>
                    </div>

                    {/* Progress Bar & Details */}
                    {/* PROGRESS, per the approved mockup: the number leads and
                        the bar sits under it, with no box around either. The
                        old version wrapped this in its own bordered panel --
                        a card inside a card, which added an edge that meant
                        nothing.

                        Green only when complete. A part-built deck is not a
                        warning, so it stays neutral rather than amber: colour
                        here means "done", not "how far". */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                        <span style={{ fontSize: '1.05rem', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
                          {totalCards}<span style={{ color: 'var(--text-muted)', fontWeight: 500 }}> / {targetSize}</span>
                        </span>
                        <span style={{ fontSize: '0.78rem', fontWeight: 600, color: isComplete ? 'var(--accent-green)' : 'var(--text-secondary)' }}>
                          {isComplete ? t('deck.ready') : `${percent}%`}
                        </span>
                      </div>
                      <div style={{ width: '100%', height: '5px', background: 'var(--surface-3)', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{
                          height: '100%',
                          width: `${percent}%`,
                          background: isComplete ? 'var(--accent-green)' : 'var(--accent-blue)',
                          borderRadius: '3px',
                          transition: 'width 0.35s cubic-bezier(.2,.8,.3,1)'
                        }} />
                      </div>
                    </div>

                    {/* Card Footer Actions */}
                    <div style={{ borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                        Created {new Date(deck.created_at).toLocaleDateString()}
                      </span>

                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        {deck.checked_out ? (
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px', border: '1px solid var(--accent-yellow)', color: '#eab308' }}
                            onClick={(e) => { e.stopPropagation(); handleReturn(deck); }}
                            disabled={checkingOut}
                          >
                            <PackageCheck size={12} /> Return
                          </button>
                        ) : (
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                            onClick={(e) => { e.stopPropagation(); handleCheckout(deck); }}
                            disabled={checkingOut}
                          >
                            <LogOut size={12} /> Checkout
                          </button>
                        )}

                        <button
                          className="btn btn-primary"
                          style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                          onClick={(e) => { e.stopPropagation(); loadDeckDetails(deck.id); }}
                        >
                          Open <ArrowRight size={12} />
                        </button>

                        <button
                          className="btn btn-danger btn-icon-only"
                          style={{ padding: '0.3rem' }}
                          onClick={(e) => { e.stopPropagation(); handleDeleteDeck(deck.id, deck.name); }}
                          title={t('deck.deleteDeck')}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>

                  </div>
                );
              })}
            </div>
          ) : (
            /* --- TABLE VIEW --- */
            <div className="glass-panel" style={{ overflowX: 'auto', padding: 0 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-glass)', background: 'var(--surface-2)', color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    <th style={{ padding: '0.75rem 1rem' }}>{t('deck.colGameFormat')}</th>
                    <th style={{ padding: '0.75rem 1rem' }}>{t('deck.colNameDesc')}</th>
                    <th style={{ padding: '0.75rem 1rem' }}>{t('deck.colCapacity')}</th>
                    <th style={{ padding: '0.75rem 1rem' }}>{t('admin.colStatus')}</th>
                    <th style={{ padding: '0.75rem 1rem' }}>{t('admin.colCreated')}</th>
                    <th style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>{t('admin.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDecks.map(deck => {
                    const targetSize = deck.target_size || 60;
                    const totalCards = deck.total_cards || 0;
                    const isComplete = totalCards >= targetSize;
                    const percent = Math.min(100, Math.round((totalCards / targetSize) * 100));
                    const accentColor = deck.accent_color || '#ef4444';
                    // Same rule as the grid, same yellow. See the grid branch
                    // for why the card/row carries this and not just a tick.
                    const isSelected = selectMode && selectedDeckIds.includes(deck.id);
                    // The row's resting background. Hover overwrites background
                    // directly, so it has to be restored to THIS, not to
                    // transparent, or hovering a selected row would clear its
                    // selected look.
                    const restingBackground = isSelected ? 'rgba(234,179,8,0.14)' : 'transparent';

                    return (
                      <tr
                        key={deck.id}
                        style={{ borderBottom: '1px solid var(--border-glass)', cursor: 'pointer', transition: 'background 0.15s', background: restingBackground }}
                        /* In select mode a row TOGGLES instead of opening. */
                        onClick={() => selectMode ? toggleDeckSelected(deck.id) : loadDeckDetails(deck.id)}
                        onMouseEnter={e => e.currentTarget.style.background = isSelected ? 'rgba(234,179,8,0.2)' : 'rgba(255,255,255,0.03)'}
                        onMouseLeave={e => e.currentTarget.style.background = restingBackground}
                      >
                        <td style={{
                          padding: '0.75rem 1rem',
                          /* INSET shadow, so the selected marker bar costs zero
                             width — a real left border would widen the table and
                             is exactly how PR 6I's overflow got introduced. */
                          boxShadow: isSelected ? 'inset 3px 0 0 0 var(--accent-yellow)' : 'none'
                        }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              {/* THE TICK IS PRESENT IN BOTH VIEWS. The table
                                  had none at all, so the only feedback was the
                                  counter in the panel above. It sits inside the
                                  existing first cell rather than in a new
                                  column, so no column is added on a phone. */}
                              {selectMode && (
                                <input
                                  type="checkbox"
                                  checked={selectedDeckIds.includes(deck.id)}
                                  onChange={() => toggleDeckSelected(deck.id)}
                                  onClick={e => e.stopPropagation()}
                                  aria-label={deck.name}
                                  style={{ width: '16px', height: '16px', cursor: 'pointer', accentColor: 'var(--accent-yellow)', flexShrink: 0 }}
                                />
                              )}
                              <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: accentColor, display: 'inline-block' }} />
                              <span style={{
                                fontSize: '0.65rem',
                                fontWeight: 800,
                                padding: '0.15rem 0.45rem',
                                borderRadius: '4px',
                                background: 'rgba(239,68,68,0.15)',
                                color: '#f87171',
                                border: '1px solid rgba(239,68,68,0.3)',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '3px'
                              }}>
                                <Swords size={10} /> MTG
                              </span>
                            </div>
                            {deck.format && (
                              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                                {deck.format}
                              </span>
                            )}
                          </div>
                        </td>
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{deck.name}</span>
                            {deck.category && (
                              <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: 'rgba(59,130,246,0.12)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.25)' }}>
                                {deck.category}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                            {deck.description || 'No description'}
                          </div>
                        </td>
                        <td style={{ padding: '0.75rem 1rem', width: '160px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: isComplete ? '#4ade80' : 'var(--text-strong)' }}>
                              {totalCards} / {targetSize} Cards
                            </div>
                            <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${percent}%`, background: isComplete ? '#4ade80' : '#3b82f6' }} />
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: '0.75rem 1rem' }}>
                          {deck.checked_out ? (
                            <span style={{ fontSize: '0.7rem', fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'rgba(234,179,8,0.15)', color: '#eab308', border: '1px solid var(--accent-yellow)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              <Gamepad2 size={11} /> In Play
                            </span>
                          ) : isComplete ? (
                            <span style={{ fontSize: '0.7rem', fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'rgba(74, 222, 128, 0.15)', color: '#4ade80', border: '1px solid rgba(74, 222, 128, 0.3)' }}>
                              {t('deck.statusReady')}
                            </span>
                          ) : (
                            <span style={{ fontSize: '0.7rem', fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'var(--surface-2)', color: 'var(--text-secondary)', border: '1px solid var(--border-glass)' }}>
                              {t('deck.statusBuilding')}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          {new Date(deck.created_at).toLocaleDateString()}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
                            {deck.checked_out ? (
                              <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', color: '#eab308' }} onClick={() => handleReturn(deck)} disabled={checkingOut}>
                                {t('deck.return')}
                              </button>
                            ) : (
                              <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }} onClick={() => handleCheckout(deck)} disabled={checkingOut}>
                                {t('deck.checkout')}
                              </button>
                            )}
                            <button className="btn btn-primary" style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem' }} onClick={() => loadDeckDetails(deck.id)}>
                              {t('deck.open')}
                            </button>
                            <button className="btn btn-danger btn-icon-only" style={{ padding: '0.25rem' }} onClick={() => handleDeleteDeck(deck.id, deck.name)}>
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

        </div>
      )}

      {/* 2. DECK EDITOR / DETAIL VIEW */}
      {viewMode === 'detail' && activeDeck && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Header */}
          <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', position: 'relative', overflow: 'hidden' }}>
            
            {/* Checked out banner */}
            {activeDeck.checked_out ? (
              <div style={{
                position: 'absolute',
                top: 0, left: 0, right: 0,
                height: '4px',
                background: 'linear-gradient(90deg, #eab308, #f59e0b, #eab308)',
                backgroundSize: '200% auto',
                animation: 'shimmer-gold 2s linear infinite'
              }} />
            ) : null}

            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <button className="btn btn-secondary btn-icon-only" onClick={() => { setViewMode('list'); fetchDecks(); }} style={{ borderRadius: '50%' }}>
                <ChevronLeft size={16} />
              </button>
              <div>
                <h2 style={{ fontSize: '1.25rem', color: 'var(--text-strong)', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  {activeDeck.name}
                  <span style={{ fontSize: '0.8rem', color: totalDeckCardsCount === targetDeckCardsCount ? 'var(--type-grass)' : 'var(--accent-yellow)', fontWeight: 600 }}>
                    ({totalDeckCardsCount}/{targetDeckCardsCount} cards)
                  </span>
                  {activeDeck.checked_out ? (
                    <span style={{
                      fontSize: '0.65rem',
                      background: 'rgba(234,179,8,0.15)',
                      border: '1px solid var(--accent-yellow)',
                      color: '#eab308',
                      padding: '2px 8px',
                      borderRadius: '12px',
                      fontWeight: 700,
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}>
                      🎮 In Play
                    </span>
                  ) : null}
                </h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{activeDeck.description || 'Custom deck build.'}</p>
                {!!activeDeck.checked_out && activeDeck.checked_out_at && (
                  <p style={{ color: '#eab308', fontSize: '0.7rem', marginTop: '2px' }}>
                    Checked out since {new Date(activeDeck.checked_out_at).toLocaleString()}
                  </p>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowExportModal(true)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                title={t('deck.exportHint')}
              >
                <Download size={14} /> Export
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setShowImportModal(true)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                title={t('deck.importHint')}
              >
                <Upload size={14} /> Import
              </button>
              {/* Checkout / Return button */}
              {activeDeck.checked_out ? (
                <button
                  className="btn btn-secondary"
                  onClick={() => handleReturn(activeDeck)}
                  disabled={checkingOut}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', border: '1px solid var(--accent-yellow)', color: '#eab308' }}
                >
                  <PackageCheck size={14} /> Return to Storage
                </button>
              ) : (
                <button
                  className="btn btn-secondary"
                  onClick={() => handleCheckout(activeDeck)}
                  disabled={checkingOut}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}
                >
                  <LogOut size={14} /> Check Out for Play
                </button>
              )}
              <button className="btn btn-primary" onClick={startSimulator} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <Play size={14} /> Draw Simulator
              </button>
            </div>
          </div>

          {/* Checked out info banner */}
          {!!activeDeck.checked_out && (
            <div style={{
              background: 'rgba(234,179,8,0.06)',
              border: '1px solid rgba(234,179,8,0.25)',
              borderRadius: 'var(--radius-md)',
              padding: '0.85rem 1.25rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              fontSize: '0.85rem',
              color: '#eab308'
            }}>
              <span style={{ fontSize: '1.25rem' }}>🎮</span>
              <div>
                <strong>{t('deck.checkedOutBanner')}</strong>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  {t('deck.checkedOutHint')}
                </div>
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem', alignItems: 'start' }}>
            <div className="deck-detail-columns" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: '1.5rem' }}>
              
              {/* Left Column: Deck Card List */}
              <div className="deck-detail-main" style={{ flex: '2 1 500px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                
                {/* DECK HEALTH & RULES, ABOVE ADD CARDS (PR 7; was PR 6I item 4c).

                    Zach: "moving deck health and rules toward the top would be
                    nice as well since it's super important to know that data."
                    It used to sit in the right-hand statistics column, which on
                    a phone stacks BELOW the whole card list -- so the panel that
                    says whether the deck is legal and buildable was the last
                    thing seen, a long scroll away.

                    MOVED, NOT REBUILT. This is the same markup, the same styling
                    and the same content as before; only its position in the tree
                    changed. The charts it used to sit above (mana curve,
                    supertype, colour distribution) stay in the right column,
                    where they belong -- they are analysis, this is status.

                    PR 7 moves it one step further, above Add Cards / Browse
                    Collection. Zach: "deck health should be above the card
                    search/browse collection on mobile." PR 6I put it above the
                    card LIST but still below the search box, so on a phone the
                    tool for fixing the deck came before the panel saying what
                    was wrong with it. Diagnosis before treatment. Placement
                    only -- nothing about the panel itself changed. */}
                {/* Deck Health & Summary Status */}
                <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {totalDeckCardsCount === targetDeckCardsCount ? (
                      <CheckCircle size={15} style={{ color: 'var(--type-grass)' }} />
                    ) : (
                      <AlertTriangle size={15} style={{ color: 'var(--accent-yellow)' }} />
                    )}
                    {t('deck.healthTitle')}
                  </h3>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontSize: '0.8rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                      <span>Target Deck Size:</span>
                      <strong style={{ color: totalDeckCardsCount === targetDeckCardsCount ? 'var(--type-grass)' : 'var(--text-strong)' }}>{totalDeckCardsCount}/{targetDeckCardsCount} Cards</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                      <span>Unique Cards:</span>
                      <strong style={{ color: 'var(--text-strong)' }}>{deckCards.length} titles</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                      <span>{t('deck.basicLands')}</span>
                      <strong style={{ color: 'var(--accent-yellow)' }}>
                        {deckCards.filter(isBasicEnergyOrLand).reduce((s, c) => s + c.quantity, 0)} basic lands
                      </strong>
                    </div>
                    {consideringCards.length > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                        <span>{t('deck.consideringLabel')}</span>
                        <strong style={{ color: 'var(--accent-yellow)' }}>
                          {sectionCount(consideringCards)}
                        </strong>
                      </div>
                    )}
                  </div>

                  {/* Server-computed rules and ownership warnings.
                      Advisory, never a blocked save: not owning a card you plan
                      to buy is a normal state of a deck under construction, so
                      these are listed as information rather than styled as
                      errors. They come from the server so the screen and the
                      database cannot disagree about them. */}
                  {(activeDeck.warnings || []).length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border-glass)' }}>
                      {activeDeck.warnings.map((warning, index) => (
                        <div key={`${warning.code}-${index}`} style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                          <AlertTriangle size={12} style={{ color: 'var(--accent-yellow)', flexShrink: 0, marginTop: '2px' }} />
                          <span>{warning.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* MISSING CARDS / BUYLIST (PR 7).
                    Sits with Deck Health, above Add Cards, for the same reason
                    the health panel does: what is wrong with the deck comes
                    before the tool for fixing it. It is only rendered when the
                    server has actually answered -- a buylist that has not
                    loaded must not be shown as an empty one, because an empty
                    buylist is the positive claim "you own everything". */}
                {buylist && (
                  <MissingCardsPanel
                    buylist={buylist}
                    loading={buylistLoading}
                    bracketStyle={buylistBracketStyle}
                    onBracketStyleChange={setBuylistBracketStyle}
                    onCopy={handleCopyBuylist}
                    onOpenMassEntry={handleOpenMassEntry}
                  />
                )}

                {/* Search & Quick Add to Deck */}
                <div className="glass-panel">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', margin: 0 }}>{t('deck.addCardsTitle')}</h3>
                  </div>
                  <form onSubmit={handleSearchCards} className="deck-search-row" style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type="text"
                      className="input-control"
                      placeholder={t('deck.searchPlaceholder')}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button type="submit" className="btn btn-primary" style={{ padding: '0.5rem 1rem' }} title={t('shared.search')}>
                      <Search size={16} />
                    </button>
                    {/* A TOGGLE (PR 6I item 4b). It reads as pressed while the
                        browse listing is open, so the control's own appearance
                        says what pressing it again will do -- previously it
                        looked identical open or shut and only ever opened. */}
                    <button
                      type="button"
                      className={`btn ${resultsSource?.mode === 'browse' ? 'btn-primary' : 'btn-secondary'}`}
                      aria-pressed={resultsSource?.mode === 'browse'}
                      onClick={(e) => handleSearchCards(e, true)}
                      style={{ padding: '0.5rem 0.9rem', fontSize: '0.75rem', whiteSpace: 'nowrap' }}
                      title={t('deck.browseHint')}
                    >
                      {t('deck.browseCollection')}
                    </button>
                  </form>

                  {/* Search Results list */}
                  {searching || loadingVariants ? (
                    <div className="spinner" style={{ margin: '1rem auto' }}></div>
                  ) : searchResults.length > 0 && (
                    <>
                    {/* AN EXPLICIT DISMISS (PR 6I item 4b), on the panel itself.
                        The toggle above closes a BROWSE listing, but a search
                        result list had no way out either -- and the X is the
                        affordance every other dismissible panel in this file
                        uses (the modals all carry the same Trash-free X button),
                        so this follows the app's existing convention rather than
                        inventing a control. */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        {resultsSource?.mode === 'browse' ? t('deck.browseCollection') : t('deck.addCardsTitle')}
                      </span>
                      <button
                        type="button"
                        className="btn btn-secondary btn-icon-only"
                        onClick={closeResultsPanel}
                        title={t('common.close')}
                        aria-label={t('common.close')}
                        style={{ padding: '0.2rem 0.35rem' }}
                      >
                        <X size={13} />
                      </button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.4rem', maxHeight: '240px', overflowY: 'auto', background: 'var(--surface-2)', padding: '0.5rem', borderRadius: 'var(--radius-sm)' }}>
                      {searchResults.map(card => {
                          // "IN DECK" IS THE CROSS-DECK TOTAL, FROM THE SERVER.
                          //
                          // It used to be counted from `deckCards` -- the OPEN
                          // deck's own list -- so the same card read "In Deck: 1"
                          // while viewing the deck holding it and "In Deck: 0"
                          // from any other deck. That told the user a card was
                          // free when it was already sleeved elsewhere, which is
                          // the "app shows something false about what you own"
                          // class of bug.
                          //
                          // The client cannot answer this question: it only ever
                          // holds one deck. So the server answers it
                          // (in_deck_qty, counted across ALL decks) and this row
                          // reports it. `?? 0` rather than `||` so a legitimate
                          // zero is not confused with a missing field.
                          const qtyInDeck = card.in_deck_qty ?? 0;
                          // "In this deck" is kept as a SEPARATE, secondary
                          // figure. Both are useful and they answer different
                          // questions -- "have I already put this in THIS deck"
                          // versus "is this card actually free" -- but only the
                          // cross-deck number is allowed to drive availability.
                          const qtyInThisDeck = deckCards
                            .filter(c => c.oracle_id === card.oracle_id)
                            .reduce((s, c) => s + c.quantity, 0);
                          const ownedQty = card.owned_qty || 0;
                          // WHAT IS GENUINELY FREE, FROM THE SERVER.
                          //
                          // Zach (2026-08-18): "searching when inside the deck
                          // would allow you to search on cards you own/dont own
                          // and that is where show available count becomes nice
                          // in that because you can see if you even have it and
                          // then even farther it marks it as missing".
                          //
                          // So the search row answers the whole question on the
                          // spot -- do I have it, and is it actually free --
                          // instead of sending the user off to look it up a
                          // second time.
                          //
                          // `available_qty` is the SERVER's figure: owned minus
                          // committed across ALL decks. It is not derived here
                          // and must not be: this screen holds one deck, so a
                          // client-side subtraction could only ever see this
                          // deck's commitments and would report a card as free
                          // while another deck box already had it -- the exact
                          // false-availability bug this PR fixes.
                          //
                          // `??` rather than `||` so a legitimate 0 survives,
                          // and the older-payload fallback is the arithmetic on
                          // the two figures already shown rather than a blank.
                          const freeQty = card.available_qty ?? Math.max(0, ownedQty - qtyInDeck);
                          // Zero free is not a blocker -- the add below stays
                          // enabled and the requirement simply reads as missing
                          // in the deck (in red, per the same ruling). This
                          // flag only chooses the colour of the count.
                          const noneFree = freeQty === 0;
                          const isAtRuleMax = !isBasicEnergyOrLand(card) && deckCountByName(deckCards, card.name) >= 4;
                          // Ownership does NOT disable the add. Planning a deck
                          // you have not finished buying is the normal case;
                          // the row's badge reports the shortfall instead.
                          const disabledAdd = savingCard || isAtRuleMax;
                          // Keyed on the exact variant, not the Oracle card.
                          // Browse rows are per (printing, finish), so several
                          // rows share an oracle_id -- matching on it would
                          // open the picker under every printing of the card at
                          // once. Exact rows never open a picker at all; this
                          // only fires for a name-scoped search result.
                          const rowKey = `${card.id}|${card.finish || ''}`;
                          const isPicking = variantPicker
                            && `${variantPicker.card.id}|${variantPicker.card.finish || ''}` === rowKey;

                          return (
                            <div key={rowKey} style={{ display: 'flex', flexDirection: 'column', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', border: `1px solid ${isPicking ? 'rgba(234,179,8,0.4)' : 'var(--border-glass)'}` }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.35rem 0.5rem' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }} onClick={() => setPreviewCard(card)}>
                                  <img src={card.image_url} alt={card.name} style={{ width: '24px', height: '33px', objectFit: 'cover', borderRadius: '2px' }} />
                                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                                    <span style={{ fontSize: '0.8rem', color: 'var(--text-strong)', display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                                      {card.name} ({card.set_name} • #{card.number})
                                      {/* THE FOIL INDICATOR.
                                          Rows are separated by finish, so a
                                          foil and a nonfoil of one printing are
                                          two rows -- but without this badge
                                          they read identically and the user
                                          cannot tell which row is which.

                                          This is the Collection screen's own
                                          yellow FOIL badge, imported rather
                                          than re-styled: a foil has to look
                                          like a foil everywhere in the app,
                                          and a second amber pill defined here
                                          would drift from the first one. */}
                                      <FinishBadge card={card} />
                                    </span>
                                    {/* The SAME badge, in the same place, with
                                        the same styling -- only the numbers
                                        behind it are now correct. "In Deck" is
                                        the cross-deck total, so Owned minus
                                        In Deck is what is genuinely free.
                                        "in this deck" is appended only when it
                                        is non-zero and differs from the total,
                                        so the common case reads exactly as it
                                        did before rather than growing noise.

                                        AVAILABLE IS ALWAYS SHOWN, including on
                                        a card the user owns none of, because
                                        "0 free" is the answer to "do I even
                                        have this" -- and an omitted count reads
                                        as unknown, which is the second lookup
                                        this is here to remove. It is coloured
                                        with the app's EXISTING red when nothing
                                        is free, the same red the deck row's
                                        Missing badge uses, so one colour means
                                        one thing across the screen. */}
                                    <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
                                      Owned: {ownedQty} | In Deck: {qtyInDeck}
                                      {qtyInThisDeck > 0 && qtyInThisDeck !== qtyInDeck
                                        ? ` (${qtyInThisDeck} in this deck)` : ''}
                                      {' | '}
                                      <span style={{ color: noneFree ? '#f87171' : 'var(--type-grass)', fontWeight: 700 }}>
                                        Available: {freeQty}
                                      </span>
                                    </span>
                                  </div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                  <button className="btn btn-secondary btn-icon-only" style={{ padding: '0.2rem' }} onClick={() => setPreviewCard(card)} title={t('deck.previewArt')}>
                                    <Eye size={12} />
                                  </button>
                                  <button
                                    className="btn btn-secondary btn-icon-only"
                                    style={{ padding: '0.2rem' }}
                                    disabled={savingCard}
                                    onClick={() => handleAddCardToDeck(card, 'considering')}
                                    title={t('deck.addConsidering')}
                                  >
                                    <Lightbulb size={12} />
                                  </button>
                                  <button className="btn btn-primary btn-icon-only" style={{ padding: '0.2rem' }} disabled={disabledAdd} onClick={() => handleAddCardToDeck(card)} title={isAtRuleMax ? '4-copy limit reached' : t('deck.addToDeck')}>
                                    <Plus size={12} />
                                  </button>
                                </div>
                              </div>

                              {/* Exact printing + finish picker.
                                  Appears inline, in this same list, only when
                                  the click was ambiguous -- i.e. the user owns
                                  more than one printing or finish of this card.
                                  Choosing for them is the single thing
                                  exact-only identity forbids, so we ask here
                                  rather than guess, and we ask in place rather
                                  than on a new screen. */}
                              {isPicking && (
                                <div style={{ borderTop: '1px solid var(--border-glass)', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.35rem', background: 'rgba(0,0,0,0.25)' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--accent-yellow)' }}>
                                      {t('deck.choosePrinting')}
                                    </span>
                                    <button className="btn btn-secondary btn-icon-only" style={{ padding: '0.15rem' }} onClick={() => setVariantPicker(null)}>
                                      <X size={11} />
                                    </button>
                                  </div>
                                  {variantPicker.variants.map(variant => (
                                    <button
                                      key={`${variant.desired_card_id}-${variant.finish}`}
                                      type="button"
                                      className="btn btn-secondary"
                                      disabled={savingCard}
                                      onClick={() => addExactVariant(variant, variantPicker.board)}
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
                                          {variant.available_qty !== undefined
                                            ? `${variant.available_qty} free`
                                            : `x${variant.owned_qty}`}
                                        </span>
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                      })}
                    </div>
                    </>
                  )}
                </div>


                {/* Deck Cards Header & Display Mode Toggle */}
                <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <h3 style={{ fontSize: '1rem', color: 'var(--text-strong)', borderLeft: '3px solid var(--accent-red)', paddingLeft: '0.5rem', margin: 0 }}>
                      Deck Cards ({totalDeckCardsCount} / {targetDeckCardsCount})
                    </h3>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--surface-2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                      <button
                        type="button"
                        className={`btn ${cardDisplayMode === 'list' ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                        onClick={() => setCardDisplayMode('list')}
                      >
                        <List size={12} /> List
                      </button>
                      <button
                        type="button"
                        className={`btn ${cardDisplayMode === 'grid' ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                        onClick={() => setCardDisplayMode('grid')}
                      >
                        <LayoutGrid size={12} /> Grid
                      </button>
                    </div>
                  </div>
                  
                  {activeDeck.cards.length === 0 ? (
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem 0' }}>{t('deck.emptyDeck')}</p>
                  ) : (
                    /* Moxfield-style sections INSIDE this one list: Commander,
                       then each card type, then Considering. They are headers
                       in the same list, not tabs or separate screens, so the
                       whole deck still reads top to bottom in one pass. */
                    groupDeckCards(activeDeck.cards).map(section => {
                      const collapsed = collapsedSections.has(section.key);
                      const isConsidering = section.kind === 'considering';
                      const isCommanderSection = section.kind === 'commander';
                      const sum = sectionCount(section.cards);

                      return (
                        <div key={section.key} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                          <button
                            type="button"
                            onClick={() => toggleSection(section.key)}
                            style={{
                              background: 'none',
                              border: 'none',
                              borderBottom: '1px solid var(--border-glass)',
                              padding: '0 0 0.25rem 0',
                              margin: 0,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              width: '100%',
                              fontSize: '0.85rem',
                              fontWeight: 600,
                              color: isConsidering ? 'var(--accent-yellow)' : 'var(--text-secondary)'
                            }}
                          >
                            <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                              {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                              {isConsidering && <Lightbulb size={12} />}
                              {section.title} ({sum})
                            </span>
                          </button>

                          {/* The considering section says what it is, once, at
                              the top. These cards are NOT in the deck and hold
                              no inventory -- without saying so the red
                              "Unavailable" badges below look like errors in the
                              deck rather than notes about a shopping list. */}
                          {isConsidering && !collapsed && (
                            <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0 }}>
                              {t('deck.consideringHint')}
                            </p>
                          )}

                          {/* CHANGE OR ADD A COMMANDER, from inside the deck.
                              Lives in the existing Commander section from PR 6D
                              rather than on a new screen or a separate modal:
                              the commander is a card in the deck list, and this
                              is the row it already occupies.

                              Only for Commander decks. `groupDeckCards` only
                              emits a commander section for entries on the
                              commander board, so a Modern deck never reaches
                              this branch. The "add a partner" affordance
                              appears while fewer than two are assigned. */}
                          {isCommanderSection && !collapsed && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                {section.cards.map(commander => (
                                  <button
                                    key={`swap-${commander.id}`}
                                    type="button"
                                    className="btn btn-secondary"
                                    disabled={savingCard}
                                    onClick={() => {
                                      setCommanderResults([]);
                                      setCommanderQuery('');
                                      setCommanderSwap(
                                        commanderSwap?.replacing?.id === commander.id
                                          ? null
                                          : { replacing: commander }
                                      );
                                    }}
                                    style={{ fontSize: '0.68rem', padding: '0.2rem 0.5rem' }}
                                  >
                                    {t('deck.commanderChange', { name: commander.name })}
                                  </button>
                                ))}
                                {section.cards.length < 2 && (
                                  <button
                                    type="button"
                                    className="btn btn-secondary"
                                    disabled={savingCard}
                                    onClick={() => {
                                      setCommanderResults([]);
                                      setCommanderQuery('');
                                      setCommanderSwap(
                                        commanderSwap && !commanderSwap.replacing ? null : { replacing: null }
                                      );
                                    }}
                                    style={{ fontSize: '0.68rem', padding: '0.2rem 0.5rem' }}
                                  >
                                    {t('deck.commanderAddPartner')}
                                  </button>
                                )}
                              </div>

                              {commanderSwap && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', background: 'rgba(0,0,0,0.25)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.5rem' }}>
                                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                                    <input
                                      type="text"
                                      className="input-control"
                                      placeholder={t('deck.commanderSearchPlaceholder')}
                                      value={commanderQuery}
                                      onChange={(e) => setCommanderQuery(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          e.preventDefault();
                                          searchCommanders(commanderQuery);
                                        }
                                      }}
                                      style={{ flex: 1, fontSize: '0.8rem' }}
                                    />
                                    <button type="button" className="btn btn-secondary" onClick={() => searchCommanders(commanderQuery)} style={{ padding: '0.4rem 0.7rem' }}>
                                      <Search size={13} />
                                    </button>
                                    <button type="button" className="btn btn-secondary btn-icon-only" style={{ padding: '0.2rem' }} onClick={() => setCommanderSwap(null)}>
                                      <X size={12} />
                                    </button>
                                  </div>
                                  {commanderSearching ? (
                                    <div className="spinner" style={{ margin: '0.5rem auto' }}></div>
                                  ) : commanderResults.map(card => (
                                    <button
                                      key={card.id}
                                      type="button"
                                      className="btn btn-secondary"
                                      disabled={savingCard}
                                      onClick={() => swapCommander(commanderSwap.replacing, card)}
                                      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0.4rem', fontSize: '0.72rem', textAlign: 'left' }}
                                    >
                                      <img src={card.image_url} alt={card.name} style={{ width: '20px', height: '28px', objectFit: 'cover', borderRadius: '2px' }} />
                                      <span style={{ color: 'var(--text-strong)' }}>
                                        {card.name} <span style={{ color: 'var(--text-secondary)' }}>({card.set_name} • #{card.number})</span>
                                      </span>
                                    </button>
                                  ))}

                                  {/* THE SAME REFUSAL + OVERRIDE, inside the
                                      existing swap panel. Not a new screen and
                                      not a second design -- the user has
                                      already learned this control on the
                                      create modal. */}
                                  {commanderRefusal && commanderRefusedSwap && (
                                    <div style={{ padding: '0.5rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 'var(--radius-sm)', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.35rem' }}>
                                        <AlertTriangle size={13} style={{ color: 'var(--accent-red)', flexShrink: 0, marginTop: '1px' }} />
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text-strong)', fontWeight: 600, lineHeight: 1.35 }}>
                                          {commanderRefusal.error}
                                        </div>
                                      </div>
                                      <div style={{ fontSize: '0.63rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                                        {t('deck.commanderOverrideHint')}
                                      </div>
                                      <input
                                        type="text"
                                        className="input-control"
                                        placeholder={t('deck.commanderOverrideReasonPlaceholder')}
                                        value={commanderOverrideReason}
                                        onChange={(e) => setCommanderOverrideReason(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                                        style={{ fontSize: '0.76rem' }}
                                      />
                                      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                        <button
                                          type="button"
                                          className="btn btn-secondary"
                                          disabled={savingCard || !commanderOverrideReason.trim()}
                                          onClick={() => swapCommander(
                                            commanderRefusedSwap.replacing,
                                            commanderRefusedSwap.card,
                                            { reason: commanderOverrideReason.trim() }
                                          )}
                                          style={{ fontSize: '0.7rem', padding: '0.3rem 0.6rem', opacity: commanderOverrideReason.trim() ? 1 : 0.5 }}
                                        >
                                          {t('deck.commanderOverrideConfirm')}
                                        </button>
                                        <button
                                          type="button"
                                          className="btn btn-secondary"
                                          onClick={() => { setCommanderRefusal(null); setCommanderOverrideReason(''); setCommanderRefusedSwap(null); }}
                                          style={{ fontSize: '0.7rem', padding: '0.3rem 0.6rem' }}
                                        >
                                          {t('deck.commanderOverrideCancel')}
                                        </button>
                                      </div>
                                    </div>
                                  )}

                                  {/* THE SWAP-REMOVES-CARDS WARNING.
                                      Same panel shape and same place as the
                                      override control above -- not a new
                                      screen and not a second design. The
                                      difference is what it asks for: the
                                      override needs a typed REASON because the
                                      app may be wrong; this needs only a
                                      confirmation, because the app is not
                                      guessing -- it knows exactly which cards
                                      no longer fit and says so by name. */}
                                  {commanderSwapRemoval && commanderRefusedSwap && (
                                    <div style={{ padding: '0.5rem', background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.35)', borderRadius: 'var(--radius-sm)', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.35rem' }}>
                                        <AlertTriangle size={13} style={{ color: '#eab308', flexShrink: 0, marginTop: '1px' }} />
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text-strong)', fontWeight: 600, lineHeight: 1.35 }}>
                                          {commanderRefusedSwap.dropping
                                            ? `Removing this commander will remove ${commanderSwapRemoval.removing_count} card(s) that no longer fit the deck's colour identity.`
                                            : `Changing the commander will remove ${commanderSwapRemoval.removing_count} card(s) that no longer fit its colour identity.`}
                                        </div>
                                      </div>
                                      {/* NAMED, WITH THEIR PRINTINGS. The user
                                          has to find these in a binder, and
                                          under exact-only identity a bare name
                                          does not identify a physical card. */}
                                      <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.65rem', color: 'var(--text-secondary)', lineHeight: 1.5, maxHeight: '120px', overflowY: 'auto' }}>
                                        {(commanderSwapRemoval.removing || []).map(entry => (
                                          <li key={entry.deck_card_id}>
                                            {entry.name}{entry.set_name ? ` (${entry.set_name} • #${entry.number})` : ''}
                                            {entry.quantity > 1 ? ` ×${entry.quantity}` : ''}
                                          </li>
                                        ))}
                                      </ul>
                                      <div style={{ fontSize: '0.63rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                                        The physical cards stay in your collection and become available for other decks. The commander change and these removals happen together.
                                      </div>
                                      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                        <button
                                          type="button"
                                          className="btn btn-secondary"
                                          disabled={savingCard}
                                          onClick={() => (
                                            commanderRefusedSwap.dropping
                                              ? dropCommander(commanderRefusedSwap.dropping, true)
                                              : swapCommander(
                                                commanderRefusedSwap.replacing,
                                                commanderRefusedSwap.card,
                                                null,
                                                true
                                              )
                                          )}
                                          style={{ fontSize: '0.7rem', padding: '0.3rem 0.6rem' }}
                                        >
                                          {commanderRefusedSwap.dropping
                                            ? `Remove commander and ${commanderSwapRemoval.removing_count} card(s)`
                                            : `Change commander and remove ${commanderSwapRemoval.removing_count} card(s)`}
                                        </button>
                                        <button
                                          type="button"
                                          className="btn btn-secondary"
                                          onClick={() => { setCommanderSwapRemoval(null); setCommanderRefusedSwap(null); }}
                                          style={{ fontSize: '0.7rem', padding: '0.3rem 0.6rem' }}
                                        >
                                          {t('deck.commanderOverrideCancel')}
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          {/* 1. COMPACT LIST VIEW */}
                          {!collapsed && cardDisplayMode === 'list' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                              {section.cards.map(card => (
                                <div key={card.id} style={{ display: 'flex', flexDirection: 'column', background: 'rgba(255,255,255,0.01)', borderRadius: 'var(--radius-sm)', border: `1px solid ${printingEditor?.entryId === card.id ? 'rgba(234,179,8,0.4)' : 'var(--border-glass)'}` }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.75rem' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer', minWidth: 0 }} onClick={() => setPreviewCard(card)}>
                                    <img src={card.image_url} alt={card.name} style={{ width: '32px', height: '44px', objectFit: 'cover', borderRadius: '2px' }} />
                                    <div style={{ minWidth: 0 }}>
                                      <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-strong)' }}>{card.name}</div>
                                      {/* Set, collector number and finish are
                                          shown always rather than on hover:
                                          under exact-only identity the printing
                                          IS the identity, so hiding it hides
                                          the thing the user must match against
                                          the card in their hand. */}
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', marginTop: '2px' }}>
                                        <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{card.set_name} • #{card.number}</span>
                                        <PrintingBadge card={card} onClick={() => (
                                          printingEditor?.entryId === card.id
                                            ? setPrintingEditor(null)
                                            : openPrintingEditor(card)
                                        )} />
                                        <StatusBadge card={card} />
                                        {!!card.checked_out && (
                                          <span style={{ fontSize: '0.6rem', fontWeight: 800, padding: '1px 6px', borderRadius: '10px', background: 'rgba(234,179,8,0.15)', color: '#eab308', border: '1px solid var(--accent-yellow)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                                            <Gamepad2 size={9} /> In Play
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  </div>

                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    {/* Move in or out of Considering. This is
                                        the only control that sets it, and it
                                        acts on ONE card -- there is no
                                        deck-level considering state. */}
                                    <button
                                      className="btn btn-secondary btn-icon-only"
                                      style={{ width: '22px', height: '22px', padding: 0, color: isConsidering ? 'var(--accent-yellow)' : undefined }}
                                      disabled={savingCard}
                                      onClick={() => handleMoveBoard(card, isConsidering ? 'mainboard' : 'considering')}
                                      title={t(isConsidering ? 'deck.moveToDeck' : 'deck.moveToConsidering')}
                                    >
                                      <Lightbulb size={11} />
                                    </button>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--surface-2)', padding: '2px', borderRadius: '4px', border: '1px solid var(--border-glass)' }}>
                                      <button
                                        className={`btn ${card.quantity === 1 ? 'btn-danger' : 'btn-secondary'} btn-icon-only`}
                                        style={{ width: '22px', height: '22px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                        disabled={savingCard}
                                        onClick={() => handleUpdateCardQty(card, card.quantity - 1)}
                                        title={t(isCommanderSection
                                          ? 'deck.commanderSwapTitle'
                                          : (card.quantity === 1 ? 'deck.removeFromDeck' : 'deck.decreaseQty'))}
                                      >
                                        {card.quantity === 1 ? <Trash2 size={11} /> : '-'}
                                      </button>
                                      <span style={{ padding: '0 0.4rem', fontSize: '0.85rem', fontWeight: 700, minWidth: '18px', textAlign: 'center', color: 'var(--text-strong)' }}>{card.quantity}</span>
                                      <button
                                        className="btn btn-secondary btn-icon-only"
                                        style={{ width: '22px', height: '22px', padding: 0 }}
                                        disabled={savingCard || (!isBasicEnergyOrLand(card) && deckCountByName(deckCards, card.name) >= 4)}
                                        onClick={() => handleUpdateCardQty(card, card.quantity + 1)}
                                      >
                                        +
                                      </button>
                                    </div>
                                  </div>
                                </div>

                                {/* Repin this entry to a different printing.
                                    Same inline panel the Add Cards list uses,
                                    rendered inside this row rather than on a
                                    new screen. Each option shows the count that
                                    is actually FREE of that printing, which is
                                    the number that decides whether switching
                                    leaves the deck filled -- a printing with
                                    copies committed to another deck is offered
                                    and honestly labelled "0 free", never
                                    hidden. */}
                                {printingEditor?.entryId === card.id && (
                                  <div style={{ borderTop: '1px solid var(--border-glass)', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.35rem', background: 'rgba(0,0,0,0.25)' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--accent-yellow)' }}>
                                        {t('deck.choosePrinting')}
                                      </span>
                                      <button className="btn btn-secondary btn-icon-only" style={{ padding: '0.15rem' }} onClick={() => setPrintingEditor(null)}>
                                        <X size={11} />
                                      </button>
                                    </div>
                                    {printingEditor.variants.length === 0 ? (
                                      <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                                        {t('deck.noOwnedPrintings')}
                                      </span>
                                    ) : printingEditor.variants.map(variant => {
                                      const isCurrent = variant.desired_card_id === card.desired_card_id
                                        && variant.finish === card.desired_finish;
                                      return (
                                        <button
                                          key={`${variant.desired_card_id}-${variant.finish}`}
                                          type="button"
                                          className="btn btn-secondary"
                                          disabled={savingCard}
                                          onClick={() => repinEntryPrinting(card, variant)}
                                          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.3rem 0.5rem', fontSize: '0.72rem', textAlign: 'left', borderColor: isCurrent ? 'rgba(234,179,8,0.4)' : undefined }}
                                        >
                                          <span style={{ color: 'var(--text-strong)' }}>
                                            {variant.set_name} • #{variant.number}
                                          </span>
                                          <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                            <span style={{ fontSize: '0.6rem', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)', border: '1px solid var(--border-glass)' }}>
                                              {finishLabel(variant.finish)}
                                            </span>
                                            {/* AVAILABLE, not owned. Switching
                                                to a printing whose copies are
                                                all in another deck would leave
                                                this row Missing, and the user
                                                must be able to see that before
                                                they choose, not after. */}
                                            <span style={{ color: 'var(--text-muted)' }}>
                                              {variant.available_qty} free
                                            </span>
                                          </span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                                </div>
                              ))}
                            </div>
                          )}

                          {/* 2. VISUAL CARD GRID VIEW.
                              Renders through the SAME CardTile the Collection
                              gallery uses, so a card looks like itself on both
                              screens: rarity chip top-left, quantity badge
                              top-right, FOIL badge and foil shine on foils,
                              name / set · number below.

                              Deck-specific information is passed IN rather than
                              replacing the tile: the reservation StatusBadge and
                              the quantity/considering controls sit in the tile's
                              footer, and the card's printing badge joins the
                              overlay strip. That keeps one implementation of the
                              card while still saying everything a deck row has
                              to say. */}
                          {!collapsed && cardDisplayMode === 'grid' && (
                            <div className="card-grid">
                              {section.cards.map(card => (
                                <CardTile
                                  key={card.id}
                                  card={card}
                                  quantity={card.quantity}
                                  onImageClick={() => setPreviewCard(card)}
                                  badges={<PrintingBadge card={card} />}
                                  meta={null}
                                  footer={(
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
                                      <StatusBadge card={card} />
                                      <div style={{ display: 'flex', gap: '2px' }}>
                                        <button className={`btn ${card.quantity === 1 ? 'btn-danger' : 'btn-secondary'} btn-icon-only`} style={{ width: '20px', height: '20px', fontSize: '0.7rem', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} disabled={savingCard} onClick={() => handleUpdateCardQty(card, card.quantity - 1)} title={t(isCommanderSection ? 'deck.commanderSwapTitle' : (card.quantity === 1 ? 'deck.removeFromDeck' : 'deck.decreaseQty'))}>
                                          {card.quantity === 1 ? <Trash2 size={10} /> : '-'}
                                        </button>
                                        <button className="btn btn-secondary btn-icon-only" style={{ width: '20px', height: '20px', fontSize: '0.7rem', padding: 0 }} disabled={savingCard || (!isBasicEnergyOrLand(card) && deckCountByName(deckCards, card.name) >= 4)} onClick={() => handleUpdateCardQty(card, card.quantity + 1)}>+</button>
                                        <button className="btn btn-secondary btn-icon-only" style={{ width: '20px', height: '20px', fontSize: '0.7rem', padding: 0, color: isConsidering ? 'var(--accent-yellow)' : undefined }} disabled={savingCard} onClick={() => handleMoveBoard(card, isConsidering ? 'mainboard' : 'considering')} title={t(isConsidering ? 'deck.moveToDeck' : 'deck.moveToConsidering')}>
                                          <Lightbulb size={10} />
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                />
                              ))}
                            </div>
                          )}

                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Right Column: Statistics & Mana Curve.
                  Deck Health moved OUT of this column in PR 6I item 4c -- it is
                  status, not analysis, and on a phone this column stacks below
                  the entire card list. */}
              <div className="deck-detail-side" style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                

                {/* Mana curve */}
                {manaCurveData.some(d => d.count > 0) && (
                  <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <BarChart2 size={14} style={{ color: '#3b82f6' }} /> Mana Curve
                    </h3>
                    <div style={{ width: '100%', height: '180px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={manaCurveData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                          <XAxis dataKey="cost" stroke="var(--text-muted)" fontSize={10} tickLine={false} />
                          <YAxis stroke="var(--text-muted)" fontSize={10} tickLine={false} />
                          <Tooltip contentStyle={{ background: 'rgba(0,0,0,0.8)', border: '1px solid var(--border-glass)', borderRadius: '4px', fontSize: '0.8rem', color: 'var(--text-strong)' }} />
                          <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {/* Pie Chart: Supertypes */}
                {supertypeData.length > 0 && (
                  <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <BarChart2 size={14} style={{ color: 'var(--accent-red)' }} /> Supertype Breakdown
                    </h3>
                    <div style={{ width: '100%', height: '180px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={supertypeData}
                            cx="50%"
                            cy="50%"
                            innerRadius={50}
                            outerRadius={70}
                            paddingAngle={3}
                            dataKey="value"
                          >
                            {supertypeData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip contentStyle={{ background: 'rgba(0,0,0,0.8)', border: '1px solid var(--border-glass)', borderRadius: '4px', fontSize: '0.8rem', color: 'var(--text-strong)' }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    {/* Legend */}
                    <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
                      {supertypeData.map((d, index) => (
                        <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem' }}>
                          <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: PIE_COLORS[index % PIE_COLORS.length] }}></div>
                          <span style={{ color: 'var(--text-secondary)' }}>{d.name}: <strong>{d.value}</strong></span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Color and land distribution */}
                {energyData.length > 0 && (
                  <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <BarChart2 size={14} style={{ color: 'var(--accent-yellow)' }} /> {t('deck.colorLandDist')}
                    </h3>
                    <div style={{ width: '100%', height: '220px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={energyData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                          <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={10} tickLine={false} />
                          <YAxis stroke="var(--text-muted)" fontSize={10} tickLine={false} />
                          <Tooltip contentStyle={{ background: 'rgba(0,0,0,0.8)', border: '1px solid var(--border-glass)', borderRadius: '4px', fontSize: '0.8rem', color: 'var(--text-strong)' }} />
                          <Bar dataKey="value" fill="var(--accent-yellow)" radius={[4, 4, 0, 0]}>
                            {energyData.map((entry, idx) => {
                              const colorMap = {
                                'White': '#fef08a', 'Blue': '#3b82f6', 'Black': '#475569', 'Red': '#ef4444', 'Green': '#10b981', 'Colorless': '#cbd5e1',
                                'Land (Plains)': '#fef08a', 'Land (Island)': '#60a5fa', 'Land (Swamp)': '#475569', 'Land (Mountain)': '#f87171', 'Land (Forest)': '#4ade80', 'Land (Nonbasic)': '#d97706'
                              };
                              return <Cell key={`cell-${idx}`} fill={colorMap[entry.name] || 'var(--accent-yellow)'} />;
                            })}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}
              </div>

            </div>
          </div>
        </div>
      )}

      {/* --- POPUPS & MODALS --- */}

      {/* A. Create Deck Modal */}
      {showCreateModal && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
          <div className="glass-panel" style={{ maxWidth: '480px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '1.75rem', position: 'relative', border: '1px solid rgba(255,255,255,0.15)' }}>
            <button className="btn btn-secondary btn-icon-only" onClick={() => setShowCreateModal(false)} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>

            <h3 style={{ fontSize: '1.25rem', color: 'var(--text-strong)', fontWeight: 800, marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <FolderPlus size={20} style={{ color: 'var(--accent-yellow)' }} />
              {t('deck.createTitle')}
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
              {t('deck.createSubtitle')}
            </p>

            <form onSubmit={handleCreateDeck} style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem', maxHeight: '80vh', overflowY: 'auto', paddingRight: '0.25rem' }}>
              
              {/* Format & Target Size Row */}
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.75rem' }}>
                <div className="form-group">
                  <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>{t('deck.format')}</label>
                  <select
                    className="input-control"
                    value={newDeckFormat}
                    onChange={(e) => {
                      const selectedFmt = e.target.value;
                      setNewDeckFormat(selectedFmt);
                      if (selectedFmt.includes('Commander')) setNewDeckTargetSize(100);
                      else if (selectedFmt.includes('Standard') || selectedFmt.includes('Modern') || selectedFmt.includes('Pioneer')) setNewDeckTargetSize(60);
                    }}
                    style={{ fontSize: '0.85rem' }}
                  >
                    {MTG_FORMATS.map(fmt => (
                      <option key={fmt} value={fmt} style={{ background: '#1e293b', color: '#fff' }}>{fmt}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>{t('deck.targetSize')}</label>
                  <input
                    type="number"
                    min="1"
                    max="300"
                    className="input-control"
                    value={newDeckTargetSize}
                    onChange={(e) => setNewDeckTargetSize(parseInt(e.target.value, 10) || 60)}
                    style={{ fontSize: '0.85rem' }}
                  />
                </div>
              </div>

              {/* Deck Name */}
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>{t('deck.deckName')}</label>
                <input 
                  type="text" 
                  className="input-control" 
                  placeholder={t('deck.namePlaceholder')} 
                  value={newDeckName} 
                  onChange={(e) => setNewDeckName(e.target.value)}
                  required 
                  autoFocus
                />
              </div>

              {/* COMMANDER SELECTION.
                  Rendered ONLY for the Commander format. Every other format
                  sees this modal exactly as it was: no field, no validation,
                  no layout change.

                  One or two slots. A single slot would be wrong on day one --
                  partner pairs and Backgrounds are ordinary, and The Prismatic
                  Piper is never a legal commander by itself. */}
              {newDeckIsCommander && (
                <div className="form-group">
                  <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>
                    {t('deck.commanderLabel')} <span style={{ color: 'var(--accent-red)' }}>*</span>
                  </label>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem' }}>
                    {t('deck.commanderHint')}
                  </span>

                  {/* The chosen commanders. Each shows its exact printing,
                      because that is its identity -- the same thing every
                      other card in the deck shows. */}
                  {newDeckCommanders.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginBottom: '0.5rem' }}>
                      {newDeckCommanders.map((commander, index) => (
                        <div key={`${commander.desired_card_id}-${commander.desired_finish}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.3rem 0.5rem', background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.3)', borderRadius: 'var(--radius-sm)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                            <img src={commander.image_url} alt={commander.name} style={{ width: '24px', height: '33px', objectFit: 'cover', borderRadius: '2px' }} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-strong)' }}>{commander.name}</div>
                              <div style={{ fontSize: '0.62rem', color: 'var(--text-secondary)' }}>
                                {commander.set_name} • #{commander.number} · {finishLabel(commander.desired_finish)}
                              </div>
                            </div>
                          </div>
                          <button type="button" className="btn btn-secondary btn-icon-only" style={{ padding: '0.2rem' }} onClick={() => removeCommanderChoice(index)} title={t('deck.commanderRemove')}>
                            <X size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* The search. Hidden once two commanders are chosen, since
                      there is nothing left to fill. */}
                  {newDeckCommanders.length < 2 && (
                    <>
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <input
                          type="text"
                          className="input-control"
                          placeholder={t('deck.commanderSearchPlaceholder')}
                          value={commanderQuery}
                          onChange={(e) => setCommanderQuery(e.target.value)}
                          // Enter must not submit the create form while the
                          // user is searching for a commander -- it would
                          // create the deck with whatever is chosen so far.
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              searchCommanders(commanderQuery);
                            }
                          }}
                          style={{ flex: 1, fontSize: '0.85rem' }}
                        />
                        <button type="button" className="btn btn-secondary" onClick={() => searchCommanders(commanderQuery)} style={{ padding: '0.5rem 0.8rem' }}>
                          <Search size={14} />
                        </button>
                      </div>

                      {commanderSearching ? (
                        <div className="spinner" style={{ margin: '0.6rem auto' }}></div>
                      ) : commanderResults.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginTop: '0.5rem', maxHeight: '160px', overflowY: 'auto', background: 'var(--surface-2)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.4rem' }}>
                          {commanderResults.map(card => (
                            <button
                              key={card.id}
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => addCommanderChoice(card)}
                              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0.4rem', fontSize: '0.72rem', textAlign: 'left' }}
                            >
                              <img src={card.image_url} alt={card.name} style={{ width: '20px', height: '28px', objectFit: 'cover', borderRadius: '2px' }} />
                              <span style={{ color: 'var(--text-strong)' }}>
                                {card.name} <span style={{ color: 'var(--text-secondary)' }}>({card.set_name} • #{card.number})</span>
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  {/* THE REFUSAL AND ITS OVERRIDE.
                      Rendered INSIDE the existing commander field, not as a
                      new screen or a separate modal -- it is about the
                      commanders chosen just above it, and it belongs next to
                      them.

                      It appears only after the server has actually refused.
                      There is no pre-armed checkbox and no default path
                      through: the user must read the refusal, type a reason,
                      and press a button that is disabled until they do.
                      Silence is not consent. */}
                  {commanderRefusal && (
                    <div style={{ marginTop: '0.6rem', padding: '0.6rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 'var(--radius-sm)', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4rem' }}>
                        <AlertTriangle size={14} style={{ color: 'var(--accent-red)', flexShrink: 0, marginTop: '1px' }} />
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-strong)', fontWeight: 600, lineHeight: 1.35 }}>
                          {commanderRefusal.error}
                        </div>
                      </div>

                      {/* Why an override exists at all, said plainly. The user
                          needs to know this is "the app might not know that
                          mechanic yet", not "the rules are optional". */}
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                        {t('deck.commanderOverrideHint')}
                      </div>

                      <input
                        type="text"
                        className="input-control"
                        placeholder={t('deck.commanderOverrideReasonPlaceholder')}
                        value={commanderOverrideReason}
                        onChange={(e) => setCommanderOverrideReason(e.target.value)}
                        // Enter must not submit the form from inside the
                        // reason box: that would let a stray keypress perform
                        // the override, which is the opposite of an explicit
                        // confirmation.
                        onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                        style={{ fontSize: '0.78rem' }}
                      />

                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          // DISABLED until a reason is typed. The reason is
                          // what turns a bypass into a bug report the parser
                          // can be improved from, so an override without one
                          // is not an override -- and the server rejects it
                          // too, because the client is not the authority.
                          disabled={!commanderOverrideReason.trim()}
                          onClick={(e) => handleCreateDeck(e, { reason: commanderOverrideReason.trim() })}
                          style={{ fontSize: '0.72rem', padding: '0.35rem 0.7rem', opacity: commanderOverrideReason.trim() ? 1 : 0.5 }}
                        >
                          {t('deck.commanderOverrideConfirm')}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => { setCommanderRefusal(null); setCommanderOverrideReason(''); }}
                          style={{ fontSize: '0.72rem', padding: '0.35rem 0.7rem' }}
                        >
                          {t('deck.commanderOverrideCancel')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Category Pills */}
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.4rem', display: 'block' }}>{t('deck.category')}</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                  {DECK_CATEGORIES.map(cat => {
                    const isSelected = newDeckCategory === cat;
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setNewDeckCategory(cat)}
                        style={{
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          padding: '0.3rem 0.65rem',
                          borderRadius: '12px',
                          border: isSelected ? '1px solid var(--accent-yellow)' : '1px solid var(--border-glass)',
                          background: isSelected ? 'rgba(234, 179, 8, 0.2)' : 'rgba(0,0,0,0.2)',
                          color: isSelected ? 'var(--accent-yellow)' : 'var(--text-secondary)',
                          cursor: 'pointer',
                          transition: 'all 0.15s'
                        }}
                      >
                        {cat}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Deck Accent Color */}
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.4rem', display: 'block' }}>{t('deck.accentColor')}</label>
                <div style={{ display: 'flex', itemsAlign: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {DECK_ACCENT_COLORS.map(c => {
                    const isSelected = newDeckAccentColor === c.hex;
                    return (
                      <div
                        key={c.hex}
                        onClick={() => setNewDeckAccentColor(c.hex)}
                        title={c.name}
                        style={{
                          width: '26px',
                          height: '26px',
                          borderRadius: '50%',
                          backgroundColor: c.hex,
                          cursor: 'pointer',
                          border: isSelected ? '2px solid #ffffff' : '2px solid transparent',
                          boxShadow: isSelected ? `0 0 10px ${c.hex}` : 'none',
                          transform: isSelected ? 'scale(1.15)' : 'scale(1)',
                          transition: 'all 0.15s'
                        }}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Description (Optional) */}
              <div className="form-group">
                <label style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)', marginBottom: '0.3rem', display: 'block' }}>Description (Optional)</label>
                <textarea
                  className="input-control"
                  style={{ minHeight: '65px', resize: 'vertical', fontSize: '0.85rem' }}
                  placeholder={t('deck.notesPlaceholder')}
                  value={newDeckDesc}
                  onChange={(e) => setNewDeckDesc(e.target.value)}
                />
              </div>

              {/* Quick Decklist Importer Toggle */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowImportDecklistArea(!showImportDecklistArea)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent-yellow)',
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: 0
                  }}
                >
                  <FileText size={14} />
                  {showImportDecklistArea ? 'Hide Quick Import Decklist' : '+ Quick Import Decklist (Optional)'}
                </button>

                {showImportDecklistArea && (
                  <div style={{ marginTop: '0.5rem' }}>
                    <textarea
                      className="input-control"
                      style={{ minHeight: '90px', fontFamily: 'monospace', fontSize: '0.8rem', whiteSpace: 'pre' }}
                      placeholder={`Paste decklist (e.g. \n4 Lightning Bolt\n2 Counterspell\n1 Sol Ring)`}
                      value={newDeckImportText}
                      onChange={(e) => setNewDeckImportText(e.target.value)}
                    />
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'block', marginTop: '0.2rem' }}>
                      {t('deck.importOnCreateHint')}
                    </span>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowCreateModal(false)}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 2, fontWeight: 700 }}>{t('deck.createDeck')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* B. Draw Hand Simulator Modal */}
      {showSimulator && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
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
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
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
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
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
