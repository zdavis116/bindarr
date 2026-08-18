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

// A BARE line states a card name and nothing else. No set, no number, no
// finish -- and crucially the parser must not manufacture any, because the
// server treats "the line said nothing" and "the line said this" as completely
// different instructions.
assert.deepEqual(parseDeckLine('2 Counterspell'), { qty: 2, name: 'Counterspell' });
assert.equal(parseDeckLine('not a card line'), null);

// An EXPLICIT line states the printing. These are the common decklist forms.
assert.deepEqual(
  parseDeckLine('1 Sol Ring (C21) 263'),
  { qty: 1, name: 'Sol Ring', set: 'C21', number: '263' },
  'set code and collector number are both carried through'
);
assert.deepEqual(
  parseDeckLine('1 Sol Ring [C21]'),
  { qty: 1, name: 'Sol Ring', set: 'C21' },
  'a set code with no collector number is still an explicit printing'
);
assert.deepEqual(
  parseDeckLine('1 Sol Ring (c21) 263 *F*'),
  { qty: 1, name: 'Sol Ring', set: 'C21', number: '263', finish: 'foil' },
  'set codes are case-insensitive and *F* means foil'
);
assert.deepEqual(
  parseDeckLine('1 Sol Ring (C21) 263 *E*'),
  { qty: 1, name: 'Sol Ring', set: 'C21', number: '263', finish: 'etched' },
  'etched is its own finish, not a kind of foil'
);
assert.deepEqual(
  parseDeckLine('4 Lightning Bolt (2X2) 117'),
  { qty: 4, name: 'Lightning Bolt', set: '2X2', number: '117' },
  'the MTGA export form round-trips back into an explicit printing'
);

// The parser must never invent a finish out of a card NAME. 'Foil' is a real
// Magic card, and reading it as a finish marker would silently change which
// physical object the line refers to.
assert.deepEqual(parseDeckLine('1 Foil'), { qty: 1, name: 'Foil' });

// A trailing bare number on a line with no set code is part of the name's
// context, not a collector number -- guessing otherwise would pin the user to a
// printing their line never mentioned.
assert.deepEqual(parseDeckLine('2 Counterspell 267'), { qty: 2, name: 'Counterspell' });

const buylist = buildDeckExport([
  { quantity: 4, name: 'Lightning Bolt', owned_qty: 1 },
  { quantity: 2, name: 'Counterspell', owned_qty: 2 },
  { quantity: 3, name: 'Sol Ring', owned_qty: 0 },
], 'buylist');
assert.equal(buylist, '3 Lightning Bolt\n3 Sol Ring', 'buylist contains only the ownership shortfall');

console.log('deckText MTG-only self-check passed');
