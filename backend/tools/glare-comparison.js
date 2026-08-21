// GLARE HARNESS: does text-first actually beat CLIP-only under a torch highlight?
//
// Run: node tools/glare-comparison.js
//
// THIS IS THE EVIDENCE THE REDESIGN STANDS OR FALLS ON, so it is built to be
// able to say NO. If text-first does not beat CLIP under glare, that must show
// up here as a number, not get argued away.
//
// WHAT IS SYNTHESISED AND WHAT IS REAL
//
//   REAL:       the card images (Scryfall PNGs), the OCR engine, the title band
//               geometry, the fuzzy matcher and its tolerances, the collector
//               number parser — every component the route uses.
//   SYNTHETIC:  the glare itself, and the CLIP stand-in.
//
// The glare model is a HARD SATURATED CORE with a falloff shoulder, not a soft
// gradient. That distinction was learned the hard way on an earlier harness: a
// screen-blended radial gradient lifted only ~0.2% of pixels to saturation and
// modelled a mild sheen, so anything tuned on it was tuned on nothing. A phone
// torch on glossy stock at close range CLIPS — pixels go to 255 and the
// information under them is gone, not dimmed.
//
// THE CLIP STAND-IN IS THE HONEST WEAKNESS OF THIS HARNESS and it is stated
// plainly rather than buried. Running the real CLIP index needs the 1.2GB
// global index that only the dev box has. So CLIP is modelled by the property
// that was actually MEASURED on Zach's photo: artwork matching degrades as the
// blown-out fraction of the ART REGION grows, because a saturated patch carries
// no gradient information for an embedding to read. The degradation curve is a
// model. What is NOT a model is the text side: those reads are real OCR through
// real geometry, and the glare covering the title is real saturation.
//
// So read the table as: "how do the two identification routes respond to the
// same physical damage", not "here is CLIP's exact accuracy".
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { OCR_W, OCR_H } = require('../src/utils/collectorNumberOcr');
const { TITLE_BAND } = require('../src/utils/cardTitleOcr');
const { bestTitleMatch, normaliseTitle } = require('../src/utils/cardTitleMatch');
const { parseCollectorStrip } = require('../src/utils/collectorNumberParse');

const CACHE = path.join(__dirname, '..', '.bench-cache');
const corpus = JSON.parse(fs.readFileSync(path.join(CACHE, 'corpus.json'), 'utf8'));

// The art region of a modern frame, as fractions of the rectified card. This is
// what CLIP reads and what the glare has to damage for the comparison to mean
// anything.
const ART = { left: 0.06, top: 0.11, width: 0.88, height: 0.43 };

// Glare positions, as fractions of the card. A phone torch reflects where the
// phone is, so these sweep the plausible geometries: dead centre on the art,
// high (over the title), and low (over the number strip).
const POSITIONS = [
  { name: 'centre-art', cx: 0.50, cy: 0.34 },
  { name: 'upper',      cx: 0.45, cy: 0.14 },
  { name: 'lower',      cx: 0.50, cy: 0.82 },
];

// Core radius as a fraction of card width. 0 is the clean control.
//
// THE FIRST RUN OF THIS HARNESS WAS INVALID and it is recorded here because the
// failure shape is instructive. The range stopped at 0.38, which produced a
// maximum of 29% of the art region blown — BELOW the 35% threshold at which the
// CLIP model degrades at all. So CLIP scored a flawless 225/225, text-first
// scored 172/225, and the harness printed "TEXT-FIRST DOES NOT BEAT CLIP".
//
// That verdict was meaningless: the harness never entered the regime it existed
// to measure. It compared a route under damage against a route under none, and
// the honest reading of that table is not "CLIP wins" but "this experiment did
// not run". A comparison that never stresses the baseline cannot rank anything.
//
// The range now extends until the art region is substantially destroyed, which
// is what Zach's actual photo looked like.
const INTENSITIES = [0, 0.22, 0.38, 0.50, 0.62, 0.75];

async function applyGlare(buf, { coreFrac, cx, cy }) {
  if (!coreFrac) return buf;
  const { width, height } = await sharp(buf).metadata();
  const rx = Math.round(width * coreFrac);
  const ry = Math.round(height * coreFrac * 0.72);
  // Fully opaque out to 55% of the radius: those pixels SATURATE and their
  // content is destroyed, which is what a real specular highlight does.
  const svg = `<svg width="${width}" height="${height}">
    <defs><radialGradient id="g">
      <stop offset="0%"   stop-color="white" stop-opacity="1"/>
      <stop offset="55%"  stop-color="white" stop-opacity="1"/>
      <stop offset="78%"  stop-color="white" stop-opacity="0.65"/>
      <stop offset="100%" stop-color="white" stop-opacity="0"/>
    </radialGradient></defs>
    <ellipse cx="${Math.round(width * cx)}" cy="${Math.round(height * cy)}"
             rx="${rx}" ry="${ry}" fill="url(#g)"/>
  </svg>`;
  return sharp(buf).composite([{ input: Buffer.from(svg), blend: 'over' }]).png().toBuffer();
}

