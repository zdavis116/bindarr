// Read the collector-number strip off a rectified card image.
//
// ENGINE CHOICE: tesseract.js, chosen on measurement (see the PR 8 report and
// backend/tools/ocr-bench). The alternative tested was an ONNX text recogniser
// (Xenova/trocr-small-printed) running on the onnxruntime-node that CLIP
// already pulls in. Result on the same 21-card corpus, identical crops:
//
//   engine                                   number   set     median
//   tesseract.js @ 750x1050 (OCR crop only)  12/15    7/15    186ms
//   onnx trocr-small-printed @ 750x1050       0/15    0/15    608ms
//
// TrOCR scored ZERO. It is trained on single-line document/receipt text and
// this crop is far out of its distribution, so it does not misread the strip —
// it ignores it and emits fluent receipt boilerplate ("SEE BACK OF RECEIPT FOR
// AN OFFER"). That failure shape is worse than a low score: it is confident,
// well-formed text with no relationship to the card. It is also 3x slower.
//
// tesseract.js costs a real dependency (~2MB package plus a ~15MB English
// traineddata downloaded once and cached on disk) where TrOCR would have added
// none. Measurement says pay it: an engine that is 0/15 is not a cheaper
// option, it is a non-option.
//
// CROP SIZE: 750x1050 for the OCR crop only. The matcher keeps its tuned
// 500x700 (scanMatch.js:47) untouched. Rectifying the OCR crop larger moved
// collector-number accuracy 10/15 -> 12/15 and, more importantly, took
// fabricated reads from 5/21 down to 1/21. A 2x upscale on top was tested and
// made things WORSE (3/21 fabricated) while costing another 55ms, so it is not
// used.
const path = require('path');
const sharp = require('sharp');

// Fractions of the rectified card. The strip holds two lines:
//   "263 U"  or  "267/303 U"   then   "C21 * EN  <artist>"
//
// MEASURED, NOT GUESSED - and deliberately placed at the CENTRE of the safe
// band rather than anywhere that merely works.
//
// The original 0.885 landed on FLAVOUR TEXT, and a 0.42-wide window pulled the
// artist credit into the same block, so live scans read "ZACKSTELLA" and
// "ring of purest cold." while the module's own benchmark scored 12/15 - the
// benchmark fed it a different crop than the route does.
//
// Every offset from 0.880 to 0.944 was scored against five modern cards,
// counting correct reads AND confident-but-wrong reads separately:
//
//   0.880-0.892   0/5 correct   0 fabricated   (above the line)
//   0.896         4/5           0
//   0.900-0.908   5/5           0
//   0.912         4/5           1 FABRICATED
//   0.916-0.936   5/5           0              <- clean run
//   0.940         2/5           3 FABRICATED
//   0.944         0/5           4 FABRICATED
//
// 0.924 is the middle of the clean 0.916-0.936 run. THE CLIFF AT 0.940 IS THE
// REASON THIS IS CENTRED: past it the line clips and digits merge into numbers
// that still report confident=true - Sol Ring reads "20635" instead of "263".
// A fabricated number silently records a printing Zach does not own, which the
// review queue cannot protect him from because OCR never admits doubt.
//
// Do not nudge these values without re-running the band sweep.
//
// Width is 0.28, not 0.42: on modern frames the artist credit sits immediately
// right of the number and a wider window drags it into the same text block.
//
// TUNED FOR MODERN FRAMES ONLY. Cards from ~2007 and earlier (tested: LRW, 10E)
// place their bottom text differently and are not found anywhere in 0.86-0.97.
// They return no read and go to the review queue, which is correct and safe.
// Zach's collection is 90%+ post-2007, so a second crop position for old frames
// would be real work for a tenth of the cards; revisit only if the queue proves
// tedious in practice.
const STRIP = { left: 0.02, top: 0.924, width: 0.28, height: 0.055 };

// The matcher's rectified size (scanMatch.js). NOT changed here.
const CARD_ASPECT = 2.5 / 3.5;
const MATCH_W = 500, MATCH_H = Math.round(500 / CARD_ASPECT);
// The OCR crop is rectified 1.5x larger. Measured: fewer fabricated reads.
const OCR_SCALE = 1.5;

let workerPromise = null;

// The worker is a singleton and lazily created, mirroring how embedMatch.js
// treats the CLIP pipeline. Creating it costs ~1-2s and loads the language
// data, so paying that per scan would dwarf the recognition itself.
function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = require('tesseract.js');
      const worker = await createWorker('eng', 1, {
        logger: () => {},
        errorHandler: (e) => console.warn('ocr worker:', e?.message || e),
        cachePath: process.env.OCR_CACHE_DIR || path.join(__dirname, '..', '..', 'data', 'ocr'),
      });
      // PSM 6: a uniform block of text. The strip is two short lines; the
      // default (auto page segmentation) treats it as a page and does worse.
      await worker.setParameters({ tessedit_pageseg_mode: '6' });
      return worker;
    })().catch((e) => {
      // A failed worker must not be cached as a permanently rejected promise,
      // or one transient failure disables OCR for the life of the process.
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

// Cut the collector-number strip out of a card image.
async function cropCollectorStrip(imageBuffer) {
  const w = Math.round(MATCH_W * OCR_SCALE);
  const h = Math.round(MATCH_H * OCR_SCALE);
  const rect = await sharp(imageBuffer).resize(w, h, { fit: 'fill' }).toBuffer();
  return sharp(rect)
    .extract({
      left: Math.round(STRIP.left * w),
      top: Math.round(STRIP.top * h),
      width: Math.round(STRIP.width * w),
      height: Math.round(STRIP.height * h),
    })
    // Small white-on-black text; contrast normalisation measurably helps.
    .greyscale().normalise().sharpen().png().toBuffer();
}

// Read the strip. Returns raw OCR text, or '' if OCR is unavailable.
//
// NEVER THROWS. OCR is an ENHANCEMENT to scanning: if it fails, the card
// should go to the review queue for Zach to resolve, exactly as an unreadable
// number does. Propagating the error would fail the whole scan and lose a card
// he physically scanned, which is a strictly worse outcome than asking him.
async function readCollectorStrip(imageBuffer) {
  try {
    const crop = await cropCollectorStrip(imageBuffer);
    const worker = await getWorker();
    const { data } = await worker.recognize(crop);
    return data?.text || '';
  } catch (e) {
    console.warn('collector-number OCR failed:', e.message);
    return '';
  }
}

async function shutdown() {
  if (!workerPromise) return;
  const p = workerPromise;
  workerPromise = null;
  try { (await p).terminate(); } catch { /* already gone */ }
}

module.exports = { readCollectorStrip, cropCollectorStrip, shutdown, STRIP, OCR_SCALE };
