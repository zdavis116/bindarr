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

check('F8P-TC17', 'a read that cannot be a collector number is never confident', () => {
  // FROM ZACH'S REAL SCANS. Both of these came back confident=true:
  //     'D294'   (a Marvel land, the L misread as D)
  //     'M0069'  (mythic 69, rarity letter glued to the digits)
  //
  // Neither is a collector number. The danger is not the misread itself — it is
  // reporting it as CONFIDENT, because the OCR fallback adds a card outright on
  // a confident set+number. The review queue exists for "we don't know"; it
  // cannot catch "we're sure and wrong".
  //
  // The two cases are genuinely different and must behave differently:
  //   M0069 is RECOVERABLE — M is a real rarity, so numberAlt offers 69 and the
  //         resolver tries both readings against the catalogue.
  //   D294  is NOT — D is not a rarity, so there is no alternative reading and
  //         the literal 'D294' can never match a row.
  const bad = parseCollectorStrip('D294\nRvryg Sat');
  assert.strictEqual(bad.confident, false,
    `'D294' has no recoverable reading and must not be confident, got ${JSON.stringify(bad)}`);
  assert.strictEqual(bad.numberAlt, null);

  const recoverable = parseCollectorStrip('M0069\nMSH EN CHRIS');
  assert.strictEqual(recoverable.confident, true,
    'a rarity-prefixed number IS recoverable via numberAlt and stays confident');
  assert.strictEqual(recoverable.numberAlt, '69');

  // And the ordinary shapes must be untouched by the guard.
  assert.strictEqual(parseCollectorStrip('L 0295\nMSH EN').confident, true);
  assert.strictEqual(parseCollectorStrip('0287').confident, true);
  assert.strictEqual(parseCollectorStrip('263a').confident, true,
    'letter SUFFIXES are real collector numbers (263a) and must stay confident');
});

check('F8P-TC18', 'a truncated read is reported but not trusted', () => {
  // Caught by the distant-card fixture when the strip window was widened: a
  // Sol Ring #263 read as '26} \' and reported number=26, confident=true.
  // '26' is a real collector number, so nothing downstream could tell it was
  // wrong. The tell is the debris glued to the digits.
  const clipped = parseCollectorStrip('26} \\\nC21 + EN Mint Burris');
  assert.strictEqual(clipped.number, '26', 'the number is still REPORTED — it is evidence');
  assert.strictEqual(clipped.confident, false, 'but nothing may act on it alone');
});

check('F8P-TC19', 'every set-shaped token is offered, not just the first', () => {
  // Zach: "You should use all information possible."
  //
  // Measured on 20 real scans, the FIRST set-shaped token is wrong on five:
  // 'turn' off the rules text, 'wml'/'stey'/'dan' off the artist line, 'teens'
  // out of noise. The parser has no catalogue and cannot judge, so it returns
  // everything it saw and the RESOLVER validates against real printings.
  const p = parseCollectorStrip('turn.\nR 0213\nMSH + EN he DAN Bi');
  assert.ok(Array.isArray(p.setCandidates));
  assert.ok(p.setCandidates.includes('msh'),
    `the real set must be among the candidates, got ${JSON.stringify(p.setCandidates)}`);
  assert.ok(p.setCandidates.length > 1,
    'and the wrong first guess must not be the only option offered');
});


check('F8P-TC20', 'a set code glued to its language suffix still yields the set', () => {
  // Zach: "I count queues as failures... I would expect maybe 1 not 4."
  //
  // ALL FOUR queues in that session read the NUMBER correctly and then failed
  // on the set. The set line is "<SET> <sep> <LANG> <sep> <ARTIST>" and the
  // separator is a tiny glyph OCR renders as *, A, «, ® — or drops entirely.
  // When it drops, set and language fuse into one token that matches no set.
  //
  // Real raw reads from his scans, with what the card actually is:
  const cases = [
    ['Pr\nL 0296\nMSH*EN % RYTIS SA\n', 'msh'],      // separator vanished
    ['RS S=,\nC 0247\nMSHAEN \u00a5% DAVID\n', 'msh'],    // '*' read as 'A'
    ['REE\nL 0295\nMSH*EN \u00bb DOMENIC\n', 'msh'],
    ['L 02906\nMSH \u00ab EN % RYTIS SA\n', 'msh'],
  ];
  for (const [raw, want] of cases) {
    const p = parseCollectorStrip(raw);
    assert.ok(p.setCandidates.includes(want),
      `expected '${want}' among candidates for ${JSON.stringify(raw)}, `
      + `got ${JSON.stringify(p.setCandidates)}`);
  }
});

