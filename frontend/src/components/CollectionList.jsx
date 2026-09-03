// COLLECTION — rebuilt against the approved mockup (sketches/001-quiet-canvas).
//
// This is a REWRITE, not a restyle. The previous version was ~900 lines because
// it carried features Zach has now cut: Collection/Wishlist sub-tabs, a select
// mode whose purpose was never finished, card stacking options, and a
// collapsible panel of nine dropdown filters.
//
// Zach, after seeing the restyled version on dev:
//   "this is rough. The filtering is horrible. I want how you had it in the
//    mock with the chips... The top part is horrible as well. Wishlist can be
//    deleted... Right now what does the select do can we build a deck from it
//    doesn't seem flushed out can remove it for now."
//
// He was right, and the reason the restyle failed is worth stating: editing the
// old screen toward the mock kept every existing control and added the new
// ones on top. The mock's value is what it LEAVES OUT.
//
// WHAT SURVIVES: search, colour pips, types, sets, sort, grid/list, storage.
// WHAT IS GONE: wishlist, select mode, stacking, and the filters with no home
// in the mock -- location, rarity, condition, printing, supertype, CMC, price
// range, trade-only, favourites-only. Removed, not hidden. If any is wanted
// back it returns as a sheet in the filter row, matching the others.

import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Search, X, LayoutGrid, List, MapPin, Plus, Camera, Download, ChevronDown, Check, ArrowUpDown,
} from 'lucide-react';
import { formatPrice } from '../utils/formatPrice';
import { sortCardsByOrder } from '../utils/cardSort';
import { useT } from '../utils/i18n';
import { Z_BACKDROP, Z_MODAL } from '../utils/zLayers';
import CardInspectorModal from './CardInspectorModal';
import ImportModal from './ImportModal';
import { useMultiSelect } from '../utils/useMultiSelect';
import CardTile from './CardTile';

// The five MTG colours in WUBRG order -- the order every player and every deck
// list uses. `label` is what the API stores in color_identity ("Blue"); `code`
// is the pip glyph; `token` is the muted fill from index.css.
const MTG_COLORS = [
  { code: 'W', label: 'White', token: 'var(--mtg-white)' },
  { code: 'U', label: 'Blue',  token: 'var(--mtg-blue)' },
  { code: 'B', label: 'Black', token: 'var(--mtg-black)' },
  { code: 'R', label: 'Red',   token: 'var(--mtg-red)' },
  { code: 'G', label: 'Green', token: 'var(--mtg-green)' },
];

// Sort orders. Keys are
// the ones sortCardsByOrder actually understands -- 'price-desc', not
// 'value-desc'. An unknown key silently falls back to added-newest, so a typo
// here would make Sort look functional while doing nothing.
const SORT_CRITERIA = {
  'added-newest': [{ by: 'added_at', dir: 'desc' }, { by: 'entry_id', dir: 'desc' }],
  'name-asc': [{ by: 'name', dir: 'asc' }],
  'name-desc': [{ by: 'name', dir: 'desc' }],
  'price-desc': [{ by: 'price', dir: 'desc' }],
  'price-asc': [{ by: 'price', dir: 'asc' }],
  'set-asc': [{ by: 'set', dir: 'asc' }, { by: 'number', dir: 'asc' }],
  'rarity-desc': [{ by: 'rarity', dir: 'desc' }, { by: 'name', dir: 'asc' }],
};

const SORT_OPTIONS = Object.keys(SORT_CRITERIA);

// Returns a NEW Set with `value` toggled. New, not mutated: React compares by
// reference, so mutating would change the filter without re-rendering and the
// grid would silently disagree with its own controls.
function toggleIn(set, value) {
  const next = new Set(set);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
}

const SHEET_ROW = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  width: '100%', minHeight: 48, padding: '0 0.9rem', border: 0,
  background: 'transparent', font: 'inherit', fontSize: '0.95rem',
  textAlign: 'left', cursor: 'pointer', color: 'var(--text-primary)',
};

const MENU_ITEM = {
  display: 'flex', alignItems: 'center', gap: '0.7rem', width: '100%',
  padding: '0.8rem 0.9rem', minHeight: 52, border: 0,
  borderBottom: '1px solid var(--border-glass)', background: 'transparent',
  color: 'var(--text-primary)', font: 'inherit', fontSize: '0.92rem',
  textAlign: 'left', cursor: 'pointer',
};

