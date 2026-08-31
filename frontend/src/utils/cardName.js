// HOW A CARD'S NAME IS SHOWN.
//
// Zach scanned a card reading 'SPLINTER, VENGEFUL SENSEI' in large type and
// Bindarr called it 'Ink-Eyes, Servant of Oni'. Both are correct: it is one
// Secret Lair card carrying a flavor name on top and the real card name in
// small type beneath. 648 cards across Magic are like this.
//
// For those cards `name` is a name the owner CANNOT SEE while holding the card,
// which makes a shelf of them unrecognisable.
//
// ONE HELPER, NOT 113 OPINIONS. There are ~113 places a card name is rendered
// in this app. If each decides for itself which name to show, they will drift,
// and the drift will surface as "the deck export says a different card than the
// collection" -- a bug that looks like data corruption to someone reconciling
// against physical cards.
//
// So the rule lives here once:
//   displayName()    what to show in large type -- the flavor name if there is
//                    one, otherwise the real name
//   secondaryName()  the real card name, but ONLY when it differs, so ordinary
//                    cards do not grow a redundant second line
//
// The catalogue identity is untouched. `name` remains what everything keys on;
// this is purely presentation.

export function displayName(card) {
  if (!card) return '';
  const flavor = (card.flavor_name || '').trim();
  return flavor || card.name || '';
}

// The real card name, when it is NOT the one being displayed. Returns '' for
// ordinary cards so callers can render it unconditionally.
export function secondaryName(card) {
  if (!card) return '';
  const flavor = (card.flavor_name || '').trim();
  const real = (card.name || '').trim();
  return flavor && flavor !== real ? real : '';
}

// Does this card show two names? Useful for layout decisions that need to
// reserve space before rendering.
export function hasFlavorName(card) {
  return secondaryName(card) !== '';
}