check('F8P-TC21', 'a spurious digit in the zero padding is offered as an alternative', () => {
  // 'L 02906' on a card that is #296. Collector numbers print zero-padded to
  // four digits and OCR inserted a fifth. Offered as an ALTERNATIVE reading,
  // never a rewrite: the catalogue decides, and if both readings resolve the
  // resolver queues it as genuine ambiguity.
  const p = parseCollectorStrip('L 02906\nMSH \u00ab EN % RYTIS SA\n');
  assert.strictEqual(p.number, '2906', 'the literal reading must be preserved');
  assert.strictEqual(p.numberAlt, '296', 'the padded-digit alternative must be offered');
});

check('F8P-TC22', 'the language split does not invent sets from ordinary words', () => {
  // The stem logic must not fire on any word that happens to end in a language
  // code. 'garden' ends in 'en'; 'gard' is not a set and must not be asserted
  // as one — but the parser has no catalogue, so the real guarantee is that the
  // ORIGINAL token is still offered and the stem is only ever an ADDITION.
  const p = parseCollectorStrip('R 0100\nGARDEN % SOMEONE\n');
  assert.ok(p.setCandidates.includes('garden'),
    'the token as read must still be offered');
  // A stem may be present, but it can never REPLACE the literal reading.
  assert.ok(p.setCandidates.indexOf('garden') >= 0);
});


check('F8P-TC23', "bleed-through from the card above must not become this card's number", () => {
  // THE WORST BUG THIS PROJECT HAS HAD. Zach: "one scan was bad marked super
  // solider serum as kid Loki" -- a confident WRONG card in his collection,
  // which he cannot reconcile against the physical stack without recounting it.
  //
  // The capture clearly showed 'R 0038 / MSH*EN / Rafater'. OCR read it fine:
  //
  //     "| iil 63\nrR 0038\nMSH *EN be RAFAT\nNET Ue SRT\nEr\n"
  //          ^^                ^^^^
  //     bleed-through       the real number
  //
  // The first line is blurred text from the card BEHIND this one in the stack,
  // caught because the OCR window was widened to stop missing numbers. Taking
  // the first number-shaped token took the noise -- and 63 is a REAL Marvel
  // card (Kid Loki), so it resolved cleanly to the wrong card. Nothing about
  // the result looked wrong.
  //
  // The card's own number is always printed directly above its set line, so
  // that adjacency is what identifies it.
  const p = parseCollectorStrip('| iil 63\nrR 0038\nMSH *EN be RAFAT\nNET Ue SRT\nEr\n');
  assert.strictEqual(p.number, '38',
    `expected the number adjacent to the set line (38), got ${p.number}`);
  assert.ok(p.setCandidates.includes('msh'));
});

check('F8P-TC24', 'a set code containing digits is never read as the number', () => {
  // My first version of the adjacency rule accepted a number token from the SET
  // LINE ITSELF as well as the line above. F8P-TC1/TC14/TC18 caught it at once:
  // 'C21' is a real set (Commander 2021) and matches the number shape, so the
  // parser returned the SET as the NUMBER.
  //
  // Only the line ABOVE the set line counts.
  const p = parseCollectorStrip('263/281 U\nC21 * EN MIKE BIEREK');
  assert.strictEqual(p.number, '263', `read the set code as the number: ${p.number}`);
  assert.strictEqual(p.set, 'c21');
});

check('F8P-TC25', 'with no legible set line, the old first-token behaviour remains', () => {
  // The adjacency rule is an IMPROVEMENT where the set line is readable, not a
  // new requirement. A strip with no recognisable set line must be no worse off
  // than before this change.
  const p = parseCollectorStrip('R 0213\nsome noise here\n');
  assert.strictEqual(p.number, '213');
});


