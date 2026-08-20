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
// 500x700 (scanMatch.js:47) untouched.
//
// WHERE THOSE PIXELS COME FROM IS THE WHOLE STORY. This module only ever
// RESIZES what it is handed, and a resize cannot invent detail. For two PRs the
// route handed it `preprocessCard(buf)` — the matcher's 500x700 output — so the
// "750x1050 crop" was a 1.5x UPSCALE of an already-discarded strip: ~8px of
// blurred text stretched to look like 12. The route now calls
// scanMatch.rectifyCard(buf, { width: OCR_W, height: OCR_H }), which warps the
// SAME detected quad out of the ORIGINAL upload, so the resize below is an exact
// no-op and the strip arrives with real pixels. See the band-sweep note further
// down for what that cost.
//
// THE REMAINING CEILING IS THE CLIENT, not this module. CameraScanner caps its
// upload at SCAN_UPLOAD_W = 1280px. Measured, this fix only beats the old
// upscaling path once the CARD ITSELF exceeds ~500px wide in the uploaded image;
// below that the matcher's 500x700 warp is already an upscale and there is no
// detail left to recover. At a 1280px upload a card filling ~35% of the frame is
// ~690px wide (fine) but a card held back is ~400px (not fine, and identical on
// both paths). If distant cards still misread on real hardware, raise
// SCAN_UPLOAD_W — do not re-sweep the crop fractions below.
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
// THE SWEEP ABOVE WAS VALID. THE ROUTE WAS NOT. Read this before you touch the
// numbers, because the obvious conclusion is the wrong one.
//
// That sweep rectified its own images FROM THE ORIGINAL PHOTO, and against
// those images 0.924 is correct. But the route did not do that: it passed
// `preprocessCard(buf)`, the matcher's 500x700, and this module upscaled it 1.5x.
// So live scans were reading a blurred ~8px strip while the sweep read a sharp
// one, and the same offset behaved completely differently in the two places.
// Measured through the REAL route on that degraded input, EVERY offset from
// 0.86 to 0.96 scored 0/4 correct, and the offsets where the text half-appeared
// produced fabricated-but-confident reads ("SEI 39/302 M", "53 U 1 > [ol NY]").
//
// The instinct at that point is to re-sweep and move the offset. That would
// have been fitting the crop to a broken input and would have BAKED THE BUG IN:
// the winning offset would only work on blur. The fix was upstream — give OCR
// its own rectification from the original buffer (scanMatch.rectifyCard) — after
// which the same 0.924 reads 4/4 with 0 fabrications, exactly as the sweep said
// it would.
//
// The lesson, which is the same one PR 8 and PR 9 each learned separately: a
// sweep or benchmark that PREPARES ITS OWN INPUT proves nothing about the route.
// Whatever you measure next, measure it by POSTing to /api/scan-match.
//
// Do not nudge these values without re-running the band sweep THROUGH THE ROUTE.
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
// The size the CALLER should rectify at. Exported so the route asks
// scanMatch.rectifyCard for exactly this and the resize in cropCollectorStrip
// is a no-op — one source of truth instead of two constants drifting apart.
const OCR_W = Math.round(MATCH_W * OCR_SCALE);   // 750
const OCR_H = Math.round(MATCH_H * OCR_SCALE);   // 1050

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
//
// The resize is a NO-OP when the caller rectified at OCR_W x OCR_H (which the
// route does). It stays because this function must still be correct for a
// caller that hands it a differently-sized rectified card — but note that if
// that image was rectified SMALLER, this resize UPSCALES it and OCR will read
// blur. That was the production bug. Rectify at the target size.
async function cropCollectorStrip(imageBuffer) {
  const w = OCR_W;
  const h = OCR_H;
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

module.exports = { readCollectorStrip, cropCollectorStrip, shutdown, STRIP, OCR_SCALE, OCR_W, OCR_H };
