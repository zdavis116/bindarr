// The four scanner bugs Zach reported after the port, each pinned to the
// property that fixes it rather than to the code that happens to implement it.
//
// These are all SILENT failures -- the scanner kept working and the feedback
// was wrong, which is the class of bug that survives a test suite unless
// something asserts the feedback itself.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), 'utf8');
// Comments stripped: asserting a string that also appears in a comment is how
// a guard in this repo passed while the real line was deleted.
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l) && !/^\s*\{\/\*/.test(l)).join('\n');

const app = strip(read('../App.jsx'));
const scanner = strip(read('CameraScanner.jsx'));
const wiring = strip(read('../utils/scannerWiring.js'));
const client = strip(read('../utils/clientScan.js'));

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// BUG1-TC1: a toast must be able to repeat itself.
//
// "some cards when scanned... wouldn't notify they were scanned. It was mainly
// the ones that scanned super fast."
//
// Storing the MESSAGE as state means setToast('Staged Forest') is a no-op when
// that string is already showing: React bails on an identical value, the
// dismiss timer is never re-armed, and the second scan appears to do nothing.
{
  start('BUG1-TC1');
  assert.match(app, /setToast\(\{\s*message[^}]*key:/,
    'the toast state must carry a unique key per call, not a bare message -- '
    + 'an identical string set twice is a no-op and the second scan shows '
    + 'nothing');
  assert.match(app, /key=\{toast\.key\}/,
    'the rendered toast must be keyed so an identical message re-mounts and '
    + 're-animates');
  pass('BUG1-TC1', 'repeat toasts re-show and re-arm their timer');
}

// BUG2-TC1: the toast names the PRINTING, not just the card.
//
// "I would like to see name and set when notifying it was added."
//
// Set and number are what this scanner actually proves. A toast saying only
// "Forest" hides whether it picked the right one of 774.
{
  start('BUG2-TC1');
  const call = /showToast\(t\('scan\.stagedToast',\s*\{([\s\S]{0,320}?)\}\)\)/.exec(scanner);
  assert.ok(call, 'the staged toast call could not be found');
  for (const field of ['name', 'set', 'number']) {
    assert.ok(new RegExp(`\\b${field}:`).test(call[1]),
      `the staged toast must include ${field} -- it identifies the PRINTING, `
      + 'which is the claim the scanner is making');
  }
  const en = JSON.parse(read('../locales/en.json'));
  for (const token of ['{{name}}', '{{set}}', '{{number}}']) {
    assert.ok(en['scan.stagedToast'].includes(token),
      `scan.stagedToast must render ${token}; passing a value the string does `
      + 'not use silently drops it');
  }
  pass('BUG2-TC1', 'the staged toast names the exact printing');
}

// BUG3-TC1: nothing in the scan overlay strobes on `loading`.
//
// "it starts flashing waiting for card but it's flashing instead of just
// steady... Also the scan bar is also flashing but I would just like for that
// to be removed."
//
// `loading` toggles every pass. At the old ~1.5s cadence that read as a
// spinner; at 60ms it is a strobe. Anything gated on it flickers.
{
  start('BUG3-TC1');
  assert.ok(!/\{loading && <div className="scan-line"/.test(scanner),
    'the sweeping scan line must be gone -- Zach asked for it removed, and it '
    + 'strobed at the new cadence');
  assert.ok(!/animation: 'scan-status-spin/.test(scanner),
    'the status spinner must be gone -- it is driven by `loading`, which now '
    + 'toggles every 60ms');
  assert.ok(!/\(scanStatus \|\| loading \|\| autoScanWaitReason\)/.test(scanner),
    'the status pill must not be shown because `loading` is true; it would '
    + 'appear and vanish with every pass');
  pass('BUG3-TC1', 'no overlay element is driven by the per-pass loading flag');
}

// BUG3-TC2: the hint text is HELD, not repainted every pass.
//
// Consecutive passes legitimately disagree (noCard, hold, noCard, '' inside a
// fifth of a second). Writing each straight to the status line turns honest
// per-frame reporting into a flashing label.
{
  start('BUG3-TC2');
  assert.match(scanner, /hintClearRef/,
    'clearing the hint must be deferred through a timer, or a single '
    + 'disagreeing pass blinks the line off and on');
  assert.match(scanner, /HINT_CLEAR_MS/,
    'the hold-open period must be a named constant, not an inline number');
  // The critical shape: an empty hint must NOT synchronously blank the line.
  const body = /hint: \(key, vars\) => \{([\s\S]*?)\n      \},/.exec(scanner);
  assert.ok(body, 'the hint handler could not be found');
  assert.ok(!/if \(!key\) return setScanStatus\(''\)/.test(body[1]),
    'an empty hint must not clear the status synchronously -- that is exactly '
    + 'the flashing Zach reported');
  pass('BUG3-TC2', 'hints persist until replaced and clear only after a quiet period');
}

// BUG4-TC1: a staged row carries a photo of the card.
//
// "the cards added to the add review list now have no card image, why is
// that?" -- the on-device path submitted crop: null, so every review row drew
// an empty grey box.
{
  start('BUG4-TC1');
  assert.ok(!/crop: null/.test(wiring),
    'the staging submit must not hardcode crop: null -- that is the bug');
  assert.match(wiring, /crop: lastCardCrop\(\)/,
    'the staged row must carry the crop the reader just looked at');
  assert.match(client, /export function lastCardCrop\(/,
    'clientScan must expose the crop of the frame it read');
  // It must crop to the CARD, using the quad, not dump the whole frame.
  assert.match(client, /if \(!frameCanvas \|\| !lastQuad\) return null;/,
    'the crop must require the card outline; without it the thumbnail would '
    + 'be the whole table');
  // And a missing crop must never break a scan.
  assert.match(client, /\} catch \{[\s\S]{0,200}return null;/,
    'lastCardCrop must swallow its own errors -- a thumbnail is a nicety, a '
    + 'scan is not');
  pass('BUG4-TC1', 'staged rows carry a bounded crop of the actual card');
}

console.log(`\nscannerFeedback.test.js: ${passed} cases passed`);
