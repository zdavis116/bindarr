// LIVE CARD DETECTION for the scanner preview.
//
// WHY THIS EXISTS. Zach: "mana box auto outlines the card ... it just draws a
// line around the entire and it auto detects that", and "I want live drawing
// going green when it has it."
//
// That is not a cosmetic difference, it is the whole architecture. Our scanner
// asked the user to aim into a FIXED dashed box and then handed the server
// whatever was inside it. ManaBox finds the card FIRST and draws the outline it
// found — the outline is OUTPUT, not input.
//
// THE FAILURE THAT FORCED THIS. Zach scans in a small white box. His four failed
// basic lands came back with matched_name = '' — the card was never identified
// at all, so the collector-number work was irrelevant to them. The stored crop
// shows a sharp, well-lit, fully-visible card occupying only ~28% of the frame;
// the rest is the box's corners, walls and shadowed interior. detectCard scores
// candidates by area x aspect-fit x centrality, and the BOX INTERIOR is a
// bigger, equally rectangular, equally centred candidate. It competes with the
// card and wins.
//
// Raising CROP_PAD to 0.14 (to give the detector a border to find) made this
// strictly worse by pulling MORE of the box into frame. The fix is not a better
// crop constant — it is to stop guessing which rectangle is the card.
//
// WHAT THIS MODULE DOES. Given a downscaled greyscale frame, find the
// strongest card-shaped quadrilateral and report it with a confidence. Pure
// arithmetic over a pixel array: no DOM, no canvas, no camera — so it is
// testable, and it is tested (liveCardDetect.test.js) against synthetic frames
// including the card-inside-a-box case that broke production.
//
// DESIGN NOTE, and the reason this is not just "biggest rectangle wins": a
// container is a rectangle too. The discriminator is that a Magic card has a
// KNOWN aspect ratio (63x88mm = 0.716) and a card's interior is BUSY (art,
// text, borders) while a box interior is FLAT. Scoring on shape agreement and
// interior detail rejects the container even when the container is larger and
// better centred.

// A Magic card, 63mm x 88mm.
export const CARD_ASPECT = 63 / 88;

// How far the observed aspect may drift from a true card before the candidate is
// rejected outright. Generous enough for perspective on a hand-held phone,
// tight enough that a squarer box interior fails it.
const ASPECT_TOLERANCE = 0.16;

// A candidate must cover at least this fraction of the frame. Below it we are
// almost certainly locking onto a detail inside the card (an art box, a text
// block) rather than the card.
const MIN_AREA = 0.06;

// ...and at most this much, which rejects the frame itself and the walls of a
// container that fills the shot.
const MAX_AREA = 0.92;

// Column/row projections of the vertical and horizontal gradient. A card edge
// is a sustained straight transition, so it shows up as a peak in the
// projection; noise and texture do not accumulate the same way.
function gradientProfiles(gray, w, h) {
  const colEdge = new Float32Array(w);
  const rowEdge = new Float32Array(h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = Math.abs(gray[i + 1] - gray[i - 1]);
      const gy = Math.abs(gray[i + w] - gray[i - w]);
      colEdge[x] += gx;
      rowEdge[y] += gy;
    }
  }
  return { colEdge, rowEdge };
}

// The two strongest peaks in a projection that are at least `minGap` apart.
// Returns them in ascending order, or null when the profile has no clear pair —
// which is the honest answer for a frame with no card in it.
function strongestPair(profile, minGap) {
  const n = profile.length;
  let max = 0;
  for (let i = 0; i < n; i++) if (profile[i] > max) max = profile[i];
  if (max <= 0) return null;

  // Only consider genuine peaks: a value must beat a fraction of the maximum
  // AND be a local ridge, so a broad bright region does not read as an edge.
  const floor = max * 0.35;
  const peaks = [];
  for (let i = 1; i < n - 1; i++) {
    if (profile[i] >= floor && profile[i] >= profile[i - 1] && profile[i] >= profile[i + 1]) {
      peaks.push({ i, v: profile[i] });
    }
  }
  if (peaks.length < 2) return null;
  peaks.sort((a, b) => b.v - a.v);

  const first = peaks[0];
  // Pair the strongest peak with the strongest OTHER peak far enough away to be
  // the opposite edge rather than the same edge sampled twice.
  for (const p of peaks) {
    if (Math.abs(p.i - first.i) >= minGap) {
      const a = Math.min(first.i, p.i), b = Math.max(first.i, p.i);
      return { a, b, strength: (first.v + p.v) / (2 * max) };
    }
  }
  return null;
}