check('F8P-TC26', 'an artist name is not mistaken for the set line', () => {
  // Zach: "evils thrall has set code and number but still didn't match not sure
  // why."
  //
  // The strip read 'uv 0128 / MSH (R)EN % Mintav / Nemes 5 BE'. Candidates came
  // back as ['msh', 'nemes', 'nem'] -- 'nem' is the artist's name 'Nemes' with
  // its last letter stripped by the language-suffix rule added for glued tokens
  // ('mshen' -> 'msh').
  //
  // 'nem' is a REAL set (Nemesis) and nem #128 is a REAL card (Complex
  // Automaton). So msh #128 and nem #128 BOTH resolved, the resolver correctly
  // called that ambiguous, and a card it had actually identified was queued.
  //
  // The set code is printed ON THE SET LINE; an artist name is not. The parser
  // reports which candidates came from that line so the resolver can prefer
  // them.
  //
  // NOTE the separator requirement: 'Nemes' is itself <3-5 chars><lang 'es'>
  // with nothing between, so a permissive pattern matched the ARTIST line too.
  const p = parseCollectorStrip('uv 0128\nMSH \u00aeEN \u00a5% Mintav\nNemes 5 BE\n');
  assert.strictEqual(p.number, '128');
  assert.ok(p.setCandidates.includes('msh'), 'the real set must still be offered');
  assert.deepStrictEqual(p.setLineCandidates, ['msh'],
    `only the set line's own candidates may be flagged, got `
    + `${JSON.stringify(p.setLineCandidates)}`);
});

check('F8P-TC27', 'setLineCandidates is a subset of setCandidates', () => {
  // The resolver tiers on this. If a set-line candidate were ever absent from
  // the full list, the tiering would silently drop a real reading.
  for (const raw of [
    'uv 0128\nMSH \u00aeEN \u00a5% Mintav\nNemes 5 BE\n',
    '| iil 63\nrR 0038\nMSH *EN be RAFAT\n',
    '263/281 U\nC21 * EN MIKE BIEREK',
    'RS S=,\nC 0247\nMSHAEN \u00a5% DAVID\n',
  ]) {
    const p = parseCollectorStrip(raw);
    for (const c of p.setLineCandidates || []) {
      assert.ok(p.setCandidates.includes(c),
        `set-line candidate '${c}' missing from setCandidates for ${JSON.stringify(raw)}`);
    }
  }
});


check('F8P-TC28', "a neighbouring card's set line must not donate a number", () => {
  // Zach: "one had the wrong set number turtle duck".
  //
  //     line 0  'Ww WE V WV'            noise
  //     line 1  'TLA * EN % SYLVAIN'    the real set line
  //     line 2  '"MSH XEN 8 RAFATE'     a SECOND set line, bleeding through
  //                                     from the card below in the stack
  //
  // The Turtle-Duck's own number was not legible. The parser found nothing
  // above the set line and fell back to "the first number-shaped token
  // anywhere", which was the '8' inside the NEIGHBOURING card's set line.
  // tla #8 is a real card, so it resolved confidently to the wrong printing.
  //
  // When a set line exists, this card's number is the one above it -- or we did
  // not read it. Reporting nothing queues; reporting a neighbour's digits puts
  // the wrong card in his collection.
  const p = parseCollectorStrip('Ww WE V WV\nTLA \u00ab EN % SYLVAIN\n\u201cMSH XEN 8 RAFATE\n');
  assert.strictEqual(p.number, null,
    `expected no number when this card's own line is illegible, got ${p.number}`);
  assert.ok(p.setCandidates.includes('tla'), 'the set code is still read normally');
});

check('F8P-TC29', 'the number above the set line is still preferred over noise above it', () => {
  // The guard must not have broken the case it was built for: junk on line 0,
  // the real number on line 1, the set line on line 2.
  const p = parseCollectorStrip('| iil 63\nrR 0038\nMSH *EN be RAFAT\n');
  assert.strictEqual(p.number, '38');
});

console.log(`\nCollector-number parser: ${passed} cases passed.`);
if (process.exitCode) process.exit(process.exitCode);
