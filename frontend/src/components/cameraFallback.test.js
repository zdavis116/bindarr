// The camera must degrade rather than fail closed.
//
// THE BUG (Zach, desktop): "AbortError: Timeout starting video source", and
// then the decisive clue -- "camera only works on bindarr when I first test it
// with the webcamtest site". A warm-up requirement is never the user's
// problem to solve; it means our COLD request is what fails.
//
// The app asks a cold webcam for 4032x3024. Under `ideal` that cannot reject,
// so the old code's reasoning ("ideal never fails closed") held -- but the
// camera can still negotiate a mode it cannot actually START, and then
// getUserMedia just hangs. A hang is not a rejection, so no .catch() fires.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'CameraScanner.jsx'), 'utf8');
// Comments stripped: asserting a string that also appears in a comment is how
// a guard in this repo passed while the real line was deleted.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// CAM-TC1: a hung getUserMedia must become a rejection.
//
// Without a deadline the fallbacks below are unreachable: Chrome can take
// 10-20s to emit AbortError and Safari may never settle at all, leaving a dead
// preview and no error.
{
  start('CAM-TC1');
  assert.match(code, /const withDeadline = /,
    'each camera attempt must race a timer; a hang cannot be caught otherwise');
  // Rewritten with the ladder: the deadline is applied per RUNG now, not to a
  // single named `constraints` object. What must hold is that a non-final rung
  // is always raced -- the final one is deliberately unbounded, because if
  // plain `video: true` hangs the device is broken and a synthetic timeout
  // would only replace an accurate browser error with a vaguer one.
  assert.match(code, /withDeadline\(attempt, CAMERA_ATTEMPT_MS, rung\.name\)/,
    'every non-final rung must be raced against the deadline, or a cold '
    + 'camera hangs there and the ladder below it is unreachable');
  assert.match(code, /i === ladder\.length - 1\s*\n?\s*\? await attempt/,
    'the FINAL rung must be awaited without a deadline');
  assert.match(code, /name: 'TimeoutError'/,
    'the synthetic failure needs a name the error mapping can report');
  pass('CAM-TC1', 'a hung camera request becomes a catchable rejection');
}

// CAM-TC2: the abandoned attempt is cleaned up.
//
// Losing the race does not cancel getUserMedia. If it resolves later we hold a
// live stream nobody references: the camera light stays on and the NEXT
// attempt finds the device busy -- turning one slow start into a permanently
// broken camera.
{
  start('CAM-TC2');
  const body = /const withDeadline = [\s\S]{0,700}?\n      \};/.exec(code);
  assert.ok(body, 'withDeadline could not be found');
  assert.match(body[0], /getTracks\(\)\.forEach\(t => t\.stop\(\)\)/,
    'a late-resolving stream must have its tracks stopped, or the camera '
    + 'leaks and the next attempt fails with NotReadableError');
  assert.match(body[0], /clearTimeout\(timer\)/,
    'the deadline timer must be cleared on success, or it fires into nothing '
    + 'and keeps the page awake');
  pass('CAM-TC2', 'a timed-out attempt releases the camera it abandoned');
}

// CAM-TC3: the request degrades, and remembers what worked.
//
// THE FOLLOW-UP BUG (Zach): "why did it take so long to open the camera?"
// His webcam fails the first two rungs, so he paid two full timeouts (~12s of
// dead preview) on EVERY open before reaching the one that works. The ladder
// was correct; charging for it repeatedly was not.
{
  start('CAM-TC3');
  assert.match(code, /video: true \}/,
    'the last rung must ask for NOTHING but video; dropping every constraint '
    + 'is what lets a stubborn webcam start');
  // The ladder must be ordered widest-request-first, so a capable camera is
  // never punished with the lowest common denominator.
  const full = code.indexOf('facingMode:');
  const plain = code.indexOf('video: true }');
  assert.ok(plain > full,
    'the unconstrained rung must come AFTER the full-resolution one');

  // And the winning rung must be persisted, or every open pays for the
  // failures again.
  assert.match(code, /localStorage\.setItem\(LADDER_KEY/,
    'the successful rung must be remembered, or the fallback cost is paid on '
    + 'every single camera open');
  assert.match(code, /localStorage\.getItem\(LADDER_KEY\)/,
    'the remembered rung must actually be read back');

  // Remembering must REORDER, never RESTRICT: a camera moved to another port
  // or given a new driver has to be able to reach the other rungs.
  const orderExpr = /const order = [\s\S]{0,260}?;/.exec(code);
  assert.ok(orderExpr, 'the rung ordering could not be found');
  assert.match(orderExpr[0], /\.\.\.ladder\.keys\(\)/,
    'the remembered rung must be tried FIRST and the rest still tried after '
    + '-- restricting to one rung would strand a camera whose behaviour '
    + 'changed');
  pass('CAM-TC3', 'the request degrades, and the winning rung is remembered');
}

// CAM-TC5: the per-attempt deadline is short enough to be paid.
//
// Every failed rung costs this in dead preview. It only has to be longer than
// a working camera takes to start.
{
  start('CAM-TC5');
  const m = /const CAMERA_ATTEMPT_MS = (\d+);/.exec(code);
  assert.ok(m, 'the per-attempt deadline must be a named constant');
  const ms = Number(m[1]);
  assert.ok(ms <= 3000,
    `the camera attempt deadline is ${ms}ms; a user pays it once per failed `
    + 'rung and a camera that is going to start does so in under two seconds');
  assert.ok(ms >= 1500,
    `the camera attempt deadline is ${ms}ms; too short and a slow-but-healthy `
    + 'camera is abandoned before it ever delivers a frame');
  pass('CAM-TC5', 'a failed rung costs a bounded, sensible wait');
}

