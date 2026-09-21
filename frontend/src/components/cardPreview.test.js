// THE HOVER/TAP CARD PREVIEW's positioning rule.
//
// Zach (2026-09-20): "on hover of card name show me card details", and he chose
// the printed card image alone.
//
// Positioning is the part that has failed before. Three tooltip attempts on the
// Curve tab were rejected because I picked a fixed corner and reasoned about it
// instead of measuring: bottom-left was a screen-width from the cursor, "beside
// the list" sat on the bars, and "below the chart" had 44px of room. Zach
// reviews at 1473x736 and 1855x731 -- SHORT screens, so vertical space is the
// scarce axis.
//
// These tests use his real viewports and assert the two things that actually
// break: the preview must stay fully on screen, and it must not cover the row
// being read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Geometry only -- a .jsx file cannot be imported by plain node, and the rule
// under test is pure anyway.
import { cardPreviewPosition, CARD_W, CARD_H } from './cardPreviewPosition.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// CARD_W / CARD_H are IMPORTED, not redeclared. A local copy would let the
// component change size while these tests kept checking the old number.

// Zach's real review sizes, plus his phone.
const VIEWPORTS = [
  { name: 'desktop 1473x736', width: 1473, height: 736 },
  { name: 'desktop 1855x731', width: 1855, height: 731 },
  { name: 'phone 390x844', width: 390, height: 844 },
];

const rowAt = (top, left = 40, width = 300) => ({
  top, left, right: left + width, width, height: 20, bottom: top + 20,
});

// ---------------------------------------------------------------------------
// CP-TC1: THE PREVIEW IS ALWAYS FULLY ON SCREEN.
//
// The failure this prevents is the one Zach reported as "the UI looking cut
// off": a box anchored to a row near an edge that runs past the fold. A card is
// 340px tall against a 731px-high window, so a row in the bottom third would
// overflow without clamping.
// ---------------------------------------------------------------------------
for (const vp of VIEWPORTS) {
  // Every row position from the very top to the very bottom.
  for (let top = -10; top <= vp.height + 10; top += 7) {
    const pos = cardPreviewPosition(rowAt(top), vp);
    assert.ok(pos.top >= 0,
      `CP-TC1 ${vp.name}: row at ${top} put the preview above the viewport (${pos.top})`);
    assert.ok(pos.top + CARD_H <= vp.height,
      `CP-TC1 ${vp.name}: row at ${top} ran the preview past the bottom `
      + `(${pos.top + CARD_H} > ${vp.height})`);
    assert.ok(pos.left >= 0,
      `CP-TC1 ${vp.name}: preview left edge off screen (${pos.left})`);
    assert.ok(pos.left + CARD_W <= vp.width,
      `CP-TC1 ${vp.name}: preview right edge off screen `
      + `(${pos.left + CARD_W} > ${vp.width})`);
  }
}

// ---------------------------------------------------------------------------
// CP-TC2: IT DOES NOT COVER THE NAME BEING HOVERED.
//
// A preview sitting on the row is the "beside the list sat on the bars" mistake
// again: you lose the thing you were pointing at, and on a touch screen it
// covers the next card you wanted to tap.
// ---------------------------------------------------------------------------
{
  const vp = { width: 1473, height: 736 };
  const row = rowAt(300, 40, 300);
  const pos = cardPreviewPosition(row, vp);
  const overlapsHorizontally =
    pos.left < row.right && (pos.left + CARD_W) > row.left;
  assert.equal(overlapsHorizontally, false,
    'CP-TC2 the preview must sit beside the row, not on top of it');
}

// ---------------------------------------------------------------------------
// CP-TC3: IT FLIPS TO THE SIDE THAT HAS ROOM.
//
// The right column's rows sit near the right edge; opening rightward there
// would push the card off screen, so it must open leftward instead. This is the
// case a fixed "always to the right" rule gets wrong, and it is exactly where
// Zach's eye goes -- the pre-built deck is the right-hand column.
// ---------------------------------------------------------------------------
{
  const vp = { width: 1473, height: 736 };

  // A row in the LEFT column: room on the right, so open right.
  const left = cardPreviewPosition(rowAt(300, 40, 300), vp);
  assert.ok(left.left >= 340,
    'CP-TC3 a left-column row should open to its right');

  // A row in the RIGHT column, hard against the edge: must open left.
  const rightRow = rowAt(300, vp.width - 320, 300);
  const right = cardPreviewPosition(rightRow, vp);
  assert.ok(right.left + CARD_W <= rightRow.left + 1,
    'CP-TC3 a right-column row must open to its LEFT, not off screen');
}

