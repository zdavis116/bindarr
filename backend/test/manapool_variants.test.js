// THE PRICE MUST BE ONE A PERSON CAN ACTUALLY BUY AT.
//
// Zach: "it says the value is 34.37 but I don't see any value like that in mana
// pool I do see a 34.27" -- then, once the variants feed was found: "I only care
// about LP or NM and English language for exact printing."
//
// HOW THE OLD CODE WAS WRONG. /prices/singles returns one summary row per
// printing, and its numbers do not appear on Mana Pool's own page. Measured on
// The Ur-Dragon PF25 #15 foil:
//
//   /prices/singles   $34.37   <- appears NOWHERE on their page
//   their page        $32.99 $33.73 $34.27 $34.29 $34.98 $35.69 $35.99
//   /prices/variants  $32.99 LP (5 in stock), $33.73 NM (21 in stock)
//
// I had trusted the field name and the docs over the page the app links to.
// Zach found it by trying to buy a card. These guards exist so the same class of
// error -- a confident number nobody can transact at -- cannot come back.
import assert from 'node:assert/strict';
import test from 'node:test';
import { foldVariants, ACCEPTED_CONDITIONS, LANGUAGE }
  from '../src/manaPoolPrices.js';

// The real shape of a variants row, from the live feed.
const row = (over = {}) => ({
  product_type: 'mtg_single',
  scryfall_id: 'card-1',
  set_code: 'PF25',
  number: '15',
  language_id: 'EN',
  condition_id: 'NM',
  finish_id: 'NF',
  low_price: 1000,
  available_quantity: 4,
  url: 'https://manapool.com/card/pf25/15/the-ur-dragon',
  ...over,
});

test('VAR-TC1: the cheapest ACCEPTABLE copy wins, whatever its condition', () => {
  // Zach's real Ur-Dragon listings, from Mana Pool's own page:
  //   Foil MP $29.73  (below his floor)
  //   Foil NM $33.73  <- cheapest he would accept
  //   Foil LP $34.29
  //   Foil LP $34.98
  //
  // My first version of this rule preferred LP by rank, so it picked $34.29 --
  // more money for a worse card. He caught it: "I don't see any LP foil that is
  // 32.99 on mana pool". He was setting a QUALITY FLOOR, not asking to be sold
  // played copies.
  const [out] = foldVariants([
    row({ condition_id: 'MP', low_price: 2973 }),
    row({ condition_id: 'NM', low_price: 3373 }),
    row({ condition_id: 'LP', low_price: 3429 }),
    row({ condition_id: 'LP', low_price: 3498 }),
  ]);
  assert.equal(out.price_cents, 3373,
    'the cheapest copy at or above the floor, not the cheapest LP');
  assert.equal(out.condition, 'NM',
    'and the screen must say which condition that price is for');
});

test('VAR-TC1b: an LP copy wins when it really is cheaper', () => {
  // The mirror of TC1. Both are above the floor, so price alone decides -- this
  // direction proves the fix did not simply become "always prefer NM".
  const [out] = foldVariants([
    row({ condition_id: 'NM', low_price: 3373 }),
    row({ condition_id: 'LP', low_price: 3100 }),
  ]);
  assert.equal(out.price_cents, 3100);
  assert.equal(out.condition, 'LP');
});

test('VAR-TC2: Near Mint is used when there is no Lightly Played', () => {
  const [out] = foldVariants([row({ condition_id: 'NM', low_price: 3373 })]);
  assert.equal(out.price_cents, 3373);
  assert.equal(out.condition, 'NM');
});

test('VAR-TC3: conditions below Lightly Played are never priced', () => {
  // MP/HP/DMG are 201,560 rows of the live feed. A Damaged card is not a
  // substitute for the one he is pricing, and letting one win would quote a
  // number he would not accept -- cheaper, and therefore more tempting.
  const out = foldVariants([
    row({ condition_id: 'MP', low_price: 100 }),
    row({ condition_id: 'HP', low_price: 50 }),
    row({ condition_id: 'DMG', low_price: 10 }),
  ]);
  assert.equal(out.length, 0, 'no acceptable condition means no marketplace price');
  assert.deepEqual(ACCEPTED_CONDITIONS, ['LP', 'NM'],
    'the accepted set is exactly what he asked for');
});

test('VAR-TC4: a cheaper non-English copy never undercuts the English price', () => {
  // 56,768 keys in the live feed differ ONLY by language. Real example:
  //   7ED #275 NF MP  Czech   $0.20    1 in stock
  //   7ED #275 NF MP  English $0.15  141 in stock
  // Taking a global minimum would quietly price his collection in Czech.
  const [out] = foldVariants([
    row({ language_id: 'JA', condition_id: 'LP', low_price: 500 }),
    row({ language_id: 'EN', condition_id: 'LP', low_price: 3299 }),
  ]);
  assert.equal(out.price_cents, 3299, 'the English price stands');
  assert.equal(LANGUAGE, 'EN');
});

test('VAR-TC5: finishes are priced separately, never blended', () => {
  // A foil and a nonfoil of the same printing are different physical objects at
  // very different prices. Collapsing them is how a $33 foil reads as $2.
  const [out] = foldVariants([
    row({ finish_id: 'NF', condition_id: 'LP', low_price: 200 }),
    row({ finish_id: 'FO', condition_id: 'LP', low_price: 3299 }),
  ]);
  assert.equal(out.price_cents, 200, 'nonfoil keeps its own price');
  assert.equal(out.price_cents_foil, 3299, 'foil keeps its own price');
});

test('VAR-TC6: the exact printing is the key, not the card name', () => {
  // Zach: "if I have the foil UR-Dragon for specific set code and number can you
  // get me that exact value?" Two printings of one card must not merge -- he has
  // been bitten by four "identical" Tony Starks priced $6.50 to $76.94.
  const out = foldVariants([
    row({ scryfall_id: 'print-a', condition_id: 'LP', low_price: 3299 }),
    row({ scryfall_id: 'print-b', condition_id: 'LP', low_price: 650 }),
  ]);
  assert.equal(out.length, 2, 'each printing keeps its own row');
  assert.deepEqual(out.map(o => o.price_cents).sort((a, b) => a - b), [650, 3299]);
});

test('VAR-TC7: a zero or missing price is a miss, not a free card', () => {
  const out = foldVariants([
    row({ condition_id: 'LP', low_price: 0 }),
    row({ condition_id: 'NM', low_price: null }),
  ]);
  assert.equal(out.length, 0,
    'storing a zero would make the source look like it has an answer and stop '
    + 'the fallback chain before it reaches Scryfall');
});

test('VAR-TC8: the buy URL comes from the feed, never constructed', () => {
  const [out] = foldVariants([row({ condition_id: 'LP', low_price: 3299 })]);
  assert.equal(out.url, 'https://manapool.com/card/pf25/15/the-ur-dragon',
    'a URL built from set code and number 404s on anything not carried');
});

console.log('mana pool variants guards passed');
