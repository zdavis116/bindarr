// The loop's refs must actually be DRIVEN by the component.
//
// createScanLoop reads eleven refs and writes most of them. A ref the
// component declares but never assigns is not a compile error, not a lint
// error, and not a test failure -- it is a silent behaviour change, and this
// file exists because exactly that shipped:
//
//   onDeviceRef was declared, passed to the loop, and NEVER ASSIGNED.
//   loadClientScan() was called and its {ok} thrown away. So the reader was
//   never used, every frame went to the server, and the scanner sat on "hold
//   steady" -- the precise opposite of what the port was for.
//
// Each case below names a ref and the thing that must drive it.
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

// WIRE-TC1: the on-device reader is actually switched ON.
//
// onDeviceRef is the master switch for the entire point of this port. If it
// is never set from loadClientScan's result, the loop skips the reader on
// every pass and silently degrades to the server path.
{
  start('WIRE-TC1');
  assert.match(code, /onDeviceRef\.current = /,
    'onDeviceRef is never ASSIGNED -- the on-device reader can never turn on, '
    + 'and every frame will go to the server instead');
  assert.match(code, /loadClientScan\(\)\s*\.then\(/,
    "loadClientScan's result must be consumed; calling it fire-and-forget "
    + 'throws away the {ok} that decides whether the reader is used');
  // And the assignment must be fed BY that result, not hardcoded.
  const m = /loadClientScan\(\)\s*\.then\(\s*(\w+)\s*=>\s*\{([\s\S]{0,300}?)\}\)/.exec(code);
  assert.ok(m, 'could not find the loadClientScan handler');
  assert.match(m[2], new RegExp(`onDeviceRef\\.current = !!${m[1]}\\.ok`),
    'onDeviceRef must be set from the loader result, not a constant');
  pass('WIRE-TC1', 'the reader is enabled from its own load result');
}

// WIRE-TC2: the loop is actually started.
//
// The loop schedules its own ticks, so nothing else will drive it. A
// component that builds the scanner but never calls setAutoRunning has a
// camera that shows a preview and scans nothing.
{
  start('WIRE-TC2');
  assert.match(code, /setAutoRunning\(\s*\n?\s*true/,
    'the auto loop must be STARTED somewhere, or the scanner never ticks');
  assert.match(code, /setAutoRunning\(false\)/,
    'the auto loop must be stoppable, or it outlives the camera');
  pass('WIRE-TC2', 'the loop is started and stopped');
}

// WIRE-TC3: aliveRef is set true on mount, not only false on unmount.
//
// isStale() is `!aliveRef.current`. A ref that starts false and is only ever
// set false would make EVERY result stale -- scans run, nothing is ever
// staged.
{
  start('WIRE-TC3');
  assert.match(code, /aliveRef\.current = true/,
    'aliveRef must be set true while mounted, or every scan result is '
    + 'discarded as stale');
  assert.match(code, /aliveRef\.current = false/,
    'aliveRef must be cleared on unmount, or late results touch dead state');
  pass('WIRE-TC3', 'aliveRef is driven in both directions');
}

// WIRE-TC4: the stale-closure hazards are routed through refs.
//
// The scanner is built ONCE. Anything it calls that changes per render must
// be read through a ref, or it captures the first render's closure for ever.
{
  start('WIRE-TC4');
  for (const [ref, why] of [
    ['applyScanOutcomeRef', 'staging a card would use the first render\'s queue'],
    ['signalRef', 'the capture cue would fire against stale state'],
    ['showStagingRef', 'scanning would continue while the staged list is open'],
  ]) {
    assert.ok(new RegExp(`${ref}\\.current = `).test(code),
      `${ref} is not kept current -- ${why}`);
  }
  pass('WIRE-TC4', 'per-render closures are read through refs');
}

console.log(`\nscannerRefs.test.js: ${passed} cases passed`);
