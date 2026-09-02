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

// --- CIL-TC6: THE CLOSE BUTTON IS IN THE FLOW ------------------------------
//
// Zach reported the X missing TWICE, for two different reasons:
//
//   1. the panel scrolled, and an absolutely-positioned button anchored to the
//      content went with it
//   2. the header outgrew the viewport, so the panel's top -- and the button
//      pinned at top:1rem of it -- sat above the screen
//
// The shared cause is that position:absolute gives a control no relationship
// to the layout. It goes wherever its containing block's top goes, including
// off-screen, and no amount of fixing the SCROLLING addresses that.
//
// In the flex flow it cannot be anywhere the panel is not.

test('CIL-TC6: the close button is laid out, not absolutely positioned', () => {
  // ANCHOR ON THE ICON. Searching for onClick={handleClose} found the
  // OVERLAY's backdrop handler, not the button -- so two earlier versions of
  // this test asserted about the wrong element and stayed green while the
  // button was absolutely positioned. There is exactly one <X /> and it is
  // inside the close button by construction.
  const icon = src.indexOf('<X size={16} />');
  assert.ok(icon > 0, 'the close button must exist');

  const open = src.lastIndexOf('<button', icon);
  assert.ok(open > 0 && icon - open < 600,
    'the icon must sit inside a nearby button element');
  const tag = src.slice(open, icon);

  assert.doesNotMatch(tag, /position:\s*'absolute'/,
    'an absolute close button follows the panel off-screen when the panel '
    + 'does not fit -- Zach reported this twice as a missing X');
  assert.match(src.slice(Math.max(0, open - 500), open), /justifyContent: 'flex-end'/,
    'the button must sit in a laid-out flex row');
});

// --- CIL-TC7: THE PANEL MUST FIT, NOT JUST CLIP ----------------------------
//
// Zach: "the modal needs to fit better on the screen because the entire modal
// shouldn't be scrollable but since it doesn't fully fit in the screen it
// becomes scrollable"
//
// Two flex defaults were letting the panel outgrow its own max-height:
//
//   flex-wrap: wrap    -- a wrapped container sizes to its CONTENT, so when
//                         the columns could not sit side by side they stacked
//                         and the panel grew past 90vh
//   min-height: auto   -- flex children refuse to shrink below their content,
//                         so the card art dictated the panel's height and the
//                         scroller never got a bounded box

