import { useState, useEffect } from 'react';
import { Plus, Trash2, X, ChevronLeft, Play, BarChart2, Search, LogOut, PackageCheck, LayoutGrid, List, Download, Upload, Eye, Filter, CheckCircle, AlertTriangle, Layers, Swords, Gamepad2, SlidersHorizontal, ArrowRight, FolderPlus, FileText, ChevronDown, ChevronRight, Lightbulb } from 'lucide-react';
import { ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip } from 'recharts';
import { shuffleArray } from '../utils/shuffle';

import CheckoutWizardModal from './CheckoutWizardModal';
import { useBackGuard } from '../utils/useBackGuard';
import { buildDeckExport, parseDeckLine } from '../utils/deckText';
import { useT } from '../utils/i18n';
import { groupDeckCards, sectionCount, sectionForTypeLine, requirementStatus, finishLabel } from './deckSections';

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
  muted: { background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', border: '1px solid var(--border-glass)' }
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
  
  // Card Search States inside editor
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const deckSearchGame = 'mtg';

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

  const handleCreateDeck = async (e) => {
    e.preventDefault();
    if (!newDeckName.trim()) return;

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
          target_size: newDeckTargetSize
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

        setNewDeckName('');
        setNewDeckDesc('');
        setNewDeckFormat('Commander / EDH');
        setNewDeckCategory('Competitive');
        setNewDeckAccentColor('#eab308');
        setNewDeckTargetSize(100);
        setNewDeckImportText('');
        setShowImportDecklistArea(false);
        setShowCreateModal(false);
        fetchDecks();
      } else {
        showToast(t('deck.errCreate'));
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
  const writeRequirement = async ({ desired_card_id, desired_finish, board = 'mainboard', quantity }) => {
    if (!activeDeck) return false;
    const response = await fetch(`/api/decks/${activeDeck.id}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ desired_card_id, desired_finish, board, quantity })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
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

  // "Add this card" from the search results.
  //
  // The gesture the user makes is still one click on the card they searched
  // for. What changed is what happens when that click is AMBIGUOUS. If they own
  // exactly one printing+finish of the card there is nothing to ask and it is
  // added immediately, exactly as before. If they own several, we open the
  // variant picker inline in this same list rather than picking for them --
  // choosing silently is the specific failure exact-only identity exists to
  // prevent.
  const handleAddCardToDeck = async (card, board = 'mainboard') => {
    if (!activeDeck || savingCard) return;

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
  // Implemented as add-then-remove rather than an UPDATE, because the entry's
  // identity IS (printing, finish): changing them makes it a different
  // requirement, and the server's upsert is keyed on them.
  //
  // The ORDER is load-bearing. Removing first and then adding would, if the add
  // failed (dropped connection, server restart between the two calls), leave
  // the card gone from the deck entirely -- a silent loss of a requirement the
  // user never asked to delete, on an app whose whole job is tracking physical
  // objects. Adding first means the worst case is a visible duplicate row the
  // user can see and remove, not a disappearance they will not notice until
  // they are standing at the binder.
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
        quantity: (existing ? existing.quantity : 0) + entry.quantity
      });
      if (!ok) return;

      const removed = await fetch(`/api/decks/${activeDeck.id}/cards/${entry.id}`, { method: 'DELETE' });
      if (!removed.ok) showToast(t('deck.errQuantity'));

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
  // uniqueness key, so a move is a delete of the old row plus a write of the
  // new one rather than an in-place update. The delete happens second: if the
  // write fails the user still has their card, which is the safe way round for
  // software tracking physical objects.
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
        quantity: (existing ? existing.quantity : 0) + entry.quantity
      });
      if (!ok) return;

      const res = await fetch(`/api/decks/${activeDeck.id}/cards/${entry.id}`, { method: 'DELETE' });
      if (!res.ok) {
        showToast(t('loc.errRemoveCard'));
      }
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
  const handleRemoveCard = async (deckCardId) => {
    if (!activeDeck) return;

    try {
      const response = await fetch(`/api/decks/${activeDeck.id}/cards/${deckCardId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast(t('deck.cardRemoved'));
        loadDeckDetails(activeDeck.id);
      } else {
        showToast(t('loc.errRemoveCard'));
      }
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

  const handleSearchCards = async (e, forceBrowse = false) => {
    if (e) e.preventDefault();
    try {
      setSearching(true);
      if (forceBrowse || !searchQuery.trim()) {
        const res = await fetch(`/api/collection?game=${deckSearchGame}`);
        if (res.ok) {
          const data = await res.json();
          const mapped = data.map(item => ({
            id: item.card_id,
            oracle_id: item.oracle_id,
            name: item.name,
            set_name: item.set_name,
            number: item.number || item.collector_number || item.card_number || '',
            image_url: item.image_url,
            owned_qty: item.quantity || 1,
            supertype: item.supertype,
            subtypes: item.subtypes,
            types: item.types,
            type_line: item.type_line,
            finishes: item.finishes,
            colors: item.colors,
            cmc: item.cmc
          }));
          setSearchResults(mapped);
        }
      } else {
        const finalQuery = searchQuery;
        const response = await fetch(`/api/search?name=${encodeURIComponent(finalQuery)}&scope=collection&game=${deckSearchGame}`);
        if (response.ok) {
          const data = await response.json();
          setSearchResults(data);
        } else {
          showToast(t(response.status === 429 ? 'deck.errRateLimit' : 'deck.errSearch'));
        }
      }
    } catch (err) {
      console.error(err);
      showToast(t('deck.errSearch'));
    } finally {
      setSearching(false);
    }
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

  const handleExportDeckText = () => {
    if (!activeDeck) return '';
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
  const handleOpenMassEntry = () => {
    const text = buildDeckExport(deckCards, 'buylist');
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
    if (summary.unresolved_copies > 0) {
      showToast(t('deck.importUnresolvedCopies', { count: summary.unresolved_copies }));
    }

    await loadDeckDetails(activeDeck.id);
    setImportText('');
    setImportComparison(null);
    setImportSummary(null);
    setImportChoices({});
    setImportPicker(null);
    setShowImportModal(false);
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

              {/* View Mode Toggle: Grid vs Table */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', background: 'rgba(0,0,0,0.3)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
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
                      border: deck.checked_out
                        ? '1px solid rgba(234,179,8,0.5)'
                        : `1px solid ${accentColor}40`,
                      position: 'relative',
                      overflow: 'hidden',
                      cursor: 'pointer',
                      transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
                      background: 'linear-gradient(145deg, rgba(211,32,42,0.06), rgba(15,23,42,0.65))'
                    }}
                    onClick={() => loadDeckDetails(deck.id)}
                    onMouseEnter={e => {
                      e.currentTarget.style.transform = 'translateY(-3px)';
                      e.currentTarget.style.boxShadow = `0 12px 30px ${accentColor}25`;
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.transform = 'none';
                      e.currentTarget.style.boxShadow = 'none';
                    }}
                  >
                    {/* Top Accent Line */}
                    <div style={{
                      position: 'absolute', top: 0, left: 0, right: 0, height: '3px',
                      background: deck.checked_out
                        ? 'linear-gradient(90deg, #eab308, #f59e0b)'
                        : `linear-gradient(90deg, ${accentColor}, ${accentColor}cc)`
                    }} />

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
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', background: 'rgba(0,0,0,0.2)', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem' }}>
                        <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('deck.cardCapacity')}</span>
                        <span style={{ color: isComplete ? '#4ade80' : 'var(--text-strong)', fontWeight: 700 }}>
                          {totalCards} / {targetSize} Cards ({percent}%)
                        </span>
                      </div>
                      <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{
                          height: '100%',
                          width: `${percent}%`,
                          background: isComplete
                            ? 'linear-gradient(90deg, #4ade80, #22c55e)'
                            : 'linear-gradient(90deg, #3b82f6, #6366f1)',
                          borderRadius: '3px',
                          transition: 'width 0.3s ease'
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
                            style={{ padding: '0.3rem 0.65rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px', border: '1px solid rgba(234,179,8,0.4)', color: '#eab308' }}
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
                  <tr style={{ borderBottom: '1px solid var(--border-glass)', background: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
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

                    return (
                      <tr
                        key={deck.id}
                        style={{ borderBottom: '1px solid var(--border-glass)', cursor: 'pointer', transition: 'background 0.15s' }}
                        onClick={() => loadDeckDetails(deck.id)}
                        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
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
                            <span style={{ fontSize: '0.7rem', fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'rgba(234,179,8,0.15)', color: '#eab308', border: '1px solid rgba(234,179,8,0.4)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              <Gamepad2 size={11} /> In Play
                            </span>
                          ) : isComplete ? (
                            <span style={{ fontSize: '0.7rem', fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'rgba(74, 222, 128, 0.15)', color: '#4ade80', border: '1px solid rgba(74, 222, 128, 0.3)' }}>
                              {t('deck.statusReady')}
                            </span>
                          ) : (
                            <span style={{ fontSize: '0.7rem', fontWeight: 800, padding: '2px 8px', borderRadius: '10px', background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', border: '1px solid var(--border-glass)' }}>
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
                      border: '1px solid rgba(234,179,8,0.4)',
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
                  style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', border: '1px solid rgba(234,179,8,0.4)', color: '#eab308' }}
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
            <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: '1.5rem' }}>
              
              {/* Left Column: Deck Card List */}
              <div style={{ flex: '2 1 500px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                
                {/* Search & Quick Add to Deck */}
                <div className="glass-panel">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', margin: 0 }}>{t('deck.addCardsTitle')}</h3>
                  </div>
                  <form onSubmit={handleSearchCards} style={{ display: 'flex', gap: '0.5rem' }}>
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
                    <button type="button" className="btn btn-secondary" onClick={(e) => handleSearchCards(e, true)} style={{ padding: '0.5rem 0.9rem', fontSize: '0.75rem', whiteSpace: 'nowrap' }} title={t('deck.browseHint')}>
                      {t('deck.browseCollection')}
                    </button>
                  </form>

                  {/* Search Results list */}
                  {searching || loadingVariants ? (
                    <div className="spinner" style={{ margin: '1rem auto' }}></div>
                  ) : searchResults.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '1rem', maxHeight: '240px', overflowY: 'auto', background: 'rgba(0,0,0,0.15)', padding: '0.5rem', borderRadius: 'var(--radius-sm)' }}>
                      {searchResults.map(card => {
                          // "In deck" is counted across every printing and
                          // finish of this Oracle card, because that is the
                          // question the user is asking when they look at a
                          // search row: have I already put this card in?
                          const qtyInDeck = deckCards
                            .filter(c => c.oracle_id === card.oracle_id)
                            .reduce((s, c) => s + c.quantity, 0);
                          const ownedQty = card.owned_qty || 0;
                          const isAtRuleMax = !isBasicEnergyOrLand(card) && deckCountByName(deckCards, card.name) >= 4;
                          // Ownership does NOT disable the add. Planning a deck
                          // you have not finished buying is the normal case;
                          // the row's badge reports the shortfall instead.
                          const disabledAdd = savingCard || isAtRuleMax;
                          const isPicking = variantPicker && variantPicker.card.oracle_id === card.oracle_id;

                          return (
                            <div key={card.id} style={{ display: 'flex', flexDirection: 'column', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', border: `1px solid ${isPicking ? 'rgba(234,179,8,0.4)' : 'var(--border-glass)'}` }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.35rem 0.5rem' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }} onClick={() => setPreviewCard(card)}>
                                  <img src={card.image_url} alt={card.name} style={{ width: '24px', height: '33px', objectFit: 'cover', borderRadius: '2px' }} />
                                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                                    <span style={{ fontSize: '0.8rem', color: 'var(--text-strong)' }}>{card.name} ({card.set_name} • #{card.number})</span>
                                    <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>Owned: {ownedQty} | In Deck: {qtyInDeck}</span>
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
                  )}
                </div>

                {/* Deck Cards Header & Display Mode Toggle */}
                <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <h3 style={{ fontSize: '1rem', color: 'var(--text-strong)', borderLeft: '3px solid var(--accent-red)', paddingLeft: '0.5rem', margin: 0 }}>
                      Deck Cards ({totalDeckCardsCount} / {targetDeckCardsCount})
                    </h3>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
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
                                          <span style={{ fontSize: '0.6rem', fontWeight: 800, padding: '1px 6px', borderRadius: '10px', background: 'rgba(234,179,8,0.15)', color: '#eab308', border: '1px solid rgba(234,179,8,0.4)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
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
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: '4px', border: '1px solid var(--border-glass)' }}>
                                      <button
                                        className={`btn ${card.quantity === 1 ? 'btn-danger' : 'btn-secondary'} btn-icon-only`}
                                        style={{ width: '22px', height: '22px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                        disabled={savingCard}
                                        onClick={() => handleUpdateCardQty(card, card.quantity - 1)}
                                        title={t(card.quantity === 1 ? 'deck.removeFromDeck' : 'deck.decreaseQty')}
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

                          {/* 2. VISUAL CARD GRID VIEW */}
                          {!collapsed && cardDisplayMode === 'grid' && (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: '0.75rem' }}>
                              {section.cards.map(card => (
                                <div key={card.id} style={{ position: 'relative', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border-glass)', background: 'rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column', transition: 'transform 0.15s' }}>
                                  <div style={{ position: 'relative', width: '100%', aspectRatio: 0.718, cursor: 'pointer' }} onClick={() => setPreviewCard(card)}>
                                    <img src={card.image_url} alt={card.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                    <span style={{ position: 'absolute', top: '4px', right: '4px', background: 'rgba(0,0,0,0.85)', color: 'var(--accent-yellow)', fontSize: '0.75rem', fontWeight: 800, padding: '1px 6px', borderRadius: '10px', border: '1px solid var(--accent-yellow)' }}>
                                      x{card.quantity}
                                    </span>
                                    <span style={{ position: 'absolute', bottom: '4px', left: '4px' }}>
                                      <PrintingBadge card={card} />
                                    </span>
                                  </div>
                                  <div style={{ padding: '4px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px', background: 'rgba(0,0,0,0.5)' }}>
                                    <StatusBadge card={card} />
                                    <div style={{ display: 'flex', gap: '2px' }}>
                                      <button className={`btn ${card.quantity === 1 ? 'btn-danger' : 'btn-secondary'} btn-icon-only`} style={{ width: '20px', height: '20px', fontSize: '0.7rem', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} disabled={savingCard} onClick={() => handleUpdateCardQty(card, card.quantity - 1)} title={t(card.quantity === 1 ? 'deck.removeFromDeck' : 'deck.decreaseQty')}>
                                        {card.quantity === 1 ? <Trash2 size={10} /> : '-'}
                                      </button>
                                      <button className="btn btn-secondary btn-icon-only" style={{ width: '20px', height: '20px', fontSize: '0.7rem', padding: 0 }} disabled={savingCard || (!isBasicEnergyOrLand(card) && deckCountByName(deckCards, card.name) >= 4)} onClick={() => handleUpdateCardQty(card, card.quantity + 1)}>+</button>
                                      <button className="btn btn-secondary btn-icon-only" style={{ width: '20px', height: '20px', fontSize: '0.7rem', padding: 0, color: isConsidering ? 'var(--accent-yellow)' : undefined }} disabled={savingCard} onClick={() => handleMoveBoard(card, isConsidering ? 'mainboard' : 'considering')} title={t(isConsidering ? 'deck.moveToDeck' : 'deck.moveToConsidering')}>
                                        <Lightbulb size={10} />
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}

                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Right Column: Statistics, Mana Curve & Deck Health */}
              <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                
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
                <div style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '180px', overflowY: 'auto' }}>
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
                                  : item.status === 'missing' ? 'warn'
                                    : 'unavailable'
                            ])
                          }}>
                            {item.status === 'full' ? `Owned (${item.allocated})`
                              : item.status === 'partial' ? `Partial (${item.allocated}/${item.requested})`
                                : item.status === 'missing' ? `Missing (${item.shortfall})`
                                  : 'Not found'}
                          </span>
                        </div>
                      </div>
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
