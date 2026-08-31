// OVERLAY CONTROLS MUST NOT SIT ON TOP OF EACH OTHER.
//
// Zach: "for the scanned button when I click it on full screen mode nothing
// happens I want it to take me to the page."
//
// THE BUG. The "N scanned" badge and the torch button were both positioned at
// `top: 1rem; right: 1rem` inside the fullscreen preview. They occupied the
// same coordinates, so tapping the badge hit whichever element won -- the
// torch. The badge was not broken and its handler was fine; it was simply
// underneath something else.
//
// A HIGHER z-index WOULD NOT HAVE FIXED IT RELIABLY, which is the trap. The
// badge already had zIndex 21 against the torch's 20. Stacking order decides
// what PAINTS on top, and it does decide hit-testing between siblings -- but
// two controls sharing one spot means one of them is always unreachable to a
// thumb aiming at the other, and any later reshuffle silently swaps which. The
// fix is that they must not share the coordinates at all.
//
// WHY A TEST. Same reason as stagingOverlayStacking: this is invisible to unit
// tests, to the build, and to the bundle. Both buttons render, both have
// handlers, everything passes. Only a human with a phone finds it, and that
// human is Zach -- who has now reported an unreachable control three separate
// times. Positions are the one part a machine can check.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const scanner = readFileSync(join(here, 'CameraScanner.jsx'), 'utf8');

