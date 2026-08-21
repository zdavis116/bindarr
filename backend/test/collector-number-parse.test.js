// PR 8: the collector-number parser — the boundary where a misread becomes
// either a refusal or a wrong card in Zach's collection.
//
// These are UNIT tests on purpose. The e2e suite proves the route behaviour;
// this proves the parser refuses the specific junk tesseract was MEASURED
// emitting on real card images (see backend/tools/ocr-bench). Every `raw`
// string below except where noted is real observed OCR output, not invented.
const assert = require('assert');
const { parseCollectorStrip } = require('../src/utils/collectorNumberParse');

let passed = 0;
function check(id, desc, fn) {
  try { fn(); passed++; console.log(`PASS: ${id} - ${desc}`); }
  catch (e) { console.error(`FAIL: ${id} - ${desc}\n  ${e.message}`); process.exitCode = 1; }
}

// --- reads that must SUCCEED ------------------------------------------------

check('F8P-TC1', 'reads a plain number/total form', () => {
  const r = parseCollectorStrip('263/281 U\nC21 * EN MIKE BIEREK');
  assert.strictEqual(r.number, '263');
  assert.strictEqual(r.set, 'c21');
  assert.strictEqual(r.confident, true);
});

check('F8P-TC2', 'strips leading zeros from the printed padded form', () => {
  // Cards print "0410"; card_cache stores "410". Same value, different padding.
  const r = parseCollectorStrip('U 0410 CMM * EN MIKE BIEREK');
  assert.strictEqual(r.number, '410');
  assert.strictEqual(r.set, 'cmm');
});

check('F8P-TC3', 'takes the part BEFORE the slash, never the set size', () => {
  const r = parseCollectorStrip('049/277 U MID * EN DAVID PALUMBO');
  assert.strictEqual(r.number, '49', 'must be the collector number, not 277');
});

check('F8P-TC4', 'keeps a suffixed number as a STRING', () => {
  // parseInt('123a') === 123 would match a DIFFERENT printing while looking
  // like a success. This is the silent-wrong-card case.
  const r = parseCollectorStrip('123a R PLST * EN');
  assert.strictEqual(r.number, '123a');
  assert.strictEqual(typeof r.number, 'string');
});

check('F8P-TC5', 'handles a 4-digit number without treating it as a year', () => {
  const r = parseCollectorStrip('1508 SLD * EN ANDREA RADECK');
  assert.strictEqual(r.number, '1508');
});

// --- reads that must REFUSE -------------------------------------------------
//
// Each of these is a real tesseract output on a card that carries NO printed
// collector number. Returning a number for any of them would silently record a
// card Zach does not own.

check('F8P-TC6', 'refuses an artist credit (1993 frame, no number printed)', () => {
  const r = parseCollectorStrip('L illu, (c) Chiciston');
  assert.strictEqual(r.number, null, 'an artist credit is not a collector number');
  assert.strictEqual(r.confident, false);
});

check('F8P-TC7', 'refuses a copyright line (2003 frame, no number printed)', () => {
  const r = parseCollectorStrip('--= Matthew D. Wilson TM & (c) 1993-2007 Wizards of the Co');
  assert.strictEqual(r.number, null,
    'the year 2007 must not be read as collector number 2007');
});

check('F8P-TC8', 'refuses empty and whitespace-only OCR output', () => {
  for (const raw of ['', '   ', '\n\n', null, undefined]) {
    const r = parseCollectorStrip(raw);
    assert.strictEqual(r.number, null, `must refuse ${JSON.stringify(raw)}`);
    assert.strictEqual(r.confident, false);
  }
});

check('F8P-TC9', 'refuses pure noise', () => {
  const r = parseCollectorStrip('cc gE');
  assert.strictEqual(r.number, null);
});

// --- set-code discipline ----------------------------------------------------

check('F8P-TC10', 'never returns a language tag as a set code', () => {
  const r = parseCollectorStrip('281 M ZNR * EN DAVID RAPOZA');
  assert.strictEqual(r.set, 'znr', 'EN is a language, not a set');
});

check('F8P-TC11', 'never returns an all-digit token as a set code', () => {
  const r = parseCollectorStrip('263\n');
  assert.strictEqual(r.number, '263');
  assert.strictEqual(r.set, null, '263 is a number, not a set code');
});

// --- the property that actually protects the collection ---------------------

