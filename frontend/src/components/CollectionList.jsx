import { useState, useEffect, useMemo } from 'react';
import { Search, Trash2, Edit2, LayoutGrid, List, SlidersHorizontal, X, MousePointerClick, MapPin, Plus, Camera, Download } from 'lucide-react';

import { formatPrice } from '../utils/formatPrice';
import { CONDITIONS, PRINTINGS } from '../utils/cardOptions';
import { getFoilOverlayClass } from '../utils/cardPrinting';
import { getCardRarityBorder, getRarityBadgeLabel, getRarityBadgeStyle } from '../utils/cardRarity';
import { sortCardsByOrder } from '../utils/cardSort';
import { useMultiSelect } from '../utils/useMultiSelect';

import { useT } from '../utils/i18n';
import CardInspectorModal from './CardInspectorModal';
import CardTile from './CardTile';
import AddToDeckSelect from './AddToDeckSelect';
import PackPriceSplitter from './PackPriceSplitter';

const labelStyle = { fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' };

// Maps each Sort By option to sortCardsByOrder criteria so ordering matches the
// storage engine (set = chronological via setsList).
// 'qty-desc' isn't a card-order scheme, handled separately.
const SORT_CRITERIA = {
  'added-newest': [{ by: 'added_at', dir: 'desc' }, { by: 'entry_id', dir: 'desc' }],
  'added-oldest': [{ by: 'added_at', dir: 'asc' }],
  'name-asc': [{ by: 'name', dir: 'asc' }],
  'name-desc': [{ by: 'name', dir: 'desc' }],
  'price-desc': [{ by: 'price', dir: 'desc' }],
  'price-asc': [{ by: 'price', dir: 'asc' }],
  'set-asc': [{ by: 'set', dir: 'asc' }, { by: 'number', dir: 'asc' }],
  'number-asc': [{ by: 'number', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'rarity-desc': [{ by: 'rarity', dir: 'desc' }, { by: 'name', dir: 'asc' }],
  'rarity-asc': [{ by: 'rarity', dir: 'asc' }, { by: 'name', dir: 'asc' }],
  'type-asc': [{ by: 'type', dir: 'asc' }, { by: 'name', dir: 'asc' }],

  'favorite-first': [{ by: 'favorite', dir: 'desc' }, { by: 'added_at', dir: 'desc' }],
};

// Small labelled field wrapper to keep the filter grid uniform.
function Field({ label, children }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

// The five MTG colours, in WUBRG order -- the order every player and every
// deck list uses. `label` is what the API stores in color_identity ("Blue"),
// `code` is what the pip shows, `token` is the muted fill from index.css.
// One style for every row in the add menu, so a future item cannot drift.
const ADD_MENU_ITEM = {
  display: 'flex', alignItems: 'center', gap: '0.6rem', width: '100%',
  padding: '0.75rem 0.9rem', minHeight: 44, border: 0,
  borderBottom: '1px solid var(--border-glass)',
  background: 'transparent', color: 'var(--text-primary)',
  font: 'inherit', fontSize: '0.9rem', textAlign: 'left', cursor: 'pointer',
};

const MTG_COLORS = [
  { code: 'W', label: 'White', token: 'var(--mtg-white)' },
  { code: 'U', label: 'Blue',  token: 'var(--mtg-blue)' },
  { code: 'B', label: 'Black', token: 'var(--mtg-black)' },
  { code: 'R', label: 'Red',   token: 'var(--mtg-red)' },
  { code: 'G', label: 'Green', token: 'var(--mtg-green)' },
];

// Returns a NEW Set with `value` toggled. New, not mutated: React compares by
// reference, so mutating the existing Set would change the filter without
// re-rendering -- the list would silently disagree with the controls.
function toggleIn(set, value) {
  const next = new Set(set);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
}

// A horizontally scrolling row of multi-select chips.
//
// Chips rather than a <select multiple>: on iOS a multi-select renders as a
// picker that shows one option at a time, which makes "how many are selected"
// invisible -- and that is the only question this control has to answer at a
// glance. Horizontal scroll keeps 60 sets reachable one-handed without a modal.
function ChipRow({ options, selected, onToggle }) {
  return (
    <div
      style={{
        display: 'flex', gap: '0.35rem', overflowX: 'auto', paddingBottom: '0.2rem',
        scrollbarWidth: 'none', msOverflowStyle: 'none',
      }}
    >
      {options.map(opt => {
        const on = selected.has(opt);
        return (
          <button
            key={opt}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(opt)}
            style={{
              flexShrink: 0, minHeight: 34, padding: '0.4rem 0.75rem',
              borderRadius: 'var(--radius-sm)', cursor: 'pointer',
              border: '1px solid ' + (on ? 'var(--accent-blue)' : 'var(--border-glass)'),
              background: on ? 'var(--accent-blue)' : 'var(--surface-1)',
              color: on ? 'var(--text-on-accent)' : 'var(--text-secondary)',
              fontSize: '0.8rem', fontWeight: on ? 600 : 500,
              whiteSpace: 'nowrap', transition: 'var(--transition-smooth)',
            }}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

function CollectionList({ statsTrigger, onUpdate, showToast, selectedCardFilter, setSelectedCardFilter, onNavigate, setSelectedLocationId, setFocusEntryId }) {
  const { t } = useT();
  const [collection, setCollection] = useState([]);
  const [locations, setLocations] = useState([]);
  const [setsList, setSetsList] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (selectedCardFilter) {
      setSearchFilter(selectedCardFilter);
      // Reset after applying so they can clear search manually
      setSelectedCardFilter('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCardFilter]);

  // UX view state
  const [viewMode, setViewMode] = useState('gallery'); // 'gallery' or 'list'
  const [inspectorCard, setInspectorCard] = useState(null);
  const [inspectorStartEdit, setInspectorStartEdit] = useState(false);
  const [subTab, setSubTab] = useState('collection'); // 'collection', 'wishlist'
  const [showFilters, setShowFilters] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  // Search & Filter state
  const [searchFilter, setSearchFilter] = useState('');

  const [locationFilter, setLocationFilter] = useState('');
  const [rarityFilter, setRarityFilter] = useState('');
  const [conditionFilter, setConditionFilter] = useState('');
  const [printingFilter, setPrintingFilter] = useState('');
  // MULTI-SELECT, as Sets, not single values. A card can be several types
  // (Dryad of the Ilysian Grove is Creature AND Enchantment) and several
  // colours, so a filter that holds one value cannot express the question.
  // Sets are Sets too -- "everything from the last two Commander sets".
  const [setFilters, setSetFilters] = useState(() => new Set());
  const [typeFilters, setTypeFilters] = useState(() => new Set());
  // WUBRG. The card's color_identity arrives from the API already parsed into
  // an array (priceHelpers.parseCardRow), so no parsing happens in the client.
  const [colorFilters, setColorFilters] = useState(() => new Set());
  const [supertypeFilter, setSupertypeFilter] = useState('');
  const [cmcFilter, setCmcFilter] = useState('');

  const [minPriceFilter, setMinPriceFilter] = useState('');
  const [maxPriceFilter, setMaxPriceFilter] = useState('');
  const [sortBy, setSortBy] = useState('added-newest');
  const [tradeOnly, setTradeOnly] = useState(false);
  const [favoriteOnly, setFavoriteOnly] = useState(false);

  // Stacking state (default to stacked)
  const [stackCards, setStackCards] = useState(true);
  const [stackByCondition, setStackByCondition] = useState(false);
  const [stackByPrinting, setStackByPrinting] = useState(false);

  // Multi-select / bulk actions — shared long-press + /api/collection/bulk logic.
  const {
    selectMode, setSelectMode, selectedIds, setSelectedIds, toggleSelect, selectAt, clearSelection, exitSelectMode,
    bulkMoveTarget, setBulkMoveTarget, pressHandlers, longPressFired, runBulk,
  } = useMultiSelect({ showToast, onChanged: () => { onUpdate(); fetchCollection(); } });

  useEffect(() => {
    fetchCollection();
    fetchLocations();
    fetchSets();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsTrigger, subTab, tradeOnly]);

  const fetchCollection = async () => {
    try {
      setLoading(true);
      let url = '/api/collection?list_type=collection';
      if (subTab === 'wishlist') {
        url = '/api/collection?list_type=wishlist';
      }
      if (tradeOnly) {
        url += '&is_trade=1';
      }

      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        setCollection(data);
      }
    } catch (err) {
      console.error(err);
      showToast(t('collection.errLoad'));
    } finally {
      setLoading(false);
    }
  };

  const fetchLocations = async () => {
    try {
      const response = await fetch('/api/locations');
      if (response.ok) {
        const data = await response.json();
        setLocations(data);
      }
    } catch (err) {
      console.error('Error fetching locations:', err);
    }
  };

  const fetchSets = async () => {
    try {
      const response = await fetch('/api/sets');
      if (response.ok) setSetsList(await response.json());
    } catch (err) {
      console.error('Error fetching sets:', err);
    }
  };

  const handleDelete = async (entryId, cardName) => {
    if (!window.confirm(t('collection.confirmDeleteCard', { name: cardName }))) {
      return;
    }

    try {
      const response = await fetch(`/api/collection/${entryId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast(t('collection.cardRemoved', { name: cardName }));
        onUpdate();
      } else {
        showToast(t('collection.errDelete'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('common.errBackend'));
    }
  };

  const openEdit = (item) => {
    setInspectorCard(item);
    setInspectorStartEdit(true);
  };

  // Tap: swallowed if a long-press just armed selection; otherwise toggle (in
  // select mode) or open the inspector.
  const activateCard = (item, event) => {
    if (longPressFired.current) { longPressFired.current = false; return; }
    if (selectMode) selectAt(item.entry_id, displayCards.map(i => i.entry_id), event?.shiftKey);
    else { setInspectorCard(item); setInspectorStartEdit(false); }
  };

  const handleViewStorage = (card) => {
    setInspectorCard(null);
    if (setSelectedLocationId) {
      setSelectedLocationId(card.location_id || 'unsorted');
    }
    if (setFocusEntryId) {
      setFocusEntryId(card.entry_id || card.id);
    }
    if (onNavigate) {
      onNavigate('storage');
    }
  };

  // Extract unique filter values from the loaded collection.
  const uniqueRarities = useMemo(
    () => Array.from(new Set(collection.map(item => item.rarity).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueSets = useMemo(
    () => Array.from(new Set(collection.map(item => item.set_name).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueTypes = useMemo(
    () => Array.from(new Set(collection.flatMap(item => item.types || []).filter(Boolean))).sort(),
    [collection]
  );
  const uniqueSupertypes = useMemo(
    () => Array.from(new Set(collection.map(item => item.supertype).filter(Boolean))).sort(),
    [collection]
  );

  const uniqueCmcs = useMemo(
    () => Array.from(new Set(collection.map(item => item.cmc).filter(v => v !== null && v !== undefined))).sort((a, b) => a - b),
    [collection]
  );

  const activeFilterCount = [
    locationFilter, rarityFilter, conditionFilter, printingFilter,
    setFilters.size ? 'set' : '', typeFilters.size ? 'type' : '',
    colorFilters.size ? 'color' : '', supertypeFilter, cmcFilter,
    minPriceFilter, maxPriceFilter
  ].filter(v => v !== '').length + (tradeOnly ? 1 : 0) + (favoriteOnly ? 1 : 0);

  const clearAllFilters = () => {
    setSearchFilter('');
    setLocationFilter(''); setRarityFilter(''); setConditionFilter('');
    setPrintingFilter(''); setSetFilters(new Set()); setTypeFilters(new Set());
    setColorFilters(new Set()); setSupertypeFilter('');
    setCmcFilter(''); setMinPriceFilter('');
    setMaxPriceFilter(''); setTradeOnly(false); setFavoriteOnly(false);
  };

  // Filter + sort
  const filteredCollection = useMemo(() => {
    const normalizedSearch = searchFilter.toLowerCase();
    const result = collection.filter(item => {
      const matchesSearch = item.name.toLowerCase().includes(normalizedSearch) ||
                            (item.set_name || '').toLowerCase().includes(normalizedSearch) ||
                            (item.number || '').includes(searchFilter);
      const matchesLocation = locationFilter === '' ? true :
                              locationFilter === 'unassigned' ? !item.location_id :
                              item.location_id == locationFilter;

      const matchesRarity = rarityFilter === '' ? true : item.rarity === rarityFilter;
      const matchesCondition = conditionFilter === '' ? true : item.condition === conditionFilter;
      const matchesPrinting = printingFilter === '' ? true : item.printing === printingFilter;
      // ANY-OF semantics for every multi-select: selecting B and G shows cards
      // that are black, green, OR both -- not only exactly-Golgari cards. That
      // is what a player means when they tap two pips, and the alternative
      // (all-of) makes two taps return almost nothing.
      const matchesSet = setFilters.size === 0 ? true : setFilters.has(item.set_name);
      const matchesType = typeFilters.size === 0
        ? true
        : (item.types || []).some(ty => typeFilters.has(ty));
      const matchesColor = colorFilters.size === 0
        ? true
        : (item.color_identity || []).some(c => colorFilters.has(c));
      const matchesSupertype = supertypeFilter === '' ? true : item.supertype === supertypeFilter;
      const matchesCmc = cmcFilter === '' ? true : String(item.cmc) === cmcFilter;

      const matchesFavorite = favoriteOnly ? item.favorite === 1 : true;

      const price = item.price_trend || 0;
      const matchesMinPrice = minPriceFilter === '' ? true : price >= parseFloat(minPriceFilter);
      const matchesMaxPrice = maxPriceFilter === '' ? true : price <= parseFloat(maxPriceFilter);

      return matchesSearch && matchesLocation && matchesRarity && matchesCondition &&
             matchesPrinting && matchesSet && matchesType && matchesColor &&
             matchesSupertype && matchesCmc && matchesFavorite &&
             matchesMinPrice && matchesMaxPrice;
    });

    if (sortBy === 'qty-desc') {
      result.sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
    } else {
      sortCardsByOrder(result, SORT_CRITERIA[sortBy] || SORT_CRITERIA['added-newest'], undefined, setsList);
    }
    return result;
  }, [collection, searchFilter, locationFilter, rarityFilter, conditionFilter, printingFilter, setFilters, typeFilters, colorFilters, supertypeFilter, cmcFilter, favoriteOnly, minPriceFilter, maxPriceFilter, sortBy, setsList]);

  // Group duplicate cards if stack option is active
  const processedCollection = useMemo(() => {
    if (!stackCards) return filteredCollection;

    const groups = {};
    filteredCollection.forEach(item => {
      let key = item.card_id;
      if (stackByCondition) key += `-${item.condition}`;
      if (stackByPrinting) key += `-${item.printing}`;

      if (!groups[key]) {
        groups[key] = { ...item };
      } else {
        groups[key].quantity += item.quantity;
      }
    });
    return Object.values(groups);
  }, [filteredCollection, stackCards, stackByCondition, stackByPrinting]);

  // In select mode, render the unstacked list so every entry is individually
  // selectable and bulk actions hit real entry_ids (stacking merges rows).
  const displayCards = selectMode ? filteredCollection : processedCollection;

  const totalValue = useMemo(
    () => displayCards.reduce((sum, item) => sum + (item.price_trend || 0) * (item.quantity || 1), 0),
    [displayCards]
  );

  return (
    <div>
      {/* Header: sub-tabs + selection hint + view toggle */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            className={`btn ${subTab === 'collection' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setSubTab('collection')}
            style={{ fontSize: '0.85rem', padding: '0.45rem 1.25rem', borderRadius: 'var(--radius-sm)' }}
          >
            {t('nav.collection')}
          </button>
          <button
            className={`btn ${subTab === 'wishlist' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setSubTab('wishlist')}
            style={{ fontSize: '0.85rem', padding: '0.45rem 1.25rem', borderRadius: 'var(--radius-sm)' }}
          >
            {t('collection.wishlist')}
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          {/* Multi-select toggle (long-press cards is the primary path) */}
          <button
            className={`btn ${selectMode ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            style={{ fontSize: '0.8rem', padding: '0.4rem 0.9rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
            title={t('collection.selectHint')}
          >
            <MousePointerClick size={14} />
            {t(selectMode ? 'bulk.done' : 'collection.select')}
          </button>

          {/* ADD MENU. Three ways cards get into a collection; a single "+"
              rather than three buttons competing for the header. */}
          <div style={{ position: 'relative' }}>
            <button
              className={`btn ${addMenuOpen ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setAddMenuOpen(o => !o)}
              aria-expanded={addMenuOpen}
              aria-haspopup="menu"
              title={t('collection.addCards')}
              style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', minHeight: 34 }}
            >
              <Plus size={16} />
            </button>

            {addMenuOpen && (
              <>
                {/* Full-screen catcher so a tap anywhere closes the menu. On a
                    phone there is no Escape key and no click-outside for free. */}
                <div
                  onClick={() => setAddMenuOpen(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 90 }}
                />
                <div
                  role="menu"
                  style={{
                    position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 91,
                    minWidth: 210, background: 'var(--surface-2)',
                    border: '1px solid var(--border-glass)',
                    borderRadius: 'var(--radius-md)', overflow: 'hidden',
                    boxShadow: 'var(--shadow-glow)',
                  }}
                >
                  <button
                    role="menuitem"
                    onClick={() => { setAddMenuOpen(false); onNavigate && onNavigate('add-cards'); }}
                    style={ADD_MENU_ITEM}
                  >
                    <Camera size={16} />
                    <span>{t('collection.addScan')}</span>
                  </button>
                  <button
                    role="menuitem"
                    disabled
                    title={t('collection.addImportSoon')}
                    style={{ ...ADD_MENU_ITEM, opacity: 0.5, cursor: 'not-allowed' }}
                  >
                    <Download size={16} />
                    <span>{t('collection.addImport')}</span>
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => { setAddMenuOpen(false); setShowFilters(true); }}
                    style={{ ...ADD_MENU_ITEM, borderBottom: 0 }}
                  >
                    <Search size={16} />
                    <span>{t('collection.addSearch')}</span>
                  </button>
                </div>
              </>
            )}
          </div>

          {/* View Toggle */}
          <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', padding: '2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
            <button
              className={`btn btn-icon-only ${viewMode === 'gallery' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setViewMode('gallery')}
              style={{ borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.5rem', width: '32px', height: '32px' }}
              title={t('collection.galleryView')}
            >
              <LayoutGrid size={14} />
            </button>
            <button
              className={`btn btn-icon-only ${viewMode === 'list' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setViewMode('list')}
              style={{ borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.5rem', width: '32px', height: '32px' }}
              title={t('collection.listView')}
            >
              <List size={14} />
            </button>
            {/* STORAGE AS A THIRD VIEW OF THE COLLECTION.
                Storage lost its nav tab when the bar went from eight
                destinations to four. Zach chose this over keeping it as a fifth
                tab: it is a VIEW of the collection -- where the cards
                physically are -- not a separate place.

                It sits in the existing view toggle rather than as a link
                elsewhere, because that is already the control that answers "how
                do I want to look at my cards", and a second navigation idiom
                for the same question is how a control ends up unfindable.

                THIS IS THE ONLY GENERAL WAY IN NOW. The pre-existing
                onNavigate('storage') call fires only from a single card's
                "where is this?" action, so without this button a user who had
                not already picked a card could not reach 15 compartments of
                real data. Removing a tab without adding the replacement is
                exactly how four controls became unreachable this week. */}
            <button
              className="btn btn-icon-only btn-secondary"
              onClick={() => onNavigate && onNavigate('storage')}
              style={{ borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.5rem', width: '32px', height: '32px' }}
              title={t('nav.storage')}
              aria-label={t('nav.storage')}
            >
              <MapPin size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Filter Panel */}
      <div className="glass-panel" style={{ marginBottom: '1.5rem', padding: '1rem 1.25rem' }}>
        {/* Always-visible top bar: search + sort + filters toggle */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2.5fr) minmax(150px, 1fr) auto', gap: '0.75rem', alignItems: 'flex-end' }}>
          <Field label={t('collection.searchLabel')}>
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                className="input-control"
                placeholder={t('collection.searchPlaceholder')}
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                style={{ width: '100%', paddingLeft: '2.5rem' }}
              />
              <Search size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            </div>
          </Field>

          <Field label={t('collection.sortBy')}>
            <select className="select-control" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              {['added-newest', 'added-oldest', 'name-asc', 'name-desc', 'price-desc', 'price-asc', 'qty-desc', 'set-asc', 'number-asc', 'type-asc', 'rarity-desc', 'rarity-asc', 'favorite-first']
                .map(key => <option key={key} value={key}>{t(`collection.sort.${key}`)}</option>)}
            </select>
          </Field>

          <button
            className={`btn ${showFilters ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setShowFilters(s => !s)}
            style={{ padding: '0.5rem 0.9rem', height: '40px', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}
          >
            <SlidersHorizontal size={15} />
            {t('collection.filters')}
            {activeFilterCount > 0 && (
              <span style={{ background: 'var(--accent-red)', color: 'var(--text-strong)', fontSize: '0.65rem', fontWeight: 900, borderRadius: '999px', padding: '1px 7px', minWidth: '18px', textAlign: 'center' }}>
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {showFilters && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border-glass)' }}>
            {/* Selector filters grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.75rem' }}>


              <Field label={t('collection.fLocation')}>
                <select className="select-control" value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)}>
                  <option value="">{t('collection.allLocations')}</option>
                  <option value="unassigned">{t('bulk.unassignedPile')}</option>
                  {locations.map(loc => (
                    <option key={loc.id} value={loc.id}>{loc.name}</option>
                  ))}
                </select>
              </Field>

              <Field label={t('collection.fSet')}>
                <ChipRow
                  options={uniqueSets}
                  selected={setFilters}
                  onToggle={(v) => setSetFilters(toggleIn(setFilters, v))}
                />
              </Field>

              <Field label={t('collection.fSupertype')}>
                <select className="select-control" value={supertypeFilter} onChange={(e) => setSupertypeFilter(e.target.value)}>
                  <option value="">{t('collection.allSupertypes')}</option>
                  {uniqueSupertypes.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>

              {/* COLOUR IDENTITY as WUBRG pips, not a dropdown. Players read
                  colour as pips, and five fit where one dropdown would go.
                  Multi-select with ANY-OF semantics: tapping B and G shows
                  black, green AND Golgari cards, which is what two taps mean. */}
              <Field label={t('collection.fColor')}>
                <div style={{ display: 'flex', gap: '0.35rem' }}>
                  {MTG_COLORS.map(({ code, label, token }) => {
                    const on = colorFilters.has(label);
                    return (
                      <button
                        key={code} type="button" aria-pressed={on}
                        title={label} aria-label={label}
                        onClick={() => setColorFilters(toggleIn(colorFilters, label))}
                        style={{
                          width: 34, height: 34, minHeight: 34, borderRadius: '50%',
                          border: on ? '2px solid var(--text-primary)' : '2px solid var(--surface-2)',
                          background: on ? token : 'var(--surface-1)',
                          color: on ? '#1a1a1a' : 'var(--text-muted)',
                          fontWeight: 800, fontSize: '0.8rem', cursor: 'pointer',
                          padding: 0, transition: 'var(--transition-smooth)',
                        }}
                      >
                        {code}
                      </button>
                    );
                  })}
                </div>
              </Field>

              <Field label={t('collection.fType')}>
                <ChipRow
                  options={uniqueTypes}
                  selected={typeFilters}
                  onToggle={(v) => setTypeFilters(toggleIn(typeFilters, v))}
                />
              </Field>

              <Field label={t('collection.fRarity')}>
                <select className="select-control" value={rarityFilter} onChange={(e) => setRarityFilter(e.target.value)}>
                  <option value="">{t('collection.allRarities')}</option>
                  {uniqueRarities.map(rarity => (
                    <option key={rarity} value={rarity}>{rarity}</option>
                  ))}
                </select>
              </Field>

              <Field label={t('card.condition')}>
                <select className="select-control" value={conditionFilter} onChange={(e) => setConditionFilter(e.target.value)}>
                  <option value="">{t('collection.allConditions')}</option>
                  {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>

              <Field label={t('card.printing')}>
                <select className="select-control" value={printingFilter} onChange={(e) => setPrintingFilter(e.target.value)}>
                  <option value="">{t('collection.allPrintings')}</option>
                  {PRINTINGS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>

              {uniqueCmcs.length > 0 && (
                <Field label={t('collection.fManaValue')}>
                  <select className="select-control" value={cmcFilter} onChange={(e) => setCmcFilter(e.target.value)}>
                    <option value="">{t('collection.allManaValues')}</option>
                    {uniqueCmcs.map(c => <option key={c} value={String(c)}>{c}</option>)}
                  </select>
                </Field>
              )}



              <Field label={t('collection.fMinPrice')}>
                <input type="number" className="input-control" placeholder={t('collection.minPricePlaceholder')} value={minPriceFilter} onChange={(e) => setMinPriceFilter(e.target.value)} />
              </Field>

              <Field label={t('collection.fMaxPrice')}>
                <input type="number" className="input-control" placeholder={t('collection.maxPricePlaceholder')} value={maxPriceFilter} onChange={(e) => setMaxPriceFilter(e.target.value)} />
              </Field>
            </div>

            {/* Options row: stacking + trade + clear */}
            <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--border-glass)', paddingTop: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" id="stackCardsOpt" checked={stackCards} onChange={(e) => setStackCards(e.target.checked)} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                <label htmlFor="stackCardsOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)' }}>
                  {t('collection.stackDuplicates')}
                </label>
              </div>

              {stackCards && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input type="checkbox" id="stackByConditionOpt" checked={stackByCondition} onChange={(e) => setStackByCondition(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                    <label htmlFor="stackByConditionOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {t('collection.splitByCondition')}
                    </label>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input type="checkbox" id="stackByPrintingOpt" checked={stackByPrinting} onChange={(e) => setStackByPrinting(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                    <label htmlFor="stackByPrintingOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {t('collection.splitByPrinting')}
                    </label>
                  </div>
                </>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" id="tradeOnlyOpt" checked={tradeOnly} onChange={(e) => setTradeOnly(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                <label htmlFor="tradeOnlyOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--accent-yellow)', fontWeight: 600 }}>
                  {t('collection.tradeOnly')}
                </label>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="checkbox" id="favoriteOnlyOpt" checked={favoriteOnly} onChange={(e) => setFavoriteOnly(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                <label htmlFor="favoriteOnlyOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: '#facc15', fontWeight: 600 }}>
                  {t('collection.favoritesOnly')}
                </label>
              </div>

              {activeFilterCount > 0 && (
                <button className="btn btn-secondary" onClick={clearAllFilters} style={{ marginLeft: 'auto', fontSize: '0.72rem', padding: '0.3rem 0.7rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                  <X size={13} /> {t('collection.clearFilters')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Result summary bar */}
      {!loading && !selectMode && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem', fontSize: '0.78rem', color: 'var(--text-secondary)', flexWrap: 'wrap', gap: '0.5rem' }}>
          <span><strong style={{ color: 'var(--text-strong)' }}>{displayCards.length}</strong> {t('collection.cardUnit', { count: displayCards.length })}</span>
          <span>{t('collection.totalValue')} <strong style={{ color: 'var(--accent-yellow)' }}>${formatPrice(totalValue)}</strong></span>
        </div>
      )}

      {/* Bulk action bar */}
      {selectMode && (
        <div className="glass-panel" style={{ marginBottom: '1rem', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', position: 'sticky', top: '0.5rem', zIndex: 30 }}>
          <span style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: '0.85rem' }}>{t('bulk.selected', { count: selectedIds.size })}</span>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} onClick={() => setSelectedIds(new Set(filteredCollection.map(i => i.entry_id)))}>{t('bulk.selectAll', { count: filteredCollection.length })}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} onClick={clearSelection}>{t('bulk.clear')}</button>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <button className="btn btn-danger" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('delete', null, t('bulk.confirmDelete', { count: selectedIds.size }))}>{t('bulk.delete')}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('trade', null)}>{t('bulk.markTrade')}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('untrade', null)}>{t('bulk.untrade')}</button>
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!selectedIds.size} onClick={() => runBulk('list_type', subTab === 'wishlist' ? 'collection' : 'wishlist', null)}>{t(subTab === 'wishlist' ? 'bulk.moveToCollection' : 'bulk.moveToWishlist')}</button>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <select className="select-control" value="" disabled={!selectedIds.size} onChange={(e) => { if (e.target.value) runBulk('condition', e.target.value); e.target.value = ''; }} style={{ fontSize: '0.72rem', maxWidth: '150px', padding: '0.3rem 0.4rem' }}>
            <option value="">{t('bulk.setCondition')}</option>
            {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="select-control" value="" disabled={!selectedIds.size} onChange={(e) => { if (e.target.value) runBulk('printing', e.target.value); e.target.value = ''; }} style={{ fontSize: '0.72rem', maxWidth: '150px', padding: '0.3rem 0.4rem' }}>
            <option value="">{t('bulk.setPrinting')}</option>
            {PRINTINGS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <PackPriceSplitter
            entryIds={Array.from(selectedIds)}
            showToast={showToast}
            onApplied={() => { clearSelection(); onUpdate(); fetchCollection(); }}
          />
          <select className="select-control" value={bulkMoveTarget} onChange={(e) => setBulkMoveTarget(e.target.value)} style={{ fontSize: '0.72rem', maxWidth: '170px', padding: '0.3rem 0.4rem' }}>
            <option value="">{t('bulk.moveToContainer')}</option>
            <option value="unassign">{t('bulk.unassignedPile')}</option>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <button className="btn btn-primary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!bulkMoveTarget || !selectedIds.size} onClick={() => runBulk('move', bulkMoveTarget === 'unassign' ? null : bulkMoveTarget)}>{t('bulk.applyMove')}</button>
          <div style={{ width: '1px', height: '22px', background: 'var(--border-glass)' }} />
          <AddToDeckSelect
            onAdd={(id) => runBulk('add_to_deck', id)}
            disabled={!selectedIds.size}
            style={{ fontSize: '0.72rem', maxWidth: '160px', padding: '0.3rem 0.4rem' }}
          />
          <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem', marginLeft: 'auto' }} onClick={exitSelectMode}>{t('bulk.done')}</button>
        </div>
      )}

      {loading ? (
        <div className="spinner"></div>
      ) : displayCards.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '3rem 1.5rem' }}>
          <p>{t('collection.noMatches')} {t(activeFilterCount > 0 ? 'collection.noMatchesFiltered' : 'collection.noMatchesEmpty')}</p>
        </div>
      ) : viewMode === 'gallery' ? (
        /* Visual Cards Grid Gallery View.
           The tile itself now lives in CardTile.jsx and is shared with the
           deck's Grid view, so the same card cannot look like two different
           cards depending on which screen you opened. The markup moved
           unchanged; what this screen passes in is what it always showed. */
        <div className="card-grid">
          {displayCards.map((item) => {
            const selected = selectedIds.has(item.entry_id);

            return (
              <CardTile
                key={item.entry_id}
                card={item}
                selected={selected}
                selectMode={selectMode}
                conditionLabel={
                  item.condition === 'Near Mint' ? 'NM' :
                    item.condition === 'Lightly Played' ? 'LP' :
                      item.condition === 'Moderately Played' ? 'MP' :
                        item.condition === 'Heavily Played' ? 'HP' : 'DMG'
                }
                onClick={(e) => activateCard(item, e)}
                pressHandlers={pressHandlers(item.entry_id)}
              />
            );
          })}
        </div>
      ) : (
        /* Traditional List Table View */
        <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowY: 'auto' }}>
            <table className="collection-table" style={{ minWidth: 0 }}>
              <thead>
                <tr>
                  <th>{t('collection.colCard')}</th>
                  <th style={{ width: '70px', textAlign: 'right' }}>{t('collection.colQtyValue')}</th>
                </tr>
              </thead>
              <tbody>
                {displayCards.map((item) => {
                  const selected = selectedIds.has(item.entry_id);
                  return (
                  <tr key={item.entry_id} style={selected ? { background: 'rgba(255,71,71,0.12)' } : undefined}>
                    <td>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        {selectMode && (
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleSelect(item.entry_id)}
                            style={{ width: '18px', height: '18px', flexShrink: 0, cursor: 'pointer' }}
                          />
                        )}
                        <div
                          onClick={(e) => activateCard(item, e)}
                          {...pressHandlers(item.entry_id)}
                          style={{ position: 'relative', width: '36px', height: '50px', flexShrink: 0, overflow: 'hidden', borderRadius: '4px', cursor: 'pointer', touchAction: 'pan-y', ...getCardRarityBorder(item.rarity) }}
                        >
                          <img src={item.image_url} alt={item.name} className="collection-row-thumbnail" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '4px' }} draggable={false} />
                          {getFoilOverlayClass(item.printing) && (
                            <div className={getFoilOverlayClass(item.printing)} style={{ borderRadius: '4px' }} />
                          )}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div onClick={(e) => activateCard(item, e)} {...pressHandlers(item.entry_id)} style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}>{item.name}</div>
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                            <span>{item.set_name} • #{item.number}</span>
                            <span style={{ fontSize: '0.55rem', fontWeight: 800, padding: '1px 3px', borderRadius: '3px', flexShrink: 0, ...getRarityBadgeStyle(item.rarity) }}>
                              {getRarityBadgeLabel(item.rarity)}
                            </span>
                          </div>
                          <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                            {item.printing} • {item.condition}
                          </div>
                          {!selectMode && (
                            <div style={{ display: 'flex', gap: '0.35rem', marginTop: '2px' }}>
                              <button className="btn btn-secondary btn-icon-only" style={{ width: '18px', height: '18px', padding: 0, borderRadius: '3px' }} onClick={() => openEdit(item)} title={t('common.edit')}>
                                <Edit2 size={9} />
                              </button>
                              <button className="btn btn-danger btn-icon-only" style={{ width: '18px', height: '18px', padding: 0, borderRadius: '3px' }} onClick={() => handleDelete(item.entry_id, item.name)} title={t('common.delete')}>
                                <Trash2 size={9} />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', verticalAlign: 'top', paddingTop: '0.6rem' }}>
                      {item.quantity > 1 && (
                        <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.85rem' }}>x{item.quantity}</div>
                      )}
                      <div style={{ fontSize: '0.7rem', color: 'var(--accent-yellow)', fontWeight: 600 }}>${formatPrice(item.price_trend)}</div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Card Detail Inspector Modal (Private Authorized View) */}
      <CardInspectorModal
        card={inspectorCard}
        startInEdit={inspectorStartEdit}
        onClose={() => { setInspectorCard(null); setInspectorStartEdit(false); }}
        onUpdate={onUpdate}
        showToast={showToast}
        onViewStorage={handleViewStorage}
      />
    </div>
  );
}

export default CollectionList;