const MENU_SUB = {
  display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)',
  fontWeight: 400, marginTop: 1,
};

// A filter button that opens a sheet. Shows a COUNT when active rather than
// only changing colour -- "Types" and "Types 2" answer different questions, and
// the selected state has to survive being glanced at in sunlight.
function DropButton({ label, count, onClick }) {
  const on = count > 0;
  return (
    <button
      type="button" onClick={onClick} aria-pressed={on}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0,
        minHeight: 34, padding: '0 0.75rem', borderRadius: 'var(--radius-sm)',
        border: `1px solid ${on ? 'var(--accent-blue)' : 'var(--border-glass)'}`,
        background: on ? 'var(--accent-blue)' : 'var(--surface-1)',
        color: on ? 'var(--text-on-accent)' : 'var(--text-secondary)',
        font: 'inherit', fontSize: '0.82rem', fontWeight: on ? 600 : 500,
        whiteSpace: 'nowrap', cursor: 'pointer', transition: 'var(--transition-smooth)',
      }}
    >
      {label}{on ? ` ${count}` : ''}
      <ChevronDown size={12} strokeWidth={3} />
    </button>
  );
}

// The card types this app filters on, read from type_line.
//
// NOT from `types` -- that column holds COLOURS in this database, so using it
// made the Types sheet a second colour picker. Everything before the em dash in
// a type_line is the card type(s) plus supertypes ("Legendary Creature");
// everything after is subtypes ("Goblin Berserker"), which would flood a filter
// list with hundreds of entries.
const CARD_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant',
                    'Land', 'Planeswalker', 'Sorcery'];

// Shared sizing for the bulk bar's controls, so a stray padding value cannot
// make one button a different height from its neighbours.
const BULK_BTN = { fontSize: '0.72rem', padding: '0.3rem 0.6rem' };

function CollectionList({ statsTrigger, onUpdate, showToast, onNavigate, setSelectedLocationId, setFocusEntryId }) {
  const { t } = useT();

  const [collection, setCollection] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('gallery');
  const [inspectorCard, setInspectorCard] = useState(null);

  const [searchFilter, setSearchFilter] = useState('');
  const [colorFilters, setColorFilters] = useState(() => new Set());
  const [typeFilters, setTypeFilters] = useState(() => new Set());
  const [setFilters, setSetFilters] = useState(() => new Set());
  const [sortBy, setSortBy] = useState('added-newest');

  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [bulkLocation, setBulkLocation] = useState('');
  const [locations, setLocations] = useState([]);
  const [lastDelete, setLastDelete] = useState(null);   // { batchId, count }

  // SELECT MODE. The same hook three other screens use, so the interaction is
  // identical wherever cards are selected rather than a second one invented
  // for this screen.
  const {
    selectMode, setSelectMode, selectedIds, setSelectedIds, selectAt,
    clearSelection, exitSelectMode, pressHandlers, longPressFired, runBulk,
  } = useMultiSelect({
    showToast,
    onChanged: ({ action, batchId, ids, data }) => {
      // A delete comes back with a batch id; hold it so the toast can offer an
      // undo. Anything else just refreshes.
      // The count comes from the RESPONSE. Reading selectedIds here would give
      // 0: runBulk clears the selection before calling back.
      if (action === 'delete' && batchId) {
        setLastDelete({ batchId, count: data?.affected ?? ids.length });
      }
      onUpdate && onUpdate();
    },
  });
  // Which bottom sheet is open: 'type' | 'set' | 'sort' | null. One piece of
  // state for all three, so two sheets can never be open at once.
  const [sheet, setSheet] = useState(null);
  // Focused by the add menu's "Search for a card".
  const searchRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch('/api/collection?list_type=collection');
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (!cancelled) setCollection(data);
      } catch {
        if (!cancelled) showToast(t('collection.errLoad'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsTrigger]);

  // Storage locations for the bulk move. Fetched once: the list is short and
  // changes rarely, and re-fetching per selection would put a request behind
  // every tap.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/locations');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setLocations(Array.isArray(data) ? data : []);
      } catch { /* the dropdown just stays empty */ }
    })();
    return () => { cancelled = true; };
  }, []);

