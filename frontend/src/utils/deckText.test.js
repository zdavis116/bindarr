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

// THE BUYLIST NAMES THE EXACT PRINTING (PR 7).
//
// The old assertion here expected bare "3 Lightning Bolt" lines. That was the
// defect, not the contract: a bare name pasted into a shop's mass entry lets
// the shop choose the printing, which silently spends money on an object the
// user did not pick. The printing is a PRICE decision and it belongs on the
// line.
const buylist = buildDeckExport([
  { quantity: 4, name: 'Lightning Bolt', set_id: '2x2', number: '117', quantity_missing: 3 },
  { quantity: 2, name: 'Counterspell', set_id: 'mh2', number: '267', quantity_missing: 0 },
  { quantity: 3, name: 'Sol Ring', set_id: 'cmm', number: '410', quantity_missing: 3 },
], 'buylist');
assert.equal(
  buylist,
  '3 Lightning Bolt (2X2) 117\n3 Sol Ring (CMM) 410',
  'buylist contains only the shortfall, and names the exact printing to buy'
);

// A card he owns enough of is absent entirely -- a shopping list of things you
// already have is worse than no list.
assert.ok(!buylist.includes('Counterspell'), 'owned surplus is never listed');

// FINISH TRAVELS TOO. A foil slot and a nonfoil slot are different physical
// objects at different prices; dropping the marker would buy the wrong one.
assert.equal(
  buildDeckExport([
    { quantity: 1, name: 'Sol Ring', set_id: 'cmm', number: '410', finish: 'foil', quantity_missing: 1 },
    { quantity: 1, name: 'Sol Ring', set_id: 'cmm', number: '410', finish: 'etched', quantity_missing: 1 },
    { quantity: 1, name: 'Sol Ring', set_id: 'c21', number: '263', finish: 'nonfoil', quantity_missing: 1 },
  ], 'buylist'),
  '1 Sol Ring (CMM) 410 *F*\n1 Sol Ring (CMM) 410 *E*\n1 Sol Ring (C21) 263',
  'foil and etched carry their marker; nonfoil is the unmarked default'
);

// AND IT ROUND-TRIPS. A buylist line fed back through the import parser must
// reproduce the exact requirement it came from -- that is what proves the line
// is unambiguous rather than merely more detailed.
assert.deepEqual(
  parseDeckLine('3 Sol Ring (CMM) 410 *F*'),
  { qty: 3, name: 'Sol Ring', set: 'CMM', number: '410', finish: 'foil' },
  'a buylist line is a fully specified printing, not a hint'
);

// The legacy owned_qty shape still works for callers that predate
// quantity_missing.
assert.equal(
  buildDeckExport([{ quantity: 4, name: 'Lightning Bolt', set_id: '2x2', number: '117', owned_qty: 1 }], 'buylist'),
  '3 Lightning Bolt (2X2) 117'
);

console.log('deckText MTG-only self-check passed');
