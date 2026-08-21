// SWEEP the title band offset, exactly as the collector-number strip was tuned.
//
// Run:  node tools/title-band-sweep.js
//
// Geometry is the SAME as the OCR path: the card is rectified at OCR_W x OCR_H
// (750x1050) and the band is expressed as fractions of that. The corpus is real
// Scryfall PNGs at 745x1040, which is what rectifyCard produces for a well-shot
// photo, so the resize below is a no-op in the same way the route's is.
//
// Scored per offset: CORRECT (exact title after fuzzy match) vs FABRICATED
// (confident-looking text that resolves to the WRONG card). Fabrications are
// counted separately and weigh far more, for the same reason as the number
// sweep: a wrong title that resolves silently records a card Zach does not own.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { OCR_W, OCR_H } = require('../src/utils/collectorNumberOcr');
const { normaliseTitle, bestTitleMatch } = require('../src/utils/cardTitleMatch');

const CACHE = path.join(__dirname, '..', '.bench-cache');
const corpus = JSON.parse(fs.readFileSync(path.join(CACHE, 'corpus.json'), 'utf8'));

async function cropBand(buf, band) {
  const rect = await sharp(buf).resize(OCR_W, OCR_H, { fit: 'fill' }).toBuffer();
  return sharp(rect)
    .extract({
      left: Math.round(band.left * OCR_W),
      top: Math.round(band.top * OCR_H),
      width: Math.round(band.width * OCR_W),
      height: Math.round(band.height * OCR_H),
    })
    .greyscale().normalise().sharpen().png().toBuffer();
}

async function main() {
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker('eng', 1, {
    logger: () => {},
    cachePath: path.join(__dirname, '..', 'data', 'ocr'),
  });
  await worker.setParameters({ tessedit_pageseg_mode: '7' }); // single line

  // The catalogue the fuzzy matcher resolves against: every corpus title plus
  // decoys, so a fabricated read has somewhere WRONG to land.
  const names = corpus.map(c => c.name).concat([
    'Fated Retribution', 'Sol Talisman', 'Counterflux', 'Llanowar Scout',
    'The One Ring Bearer', 'Faerie Mastermind', 'Wear // Tear', 'Avatar of Woe',
  ]);

  const offsets = [];
  for (let t = 0.030; t <= 0.098; t += 0.004) offsets.push(+t.toFixed(3));

  console.log(`corpus: ${corpus.length} cards, band height 0.052, left 0.06 width 0.80\n`);
  console.log('offset  correct  fabricated  blank');
  const rows = [];
  for (const top of offsets) {
    let correct = 0, fabricated = 0, blank = 0;
    for (const c of corpus) {
      const buf = fs.readFileSync(path.join(CACHE, c.file));
      const crop = await cropBand(buf, { left: 0.06, top, width: 0.80, height: 0.052 });
      const { data } = await worker.recognize(crop);
      const raw = (data.text || '').trim();
      if (!normaliseTitle(raw)) { blank++; continue; }
      const m = bestTitleMatch(raw, names);
      if (!m) { blank++; continue; }
      if (m.name === c.name) correct++;
      else fabricated++;
    }
    rows.push({ top, correct, fabricated, blank });
    console.log(
      `${top.toFixed(3)}   ${String(correct).padStart(2)}/${corpus.length}    ${String(fabricated).padStart(2)}          ${blank}`
    );
  }
  await worker.terminate();

  const clean = rows.filter(r => r.fabricated === 0 && r.correct === corpus.length);
  if (clean.length) {
    const mid = clean[Math.floor(clean.length / 2)];
    console.log(`\nclean run: ${clean[0].top} .. ${clean[clean.length - 1].top}  -> centre ${mid.top}`);
  } else {
    const best = rows.slice().sort((a, b) => (b.correct - a.correct) || (a.fabricated - b.fabricated))[0];
    console.log(`\nno fully clean run; best ${best.top} ${best.correct}/${corpus.length} fab=${best.fabricated}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
