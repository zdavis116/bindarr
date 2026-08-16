// MTG marketplace links. Provider URLs win; older cache rows fall back to a
// name search against the Magic product line.
const searchable = (card) => /[a-z]/i.test(card?.name || '');

export function tcgplayerUrl(card) {
  if (card?.tcgplayer_url) return card.tcgplayer_url;
  if (!searchable(card)) return null;
  return `https://www.tcgplayer.com/search/magic/product?q=${encodeURIComponent(card.name)}`;
}

export function cardmarketUrl(card) {
  if (card?.cardmarket_url) return card.cardmarket_url;
  if (!searchable(card)) return null;
  return `https://www.cardmarket.com/en/Magic/Products/Search?searchString=${encodeURIComponent(card.name)}`;
}

export const priceSource = () => null;

export function noLinkReason(card) {
  if (tcgplayerUrl(card) || cardmarketUrl(card)) return null;
  return 'No marketplace link for this printing — TCGplayer and Cardmarket index cards by English name, and this one has none.';
}
