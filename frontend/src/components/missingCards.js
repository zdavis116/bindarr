// What the MissingCardsPanel shows, as pure functions.
//
// The rules live here rather than inside the JSX for the same reason
// deckSections.js exists: they decide what the user is told to BUY, and a
// wrong answer is invisible to a test that only renders markup. Pure functions
// can be checked directly.
//
// THE SERVER OWNS THE ARITHMETIC. These functions shape and group what
// /api/decks/:id/buylist already returned; they never recompute a shortfall.
// The cross-deck reservation logic (PR 6G) is subtle and exists once, on the
// server. A second implementation here would eventually disagree with the red
// "Missing" badge on the same screen, and the user would have no way to know
// which number to trust at the shop.

// A stable, exact key for one buyable thing: PRINTING plus FINISH.
//
// Deliberately NOT the card name. For a buylist the printing is the decision,
// because it is a price decision -- two printings of Sol Ring are two
// different purchases and must never collapse into one line. This is the
// opposite of the import rule, and both are right; see
// backend/src/utils/deckIdentity.js buylistForDeck for the full reasoning.
export function buylistKey(item) {
  return `${item.desired_card_id}|${item.finish || item.desired_finish || 'nonfoil'}`;
}

// The buylist lines, in the order the panel renders them.
//
// Sorted by name, then set, then collector number, then finish -- a stable
// order so the list does not reshuffle between reads while he is working
// through it with a binder open.
export function buylistLines(items) {
  const FINISH_ORDER = ['nonfoil', 'foil', 'etched'];
  return [...(items || [])]
    .filter(item => (item.quantity || 0) > 0)
    .sort((a, b) => {
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      const setA = String(a.set_id || ''), setB = String(b.set_id || '');
      if (setA !== setB) return setA < setB ? -1 : 1;
      const numA = String(a.number || ''), numB = String(b.number || '');
      if (numA !== numB) return numA < numB ? -1 : 1;
      return FINISH_ORDER.indexOf(a.finish) - FINISH_ORDER.indexOf(b.finish);
    });
}

// Whether a line is worth explaining as "you own these, but they are committed
// elsewhere". Only true when he genuinely owns copies that are all spoken for.
//
// This exists because the most confusing possible buylist entry is one telling
// him to buy a card he can see in his own binder. Saying WHY -- another deck
// has it -- turns an apparent bug into information.
export function isCommittedElsewhere(item) {
  return (item.quantity_owned || 0) > 0
    && (item.quantity_allocated_elsewhere || 0) > 0;
}

// A short human explanation of a line's shortfall, or null when the plain
// quantity already says everything.
export function shortfallExplanation(item) {
  if (!isCommittedElsewhere(item)) return null;
  return {
    owned: item.quantity_owned,
    committed: item.quantity_allocated_elsewhere
  };
}