test('CIL-TC7: the panel cannot outgrow its max-height', () => {
  const i = css.indexOf('.card-inspector {');
  const rule = css.slice(i, css.indexOf('}', i)).replace(/\/\*[\s\S]*?\*\//g, '');

  assert.doesNotMatch(rule, /flex-wrap:\s*wrap/,
    'a wrapped flex container sizes to its content and escapes max-height');
  assert.match(rule, /flex-wrap:\s*nowrap/);
  assert.match(rule, /max-height:\s*90vh/);
});

test('CIL-TC8: both columns can shrink so the art never sets the height', () => {
  for (const sel of ['.card-inspector .ci-image-col',
                     '.card-inspector .ci-info-col']) {
    const i = css.indexOf(sel);
    assert.ok(i > 0, `${sel} must have a rule`);
    const rule = css.slice(i, css.indexOf('}', i));
    assert.match(rule, /min-height:\s*0/,
      `${sel} must be allowed to shrink, or its content dictates the panel `
      + 'height and pushes the close button off the top');
  }
});

// --- CIL-TC9: THE CARD ART IS BOUNDED BY HEIGHT ---------------------------
//
// Zach's screenshot showed the art PAINTED OVER the card name -- the image
// escaping its box, not merely being tall.
//
//     <img style={{ width: '100%', aspectRatio: 0.718 }} />
//
// width:100% + aspectRatio DERIVES the height from the width, so the image
// cannot shrink to fit a short screen. A max-height on the wrapper then clamps
// the BOX while the image keeps its computed height, and it overflows.
//
// Driving from height instead lets the card shrink; the width follows.

// --- CIL-TC11: THE PAGE BEHIND MUST NOT SCROLL ----------------------------
//
// "the whole window wants to scroll". Opening a modal does not stop the body
// scrolling, so a flick anywhere -- including on the dimmed backdrop -- drags
// the page underneath. That reads as the modal being too big even when it
// fits, because the thing that moves is the window.

test('CIL-TC11: body scroll is locked while the sheet is open', () => {
  assert.match(src, /body\.style\.overflow = 'hidden'/,
    'the page behind the modal must not scroll');
  assert.match(src, /body\.style\.overflow = previous/,
    'and the previous value must be restored on close, not hardcoded to '
    + "'auto' -- that would clobber a lock set by another modal");
});

test('CIL-TC12: the overlay leaves room and never scrolls itself', () => {
  const i = src.indexOf('className="modal-overlay"');
  const style = src.slice(i, i + 1100);
  assert.match(style, /env\(safe-area-inset-bottom/,
    'a full-bleed overlay puts the panel flush against the viewport edge; the '
    + 'safe-area insets matter on a phone with a notch or home bar');
  assert.match(style, /overflow:\s*'hidden'/,
    '.ci-scroll is the only scrolling region in this modal');
});

test('CIL-TC13: the panel is sized by the DYNAMIC viewport height', () => {
  // On iOS Safari `vh` is the LARGEST viewport, measured with the toolbars
  // retracted. With them showing, a 90vh panel is taller than the screen
  // actually offers and the page scrolls to reveal the rest -- which is what
  // Zach reported three times. `dvh` tracks the real usable height.
  const i = css.indexOf('.card-inspector {');
  const rule = css.slice(i, css.indexOf('}', i));
  assert.match(rule, /max-height:\s*100dvh/,
    'the panel must be bounded by the dynamic viewport height');
  assert.match(rule, /max-height:\s*90vh[\s\S]*max-height:\s*100dvh/,
    'the vh line must come FIRST as the fallback; browsers without dvh drop '
    + 'the second declaration and keep the first');
});

// --- CIL-TC9: THE CARD ART HAS A SIZE, NOT A CEILING ----------------------
//
// Zach: "when you switch the yours tab or flip the card the card image shrinks
// sometimes shrinks multiple times"
//
// A REPEATED shrink is a feedback loop, not a miscalculation:
//
//   .ci-image-col   flex: 0 1 auto   basis `auto` = measure the content
//   img             maxHeight only   a ceiling, never a size
//
// The image had no intrinsic height -- it was width:auto with an aspect ratio
// and a cap, so its height came from whatever space the layout offered. The
// column's basis then MEASURED that height. Every tab switch re-measured the
// already-shrunken image, took it as the new preferred size, and shrank again.
// Nothing ever pushed back up, so it ratcheted down with each interaction.
//
// The earlier version of this test asserted the cap-based sizing, which is why
// it could not catch this: it was pinning the cause.

test('CIL-TC9: the art is sized, not merely capped', () => {
  const wrap = src.indexOf('className="ci-image-wrap"');
  assert.ok(wrap > 0, 'the image wrapper must exist');
  // Anchor on the style block itself: a fixed character window from the
  // className misses it once explanatory comments sit in between.
  const styleStart = src.indexOf('style={{', wrap);
  const style = src.slice(styleStart, src.indexOf('}}', styleStart));

  // The exact number is Zach's call (he asked for 30% smaller); what this
  // test guards is that it IS a height and not a max-height. Matching the
  // shape, so a future resize does not have to touch the test.
  assert.match(style, /\bheight: 'min\(\d+vh, \d+px\)'/,
    'the wrapper needs a real height; a max-height is a ceiling and leaves the '
    + 'actual size to the layout, which then measures it back');
  assert.doesNotMatch(style, /maxHeight: 'min\(42vh, 420px\)'/,
    'a cap alone is what allowed the ratchet');
});

test('CIL-TC10: the image cannot feed its size back into the layout', () => {
  const img = src.indexOf('src={showBack && view.back_image_url');
  const style = src.slice(img, img + 500);
  assert.match(style, /height: '100%'/,
    'the image fills a wrapper that already has a size');
  assert.doesNotMatch(style, /aspectRatio/,
    'the aspect ratio belongs on the sized wrapper, not on the image -- on '
    + 'both it derives a second height that disagrees with the first');
});

test('CIL-TC11: neither image column may shrink to its content', () => {
  // flex-basis:auto means "measure the content", and the content is the image
  // whose height came from the previous layout. That is the loop.
  const col = src.indexOf('className="ci-image-col"');
  const style = src.slice(col, col + 220);
  assert.match(style, /flex: '0 0 auto'/,
    'the column must not shrink to fit its content');

  // And the mobile override, which carries !important and would win.
  const i = css.lastIndexOf('.card-inspector .ci-image-col');
  const rule = css.slice(i, css.indexOf('}', i));
  assert.match(rule, /flex:\s*0 0 auto\s*!important/,
    'the mobile rule beats the inline style, so it must agree with it -- this '
    + 'is the phone, where Zach actually sees the modal');
  assert.doesNotMatch(rule, /flex:\s*0 1 auto/,
    'allowing the column to shrink reinstates the ratchet');
});
