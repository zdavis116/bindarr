// Forcing a scan must run a MANUAL pass, on both surfaces.
//
// THE REPORT (Zach): "it seems to get stuck on printing is moving or something
// like that and also back to back of the same card. I would like to be able to
// force scanning on both desktop and mobile."
//
// Both symptoms are one cause. An auto pass is deliberately conservative in
// two ways a manual pass is not:
//
//   1. fastScanLoop:118 passes `requireStill: autoPass`, so an auto pass
//      refuses a frame whose corners moved more than STILL_DRIFT (0.012 of the
//      frame diagonal). A hand-held card can sit just above that forever --
//      "printing is moving".
//
//   2. fastScanLoop:186 begins `if (!autoPass) return true`, so the 4s window
//      that stops one card being staged twice ALSO stops a real second copy
//      being staged back to back.
//
// So the fix is not new scanning logic -- it is reaching the manual pass that
// already bypasses both. What matters is that the button stays MANUAL: pass
// `true` and it becomes an ordinary auto pass that hits both gates again, the
// button appears to do nothing, and nothing fails.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const scanner = readFileSync(join(HERE, 'CameraScanner.jsx'), 'utf8');
const desktop = readFileSync(join(HERE, 'DesktopScanLayout.jsx'), 'utf8');
const loop = readFileSync(join(REPO, 'frontend/src/utils/fastScanLoop.js'), 'utf8');

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// FORCE-TC1: the premise -- a manual pass really does bypass both gates.
//
// If either of these changes upstream, the force button silently stops being a
// force button. Asserting the mechanism here means that shows up as a failing
// test rather than as Zach reporting the same bug twice.
{
  start('FORCE-TC1');
  assert.match(loop, /requireStill: autoPass/,
    'the stillness gate must be tied to autoPass; if it applies to every pass, '
    + 'forcing a scan cannot get past "printing is moving"');
  assert.match(loop, /if \(!autoPass\) return true;/,
    'the dedupe window must be skipped on a manual pass; otherwise a genuine '
    + 'second copy of the same card still cannot be staged back to back');
  pass('FORCE-TC1', 'a manual pass bypasses the stillness gate and the dedupe window');
}

// FORCE-TC2: the desktop button runs a MANUAL pass.
{
  start('FORCE-TC2');
  assert.match(desktop, /onClick=\{onForceScan\}/,
    'the desktop needs a visible force control -- it has no tap-anywhere '
    + 'target like the phone');
  const wire = /onForceScan=\{\(\) => handleCaptureRef\.current\?\.\((false|true)\)\}/.exec(scanner);
  assert.ok(wire, 'onForceScan is not wired in CameraScanner');
  assert.strictEqual(wire[1], 'false',
    'the desktop force button must pass autoPass=false. Passing true makes it '
    + 'an ordinary auto pass that hits both gates again -- the button would '
    + 'appear to do nothing, and nothing would fail');
  pass('FORCE-TC2', 'the desktop force button runs a manual pass');
}

// FORCE-TC3: the phone has a VISIBLE control, not just the invisible tap.
//
// Tapping the preview always did this. A capability nothing announces is a
// capability that does not exist -- Zach asked for it on mobile while it was
// already there.
{
  start('FORCE-TC3');
  const calls = [...scanner.matchAll(/handleCaptureRef\.current\?\.\(false\)/g)];
  assert.ok(calls.length >= 2,
    `only ${calls.length} manual-pass call site(s); both the desktop button `
    + 'and a visible phone button must exist');
  // Matched loosely on purpose: the phone button carries a large inline style
  // block, and a tight character window made this assertion fail on a button
  // that was really there. Assert the two facts that matter -- a <button>
  // exists whose label is the force string, and it calls a manual pass.
  const btn = /<button[\s\S]*?t\('scan\.forceScan'\)[\s\S]*?<\/button>/.test(scanner);
  assert.ok(btn,
    'the phone needs a real button -- the full-screen invisible tap target is '
    + 'undiscoverable, which is why the feature was reported missing while it '
    + 'already worked');
  const en = JSON.parse(readFileSync(join(REPO, 'frontend/src/locales/en.json'), 'utf8'));
  assert.ok(en['scan.forceScan'],
    'scan.forceScan has no string; this app renders the KEY when one is '
    + 'missing, so the button would read "scan.forceScan"');
  pass('FORCE-TC3', 'the phone gets a visible force button too');
}

// FORCE-TC4: the control does not cover the message explaining the refusal.
//
// "printing is moving" appears in the status pill. A button on top of it hides
// the reason the scan was refused, which is the one thing worth reading.
{
  start('FORCE-TC4');
  const css = readFileSync(join(REPO, 'frontend/src/styles/desktop-scanner.css'), 'utf8');
  const force = /\.dsk-force \{([\s\S]*?)\}/.exec(css);
  assert.ok(force, '.dsk-force has no styles');
  assert.match(force[1], /right:/,
    'the desktop force button must be pinned to a side, not centred over the '
    + 'status pill that explains why a scan was refused');
  const hint = /\.dsk-hint \{([\s\S]*?)\}/.exec(css);
  assert.match(hint[1], /left: 50%/,
    'the status pill is centred; this test exists to keep the button off it');
  pass('FORCE-TC4', 'the force control does not cover the status message');
}

console.log(`\nforceScan.test.js: ${passed} cases passed`);
