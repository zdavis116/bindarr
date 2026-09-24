// OWNED IS NOT THE SAME AS AVAILABLE.
//
// Zach, looking at a deck: "in card detail view when it tells me I own a
// printing in the your tab one of those own printings could be used in another
// deck which can cause confusion. What it should show is that I own it but it's
// used in another deck if it technically isn't available."
//
// The Yours tab printed "you own 6" from `owned_qty` alone. On his real data
// that was actively misleading:
//
//   AKH #266 Mountain   owned 6   committed 6   ACTUALLY FREE 0
//   DFT #291 Forest     owned 6   committed 6   ACTUALLY FREE 0
//   MSH #293 Mountain   owned 7   committed 12  ACTUALLY FREE 0
//   TMT #257 Forest     owned 13  committed 5   ACTUALLY FREE 8
//
// Reading "you own 6" while building a deck means picking a printing that
// cannot go in it, and finding out at the table against cardboard. Zach's own
// rule: a wrong record costs a recount, a missing one costs a tap. This was the
// app manufacturing the expensive kind.
//
// THE NUMBERS COME FROM THE SERVER. committed_qty and quantity_available are
// already computed in routes/collection.js from deck_cards, and the deck view
// reserves against the same figures. Recomputing in the component would be a
// SECOND OPINION about physical cards -- which is precisely how the completion
// ring and missing_cost drifted apart earlier in this project: two plausible
// rules for one question, one of them wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'CardInspectorModal.jsx'), 'utf8');
const route = readFileSync(join(here, '../../../backend/src/routes/collection.js'), 'utf8');
const en = JSON.parse(readFileSync(join(here, '../locales/en.json'), 'utf8'));
const strip = s => s
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const code = strip(src);

test('AV-TC1: an owned printing never reports a bare count when copies are committed', () => {
  // The bug in one line: `youOwn` rendered from owned_qty with nothing else.
  const list = code.slice(code.indexOf('otherPrintings'));
  assert.doesNotMatch(list, /t\('inspector\.youOwn', \{ count: pr\.owned_qty \}\)/,
    'rendering owned_qty alone is the confusion he reported');
  assert.match(list, /const avail = pr\.quantity_available \?\? owned/,
    'the row must read the server\'s availability figure');
  assert.match(list, /const spoken = Math\.max\(0, owned - avail\)/,
    'and derive how many are spoken for from it');
});

test('AV-TC2: none-free and some-free say different things', () => {
  // They lead to different decisions: none free means buy another copy, some
  // free means you have one to spare. Collapsing both into "3 in decks" makes
  // him do the subtraction himself, every time, on a phone.
  const list = code.slice(code.indexOf('otherPrintings'));
  assert.match(list, /avail > 0\s*\n?\s*\? t\('inspector\.someInDecks', \{ count: avail \}\)\s*\n?\s*: t\('inspector\.allInDecks', \{ count: spoken \}\)/,
    'the two cases must render distinct strings');
  assert.ok('inspector.someInDecks' in en && 'inspector.allInDecks' in en,
    'both strings must exist');
  assert.match(en['inspector.someInDecks'], /\{count\}/, 'free count must interpolate');
  assert.match(en['inspector.allInDecks'], /\{count\}/, 'committed count must interpolate');
});

test('AV-TC3: a printing with nothing committed stays quiet', () => {
  // Verified deployed: RIX #196 (5 owned, 0 committed) renders "you own 5" with
  // no extra line, while DFT #291 (6 owned, 6 committed) renders "All 6 in
  // decks". A note on every row would be noise that trains him to ignore it.
  const list = code.slice(code.indexOf('otherPrintings'));
  assert.match(list, /if \(spoken === 0\) \{/,
    'the unencumbered case must return the plain label');
});

test('AV-TC6: Available to use is oracle-wide, never mixed scopes', () => {
  // Zach, on a Commander 2019 Rogue's Passage he owns NONE of: "Why is
  // available to use still showing that. It should say 2 of 3."
  //
  // The row read "1 in decks" because `available` and `committed` came from
  // THIS PRINTING (c19 #270: 0 owned, 0 committed) while `owned` beside them
  // was oracle-wide (3). One sentence, two scopes -- so it described a
  // printing he does not own using a count borrowed from one he does.
  //
  // The backend already computes all three consistently: owned, reservedOwned
  // and free. The fix is to read them, not to recompute a fourth answer.
  // `code` is the comment-stripped source, prepared at the top of this file.
  // Stripping matters: the explanation above names the very values it forbids,
  // and an absence assertion that reads comments fails on its own prose.
  const at = code.indexOf("t('inspector.availableToUse')");
  assert.ok(at > 0, 'the Available to use row must exist');
  const row = code.slice(at, at + 1200);

  // THE PER-PRINTING FIGURES MUST NOT DRIVE THIS ROW. They are the exact
  // values that produced the wrong sentence.
  assert.doesNotMatch(row, /available:\s*thisPrinting/,
    'the available count must be oracle-wide, not per printing');
  assert.doesNotMatch(row, /committed:\s*thisPrintingCommitted[,\s)]/,
    'the in-decks count must be oracle-wide, not per printing');

  // AND IT MUST READ THE BACKEND'S NUMBERS. Recomputing "how many are free"
  // in the component is how the panel and the per-deck rows disagreed before:
  // when two surfaces answer the same question separately, one of them is
  // always lying and the screen gives no way to tell which.
  assert.match(row, /deckUse\?\.owned\b/, 'owned must come from the endpoint');
  assert.match(row, /deckUse\?\.reservedOwned\b/,
    'the in-decks count must come from the endpoint');
  assert.match(row, /deckUse\?\.free\b/, 'free must come from the endpoint');
});

