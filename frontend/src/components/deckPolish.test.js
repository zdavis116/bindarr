// WHAT SURVIVED PR 6I, AND WHAT DID NOT.
//
// This file used to assert the old in-builder deck screen: a Browse Collection
// results panel, a Deck Health panel positioned above the card list, and the
// two-column deck-detail layout. DeckView.jsx replaced that screen during the
// UI overhaul, and `resultsSource` became a `const = null` with no setter in
// c8572ab -- so the panel could not open, could not be closed, and the test
// asserting "there must be a way to dismiss the results panel" failed on every
// run from then on.
//
// IT WAS RED ON `main` FOR WEEKS. That is the actual cost: a permanently failing
// test teaches everyone to skim past a red suite, which is exactly how a real
// failure gets missed. Zach was told about it three times and rightly left it
// as a backlog item -- it was never a broken feature, only a test guarding a
// screen that no longer exists.
//
// So the dead plumbing is deleted from DeckBuilder.jsx and this file now guards
// the two things from PR 6I that ARE still live:
//
//   * the app-wide mobile rules (nav bar, breakpoint scoping)
//   * the rule that the client must never compute availability itself
//
// The deck-layout assertions are gone rather than rewritten, because the thing
// they described is gone. A test kept alive by loosening it until it passes is
// worse than no test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const builder = fs.readFileSync(path.join(here, 'DeckBuilder.jsx'), 'utf8');
const css = fs.readFileSync(path.join(here, '..', 'index.css'), 'utf8');

// ---------------------------------------------------------------------------
// The client must NEVER compute availability itself.
// ---------------------------------------------------------------------------
//
// The most important rule in the original file, and the one reason to keep this
// test at all. Availability spans every deck, its reservations and its
// allocations, so a locally-adjusted count is a SECOND implementation of that
// rule and will drift from the server's. This project has already been bitten
// twice by exactly that: the deck completion ring disagreeing with missing_cost,
// and the Yours tab reporting owned copies that were sleeved in other decks.

assert.ok(
  !/in_deck_qty\s*[-+]=/.test(builder),
  'the client must never mutate in_deck_qty — availability is the server\'s figure'
);
assert.ok(
  !/available_qty\s*[-+]=/.test(builder),
  'the client must never mutate available_qty — availability is the server\'s figure'
);

// ---------------------------------------------------------------------------
// The dead results panel must not come back.
// ---------------------------------------------------------------------------
//
// Not nostalgia: unreachable code that LOOKS live is what let this file assert a
// feature the app had already lost. If someone reintroduces the panel it must be
// wired for real -- a source that can actually be set -- not restored as scenery.

assert.ok(
  !/const resultsSource = null/.test(builder),
  'resultsSource must not return as a const that nothing can set'
);
assert.ok(
  !/const runResultsSource\s*=/.test(builder) || /setResultsSource\(/.test(builder),
  'if the results panel returns, it must have a setter that can actually open it'
);

// ---------------------------------------------------------------------------
// The mobile rules that are still app-wide.
// ---------------------------------------------------------------------------
//
// The deck-column rules went with the old screen, but the nav bar is shared by
// every screen and the breakpoint scoping still protects the desktop view.

const mobileBlock = css.slice(css.indexOf('PR 6I item 4'));
assert.ok(mobileBlock.length > 0, 'the mobile block must exist');

assert.ok(
  /@media \(max-width: 768px\)/.test(mobileBlock),
  'the mobile rules must be scoped to a phone breakpoint'
);

// The bottom nav fits or scrolls DELIBERATELY, rather than truncating
// "Settings" to "Setting…".
assert.ok(
  /\.nav-tabs[\s\S]{0,200}overflow-x:\s*auto/.test(mobileBlock),
  'the bottom nav must scroll deliberately rather than squeezing its labels'
);
assert.ok(
  /\.nav-tab\s*\{[\s\S]{0,160}white-space:\s*nowrap/.test(mobileBlock),
  'nav labels must not be squeezed into truncation'
);

// THE DESKTOP VIEW IS NOT RESTYLED. Every rule added for phones lives inside a
// max-width query; anything outside it changes the desktop layout too.
const outsideMediaQuery = mobileBlock.split('@media (max-width: 768px)')[0];
assert.ok(
  !/\.nav-tabs\s*\{/.test(outsideMediaQuery),
  'no nav layout rule may apply outside the phone breakpoint'
);

console.log('DeckBuilder post-overhaul self-check passed');
