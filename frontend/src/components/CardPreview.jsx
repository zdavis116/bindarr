// The hover/tap card preview for the compare screen.
//
// Zach (2026-09-20): "on hover of card name show me card details", and when
// asked what to show he chose the printed card image alone -- the card already
// shows the rules text, mana cost and type, which is how Moxfield and Scryfall
// do it. So this renders ONE image and no text panel.
//
// The geometry lives in cardPreviewPosition.js, where it can be tested against
// Zach's real viewports without a DOM.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { cardPreviewPosition, CARD_W, CARD_H } from './cardPreviewPosition.js';

export default function CardPreview({ card, anchorRect }) {
  const [pos, setPos] = useState(null);

  useEffect(() => {
    if (!anchorRect) { setPos(null); return; }
    setPos(cardPreviewPosition(anchorRect,
      { width: window.innerWidth, height: window.innerHeight }));
  }, [anchorRect]);

  if (!card || !anchorRect || !pos) return null;

  // A card with no cached image must SAY so rather than render a broken frame.
  // Measured 100% image coverage across 34,905 oracle ids, so this is the rare
  // path -- but a silently empty box would read as the feature being broken,
  // and the name is still useful.
  const body = card.imageUrl ? (
    <img
      src={card.imageUrl}
      alt={card.name}
      width={CARD_W}
      height={CARD_H}
      className="mpc-preview-img"
      // Width and height are set so the frame holds its size while the image
      // arrives; without them the preview would pop from 0px to full size.
      loading="eager"
    />
  ) : (
    <div className="mpc-preview-empty" style={{ width: CARD_W, height: CARD_H }}>
      {card.name}
    </div>
  );

  // Rendered in a PORTAL. The rows live inside a scrolling, overflow-hidden
  // column; a preview positioned there would be clipped by its own container --
  // a reachability failure, which is this project's most repeated UI bug class.
  //
  // NOT CLICKABLE, deliberately. The CSS sets pointer-events: none so moving
  // the mouse toward the preview cannot steal the hover that created it and
  // make it flicker. That means this element can never receive a click, so it
  // must not pretend to: dismissal is the caller's job (tap the same card
  // again, or tap another). An onClick here would be dead code that reads like
  // a working close button.
  return createPortal(
    <div
      className="mpc-preview"
      style={{ left: pos.left, top: pos.top }}
      aria-hidden="true"
    >
      {body}
    </div>,
    document.body
  );
}
