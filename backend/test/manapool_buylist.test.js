// PRICING A BUYLIST IS AN ORDER-LEVEL QUESTION, NOT A CARD-LEVEL ONE.
//
// Zach: "being able to send buy list to mana pool", then "I assume the 3
// calls/min wont be problem if we are just doing 1 buylist at a time."
//
// MEASURED ON HIS OWN CARDS, four real printings from his collection:
//
//   stored item prices        $120.42
//   lowest_price     items $120.49 + ship $5.40 + fee $5.06 = $130.95, 4 sellers
//   fewest_packages  items $144.26 + ship $0.00 + fee $6.06 = $150.32, 1 seller
//
// That $19.37 spread between models is the whole reason this cannot be a number
// on a card. It is a property of the ORDER.
//
// FOUR THINGS THE PUBLISHED SCHEMA GOT WRONG, each found by calling the API:
//   1. declares no auth; returns 401 without a key
//   2. cart lines need language_ids[]/finish_ids[]/condition_ids[]/quantity_requested
//   3. card_id (Scryfall printing id) 409s even for a stocked Sol Ring
//   4. the response is NDJSON, not one JSON object
//
// (4) cost an hour: JSON.parse threw, my handler swallowed it, and every total
// read $0.00 -- which looked like an API fault rather than my bug. These guards
// exist so none of the four can quietly come back.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSolutionStream, toCartLine, CONDITION_IDS, LANGUAGE_IDS,
} from '../src/manaPoolBuylist.js';

test('BUY-TC1: the answer is the LAST line of the NDJSON stream', () => {
  // The optimizer streams improving solutions. Taking the first would quote a
  // worse cart than the one it finally found -- and quoting a number that is
  // not the best available is the same class of error as the $34.37 price he
  // could not find on their site.
  const stream = [
    JSON.stringify({ totals: { total_cents: 9999, seller_count: 4 } }),
    JSON.stringify({ totals: { total_cents: 13095, seller_count: 4 } }),
    JSON.stringify({ totals: { total_cents: 12500, seller_count: 3 } }),
  ].join('\n');
  const final = parseSolutionStream(stream);
  assert.equal(final.totals.total_cents, 12500, 'the last complete object wins');
});

test('BUY-TC2: a truncated final line falls back to the last COMPLETE solution', () => {
  // A stream can be cut mid-object. Returning a half-parsed solution would be
  // worse than returning the previous good one.
  const stream = JSON.stringify({ totals: { total_cents: 13095 } })
    + '\n{"totals": {"total_cents": 129';
  const final = parseSolutionStream(stream);
  assert.equal(final.totals.total_cents, 13095);
});

test('BUY-TC3: an empty or garbage stream yields null, never a fake zero', () => {
  // THE BUG THIS EXISTS FOR. When JSON.parse threw on the whole body, the
  // fallback produced an object with no totals and every money field rendered
  // $0.00 -- a confident, wrong, free-looking price.
  assert.equal(parseSolutionStream(''), null);
  assert.equal(parseSolutionStream('not json at all'), null);
});

test('BUY-TC4: cards are identified by set code + collector number', () => {
  // card_id, which the schema documents, returns 409 "no_candidates" on this
  // endpoint even for cards demonstrably in stock.
  const line = toCartLine({ set_code: 'pf25', collector_number: '15',
                            finish: 'foil', quantity: 2 });
  assert.equal(line.set_code, 'PF25', 'set codes are sent upper case');
  assert.equal(line.collector_number, '15');
  assert.ok(!('card_id' in line), 'card_id does not work on the optimizer');
  assert.equal(line.quantity_requested, 2, 'the API field is quantity_requested');
});

test('BUY-TC5: his condition floor is sent to the marketplace, not applied after', () => {
  // Asking Mana Pool for LP or NM means the optimizer never allocates a
  // Moderately Played copy in the first place. Filtering afterwards would let
  // it build a cheaper cart he would refuse.
  const line = toCartLine({ set_code: 'C21', collector_number: '263' });
  assert.deepEqual(line.condition_ids, ['LP', 'NM']);
  assert.deepEqual(CONDITION_IDS, ['LP', 'NM']);
  assert.deepEqual(line.language_ids, ['EN']);
  assert.deepEqual(LANGUAGE_IDS, ['EN']);
});

test('BUY-TC6: finish is carried per line, never defaulted away', () => {
  // A foil and a nonfoil of one printing are different physical cards at very
  // different prices. His Ur-Dragon is foil-only.
  assert.deepEqual(toCartLine({ set_code: 'X', collector_number: '1', finish: 'foil' }).finish_ids, ['FO']);
  assert.deepEqual(toCartLine({ set_code: 'X', collector_number: '1', finish: 'etched' }).finish_ids, ['EF']);
  assert.deepEqual(toCartLine({ set_code: 'X', collector_number: '1' }).finish_ids, ['NF']);
});

test('BUY-TC7: quantity is never zero or negative', () => {
  // A zero-quantity line would ask the marketplace for nothing and could make a
  // needed card silently vanish from the order.
  assert.equal(toCartLine({ set_code: 'X', collector_number: '1', quantity: 0 }).quantity_requested, 1);
  assert.equal(toCartLine({ set_code: 'X', collector_number: '1', quantity: -3 }).quantity_requested, 1);
});

console.log('mana pool buylist guards passed');
