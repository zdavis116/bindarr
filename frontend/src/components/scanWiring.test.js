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
  assert.match(src, /SCAN_UPLOAD_W\s*=\s*1280/);
  assert.match(src, /SCAN_UPLOAD_W/);
});

console.log(`CameraScanner source-contract self-check passed (${passed} cases)`);
