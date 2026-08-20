// BUG 2 WIRING: the sharpness gate must actually be CONNECTED to auto-scan,
// and must NOT be connected to the manual scan button.
//
// BE HONEST ABOUT WHAT THIS IS. Nothing in this repo runs a browser, a canvas
// or a camera, so this is a SOURCE-CONTRACT test: it reads CameraScanner.jsx
// as text and asserts the call sites are shaped correctly. It cannot prove the
// gate improves a real photo.
//
// It exists anyway because the specific failure it guards is the one that has
// already shipped twice here: a correct module that nothing calls, and a fix
// tuned against a harness the real code path never produces. The behaviour of
// the metric is proven in frameSharpness.test.js; what THIS file proves is that
// the metric is reachable from the auto path and unreachable from the button.
//
// The threshold itself remains unvalidated by any test in this repo. Only
// Zach's iPhone can confirm it.
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'CameraScanner.jsx'), 'utf8');

let passed = 0;
function pass(id, msg) { passed++; console.log(`PASS: ${id} - ${msg}`); }

// --- FGATE-TC1: the gate module is actually imported ------------------------
{
  assert.ok(/import\s*\{[^}]*laplacianVarianceScore[^}]*\}\s*from\s*['"]\.\.\/utils\/frameSharpness['"]/.test(src),
    'CameraScanner must import laplacianVarianceScore from the real module — not reimplement it');
  assert.ok(/decideCapture/.test(src),
    'and must use the shared decideCapture rule, so the threshold has ONE definition');
  pass('FGATE-TC1', 'the scanner imports the real sharpness module rather than duplicating it');
}

// --- FGATE-TC2: handleCapture takes an explicit `auto` flag -----------------
{
  assert.ok(/const handleCapture = async \(auto = false\) =>/.test(src),
    'handleCapture must take `auto`, DEFAULTING TO FALSE so any unflagged caller is ungated');
  pass('FGATE-TC2', 'handleCapture takes an explicit auto flag that defaults to ungated');
}

// --- FGATE-TC3: the auto metronome passes auto=true -------------------------
// If this regressed, the gate would exist and never run — the "shipped a
// backend the frontend never called" failure, in miniature.
{
  assert.ok(/handleCaptureRef\.current\?\.\(true\)/.test(src),
    'the auto-scan timer MUST call handleCapture(true), or the gate never runs');
  pass('FGATE-TC3', 'the auto-scan timer invokes the gated path');
}

// --- FGATE-TC4: THE MANUAL BUTTON IS NEVER GATED ---------------------------
//
// The most important assertion in this file. `onClick={handleCapture}` passes
// the CLICK EVENT as the first argument; a click event object is truthy, so the
// button would silently become gated and Zach could press scan and get nothing.
// The wrapper must be explicit.
{
  assert.ok(/onClick=\{\(\) => handleCapture\(false\)\}/.test(src),
    'the scan button must call handleCapture(false) explicitly');
  // Match only real JSX attributes, not the explanatory comment above the
  // button which necessarily quotes the dangerous form.
  const jsxOnly = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/onClick=\{handleCapture\}/.test(jsxOnly),
    'onClick={handleCapture} would pass the truthy click EVENT as `auto` and gate the manual button');
  pass('FGATE-TC4', 'the manual scan button is explicitly ungated — a press always scans');
}

// --- FGATE-TC5: the gate is inside an `if (auto)` block --------------------
{
  const gateIdx = src.indexOf('laplacianVarianceScore(px.data');
  assert.ok(gateIdx > 0, 'the gate must actually score pixels');
  const before = src.slice(0, gateIdx);
  const guardIdx = before.lastIndexOf('if (auto) {');
  assert.ok(guardIdx > 0 && guardIdx > before.lastIndexOf('const handleCapture'),
    'the scoring must sit inside an `if (auto)` guard within handleCapture');
  pass('FGATE-TC5', 'the sharpness scoring runs only under the auto guard');
}

