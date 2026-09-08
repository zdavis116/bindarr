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

test('AV-TC4: the tab is also honest about the printing it is OPEN on', () => {
  // Otherwise the small row for a printing would be more truthful than the
  // panel describing it. Verified deployed on a deck card: "Available to use /
  // 1 of 2 free".
  assert.match(code, /const thisPrintingCommitted = thisPrinting\?\.committed_qty \|\| 0/,
    'the open printing must know what is committed');
  assert.match(code, /t\('inspector\.availableToUse'\)/, 'the row must be labelled');
  assert.ok('inspector.availableToUse' in en && 'inspector.availableOfOwned' in en,
    'both strings must exist');

  // THE CONDITION MUST BE REACHABLE, not merely present.
  //
  // My first version asserted the label existed and passed with the row gated
  // behind `false && thisPrintingCommitted > 0` -- rendering nothing, forever,
  // while the test stayed green. That is this project's recurring UI blind
  // spot: a control that exists in the source and never reaches the screen.
  // Assert the spread is gated ONLY on the real condition.
  const spread = code.slice(code.indexOf('...(thisPrintingCommitted'),
                            code.indexOf("t('inspector.availableToUse')"));
  assert.match(spread, /^\.\.\.\(thisPrintingCommitted > 0\s*$/m,
    'the row must be gated on the committed count alone -- no constant that '
    + 'can silently disable it while the label still exists in the source');
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
