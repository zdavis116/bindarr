// FIXED-POSITION SURFACES MUST SIT ABOVE THE NAV BAR.
//
// This is the seventh control on this project that rendered, was wired
// correctly, passed every existing test, and could not be used:
//
//   1. Add All            -- under the nav bar
//   2. Scanned badge      -- sharing an anchor with the torch
//   3. Camera exit        -- below the fold
//   4. Manual search box  -- styled by a class that matched no rule
//   5. ManualCardSearch   -- a component that did not exist (caught by lint)
//   6. New deck modal     -- z-index 200 under a z-index 1000 nav
//   7. Buylist bar        -- z-index 60 under the same nav
//
// Six and seven happened in ONE session, after I had already named this as my
// blind spot. So it stops being something to remember and becomes something a
// machine checks.
//
// THE RULE: the pinned mobile nav bar is z-index 1000 (index.css). Anything
// with `position: fixed` that a user must SEE or TAP has to be above it.
// Backdrops that belong behind a sheet are exempt and listed by name.
//
// WHAT THIS CANNOT DO: it reads z-index numbers, not rendered geometry. It
// cannot tell whether an element is below the fold, whether a parent has
// `overflow: hidden`, or whether two things overlap. Only a human with a phone
// catches those. This closes one specific, repeated, mechanical hole.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..');

const css = readFileSync(join(src, 'index.css'), 'utf8');

// Read the nav's z-index from the stylesheet rather than hardcoding it, so
// this test cannot drift away from the thing it is protecting against.
function navZIndex() {
  const i = css.indexOf('.nav-tabs {');
  assert.ok(i > 0, '.nav-tabs rule not found in index.css');
  // The pinned mobile variant sets its own z-index inside a media query.
  const m = css.slice(i).match(/z-index:\s*(\d+)/);
  assert.ok(m, 'no z-index found for the nav bar');
  return Number(m[1]);
}

// Surfaces that are DELIBERATELY behind something else. Each needs a reason:
// an unexplained allowlist grows until the check stops meaning anything.
const ALLOWED = new Map([
  // Full-screen tap catchers that must sit BEHIND their own menu/sheet but
  // above the page. They are not controls; they exist to be tapped anywhere.
  ['catcher', 'invisible tap-to-dismiss layer, belongs behind its own menu'],
]);

function jsxFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsxFiles(p));
    else if (e.name.endsWith('.jsx')) out.push(p);
  }
  return out;
}

test('ZIDX-TC1: the nav bar z-index is readable from the stylesheet', () => {
  const z = navZIndex();
  assert.ok(z >= 100, `expected a real stacking value, got ${z}`);
});

test('ZIDX-TC2: no fixed BOTTOM bar hides under the nav bar', () => {
  // The exact shape of failures 6 and 7: position fixed, pinned to bottom or
  // covering the screen, with a z-index below the nav.
  const nav = navZIndex();
  const problems = [];

  for (const file of jsxFiles(join(src, 'components'))) {
    const code = readFileSync(file, 'utf8');

    // Find style objects that are position:'fixed' and carry a zIndex.
    for (const m of code.matchAll(/position:\s*'fixed'[^}]*?zIndex:\s*(\d+)/g)) {
      const z = Number(m[1]);
      if (z >= nav) continue;

      // Is this block anchored to the bottom or covering the viewport? Those
      // are the ones that collide with the nav.
      const block = m[0];
      const anchored = /bottom:\s*0/.test(block) || /inset:\s*0/.test(block);
      if (!anchored) continue;

      const name = file.split('/').pop();
      const isCatcher = /inset:\s*0/.test(block) && !/background:\s*'var\(/.test(block);
      if (isCatcher && ALLOWED.has('catcher')) continue;

      problems.push(`${name}: fixed surface at zIndex ${z}, below the nav bar (${nav})`);
    }
  }

  assert.deepEqual(problems, [],
    'These fixed surfaces sit UNDER the pinned nav bar, so they are invisible '
    + 'and untappable on a phone -- the bug that hid the new-deck modal and the '
    + 'buylist bar:\n  ' + problems.join('\n  '));
});
