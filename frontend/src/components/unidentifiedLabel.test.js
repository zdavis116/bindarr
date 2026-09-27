// What the staging review must show for a card the scanner could not name.
//
// SUPERSEDES scanOutcome.test.js SO-TC5, which asserted this against
// CameraScanner's old unidentified branch. That branch is gone -- the scan
// path moved into utils/fastScanLoop.js and the two duplicate scan paths
// collapsed into one -- but the RULE it guarded is unchanged and still
// load-bearing, so it follows the code instead of being deleted with it.
//
// THE RULE: a row the scanner could not identify is labelled 'Unidentified
// card'. It must never echo raw OCR text into the UI. Garbled OCR presented as
// a card name reads like the app found something and got it wrong, which is
// worse than admitting it found nothing: the user trusts a name-shaped string.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'ScanStagingReview.jsx'), 'utf8');
// Comments stripped: asserting a string that also appears in a comment is how
// an earlier guard in this repo passed while the real line was deleted.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// UNID-TC1: the fallback label exists and is the literal string.
{
  start('UNID-TC1');
  assert.match(code, /matched_name \|\| 'Unidentified card'/,
    "an unnamed staged row must fall back to 'Unidentified card' -- without "
    + 'the fallback the row renders blank or undefined');
  pass('UNID-TC1', 'unnamed rows get an honest label');
}

// UNID-TC2: raw OCR text is never used as the name.
//
// The staged row carries ocr_raw/ocr_text for the review UI to SHOW AS
// EVIDENCE, which is fine. What must never happen is those fields standing in
// for the card's name.
{
  start('UNID-TC2');
  const asName = /matched_name \|\|\s*(entry\.)?(ocr_raw|ocr_text|ocrText|titleText)/;
  assert.ok(!asName.test(code),
    'raw OCR text is being used as the card name; a garbled string in the '
    + 'name position reads as a wrong identification rather than no '
    + 'identification');
  pass('UNID-TC2', 'OCR text is never promoted into the name position');
}

console.log(`\nunidentifiedLabel.test.js: ${passed} cases passed`);