check('F8P-TC12', 'a confident read is still only a LOOKUP KEY, never a decision', () => {
  // 'M1508' was a REAL misread of '1508' in the benchmark. The parser accepts
  // it as a well-formed token — it cannot know better — and that is fine,
  // BECAUSE no printing of the card has that number, so the catalogue lookup
  // returns nothing and the card queues. The parser's job is to refuse
  // NON-NUMBERS; the catalogue's job is to refuse numbers that do not exist.
  const r = parseCollectorStrip('M1508 SLD * EN ANDREA RADECK');
  assert.ok(r.number === 'M1508' || r.number === null,
    'either shape is safe; what must never happen is silently becoming 1508');
  assert.notStrictEqual(r.number, '1508',
    'a misread must NOT be "corrected" into a real printing — that is the guess we forbid');
});

// --- BUG 1: the rarity letter glued to the number ---------------------------
//
// Zach's iPhone 16 read Avatar Aang (tla #207) as '#M0207 · TAA'. The M is the
// printed RARITY, not part of the number. These pin the rule that `number`
// stays exactly as read while `numberAlt` offers the stripped reading for the
// CATALOGUE to adjudicate.

check('F8P-TC13', 'a glued rarity letter is preserved in number and offered as numberAlt', () => {
  const r = parseCollectorStrip('M0207/0286\nTAA * EN SOME ARTIST');
  assert.strictEqual(r.number, 'M0207',
    'the read is reported EXACTLY as read — never silently rewritten');
  assert.strictEqual(r.numberAlt, '207',
    'and the rarity-stripped reading is offered as a second candidate');
  assert.strictEqual(r.confident, true);
});

check('F8P-TC14', 'numberAlt is null when there is no plausible alternative', () => {
  // A plain number has no leading letter to strip.
  assert.strictEqual(parseCollectorStrip('263/281 U\nC21 * EN').numberAlt, null);
  // 'GR1' is a REAL collector number shape. 'R1' is not a rarity+number
  // reading of it, so no alternative is offered.
  assert.strictEqual(parseCollectorStrip('GR1\nMH2 * EN').numberAlt, null);
});

check('F8P-TC15', 'numberAlt NEVER replaces the primary read', () => {
  // The F8P-TC12 property, restated against the new field. 'M1508' was a real
  // observed misread. The parser may SUGGEST '1508' but must still report
  // 'M1508' as what it actually read — the catalogue decides which is real.
  const r = parseCollectorStrip('M1508 SLD * EN ANDREA RADECK');
  assert.strictEqual(r.number, 'M1508', 'the primary read is untouched');
  assert.notStrictEqual(r.number, '1508',
    'a misread must NOT be "corrected" into a real printing — that is the guess we forbid');
});

check('F8P-TC16', 'the OCR rectify size keeps the collector number above the engine floor', () => {
  // THE ARITHMETIC BUG THIS PINS. rectifyCard warps every scan to a FIXED
  // OCR_W x OCR_H before reading. At the old 750x1050 the numbers were:
  //
  //   card height 88mm, collector-number cap height ~1.2mm
  //   1050px / 88mm = 11.9 px/mm  ->  the number lands ~14px tall
  //
  // Tesseract needs ~20px of cap height for small print, so every scan was
  // handed a strip BELOW the floor and returned EMPTY — measured on Zach's
  // stack, every queue row had ocr_number=NULL and raw=''. Unique LANDS failing
  // is what made it unmistakable: those have nothing to disambiguate, so the
  // only explanation was that the strip was never legible at all.
  //
  // This was invisible for months because 750 was an UPSCALE when the capture
  // delivered a ~660px card. The capture work since (fullscreen, full-res
  // request, lens pin, ImageCapture stills) delivers 1400-2600px, at which
  // point the SAME constant became a downscale discarding all of it — the same
  // dead-clamp trap as SCAN_UPLOAD_W, one layer deeper.
  //
  // Pinned as ARITHMETIC rather than as a magic number so the reason survives:
  // if someone lowers OCR_SCALE for speed, this fails and says why.
  const { OCR_W, OCR_H } = require('../src/utils/collectorNumberOcr');
  const CARD_HEIGHT_MM = 88;
  const NUMBER_CAP_MM = 1.2;
  const OCR_FLOOR_PX = 20;

  const numberPx = (OCR_H / CARD_HEIGHT_MM) * NUMBER_CAP_MM;
  assert.ok(numberPx >= OCR_FLOOR_PX,
    `the collector number must reach the OCR floor: OCR_H=${OCR_H} gives ${numberPx.toFixed(1)}px, need >=${OCR_FLOOR_PX}px`);

  // Aspect must stay card-shaped, or the strip crop fractions point at the
  // wrong part of the card and a bigger image reads nothing at all.
  const aspect = OCR_W / OCR_H;
  assert.ok(Math.abs(aspect - (2.5 / 3.5)) < 0.01,
    `the rectify target must keep the card aspect, got ${aspect.toFixed(3)}`);
});

console.log(`\nCollector-number parser: ${passed} cases passed.`);
if (process.exitCode) process.exit(process.exitCode);
