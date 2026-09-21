// WHERE THE CARD PREVIEW GOES.
//
// Pure geometry, in its own module for two reasons. It is the part that has
// actually failed before, so it needs direct tests; and a .jsx file cannot be
// imported by plain `node`, which is what runs this project's test suite.
//
// POSITIONED AGAINST THE REAL ELEMENT, NEVER A FIXED CORNER.
//
// Three tooltip attempts on the Curve tab were rejected because I picked a
// corner and reasoned about it: bottom-left was a screen-width from the cursor,
// "beside the list" sat on the bars, and "below the chart" was impossible (44px
// of room). Zach reviews at 1473x736 and 1855x731 -- SHORT screens. Vertical
// space is the scarce axis and must be measured.

// A Magic card is 0.717 wide to tall. Height FOLLOWS from width, one number, so
// the frame can never letterbox or crop. (Filling space by stretching is a
// mistake this project has made before: art has a fixed aspect ratio.)
export const CARD_W = 244;
export const CARD_H = Math.round(CARD_W / 0.717);

// Gap between the row and the card; margin from the viewport edge.
const GAP = 12;
const EDGE = 8;

// Given the hovered row's bounding rect and the viewport, where should the
// preview's top-left corner sit?
//
// Three rules, in priority order:
//   1. fully on screen -- a card clipped by the fold reads as a broken UI, and
//      Zach has reported exactly that before;
//   2. beside the row, never on top of it -- otherwise you lose the name you
//      are pointing at, and on a touch screen it covers the next card;
//   3. vertically centred on the row, so the eye does not have to travel.
export function cardPreviewPosition(anchorRect, viewport) {
  const { width: vw, height: vh } = viewport;

  // Horizontal: prefer the right of the row, flip left when there is no room.
  // The pre-built deck is the RIGHT-hand column, so its rows sit near the edge
  // and a fixed "always to the right" rule would push the card off screen --
  // precisely where Zach is looking.
  const roomRight = vw - anchorRect.right;
  const roomLeft = anchorRect.left;
  let left = roomRight >= CARD_W + GAP + EDGE
    ? anchorRect.right + GAP
    : anchorRect.left - CARD_W - GAP;

  // Neither side fits (a phone, where the row is full width). Sit against the
  // wider side rather than half off-screen; the clamp below guarantees the
  // result is still fully visible.
  if (left < EDGE) left = roomLeft > roomRight ? EDGE : anchorRect.right + GAP;
  left = Math.max(EDGE, Math.min(left, vw - CARD_W - EDGE));

  // Vertical: centre on the row, then clamp into the viewport. The clamp is
  // what keeps a 340px card on a 731px screen when the row is near the bottom.
  let top = anchorRect.top + (anchorRect.height / 2) - (CARD_H / 2);
  top = Math.max(EDGE, Math.min(top, vh - CARD_H - EDGE));

  return { left: Math.round(left), top: Math.round(top) };
}
