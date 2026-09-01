// THE MODAL'S CLOSE BUTTON MUST NOT SCROLL AWAY.
//
// Zach: "The modal is missing an x button when trying to close modal and I
// think it would make sense for the section below the 3 tabs to be the
// scrollable area"
//
// Both complaints are one CSS fact:
//
//     .card-inspector { overflow-y: auto; position: relative; }
//
// The X is position:absolute inside that scrolling box, so it was anchored to
// the CONTENT and left the screen on scroll. His screenshot caught it as a
// faint oval, already half hidden behind the card art.
//
// The same fact scrolled the art and the tab bar away too, so after reading
// rules text he could not see which tab he was on or flip the card.
//
// Fixed structurally: the panel no longer scrolls. It is a flex column with a
// fixed header (art, name, tabs, close button) above one scrolling region.
//
// THIS TEST CHECKS CONTAINMENT, NOT SYNTAX. While building it I twice had a
// version that compiled cleanly with the scroller NESTED INSIDE the header --
// which would have shipped the exact bug being fixed. A passing build proves
// braces balance and nothing else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'CardInspectorModal.jsx'), 'utf8');
const css = readFileSync(join(here, '../index.css'), 'utf8');

// Balance <div> tags to find where a region really ends.
function span(marker) {
  const start = src.indexOf(marker);
  if (start < 0) return [-1, -1];
  let depth = 0;
  for (let k = start; k < src.length; k++) {
    if (src.startsWith('<div', k)) { depth++; k += 3; }
    else if (src.startsWith('</div>', k)) {
      depth--;
      if (depth === 0) return [start, k];
      k += 5;
    }
  }
  return [start, -1];
}

const [headStart, headEnd] = span('<div className="ci-head">');
const [scrollStart, scrollEnd] = span('<div className="ci-scroll">');

function region(needle) {
  const i = src.indexOf(needle);
  assert.ok(i > 0, `could not find ${needle}`);
  if (i > headStart && i < headEnd) return 'head';
  if (i > scrollStart && i < scrollEnd) return 'scroll';
  return 'outside';
}

test('CIL-TC1: the panel itself does not scroll', () => {
  const i = css.indexOf('.card-inspector {');
  assert.ok(i > 0);
  // Strip comments first: the rule carries an explanatory comment that
  // MENTIONS overflow-y:auto, and matching prose instead of declarations is
  // how a test reports a bug that is not there.
  const rule = css.slice(i, css.indexOf('}', i)).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rule, /overflow-y:\s*auto/,
    'a scrolling panel carries its absolutely-positioned close button off '
    + 'the screen -- this is exactly what Zach reported as a missing X');
  assert.match(rule, /overflow:\s*hidden/,
    'the panel clips; only .ci-scroll scrolls');
});

test('CIL-TC2: header and scroller are siblings, not nested', () => {
  assert.ok(headStart > 0, 'the header must exist');
  assert.ok(scrollStart > 0, 'the scrolling region must exist');
  assert.ok(headEnd < scrollStart,
    'the scroller must not be INSIDE the header -- nested, the header scrolls '
    + 'with it and the fix does nothing. Two of my attempts compiled fine in '
    + 'exactly that broken shape');
});

test('CIL-TC3: the close button is outside the scrolling region', () => {
  assert.equal(region('<X size={16} />'), 'outside',
    'the X must not live in anything that scrolls');
});

test('CIL-TC4: the tabs stay fixed and every panel scrolls', () => {
  assert.equal(region("['card', t('inspector.tabCard')"), 'head',
    'you must always be able to see which tab you are on');

  for (const [label, needle] of [
    ['card tab', "{tab === 'card' && ("],
    ['yours tab', "{tab === 'yours' && (<>"],
    ['decks tab', "{tab === 'decks' && ("],
  ]) {
    assert.equal(region(needle), 'scroll',
      `${label} content must be inside the scrolling region`);
  }
});

test('CIL-TC5: the scroller can actually shrink', () => {
  // min-height:0 is load-bearing. A flex child defaults to min-height:auto,
  // which refuses to shrink below its content -- so the overflow escapes the
  // panel and grows it past the viewport instead of scrolling inside it. The
  // close button would then be off-screen again, by a different route.
  const i = css.indexOf('.card-inspector .ci-scroll');
  assert.ok(i > 0, 'the scroller rule must exist');
  const rule = css.slice(i, css.indexOf('}', i));
  assert.match(rule, /min-height:\s*0/,
    'without min-height:0 a flex child will not scroll');
  assert.match(rule, /overflow-y:\s*auto/);
});
