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
//
// SCOPE WIDENED, BEHAVIOUR UNCHANGED. The scan path moved out of
// CameraScanner.jsx into utils/scannerWiring.js (one path, replacing the two
// that used to double-stage cards), so reading only CameraScanner.jsx now
// misses the call site. The RULE is the same -- titleText must be handed to
// the queue -- so the assertion follows the code rather than being deleted or
// weakened. A test pinned to a FILE fails when code moves; the property it
// guards has not changed.
{
  const wiring = fs.readFileSync(path.join(here, '..', 'utils', 'scannerWiring.js'), 'utf8');
  assert.ok(/titleText/.test(src) || /titleText/.test(wiring),
    'the scanner must pass the OCR title to the queue controller');
  // THE SOURCE OF THE TITLE CHANGED, and the old assertion named the old
  // source. It required `const titleText = (ocr?.title || '').trim()` -- the
  // title parsed out of the SERVER's OCR response, because back then the
  // server was the only thing that read cards.
  //
  // The on-device reader now reads the title itself, on the phone, from the
  // same frame it identifies. meta.title IS that read. There is no server OCR
  // response on the fast path at all, so the old expression cannot exist.
  //
  // The rule worth keeping is "the title is READ, not re-derived from the
  // matched card's name" -- i.e. it must be evidence about the cardboard, not
  // an echo of what we already decided. `meta.title || card.name` satisfies
  // that: the read wins, with the identified name only as a last resort.
  assert.ok(/titleText:\s*meta\.title\s*\|\|\s*card\.name/.test(wiring),
    'the title must come from the READER (meta.title), falling back to the '
    + 'identified card name only when the read produced nothing');
  assert.ok(/title_text:\s*titleText \|\| ''/.test(queueSrc),
    'the queue controller must send it as `title_text` — the field the route reads');
  pass('FTORCH-TC5', 'the OCR title is passed from the scan response through to /scan-resolve');
}

// --- FTORCH-TC6: an artwork match can never gate a scan -------------------
//
// THE SINGLE POINT OF FAILURE THIS ORIGINALLY REMOVED. The old gate was
// `autoScan && confident && top?.name`, so a glare-hit card whose artwork
// match collapsed into noise was never sent at all -- the backend could not
// rescue a request it never received. The fix then was to submit whenever
// EITHER a confident CLIP name OR a read title existed.
//
// THE PREMISE IS NOW GONE, NOT THE RULE. CLIP was deleted with the rest of the
// old server scanner (it was the second engine whose separate dedupe key put
// the same card in the tray twice). There is no artwork-confidence value left
// to gate on, which makes the original failure mode structurally impossible
// rather than merely guarded against.
//
// So this asserts the stronger property the port actually established: the
// scan decision is made from the READ (title + collector footer), and no
// artwork-similarity score appears in it at all.
{
  const loop = fs.readFileSync(path.join(here, '..', 'utils', 'fastScanLoop.js'), 'utf8');
  const loopCode = loop
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

  assert.ok(!/if \(autoScan && confident && top\?\.name\)/.test(src),
    'the old CLIP-confidence gate must stay gone -- it blocked text-first entirely');
  for (const dead of ['clipName', 'confident', 'rgbArtMatch', 'scanMatch']) {
    assert.ok(!new RegExp(`\\b${dead}\\b`).test(loopCode),
      `the scan decision still references ${dead}; an artwork score must not `
      + 'be able to gate a scan the reader already proved');
  }
  // And the decision must be driven by the reader's own eligibility, which is
  // what replaced it.
  assert.ok(/needsServer\(local, \{ autoPass \}\)/.test(loopCode),
    'the scan decision must come from the reader (needsServer), not an '
    + 'artwork-similarity threshold');
  pass('FTORCH-TC6', 'the scan decision is text-first with no artwork gate left to fail');
}

// --- FTORCH-TC7: the dedup key cannot collapse across different cards -----
//
// THE FAILURE THIS GUARDS, unchanged: if the key were always `top.name`, a
// stack of glared cards would all key on '' and every card after the first
// would be silently skipped -- cards missing from a scanned stack, which is
// the failure this app cannot afford.
//
// THE KEY ITSELF CHANGED, and the new one is strictly stronger. It used to be
// `clipName || titleText` -- a STRING, and two different printings of one card
// share it. It is now the Scryfall id, with a time window, which is what
// upstream uses (FastScanner.jsx:301-306). An id cannot collapse to '' and
// cannot be shared by two different cards, so the original failure mode is
// structurally impossible rather than merely handled.
//
// This was also the bug Zach reported directly: the on-device path keyed on
// card.id while the old server path keyed on a CLIP name, both writing into
// one Map, so neither could see the other's entries and the same card staged
// twice a second apart.
{
  const wiring2 = fs.readFileSync(path.join(here, '..', 'utils', 'scannerWiring.js'), 'utf8');
  const loop2 = fs.readFileSync(path.join(here, '..', 'utils', 'fastScanLoop.js'), 'utf8');
  const loopCode2 = loop2
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

  // Every keyed access must use the card id -- one key, one rule, one place.
  const keys = loopCode2.match(/seenIdsRef\.current\.(?:get|set)\(([^,)]+)/g) || [];
  assert.ok(keys.length >= 2, 'the dedupe window must be both read and written');
  for (const k of keys) {
    assert.match(k, /h\.card\.id/,
      `the dedupe key is ${k}; keying on anything but the card id lets two `
      + 'scan paths write keys that can never match');
  }
  assert.match(loopCode2, /now - last > SEEN_CARD_MS/,
    'the guard must expire on a clock, not latch until some event clears it');
  // And the outcome handler must not touch the window: an errored scan has to
  // stay retryable, or a card goes silently missing from the stack.
  assert.ok(!/seenIdsRef/.test(wiring2),
    'the outcome handler must not record into the dedupe window -- an errored '
    + 'scan would then be treated as already seen and skipped');
  pass('FTORCH-TC7', 'one dedupe rule, keyed on the card id, expiring on a clock');
}

// --- FTORCH-TC8: the client still does not second-guess the catalogue ----
//
// The catalogue is the validator and this component is not. That principle is
// unchanged; what the client SENDS changed.
//
// It used to forward `ocrText: ocr?.raw` -- raw OCR text for /scan-resolve to
// parse -- because the server did the reading. The on-device reader now does
// the reading AND the resolving: it proves an exact printing against the full
// Scryfall index before anything is submitted, so there is no raw text left to
// forward and ocrText is deliberately ''.
//
// What must still hold, and what this now asserts: the client sends the
// printing it PROVED as a hint, and never re-implements the matching rules
// itself. The server still validates the hint against the catalogue.
{
  const wiring3 = fs.readFileSync(path.join(here, '..', 'utils', 'scannerWiring.js'), 'utf8');
  assert.ok(/printingHint: \{ set: card\.set_id, number: card\.number \}/.test(wiring3),
    'the proven printing must be sent as a HINT for the server to validate, '
    + 'not asserted as fact');
  assert.ok(/ocrText: ''/.test(wiring3),
    'there is no raw server-side OCR on this path; sending stale text would '
    + 'invite the server to re-parse evidence the reader already resolved');
  for (const f of [src, wiring3]) {
    assert.ok(!/bestTitleMatch|normaliseTitle|levenshtein/i.test(f),
      'the scanner must NOT reimplement fuzzy title matching client-side');
  }
  pass('FTORCH-TC8', 'the client sends a proven hint and never re-implements the matching rules');
}

console.log(`\ncameraScannerTorch.test.js: ${passed} cases passed`);
