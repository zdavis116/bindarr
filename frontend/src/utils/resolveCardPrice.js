// Market price for one collection row, chosen by its FINISH.
//
// Mirrors backend/src/utils/priceHelpers.js. It previously matched pre-fork
// finish values that MTG rows can never hold, so
// every foil silently fell through to the generic price_trend and the
// collection totals were computed as if the user owned no foils.
//
// price_holofoil is Scryfall's usd_foil. Etched has no separate price field, so
// it uses the foil price -- closer to the truth than the nonfoil price.
export function resolveCardPrice(card, printing) {
  if (!card) return 0;
  const raw = printing !== undefined ? printing : (card.finish || card.printing);
  const finish = raw === 'foil' || raw === 'Foil' ? 'foil'
    : raw === 'etched' || raw === 'Etched' ? 'etched'
    : 'nonfoil';
  if ((finish === 'foil' || finish === 'etched') && card.price_holofoil > 0) return card.price_holofoil;
  if (finish === 'nonfoil' && card.price_normal > 0) return card.price_normal;
  return card.price_trend || 0;
}
