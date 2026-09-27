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

// FAST-TC1: the ImageCapture still is GONE ENTIRELY.
//
// This assertion INVERTED. It used to require takeStillPhoto to exist and run
// after the read; now it must not exist at all. Zach: "remove anything scrybox
// isn't using... This should function EXACTLY like scrybox" -- and upstream
// never calls ImageCapture. It cost a real shutter (~0.3-1s on iOS) that the
// reader does not need, since it proves the card from preview pixels.
//
// A test whose meaning reverses is worth flagging loudly rather than quietly
// editing: the OLD version passing would now mean the slow path came back.
{
  start('FAST-TC1');
  assert.ok(!/takeStillPhoto/.test(code),
    'takeStillPhoto/ImageCapture must be gone -- it is a full shutter on every '
    + 'scan and upstream never calls it');
  assert.ok(!/ImageCapture/.test(code),
    'no ImageCapture references should remain in the scanner');
  const read = code.indexOf('await readOnDevice(');
  assert.ok(read > 0, 'the scanner must call readOnDevice');
  pass('FAST-TC1', 'no ImageCapture shutter: the reader works off the preview');
}

// FAST-TC2: the frame is never re-encoded on the main thread.
//
// ALSO INVERTED. The old rule was "toDataURL must come after the read". The
// toDataURL is now gone entirely: the server fallback calls lastFrameJpeg(),
// which encodes the canvas clientScan ALREADY drew -- off-thread via
// convertToBlob where the browser supports it. So the server sees exactly the
// pixels the phone looked at, and no scan pays a main-thread encode.
{
  start('FAST-TC2');
  assert.ok(!/\.toDataURL\(/.test(code),
    'the scanner must not re-encode a frame on the main thread; the server '
    + 'fallback reuses lastFrameJpeg()');
  assert.ok(/lastFrameJpeg\(\)/.test(code),
    'the server fallback must reuse the frame the reader already drew');
  const read = code.indexOf('await readOnDevice(');
  const reuse = code.indexOf('await lastFrameJpeg()');
  assert.ok(reuse > read,
    'lastFrameJpeg must be reached only after the on-device read has failed');
  pass('FAST-TC2', 'the server reuses the read frame; no main-thread encode');
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

// FAST-TC4: the reader is handed the VIDEO ELEMENT.
//
// Was `framedCanvas` (the guide crop). That crop is gone with the rest of the
// pre-read work: cornelius predicts corners from the FULL frame, so cropping
// first fed it a picture of a crop and cost three canvas draws per tick.
// clientScan draws the two canvases it needs straight off the video, at one
// instant, so corners and pixels cannot come from different moments.
{
  start('FAST-TC4');
  const call = /await readOnDevice\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(code);
  assert.ok(call, 'readOnDevice must be called with a named frame source');
  assert.strictEqual(call[1], 'video',
    `readOnDevice is fed \`${call[1]}\`; it must read the video element directly `
    + '-- any intermediate canvas is pre-read work upstream does not do');
  assert.ok(!/cropGuideRegion/.test(code),
    'the guide-box crop must be gone: cornelius reads the full frame');
  pass('FAST-TC4', 'the reader reads the video element directly');
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

// FAST-TC6: the duplicated pre-read subsystems stay deleted.
//
// Each of these asked a question the reader already answers, and each cost
// real time per tick. The YOLO detector is the expensive one: a second ONNX
// model on its own 140ms loop, competing with the scan's own models for the
// single wasm thread the browser gives us (no COOP/COEP means no
// SharedArrayBuffer means no threads). Every scan queued behind a detector
// hunting for the card the scan had already found.
//
// Listed by SYMBOL rather than by file so re-importing any of them fails here,
// not just re-creating the module.
{
  start('FAST-TC6');
  const banned = [
    ['detectCardOnDevice', 'the YOLO detector: cornelius already returns the corners'],
    ['initCardDetector', 'the YOLO detector loader'],
    ['detectCardInFrame', 'the edge detector it fell back to'],
    ['laplacianVarianceScore', "the sharpness gate: the pipeline has its own, on the strip that must be legible"],
    ['decideCapture', 'the sharpness gate decision'],
    ['liveDetectRef', 'the detector-driven capture latch'],
  ];
  for (const [sym, why] of banned) {
    assert.ok(!new RegExp(`\\b${sym}\\b`).test(code),
      `${sym} is back (${why}) -- it duplicates work the reader does`);
  }
  pass('FAST-TC6', 'no second detector, no second sharpness gate');
}

// FAST-TC7: an auto pass with NO CARD must END, not upload.
//
// THE BUG ZACH HIT: "it scans right away and always says no confident match."
//
// needsServer() returns false for TWO different reasons -- the phone proved a
// card, OR an auto pass saw no card at all. The first version only handled the
// proven case and let "no card" fall through to the server upload. So an empty
// mat (most passes of a 60ms loop) was JPEG'd, uploaded, matched against 106k
// printings and answered "No confident match", instantly and for ever.
//
// The gate was working. Its answer was being discarded. This pins the early
// return so the second meaning cannot be dropped again.
{
  start('FAST-TC7');
  const read = code.indexOf('await readOnDevice(');
  const fetchIdx = code.indexOf("fetch('/api/scan-match'");
  const between = code.slice(read, fetchIdx);
  assert.match(between, /const goServer = needsServer\(/,
    'the scanner must capture needsServer() as a named decision');
  assert.match(between, /if \(!deviceCard\) \{[\s\S]{0,400}?return;/,
    'when needsServer() says "do not send" and no card was proven, the pass '
    + 'must RETURN -- otherwise an empty frame is uploaded every tick');
  pass('FAST-TC7', 'no card on an auto pass ends the pass instead of uploading');
}

// FAST-TC8: a missing frame must not be reported as "no match".
//
// When the reader never loads, lastFrameJpeg() returns null -- no card was
// ever examined. Saying "No confident match" there is a claim about a CARD,
// and it is what made a broken loader look like a scanner that simply could
// not recognise anything. It cost a full debugging round.
{
  start('FAST-TC8');
  const i = code.indexOf('const blob = await lastFrameJpeg();');
  assert.ok(i > 0, 'the server path must reuse lastFrameJpeg()');
  const branch = code.slice(i, i + 600);
  assert.ok(!/No confident match/.test(branch),
    'a missing frame means the READER did not run; it must not be reported as '
    + 'a failed match against a card');
  pass('FAST-TC8', 'a reader that never ran says so, instead of blaming the card');
}

console.log(`\nscanOrder.test.js: ${passed} cases passed`);
