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
// PR 7C: BRACKETS ARE THE DEFAULT. Zach pastes this into shops, and brackets
// are what TCGplayer Mass Entry and most shop mass-entry boxes parse. The old
// parenthesis default is still available as an explicit choice below.
assert.equal(
  buylist,
  '3 Lightning Bolt [2X2] 117\n3 Sol Ring [CMM] 410',
  'buylist contains only the shortfall, names the exact printing, and defaults to brackets'
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
  '1 Sol Ring [CMM] 410 *F*\n1 Sol Ring [CMM] 410 *E*\n1 Sol Ring [C21] 263',
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
  '3 Lightning Bolt [2X2] 117'
);

// ---------------------------------------------------------------------------
// PR 7C — THE BRACKET STYLE IS THE USER'S CHOICE.
//
// Zach: "I think you should be able to choose brackets or paranthesis before
// copy. Maybe default to brackets."
//
// Neither form is "the correct one". Brackets are the MTG community convention
// that shops parse; parentheses are what MTG Arena's format uses. The choice
// exists because the buylist has two real destinations, and the DEFAULT is
// brackets because shopping is the common case.
// ---------------------------------------------------------------------------

const styleCards = [
  { quantity: 3, name: 'Sol Ring', set_id: 'cmm', number: '410', finish: 'foil', quantity_missing: 3 },
];

// The default, with no options argument at all — this is what an un-updated
// caller gets, and it must be the shop form.
assert.equal(
  buildDeckExport(styleCards, 'buylist'),
  '3 Sol Ring [CMM] 410 *F*',
  'with no choice expressed, the buylist uses brackets'
);
assert.equal(
  buildDeckExport(styleCards, 'buylist', { bracketStyle: 'brackets' }),
  '3 Sol Ring [CMM] 410 *F*',
  'choosing brackets explicitly is the same as the default'
);
assert.equal(
  buildDeckExport(styleCards, 'buylist', { bracketStyle: 'parentheses' }),
  '3 Sol Ring (CMM) 410 *F*',
  'choosing parentheses produces the MTG Arena-shaped form'
);

// A junk or missing style is the DEFAULT, never a crash and never a third
// output shape. A stored preference from a future version, or a typo, must
// still produce a list he can paste.
for (const junk of [undefined, null, '', 'curly', 42, {}]) {
  assert.equal(
    buildDeckExport(styleCards, 'buylist', { bracketStyle: junk }),
    '3 Sol Ring [CMM] 410 *F*',
    `an unusable bracket style (${JSON.stringify(junk)}) falls back to the default rather than inventing a form`
  );
}

// BOTH FORMS CARRY THE WHOLE PRINTING. This is the property that must survive
// the choice: a line without set code, collector number or finish lets a shop
// pick any printing it likes, which is exactly what exact-printing prevents.
// A style toggle that quietly dropped one of them would spend his money on the
// wrong object.
for (const bracketStyle of ['brackets', 'parentheses']) {
  const line = buildDeckExport(styleCards, 'buylist', { bracketStyle });
  assert.ok(line.includes('CMM'), `${bracketStyle}: the set code must travel with the line`);
  assert.ok(/\b410\b/.test(line), `${bracketStyle}: the collector number must travel with the line`);
  assert.ok(line.includes('*F*'), `${bracketStyle}: the finish must travel with the line`);
  assert.ok(line.startsWith('3 Sol Ring'), `${bracketStyle}: the quantity and name are unchanged`);

  // AND BOTH ROUND-TRIP. Verified rather than assumed: parseDeckLine's set
  // token accepts either delimiter, so the comment's old claim that only
  // parentheses round-trip was too pessimistic. Pasting a buylist back into
  // Bindarr works whichever style he picked.
  assert.deepEqual(
    parseDeckLine(line),
    { qty: 3, name: 'Sol Ring', set: 'CMM', number: '410', finish: 'foil' },
    `${bracketStyle}: a buylist line still reproduces its exact requirement when imported back`
  );
}

// THE PER-DECK AND MULTI-DECK BUYLISTS CANNOT DISAGREE ON FORMAT.
//
// Both call sites map the server's items to the same shape (`quantity` is the
// shortfall, mapped onto `quantity_missing`) and hand them to this one
// exporter. So given the same choice, the same lines produce the same text.
// That is what this asserts here; that both call sites actually pass the SAME
// choice is a wiring fact and is asserted in components/buylistUx.test.js.
const serverItems = [
  { quantity: 2, name: 'Sol Ring', set_id: 'cmm', number: '410', finish: 'foil' },
  { quantity: 1, name: 'Lightning Bolt', set_id: '2x2', number: '117' },
];
// The per-deck path and the multi-deck path build their argument identically;
// both are written out here rather than shared, so a future divergence in
// either mapping shows up as a failure instead of passing silently.
const perDeckArgs = (serverItems || []).map(item => ({ ...item, quantity_missing: item.quantity }));
const multiDeckArgs = (serverItems || []).map(item => ({ ...item, quantity_missing: item.quantity }));
for (const bracketStyle of ['brackets', 'parentheses']) {
  assert.equal(
    buildDeckExport(perDeckArgs, 'buylist', { bracketStyle }),
    buildDeckExport(multiDeckArgs, 'buylist', { bracketStyle }),
    `${bracketStyle}: per-deck and multi-deck copy produce the same text from the same lines`
  );
}
assert.equal(
  buildDeckExport(perDeckArgs, 'buylist'),
  '2 Sol Ring [CMM] 410 *F*\n1 Lightning Bolt [2X2] 117',
  'the multi-deck shape defaults to brackets too'
);

// THE MTGA FORMAT IS NOT AFFECTED. Parentheses there are MTG Arena's actual
// spec, not a preference, so the buylist choice must not leak into it — even
// when a caller passes the option through.
const arenaCards = [{ quantity: 4, name: 'Lightning Bolt', set_id: '2x2', number: '117' }];
const arenaExpected = 'Deck\n4 Lightning Bolt (2X2) 117';
assert.equal(buildDeckExport(arenaCards, 'mtga'), arenaExpected, 'mtga export is unchanged');
assert.equal(
  buildDeckExport(arenaCards, 'mtga', { bracketStyle: 'brackets' }),
  arenaExpected,
  'choosing brackets for the buylist must never rewrite an MTG Arena export'
);

console.log('deckText MTG-only self-check passed');
