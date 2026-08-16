// MTG decklist text <-> card list. Export supports MTG Arena, a plain list,
// and a buylist containing only ownership shortfalls.
function cardLine(card, format) {
  const set = String(card.set_id || card.set_code || '').replace(/^mtg-/, '').toUpperCase();
  const number = card.number || '';
  if (format === 'mtga') {
    return `${card.quantity} ${card.name}${set ? ` (${set})` : ''}${number ? ` ${number}` : ''}`;
  }
  return `${card.quantity} ${card.name}`;
}

export function buildDeckExport(cards, format = 'plain') {
  if (!cards?.length) return '';

  if (format === 'buylist') {
    return cards
      .map(card => ({
        name: card.name,
        need: Math.max(0, (card.quantity || 0) - (card.owned_qty || 0)),
      }))
      .filter(card => card.need > 0)
      .map(card => `${card.need} ${card.name}`)
      .join('\n');
  }

  if (format === 'mtga') {
    return `Deck\n${cards.map(card => cardLine(card, 'mtga')).join('\n')}`;
  }

  return cards.map(card => cardLine(card, 'plain')).join('\n');
}

// Extract quantity and card name while tolerating MTGA printing metadata.
export function parseDeckLine(line) {
  const match = String(line).trim().match(/^(\d+)x?\s+(.+)$/i);
  if (!match) return null;

  const qty = Number.parseInt(match[1], 10);
  const name = match[2]
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*#\d+[a-zA-Z]?\s*$/, '')
    .replace(/\s+\d+[a-zA-Z]?$/, '')
    .trim();

  return name ? { qty, name } : null;
}
