// PR 7 (plan requirement G1): the finish picker must only offer finishes that
// the SELECTED PRINTING actually exists in.
//
// Why this is a correctness rule and not a cosmetic one: offering "Foil" for a
// card that was never printed in foil invites the user to record a physical
// object that does not exist. Every downstream consequence of that is silent —
// deck identity matches on finish, so the phantom foil satisfies nothing and
// shows as missing forever; and since PR 7 the same wrong finish flows
// straight onto a BUYLIST, where it becomes an instruction to go and buy a
// card no shop can sell.
//
// Pure functions, no DOM, same approach as cardDisplay.test.js.
import assert from 'node:assert';
import { getPrintings, finishPickerState } from '../utils/cardOptions.js';

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

const values = list => list.map(option => option.value);

// ---------------------------------------------------------------------------

test('F7-TCG1a', 'a nonfoil-only printing offers ONLY nonfoil', () => {
  assert.deepStrictEqual(
    values(getPrintings(['nonfoil'])),
    ['nonfoil'],
    'a card never printed in foil must not offer Foil'
  );
});

test('F7-TCG1b', 'a printing with no etched version does not offer Etched', () => {
  assert.deepStrictEqual(
    values(getPrintings(['nonfoil', 'foil'])),
    ['nonfoil', 'foil'],
    'Etched is a real, separate finish — offering it where it does not exist invents a card'
  );
});

test('F7-TCG1c', 'a printing that IS etched-only offers only etched', () => {
  assert.deepStrictEqual(values(getPrintings(['etched'])), ['etched']);
});

test('F7-TCG1d', 'every offered finish keeps its human label', () => {
  const options = getPrintings(['nonfoil', 'foil', 'etched']);
  assert.deepStrictEqual(
    options.map(o => o.label),
    ['Nonfoil', 'Foil', 'Etched'],
    'filtering must not strip the labels the picker renders'
  );
});

test('F7-TCG1e', 'the canonical order is preserved regardless of Scryfall order', () => {
  assert.deepStrictEqual(
    values(getPrintings(['etched', 'foil', 'nonfoil'])),
    ['nonfoil', 'foil', 'etched'],
    'the picker order is the app\'s, so the list does not reshuffle per card'
  );
});

// THE FALLBACK, and why it is permissive rather than strict.
//
// A caller that knows nothing about the card's finishes must still be able to
// show a working picker. Refusing to offer anything would make a card with a
// thin or missing cache row unaddable entirely — turning a data gap into a
// dead end, which is worse than the over-offering this fixes. The rule is:
// filter when we KNOW, offer everything when we genuinely do not.
test('F7-TCG1f', 'an unknown finishes list falls back to offering all three', () => {
  assert.deepStrictEqual(values(getPrintings()), ['nonfoil', 'foil', 'etched']);
  assert.deepStrictEqual(values(getPrintings(null)), ['nonfoil', 'foil', 'etched']);
  assert.deepStrictEqual(values(getPrintings([])), ['nonfoil', 'foil', 'etched'],
    'an EMPTY list is a card we have no finish data for, not a card with no finishes');
});

test('F7-TCG1g', 'unrecognised finish values from upstream are ignored, not shown', () => {
  assert.deepStrictEqual(
    values(getPrintings(['nonfoil', 'glossy', 'foil'])),
    ['nonfoil', 'foil'],
    'a finish the app cannot store must never become a selectable option'
  );
});

// ---------------------------------------------------------------------------
// THE RESET RULE (PR 7 review blocker 1).
//
// G1 narrowed the picker. It must NEVER, as a side effect, rewrite a finish
// already recorded against a physical card the user owns.
//
// The failure it caused: he owns a FOIL of a card whose cached finishes array
// lacks 'foil' (exactly the bad data the old unconditional picker allowed).
// He opens the inspector, edits the PRICE, saves — and the reset fires on
// mount, submitting 'nonfoil'. Because finish drives deck availability, the
// rewritten row stops satisfying the foil slot, the deck reports the card
// MISSING, and the buylist tells him to buy a card sitting in his binder.
//
// Two of his standing rules broken at once: never silently change the record
// of a physical object he cannot reconcile against reality, and never assert
// something false about what he needs to buy.
//
// The rule: on an EDIT surface an out-of-range recorded finish is PRESERVED
// and FLAGGED. Warn, do not correct. Resetting is only ever right where no
// record exists yet (an ADD surface) or where the user themselves just changed
// the printing.

test('F7-TCG2a', 'EDIT: an out-of-range recorded finish is NEVER rewritten', () => {
  const state = finishPickerState({
    surface: 'edit',
    finishes: ['nonfoil'],
    printing: 'foil'
  });
  assert.strictEqual(state.reset, null,
    'editing an unrelated field must not rewrite the recorded finish of a physical card');
});

test('F7-TCG2b', 'EDIT: the out-of-range recorded finish stays VISIBLE and is FLAGGED', () => {
  const state = finishPickerState({
    surface: 'edit',
    finishes: ['nonfoil'],
    printing: 'foil'
  });
  assert.ok(state.options.some(option => option.value === 'foil'),
    'a value he cannot see is a value he cannot correct — it must stay selectable');
  assert.strictEqual(state.unverifiedFinish, 'foil',
    'and it must be flagged, so he is warned rather than silently corrected');
});

// CONTROL 1: a thin cache row is a DATA GAP, not a contradiction. Nothing to
// warn about and nothing to reset.
test('F7-TCG2c', 'EDIT: a thin cache row (finishes []) causes NO reset and NO flag', () => {
  const state = finishPickerState({ surface: 'edit', finishes: [], printing: 'foil' });
  assert.strictEqual(state.reset, null);
  assert.strictEqual(state.unverifiedFinish, null,
    'we know nothing about this card, so there is nothing to contradict');
});

// CONTROL 2: a recorded finish that IS offered is ordinary. No reset, no flag.
test('F7-TCG2d', 'EDIT: a recorded finish that IS offered causes NO reset and NO flag', () => {
  const state = finishPickerState({
    surface: 'edit',
    finishes: ['nonfoil', 'foil'],
    printing: 'foil'
  });
  assert.strictEqual(state.reset, null);
  assert.strictEqual(state.unverifiedFinish, null);
});

// ADD surfaces still reset, and must. There is no record yet, so nothing can
// be destroyed — and leaving 'foil' held in state from the previous card while
// the dropdown shows Nonfoil would submit a value the screen never displayed.
test('F7-TCG2e', 'ADD: an unofferable in-progress value IS reset', () => {
  const state = finishPickerState({
    surface: 'add',
    finishes: ['nonfoil'],
    printing: 'foil'
  });
  assert.strictEqual(state.reset, 'nonfoil',
    'on an add surface there is no recorded card to protect, and a stale carried-over value would be submitted unseen');
});

test('F7-TCG2f', 'ADD: an offerable value is left alone', () => {
  const state = finishPickerState({
    surface: 'add',
    finishes: ['nonfoil', 'foil'],
    printing: 'foil'
  });
  assert.strictEqual(state.reset, null);
});

if (failed > 0) {
  console.error(`${failed} G1 finish-picker test(s) failed`);
  process.exit(1);
}
console.log('G1 finish-picker self-check passed');