// The types on a card, from the front of its type line.
//
// Module scope, like CARD_TYPES: it reads nothing but its argument, so a fresh
// identity every render is noise -- and inside the component it made
// uniqueTypes' dependency list "incomplete", where listing it would have
// defeated the memo (new function each render = recompute each render).
const cardTypesOf = (card) => {
  const line = (card.type_line || '').split('—')[0];
  return CARD_TYPES.filter(ty => line.includes(ty));
};

  const uniqueTypes = useMemo(() => {
    const found = new Set();
    for (const c of collection) for (const ty of cardTypesOf(c)) found.add(ty);
    return CARD_TYPES.filter(ty => found.has(ty));
    // No suppression needed: CARD_TYPES and cardTypesOf are module scope now,
    // so `collection` really is the only dependency. The disable comment that
    // used to sit here was hiding the warning rather than answering it.
  }, [collection]);

  const uniqueSets = useMemo(
    () => Array.from(new Set(collection.map(c => c.set_name).filter(Boolean))).sort(),
    [collection]);

  const shown = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    const out = collection.filter(item => {
      // NAME ONLY. Set has its own filter, and matching set names here meant
      // typing a set returned every card in it -- drowning the card actually
      // being looked for.
      const matchesSearch = !q || item.name.toLowerCase().includes(q);

      // ANY-OF for every multi-select. Tapping B and G shows black cards, green
      // cards AND Golgari cards -- what a player means by two taps. ALL-OF
      // would return almost nothing and read as a broken filter.
      // AT LEAST these colours: every selected colour must be present in the
      // card's identity. Selecting U+G+R shows Temur and anything containing
      // Temur, but not mono-blue. Selecting U alone shows every card needing
      // blue, whatever else it needs.
      const identity = item.color_identity || [];
      const matchesColor = colorFilters.size === 0
        || [...colorFilters].every(c => identity.includes(c));
      // AT LEAST these types, matching the colour rule. Selecting Artifact +
      // Creature shows Artifact Creatures -- not every artifact plus every
      // creature. Selecting more always narrows, which is what a filter row
      // full of chips implies.
      const cardTypes = cardTypesOf(item);
      const matchesType = typeFilters.size === 0
        || [...typeFilters].every(ty => cardTypes.includes(ty));
      const matchesSet = setFilters.size === 0 || setFilters.has(item.set_name);

      return matchesSearch && matchesColor && matchesType && matchesSet;
    });

    // Collapse identical copies into one tile. Key on what makes a copy
    // genuinely different -- exact printing, condition, finish -- so a foil or
    // a played copy stays separate rather than being silently merged into a
    // count that misreports what he owns.
    const groups = new Map();
    for (const card of out) {
      const key = [card.card_id, card.condition || '', card.printing || ''].join('|');
      const seen = groups.get(key);
      if (seen) {
        seen.quantity = (seen.quantity || 1) + (card.quantity || 1);
      } else {
        groups.set(key, { ...card, quantity: card.quantity || 1 });
      }
    }
    const grouped = [...groups.values()];

    sortCardsByOrder(grouped, SORT_CRITERIA[sortBy] || SORT_CRITERIA['added-newest']);
    return grouped;
  }, [collection, searchFilter, colorFilters, typeFilters, setFilters, sortBy]);

  const totalValue = useMemo(
    () => shown.reduce((sum, c) => sum + (c.price_trend || 0) * (c.quantity || 1), 0),
    [shown]);

  const activeFilters = colorFilters.size + typeFilters.size + setFilters.size;

  const openStorage = () => onNavigate && onNavigate('storage');

  const sheetTitle = sheet === 'type' ? t('collection.types')
    : sheet === 'set' ? t('collection.sets')
    : t('collection.sortBy');

  return (
    <div>
      {/* HEADER: title, live count, one "+" on the right -- as in the mock. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.9rem' }}>
        <h2 style={{ fontSize: '1.6rem', fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}>
          {t('nav.collection')}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <div style={{ position: 'relative' }}>
            {/* SELECT. Long-press also arms select mode, but a hidden gesture is
                not a discoverable feature, and on a phone it competes with the
                browser's own text selection. The other three screens that use this
                hook all pair the gesture with an explicit button. */}
            <button
              className={`btn ${selectMode ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
              style={{ fontSize: '0.8rem', padding: '0.4rem 0.7rem' }}
            >
              {t(selectMode ? 'bulk.done' : 'collection.select')}
            </button>

            <button
              onClick={() => setAddMenuOpen(o => !o)}
              aria-expanded={addMenuOpen} aria-haspopup="menu"
              aria-label={t('collection.addCards')}
              style={{
                width: 34, height: 34, borderRadius: '50%', border: 0, cursor: 'pointer',
                display: 'grid', placeItems: 'center', flexShrink: 0,
                background: addMenuOpen ? 'var(--accent-blue)' : 'var(--surface-2)',
                color: addMenuOpen ? 'var(--text-on-accent)' : 'var(--text-primary)',
                transition: 'var(--transition-smooth)',
              }}
            >
              <Plus size={19} />
            </button>

            {addMenuOpen && (
              <>
                {/* Full-screen catcher: on a phone there is no Escape key and
                    no click-outside for free. */}
                <div onClick={() => setAddMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
                <div role="menu" style={{
                  position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 91,
                  minWidth: 252, background: 'var(--surface-2)',
                  border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-md)',
                  overflow: 'hidden', boxShadow: '0 12px 34px rgba(0,0,0,.6)',
                }}>
                  <button role="menuitem" style={MENU_ITEM}
                          onClick={() => { setAddMenuOpen(false); onNavigate && onNavigate('add-cards'); }}>
                    <Camera size={18} />
                    <span>{t('collection.addCardsAction')}<small style={MENU_SUB}>{t('collection.addCardsActionSub')}</small></span>
                  </button>
                  {/* Import is SHOWN but disabled until Feature 3. A control
                      that materialises later is a surprise; a disabled one that
                      says when it is coming is an answer. */}
                  {/* No longer "coming soon": the importer exists, behind the
                      Scryfall validation the 501 stub was waiting for. */}
                  <button role="menuitem"
                          onClick={() => { setAddMenuOpen(false); setImportOpen(true); }}
                          style={{ ...MENU_ITEM, borderBottom: 0 }}>
                    <Download size={18} />
                    <span>{t('collection.addImport')}<small style={MENU_SUB}>{t('collection.addImportSub')}</small></span>
                  </button>
                  
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* SEARCH: full width, icon inside. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.7rem' }}>
      <label style={{
        display: 'flex', alignItems: 'center', gap: '0.55rem', flex: 1, minWidth: 0,
        background: 'var(--surface-1)', border: '1px solid var(--border-glass)',
        borderRadius: 'var(--radius-md)', padding: '0 0.85rem', height: 44,
      }}>
        <Search size={17} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input
          ref={searchRef}
          value={searchFilter}
          onChange={e => setSearchFilter(e.target.value)}
          placeholder={t('collection.searchPlaceholder')}
          style={{ border: 0, outline: 'none', background: 'transparent', flex: 1, color: 'var(--text-primary)', font: 'inherit', fontSize: '0.95rem' }}
        />
        {searchFilter && (
          <button onClick={() => setSearchFilter('')} aria-label={t('common.close')}
                  style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>
            <X size={15} />
          </button>
        )}
      </label>

        {/* Sort sits WITH the search, not in the filter row: it is always in
            effect, whereas a filter may not be. Icon-only to keep the search
            box wide on a phone; the sheet names the current order. */}
        <button
          onClick={() => setSheet('sort')}
          title={t('collection.sortBy')}
          aria-label={t('collection.sortBy')}
          style={{
            width: 44, height: 44, flexShrink: 0, borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-glass)', background: 'var(--surface-1)',
            color: 'var(--text-secondary)', display: 'grid', placeItems: 'center',
            cursor: 'pointer',
          }}
        >
          <ArrowUpDown size={17} />
        </button>
      </div>

      {/* FILTER ROW: pips, then Types / Sets / Sort, then Clear. One scrolling
          line -- not a collapsible panel. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', overflowX: 'auto', paddingBottom: '0.3rem', marginBottom: '0.75rem' }}>
        {MTG_COLORS.map(({ code, label, token }) => {
          const on = colorFilters.has(label);
          return (
            <button
              key={code} type="button" aria-pressed={on} title={label} aria-label={label}
              onClick={() => setColorFilters(toggleIn(colorFilters, label))}
              style={{
                width: 34, height: 34, minWidth: 34, borderRadius: '50%', flexShrink: 0,
                border: on ? '2px solid var(--text-primary)' : '1px solid var(--border-glass)',
                background: on ? token : 'var(--surface-1)',
                color: on ? '#1a1a1a' : 'var(--text-muted)',
                fontWeight: 800, fontSize: '0.8rem', cursor: 'pointer', padding: 0,
                transition: 'var(--transition-smooth)',
              }}
            >
              {code}
            </button>
          );
        })}
        <DropButton label={t('collection.types')} count={typeFilters.size} onClick={() => setSheet('type')} />
        <DropButton label={t('collection.sets')} count={setFilters.size} onClick={() => setSheet('set')} />
        {activeFilters > 0 && (
          <button
            onClick={() => { setColorFilters(new Set()); setTypeFilters(new Set()); setSetFilters(new Set()); }}
            style={{ flexShrink: 0, minHeight: 34, padding: '0 0.8rem', border: 0, background: 'transparent', color: 'var(--accent-blue)', font: 'inherit', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer' }}
          >
            {t('collection.clearFilters')}
          </button>
        )}
      </div>

      {/* VIEW SWITCH: small and secondary, under the filters. It changes how the
          same cards are DRAWN, so it does not belong beside the controls that
          change WHICH cards are shown. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.8rem' }}>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          {t('collection.totalValue')} <strong style={{ color: 'var(--text-primary)' }}>${formatPrice(totalValue)}</strong>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          {[{ m: 'gallery', Icon: LayoutGrid, label: t('collection.galleryView') },
            { m: 'list', Icon: List, label: t('collection.listView') }].map(({ m, Icon, label }) => (
            <button
              key={m} onClick={() => setViewMode(m)} title={label} aria-label={label}
              aria-pressed={viewMode === m}
              style={{
                width: 32, height: 32, borderRadius: 'var(--radius-sm)', border: 0, cursor: 'pointer',
                display: 'grid', placeItems: 'center',
                background: viewMode === m ? 'var(--surface-3)' : 'transparent',
                color: viewMode === m ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              <Icon size={15} />
            </button>
          ))}
          {/* STORAGE. It lost its nav tab when the bar went to four
              destinations; this is its only general entry point, so removing it
              makes 15 compartments of real data unreachable. */}
          <button onClick={openStorage} title={t('nav.storage')} aria-label={t('nav.storage')}
                  style={{ width: 32, height: 32, borderRadius: 'var(--radius-sm)', border: 0, cursor: 'pointer', display: 'grid', placeItems: 'center', background: 'transparent', color: 'var(--text-muted)' }}>
            <MapPin size={15} />
          </button>
        </div>
      </div>

      {/* CARDS */}
      {/* UNDO. The trash makes a delete recoverable; this makes the recovery
          REACHABLE. A banner, not a timed toast -- an undo you have to catch
          within three seconds is a worse guarantee than one that waits. */}
      {lastDelete && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap',
          background: 'rgba(248,113,113,0.10)',
          border: '1px solid rgba(248,113,113,0.28)',
          borderRadius: 'var(--radius-md)', padding: '0.65rem 0.9rem',
          marginBottom: '0.75rem'
        }}>
          <span style={{ flex: 1, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {t('bulk.deleted', { count: lastDelete.count })}
          </span>
          <button className="btn btn-secondary" style={BULK_BTN} onClick={async () => {
            try {
              const res = await fetch(
                `/api/collection/trash/${lastDelete.batchId}/restore`,
                { method: 'POST' });
              const data = await res.json().catch(() => ({}));
              if (!res.ok) {
                // Purged, or already restored. Saying so beats a silent no-op
                // that leaves him wondering where the cards went.
                showToast(data.error || t('bulk.undoFailed'));
                setLastDelete(null);
                return;
              }
              showToast(t('bulk.undone', { count: data.restored }));
              setLastDelete(null);
              onUpdate && onUpdate();
            } catch {
              showToast(t('bulk.undoFailed'));
            }
          }}>
            {t('bulk.undo')}
          </button>
          <button className="btn btn-secondary" style={BULK_BTN}
                  onClick={() => setLastDelete(null)}>
            {t('common.dismiss')}
          </button>
        </div>
      )}

      {/* SELECT MODE BAR.
          A sibling of the display chain, not a branch inside it: it sits above
          whichever state renders. My first attempt spliced it into the ternary
          and the build passed while the empty state stopped excluding the card
          list -- balanced braces are not correct structure. */}
      {selectMode && (
        <div className="glass-panel" style={{
          marginBottom: '0.75rem', padding: '0.7rem 0.9rem', display: 'flex',
          alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
          position: 'sticky', top: '0.5rem', zIndex: 30
        }}>
          <span style={{ fontWeight: 800, fontSize: '0.85rem', color: 'var(--text-strong)' }}>
            {t('bulk.selected', { count: selectedIds.size })}
          </span>

          {/* NAMES THE COUNT. Zach: "Select all should be on what's filtered."
              A bare "Select all" beside a filtered list could mean 47 or
              2,433, and the destructive action is the one where being wrong
              costs a recount against cardboard. */}
          <button className="btn btn-secondary" style={BULK_BTN}
                  onClick={() => setSelectedIds(new Set(shown.map(c => c.entry_id || c.id)))}>
            {t('bulk.selectAllShown', { count: shown.length })}
          </button>
          <button className="btn btn-secondary" style={BULK_BTN} onClick={clearSelection}>
            {t('bulk.clear')}
          </button>

          <div style={{ width: 1, height: 22, background: 'var(--border-glass)' }} />

          {/* MOVE -- non-destructive, and the case Zach led with:
              "if I'm trying to put 100 cards in a deck box". */}
          <select className="select-control" style={{ ...BULK_BTN, maxWidth: 170 }}
                  value={bulkLocation}
                  onChange={(e) => {
                    const v = e.target.value;
                    setBulkLocation('');
                    if (!v) return;
                    const name = locations.find(l => String(l.id) === v)?.name || '';
                    runBulk('move', v, t('bulk.confirmMove', {
                      count: selectedIds.size, location: name
                    }));
                  }}>
            <option value="">{t('bulk.moveTo')}</option>
            {locations.map(l => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>

          {/* DELETE -- recoverable, but still named. The confirm states the
              count, because "delete selected" hides how much that is. */}
          <button className="btn btn-danger" style={BULK_BTN}
                  disabled={selectedIds.size === 0}
                  onClick={() => runBulk('delete', null,
                    t('bulk.confirmDelete', { count: selectedIds.size }))}>
            {t('bulk.delete')}
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '2.5rem', color: 'var(--text-secondary)' }}>
          {t('common.loading')}
        </div>
      ) : shown.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2.5rem 1rem', color: 'var(--text-secondary)', background: 'var(--surface-1)', borderRadius: 'var(--radius-md)' }}>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.3rem' }}>
            {collection.length ? t('collection.noMatches') : t('dash.emptyTitle')}
          </div>
          <div style={{ fontSize: '0.85rem' }}>
            {collection.length ? t('collection.noMatchesHint') : t('dash.emptyBody')}
          </div>
        </div>
      ) : viewMode === 'gallery' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '0.7rem' }}>
          {shown.map(card => (
            <CardTile
              key={card.entry_id || card.id}
              card={card}
              selected={selectedIds.has(card.entry_id || card.id)}
              {...pressHandlers(card.entry_id || card.id)}
              onClick={(e) => {
                if (longPressFired.current) return;
                if (selectMode) {
                  selectAt(card.entry_id || card.id,
                           shown.map(c => c.entry_id || c.id), e?.shiftKey);
                  return;
                }
                setInspectorCard(card);
              }}
            />
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {shown.map(card => (
            <button
              key={card.entry_id || card.id}
              {...pressHandlers(card.entry_id || card.id)}
              onClick={(e) => {
                // A long press arms select mode and must NOT also open the
                // inspector when the finger lifts.
                if (longPressFired.current) return;
                if (selectMode) {
                  selectAt(card.entry_id || card.id,
                           shown.map(c => c.entry_id || c.id), e.shiftKey);
                  return;
                }
                setInspectorCard(card);
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.7rem', width: '100%',
                minHeight: 52, padding: '0.6rem 0.75rem', border: 0, textAlign: 'left',
                background: selectedIds.has(card.entry_id || card.id)
                  ? 'var(--accent-blue-soft, rgba(10,132,255,0.18))'
                  : 'var(--surface-1)',
                color: 'var(--text-primary)',
                borderRadius: 'var(--radius-md)', font: 'inherit', cursor: 'pointer',
                outline: selectedIds.has(card.entry_id || card.id)
                  ? '2px solid var(--accent-blue)' : 'none',
                outlineOffset: -2,
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 600, fontSize: '0.92rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {card.name}
                </span>
                <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  {(card.set_id || '').toUpperCase()}{card.number ? ` #${card.number}` : ''}
                </span>
              </span>
              {card.quantity > 1 && (
                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', flexShrink: 0 }}>
                  ×{card.quantity}
                </span>
              )}
              <span style={{ fontSize: '0.82rem', fontWeight: 600, flexShrink: 0 }}>
                ${formatPrice(card.price_trend || 0)}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* BOTTOM SHEET: one component serves Types, Sets and Sort so the three
          cannot drift apart. */}
      {sheet && (
        <>
          <div onClick={() => setSheet(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: Z_BACKDROP }} />
          <div style={{
            position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: Z_MODAL,
            background: 'var(--surface-1)', borderTopLeftRadius: 20, borderTopRightRadius: 20,
            maxHeight: '70vh', display: 'flex', flexDirection: 'column',
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          }}>
            <div style={{ width: 38, height: 4, borderRadius: 2, background: 'var(--surface-3)', margin: '10px auto 4px' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.4rem 1rem 0.6rem' }}>
              <b style={{ fontSize: '1rem' }}>{sheetTitle}</b>
              <button onClick={() => setSheet(null)}
                      style={{ border: 0, background: 'transparent', color: 'var(--accent-blue)', font: 'inherit', fontWeight: 600, cursor: 'pointer', minHeight: 44, padding: '0 0.4rem' }}>
                {t('common.close')}
              </button>
            </div>
            <div style={{ overflowY: 'auto', padding: '0 0.5rem 1rem' }}>
              {sheet === 'sort'
                ? SORT_OPTIONS.map(opt => (
                    <button key={opt} onClick={() => { setSortBy(opt); setSheet(null); }}
                            style={{ ...SHEET_ROW, color: sortBy === opt ? 'var(--accent-blue)' : 'var(--text-primary)' }}>
                      <span>{t(`collection.sort.${opt}`)}</span>
                      {sortBy === opt && <Check size={17} />}
                    </button>
                  ))
                : (sheet === 'type' ? uniqueTypes : uniqueSets).map(opt => {
                    const sel = sheet === 'type' ? typeFilters : setFilters;
                    const on = sel.has(opt);
                    return (
                      <button
                        key={opt}
                        onClick={() => (sheet === 'type'
                          ? setTypeFilters(toggleIn(typeFilters, opt))
                          : setSetFilters(toggleIn(setFilters, opt)))}
                        style={{ ...SHEET_ROW, color: on ? 'var(--accent-blue)' : 'var(--text-primary)' }}
                      >
                        <span>{opt}</span>
                        {on && <Check size={17} />}
                      </button>
                    );
                  })}
            </div>
          </div>
        </>
      )}

      {importOpen && (
        <ImportModal
          onClose={() => setImportOpen(false)}
          /* The list reloads from an effect keyed on statsTrigger, which the
             parent bumps via onUpdate -- there is no local fetch function to
             call. I invented fetchCollection() first; caught by the build. */
          onImported={() => onUpdate && onUpdate()}
          showToast={showToast}
        />
      )}

      {inspectorCard && (
        <CardInspectorModal
          card={inspectorCard}
          onClose={() => setInspectorCard(null)}
          onUpdate={() => { onUpdate && onUpdate(); }}
          showToast={showToast}
          setSelectedLocationId={setSelectedLocationId}
          setFocusEntryId={setFocusEntryId}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}

export default CollectionList;
