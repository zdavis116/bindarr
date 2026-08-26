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
// WHERE THE COLLECTOR NUMBER SITS on a rectified card, as fractions.
//
// MEASURED ON 20 REAL FULL-RESOLUTION SCANS from Zach's phone, swept through the
// REAL production path (rectifyCard at OCR_W x OCR_H, then this crop, then
// tesseract). Scored on whether a plausible collector number came back:
//
//     top=0.900 h=0.090   17/20   <- this
//     top=0.920 h=0.070   15/20
//     top=0.930 h=0.055   14/20
//     top=0.924 h=0.055   12/20   <- what shipped before
//     top=0.955 h=0.040    4/20
//
// WHY IT IS TALL RATHER THAN TIGHT. The rectify lands the strip at a slightly
// different height on every photo — it depends on where detectCard put the quad,
// which depends on the angle, the lighting and the card. A tall window catches
// the strip wherever it lands; a narrow one is only correct for the average card
// and misses on either side of it, however well its centre is chosen. The extra
// height costs a few milliseconds of OCR and buys five more cards in twenty.
//
// HOW THE PREVIOUS NUMBERS GOT THERE, AND THE TRAP TO AVOID. They were measured
// on the 220x308 REVIEW-QUEUE THUMBNAIL, upscaled — a ninth of the resolution
// the phone actually uploads. That measurement said the text sat at 0.969-0.999
// and pointed at top=0.955, which scores 4/20: THREE TIMES WORSE than what it
// would have replaced. A worse compounding error hid underneath it: the test
// harness called rectifyCard(buf, 1500, 2100) positionally against a function
// that takes an options object, so every sweep silently ran against the 500x700
// default while production used 1500x2100.
//
// Measure through the real route, on real input, or do not measure.
// RETUNED FOR THE YOLO DETECTOR (Phase 4b). top 0.920 -> 0.880.
//
// The old value was tuned against the CLASSICAL detector's crop. The trained
// detector frames cards slightly differently, so the number line drifted partly
// out of the window and the reads came back with the SET line but the NUMBER
// line above it missing:
//
//     queued:  "MSH * EN % DOMENI"           <- number line gone
//     good:    "L 0295\nMSH*EN % DOMENI"
//
// That is why Zach's basic lands queued as 'unreadable' after Phase 4b shipped.
// Nothing to do with foils, and nothing to do with matching -- a basic land has
// no artwork signal to fall back on, so losing the number loses the card.
//
// MEASURED on his 33 real scans, through the real route, sweeping the window:
//
//     top    numbers read
//     0.850    10/31
//     0.865    14/31       <- cliff: the window has climbed off the text
//     0.880    29/31       <- chosen
//     0.895    28/31
//     0.920    22/31       <- previous value
//     0.930     5/31
//
// 0.880 sits on a PLATEAU (0.880 and 0.895 score the same) rather than a peak,
// which is what makes it a safe choice: the exact framing varies per photo, so
// a value that only works at one setting would fail on the next card.
// RETUNED AGAIN, ON THE CAPTURES THAT FAILED (top 0.880 -> 0.845, h 0.075 -> 0.100).
//
// Zach: "the queue still was still adding cards and some completely
// incorrectly". Every failing queue row showed the SET line reading fine and
// the NUMBER line above it missing entirely:
//
//     'MSH «EM to Daw Ba'                    set line only
//     'MSH » EN % DOMENI / EERE $00 EEE'     set line only
//     ''                                     nothing
//
// That is not blur -- the set line is the same size, in the same place, and
// reads fine. The window was simply looking BELOW the number, catching the set
// line instead.
//
// Swept over 17 real captures from that exact session:
//
//     top 0.845  h 0.100  ->  15/17   best on real photos, FAILS the fixtures
//     top 0.870  h 0.100  ->  14/17   <- CHOSEN: passes both
//     top 0.880  h 0.075  ->  11/17   what shipped
//     top 0.900  h 0.100  ->   7/17
//
// TWO CONSTRAINTS, NOT ONE. The value that scored best on Zach's photos (0.845)
// BROKE ocr_route.test.js, which renders synthetic cards and reads 4/4 -- the
// regression test that exists because a wrong-but-confident collector number
// once nearly entered his collection. Trading that guard for two more real
// reads would be removing a smoke detector to stop it chirping.
//
// So the window was swept against BOTH: every candidate run through the real
// captures AND through the actual e2e test. 0.870/0.100 is the best value that
// satisfies both -- 14/17 on his photos (up from 11) with the fixtures intact.
//
// The TALLER window is the more important half of the change. A taller strip
// catches the number whether the crop puts it at 85% or 89% of card height,
// which is exactly the variation that broke this twice. Chasing the perfect
// offset would break again the next time the crop changes.
//
// WHY THIS KEEPS MOVING, stated so the next person does not re-tune blindly:
// this constant is a fraction of the CARD'S HEIGHT in the rectified image, so
// it is only stable while the crop is. It has now been invalidated twice by
// changes upstream -- once by the server detector, once by the client cropping
// to its own detection box. If the crop changes again, re-measure; do not
// assume.
let STRIP = { left: 0.02, top: 0.870, width: 0.28, height: 0.100 };

// TEST/DIAGNOSTIC ONLY. Lets a sweep vary the window without editing source
// between runs. Production never calls this; the exported STRIP above is the
// shipped value and the only one the route uses.
function _setStrip(s) { STRIP = { ...STRIP, ...s }; }

