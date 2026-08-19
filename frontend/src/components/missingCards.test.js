// PR 7: the MissingCardsPanel's display rules.
//
// Pure functions, no DOM — same approach as deckSections.test.js and
// cardDisplay.test.js. These decide what the user is told to BUY, so a wrong
// answer here costs real money.
import assert from 'node:assert';
import {
  buylistKey,
  buylistLines,
  isCommittedElsewhere,
  shortfallExplanation
} from './missingCards.js';

let failed = 0;
function test(id, name, fn) {
  try {
    fn();
    console.log(`PASS: ${id} ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL: ${id} ${name} - ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// THE KEY IS THE EXACT PRINTING AND FINISH.
// ---------------------------------------------------------------------------

test('F7-TCM1', 'two printings of one card are two different things to buy', () => {
  const c21 = { desired_card_id: 'sol-c21', finish: 'nonfoil', name: 'Sol Ring' };
  const cmm = { desired_card_id: 'sol-cmm', finish: 'nonfoil', name: 'Sol Ring' };
  assert.notStrictEqual(buylistKey(c21), buylistKey(cmm),
    'the printing is a PRICE decision — collapsing them would buy the wrong card');
});

test('F7-TCM2', 'two finishes of one printing are two different things to buy', () => {
  const plain = { desired_card_id: 'sol-cmm', finish: 'nonfoil' };
  const foil = { desired_card_id: 'sol-cmm', finish: 'foil' };
  assert.notStrictEqual(buylistKey(plain), buylistKey(foil));
});

test('F7-TCM3', 'a deck entry finish field is read as well as a collection one', () => {
  assert.strictEqual(
    buylistKey({ desired_card_id: 'x', desired_finish: 'etched' }),
    buylistKey({ desired_card_id: 'x', finish: 'etched' }),
    'the two shapes describe the same physical object and must key alike'
  );
});

// ---------------------------------------------------------------------------
// ORDERING AND FILTERING.
// ---------------------------------------------------------------------------

test('F7-TCM4', 'zero-quantity lines never render', () => {
  const lines = buylistLines([
    { name: 'Sol Ring', desired_card_id: 'a', finish: 'nonfoil', quantity: 0 },
    { name: 'Bolt', desired_card_id: 'b', finish: 'nonfoil', quantity: 2 },
  ]);
  assert.deepStrictEqual(lines.map(l => l.name), ['Bolt'],
    'a shopping list entry for zero cards is noise at best and a lie at worst');
});

test('F7-TCM5', 'the order is stable and printing-aware', () => {
  const lines = buylistLines([
    { name: 'Sol Ring', desired_card_id: 'b', set_id: 'cmm', number: '410', finish: 'foil', quantity: 1 },
    { name: 'Sol Ring', desired_card_id: 'b', set_id: 'cmm', number: '410', finish: 'nonfoil', quantity: 1 },
    { name: 'Sol Ring', desired_card_id: 'a', set_id: 'c21', number: '263', finish: 'nonfoil', quantity: 1 },
    { name: 'Brainstorm', desired_card_id: 'c', set_id: 'mh2', number: '272', finish: 'nonfoil', quantity: 1 },
  ]);
  assert.deepStrictEqual(
    lines.map(l => `${l.name}|${l.set_id}|${l.finish}`),
    [
      'Brainstorm|mh2|nonfoil',
      'Sol Ring|c21|nonfoil',
      'Sol Ring|cmm|nonfoil',
      'Sol Ring|cmm|foil',
    ],
    'name, then set, then number, then finish — so the list does not reshuffle between reads'
  );
});

test('F7-TCM6', 'an empty or missing buylist renders nothing rather than throwing', () => {
  assert.deepStrictEqual(buylistLines([]), []);
  assert.deepStrictEqual(buylistLines(undefined), []);
  assert.deepStrictEqual(buylistLines(null), []);
});

// ---------------------------------------------------------------------------
// THE MOST CONFUSING LINE: buy a card that is sitting in your own binder.
// ---------------------------------------------------------------------------

test('F7-TCM7', 'a card owned but committed elsewhere is explained, not just listed', () => {
  const item = {
    name: 'Lightning Bolt', desired_card_id: 'bolt', finish: 'nonfoil',
    quantity: 2, quantity_owned: 2, quantity_allocated_elsewhere: 2
  };
  assert.ok(isCommittedElsewhere(item));
  assert.deepStrictEqual(shortfallExplanation(item), { owned: 2, committed: 2 },
    'telling him to buy a card he can SEE in his binder needs a reason attached');
});

test('F7-TCM8', 'a card he simply does not own gets no spurious explanation', () => {
  const item = {
    name: 'Counterspell', desired_card_id: 'cs', finish: 'nonfoil',
    quantity: 1, quantity_owned: 0, quantity_allocated_elsewhere: 0
  };
  assert.strictEqual(isCommittedElsewhere(item), false);
  assert.strictEqual(shortfallExplanation(item), null,
    'the quantity already says everything; extra words would only add doubt');
});

test('F7-TCM9', 'owning some but not all copies is not "committed elsewhere"', () => {
  const item = {
    name: 'Brainstorm', desired_card_id: 'bs', finish: 'nonfoil',
    quantity: 2, quantity_owned: 2, quantity_allocated_elsewhere: 0
  };
  assert.strictEqual(isCommittedElsewhere(item), false,
    'nothing is committed, so the explanation would be false');
});

// ---------------------------------------------------------------------------
// THE MULTI-DECK BUYLIST'S SHARED SHAPING (PR 7).
//
// The aggregate reuses buylistLines and buylistKey, so the ordering and the
// exact printing+finish key are the SAME rules on both surfaces. These cases
// pin the part that matters for the combined list: two printings of one card
// are two distinct lines, never one.

test('F7-TCM10', 'two printings of one card are two DISTINCT keys, never merged', () => {
  const c21 = { name: 'Sol Ring', desired_card_id: 'sr-c21', finish: 'nonfoil', quantity: 1 };
  const cmm = { name: 'Sol Ring', desired_card_id: 'sr-cmm', finish: 'nonfoil', quantity: 1 };
  assert.notStrictEqual(buylistKey(c21), buylistKey(cmm),
    'two printings are two purchases at two prices — merging them would spend his money on a printing he did not choose');
  assert.strictEqual(buylistLines([c21, cmm]).length, 2,
    'and so they must render as two lines, not one line of quantity 2');
});

test('F7-TCM11', 'the same printing in two finishes is also two distinct keys', () => {
  const plain = { name: 'Sol Ring', desired_card_id: 'sr-c21', finish: 'nonfoil', quantity: 1 };
  const foil = { name: 'Sol Ring', desired_card_id: 'sr-c21', finish: 'foil', quantity: 1 };
  assert.notStrictEqual(buylistKey(plain), buylistKey(foil),
    'a foil and a nonfoil of one printing are different physical objects at different prices');
});

test('F7-TCM12', 'an aggregate line carrying deck attribution is shaped unchanged', () => {
  const item = {
    name: 'Lightning Bolt', desired_card_id: 'blt', finish: 'nonfoil', quantity: 3,
    decks: [{ deck_id: 1, name: 'Aggro', quantity: 2 }, { deck_id: 2, name: 'Control', quantity: 1 }]
  };
  const [line] = buylistLines([item]);
  assert.deepStrictEqual(line.decks.map(d => d.name), ['Aggro', 'Control'],
    'the panel needs the deck names intact to say which decks put a card on the list');
  assert.strictEqual(line.quantity, 3, 'and the aggregated shortfall is passed through untouched');
});

if (failed > 0) {
  console.error(`${failed} MissingCardsPanel test(s) failed`);
  process.exit(1);
}
console.log('MissingCardsPanel self-check passed');