// CAM-TC4: every failure mode gets its own message.
//
// The original reported "check your camera permissions" for EVERY error,
// which sent Zach to check permissions that were already fine.
{
  start('CAM-TC4');
  for (const [name, key] of [
    ['NotAllowedError', 'scan.errCameraPermissions'],
    ['NotFoundError', 'scan.errCameraNone'],
    ['NotReadableError', 'scan.errCameraBusy'],
    ['AbortError', 'scan.errCameraTimeout'],
    ['OverconstrainedError', 'scan.errCameraConstraints'],
  ]) {
    assert.ok(code.includes(name) && code.includes(key),
      `${name} must map to ${key}; a single catch-all message is a guess, and `
      + 'a confident wrong guess costs a debugging round');
  }
  const en = JSON.parse(readFileSync(join(HERE, '..', 'locales', 'en.json'), 'utf8'));
  for (const k of ['scan.errCameraNone', 'scan.errCameraBusy', 'scan.errCameraTimeout',
    'scan.errCameraConstraints', 'scan.errCameraUnknown']) {
    assert.ok(en[k], `${k} has no string; the user would see the raw key`);
  }
  pass('CAM-TC4', 'each getUserMedia failure reports what actually happened');
}

// CAM-TC6: the ladder steps down through real modes, not off a cliff.
//
// THE BUG (Zach): "my camera is a 4k camera why is it only at 640x480".
//
// The old ladder was 4032x3024, the same again without facingMode, then
// `video: true`. Nothing in between. A camera that could not start at 12MP
// fell straight through to asking for NOTHING, and a browser given no
// resolution hint returns its default -- measured in a real browser as
// exactly 640x480. Remembering then made that permanent.
//
// Below 1280 wide the collector number at the foot of the card stops having
// the pixels the footer read depends on, so this is an accuracy bug as well as
// a cosmetic one.
{
  start('CAM-TC6');
  const ladderSrc = /const ladder = \[([\s\S]*?)\n      \];/.exec(code);
  assert.ok(ladderSrc, 'the ladder could not be found');

  const widths = [...ladderSrc[1].matchAll(/width: \{ ideal: (\d+) \}/g)].map(m => Number(m[1]));
  assert.ok(widths.length >= 4,
    `only ${widths.length} rungs request a resolution; a ladder that jumps `
    + 'from the maximum straight to unconstrained is how a 4K camera ends up '
    + 'at 640x480');

  // Monotonically NON-INCREASING: each rung is the same or a genuine step
  // down. Equal neighbours are legitimate -- the first two rungs are both 4K,
  // differing only in facingMode, which is a different question from
  // resolution. What must never happen is a rung going back UP, which would
  // retry a mode that has already failed.
  for (let i = 1; i < widths.length; i++) {
    assert.ok(widths[i] <= widths[i - 1],
      `rung widths ${widths.join(' -> ')} go back UP; a ladder that raises its `
      + 'request after a failure retries a mode already known not to work');
  }
  // And it must actually descend overall, or it is not a ladder at all.
  assert.ok(widths[widths.length - 1] < widths[0],
    `rung widths ${widths.join(' -> ')} never descend; without real steps `
    + 'between the maximum and unconstrained, a 4K camera that cannot start '
    + 'at 4K collapses to the browser default of 640x480');
  // And the smallest explicit rung must still be usable for a footer read.
  assert.ok(widths[widths.length - 1] >= 1280,
    `the lowest explicit rung is ${widths[widths.length - 1]}px wide; below `
    + '1280 the collector number loses the detail the printing proof needs');
  pass('CAM-TC6', 'the ladder steps down through real camera modes');
}

// CAM-TC7: a tiny capture is never remembered, and a bad memory expires.
//
// `ideal` negotiates SILENTLY -- a rung can succeed and still hand back a far
// smaller frame than it asked for. Without reading the real numbers back,
// that is invisible; with remembering, it is permanent.
{
  start('CAM-TC7');
  assert.match(code, /getVideoTracks\(\)\[0\]\?\.getSettings\?\.\(\)/,
    'the ACTUAL negotiated frame size must be read back; asking for 4K and '
    + 'checking nothing is how this bug hid');
  assert.match(code, /MIN_USEFUL_CAPTURE_W/,
    'there must be a floor below which a capture is not worth remembering');
  const m = /const MIN_USEFUL_CAPTURE_W = (\d+);/.exec(code);
  assert.ok(m && Number(m[1]) >= 1280,
    'the useful-capture floor must be at least 1280 wide');
  assert.match(code, /localStorage\.removeItem\(LADDER_KEY\)/,
    'a rung that produced a too-small frame must NOT be remembered');

  // A bad memory from a previous release must expire by itself.
  assert.match(code, /const LADDER_VERSION = /,
    'the stored rung must be versioned; fixing the ladder does not fix the '
    + "value already sitting in a user's browser, and the indices have moved");
  pass('CAM-TC7', 'a poor capture is not remembered and stale memories expire');
}

console.log(`\ncameraFallback.test.js: ${passed} cases passed`);