// The matcher's rectified size (scanMatch.js). NOT changed here.
const CARD_ASPECT = 2.5 / 3.5;
const MATCH_W = 500, MATCH_H = Math.round(500 / CARD_ASPECT);
// THE OCR RECTIFY SCALE. Raised 1.5 -> 3.0. THIS WAS A DOWNSCALE IN DISGUISE.
//
// THE ARITHMETIC, which is the whole justification:
//   a card is 88mm tall; the collector number's cap height is ~1.2mm
//   at OCR_H=1050  -> 11.9 px/mm -> the number lands ~14px tall
//   tesseract needs ~20px of cap height to read small print reliably
// So every scan was handed a strip BELOW the engine's floor, and the engine
// did exactly what that implies: it returned empty. Measured on Zach's stack —
// every queue row read ocr_number=NULL, ocr_set=NULL, raw='' — including
// UNIQUE lands, which is what made it obvious the strip was never legible
// rather than merely ambiguous. At 3.0 the number lands ~29px, clear of the
// floor with margin for a hand-held frame.
//
// WHY IT LOOKED FINE BEFORE. 1.5 was tuned when the guide-box crop delivered a
// ~660px card: 750 was then an UPSCALE, so this constant read as generous. The
// capture work since (fullscreen preview, full-resolution request, lens pin,
// ImageCapture stills) now delivers a 1400-2600px card, and the SAME constant
// silently became a DOWNSCALE that discarded every pixel those changes bought.
// This is the identical trap as SCAN_UPLOAD_W one layer deeper: a cap that is
// invisible while the input is small, and binding the moment it is not.
//
// COST. Rectify and OCR both scale with area, so 3.0 is 4x the pixels of 1.5.
// Measured on the dev box, the OCR call itself runs in ~870ms at 750x1050 and
// the warp is ~160ms; the extra area is worth it because the alternative is an
// OCR that CANNOT read at any speed. Not raised further: past ~3.0 the gain is
// resampling a phone frame that has no more real detail, and both costs keep
// climbing. Re-measure before moving it again.
const OCR_SCALE = 3.0;
// The size the CALLER should rectify at. Exported so the route asks
// scanMatch.rectifyCard for exactly this and the resize in cropCollectorStrip
// is a no-op — one source of truth instead of two constants drifting apart.
const OCR_W = Math.round(MATCH_W * OCR_SCALE);   // 1500
const OCR_H = Math.round(MATCH_H * OCR_SCALE);   // 2100

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
      // PSM 4: a single column of text of variable sizes.
      //
      // Was PSM 6 ('uniform block') -- a reasonable guess, never measured.
      // Against 48 of Zach's captures where he told us what the card actually
      // was, holding everything else fixed:
      //
      //                  tune (24)            held-out (24)
      //     psm 6    correct 13 WRONG 5    correct 15 WRONG 3
      //     psm 4    correct 13 WRONG 1    correct 14 WRONG 1
      //
      // Correctness is a wash; WRONG READS DROP BY TWO THIRDS on BOTH halves,
      // so it is a real effect rather than a fit to the tuning data.
      //
      // WHY THAT TRADE IS RIGHT HERE and would be wrong in most apps: a silent
      // read queues the card and costs one tap. A WRONG read can put the wrong
      // card into a collection tracking physical objects, where it cannot be
      // reconciled against the shelf later. Four confident mistakes becoming
      // four honest "could not read it" is worth losing one read.
      //
      // THE COST, STATED PLAINLY: this drops the synthetic distant-card
      // regression case from 4/4 to 3/4 (a NULL read, not a fabrication).
      // Isolated against that test:
      //
      //     psm 6 x1 PASS    psm 6 x2 PASS
      //     psm 4 x1 FAIL    psm 4 x2 FAIL
      //
      // so PSM 4 is what costs it, and a 2x upscale does not buy it back --
      // upscaling alone made held-out wrong reads 3 -> 4.
      //
      // Taken deliberately on Zach's own answer: "I will always scan from close
      // up." The distant case is a scenario his workflow does not contain, and
      // every capture in the corpus is close-range. If that ever changes, the
      // fix is to select PSM by detected card size rather than to revert.
      await worker.setParameters({ tessedit_pageseg_mode: '4' });
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
  // CLAMPED TO THE IMAGE, and this is not defensive padding — it is a real bug
  // that has already cost a day. A window whose top+height rounds past the last
  // row makes sharp throw 'extract_area: bad extract area', readCollectorStrip
  // catches it and returns '', and the queue row then reads ocr_raw='' — which
  // is INDISTINGUISHABLE from "the text was there but unreadable". A crash that
  // disguises itself as a bad photograph sends you looking at the camera.
  const top = Math.min(Math.round(STRIP.top * h), h - 1);
  const left = Math.min(Math.round(STRIP.left * w), w - 1);
  const height = Math.max(1, Math.min(Math.round(STRIP.height * h), h - top));
  const width = Math.max(1, Math.min(Math.round(STRIP.width * w), w - left));
  return sharp(rect)
    .extract({ left, top, width, height })
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

module.exports = { readCollectorStrip, cropCollectorStrip, shutdown, STRIP, OCR_SCALE, OCR_W, OCR_H, _setStrip };
