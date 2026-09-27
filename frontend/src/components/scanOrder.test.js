// THE ON-DEVICE READ MUST COME FIRST, BEFORE ANYTHING EXPENSIVE.
//
// Zach, comparing this scanner against the app the pipeline came from:
// "His scans worked way quicker than ours."
//
// He was right, and the cause was ORDER, not the reader. The reader was
// ported faithfully and measured at ~330ms on his own 271 frames. But it had
// been wired INSIDE the old server-scan preamble, so every scan first paid:
//
//   takeStillPhoto()   full-resolution ImageCapture, Smart HDR / Deep Fusion
//   drawImage()        downscale onto a second canvas
//   toDataURL()        JPEG-encode the whole frame to base64, MAIN THREAD
//
// ...all of which exist solely to produce an UPLOAD. When the phone can read
// the card itself, none of it is needed. Every scan was paying for both
// pipelines and then using one.
//
// This is invisible to a functional test: the scanner works, the right cards
// land in the tray, every assertion about behaviour passes. Only the clock
// tells you, and only if you know what to compare against. So the ORDER is
// pinned here as a rule.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'CameraScanner.jsx'), 'utf8');

let passed = 0;
// Announced BEFORE asserting: node:assert throws, so a case that only prints
// on success tells a mutation harness nothing about which rule broke.
const start = (id) => { console.log(`RUN: ${id}`); };
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// Comments stripped before any positional check -- a comment mentioning
// takeStillPhoto sits directly above the call, and would otherwise be found
// first and make the ordering assertion measure prose instead of code.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

// FAST-TC1: the on-device read happens before the ImageCapture still.
{
  start('FAST-TC1');
  const read = code.indexOf('await readOnDevice(');
  const still = code.indexOf('await takeStillPhoto(');
  assert.ok(read > 0, 'the scanner must call readOnDevice');
  assert.ok(still > 0, 'the scanner must still have a takeStillPhoto fallback');
  assert.ok(read < still,
    'readOnDevice must run BEFORE takeStillPhoto -- otherwise every scan pays '
    + 'for a full-resolution still it only needs when the local read fails');
  pass('FAST-TC1', 'the phone is asked before the expensive shutter');
}

// FAST-TC2: the JPEG encode is downstream of the read too. toDataURL blocks
// the main thread on a multi-megapixel frame; doing it before the local read
// stalls the UI on every scan, including the ~93% that never upload.
{
  start('FAST-TC2');
  const read = code.indexOf('await readOnDevice(');
  const encode = code.indexOf(".toDataURL('image/jpeg'");
  assert.ok(encode > 0, 'the server path still encodes a JPEG');
  assert.ok(read < encode,
    'the main-thread JPEG encode must come AFTER the on-device read');
  pass('FAST-TC2', 'the frame is only encoded when the server is actually needed');
}

// FAST-TC3: a proven card returns without falling through to the upload. The
// early return is the whole saving; without it the server path runs anyway and
// the scan costs MORE than before this feature existed.
{
  start('FAST-TC3');
  const read = code.indexOf('await readOnDevice(');
  const fetchIdx = code.indexOf("fetch('/api/scan-match'");
  assert.ok(fetchIdx > read, 'the scan-match upload must come after the read');
  const between = code.slice(read, fetchIdx);
  // Anchored to the `if (deviceCard) { ... return; }` block rather than a
  // character window: the first draft allowed 120 chars between
  // applyScanOutcome and `return`, and the real code has a try/catch/finally
  // in between. That is a test asserting its author's guess at the layout, not
  // the rule -- and it fails on a correct implementation.
  const block = /if \(deviceCard\) \{[\s\S]*?\n    \}/.exec(between);
  assert.ok(block, 'a proven on-device card must be handled in its own block');
  assert.match(block[0], /applyScanOutcome\(outcome, identified\)/,
    'the on-device block must route through the shared outcome handler');
  assert.match(block[0], /\n      return;\n    \}$/,
    'the on-device block must RETURN rather than fall through to the upload');
  pass('FAST-TC3', 'a proven card never reaches the server path');
}

// FAST-TC4: the reader is fed framedCanvas — the preview crop — by name.
//
// NOT A POSITIONAL CHECK, AND THAT IS THE POINT. The first version asserted
// `read < reassign` (the read happens before framedCanvas is replaced by the
// still). A mutation run showed that cannot fail on its own: reassignment sits
// two lines below the takeStillPhoto call, so anything that breaks it breaks
// FAST-TC1 first. It was a second spelling of TC1 wearing a different name,
// and a redundant guard inflates the count without adding safety.
//
// What is genuinely distinct is WHICH SOURCE the reader is handed. Passing a
// still-derived canvas would be the slow order restored with the ordering
// assertions still green.
{
  start('FAST-TC4');
  const call = /await readOnDevice\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(code);
  assert.ok(call, 'readOnDevice must be called with a named frame source');
  assert.strictEqual(call[1], 'framedCanvas',
    `readOnDevice is fed \`${call[1]}\`; it must read framedCanvas, the live `
    + 'preview crop, not a canvas derived from the ImageCapture still');
  pass('FAST-TC4', 'the reader is fed the live preview frame by name');
}

// FAST-TC5: the rejected-frame gap stays small. It was 350ms, sized for a
// ~1.5s server round trip; against a ~330ms local read that more than doubled
// the time between attempts.
{
  start('FAST-TC5');
  const m = /const SCAN_RETRY_REJECTED_MS = (\d+);/.exec(code);
  assert.ok(m, 'SCAN_RETRY_REJECTED_MS must be declared');
  assert.ok(Number(m[1]) <= 120,
    `SCAN_RETRY_REJECTED_MS is ${m[1]}ms; a rejected frame captured nothing and `
    + 'read nothing, so there is nothing to pace (upstream uses 60ms)');
  pass('FAST-TC5', 'a held-back frame retries promptly');
}

console.log(`\nscanOrder.test.js: ${passed} cases passed`);
