// A FULL-SCREEN OVERLAY MUST ACTUALLY BE ON TOP.
//
// Zach, twice, about the Scanned page:
//   "the header is overlapping the top and there is no add but at all"
//   "Scanned page is still not functional no add all or you can see some of
//    the other buttons are covered"
//
// I fixed the wrong thing the first time. The safe-area padding was a real bug
// -- the header did run under the notch -- but it was not what hid Add All. His
// second screenshot shows the app's own header and the Dashboard/Add Cards/
// Collection nav bar rendering ON TOP of the staged list, and no amount of
// padding moves another element's stacking order.
//
// THE ACTUAL BUG. ScanStagingReview is `position: fixed; inset: 0` with
// zIndex 120. The global bottom nav in index.css is `z-index: 1000` and is
// OPAQUE. A lower z-index loses, so the nav painted over the bottom strip of
// the overlay -- which is exactly where the commit bar lives. Add All was
// rendering the entire time and was physically unreachable underneath it.
//
// WHY A TEST RATHER THAN JUST THE FIX. This is invisible to every other kind of
// check: the component renders, the button exists in the DOM, the tests pass,
// the bundle contains it. Only a human looking at a phone can see it, and that
// human is Zach, which makes the feedback loop him losing an evening. Pinning
// the numeric relationship is the only automatic way to catch it.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..');

let passed = 0;
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

const css = readFileSync(join(src, 'index.css'), 'utf8');
const staging = readFileSync(join(src, 'components', 'ScanStagingReview.jsx'), 'utf8');

// Highest z-index among the PERSISTENT app chrome -- the things that are on
// screen the whole time and therefore compete with a full-screen overlay. Read
// from the stylesheet rather than hardcoded, so raising the nav later fails this
// test instead of silently re-burying the button.
//
// Transient floating elements are excluded deliberately. `.move-active-banner`
// sits at 9999 and SHOULD: it is a short-lived toast that belongs above
// everything including this overlay. Requiring the overlay to beat it would be
// an arms race with no correct answer.
// `.toast` (2000) is the same category: a transient notification that must be
// visible even over a full-screen screen, including this one.
const TRANSIENT = ['.move-active-banner', '.toast'];

function maxPersistentZIndex(text) {
  // Split into rules so each z-index can be attributed to its selector.
  const rules = text.split('}');
  let max = 0;
  let owner = null;
  for (const rule of rules) {
    const m = rule.match(/z-index:\s*(\d+)/);
    if (!m) continue;
    if (TRANSIENT.some(sel => rule.includes(sel))) continue;
    const z = Number(m[1]);
    if (z > max) { max = z; owner = rule.split('{')[0].trim().split('\n').pop().trim(); }
  }
  return { max, owner };
}

// The overlay's own z-index, as written in the component.
function overlayZIndex(text) {
  const m = text.match(/position:\s*'fixed',\s*inset:\s*0[\s\S]{0,900}?zIndex:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

// TC1: the overlay declares a z-index at all. A fixed, full-screen element with
// no stacking order is at the mercy of document order.
{
  const z = overlayZIndex(staging);
  assert.ok(Number.isFinite(z), 'the staging overlay must declare an explicit zIndex');
  pass('OVR-TC1', 'the staged-scans overlay sets an explicit z-index');
}

// TC2: THE REGRESSION. It must beat every z-index in the global stylesheet,
// including the opaque bottom nav at 1000 that hid the Add All button.
{
  const overlay = overlayZIndex(staging);
  const { max: chrome, owner } = maxPersistentZIndex(css);
  assert.ok(
    overlay > chrome,
    `the staged-scans overlay (z-index ${overlay}) must sit above the persistent `
    + `app chrome (highest is ${chrome}, from \`${owner}\`). Below it, the opaque `
    + 'bottom nav paints over the commit bar and Add All becomes unreachable -- '
    + 'which is exactly what Zach reported twice.',
  );
  pass('OVR-TC2', 'the overlay outranks every z-index in the global stylesheet');
}

// TC3: the commit bar is not the last thing in a scrolling container -- it must
// be a sibling of the scroll area, or a long session pushes it off-screen even
// with the stacking fixed. Two different ways to lose the same button.
{
  const scrollArea = staging.indexOf("overflowY: 'auto'");
  const commitBar = staging.indexOf('stagingAddAll');
  assert.ok(scrollArea > 0 && commitBar > 0, 'both the scroll area and commit bar exist');
  assert.ok(
    commitBar > scrollArea,
    'the commit bar must come AFTER the scrolling list, as a flex sibling, so it '
    + 'stays pinned to the bottom rather than scrolling away with the rows',
  );
  pass('OVR-TC3', 'the commit bar sits outside the scrolling list');
}

// TC4: the safe-area handling from the first fix is still there. It was a real
// bug (the header ran under the notch) even though it was not the one that hid
// Add All -- and removing it while chasing this one would just restore it.
{
  assert.ok(
    staging.includes('safe-area-inset-top'),
    'the overlay must still pad for the notch',
  );
  assert.ok(
    staging.includes('safe-area-inset-bottom'),
    'the overlay must still pad for the home indicator',
  );
  pass('OVR-TC4', 'safe-area padding for the notch and home bar is retained');
}

console.log(`\nstaging-overlay-stacking.test.js: ${passed} cases passed`);
