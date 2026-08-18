// PR 6F: the display-side rules for finishes and Browse Collection rows.
//
// These are pure functions with no DOM, checked with plain node, for the same
// reason deckSections.test.js exists: they decide what the user SEES, and a
// wrong answer here is invisible to a backend test that only checks rows.
//
// The specific failure being guarded is the one Zach hit on the dev instance:
// a foil and a nonfoil of the same printing rendered identically, so two rows
// that mean two different physical cards looked like a duplicate bug.
import assert from 'node:assert';
import {
  tileFinish,
  hasFinishBadge,
  getPrintingBadgeLabel,
  getPrintingBadgeStyle,
  getFoilOverlayClass
} from '../utils/cardPrinting.js';

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
// A row's finish is found whichever column it lives in.
//
// Collection rows carry `finish`/`printing`; deck entries carry
// `desired_finish`. The deck grid used to read `printing`, which deck entries
// do not have, so every deck card rendered as a nonfoil.
// ---------------------------------------------------------------------------
test('F14-TC1', 'tileFinish reads a deck entry desired_finish', () => {
  assert.strictEqual(tileFinish({ desired_finish: 'foil' }), 'foil');
  assert.strictEqual(tileFinish({ desired_finish: 'etched' }), 'etched');
});

test('F14-TC2', 'tileFinish reads a collection row finish', () => {
  assert.strictEqual(tileFinish({ finish: 'foil' }), 'foil');
  assert.strictEqual(tileFinish({ printing: 'Foil' }), 'Foil');
});

test('F14-TC3', 'tileFinish falls back to nonfoil rather than undefined', () => {
  // A card with no finish column at all must render as the ordinary case, not
  // crash the badge functions with undefined.
  assert.strictEqual(tileFinish({}), 'nonfoil');
  assert.strictEqual(tileFinish(null), 'nonfoil');
});

// ---------------------------------------------------------------------------
// THE FOIL INDICATOR ITSELF.
// ---------------------------------------------------------------------------
test('F14-TC4', 'a FOIL row is visually distinguishable from a nonfoil row', () => {
  const foil = { card_id: 'x', finish: 'foil' };
  const nonfoil = { card_id: 'x', finish: 'nonfoil' };

  // Same printing, same everything else -- the badge is the ONLY thing that
  // tells the user which row is which.
  assert.strictEqual(hasFinishBadge(foil), true, 'a foil must carry a badge');
  assert.strictEqual(hasFinishBadge(nonfoil), false, 'a nonfoil must NOT be badged');
  assert.strictEqual(getPrintingBadgeLabel(tileFinish(foil)), 'FOIL');
  assert.notDeepStrictEqual(
    getPrintingBadgeStyle(tileFinish(foil)),
    getPrintingBadgeStyle(tileFinish(nonfoil)),
    'the two finishes must not resolve to the same styling'
  );
});

test('F14-TC5', 'a foil deck entry gets the same badge as a foil collection row', () => {
  // The deck grid and the Collection grid must reach the SAME badge for the
  // same physical card, or the two screens disagree about what the user owns.
  const deckEntry = { desired_finish: 'foil' };
  const collectionRow = { finish: 'foil' };
  assert.strictEqual(
    getPrintingBadgeLabel(tileFinish(deckEntry)),
    getPrintingBadgeLabel(tileFinish(collectionRow))
  );
  assert.deepStrictEqual(
    getPrintingBadgeStyle(tileFinish(deckEntry)),
    getPrintingBadgeStyle(tileFinish(collectionRow))
  );
  assert.strictEqual(
    getFoilOverlayClass(tileFinish(deckEntry)),
    getFoilOverlayClass(tileFinish(collectionRow))
  );
});

test('F14-TC6', 'etched is distinct from foil, not lumped in with it', () => {
  assert.strictEqual(getPrintingBadgeLabel('etched'), 'ETCH');
  assert.notStrictEqual(getPrintingBadgeLabel('etched'), getPrintingBadgeLabel('foil'));
  assert.notStrictEqual(getFoilOverlayClass('etched'), getFoilOverlayClass('foil'));
});