test('AV-TC4: the tab is also honest about the printing it is OPEN on', () => {
  // Otherwise the small row for a printing would be more truthful than the
  // panel describing it. Verified deployed on a deck card: "Available to use /
  // 1 of 2 free".
  assert.match(code, /const thisPrintingCommitted = thisPrinting\?\.committed_qty \|\| 0/,
    'the open printing must know what is committed');
  assert.match(code, /t\('inspector\.availableToUse'\)/, 'the row must be labelled');
  assert.ok('inspector.availableToUse' in en && 'inspector.availableOfOwned' in en,
    'both strings must exist');

  // THE ROW IS NO LONGER CONDITIONAL AT ALL.
  //
  // This used to assert the row was gated on `thisPrintingCommitted > 0` and
  // on nothing else -- a reachability guard, because an earlier version passed
  // while the row sat behind `false &&` and never rendered.
  //
  // The REQUIREMENT changed (2026-09-23). Zach: "there is an available to use
  // section in the yours tab for some cards (ones in decks) and not for other
  // cards (not in decks) available to use should always show." A row that
  // appears and disappears is one you have to notice rather than read; on a
  // card with nothing committed its absence read as missing data rather than
  // as zero.
  //
  // So the guard is now the stronger one: the row must not be gated by
  // ANYTHING. The old assertion would have made a correct fix look like a
  // regression, which is the trap this file has fallen into before.
  assert.doesNotMatch(code, /\.\.\.\(thisPrintingCommitted > 0/,
    'the availability row must NOT be conditional on the committed count');
  assert.match(code, /\[t\('inspector\.availableToUse'\),/,
    'it must be an unconditional entry in the rows array');
});

test('AV-TC4b: the "(x in decks)" parenthetical only appears when it is true', () => {
  // Zach: "for cards not in a deck the count should reflect appropriately and
  // for cards in decks it should reflect appropriately but also with (x in
  // decks) in parenthesis."
  //
  // So an uncommitted card reads "4 of 4 free" and a committed one reads
  // "1 of 4 free (3 in decks)". Rendering "(0 in decks)" would be noise
  // dressed as information -- the density complaint that caused the row to be
  // hidden in the first place, reintroduced in a smaller costume.
  assert.ok('inspector.availableOfOwnedInDecks' in en,
    'the committed-case string must exist');
  assert.match(en['inspector.availableOfOwnedInDecks'], /\{available\}/);
  assert.match(en['inspector.availableOfOwnedInDecks'], /\{owned\}/);
  assert.match(en['inspector.availableOfOwnedInDecks'], /\{committed\}/,
    'the parenthetical must interpolate the committed count');
  // The plain string must NOT mention decks: it is the one used when none are.
  assert.doesNotMatch(en['inspector.availableOfOwned'], /decks/,
    'the uncommitted string must not claim anything about decks');
  // And the component must actually choose between them on the committed
  // count. ASSERTS THE BRANCH, NOT THE VARIABLE NAME: this pinned the literal
  // `thisPrintingCommitted > 0` and went red when that per-printing figure was
  // replaced by the oracle-wide one -- the fix for Zach's "it should say 2 of
  // 3". The rule is that a card with nothing in a deck must not render the
  // parenthetical; which variable carries the count is an implementation
  // detail this test has no business freezing.
  assert.match(code, /inDecks > 0[\s\S]{0,200}availableOfOwnedInDecks'/,
    'the component must branch on whether anything is committed');

  // AND THE ZERO-FREE CASE USES THE SAME SENTENCE. It used to drop to a bare
  // "{count} in decks" -- a different shape that never said how many he owns.
  // Zach saw it on a 1-owned card in the deck view and read it as the fix not
  // having shipped at all. One question, one sentence shape.
  assert.doesNotMatch(code, /allInDecks/,
    'the zero-free case must use the same "x of y free (z in decks)" sentence');
});

test('AV-TC5: availability is the SERVER\'s number, not a second calculation', () => {
  // The component must not invent its own rule for what is free. One source,
  // or the sheet and the deck view start disagreeing about cardboard.
  assert.match(code, /thisPrinting\?\.quantity_available/,
    'the panel must read quantity_available from the server');
  // And the server must still be computing it.
  assert.match(route, /AS committed_qty/,
    'the endpoint must return committed_qty per printing');
  assert.match(route, /quantity_available: Math\.max\(0, \(p\.owned_qty \|\| 0\) - \(p\.committed_qty \|\| 0\)\)/,
    'and derive quantity_available from owned minus committed');
  // Only REAL boards reserve -- a considering entry is a shopping note and
  // must not make a card look unavailable.
  assert.match(route, /dc\.board IN \('commander', 'mainboard', 'sideboard'\)/,
    'considering entries must not count as committed');
});
