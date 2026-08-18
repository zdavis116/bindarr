// Pure presentation logic for the exact-finish deck UI.
//
// Split out of the component so it can be tested without a DOM, and so the one
// rule that matters is easy to see in isolation: this function READS
// server-computed quantities and chooses a label. It never derives ownership,
// reservation or missing counts. Those are the server's answers (see
// backend/src/utils/deckIdentity.js), and a second implementation here would
// let the screen and the database disagree about whether the user must buy a
// card.
//
// Note the tone vocabulary: 'ok', 'warn', 'muted', 'unavailable'. There is
// deliberately no 'error'. Not owning a card you plan to buy is a normal state
// of a deck under construction, and styling it as an error tells the user
// something went wrong when nothing did.
//
// 'unavailable' is the one red state, and it means something narrow: a card
// you are CONSIDERING has no free copy right now because a real deck holds
// them all. It is red rather than amber because it is the answer to a yes/no
// question ("can I actually put this in?"), not a shopping shortfall.
export const FINISHES = [
  { value: 'nonfoil', label: 'Nonfoil' },
  { value: 'foil', label: 'Foil' },
  { value: 'etched', label: 'Etched' }
];

export function requirementStatus(card) {
  // Considering entries and entries in a parked deck. These claim no physical
  // card, so "missing" is meaningless for them -- the useful question is
  // whether a matching copy is FREE right now, which the server answers on
  // every read. We branch on the server's flag and never re-derive it.
  if (!card.reserves) {
    if (card.available === undefined) {
      // Older payloads without availability. Stay quiet rather than guessing.
      return { tone: 'muted', label: 'Not reserved (planning only)' };
    }
    return card.available
      ? { tone: 'ok', label: `Available ${card.quantity_available}` }
      : { tone: 'unavailable', label: 'Unavailable — no free copy' };
  }

  if (card.quantity_missing > 0) {
    return { tone: 'warn', label: `Missing ${card.quantity_missing} of ${card.quantity_required}` };
  }
  return { tone: 'ok', label: `Reserved ${card.quantity_reserved} of ${card.quantity_required}` };
}