// ---------------------------------------------------------------------------
// BROWSE COLLECTION GROUPING.
//
// The grouping rule itself, stated as the reduce the component performs: one
// row per (card_id, finish), quantities summed, nothing merged in the database.
// This is what makes clicking + an unambiguous instruction, which is what makes
// the printing picker redundant.
// ---------------------------------------------------------------------------
function groupOwnedByVariant(rows) {
  const byVariant = new Map();
  for (const item of rows) {
    const finish = item.finish || 'nonfoil';
    const key = `${item.card_id}|${finish}`;
    const existing = byVariant.get(key);
    if (existing) { existing.owned_qty += (item.quantity || 1); continue; }
    byVariant.set(key, {
      id: item.card_id,
      name: item.name,
      finish,
      desired_card_id: item.card_id,
      exact: true,
      owned_qty: item.quantity || 1
    });
  }
  return [...byVariant.values()];
}

test('F14-TC7', 'three physical rows of one variant collapse into ONE row of three', () => {
  // splitStackedEntries makes one physical card one row. Showing that raw
  // would give the user three identical Swamps to choose between.
  const grouped = groupOwnedByVariant([
    { card_id: 'swamp-a', name: 'Swamp', finish: 'nonfoil', quantity: 1 },
    { card_id: 'swamp-a', name: 'Swamp', finish: 'nonfoil', quantity: 1 },
    { card_id: 'swamp-a', name: 'Swamp', finish: 'nonfoil', quantity: 1 }
  ]);
  assert.strictEqual(grouped.length, 1);
  assert.strictEqual(grouped[0].owned_qty, 3, 'the copies are counted, not lost');
});

test('F14-TC8', 'two PRINTINGS of one card name stay two separate rows', () => {
  const grouped = groupOwnedByVariant([
    { card_id: 'sol-c21', name: 'Sol Ring', finish: 'nonfoil', quantity: 2 },
    { card_id: 'sol-cmm', name: 'Sol Ring', finish: 'nonfoil', quantity: 1 }
  ]);
  assert.strictEqual(grouped.length, 2, 'different printings are different physical cards');
});

test('F14-TC9', 'a foil and a nonfoil of ONE printing stay two separate rows', () => {
  const grouped = groupOwnedByVariant([
    { card_id: 'sol-c21', name: 'Sol Ring', finish: 'nonfoil', quantity: 1 },
    { card_id: 'sol-c21', name: 'Sol Ring', finish: 'foil', quantity: 1 }
  ]);
  assert.strictEqual(grouped.length, 2, 'finish is part of identity and must split the rows');
  assert.strictEqual(grouped.filter(r => hasFinishBadge(r)).length, 1,
    'exactly one of the two rows is badged, so they are tellable apart');
});

test('F14-TC10', 'every grouped row is an EXACT instruction -- nothing left to ask', () => {
  // THIS is the property that makes the printing picker redundant on a browse
  // row. If any row came out without both a printing and a finish, clicking +
  // would still be an incomplete instruction and the picker would be right.
  const grouped = groupOwnedByVariant([
    { card_id: 'sol-c21', name: 'Sol Ring', finish: 'nonfoil', quantity: 1 },
    { card_id: 'sol-cmm', name: 'Sol Ring', finish: 'foil', quantity: 1 },
    { card_id: 'bolt-lea', name: 'Lightning Bolt', quantity: 1 }
  ]);
  for (const row of grouped) {
    assert.ok(row.exact, `${row.name} must be marked exact`);
    assert.ok(row.desired_card_id, `${row.name} must name a printing`);
    assert.ok(row.finish, `${row.name} must name a finish`);
  }
  // A row with no stored finish defaults to nonfoil rather than to nothing --
  // an undefined finish would be sent to the server and rejected.
  assert.strictEqual(grouped.find(r => r.id === 'bolt-lea').finish, 'nonfoil');
});

if (failed > 0) {
  console.error(`${failed} card display test(s) failed`);
  process.exit(1);
}
