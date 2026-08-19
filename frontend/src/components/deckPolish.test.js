// PR 6I — the DeckBuilder half of the deck-polish fixes.
//
// WHAT THESE CAN AND CANNOT PROVE, stated plainly so nobody mistakes a green
// run here for "the mobile layout is fine".
//
// DeckBuilder.jsx is a 3800-line component with no render harness in this repo,
// so these are SOURCE CONTRACT assertions in the same style as the PR 6D/6G
// checks already in deckSections.test.js. They prove the wiring exists and that
// the specific mistakes this PR fixes have not come back:
//
//   * the results panel is re-read from the SERVER after a mutation, and is not
//     patched up locally (item 1)
//   * Browse Collection can actually be closed (item 4b)
//   * Deck Health sits above the card list (item 4c)
//   * the mobile layout rules exist and are scoped to phones (item 4)
//
// They CANNOT prove the page fits an iPhone 16, that nothing is clipped, or
// that the panel looks right. Those need Zach's eyes on a real phone, and the
// report for this PR says so explicitly rather than implying the tests covered
// it. Pixel truth is not assertable from here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const builder = fs.readFileSync(path.join(here, 'DeckBuilder.jsx'), 'utf8');
const css = fs.readFileSync(path.join(here, '..', 'index.css'), 'utf8');

// ---------------------------------------------------------------------------
// ITEM 1 — stale Browse Collection counts.
// ---------------------------------------------------------------------------

// The panel must be re-read after a mutation. loadDeckDetails is the single
// point every deck mutation in this file already funnels through, so hanging
// the refresh there is what makes "after ANY mutation" true by construction.
assert.ok(
  /const refreshResultsPanel\s*=/.test(builder),
  'there must be a function that re-reads the open results panel'
);
const loadDetails = builder.slice(
  builder.indexOf('const loadDeckDetails'),
  builder.indexOf('const writeRequirement')
);
assert.ok(
  /refreshResultsPanel\(\)/.test(loadDetails),
  'loadDeckDetails must refresh the open results panel — that is the choke point every mutation uses'
);

