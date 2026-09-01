import { useState, useEffect, useRef } from 'react';
import { Z_MODAL } from '../utils/zLayers';
import { RefreshCw, X, MapPin, Trash2, Star, Maximize2, ExternalLink } from 'lucide-react';
import { formatPrice } from '../utils/formatPrice';
import { displayName, secondaryName } from '../utils/cardName';
import { tcgplayerUrl, cardmarketUrl, priceSource, noLinkReason } from '../utils/marketplaceLinks';
import CardImageZoom from './CardImageZoom';
import CardEntryFields from './CardEntryFields';
import PriceHistoryChart from './PriceHistoryChart';
import AddToDeckSelect from './AddToDeckSelect';
import { useBackGuard } from '../utils/useBackGuard';
import { useT } from '../utils/i18n';

// MTG color identity pip colors (WUBRG), approximating the printed mana colors.
const MTG_COLOR_BG = {
  White: '#f8f6d8', Blue: '#0e68ab', Black: '#2b2422', Red: '#d3202a', Green: '#00733e'
};
const MTG_COLOR_FG = {
  White: '#3a3520', Blue: '#fff', Black: '#fff', Red: '#fff', Green: '#fff'
};

function getSlotNumber(c) {
  if (!c) return null;
  if (c.slot != null) return c.slot;
  if (c.slot_number != null) return c.slot_number;
  if (c.__slotNumber != null) return c.__slotNumber;
  if (typeof c.position === 'number') {
    if (c.position >= 1000) return Math.floor(c.position / 1000);
    return Math.floor(c.position) + 1;
  }
  return null;
}

