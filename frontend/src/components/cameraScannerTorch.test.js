// PR 11: TORCH CONTROL and the TEXT-FIRST WIRING in the scanner.
//
// BE HONEST ABOUT WHAT THIS IS. Nothing in this repo runs a browser, a canvas,
// a camera or a MediaStreamTrack, so this is a SOURCE-CONTRACT test: it reads
// CameraScanner.jsx as text and asserts the call sites are shaped correctly. It
// cannot prove that the torch actually stays off on an iPhone, and it cannot
// prove that a title read improves a real photo.
//
// It exists anyway because the specific failure it guards has already shipped
// twice in this project: a correct backend module that the frontend never
// calls. PR 8 built a correct OCR pipeline, a correct resolver and a correct
// queue, all tested and all green, and none of it was connected to the scanner.
// What THIS file proves is that the text-first path is REACHABLE from the
// scanner, and that the torch is not switched on behind the user's back.
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'CameraScanner.jsx'), 'utf8');
const queueSrc = fs.readFileSync(path.join(here, 'scanReviewQueue.js'), 'utf8');

let passed = 0;
function pass(id, msg) { passed++; console.log(`PASS: ${id} - ${msg}`); }

// --- FTORCH-TC1: the torch state initialises OFF ---------------------------
//
// The measured reason: a phone torch on glossy card stock produces a specular
// highlight over the ARTWORK, which is exactly what CLIP reads. Zach's card was
// neither foil nor sleeved and still matched as noise.
{
  assert.ok(/const \[isTorchOn, setIsTorchOn\] = useState\(false\)/.test(src),
    'the torch must initialise to FALSE — ambient light scans glossy cards better');
  pass('FTORCH-TC1', 'the torch state initialises OFF');
}

// --- FTORCH-TC2: nothing ever switches the torch on automatically ----------
//
// This is the property that matters. A default of false is worthless if some
// effect flips it on when the camera starts.
{
  const autoEnables = [
    /setIsTorchOn\(true\)/,
    /torch:\s*true/,
    /advanced:\s*\[\{\s*torch:\s*true/,
  ];
  for (const re of autoEnables) {
    assert.ok(!re.test(src),
      `nothing may enable the torch unconditionally (matched ${re})`);
  }
  // The ONLY assignment must be the user-driven toggle, which derives its value
  // from the current state rather than a literal.
  assert.ok(/const next = !isTorchOn;/.test(src),
    'the torch may only be changed by toggling from its current state');
  pass('FTORCH-TC2', 'no code path enables the torch automatically — only the user toggle');
}

// --- FTORCH-TC3: unsupported torch degrades SILENTLY, never throws ---------
//
// iOS Safari does not report `torch` in getCapabilities(). That must produce a
// plain message, not a dead button and not an exception.
{
  assert.ok(/typeof track\.getCapabilities === 'function'/.test(src),
    'getCapabilities must be feature-detected before use');
  assert.ok(/if \(!caps\.torch\) \{[\s\S]{0,120}errNoTorch/.test(src),
    'an absent torch capability must show errNoTorch and return, not throw');
  pass('FTORCH-TC3', 'an unsupported torch degrades to a message rather than an error');
}

// --- FTORCH-TC4: enabling the torch warns about glare ---------------------
//
// "It's dark, turn on the light" is the obvious move and the wrong one here.
// The warning fires on enable only — never on disable.
{
  assert.ok(/if \(next\) showToast\(t\('scan\.torchGlareWarning'\)\)/.test(src),
    'enabling the torch must warn that glare can stop cards matching');
  pass('FTORCH-TC4', 'switching the torch ON warns about glare; switching it off does not');
}

// --- FTORCH-TC5: the OCR'd TITLE reaches the server -----------------------
//
// The whole redesign is unreachable if the scanner never sends the title.
{
  assert.ok(/titleText/.test(src),
    'CameraScanner must pass the OCR title to the queue controller');
  assert.ok(/const titleText = \(ocr\?\.title \|\| ''\)\.trim\(\);/.test(src),
    'the title must come from the SERVER response (ocr.title), not be re-derived client-side');
  assert.ok(/title_text:\s*titleText \|\| ''/.test(queueSrc),
    'the queue controller must send it as `title_text` — the field the route reads');
  pass('FTORCH-TC5', 'the OCR title is passed from the scan response through to /scan-resolve');
}

// --- FTORCH-TC6: a scan is submitted even when CLIP is NOT confident ------
//
// THE SINGLE POINT OF FAILURE THIS PR REMOVES. The old gate was
// `autoScan && confident && top?.name`, so a glare-hit card whose artwork match
// collapsed into noise was never sent at all — the backend could not rescue a
// request it never received.
{
  assert.ok(!/if \(autoScan && confident && top\?\.name\)/.test(src),
    'the old CLIP-confidence gate must be gone — it blocked text-first entirely');
  assert.ok(/if \(autoScan && \(clipName \|\| titleText\)\)/.test(src),
    'a scan must be submitted when EITHER a confident CLIP name OR a title exists');
  assert.ok(/const clipName = confident && top\?\.name \? top\.name : '';/.test(src),
    'an unconfident CLIP match must be passed as empty, not as a guess');
  pass('FTORCH-TC6', 'a scan is submitted on a readable title even when CLIP is not confident');
}

// --- FTORCH-TC7: the dedup key survives CLIP being wrong ------------------
//
// If the key were always `top.name`, a stack of glared cards would all key on
// '' and every card after the first would be silently skipped — cards missing
// from a scanned stack, which is the failure this app cannot afford.
{
  assert.ok(/const identified = clipName \|\| titleText;/.test(src),
    'the dedup key must fall back to the title when CLIP produced no name');
  assert.ok(/if \(outcome\.action !== 'error'\) lastQueuedNameRef\.current = identified;/.test(src),
    'and must still only be set on a DECIDED outcome, so errors stay retryable');
  pass('FTORCH-TC7', 'the duplicate guard keys on whichever identifier actually exists');
}

// --- FTORCH-TC8: the client still does not second-guess the server -------
//
// The catalogue is the validator and this component is not. The client must
// send raw text and let /scan-resolve decide.
{
  assert.ok(/ocrText: ocr\?\.raw \|\| ''/.test(src),
    'the RAW ocr text must be sent — the server owns the parse');
  assert.ok(!/bestTitleMatch|normaliseTitle|levenshtein/i.test(src),
    'the scanner must NOT reimplement fuzzy title matching client-side');
  pass('FTORCH-TC8', 'the client sends raw text and never re-implements the matching rules');
}

console.log(`\ncameraScannerTorch.test.js: ${passed} cases passed`);