let passed = 0;
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// Pull every absolutely-positioned overlay control's anchor out of the source.
// Deliberately crude: it reads the literal `top:`/`right:`/`left:` strings, which
// is exactly what a human comparing two style blocks would do.
// Pull every absolutely-positioned overlay control's anchor out of the source.
//
// PARSED FROM THE STYLE BLOCK, COMMENTS STRIPPED FIRST. An earlier version of
// this matched a 400-character window after `position: 'absolute'` and found
// only two blocks out of a dozen -- the real ones carry long explanatory
// comments between the properties, so the window ran out before reaching `top`.
// It passed with the bug deliberately reintroduced, which is worse than no test
// at all: it would have reported the collision as fixed.
//
// Verified by re-introducing the overlap and watching TC1 fail.
// Reduce a style value to WHERE IT LANDS, not how it is written.
//
// The torch read `calc(1rem + ${fullscreenScan ? 'env(...)' : '0px'})` and the
// badge read `calc(1rem + env(...))`. Textually different, same position -- so
// a naive string comparison reported no collision while the two buttons were
// sitting on top of each other. Stripping the safe-area terms and the dead
// fullscreen ternary leaves the offset that actually decides the layout.
function normalise(v) {
  return v
    .replace(/\$\{[^}]*\}/g, '')            // interpolated expressions
    .replace(/env\([^)]*\)/g, '')            // safe-area insets: same for both
    .replace(/[`'"]/g, '')
    .replace(/calc\(|\)/g, '')
    .replace(/\+/g, ' ')
    .replace(/\b0px\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function anchors(text) {
  // Strip line comments so prose between properties cannot push the values out
  // of range or contribute false matches.
  const code = text.replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  const re = /position:\s*'absolute',/g;
  let m;
  while ((m = re.exec(code))) {
    // Read to the end of this style object, not a fixed character budget.
    const rest = code.slice(m.index, m.index + 1200);
    const end = rest.indexOf('}}');
    const block = end > 0 ? rest.slice(0, end) : rest;
    const top = (block.match(/top:\s*([^,\n]+)/) || [])[1];
    const right = (block.match(/right:\s*([^,\n]+)/) || [])[1];
    const left = (block.match(/left:\s*([^,\n]+)/) || [])[1];
    if (top && (right || left)) {
      out.push({
        top: normalise(top),
        side: right ? `right:${normalise(right)}` : `left:${normalise(left)}`,
      });
    }
  }
  return out;
}

// TC1: THE REGRESSION. No two top-anchored overlay controls may share an exact
// anchor. Sharing one is how the Scanned badge became untappable.
{
  const seen = new Map();
  const clashes = [];
  for (const a of anchors(scanner)) {
    const key = `${a.top} | ${a.side}`;
    if (seen.has(key)) clashes.push(key);
    else seen.set(key, a);
  }
  assert.deepStrictEqual(
    clashes, [],
    `two overlay controls share an anchor (${clashes.join('; ')}). They stack on `
    + 'the same coordinates, so one is unreachable to a thumb aiming at the other '
    + '-- which is how the "N scanned" badge silently toggled the torch instead '
    + 'of opening the staged list.',
  );
  pass('OVL-TC1', 'no two overlay controls share the same anchor position');
}

// TC2: the Scanned badge still opens the staged list. The handler is the point
// of the control; a badge that shows a count and does nothing is worse than no
// badge, because it implies the session is reachable when it is not.
{
  const badge = scanner.indexOf("t('scan.stagingBadge'");
  assert.ok(badge > 0, 'the staged-count badge must exist');
  const before = scanner.slice(Math.max(0, badge - 2500), badge);
  assert.ok(
    before.includes('setShowStaging(true)'),
    'the staged-count badge must open the staged list when tapped',
  );
  pass('OVL-TC2', 'the Scanned badge opens the staged list');
}

// TC3: auto-scan is a constant, not state. Zach: "I just want it always on no
// more click to capture button." It used to be state that ALSO reset itself to
// false whenever the camera stopped, which is why it kept switching off between
// sessions.
{
  assert.ok(
    /const autoScan = true;/.test(scanner),
    'auto-scan must be a constant, so nothing can turn it off',
  );
  assert.ok(
    !/setAutoScan\(/.test(scanner.replace(/\/\/.*$/gm, '')),
    'nothing may call setAutoScan -- auto-scan is permanent',
  );
  pass('OVL-TC3', 'auto-scan is permanently on and cannot be switched off');
}

// TC4: fullscreen is a constant too, and the toggle is gone. A
// maximize/minimize control would exit to a layout that no longer exists.
{
  assert.ok(
    /const fullscreenScan = true;/.test(scanner),
    'the scanner must be fullscreen always',
  );
  assert.ok(
    !/setFullscreenScan\(/.test(scanner.replace(/\/\/.*$/gm, '')),
    'nothing may toggle fullscreen off',
  );
  pass('OVL-TC4', 'the scanner is fullscreen-only with no toggle');
}

// TC5: no manual capture button. The tap-anywhere overlay is the manual path,
// and it stays -- it is what makes a forced rescan possible.
{
  assert.ok(
    !scanner.includes("t('scan.captureIdentify')"),
    'the Capture & Identify button must be gone',
  );
  assert.ok(
    scanner.includes("t('scan.tapToScan')"),
    'but tapping the preview must still force a scan',
  );
  pass('OVL-TC5', 'the capture button is gone; tap-to-scan remains');
}

// TC6: THERE IS ALWAYS A WAY OUT OF THE CAMERA.
//
// Zach: "there is no button to get out of the camera so if I go in there and
// scan no cards I can't back out of it."
//
// A Stop button always existed -- in the control bar BELOW the preview, which
// the fullscreen camera covers. That was survivable while fullscreen was a
// toggle, because the maximize control was a second exit. Making fullscreen
// permanent deleted the toggle and left the only door off-screen, so scanning
// nothing meant being stuck.
//
// This is the third control Zach has reported as unreachable (Add All under the
// nav, the Scanned badge under the torch, now the exit below the fold). The
// pattern is always the same: the element renders, its handler is correct, and
// it is somewhere a thumb cannot get to. So the property to pin is not "a stop
// handler exists" -- it is that an exit is rendered INSIDE the preview overlay,
// where the camera cannot cover it.
{
  // The overlay region: everything drawn on top of the video.
  const overlayStart = scanner.indexOf('camera-preview-wrapper camera-active');
  assert.ok(overlayStart > 0, 'the preview wrapper must exist');
  const overlay = scanner.slice(overlayStart, overlayStart + 20000);

  // An absolutely-positioned control inside the preview that stops the camera.
  const exitInFrame = /position:\s*'absolute'[\s\S]{0,600}?stopCamera\(\)|stopCamera\(\)[\s\S]{0,600}?position:\s*'absolute'/.test(overlay);
  assert.ok(
    exitInFrame,
    'the fullscreen preview must render its own exit control -- a Stop button '
    + 'below the preview is covered by the camera and leaves Zach trapped',
  );
  pass('OVL-TC6', 'the camera has an exit control inside the preview');
}

// TC7: and the phone's back gesture also leaves the camera, so the escape does
// not depend on one button rendering correctly.
{
  assert.ok(
    /useBackGuard\(cameraActive/.test(scanner),
    'the hardware back / swipe gesture must also close the camera',
  );
  pass('OVL-TC7', 'the back gesture is a second way out of the camera');
}

console.log(`\nscanner-overlay-controls.test.js: ${passed} cases passed`);
