// PR 9 — source-contract checks on CameraScanner.jsx.
//
// BE CLEAR ABOUT WHAT THESE ARE. They read the component's SOURCE TEXT. They
// prove that the code says a thing, not that the app does a thing. Nothing in
// this repo runs a browser, and an iOS Safari crash shipped through a fully
// green suite this week.
//
// They exist because the specific failure PR 9 fixes was invisible to every
// other kind of test: the OCR pipeline, the resolver and the queue were all
// correct and fully tested, and NONE of them was connected to the scanner. A
// grep for 'ocr' in this file returned nothing. That is exactly the class of
// bug a source contract catches and a unit test cannot, so the assertions
// below are pinned to the WIRING, not to behaviour.
//
// The real behavioural assertions live in scanReviewQueue.test.js, which drives
// the controller for real. Layout, touch targets and phone performance need
// Zach's eyes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'CameraScanner.jsx'), 'utf8');

let passed = 0;
const test = (id, name, fn) => { fn(); passed++; console.log(`PASS: ${id} ${name}`); };

// --- Task 1: the scanner must actually ask for OCR -------------------------

test('F9S-TC1', 'the scan-match request asks for OCR', () => {
  // The whole PR 8 pipeline is gated behind this flag server-side. Without it
  // OCR never runs from the app, which was the reported bug.
  const body = src.match(/body: JSON\.stringify\(\{ game: 'mtg', image: imageData[^}]*\}\)/);
  assert.ok(body, 'could not find the scan-match request body');
  assert.match(body[0], /ocr: true/);
});

test('F9S-TC2', 'the scanner reads the OCR result off the response', () => {
  assert.match(src, /ocr:\s*ocrResult|ocr\s*\}\s*=\s*await resp\.json\(\)|const \{[^}]*\bocr\b[^}]*\} = await resp\.json\(\)/);
});

// --- Task 2: unresolved scans route to the queue ---------------------------

test('F9S-TC3', 'the scanner uses the shared queue controller rather than its own fetches', () => {
  assert.match(src, /from '\.\/scanReviewQueue(\.js)?'/);
  assert.match(src, /createScanReviewQueue/);
});

