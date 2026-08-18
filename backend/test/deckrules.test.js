// Deck rules are now ADVISORY. This file changed shape in PR 6C along with the
// module it covers: it used to assert that `validateDeckAddition` REFUSED
// certain additions, and now it asserts that `buildDeckWarnings` REPORTS them
// while the save goes through.
//
// That inversion is the product decision, not an accident: you must be able to
// build a decklist for cards you have not bought yet. Physical availability is
// enforced at checkout (see test/deckIdentity.test.js F12-TC8), which is the
// moment it actually matters.
//
// Run: `node test/deckrules.test.js`. Uses a fake db client so it never touches
// a real database.
const assert = require('assert');
const { isBasicEnergyOrLand, buildDeckWarnings } = require('../src/utils/deckRules');

function testClassification() {
  assert.strictEqual(
    isBasicEnergyOrLand({ name: 'Forest', supertype: 'Land', subtypes: '["Basic","Forest"]' }), true
  );
  assert.strictEqual(
    isBasicEnergyOrLand({ name: 'Fabled Passage', supertype: 'Land', subtypes: '["Land"]' }), false
  );
  assert.strictEqual(
    isBasicEnergyOrLand({ name: 'Lightning Bolt', supertype: 'MTG', subtypes: '["Instant"]' }), false
  );
}

// Minimal card_cache stand-in for the copy-limit lookup.
function makeFakeDb(card = { name: 'Lightning Bolt', supertype: 'Instant', subtypes: '["Instant"]' }) {
  return { async get() { return card; } };
}

// Availability-annotated requirement, as deckIdentity.availabilityForDeck emits.
function entry(overrides = {}) {
  return {
    id: 1,
    name: 'Lightning Bolt',
    set_name: 'Double Masters 2022',
    number: '117',
    desired_card_id: 'bolt-2x2',
    desired_finish: 'nonfoil',
    board: 'mainboard',
    quantity: 1,
    reserves: true,
    quantity_required: 1,
    quantity_owned: 1,
    quantity_allocated_elsewhere: 0,
    quantity_missing: 0,
    ...overrides
  };
}

async function testOwnershipWarnings() {
  const deck = { format: 'Modern' };

  // Fully owned: nothing to say.
  const quiet = await buildDeckWarnings(makeFakeDb(), deck, [entry()]);
  assert.deepStrictEqual(quiet, [], 'an owned, legal deck produces no warnings');

  // Owned none: a warning, NOT a refusal. There is no way for this function to
  // block a save -- it returns advice and nothing else.
  const unowned = await buildDeckWarnings(makeFakeDb(), deck, [
    entry({ quantity: 4, quantity_required: 4, quantity_owned: 0, quantity_missing: 4 })
  ]);
  assert.strictEqual(unowned.length, 1, 'an unowned requirement warns exactly once');
  assert.strictEqual(unowned[0].code, 'MISSING_COPIES', 'warnings are identified by a stable code');
  assert.ok(/do not own/i.test(unowned[0].message), 'the message explains the shortfall');

  // Owned, but another deck got there first. The user needs to know this is a
  // contention problem rather than a "go buy it" problem, because the fix is
  // different: they may prefer to rebuild the other deck.
  const contended = await buildDeckWarnings(makeFakeDb(), deck, [
    entry({ quantity_owned: 1, quantity_allocated_elsewhere: 1, quantity_missing: 1 })
  ]);
  assert.strictEqual(contended[0].code, 'MISSING_COPIES');
  assert.ok(/reserved by another deck/i.test(contended[0].message), 'contention is described as such');

  // A considering entry is a shopping note, not a hole in the deck.
  const considering = await buildDeckWarnings(makeFakeDb(), deck, [
    entry({ board: 'considering', reserves: false, quantity_owned: 0, quantity_missing: 0 })
  ]);
  assert.deepStrictEqual(considering, [], 'considering entries do not warn about ownership');
}

async function testCopyLimit() {
  const deck = { format: 'Modern' };

  // The 4-copy rule is about the card NAME, so it must count across printings.
  // Three of one printing plus two of another is five Lightning Bolts.
  const overLimit = await buildDeckWarnings(makeFakeDb(), deck, [
    entry({ id: 1, desired_card_id: 'bolt-2x2', quantity: 3 }),
    entry({ id: 2, desired_card_id: 'bolt-lea', quantity: 2 })
  ]);
  assert.ok(
    overLimit.some(w => w.code === 'COPY_LIMIT'),
    'copies are counted across printings of the same name'
  );

  // Exactly four is legal.
  const atLimit = await buildDeckWarnings(makeFakeDb(), deck, [
    entry({ id: 1, desired_card_id: 'bolt-2x2', quantity: 2 }),
    entry({ id: 2, desired_card_id: 'bolt-lea', quantity: 2 })
  ]);
  assert.ok(!atLimit.some(w => w.code === 'COPY_LIMIT'), 'exactly 4 total is allowed');

  // Basic lands are exempt: a deck runs far more than four Forests.
  const basics = makeFakeDb({ name: 'Forest', supertype: 'Land', subtypes: '["Basic","Forest"]' });
  const manyForests = await buildDeckWarnings(basics, deck, [
    entry({ name: 'Forest', desired_card_id: 'forest-1', quantity: 24 })
  ]);
  assert.ok(!manyForests.some(w => w.code === 'COPY_LIMIT'), 'basic lands are exempt from the 4-copy rule');
}

async function testCommanderWarnings() {
  const commanderDeck = { format: 'Commander / EDH' };

  const noCommander = await buildDeckWarnings(makeFakeDb(), commanderDeck, [entry()]);
  assert.ok(
    noCommander.some(w => w.code === 'COMMANDER_MISSING'),
    'a Commander deck with no commander warns'
  );

  const withCommander = await buildDeckWarnings(makeFakeDb(), commanderDeck, [
    entry({ board: 'commander' })
  ]);
  assert.ok(
    !withCommander.some(w => w.code === 'COMMANDER_MISSING'),
    'assigning a commander clears the warning'
  );

  const tooMany = await buildDeckWarnings(makeFakeDb(), commanderDeck, [
    entry({ id: 1, board: 'commander', quantity: 3 })
  ]);
  assert.ok(
    tooMany.some(w => w.code === 'COMMANDER_TOO_MANY'),
    'more than two commanders warns'
  );

  // Commander rules must not leak into other formats.
  const modern = await buildDeckWarnings(makeFakeDb(), { format: 'Modern' }, [entry()]);
  assert.ok(
    !modern.some(w => String(w.code).startsWith('COMMANDER')),
    'Commander rules apply only to Commander decks'
  );
}

async function main() {
  testClassification();
  await testOwnershipWarnings();
  await testCopyLimit();
  await testCommanderWarnings();
  console.log('deckrules.test.js passed');
}

main().catch(err => { console.error(err); process.exit(1); });
