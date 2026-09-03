// ONE ROW FOR EVERY SINGLE-CARD SEARCH.
//
// Zach, after using the deployed build: "commander search should function the
// same as other searches. Honestly all single card searches should function
// the same."
//
// Before this, the commander picker and the deck-view search each had their
// own row. The commander one showed the name and a bare set code -- no set
// name, no price, no foil-only marker, and the FRONT face only, so Tony Stark
// read differently depending on which screen you were on.
//
// The rules this encodes, each of which was learned from a real mistake:
//
//   * BOTH FACES. display_name is "Tony Stark // The Invincible Iron Man";
//     it is null for single-faced cards, so `|| name` is the normal path.
//
//   * THE PRINTING IS PART OF THE IDENTITY. Bindarr records the exact physical
//     card, and Zach found four "identical" Tony Starks that were different
//     printings at different prices. A row that does not name its printing
//     asks the user to choose blind.
//
//   * FOIL-ONLY IS A DIFFERENT CARD. MSH #392 exists only as a foil; picking
//     it expecting a nonfoil is a wrong record about cardboard.
export default function CardSearchResult({ card, onSelect, t, trailing, disabled }) {
  const finishes = Array.isArray(card.finishes)
    ? card.finishes
    : (() => { try { return JSON.parse(card.finishes || '[]'); } catch { return []; } })();
  const foilOnly = finishes.length === 1 && finishes[0] === 'foil';

  const price = card.price_trend ?? card.price_normal ?? null;

  return (
    <button
      type="button"
      onClick={() => onSelect(card)}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: '0.6rem', width: '100%',
        minHeight: 56, padding: '0.5rem 0.6rem', marginTop: '0.35rem',
        border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)',
        background: 'var(--surface-1)', color: 'var(--text-primary)',
        font: 'inherit', textAlign: 'left', cursor: 'pointer',
      }}
    >
      {card.image_url && (
        <img
          src={card.image_url}
          alt=""
          style={{ width: 34, height: 47, objectFit: 'cover', borderRadius: 3, flexShrink: 0 }}
        />
      )}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{
          display: 'block', fontSize: '0.9rem', fontWeight: 600,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {/* Both faces, as every Magic site shows them. */}
          {card.display_name || card.name}
        </span>
        <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
          {(card.set_id || '').toUpperCase()}
          {card.number ? ` #${card.number}` : ''}
          {card.set_name ? ` \u00b7 ${card.set_name}` : ''}
          {foilOnly && ` \u00b7 ${t ? t('card.foilOnly') : 'Foil only'}`}
        </span>
      </span>
      {/* Deck-specific facts -- "1 in this deck", "2 of 3 free" -- belong to
          the caller that has a deck in hand. When absent, the price stands in
          its place, so a commander picker is not forced to invent ownership
          numbers it has no context for. */}
      {trailing || (price != null && (
        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', flexShrink: 0 }}>
          ${Number(price).toFixed(2)}
        </span>
      ))}
    </button>
  );
}