test('F9S-TC4', 'a scan with an OCR read is submitted through submitScan, not a bare collection POST', () => {
  assert.match(src, /submitScan\(/);
});

test('F9S-TC5', 'the pending count is rendered during scanning', () => {
  // The queue must never be a surprise at the end of a stack.
  assert.match(src, /pendingCount/);
});

test('F9S-TC6', 'the review queue screen is reachable from the scanner', () => {
  assert.match(src, /ScanReviewQueue/);
});

// --- Task 3: nothing may prompt mid-scan -----------------------------------

test('F9S-TC7', 'the queue screen is opened by an explicit tap, never automatically on a queued scan', () => {
  // Zach scans a physical stack. A modal every few cards makes the workflow
  // unusable, and that is the entire reason the queue exists. If a future edit
  // opens the review screen from inside the scan handler, this fails.
  const handler = src.slice(src.indexOf('const handleCapture'), src.indexOf('handleCaptureRef.current = handleCapture'));
  assert.ok(handler.length > 0, 'could not locate handleCapture');
  assert.equal(/setShowReviewQueue\(true\)/.test(handler), false,
    'handleCapture must not open the review queue mid-scan');
});

// --- Task 4: the set banner no longer lies ---------------------------------

test('F9S-TC8', 'the old accuracy warning about unscoped scanning is gone', () => {
  // Measured 12/12 and 10/10 unscoped at every width 400-1600px. Telling him
  // unscoped scanning "may misidentify the card" steers him away from the
  // workflow he asked for, on the strength of a fact that is no longer true.
  assert.equal(/Highly recommended/.test(src), false);
  assert.equal(/may misidentify the card/.test(src), false);
});

test('F9S-TC9', 'set scoping is offered as a speed option, not a correctness warning', () => {
  assert.match(src, /scan\.setOptionalHint/);
});

// --- Task 5: the slider whose axis measurably did nothing ------------------

test('F9S-TC10', 'the scan-detail slider and its profile table are gone', () => {
  // recallK scored 8/8 card identity at 250/100/50/25/10 — the axis moved
  // latency only, and RECALL_K's default is now 50 server-side. A control that
  // does not trade anything off is a control that invites blame for problems it
  // cannot cause.
  assert.equal(/SCAN_PROFILES/.test(src), false);
  assert.equal(/scan_detail/.test(src), false);
  assert.equal(/scan\.detailQuick/.test(src), false);
});

test('F9S-TC11', 'one fixed capture profile is used, at the width the collector number needs', () => {
  // Card identity was 10/10 even at 400px, but the collector number needs
  // resolution to be legible at all — so width is chosen for OCR, which is the
  // only consumer that can tell the difference.
  //
  // PR 12 raised this 1280 -> 2000. The old value was a DEAD CLAMP: the
  // guide-box crop was ~660px, so Math.min(1, 1280/660) was always 1. Once the
  // fullscreen preview and the full-resolution capture request enlarge the crop
  // past the cap, this constant becomes the binding constraint on how many
  // pixels reach the collector-number strip — which is why it had to move in
  // the SAME change rather than a follow-up.
  assert.match(src, /SCAN_UPLOAD_W\s*=\s*2000/);
  assert.match(src, /SCAN_UPLOAD_W/);
});

test('F9S-TC12', 'the capture request and the upload cap move together', () => {
  // The pixel budget has three terms and they are only meaningful jointly:
  // ask the sensor for a big frame, give the card a big share of that frame
  // (fullscreen), and do not throw the result away at the upload cap. Any one
  // of these alone is a near-no-op, so all three are asserted here — a future
  // change that reverts one of them should fail this test rather than silently
  // reinstate the starved pipeline.
  assert.match(src, /SCAN_CAPTURE_IDEAL_W\s*=\s*4032/);
  assert.match(src, /width:\s*\{\s*ideal:\s*SCAN_CAPTURE_IDEAL_W\s*\}/);
  assert.match(src, /camera-fullscreen/);

  // `exact` would make getUserMedia REJECT on a device that cannot serve the
  // requested mode, and the catch in startCamera reports that as a permissions
  // failure — leaving the user with no camera at all. A lower-resolution
  // scanner still scans; a scanner that will not open does not.
  assert.equal(/exact:\s*SCAN_CAPTURE_IDEAL/.test(src), false);
});

test('F9S-TC13', 'the lens is pinned so iOS cannot hand us the ultra-wide', () => {
  // On multi-lens iPhones WebKit's web zoom domain is [0.5, 10] where anything
  // below 1.0 is the soft ultra-wide, and iOS auto-switches to it at macro
  // distance — i.e. exactly when a card fills the frame. Unset zoom is how a
  // web capture silently ends up blurrier than the native camera app.
  assert.match(src, /applyConstraints\(\{\s*advanced:\s*\[\{\s*zoom:/);
  // Best-effort only: guarded on capabilities and wrapped, because a lens
  // preference must never be the reason the camera fails to open.
  assert.match(src, /caps\.zoom/);
});

test('F9S-TC14', 'the still-photo path is used, and only after the sharpness gate', () => {
  // ImageCapture.takePhoto() routes through AVCapturePhotoOutput — Apple's real
  // still pipeline — instead of a frame off the realtime preview, which iOS
  // deliberately keeps cheap. That is the ManaBox gap Zach measured.
  assert.match(src, /new window\.ImageCapture\(track\)/);
  assert.match(src, /takePhoto\(\{\s*imageWidth: 9999, imageHeight: 9999\s*\}\)/);

  // ORDER: the shutter costs ~0.3-1s, and auto-scan deliberately discards
  // blurred frames. Taking a still BEFORE the gate would pay that cost on every
  // rejected tick, making the scanner slower exactly when conditions are poor.
  // So the gate block must appear before the takeStillPhoto call site.
  const gateAt = src.indexOf('THE SHARPNESS GATE');
  const stillAt = src.indexOf('const still = await takeStillPhoto(video)');
  assert.ok(gateAt > 0 && stillAt > 0, 'both the gate and the still capture must exist');
  assert.ok(gateAt < stillAt,
    'the sharpness gate must run BEFORE the still-photo shutter, not after');
});

test('F9S-TC15', 'an unusable still degrades to the video frame instead of failing', () => {
  // Every rejection path returns null, and null means "use the preview crop" —
  // the pre-existing behaviour. A scanner that stops scanning is far worse than
  // a slightly soft one, so this can only add quality, never remove capture.
  assert.match(src, /typeof window\.ImageCapture !== 'function'\) return null/);
  assert.match(src, /track\.readyState !== 'live'\) return null/);

  // GEOMETRY IS THE REAL RISK. The crop maps preview CSS pixels onto the
  // captured frame assuming a matching aspect ratio. A 4:3 still from a 16:9
  // video mode would silently crop the WRONG REGION — no card at all, which
  // fails without looking like a failure. So a mismatched photo is refused.
  assert.match(src, /Math\.abs\(photoAR - videoAR\) \/ videoAR > 0\.02/);

  // The rotation decision must stay keyed to the VIDEO track: it compares the
  // stream shape against the on-screen layout, which is a fact about the
  // preview, not the still.
  assert.match(src, /const isRotated = isMobile &&/);
});

test('F9S-TC16', 'which capture path fired is reported, not assumed', () => {
  // takeStillPhoto falls back SILENTLY by design, so without this the
  // difference between "the still path works" and "it degraded on every scan"
  // is invisible — and no browser or camera runs in this repo, so Zach's phone
  // is the only place that can answer it.
  assert.match(src, /setCaptureSource\(still \? 'photo' : 'video'\)/);
  assert.match(src, /captureSource === 'photo' \? ' · still photo' : ' · video frame'/);
});

test('F9S-TC17', 'the retry delay is proportional to what the tick actually did', () => {
  // The flat 3s-after-everything cooldown was the bulk of Zach's measured
  // 3-4s per card: real work is ~1.1s, the rest was the app waiting on a timer.
  // A tick the sharpness gate SKIPPED captured nothing and called no server, so
  // punishing it with the same pause as a completed scan meant a card that
  // steadied instantly still sat out three seconds.
  assert.match(src, /SCAN_RETRY_REJECTED_MS\s*=\s*350/);
  assert.match(src, /SCAN_RETRY_SETTLE_MS\s*=\s*900/);
  assert.match(src, /SCAN_RETRY_ERROR_MS\s*=\s*2500/);

  // A rejected frame must retry FAST and a thrown scan must back off SLOW —
  // if those two were ever equal the distinction would be pointless.
  const rejected = Number(src.match(/SCAN_RETRY_REJECTED_MS\s*=\s*(\d+)/)[1]);
  const settle = Number(src.match(/SCAN_RETRY_SETTLE_MS\s*=\s*(\d+)/)[1]);
  const error = Number(src.match(/SCAN_RETRY_ERROR_MS\s*=\s*(\d+)/)[1]);
  assert.ok(rejected < settle && settle < error,
    `retry delays must be ordered rejected < settle < error, got ${rejected}/${settle}/${error}`);

  // The flat constant is gone, not merely unused — a dead timer constant on a
  // screen Zach uses for long stretches invites someone to wire it back up.
  assert.equal(/SCAN_COOLDOWN_MS\s*=\s*\d+/.test(src), false,
    'the flat cooldown constant must be removed, not left dangling');

  // The scheduler has to actually READ the outcome, or the constants are decoration.
  assert.match(src, /lastTickOutcomeRef\.current = 'rejected'/);
  assert.match(src, /lastTickOutcomeRef\.current = 'settle'/);
  assert.match(src, /lastTickOutcomeRef\.current = 'error'/);
});

test('F9S-TC18', 'the auto-add cancel window is shortened but not removed', () => {
  // 2s per card is ~33s across a 100-card stack. One second still shows the
  // card and still accepts a tap to cancel.
  assert.match(src, /SCAN_COUNTDOWN\s*=\s*1/);
  // NOT zero. It is the only pre-commit undo on the auto-add path, and a silent
  // state change is the one thing this app must not do to a physical collection.
  assert.equal(/SCAN_COUNTDOWN\s*=\s*0/.test(src), false,
    'the cancel window must survive — removing it makes auto-add irreversible');
});

console.log(`CameraScanner source-contract self-check passed (${passed} cases)`);