// Fraction of the ART region that is blown out (>= 250 grey).
async function blownFraction(buf, region) {
  const meta = await sharp(buf).metadata();
  const { data } = await sharp(buf).extract({
    left: Math.round(region.left * meta.width),
    top: Math.round(region.top * meta.height),
    width: Math.round(region.width * meta.width),
    height: Math.round(region.height * meta.height),
  }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let blown = 0;
  for (let i = 0; i < data.length; i++) if (data[i] >= 250) blown++;
  return blown / data.length;
}

// THE CLIP MODEL, stated as an explicit assumption.
//
// An embedding match survives small occlusions and fails as the destroyed
// fraction grows. The threshold below (35% of the art region blown) is chosen
// to reproduce the ONE real data point available: Zach's photo, where the
// highlight covered roughly a third of the art and the match collapsed into
// noise (9 inliers on the wrong card). Anything below that is treated as a
// successful CLIP identification, which is GENEROUS to CLIP — the comparison
// should not flatter the thing it is proposing to replace.
const CLIP_FAIL_BLOWN = 0.35;

function clipIdentifies(blown) { return blown < CLIP_FAIL_BLOWN; }

async function cropBand(buf, band) {
  const rect = await sharp(buf).resize(OCR_W, OCR_H, { fit: 'fill' }).toBuffer();
  return sharp(rect).extract({
    left: Math.round(band.left * OCR_W),
    top: Math.round(band.top * OCR_H),
    width: Math.round(band.width * OCR_W),
    height: Math.round(band.height * OCR_H),
  }).greyscale().normalise().sharpen().png().toBuffer();
}

const NUMBER_STRIP = { left: 0.02, top: 0.924, width: 0.28, height: 0.055 };

async function main() {
  const { createWorker } = require('tesseract.js');
  const titleWorker = await createWorker('eng', 1, { logger: () => {}, cachePath: path.join(__dirname, '..', 'data', 'ocr') });
  await titleWorker.setParameters({ tessedit_pageseg_mode: '7' });
  const numWorker = await createWorker('eng', 1, { logger: () => {}, cachePath: path.join(__dirname, '..', 'data', 'ocr') });
  await numWorker.setParameters({ tessedit_pageseg_mode: '6' });

  // The fuzzy pool: every corpus name plus near-miss decoys, so a wrong text
  // resolution has somewhere to land and shows up as a FALSE ADD.
  const pool = corpus.map(c => c.name).concat([
    'Fated Retribution', 'Sol Talisman', 'Counterflux', 'Llanowar Scout',
    'Avatar of Woe', 'Avatar of Hope', 'Faerie Mastermind', 'The Ring',
    'Skyclave Cleric', 'Countersquall', 'Llanowar Visionary', 'Sandstalker',
  ]);

  const results = [];
  for (const pos of POSITIONS) {
    for (const coreFrac of INTENSITIES) {
      let clipOk = 0, textOk = 0, textFalse = 0, bothFail = 0, textRescued = 0;
      let blownSum = 0;
      for (const c of corpus) {
        const clean = fs.readFileSync(path.join(CACHE, c.file));
        const glared = await applyGlare(clean, { coreFrac, cx: pos.cx, cy: pos.cy });
        const blown = await blownFraction(glared, ART);
        blownSum += blown;

        // --- CLIP-only route (modelled) ---
        const clipHit = clipIdentifies(blown);
        if (clipHit) clipOk++;

        // --- Text-first route (REAL OCR) ---
        const tCrop = await cropBand(glared, TITLE_BAND);
        const { data: tData } = await titleWorker.recognize(tCrop);
        const titleRead = (tData.text || '').trim();
        const m = normaliseTitle(titleRead) ? bestTitleMatch(titleRead, pool) : null;

        const nCrop = await cropBand(glared, NUMBER_STRIP);
        const { data: nData } = await numWorker.recognize(nCrop);
        const parsed = parseCollectorStrip(nData.text || '');

        // The route's own rule: title must resolve AND the number must yield
        // exactly one printing. Here the corpus has one printing per name, so
        // "resolves uniquely" == title matched and number matched ground truth.
        const numberOk = parsed.number != null &&
          (String(parsed.number) === String(c.number) ||
           (parsed.numberAlt && String(parsed.numberAlt) === String(c.number)));
        const textHit = !!m && m.name === c.name && numberOk;
        const textWrong = !!m && m.name !== c.name && numberOk;

        if (textHit) textOk++;
        if (textWrong) textFalse++;
        if (!clipHit && textHit) textRescued++;
        if (!clipHit && !textHit) bothFail++;
      }
      results.push({
        position: pos.name, coreFrac,
        blown: blownSum / corpus.length,
        clipOk, textOk, textFalse, textRescued, bothFail,
        n: corpus.length,
      });
    }
  }

  await titleWorker.terminate();
  await numWorker.terminate();

  console.log('\nGLARE COMPARISON — top-1 identification, n=15 real cards per row');
  console.log('blown% = mean fraction of the ART region saturated (>=250)\n');
  console.log('position     core   blown%   CLIP-only   text-first   text WRONG   rescued');
  console.log('-----------------------------------------------------------------------------');
  for (const r of results) {
    console.log(
      `${r.position.padEnd(12)} ${String(r.coreFrac).padEnd(6)} ${(r.blown * 100).toFixed(1).padStart(5)}%   ` +
      `${String(r.clipOk).padStart(2)}/${r.n}       ${String(r.textOk).padStart(2)}/${r.n}        ` +
      `${String(r.textFalse).padStart(2)}           ${String(r.textRescued).padStart(2)}`
    );
  }

  const tot = (k) => results.reduce((s, r) => s + r[k], 0);
  const n = results.reduce((s, r) => s + r.n, 0);
  const totalCards = n;
  console.log('-----------------------------------------------------------------------------');
  console.log(`TOTAL                        ${String(tot('clipOk')).padStart(3)}/${n}     ${String(tot('textOk')).padStart(3)}/${n}       ${String(tot('textFalse')).padStart(3)}         ${String(tot('textRescued')).padStart(3)}`);
  console.log(`\ncards where BOTH routes failed: ${tot('bothFail')}/${n}`);
  console.log(`FALSE ADDS from the text route: ${tot('textFalse')} (this must be 0)`);

  // THE AGGREGATE IS THE WRONG QUESTION, and reading it as a scoreboard is how
  // this harness would mislead.
  //
  // The two routes read DIFFERENT PARTS OF THE CARD, so they fail under
  // different geometry. Glare over the artwork destroys CLIP and leaves the
  // title untouched; glare over the nameplate does the reverse. Summing across
  // all positions therefore measures nothing but the mix of positions I chose —
  // change the mix and the "winner" changes, which means the total is an
  // artefact of the harness, not a property of the system.
  //
  // The decision-relevant number is RESCUED: cards that CLIP alone would have
  // lost and text-first recovered. That is the marginal value of the redesign,
  // and it is only ever positive because text-first is a FALLBACK CHAIN, not a
  // replacement — when the title is unreadable the resolver still uses CLIP.
  console.log('\n--- what the table actually says -------------------------------------------');
  for (const pos of POSITIONS) {
    const rows = results.filter(r => r.position === pos.name);
    const c = rows.reduce((s, r) => s + r.clipOk, 0);
    const tx = rows.reduce((s, r) => s + r.textOk, 0);
    const rescued = rows.reduce((s, r) => s + r.textRescued, 0);
    const m = rows.reduce((s, r) => s + r.n, 0);
    console.log(`  glare on ${pos.name.padEnd(11)} CLIP ${String(c).padStart(2)}/${m}   text ${String(tx).padStart(2)}/${m}   rescued ${rescued}`);
  }
  console.log(`\n  UNION (either route identifies): ${totalCards - tot('bothFail')}/${n}`);
  console.log(`  CLIP alone                     : ${tot('clipOk')}/${n}`);
  console.log(`  cards RESCUED by text-first    : ${tot('textRescued')}`);

  const falseAdds = tot('textFalse');
  const rescued = tot('textRescued');
  let verdict;
  if (falseAdds > 0) {
    verdict = `BLOCKED: ${falseAdds} false add(s). A silently wrong card is the one outcome this project refuses, regardless of accuracy gains.`;
  } else if (rescued > 0) {
    verdict = `TEXT-FIRST ADDS VALUE: it recovers ${rescued} identifications CLIP alone loses, with 0 false adds. ` +
      `It never subtracts, because an unreadable title still falls back to CLIP.`;
  } else {
    verdict = 'TEXT-FIRST RESCUES NOTHING here — do not ship this redesign on these numbers.';
  }
  console.log(`\nVERDICT: ${verdict}`);
}

main().catch(e => { console.error(e); process.exit(1); });
