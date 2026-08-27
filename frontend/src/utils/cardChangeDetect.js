// HAS THE CARD ON TOP OF THE STACK CHANGED?
//
// Zach: "I put down 3 forest in a row and it only scanned the 1st because it
// thought the next 2 were the same card... Every time a new card gets put down
// it should scan but if there is a card just sitting in the tray it shouldn't
// continuously scan that card."
//
// THE PROBLEM WITH THE CURRENT RULE. Re-arming capture depends entirely on the
// detected BOX moving (DISTURBED_FRAMES_TO_REARM consecutive disagreeing
// frames). That works when the new card lands askew, and fails completely when
// it does not: drop a Forest squarely onto a stack of Forests and the box is
// identical, so nothing ever re-arms.
//
// It is the same root cause as the "waiting for steady frame" complaint. The
// latch clears only on box movement, so a card that settles cleanly leaves it
// stuck and the tap is the only way through.
//
// GEOMETRY CANNOT ANSWER THIS. Two cards in the same position produce the same
// quad no matter how different they look. The only thing that distinguishes
// them is what is PRINTED on them.
//
// So: a cheap perceptual fingerprint of the card's ARTWORK. Not the whole
// frame -- the desk, the tray and the lighting are constant and would drown out
// the signal. Just the art box, reduced to a tiny grid of brightness values.
// Two different cards differ there; the same card sitting still does not.
//
// WHY NOT THE COLLECTOR NUMBER. It is 2mm of text that OCR reads on the SERVER
// after a 700ms round trip. This has to run in the preview loop at ~140ms per
// frame on a phone, and it only has to answer "different?", not "which card?".
//
// DELIBERATELY CONSERVATIVE. A false "same card" costs a tap, which Zach has
// explicitly accepted as a fallback. A false "different card" scans the same
// cardboard twice and puts a duplicate in his collection. So the threshold is
// set from measured same-card noise with a wide margin, and every uncertain
// case reports "same".

// The art box, as fractions of the rectified card. Chosen to sit well inside
// the artwork on both modern and older frames, avoiding the title, the type
// line and the border -- regions that look alike across different cards.
const ART = { left: 0.12, top: 0.13, width: 0.76, height: 0.42 };

// Grid resolution of the fingerprint. 8x8 = 64 samples is enough to separate
// different artwork and small enough to compute every frame without cost.
const GRID = 8;

// How much the fingerprint must change to count as a different card.
//
// MEASURED, NOT CHOSEN. Units are mean absolute difference in 0-255 brightness
// per cell, over 55 distinct cards from Zach's corpus:
//
//     SAME card, consecutive frames   min 1.3   p50 1.8   max  2.4
//     DIFFERENT cards                 min 19.9  p50 46.2  max 86.6
//
// An eight-fold gap with nothing in it. Every threshold from 6 to 15 scores
// 0 duplicates and 0 missed cards on that data, so 10 is taken as the middle of
// the empty band rather than as a tuned value -- there is nothing to tune.
//
// A NOTE ON HOW THIS WAS MEASURED, because the first attempt was wrong. I began
// by comparing separate PHOTOS of the same card, which gave same-card distances
// of 15.6-52.1 -- overlapping different-card almost entirely, and would have
// killed the idea. But that measures LIGHTING AND ANGLE changes between two
// hand-held shots, which is not the question. In the preview loop the
// comparison is between consecutive frames of a card lying still, where only
// sensor noise and slight exposure drift differ. Measuring the right thing
// moved same-card from 15.6-52.1 down to 1.3-2.4.
const CHANGE_THRESHOLD = 10;

// Reduce the art box to a GRID x GRID brightness fingerprint.
//
// `box` is the detected card in VIDEO pixels: { x, y, w, h }.
export function artFingerprint(imageData, width, height, box) {
  if (!imageData || !box || !box.w || !box.h) return null;
  const data = imageData;

  const ax = box.x + box.w * ART.left;
  const ay = box.y + box.h * ART.top;
  const aw = box.w * ART.width;
  const ah = box.h * ART.height;
  if (aw < GRID || ah < GRID) return null;

  const out = new Float32Array(GRID * GRID);
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      // Sample the centre of each cell. Averaging the whole cell would be more
      // robust but costs GRID*GRID*cellArea reads per frame; the centre sample
      // is enough to tell two artworks apart and is O(64).
      const px = Math.round(ax + aw * ((gx + 0.5) / GRID));
      const py = Math.round(ay + ah * ((gy + 0.5) / GRID));
      if (px < 0 || py < 0 || px >= width || py >= height) return null;
      const i = (py * width + px) * 4;
      // Rec. 601 luma: cheap and matches how the eye weights the channels.
      out[gy * GRID + gx] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
  }
  return out;
}

// Mean absolute difference between two fingerprints, or null if incomparable.
export function fingerprintDistance(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// Is this a DIFFERENT card from the one we last captured?
//
// Returns false whenever it cannot tell -- no fingerprint, wrong size, first
// frame. That is the safe direction: the worst outcome is a tap.
export function isDifferentCard(current, lastCaptured, threshold = CHANGE_THRESHOLD) {
  const d = fingerprintDistance(current, lastCaptured);
  if (d == null) return false;
  return d >= threshold;
}

export { ART, GRID, CHANGE_THRESHOLD };
