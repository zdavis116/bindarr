// Read the card TITLE off a rectified card image.
//
// WHY THIS EXISTS: THE ARTWORK IS A SINGLE POINT OF FAILURE.
//
// Until now the pipeline identified the CARD by CLIP artwork similarity and
// used OCR only for the collector number. Measured on Zach's own photos that
// design fails exactly where it matters:
//
//   clean Scryfall image  ->  MATCH Fated Firepower tla#132
//   his phone photo       ->  noise: Transpose 9 inliers, Outpace Oblivion 8,
//                             Furnace Celebration 7
//
// The card is NOT foil and NOT sleeved (confirmed). The cause is a specular
// reflection from the PHONE TORCH: a small intense source inches from glossy
// modern card stock blows out a region of the face, and that region is exactly
// what CLIP reads. Artwork is the fragile signal under a highlight.
//
// In the SAME photo the title 'Fated Firepower' and the bottom line
// 'M 0132 / TLA . EN' are both plainly legible. Zach's own conclusion, and it
// reframes the design: "get name of card and set number and find it, it should
// be unique majority of the time". The identifying information on a Magic card
// is PRINTED TEXT, and printed text survives a highlight that destroys artwork
// matching — a blown-out patch removes some glyphs, it does not turn the title
// into a different card's title.
//
// GEOMETRY IS THE SAME AS THE COLLECTOR-NUMBER PATH and that is deliberate: the
// caller rectifies ONCE at OCR_W x OCR_H from the ORIGINAL upload
// (scanMatch.rectifyCard) and both crops come out of that same image. Do NOT
// feed this the matcher's 500x700 downscale. That bug cost most of a day on the
// number path — the crop was an upscale of already-discarded detail, and every
// offset scored 0/4 while the module's own benchmark said 12/15, because the
// benchmark prepared its own input and the route did not.
const sharp = require('sharp');
const path = require('path');

const { OCR_W, OCR_H } = require('./collectorNumberOcr');

// MEASURED, NOT GUESSED — tools/title-band-sweep.js, 15 real Scryfall cards
// spanning dom(2018) to tla(2025), ground truth from Scryfall's own API.
//
// Scored as CORRECT (fuzzy-resolves to the true name) vs FABRICATED (resolves
// to a DIFFERENT catalogue name), against a name pool seeded with near-miss
// decoys so a fabrication has somewhere wrong to land.
//
// OFFSET sweep (left 0.06, width 0.64, height 0.060):
//
//   0.030-0.034    0-2/15    above the title, into the border
//   0.038          9/15
//   0.042         14/15
//   0.046-0.058   15/15  0 fabricated      <- clean run
//   0.062         13/15
//   0.066          6/15
//   0.070+         0/15                    below the title, into the art
//
// 0.052 is the middle of the clean 0.046-0.058 run.
//
// WIDTH WAS THE REAL DISCOVERY, and the first sweep got it wrong. At width 0.80
// the band scored only 13/15 — but the two failures were not misreads. The
// title read PERFECTLY and the MANA COST, right-aligned in the same band, came
// with it: 'Fated Firepower X ee', '(a) Avatar Aang eP'. Widening past the
// title pulls in mana symbols that OCR renders as garbage letters, and those
// letters are edit distance the fuzzy matcher must then pay for.
//
//   width  0.58-0.70  ->  15/15  0 fabricated   <- clean run, centre 0.64
//   width  0.74       ->  14/15
//   width  0.78       ->  12/15
//
// This is the same lesson the number crop learned when its 0.42 window dragged
// in the artist credit: CROP TO THE TEXT YOU WANT, not to the region it sits in.
//
// HEIGHT is flat across 0.048-0.068 (all 15/15); 0.060 is the centre.
//
// Note what did NOT happen anywhere in this sweep: ZERO fabrications at ANY
// offset, including the ones scoring 0/15. When the band misses the title, OCR
// returns border noise and the fuzzy matcher REFUSES it rather than landing on
// a wrong card. That is the safety property the number crop could not claim —
// it had a cliff at 0.940 where digits merged into confident wrong numbers.
const TITLE_BAND = { left: 0.06, top: 0.052, width: 0.64, height: 0.060 };

let workerPromise = null;

// A SEPARATE worker from the collector-number one, with a different page
// segmentation mode. PSM 7 is 'single text line', which is what a title is;
// the number strip uses PSM 6 ('uniform block') because it is two lines.
// Sharing one worker would mean calling setParameters per crop, and the two
// scans of a single card would then race on shared worker state.
function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = require('tesseract.js');
      const worker = await createWorker('eng', 1, {
        logger: () => {},
        errorHandler: (e) => console.warn('title ocr worker:', e?.message || e),
        cachePath: process.env.OCR_CACHE_DIR || path.join(__dirname, '..', '..', 'data', 'ocr'),
      });
      await worker.setParameters({ tessedit_pageseg_mode: '7' });
      return worker;
    })().catch((e) => {
      // Never cache a rejected promise: one transient failure would otherwise
      // disable title OCR for the life of the process.
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

async function cropTitleBand(imageBuffer) {
  const rect = await sharp(imageBuffer).resize(OCR_W, OCR_H, { fit: 'fill' }).toBuffer();
  return sharp(rect)
    .extract({
      left: Math.round(TITLE_BAND.left * OCR_W),
      top: Math.round(TITLE_BAND.top * OCR_H),
      width: Math.round(TITLE_BAND.width * OCR_W),
      height: Math.round(TITLE_BAND.height * OCR_H),
    })
    // Titles are dark text on a light nameplate on most frames and light on
    // dark on full-art ones. normalise() handles both by stretching whatever
    // contrast is there; it is not polarity-specific.
    .greyscale().normalise().sharpen().png().toBuffer();
}

// Read the title band. Returns raw OCR text, or '' when unavailable.
//
// NEVER THROWS, for the same reason the number reader does not: OCR is an
// ENHANCEMENT. A failure must degrade to "no title read" — which falls back to
// CLIP — not to a failed scan that loses a card Zach physically scanned.
async function readCardTitle(imageBuffer) {
  try {
    const crop = await cropTitleBand(imageBuffer);
    const worker = await getWorker();
    const { data } = await worker.recognize(crop);
    return data?.text || '';
  } catch (e) {
    console.warn('title OCR failed:', e.message);
    return '';
  }
}

async function shutdown() {
  if (!workerPromise) return;
  const p = workerPromise;
  workerPromise = null;
  try { (await p).terminate(); } catch { /* already gone */ }
}

module.exports = { readCardTitle, cropTitleBand, shutdown, TITLE_BAND };