// AND IT MUST RE-READ FROM THE SERVER, not adjust the numbers locally.
//
// This is the requirement the spec is most emphatic about: availability now
// spans every deck, its reservations and its allocations, so a locally-adjusted
// count would be a SECOND implementation of that rule and would drift from the
// real one. The refresh path must therefore issue a real request.
const refreshBlock = builder.slice(
  builder.indexOf('const runResultsSource'),
  builder.indexOf('const handleSearchCards')
);
assert.ok(
  /fetch\(/.test(refreshBlock),
  'the refresh must re-read from the server, not recompute counts on the client'
);
assert.ok(
  /\/api\/collection/.test(refreshBlock) && /\/api\/search/.test(refreshBlock),
  'both panel sources (browse listing and catalogue search) must be re-readable'
);

// The client must never derive availability itself. A guard rather than a
// preference: this is the exact class of bug PR 6G removed, and re-adding a
// local subtraction here would quietly reintroduce it.
assert.ok(
  !/in_deck_qty\s*[-+]=/.test(builder),
  'the client must never mutate in_deck_qty — availability is the server\'s figure'
);
assert.ok(
  !/available_qty\s*[-+]=/.test(builder),
  'the client must never mutate available_qty — availability is the server\'s figure'
);

// ---------------------------------------------------------------------------
// ITEM 4b — Browse Collection can be closed.
// ---------------------------------------------------------------------------

assert.ok(
  /const closeResultsPanel\s*=/.test(builder),
  'there must be a way to dismiss the results panel'
);

// The button TOGGLES: pressing it while browse is open closes it. Previously it
// only ever opened the panel, which is why there was no way out.
assert.ok(
  /forceBrowse\s*&&\s*resultsSource\?\.mode === 'browse'/.test(builder),
  'pressing Browse Collection while the browse listing is open must close it'
);

// Closing must clear BOTH the rows and the source, or "nothing is showing"
// becomes two facts that can disagree.
const closeBlock = builder.slice(
  builder.indexOf('const closeResultsPanel'),
  builder.indexOf('const closeResultsPanel') + 400
);
assert.ok(
  /setSearchResults\(\[\]\)/.test(closeBlock) && /setResultsSource\(null\)/.test(closeBlock),
  'closing must clear both the results and the record of what was showing'
);

// An explicit dismiss affordance on the panel too, for the search case which
// the toggle does not cover.
assert.ok(
  /onClick=\{closeResultsPanel\}/.test(builder),
  'the results panel must carry an explicit close control'
);

// The toggle must SHOW its state, so the control says what pressing it will do.
assert.ok(
  /aria-pressed=\{resultsSource\?\.mode === 'browse'\}/.test(builder),
  'the Browse Collection toggle must report its pressed state'
);

// ---------------------------------------------------------------------------
// ITEM 4c — Deck Health sits ABOVE the card list.
// ---------------------------------------------------------------------------

const healthAt = builder.indexOf('Deck Health & Summary Status');
const cardListAt = builder.indexOf('Deck Cards Header & Display Mode Toggle');
const sideColumnAt = builder.indexOf('Right Column: Statistics');
assert.ok(healthAt > 0 && cardListAt > 0 && sideColumnAt > 0, 'all three landmarks must exist');
assert.ok(
  healthAt < cardListAt,
  'the Deck Health panel must appear BEFORE the card list, not after it'
);
assert.ok(
  healthAt < sideColumnAt,
  'Deck Health must have moved out of the right-hand statistics column'
);

// MOVED, NOT REBUILT. The style constraint is absolute: adapt in place, never
// replace a screen with a new component. The panel keeps its existing markup
// and its existing content.
assert.ok(
  /\{t\('deck\.healthTitle'\)\}/.test(builder),
  'the health panel must keep its existing title, not be rebuilt'
);
assert.ok(
  /activeDeck\.warnings/.test(builder.slice(healthAt, cardListAt)),
  'the moved panel must still render the server-computed rules warnings'
);

// The charts stay where they were — they are analysis, not status.
const sideColumn = builder.slice(sideColumnAt);
assert.ok(
  /Mana Curve/.test(sideColumn),
  'the mana curve must remain in the right-hand statistics column'
);

// ---------------------------------------------------------------------------
// ITEM 4 — the mobile layout fits the viewport.
//
// Asserting the CAUSE, not the symptoms. The page was wider than the screen
// because .deck-detail-main carries `flex: 2 1 500px` and a flex item's default
// `min-width: auto` refuses to shrink below its content — so on a 393px phone
// the column stayed ~500px wide and everything near the right edge went off it.
// A test that checked for five per-control overflow rules would be testing the
// symptoms Zach happened to photograph, and would pass while the sixth clipped
// control stayed broken.
// ---------------------------------------------------------------------------

const mobileBlock = css.slice(css.indexOf('PR 6I item 4'));
assert.ok(mobileBlock.length > 0, 'the PR 6I mobile block must exist');

assert.ok(
  /@media \(max-width: 768px\)/.test(mobileBlock),
  'the mobile rules must be scoped to a phone breakpoint'
);

// THE ROOT-CAUSE RULE.
assert.ok(
  /\.deck-detail-main[\s\S]{0,200}min-width:\s*0/.test(mobileBlock),
  'the deck columns must be allowed to shrink below their content width'
);
assert.ok(
  /\.deck-detail-main[\s\S]{0,200}flex:\s*1 1 100%/.test(mobileBlock),
  'the 500px flex-basis must be overridden on phones'
);

// The search row wraps rather than overflowing — the spec's own wording.
assert.ok(
  /\.deck-search-row[\s\S]{0,120}flex-wrap:\s*wrap/.test(mobileBlock),
  'the search row must wrap on a phone instead of running off the edge'
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

// THE DESKTOP VIEW IS NOT RESTYLED. The spec is explicit that it is correct and
// must not be touched, so every rule added here lives inside a max-width query.
const outsideMediaQuery = mobileBlock.split('@media (max-width: 768px)')[0];
assert.ok(
  !/\.deck-detail-main\s*\{/.test(outsideMediaQuery),
  'no deck layout rule may apply outside the phone breakpoint — the desktop view is correct'
);

// The classes the CSS targets must actually be on the elements.
assert.ok(
  /className="deck-detail-main"/.test(builder),
  'the left column must carry the class the mobile rules target'
);
assert.ok(
  /className="deck-detail-side"/.test(builder),
  'the right column must carry the class the mobile rules target'
);
assert.ok(
  /className="deck-search-row"/.test(builder),
  'the search row must carry the class the mobile rules target'
);

console.log('DeckBuilder PR 6I deck-polish self-check passed');
