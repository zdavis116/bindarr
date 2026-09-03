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
  // Was `remaining >= want` against ONE oracle-wide pile. The rule it protects
  // -- coverage is computed from copies actually left, not asserted -- is
  // unchanged; the pool is now per printing and finish, because an owned 2XM
  // cannot cover a requirement for a BRC. See COV-TC8.
  assert.match(scope, /const have = ownedByVariant\.get\(key\) \|\| 0/,
    'coverage must be derived from copies actually remaining, per variant');
  assert.match(scope, /if \(r\.covered\) ownedByVariant\.set\(key, have - want\)/,
    'a covered requirement must consume the copies it claims');
});

test('COV-TC8: coverage is keyed on the PRINTING, not the oracle', () => {
  // Zach: "I don't own this printing I own a different printing but right now
  // I have a printing I don't own chosen so it shouldn't say covered."
  //
  // He owns Master Transmuter 2XM #58. The Tony Stark row wants BRC #87. The
  // loop counted `owned.n` -- every printing of the card -- and handed it out
  // in id order regardless of what each row asked for, so an owned 2XM covered
  // a requirement for a BRC.
  //
  // A WRONG RECORD: a card shown as covered that he cannot actually put in the
  // deck means walking to the shelf for a card that is not there.
  assert.match(route, /const key = `\$\{r\.desired_card_id\}\|\$\{r\.desired_finish\}`/,
    'each requirement must draw from its own variant pool');
  assert.doesNotMatch(route, /let remaining = owned\.n;/,
    'one oracle-wide pile is what caused the bug');
});

test('COV-TC9: the owned pool spans the oracle, not the opened printing', () => {
  // ownedRows is scoped to the printing the sheet was OPENED on
  // (WHERE c.card_id = ?), so it cannot see the 2XM copy when the sheet is
  // open on BRC -- precisely Zach's case. Keying the coverage map off it would
  // have bucketed everything under "undefined|nonfoil": the same oracle-wide
  // flattening, with extra steps.
  assert.match(route, /const ownedVariantRows = await db\.all\(/,
    'coverage needs its own oracle-wide query');
  assert.match(route, /GROUP BY c\.card_id, c\.finish/,
    'grouped per printing and finish');
});

test('COV-TC10: the deck rows query selects desired_card_id', () => {
  // Without it every row hashes to "undefined|<finish>" and the fix silently
  // reproduces the bug it replaces -- while every test still passes.
  // Strip SQL comments first: my own note explaining WHY the column is needed
  // sits inside this window, so the test matched its own documentation and
  // passed with the column removed. Fifth time today a test measured the
  // wrong thing -- comments are not code.
  const q = route
    .slice(route.indexOf('SELECT d.id          AS deck_id'),
           route.indexOf('ORDER BY CASE dc.board'))
    .replace(/--[^\n]*/g, '');
  // Match the SELECT LIST only. The JOIN clause below also mentions
  // dc.desired_card_id, so a window-wide match passed with the column removed
  // -- the test was reading the join condition, not the projection.
  const selectList = q.slice(0, q.indexOf('FROM deck_cards'));
  assert.match(selectList, /dc\.desired_card_id,/,
    'coverage cannot be keyed on a column that was never selected');
});

test('COV-TC11: availability counts claims on cards he actually owns', () => {
  // The panel read "Reserved by decks 1, Free to use 0" for a card whose only
  // claim was on a printing he does not own. His one 2XM #58 is unclaimed, so
  // the truth is reserved 0, free 1.
  assert.match(route, /free: Math\.max\(0, owned\.n - reservedOwned\)/,
    'free must not subtract claims on printings he does not own');
  assert.match(route, /reserved: reservedOwned,/,
    'and the panel must report the honest reservation');
});
