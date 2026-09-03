// A DECK OVER ITS LIMIT MUST SAY SO.
//
// Zach, on the deployed build:
//
//   "I have 101 cards in my list and there is no error message showing at the
//    top like it should because max cards in 100"
//
// Measured on his Tony Stark deck: 100 mainboard + 1 commander = 101 against a
// target of 100, and the API returned 84 warnings -- every one MISSING_COPIES.
// There was no size rule at all.
//
// The comment at the end of buildDeckWarnings already NAMED deck size as
// something that belongs there and stays warning-only. It was described and
// never written, which is the worst state: the reasoning was recorded, so
// reading the code suggested the rule existed.

const assert = require('node:assert/strict');
const { buildDeckWarnings } = require('../src/utils/deckRules');

let passed = 0;
const cases = [];
function test(id, name, fn) { cases.push({ id, name, fn }); }

// buildDeckWarnings only touches the database for colour-identity checks,
// which these entries do not trigger.
const db = { all: async () => [], get: async () => null };

const entry = (over) => ({
  id: 1, board: 'mainboard', quantity_required: over, quantity: over,
  reserves: false, quantity_missing: 0, name: 'Island',
});

test('DS-TC1', 'a deck over its target warns', async () => {
  const warnings = await buildDeckWarnings(
    db, { target_size: 100 },
    [entry(100), { ...entry(1), id: 2, board: 'commander' }]);
  const size = warnings.find(w => w.code === 'DECK_OVER_SIZE');
  assert.ok(size, 'a 101-card deck with a limit of 100 must warn');
  assert.match(size.message, /101/, 'the message states the actual count');
  assert.match(size.message, /100/, 'and the limit');
  assert.match(size.message, /Remove 1 card\b/,
    'and says exactly how many to cut -- a warning you cannot act on is noise');
});

test('DS-TC2', 'a deck at exactly its target does not warn', async () => {
  const warnings = await buildDeckWarnings(
    db, { target_size: 100 },
    [entry(99), { ...entry(1), id: 2, board: 'commander' }]);
  assert.equal(warnings.find(w => w.code === 'DECK_OVER_SIZE'), undefined,
    'exactly 100 is legal and must be silent');
});

test('DS-TC3', 'the commander counts toward the limit', async () => {
  // 100 mainboard + 1 commander is 101 cards in hand. A count that excluded
  // the commander would report 100 while he physically holds 101.
  const warnings = await buildDeckWarnings(
    db, { target_size: 100 },
    [entry(100), { ...entry(1), id: 2, board: 'commander' }]);
  const size = warnings.find(w => w.code === 'DECK_OVER_SIZE');
  assert.match(size.message, /101 cards/,
    'the commander is part of the deck and part of the count');
});

test('DS-TC4', 'considering entries do not count', async () => {
  // A considering entry is a shopping note, not a card in the deck. Counting
  // it would warn about a perfectly legal deck.
  const warnings = await buildDeckWarnings(
    db, { target_size: 100 },
    [entry(100), { ...entry(5), id: 2, board: 'considering' }]);
  assert.equal(warnings.find(w => w.code === 'DECK_OVER_SIZE'), undefined,
    'cards being considered are not in the deck');
});

test('DS-TC5', 'it warns, it does not refuse', async () => {
  // Consistent with every other CONTENTS rule: he fixes an over-size deck by
  // cutting a card, which is work in progress. Only the command zone refuses,
  // because that is a foundation that can never become legal.
  const warnings = await buildDeckWarnings(
    db, { target_size: 100 }, [entry(140)]);
  assert.ok(Array.isArray(warnings), 'returns warnings rather than throwing');
  assert.ok(warnings.some(w => w.code === 'DECK_OVER_SIZE'));
});

test('DS-TC6', 'a deck with no target is not judged', async () => {
  const warnings = await buildDeckWarnings(db, { target_size: null }, [entry(250)]);
  assert.equal(warnings.find(w => w.code === 'DECK_OVER_SIZE'), undefined,
    'no declared limit means nothing to be over');
});

(async () => {
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`PASS: ${c.id} - ${c.name}`);
      passed++;
    } catch (err) {
      console.log(`FAIL: ${c.id} - ${c.name}`);
      console.log(`      ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\ndeck-size warning: ${passed}/${cases.length} cases passed`);
})();
