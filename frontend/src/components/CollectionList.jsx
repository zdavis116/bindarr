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

  // The card types in this collection, read from type_line.
  //
  // NOT from `types` -- that column holds COLOURS in this database, so using it
  // made the Types sheet a second colour picker. Everything before the em dash
  // in a type_line is the card type(s) plus supertypes ("Legendary Creature");
  // everything after is subtypes ("Goblin Berserker"), which would flood a
  // filter list with hundreds of entries.
  const CARD_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant',
                      'Land', 'Planeswalker', 'Sorcery'];

  const cardTypesOf = (card) => {
    const line = (card.type_line || '').split('—')[0];
    return CARD_TYPES.filter(ty => line.includes(ty));
  };

  const uniqueTypes = useMemo(() => {
    const found = new Set();
    for (const c of collection) for (const ty of cardTypesOf(c)) found.add(ty);
    return CARD_TYPES.filter(ty => found.has(ty));
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
                  <button role="menuitem" disabled title={t('collection.addImportSoon')}
                          style={{ ...MENU_ITEM, borderBottom: 0, opacity: 0.45, cursor: 'not-allowed' }}>
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
            <CardTile key={card.entry_id || card.id} card={card} onClick={() => setInspectorCard(card)} />
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {shown.map(card => (
            <button
              key={card.entry_id || card.id}
              onClick={() => setInspectorCard(card)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.7rem', width: '100%',
                minHeight: 52, padding: '0.6rem 0.75rem', border: 0, textAlign: 'left',
                background: 'var(--surface-1)', color: 'var(--text-primary)',
                borderRadius: 'var(--radius-md)', font: 'inherit', cursor: 'pointer',
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