// ---------------------------------------------------------------------------
// CP-TC4: THE PHONE, where nothing fits beside a full-width row.
//
// 390px wide with a 244px card: there is no room to either side, so the rule
// must still produce something fully on screen rather than half off it. Zach
// tests on a phone, so this is not a corner case for him.
// ---------------------------------------------------------------------------
{
  const vp = { width: 390, height: 844 };
  const pos = cardPreviewPosition(rowAt(400, 16, 358), vp);
  assert.ok(pos.left >= 0 && pos.left + CARD_W <= vp.width,
    `CP-TC4 phone preview must stay on screen (left ${pos.left})`);
  assert.ok(pos.top >= 0 && pos.top + CARD_H <= vp.height,
    `CP-TC4 phone preview must stay on screen (top ${pos.top})`);
}

// ---------------------------------------------------------------------------
// CP-TC5: THE NAME IS REACHABLE WITHOUT A MOUSE.
//
// "Renders fine but is unreachable" is this project's most repeated UI failure,
// and a hover-only preview is unreachable by definition on the device Zach
// actually uses. The name must be a real button carrying tap AND keyboard
// handlers, with a visible focus ring.
// ---------------------------------------------------------------------------
{
  const modal = fs.readFileSync(
    path.join(here, 'DeckCompareModal.jsx'), 'utf8');
  const css = fs.readFileSync(path.join(here, '..', 'index.css'), 'utf8');

  assert.match(modal, /<button[\s\S]{0,400}className="mpc-name mpc-name-btn"/,
    'CP-TC5 the card name must be a button, not a span');
  for (const handler of ['onMouseEnter', 'onFocus', 'onClick']) {
    assert.ok(modal.includes(handler),
      `CP-TC5 the name button must handle ${handler}`);
  }
  // The ring must be a VISIBLE outline. Matching `outline:` alone was not
  // enough -- `outline: none` satisfied it, so the test passed while the ring
  // was stripped. Assert a real width/colour and reject the none/0 forms.
  const focusRule = css.match(/\.mpc-name-btn:focus-visible\s*\{([^}]*)\}/);
  assert.ok(focusRule, 'CP-TC5 the name button needs a focus-visible rule');
  assert.match(focusRule[1], /outline:\s*\d+px\s+\w+/,
    'CP-TC5 the focus ring must have a real width and style');
  assert.doesNotMatch(focusRule[1], /outline:\s*(none|0)\b/,
    'CP-TC5 the focus ring must not be stripped');
}

// ---------------------------------------------------------------------------
// CP-TC6: THE PREVIEW CANNOT BE CLIPPED, AND CANNOT EAT THE HOVER.
//
// Two rules that are invisible until they break. The rows live in a scrolling
// overflow-hidden column, so the preview must render through a portal; and it
// must not take pointer events, or moving the mouse toward it would swallow the
// hover and flicker.
// ---------------------------------------------------------------------------
{
  const preview = fs.readFileSync(path.join(here, 'CardPreview.jsx'), 'utf8');
  const css = fs.readFileSync(path.join(here, '..', 'index.css'), 'utf8');

  assert.match(preview, /createPortal\(/,
    'CP-TC6 the preview must render in a portal or the column will clip it');
  assert.match(css, /\.mpc-preview\s*\{[^}]*pointer-events:\s*none/,
    'CP-TC6 the preview must not intercept the pointer');
  // And it must not pretend to be clickable while pointer-events are off.
  // Matches a real JSX attribute (`onClick={`), not the word in a comment --
  // the comment above this rule explains it and would otherwise fail its own
  // test.
  assert.doesNotMatch(preview, /onClick\s*=\s*\{/,
    'CP-TC6 a click handler here is dead code: pointer-events is none');
}

console.log('PASS: CP-TC1 preview always fully on screen');
console.log('PASS: CP-TC2 preview never covers the hovered row');
console.log('PASS: CP-TC3 preview flips to the side with room');
console.log('PASS: CP-TC4 phone keeps the preview on screen');
console.log('PASS: CP-TC5 card name reachable by tap and keyboard');
console.log('PASS: CP-TC6 portal-rendered and pointer-transparent');