// --- FGATE-TC6: a skip reschedules rather than dying -----------------------
// The capture effect keys on `loading`. If a skip returned without clearing
// loading, auto-scan would freeze on the first blurred frame — turning a blur
// fix into a total scanner outage.
{
  const skipIdx = src.indexOf('if (!decision.capture)');
  assert.ok(skipIdx > 0, 'there must be a skip branch');
  const block = src.slice(skipIdx, skipIdx + 500);
  assert.ok(/setLoading\(false\)/.test(block),
    'a skipped frame MUST clear loading, or the capture effect never reschedules and auto-scan freezes');
  assert.ok(!/signal\('capture'\)/.test(block),
    'a skipped frame must NOT fire the capture cue — nothing was captured');
  pass('FGATE-TC6', 'a skipped frame clears loading to reschedule and fires no capture cue');
}

// --- FGATE-TC7: the gate FAILS OPEN ----------------------------------------
// getImageData throws on a tainted canvas. A browser refusing pixels must
// degrade to the old ungated behaviour, never to a scanner that captures
// nothing.
{
  const catchIdx = src.indexOf("reason: 'gate-unavailable'");
  assert.ok(catchIdx > 0,
    'the gate must FAIL OPEN when pixels are unavailable — a broken gate must not stop scanning');
  // The capture flag is what makes it fail OPEN rather than closed.
  const decl = src.slice(src.lastIndexOf('decision = {', catchIdx), catchIdx);
  assert.ok(/capture:\s*true/.test(decl),
    'the fail-open path must set capture: true');
  pass('FGATE-TC7', 'the gate fails open if the canvas refuses pixels');
}

// --- FGATE-TC8: the gate state holds NO timer handles ----------------------
//
// An earlier PR shipped an iOS Safari crash from a debounce that packed bare
// setTimeout handles into an object. The gate's ref must stay plain data.
{
  const refIdx = src.indexOf('const sharpnessRef = useRef(');
  assert.ok(refIdx > 0, 'the gate state must live in a ref');
  const decl = src.slice(refIdx, src.indexOf(')', refIdx) + 1);
  assert.ok(/newGateState\(\)/.test(decl),
    'the gate ref must be seeded from the shared newGateState(), so its shape has ONE definition');
  assert.ok(!/setTimeout|setInterval/.test(decl),
    'NO timer handles in the gate state — that exact shape crashed iOS Safari before');
  pass('FGATE-TC8', 'the gate state comes from newGateState(), no timer handles packed into an object');
}

// --- FGATE-TC9: BUG 2 — no absolute threshold survives ---------------------
//
// The regression guard for the reported bug. The gate compared every frame to
// a constant 12 tuned against synthetic blur, and on Zach's real iPhone 16
// "hold steady showed on like every card". If a future change reintroduces an
// absolute cut point, this fails.
{
  const mod = fs.readFileSync(path.join(here, '..', 'utils', 'frameSharpness.js'), 'utf8');
  assert.ok(!/SHARPNESS_MIN_SCORE/.test(mod),
    'the absolute SHARPNESS_MIN_SCORE threshold must be GONE — it is BUG 2');
  assert.ok(/SHARPNESS_REL_FLOOR/.test(mod) && /baselineOf/.test(mod),
    'the gate must judge frames against a rolling per-device baseline instead');
  assert.ok(!/SHARPNESS_MIN_SCORE/.test(src),
    'and CameraScanner must not reference the removed constant');
  pass('FGATE-TC9', 'no absolute sharpness threshold remains — the gate is relative to the device');
}

// --- FGATE-TC10: the observed scores are surfaced, not just computed -------
//
// BUG 2 was a guessed number nobody could check; it took Zach scanning a real
// stack to disprove it. The scores must reach a surface he can read, so the
// next adjustment is measured.
{
  assert.ok(/gateLogRef/.test(src), 'the gate decisions must be recorded');
  assert.ok(/decision\.score/.test(src) && /decision\.baseline/.test(src),
    'and must record BOTH the observed score and the baseline it was judged against');
  assert.ok(/t\('scan\.focusGateDebug'\)/.test(src),
    'and must be rendered somewhere Zach can actually read them');
  pass('FGATE-TC10', 'observed focus scores and baselines are surfaced for measured diagnosis');
}

console.log(`\ncameraScannerGate.test.js: ${passed} cases passed`);