// Mean absolute difference between neighbouring pixels inside a box. A card is
// busy (art, text, rules box); an empty container floor is flat. This is what
// separates "the card" from "the white box the card is sitting in" when both
// are rectangular and both are centred.
function interiorDetail(gray, w, h, box) {
  const x0 = Math.max(1, Math.round(box.x + box.w * 0.15));
  const x1 = Math.min(w - 2, Math.round(box.x + box.w * 0.85));
  const y0 = Math.max(1, Math.round(box.y + box.h * 0.15));
  const y1 = Math.min(h - 2, Math.round(box.y + box.h * 0.85));
  if (x1 <= x0 || y1 <= y0) return 0;
  let sum = 0, n = 0;
  // Sample on a stride: full-resolution scanning buys no accuracy here and this
  // runs on every preview frame.
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = y * w + x;
      sum += Math.abs(gray[i] - gray[i + 2]) + Math.abs(gray[i] - gray[i + 2 * w]);
      n += 2;
    }
  }
  return n ? sum / n : 0;
}

// Find the card in a greyscale frame.
//
// Returns { x, y, w, h, confidence, aspect } in FRAME pixel coordinates, or null
// when nothing card-like is present. Confidence is 0..1 and combines edge
// strength, how closely the shape matches a real card, and interior detail.
//
// NEVER THROWS: the preview must keep running whatever the frame contains.
export function detectCardInFrame(gray, w, h) {
  try {
    if (!gray || w < 32 || h < 32) return null;
    const { colEdge, rowEdge } = gradientProfiles(gray, w, h);

    const cols = strongestPair(colEdge, Math.round(w * 0.15));
    const rows = strongestPair(rowEdge, Math.round(h * 0.15));
    if (!cols || !rows) return null;

    const box = { x: cols.a, y: rows.a, w: cols.b - cols.a, h: rows.b - rows.a };
    if (box.w <= 0 || box.h <= 0) return null;

    const areaFrac = (box.w * box.h) / (w * h);
    if (areaFrac < MIN_AREA || areaFrac > MAX_AREA) return null;

    // SHAPE IS THE PRIMARY DISCRIMINATOR, not size. A white box's interior is
    // rectangular and centred but is not card-shaped; scoring on agreement with
    // 63x88 rejects it without needing to know anything about boxes.
    const aspect = box.w / box.h;
    const aspectErr = Math.abs(aspect - CARD_ASPECT);
    if (aspectErr > ASPECT_TOLERANCE) return null;
    const aspectFit = 1 - aspectErr / ASPECT_TOLERANCE;

    // Interior detail, normalised into 0..1 against a threshold that a printed
    // card clears comfortably and an empty surface does not.
    const detail = Math.min(1, interiorDetail(gray, w, h, box) / 12);

    // DETAIL IS A GATE, NOT JUST A TERM. A card-shaped but FEATURELESS
    // rectangle — a blank sleeve, a piece of paper, the flat floor of a white
    // box seen at card proportions — would otherwise score highly on shape and
    // edges alone and LOCK GREEN. The outline turning green is a promise that
    // the app has the card, so a surface with no print on it must never make
    // that promise however card-shaped it is.
    if (detail < 0.25) return null;

    const edgeStrength = (cols.strength + rows.strength) / 2;
    // Detail is weighted above shape: shape is cheap to imitate (any rectangle
    // at the right proportions), print is not.
    const confidence = Math.max(0, Math.min(1,
      detail * 0.45 + aspectFit * 0.35 + edgeStrength * 0.20));

    return { ...box, aspect, confidence };
  } catch {
    return null;
  }
}

// Is this detection good enough to draw as LOCKED (green) and to scan?
//
// Deliberately a named threshold rather than a magic number at the call site:
// the outline turning green is a PROMISE to Zach that the app has the card, and
// the value that backs that promise should be visible and testable.
export const LOCK_CONFIDENCE = 0.55;

export function isLocked(det) {
  return !!det && det.confidence >= LOCK_CONFIDENCE;
}
