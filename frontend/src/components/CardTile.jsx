// THE card tile. One implementation, used by the Collection gallery and by the
// deck's Grid view.
//
// Why this file exists. The deck grid and the Collection grid drew the same
// object two different ways: the Collection screen showed the rarity chip, the
// quantity badge, the FOIL badge and name / set · number / price, while the
// deck grid drew its own yellow `x1` pill and a green `Reserved 1 of 1` bar.
// Same card, two looks, and which one the user saw depended on which screen
// they opened. Two implementations of one card WILL drift -- they already had.
//
// The markup below is lifted from the Collection gallery unchanged, so the
// Collection screen is byte-for-byte what it was. Everything deck-specific is
// injected rather than branched on:
//
//   `badges`  -- extra pills rendered in the bottom overlay strip, beside FOIL
//   `footer`  -- rows added under the name/meta block (status, actions)
//   `meta`    -- overrides the right-hand meta slot (price by default)
//
// That shape is deliberate. A `variant="deck"` prop would put both screens'
// layout decisions back in one branchy component, which is the same drift with
// extra steps; passing CONTENT in keeps the layout single-sourced while letting
// each screen say what belongs on its own cards.
import {
  getPrintingBadgeLabel,
  getPrintingBadgeStyle,
  getFoilOverlayClass,
  tileFinish
} from '../utils/cardPrinting';
import { getCardRarityBorder, getRarityBadgeLabel, getRarityBadgeStyle } from '../utils/cardRarity';
import { formatPrice } from '../utils/formatPrice';

// The yellow FOIL badge, exactly as the Collection screen draws it.
//
// A component rather than a style object because the Browse Collection LIST
// rows need the same badge without the whole tile around it, and sharing the
// ELEMENT is the point: a foil has to look like a foil everywhere in the app,
// and a second hand-rolled amber pill somewhere else is precisely the drift
// this file exists to stop.
//
// `tileFinish` and `hasFinishBadge` live in utils/cardPrinting.js -- they are
// pure functions with no DOM, so they belong with the rest of the finish
// vocabulary rather than beside a component.
export function FinishBadge({ card, style }) {
  const finish = tileFinish(card);
  const label = getPrintingBadgeLabel(finish);
  if (!label) return null;
  return (
    <span style={{
      fontSize: '0.6rem',
      fontWeight: 800,
      padding: '2px 5px',
      borderRadius: '3px',
      ...getPrintingBadgeStyle(finish),
      border: '1px solid rgba(255, 255, 255, 0.2)',
      ...style
    }}>
      {label}
    </span>
  );
}

function CardTile({
  card,
  quantity,
  onClick,
  onImageClick,
  selected = false,
  selectMode = false,
  conditionLabel = null,
  badges = null,
  footer = null,
  meta = undefined,
  pressHandlers = {},
  style = {}
}) {
  const rarityStyle = getCardRarityBorder(card.rarity);
  const finish = tileFinish(card);
  const overlayClass = getFoilOverlayClass(finish);
  // The count shown top-right. Passed in rather than read off a fixed column
  // because the two screens count different things: the Collection counts
  // physical copies in the binder, the deck counts copies the deck requires.
  const count = quantity === undefined ? card.quantity : quantity;

  return (
    <div
      className="tcg-card tilt-card-wrapper"
      style={{ cursor: 'pointer', touchAction: 'pan-y', ...style }}
      onClick={onClick}
      {...pressHandlers}
    >
      <div
        className="tcg-card-inner"
        style={{ ...rarityStyle, ...(selected ? { outline: '3px solid var(--accent-red)', outlineOffset: '2px' } : {}) }}
        onClick={onImageClick}
      >
        {selectMode && (
          <div style={{ position: 'absolute', top: '6px', right: '6px', zIndex: 20, width: '22px', height: '22px', borderRadius: '50%', background: selected ? 'var(--accent-red)' : 'rgba(0,0,0,0.6)', border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-strong)', fontSize: '0.8rem', fontWeight: 900 }}>{selected ? '✓' : ''}</div>
        )}
        <img src={card.image_url} alt={card.name} className="tcg-card-image" loading="lazy" draggable={false} />
        {overlayClass && (
          <div className={overlayClass} style={{ borderRadius: 'var(--radius-sm)' }} />
        )}
        {count > 1 && (
          <div className="tcg-card-quantity-tag">x{count}</div>
        )}

        {/* Rarity badge (shared tier system, matches Storage view) */}
        <span style={{
          position: 'absolute',
          top: '6px',
          left: '6px',
          fontSize: '0.55rem',
          fontWeight: 900,
          padding: '2px 4px',
          borderRadius: '3px',
          zIndex: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
          ...getRarityBadgeStyle(card.rarity)
        }}>
          {getRarityBadgeLabel(card.rarity)}
        </span>

        {/* Overlay Tags */}
        <div style={{
          position: 'absolute',
          bottom: '6px',
          left: '6px',
          right: '6px',
          display: 'flex',
          justifyContent: 'space-between',
          gap: '4px',
          alignItems: 'flex-end',
          pointerEvents: 'none'
        }}>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {conditionLabel && (
              <span style={{
                fontSize: '0.6rem',
                fontWeight: 800,
                padding: '2px 5px',
                borderRadius: '3px',
                background: 'rgba(0, 0, 0, 0.75)',
                color: 'var(--text-strong)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                textTransform: 'uppercase'
              }}>
                {conditionLabel}
              </span>
            )}
            {badges}
          </div>
          <FinishBadge card={card} />
        </div>
      </div>
      <div className="tcg-card-info">
        <div className="tcg-card-name">{card.name}</div>
        <div className="tcg-card-meta">
          <span style={{ fontSize: '0.7rem' }}>{card.set_name} • #{card.number}</span>
          {meta === undefined
            ? <span className="tcg-card-price">${formatPrice(card.price_trend)}</span>
            : meta}
        </div>
        {footer}
      </div>
    </div>
  );
}

export default CardTile;
