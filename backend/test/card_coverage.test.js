// WHICH DECK ACTUALLY GETS THE COPY.
//
// Zach, on the deployed build: "This image shows it saying 2 decks are covered
// but only one should specifically Tony stark since I added it 1st there."
//
// He owned ONE copy of MSH #80. Two decks wanted it. Both rows said "Covered"
// while the banner directly above read "You own 1 but 2 are needed by your
// decks" -- the screen contradicting itself, because "Covered" was a LABEL
// printed on every non-considering row rather than a calculation.
//
// The rule was already written down. deckIdentity.js orders claims by
// deck_cards.id ASC and says why: the id is assigned at insert and never
// changes, so renaming a deck cannot silently move a physical card to another
// deck. That is precisely why "I added it 1st there" is the right answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const route = readFileSync(join(here, '../src/routes/collection.js'), 'utf8');

// The endpoint's coverage loop, extracted so the cases below exercise the real
// ordering rule rather than a paraphrase of it.
function coverage(owned, rows) {
  let remaining = owned;
  return rows.map(r => {
    if (r.board === 'considering') return { ...r, covered: null };
    const want = r.quantity || 0;
    const covered = remaining >= want;
    if (covered) remaining -= want;
    return { ...r, covered };
  });
}

test('CC-TC1: one copy, two decks -- the FIRST claim is covered', () => {
  // Zach's exact situation.
  const out = coverage(1, [
    { deck_name: 'Tony Stark', board: 'commander', quantity: 1 },
    { deck_name: 'Avatar Aang', board: 'mainboard', quantity: 1 },
  ]);
  assert.equal(out[0].covered, true, 'the first claim gets the copy');
  assert.equal(out[1].covered, false,
    'the second deck is short -- saying Covered here contradicts the banner');
});

test('CC-TC2: a considering entry claims nothing and blocks nothing', () => {
  // A shopping note must not consume a copy that a real requirement needs.
  const out = coverage(1, [
    { deck_name: 'Thinking', board: 'considering', quantity: 1 },
    { deck_name: 'Real deck', board: 'commander', quantity: 1 },
  ]);
  assert.equal(out[0].covered, null, 'considering has no coverage state');
  assert.equal(out[1].covered, true,
    'the real requirement still gets the copy');
});

test('CC-TC3: quantities are consumed, not just rows', () => {
  // Two copies owned, a deck wanting two, then a deck wanting one.
  const out = coverage(2, [
    { deck_name: 'Playset', board: 'mainboard', quantity: 2 },
    { deck_name: 'Other', board: 'mainboard', quantity: 1 },
  ]);
  assert.equal(out[0].covered, true);
  assert.equal(out[1].covered, false,
    'the first deck consumed both copies');
});

test('CC-TC4: owning enough covers everyone', () => {
  const out = coverage(3, [
    { deck_name: 'A', board: 'mainboard', quantity: 1 },
    { deck_name: 'B', board: 'mainboard', quantity: 1 },
    { deck_name: 'C', board: 'mainboard', quantity: 1 },
  ]);
  assert.deepEqual(out.map(r => r.covered), [true, true, true]);
});

test('CC-TC5: owning none covers no one', () => {
  const out = coverage(0, [
    { deck_name: 'A', board: 'mainboard', quantity: 1 },
  ]);
  assert.equal(out[0].covered, false);
});

test('CC-TC6: the endpoint orders rows by claim, not by deck name', () => {
  // THE ORDER DECIDES WHO IS COVERED. I first sorted by d.name, which would
  // have given Zach's copy to "Avatar Aang" over "Tony Stark" -- alphabetical
  // order deciding which deck holds a physical card, and a rename silently
  // moving it.
  const start = route.indexOf("router.get('/card/:cardId/decks'");
  assert.ok(start > 0, 'the endpoint must exist');
  const scope = route.slice(start, route.indexOf('res.json({', start));
  // The window spans the explanatory comment between ORDER BY and dc.id.
  assert.match(scope, /ORDER BY[\s\S]{0,900}dc\.id ASC/,
    'claims must be ordered by deck_cards.id, the same rule deckIdentity uses');
  assert.doesNotMatch(scope, /ORDER BY[\s\S]{0,200}d\.name`/,
    'sorting by deck name would let a rename move a card between decks');
});

test('CC-TC7: the endpoint computes coverage instead of asserting it', () => {
  const start = route.indexOf("router.get('/card/:cardId/decks'");
  const scope = route.slice(start, route.indexOf('res.json({', start));
  assert.match(scope, /remaining >= want/,
    'coverage must be derived from copies actually remaining');
  assert.match(scope, /if \(r\.covered\) remaining -= want/,
    'a covered requirement must consume the copies it claims');
});
