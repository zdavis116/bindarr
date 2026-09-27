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

// FAST-TC7: needsServer() decides whether the phone's answer is used.
//
// SUPERSEDED IN SHAPE BY FAST-TC11. This originally pinned a `goServer` local
// and an early return on "no card", which was my paraphrase of upstream and
// the cause of the "stuck waiting for a card" bug. The code now transcribes
// FastScanner.jsx:264 directly, so this pins what upstream actually does:
// needsServer() guards the hydrate, and nothing else.
{
  start('FAST-TC7');
  const read = code.indexOf('await readOnDevice(');
  const fetchIdx = code.indexOf("fetch('/api/scan-match'");
  const between = code.slice(read, fetchIdx);
  assert.match(between, /if \(!needsServer\(local, \{ autoPass: !isManual \}\)\) \{/,
    'needsServer() must gate the hydrate exactly as upstream does at line 264');
  assert.match(between, /hydrateResults\(/,
    'a proven card must be hydrated into a real row');
  pass('FAST-TC7', 'needsServer gates the hydrate, upstream-style');
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

// FAST-TC9: no "working on it" message on an auto pass.
//
// THE BUG: "stuck in initialize scanner like it's stuck in an infinite loop."
//
// handleCapture set 'Initializing scanner...' unconditionally. That was
// harmless when every scan meant a server round trip, because the next step
// always overwrote it. It is not harmless with a 60ms loop whose most common
// outcome is an EARLY RETURN (no card in frame): the text was written every
// 60ms and never cleared, so the scanner looked wedged while working
// perfectly.
//
// Upstream sets a hint from the OUTCOME after a pass, never a progress message
// before one. A message written before the work cannot survive an early
// return; a message derived from the result always can.
{
  start('FAST-TC9');
  const i = code.indexOf("setScanStatus('Initializing scanner...')");
  assert.ok(i > 0, 'the manual path may still announce itself');
  const line = code.slice(code.lastIndexOf('\n', i) + 1, i + 60);
  assert.match(line, /if \(isManual\)/,
    "'Initializing scanner...' must be gated on isManual -- on an auto pass it "
    + 'is written every 60ms and an early return leaves it on screen for ever');
  pass('FAST-TC9', 'auto passes do not paint a progress message they cannot clear');
}

// FAST-TC11: an unproven card MUST still reach the server.
//
// THE BUG: "Now it's stuck with waiting for a card."
//
// Upstream's scan() ends a pass without an answer in exactly ONE case
// (FastScanner.jsx:271): an auto pass where serverAllowed() says this frame
// shows the SAME unresolved card, in the SAME place, as the last few passes
// and the backoff window is still open. Everything else -- unproven card, no
// card on a shutter press, a reader error -- falls through to serverRead()
// at line 277.
//
// I replaced that with `if (!deviceCard) return;`. So a card the phone could
// not prove never reached the server at all, and the UI could only ever say
// "waiting for a card". Three separate bugs now have the same root: I
// paraphrased upstream's control flow instead of transcribing it.
{
  start('FAST-TC11');
  const read = code.indexOf('await readOnDevice(');
  const fetchIdx = code.indexOf("fetch('/api/scan-match'");
  const between = code.slice(read, fetchIdx);

  // The hold must be conditioned on serverAllowed(), not on "no card".
  assert.match(between, /if \(!deviceCard && !isManual && !serverAllowed\(/,
    'the only early return before the upload must be upstream\'s backoff '
    + '(serverAllowed), never a bare "the phone did not prove it"');

  // And no other early return may END THE PASS in the DECISION REGION -- the
  // span between the read and the `if (deviceCard)` success branch, where a
  // frame's fate is decided. Returns inside the success branch are a proven
  // card being staged (upstream's scan() returns once it has an answer too).
  //
  // Staleness guards are excluded by MATCHING THEM ON THE SAME LINE rather
  // than subtracting two counts: `if (scanId !== ...) return;` is one line, so
  // the bare-return pattern never saw it, and subtracting produced -1. A guard
  // that can go negative is arithmetic, not a measurement.
  const decisionEnd = between.indexOf('if (deviceCard) {');
  assert.ok(decisionEnd > 0, 'the success branch must follow the decision');
  const decision = between.slice(0, decisionEnd);
  const decisionReturns = (decision.match(/\n\s*return;/g) || []).length;
  assert.strictEqual(decisionReturns, 1,
    `${decisionReturns} decision returns before the success branch; upstream `
    + 'has exactly one (the backoff hold)');
  pass('FAST-TC11', 'only the backoff can stop a frame reaching the server');
}

// FAST-TC10: the backoff hold leaves an honest status.
//
// ORDERED AFTER TC11 DELIBERATELY. When both were present and TC10 ran first,
// a mutation that deleted the hold entirely (M11) tripped TC10's "the backoff
// hold must exist" before TC11 could judge it -- so TC11 was never proven to
// catch anything. Existence is TC11's question; this one only asks what the
// hold SAYS once TC11 has established it is there.
{
  start('FAST-TC10');
  const i = code.indexOf('!serverAllowed(');
  assert.ok(i > 0, 'the backoff hold must exist (see FAST-TC11)');
  const block = code.slice(i, i + 400);
  assert.match(block, /setScanStatus\(/,
    'the hold path must set a status from the outcome, not inherit one');
  assert.match(block, /setLoading\(false\)/,
    'the hold path must clear loading, or the scanner wedges');
  pass('FAST-TC10', 'the backoff hold reports the frame and clears loading');
}

// FAST-TC12: the fail streak is actually MAINTAINED.
//
// serverAllowed() without nextFailStreak() is a gate wired to a sensor that is
// never read: the streak stays null, the backoff never engages, and a card the
// server also cannot resolve is re-uploaded every 60ms for ever. The two are
// one mechanism and must both be present.
{
  start('FAST-TC12');
  assert.match(code, /failStreakRef\.current = nextFailStreak\(/,
    'the server answer must be folded into the fail streak, or the backoff '
    + 'never engages');
  assert.match(code, /failStreakRef\.current = null/,
    'an empty frame must CLEAR the streak, or a new card inherits the '
    + "previous card's backoff");
  pass('FAST-TC12', 'the backoff is both set and cleared');
}

// FAST-TC13: the auto loop never pauses after a hit.
//
// THE BUG: "it's just continually scanning like I don't even have time to put
// a new card down... by the time the card lands on top it already captured the
// previous card."
//
// The instinct is to slow the loop down. That is backwards, and upstream shows
// why: it runs every pass at 60ms with NO settle pause (AUTO_GAP_MS), because
// a pause cannot tell "the same card is still there" from "a new card just
// landed". Our 400ms settle DELAYED the pass that would have caught the new
// card while doing nothing about re-reading the old one.
{
  start('FAST-TC13');
  const gap = /const SCAN_RETRY_REJECTED_MS = (\d+)/.exec(code);
  const settle = /const SCAN_RETRY_SETTLE_MS = (\d+)/.exec(code);
  assert.ok(gap && settle, 'both auto-loop gaps must be declared');
  assert.strictEqual(Number(gap[1]), 60, 'the retry gap is upstream AUTO_GAP_MS');
  assert.strictEqual(Number(settle[1]), 60,
    `settle is ${settle[1]}ms; upstream does not pause after a hit -- a pause `
    + 'delays seeing the NEXT card and cannot stop re-reading the last one');
  pass('FAST-TC13', 'the loop runs at a constant 60ms, upstream-style');
}

// FAST-TC14: duplicates are suppressed by a TIME WINDOW, not a latch.
//
// The other half of the same bug, and the more serious one. The old guard was
// `identified === lastQueuedNameRef.current`, a sticky latch cleared only when
// the card LEFT THE FRAME -- an event the live detector used to report. That
// detector is deleted, so nothing ever cleared it. Combined with Zach's actual
// workflow ("I just drop cards on top"), dropping a second copy on the first
// meant the scanner silently refused it.
//
// A window keyed by id and expired by a clock needs no leave event and cannot
// block a card the user has not just scanned.
{
  start('FAST-TC14');
  assert.ok(!/lastQueuedNameRef\.current/.test(code),
    'the name-keyed latch is back; it is cleared by an event (the card leaving '
    + 'the frame) that nothing reports any more, so it never clears');
  assert.match(code, /const SEEN_CARD_MS = 4000/,
    'the dedupe window must be upstream\'s 4s');
  assert.match(code, /seenIdsRef\.current\.get\(/,
    'duplicates must be judged by the per-card window');
  // Every path that stages a card must consult the SAME window.
  const uses = (code.match(/seenIdsRef\.current\.set\(/g) || []).length;
  assert.ok(uses >= 3,
    `only ${uses} paths record into the dedupe window; the on-device, server `
    + 'and unidentified paths must all use it or they will disagree');
  pass('FAST-TC14', 'one time-based dedupe window, shared by every scan path');
}

console.log(`\nscanOrder.test.js: ${passed} cases passed`);
