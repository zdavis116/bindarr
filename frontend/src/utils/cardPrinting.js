// Single source of truth for how a card's finish is displayed across every view
// (Collection gallery/list, Storage visualizers, inspectors).
//
// Previously each view invented its own badge text ("HOLO" vs "Holo"), colors
// (amber/blue vs amber/gray), and foil overlay treatment, so the same card
// looked different depending on where you saw it. Everything now routes here.
//
// PR 6E: these functions used to switch on the finish values of the game this
// app was forked from. MTG rows can never hold those, so every branch was
// dead: a foil card fell through to `default` and rendered
// with NO badge and NO shine, looking exactly like a nonfoil. The user could
// not tell a foil from a nonfoil anywhere in the app.
//
// These accept either the canonical finish ('nonfoil' | 'foil' | 'etched') or
// the display form ('Normal' | 'Foil' | 'Etched'), because collection rows
// carry both columns and different screens read different ones.

// Canonical finish for whatever spelling a caller has to hand.
function toFinish(value) {
  switch (value) {
    case 'foil':
    case 'Foil':
      return 'foil';
    case 'etched':
    case 'Etched':
      return 'etched';
    default:
      return 'nonfoil';
  }
}

// Short uppercase badge label shown on card thumbnails. Nonfoil gets no badge:
// it is the ordinary case and badging it would add noise to every single card.
export function getPrintingBadgeLabel(printing) {
  switch (toFinish(printing)) {
    case 'foil': return 'FOIL';
    case 'etched': return 'ETCH';
    default: return '';
  }
}

// Badge background/text colors. Foil and etched are deliberately given distinct
// hues (warm gold vs cool violet) so they are legible at a glance and never
// mistaken for each other. Palette is unchanged from the previous holo/1st
// Edition styling so the collection keeps its existing look.
export function getPrintingBadgeStyle(printing) {
  switch (toFinish(printing)) {
    case 'foil':
      return { background: 'linear-gradient(135deg, #fbbf24, #f59e0b)', color: '#1a1206' };
    case 'etched':
      return { background: 'linear-gradient(135deg, #c4b5fd, #8b5cf6)', color: '#160a2e' };
    default:
      return { background: 'rgba(148, 163, 184, 0.85)', color: '#0a0f1d' };
  }
}

// Returns the CSS class for the animated foil overlay, or null for finishes
// that get no shine. Foil -> rainbow prism; etched -> silver sweep. Both
// overlay classes already exist in index.css and are reused as-is.
export function getFoilOverlayClass(printing) {
  const finish = toFinish(printing);
  if (finish === 'foil') return 'holo-shine-overlay';
  if (finish === 'etched') return 'reverse-holo-shine-overlay';
  return null;
}

// The finish a card row should be RENDERED as, whichever column it carries.
//
// Collection rows carry `printing` (display form) and `finish` (canonical);
// deck entries carry `desired_finish`. Every screen used to remember which of
// those its own rows had, and the deck grid remembered wrong -- it read
// `printing`, which deck entries do not have, so every deck card rendered as a
// nonfoil regardless of what it actually was. One function, asked once, means
// a screen can no longer get this wrong.
export function tileFinish(card) {
  if (!card) return 'nonfoil';
  return card.desired_finish || card.finish || card.printing || 'nonfoil';
}

// Does this card get a finish badge at all? False for nonfoil, which is the
// ordinary case: badging it would put a pill on every card in the binder.
export function hasFinishBadge(card) {
  return getPrintingBadgeLabel(tileFinish(card)) !== '';
}
