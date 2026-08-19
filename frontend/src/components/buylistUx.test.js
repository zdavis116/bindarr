// PR 7A — the multi-deck buylist's presentation fixes.
//
// WHAT THESE CAN AND CANNOT PROVE, stated plainly, in the same style as
// deckPolish.test.js.
//
// DeckBuilder.jsx is a 4000-line component and this repo has no render harness,
// so these are SOURCE CONTRACT assertions. They prove the wiring exists and
// that the three specific mistakes this PR fixes cannot silently come back:
//
//   * the entry point is named for the OUTCOME ("Build a buylist"), not for the
//     mechanism ("Select decks")
//   * selected decks are marked on the deck itself in BOTH view modes, not only
//     by a checkbox, and in the table view a checkbox exists at all
//   * the selected marker costs ZERO width, so it cannot reintroduce the
//     horizontal overflow PR 6I fixed on a phone
//
// They CANNOT prove that the yellow is legible, that the ring reads as
// "selected" at a glance, or that anything fits an iPhone 16. Those need Zach's
// eyes on a real phone, and the report for this PR says so rather than implying
// the tests covered it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const builder = fs.readFileSync(path.join(here, 'DeckBuilder.jsx'), 'utf8');
const panel = fs.readFileSync(path.join(here, 'MissingCardsPanel.jsx'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'locales', 'en.json'), 'utf8'));

// ---------------------------------------------------------------------------
// PROBLEM 1 — the entry point names the GOAL, not the mechanism.
// ---------------------------------------------------------------------------

// The string he reads BEFORE entering the flow must describe the outcome. The
// old wording ("Select decks") told him to perform a step without ever saying
// what the step was for; he only learned the purpose after ticking boxes.
assert.match(
  en['deck.multiBuylistSelect'],
  /buylist/i,
  'the entry-point label must name the buylist — the outcome — not the selection step'
);
assert.doesNotMatch(
  en['deck.multiBuylistSelect'],
  /^select/i,
  'the entry point must not be named for the first interaction inside the flow'
);

// And the toolbar button must actually use that key, with a way back out once
// the mode is active. A mode entered from a button that does not release it is
// the "panel with no exit" defect class.
assert.ok(
  /deck\.multiBuylistSelect/.test(builder) && /deck\.multiBuylistCancel/.test(builder),
  'the toolbar button must show the build label when idle and a cancel label while selecting'
);
assert.ok(
  typeof en['deck.multiBuylistCancel'] === 'string',
  'the cancel label must exist in en.json'
);

// Deck selection is presented as a STEP INSIDE the flow, so the panel states
// what the ticking is for rather than leaving it implicit.
assert.ok(
  typeof en['deck.multiBuylistStepHint'] === 'string'
    && /buylist/i.test(en['deck.multiBuylistStepHint']),
  'the selection panel must state that ticking decks feeds the buylist'
);
assert.ok(
  /deck\.multiBuylistStepHint/.test(builder),
  'the step hint must actually be rendered in the selection panel'
);

// ---------------------------------------------------------------------------
// PROBLEM 2 — selected decks are unmistakable in BOTH view modes.
// ---------------------------------------------------------------------------

// Both branches of the view-mode switch must derive a selected flag. Without
// this the only feedback is a checkbox, which he reported was not enough — and
// the cost of missing it is shopping for a deck he never meant to include.
const gridBranch = builder.slice(
  builder.indexOf("deckSelectionViewMode === 'grid'"),
  builder.indexOf('--- TABLE VIEW ---') > -1
    ? builder.indexOf('--- TABLE VIEW ---')
    : builder.indexOf('<thead>')
);
const tableBranch = builder.slice(
  builder.indexOf('<thead>'),
  builder.indexOf('</table>')
);

for (const [name, source] of [['grid', gridBranch], ['table', tableBranch]]) {
  assert.ok(
    /const isSelected\s*=\s*selectMode && selectedDeckIds\.includes\(deck\.id\)/.test(source),
    `the ${name} view must derive a selected flag from the real selection`
  );
  assert.ok(
    /isSelected\s*\?/.test(source),
    `the ${name} view must style the deck itself on that flag, not only the checkbox`
  );
}

// THE TABLE VIEW HAD NO CHECKBOX AT ALL. Its only selection feedback was the
// counter in the panel above, which is not on the row he just tapped.
assert.ok(
  /type="checkbox"/.test(tableBranch),
  'the table view must offer a checkbox on the row, as the grid view already does'
);

// SELECTION MUST SURVIVE HOVER. Both views set background/boxShadow imperatively
// on mouse events, so a naive handler resetting to the unselected value would
// erase the selected look under the pointer — worse than no marker at all.
assert.ok(
  /onMouseLeave=\{e => \{[\s\S]{0,400}?isSelected/.test(gridBranch),
  'leaving a hovered grid card must restore its selected ring, not clear it'
);
assert.ok(
  /onMouseLeave=\{e => e\.currentTarget\.style\.background = restingBackground\}/.test(tableBranch),
  'leaving a hovered table row must restore its selected background, not go transparent'
);

// ---------------------------------------------------------------------------
// MOBILE — the selected marker must cost ZERO width.
//
// PR 6I fixed horizontal overflow on an iPhone 16. A wider border or an extra
// table column on the selected state would reintroduce exactly that, and it
// would only show up on the phone, only while selecting.
// ---------------------------------------------------------------------------

// The markers are inset box-shadows, which paint inside the existing box and do
// not participate in layout.
assert.ok(
  /boxShadow: isSelected \? 'inset /.test(gridBranch),
  'the grid selected ring must be an INSET shadow — it must not add width'
);
assert.ok(
  /boxShadow: isSelected \? 'inset /.test(tableBranch),
  'the table selected bar must be an INSET shadow — a real left border would widen the table'
);

// The border stays 1px in every state; only its colour changes.
const gridBorders = gridBranch.match(/'\d+(?:\.\d+)?px solid [^']+'/g) || [];
for (const border of gridBorders) {
  assert.ok(
    /^'1px /.test(border),
    `every deck-card border must stay 1px so selection cannot change the card's box (saw ${border})`
  );
}

// No new table column: the tick goes inside the existing first cell.
const headerCells = (tableBranch.match(/<th /g) || []).length;
assert.strictEqual(
  headerCells, 6,
  'the table must keep its six columns — an extra selection column would widen it on a phone'
);

// ---------------------------------------------------------------------------
// PROBLEM 3 — the generated list says what it covers.
// ---------------------------------------------------------------------------

assert.ok(
  /buylistCoverage/.test(panel),
  'the panel must render the coverage line for the combined buylist'
);
assert.ok(
  /deck\.multiBuylistCovers/.test(panel),
  'and it must use the coverage string'
);
assert.ok(
  typeof en['deck.multiBuylistCovers.one'] === 'string'
    && typeof en['deck.multiBuylistCovers.other'] === 'string',
  'the coverage string is counted, so it must exist as a plural pair'
);
for (const key of ['deck.multiBuylistCovers.one', 'deck.multiBuylistCovers.other']) {
  assert.ok(
    en[key].includes('{count}') && en[key].includes('{names}'),
    `${key} must carry both the count and the deck names — the names are what make the list self-describing`
  );
}

console.log('DeckBuilder PR 7A buylist-UX self-check passed');
