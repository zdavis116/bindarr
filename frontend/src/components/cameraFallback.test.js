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
  assert.match(code, /withDeadline\(navigator\.mediaDevices\.getUserMedia\(constraints\)/,
    'the FIRST attempt is the one that hangs on a cold camera -- it must be '
    + 'the one with a deadline');
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

// CAM-TC3: the resolution is dropped before giving up.
//
// 4032x3024 is a phone-camera ceiling. A desktop webcam that cannot start
// there can almost always start at its default, and a scanner at 1280 still
// scans -- a scanner that will not open scans nothing.
{
  start('CAM-TC3');
  assert.match(code, /getUserMedia\(\{ video: true, audio: false \}\)/,
    'the last attempt must ask for NOTHING but video; dropping every '
    + 'constraint is what lets a stubborn webcam start');
  const first = code.indexOf('getUserMedia(constraints)');
  const last = code.indexOf('getUserMedia({ video: true, audio: false })');
  assert.ok(last > first,
    'the unconstrained attempt must come AFTER the full-resolution one -- '
    + 'otherwise every device gets the lowest common denominator');
  pass('CAM-TC3', 'the request degrades to plain video before failing');
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

console.log(`\ncameraFallback.test.js: ${passed} cases passed`);