// Shared card detail popup used by Dashboard, CollectionList and LocationManager.
// Self-contained: owns its edit form (PUT) and delete (DELETE) so every screen
// gets the same rich view + edit without duplicating the form. onUpdate() lets
// the parent refetch after a change. onViewStorage is optional (hidden if absent).
function CardInspectorModal({ card, onClose, onUpdate, onDeleted, showToast, onViewStorage, startInEdit = false, readOnly = false }) {
  const { t } = useT();
  const [mode, setMode] = useState('view');
  const [locations, setLocations] = useState([]);
  const [q, setQ] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('nonfoil');
  const [purchasePrice, setPurchasePrice] = useState(0);
  const [locationId, setLocationId] = useState('');
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

  useEffect(() => {
    fetch('/api/locations')
      .then(r => r.ok ? r.json() : [])
      .then(setLocations)
      .catch(() => {});
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
    setLocationId(card.location_id || '');
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
  const deckFetchFor = useRef(null);

  useEffect(() => {
    // Fetched for BOTH tabs that need it. Still lazy: the Card tab is the
    // default and never triggers a request.
    if (tab !== 'decks' && tab !== 'yours') return;
    if (!card?.id || deckUse) return;
    if (deckFetchFor.current === card.id) return;

    deckFetchFor.current = card.id;
    let cancelled = false;
    setDeckUseLoading(true);
    // Routers mount at bare /api -- see server.js:250.
    fetch(`/api/card/${card.id}/decks`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d) setDeckUse(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setDeckUseLoading(false); });
    return () => { cancelled = true; };
  }, [tab, card?.id, deckUse]);

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
          purchase_price: parseFloat(purchasePrice) || 0,
          location_id: locationId ? parseInt(locationId, 10) : null,
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
        card.location_id = locationId ? parseInt(locationId, 10) : null;
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
      location_id: locationId ? parseInt(locationId, 10) : null,
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
    } catch (err) {
      console.error(err);
      showToast && showToast(t('inspector.errAddDeckGeneric'));
    }
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

  return (
    <div className="modal-overlay" style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.75)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: Z_MODAL
    }} onClick={handleClose}>
      <div className="glass-panel card-inspector" onClick={(e) => e.stopPropagation()}>
        <button className="btn btn-secondary btn-icon-only" onClick={handleClose} style={{
          position: 'absolute',
          top: '1rem',
          right: '1rem',
          borderRadius: '50%',
          zIndex: 10
        }}>
          <X size={16} />
        </button>

        {/* Left side: Main Card Image Focus */}
        <div className="ci-image-col" style={{ flex: '1 1 260px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div
            className="ci-image-wrap"
            onClick={() => setIsFullScreen(true)}
            title={t('inspector.zoomHint')}
            style={{ position: 'relative', width: '100%', maxWidth: '300px', cursor: 'pointer' }}
          >
            <img
              src={showBack && card.back_image_url ? card.back_image_url : card.image_url}
              alt={showBack && card.back_name ? card.back_name : card.name}
              style={{
                width: '100%',
                aspectRatio: 0.718,
                objectFit: 'cover',
                borderRadius: 'var(--radius-md)',
                boxShadow: '0 12px 36px rgba(0,0,0,0.6), 0 0 20px rgba(255,255,255,0.05)',
                transition: 'transform 0.2s ease'
              }}
            />
            {/* FLIP. Rendered only when there IS a second face -- a
                single-faced card must not grow a button that does nothing. */}
            {card.back_image_url && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setShowBack(v => !v); }}
                style={{
                  position: 'absolute', right: 10, bottom: 10,
                  display: 'flex', alignItems: 'center', gap: '0.35rem',
                  minHeight: 34, padding: '0 0.7rem',
                  borderRadius: 'var(--radius-md)', border: 0,
                  background: 'rgba(0,0,0,0.72)', color: '#fff',
                  font: 'inherit', fontSize: '0.78rem', fontWeight: 600,
                  cursor: 'pointer', zIndex: 2,
                }}
              >
                <RefreshCw size={13} />
                {showBack ? card.name : card.back_name}
              </button>
            )}
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
        <div className="ci-info-col" style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: '1.25rem', justifyContent: 'space-between' }}>
          <div>
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
              {displayName(card)}
            </h3>
            {secondaryName(card) && (
              <p style={{
                color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 500,
                marginBottom: '0.25rem',
              }}>
                {secondaryName(card)}
              </p>
            )}
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', fontWeight: 500 }}>
              {card.set_name}
              {cardNumber ? ` • #${cardNumber}` : ''}{card.rarity ? ` • ${card.rarity}` : ''} • {t('inspector.owned', { count: card.quantity ?? 1 })}
            </p>

            {/* THREE TABS. Each answers a different question, which is the
                only thing that justifies a tap: what the card IS, what you
                OWN, and which decks WANT it.

                No counts on the labels. Zach: "can remove the numbers from the
                tabs seems pointless". */}
            <div style={{
              display: 'flex', gap: 4, marginTop: '0.85rem', marginBottom: '0.85rem',
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

            {/* ============================ CARD TAB ============================
                What this thing is and what it does. Built from the mockup
                rather than from whatever the old layout left behind. */}
            {tab === 'card' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>

                {/* TYPE LINE, from type_line -- NOT from `subtypes`, which is
                    type_line split on non-letters and rejoined with spaces
                    (scryfallApi.js:220). For a double-faced card that welds
                    both faces together and drops every separator, which is
                    exactly what Zach's screenshot showed. */}
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                  {(card.type_line || '').split(' // ').map((line, i, all) => (
                    <div key={i}>
                      {line}
                      {i < all.length - 1 && (
                        <span style={{ color: 'var(--text-muted)' }}> {' // '} </span>
                      )}
                    </div>
                  ))}
                </div>

                {card.supertype === 'MTG' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                    {(Array.isArray(card.types) ? card.types : []).map(color => (
                      <span key={color} className={`mtg-color-pip mtg-color-${color.toLowerCase()}`} style={{
                        fontSize: '0.6rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em',
                        padding: '0.15rem 0.45rem', borderRadius: '999px',
                        background: MTG_COLOR_BG[color] || 'rgba(255,255,255,0.1)',
                        color: MTG_COLOR_FG[color] || '#fff', border: '1px solid rgba(0,0,0,0.2)'
                      }}>{color}</span>
                    ))}
                    {(!card.types || card.types.length === 0) && (
                      <span style={{ fontSize: '0.6rem', fontWeight: 800, textTransform: 'uppercase', padding: '0.15rem 0.45rem', borderRadius: '999px', background: 'rgba(180,180,180,0.25)', color: '#eee' }}>{t('inspector.colorless')}</span>
                    )}
                  </div>
                )}

                {/* RULES TEXT, BOTH FACES. The mockup shows them together so
                    you never flip merely to read the back. normalizeCard stores
                    them as "=== Face ===\n<text>" blocks joined by a blank
                    line, so the face headers are already there to split on. */}
                {card.oracle_text && (
                  <div style={{
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)',
                    borderRadius: 'var(--radius-md)', padding: '0.75rem',
                    fontSize: '0.82rem', lineHeight: 1.55, color: 'var(--text-primary)',
                    whiteSpace: 'pre-wrap',
                  }}>
                    {String(card.oracle_text).split(/\n\n(?==== )/).map((blk, i) => {
                      const m = blk.match(/^=== (.+?) ===\n([\s\S]*)$/);
                      return (
                        <div key={i} style={{ marginTop: i ? '0.75rem' : 0 }}>
                          {m && (
                            <div style={{
                              fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.06em',
                              textTransform: 'uppercase', color: 'var(--text-muted)',
                              marginBottom: '0.3rem',
                            }}>{m[1]}</div>
                          )}
                          {m ? m[2] : blk}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* The facts the mockup lists. Each is a single stored value --
                    nothing here is derived, so nothing here can disagree with
                    another screen. */}
                <div style={{
                  background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)',
                  borderRadius: 'var(--radius-md)', overflow: 'hidden',
                }}>
                  {[
                    [t('inspector.manaCost'), card.mana_cost],
                    [t('inspector.colorIdentity'), (() => {
                      try {
                        const ci = Array.isArray(card.color_identity)
                          ? card.color_identity : JSON.parse(card.color_identity || '[]');
                        return ci.length ? ci.join(' · ') : t('inspector.colorless');
                      } catch { return null; }
                    })()],
                    [t('inspector.manaValue'), card.cmc != null ? String(card.cmc) : null],
                    [t('inspector.rarity'), card.rarity],
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
              </div>
            )}
          </div>

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
              <CardEntryFields
                game={card.game || card.supertype}
                surface="edit"
                quantity={q} purchasePrice={purchasePrice} condition={condition} printing={printing}
                onQuantity={setQ} onPurchasePrice={setPurchasePrice} onCondition={setCondition} onPrinting={setPrinting}
                finishes={card.finishes}
              />

              <div className="form-group">
                <label>{t('inspector.storageContainer')}</label>
                <select className="select-control" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">{t('bulk.unassignedPile')}</option>
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>{loc.name} ({loc.type})</option>
                  ))}
                </select>
              </div>

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
                    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                    fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.06em',
                    textTransform: 'uppercase', color: 'var(--text-muted)',
                    marginBottom: '0.4rem',
                  }}>
                  <span>{t('inspector.thisPrinting')}</span>
                  <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: 'none' }}>
                    {(card.set_id || '').toUpperCase()} #{card.number}
                  </span>
                </div>
                <div style={{
                  background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)',
                  borderRadius: 'var(--radius-md)', overflow: 'hidden', marginBottom: '0.85rem',
                }}>
                  {[
                    [t('inspector.copies'), `x${card.quantity ?? 1}`],
                    [t('inspector.finish'), card.finish || card.desired_finish || 'nonfoil'],
                    [t('inspector.condition'), card.condition || null],
                    [t('inspector.location'), card.location_name || null],
                    [t('inspector.value'), card.price_trend
                      ? `$${(Number(card.price_trend) * (card.quantity ?? 1)).toFixed(2)}`
                      : null],
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

                {/* OTHER PRINTINGS. The mockup's reason for existing: Zach
                    found four "identical" Tony Starks that were different
                    printings between $6.50 and $76.94. Telling them apart is
                    the difference between buying the right card and the wrong
                    one. Loaded with the Decks tab data, which already knows
                    every printing of this oracle id. */}
                {printings && printings.length > 1 && (
                  <div style={{ marginBottom: '0.85rem' }}>
                    <div style={{
                      fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.06em',
                      textTransform: 'uppercase', color: 'var(--text-muted)',
                      marginBottom: '0.4rem',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                    }}>
                      <span>{t('inspector.otherPrintings')}</span>
                      {/* States the fact plainly rather than leaving him to
                          infer it from an absence. */}
                      <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: 'none' }}>
                        {t('inspector.ownNoneOfThese')}
                      </span>
                    </div>
                    <div style={{
                      background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)',
                      borderRadius: 'var(--radius-md)', overflow: 'hidden',
                    }}>
                      {printings.filter(pr => pr.id !== card.card_id && pr.id !== card.id)
                        .map((pr, i) => {
                          let fin = [];
                          try { fin = Array.isArray(pr.finishes) ? pr.finishes : JSON.parse(pr.finishes || '[]'); }
                          catch { fin = []; }
                          const foilOnly = fin.length === 1 && fin[0] === 'foil';
                          return (
                            <div key={pr.id} style={{
                              display: 'flex', justifyContent: 'space-between', gap: '0.75rem',
                              padding: '0.6rem 0.75rem', minHeight: 44, fontSize: '0.82rem',
                              borderTop: i ? '1px solid var(--border-glass)' : 0,
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
                              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                                {pr.price_trend ? `$${Number(pr.price_trend).toFixed(2)}` : '—'}
                              </span>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                )}

              <div style={{ borderTop: '1px solid var(--border-glass)', borderBottom: '1px solid var(--border-glass)', padding: '0.75rem 0', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 700 }}>{t('inspector.marketPrice')}</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--accent-yellow)', marginTop: '0.15rem' }}>
                    ${formatPrice(card.price_trend)}
                  </div>
                  {/* Say where a non-English price came from and in what currency —
                      it is Cardmarket's EUR figure rendered with the app's $. */}
                  {priceSource(card) && (
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                      {t('inspector.priceVia', { source: priceSource(card).name, currency: priceSource(card).currency })}
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 700 }}>{t('inspector.purchaseValue')}</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-strong)', marginTop: '0.15rem' }}>
                    ${formatPrice(card.purchase_price)}
                  </div>
                </div>
              </div>

              {/* Marketplace links are rendered only when they can resolve. */}
              {(tcgplayerUrl(card) || cardmarketUrl(card)) ? (
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {tcgplayerUrl(card) && (
                    <a
                      href={tcgplayerUrl(card)} target="_blank" rel="noopener noreferrer"
                      className="btn btn-secondary"
                      style={{ flex: 1, minWidth: '140px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', fontSize: '0.75rem' }}
                    >
                      <ExternalLink size={13} /> {t('inspector.viewOnTcgplayer')}
                    </a>
                  )}
                  {cardmarketUrl(card) && (
                    <a
                      href={cardmarketUrl(card)} target="_blank" rel="noopener noreferrer"
                      className="btn btn-secondary"
                      style={{ flex: 1, minWidth: '140px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', fontSize: '0.75rem' }}
                    >
                      <ExternalLink size={13} /> Cardmarket
                    </a>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  {noLinkReason(card)}
                </div>
              )}

              {/* Price History Area Chart */}
              <PriceHistoryChart cardId={card.card_id} height={100} defaultRange="30d" />

              {/* Specifications Details Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem 1rem', background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-glass)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem' }}>
                <div><span style={{ color: 'var(--text-muted)' }}>{t('inspector.specCondition')}</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{card.condition}</span></div>
                <div><span style={{ color: 'var(--text-muted)' }}>{t('inspector.specPrinting')}</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{card.printing}</span></div>

                <div><span style={{ color: 'var(--text-muted)' }}>{t('inspector.specSupertype')}</span> <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{card.supertype}</span></div>
              </div>

              {/* Storage Container details (clickable to view in storage) */}
              {card.list_type !== 'wishlist' && (
                <div 
                  onClick={() => onViewStorage && card.list_type !== 'wishlist' && onViewStorage(card)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    background: 'rgba(255, 71, 71, 0.03)', padding: '0.65rem 0.75rem',
                    borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)',
                    fontSize: '0.75rem', cursor: onViewStorage ? 'pointer' : 'default',
                    transition: 'background 0.2s'
                  }}
                  title={onViewStorage ? t('inspector.viewInStorage') : undefined}
                >
                  <MapPin size={14} style={{ color: 'var(--accent-red)', flexShrink: 0 }} />
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    <span style={{ color: 'var(--text-muted)' }}>{t('inspector.locationLabel')} </span>
                    <strong style={{ color: 'var(--text-strong)' }}>
                      {card.location_name ? `${card.location_name}${card.location_type ? ` (${card.location_type})` : ''}` : t('bulk.unassignedPile')}
                    </strong>
                    {card.location_name && card.compartment_display_label && (
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {` • ${card.compartment_display_label}`}
                        {getSlotNumber(card) !== null ? ` • ${t('wizard.slot', { slot: getSlotNumber(card) })}` : ''}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {card.notes && (
                <div style={{ background: 'rgba(0,0,0,0.15)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.75rem', fontSize: '0.8rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {card.notes}
                </div>
              )}

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
                          <span style={{
                            flexShrink: 0, fontSize: '0.7rem', fontWeight: 600,
                            color: d.board === 'considering'
                              ? 'var(--text-muted)'
                              : 'var(--accent-green)',
                          }}>
                            {d.board === 'considering'
                              ? t('inspector.considering')
                              : t('inspector.covered')}
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
                      {[[t('inspector.ownedCount'), deckUse.owned],
                        [t('inspector.reservedCount'), deckUse.reserved],
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
                  {!readOnly && (
                    <div style={{ marginTop: '0.25rem' }}>
                <AddToDeckSelect
                  onAdd={handleAddToDeck}
                  placeholder={t('inspector.addToDeck')}
                  style={{ fontSize: '0.8rem', padding: '0.45rem 0.5rem', maxWidth: '140px' }}
                />
                    </div>
                  )}
                </div>
              )}

              {/* Main Actions Row: Edit Card + Icon buttons for Favorite & Delete */}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn btn-primary" style={{ flex: 1, display: readOnly ? 'none' : undefined }} onClick={() => setMode('edit')}>
                  {t('inspector.editCard')}
                </button>

                {card.list_type === 'wishlist' && (
                  <button 
                    className="btn btn-secondary" 
                    style={{ backgroundColor: 'rgba(74,222,128,0.2)', color: 'var(--type-grass)', border: '1px solid rgba(74,222,128,0.3)', padding: '0 0.75rem', fontSize: '0.8rem' }} 
                    onClick={() => handleQuickToggle('list_type', 'collection')}
                    title={t('bulk.moveToCollection')}
                  >
                    {t('inspector.obtained')}
                  </button>
                )}

                <button
                  type="button"
                  className={`btn ${favorite === 1 ? 'btn-primary' : 'btn-secondary'} btn-icon-only`}
                  style={{ borderRadius: 'var(--radius-sm)', padding: '0.6rem', ...(favorite === 1 ? { backgroundColor: 'rgba(250,204,21,0.2)', color: '#facc15', border: '1px solid rgba(250,204,21,0.3)' } : {}) }}
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
              </div>
            </>
          )}
        </div>
      </div>

      {isFullScreen && (
        <CardImageZoom src={card.image_url} alt={card.name} onClose={() => setIsFullScreen(false)} />
      )}
    </div>
  );
}

export default CardInspectorModal;
