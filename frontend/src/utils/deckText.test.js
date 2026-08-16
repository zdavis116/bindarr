import assert from 'node:assert/strict';
import { buildDeckExport, parseDeckLine } from './deckText.js';

const cards = [
  { quantity: 4, name: 'Lightning Bolt', set_id: '2x2', number: '117' },
  { quantity: 2, name: 'Counterspell', set_id: 'mh2', number: '267' },
];

const mtga = buildDeckExport(cards, 'mtga');
assert.ok(mtga.startsWith('Deck\n'), 'MTGA export includes its deck header');
assert.ok(mtga.includes('4 Lightning Bolt (2X2) 117'), 'MTGA export preserves the chosen printing');

assert.equal(buildDeckExport(cards, 'plain'), '4 Lightning Bolt\n2 Counterspell');
assert.equal(buildDeckExport(cards, 'ptcgl'), '4 Lightning Bolt\n2 Counterspell', 'unsupported legacy formats safely fall back to plain text');

assert.deepEqual(parseDeckLine('4 Lightning Bolt (2X2) 117'), { qty: 4, name: 'Lightning Bolt' });
assert.deepEqual(parseDeckLine('2 Counterspell'), { qty: 2, name: 'Counterspell' });
assert.equal(parseDeckLine('not a card line'), null);

const buylist = buildDeckExport([
  { quantity: 4, name: 'Lightning Bolt', owned_qty: 1 },
  { quantity: 2, name: 'Counterspell', owned_qty: 2 },
  { quantity: 3, name: 'Sol Ring', owned_qty: 0 },
], 'buylist');
assert.equal(buylist, '3 Lightning Bolt\n3 Sol Ring', 'buylist contains only the ownership shortfall');

console.log('deckText MTG-only self-check passed');
