// Shared collection-entry options.
//
// PR 6E: these values are now the CANONICAL MTG finishes the backend stores
// ('nonfoil' | 'foil' | 'etched'), not the legacy pre-fork serialized forms.
// The API accepts both, but sending the canonical value means what the picker
// submits is exactly what deck identity matches on -- no translation step that
// can drift.
export const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
export const PRINTINGS = ['nonfoil', 'foil', 'etched'];

const MTG_PRINTINGS = [
  { value: 'nonfoil', label: 'Nonfoil' },
  { value: 'foil', label: 'Foil' },
  { value: 'etched', label: 'Etched' },
];

// The finishes to OFFER for one printing (plan requirement G1).
//
// Scryfall publishes a per-printing `finishes` array, and it is the truth
// about which physical objects exist. Offering all three regardless — which is
// what this did before PR 7 — invites the user to record a foil of a card that
// was never printed in foil. Nothing catches that afterwards: deck identity
// matches on finish, so the phantom variant is satisfied by nothing he can
// ever own, and since PR 7 it flows onto a BUYLIST as an instruction to go and
// buy a card that does not exist.
//
// FILTER WHEN WE KNOW; OFFER EVERYTHING WHEN WE DO NOT. An absent or empty
// list means "no finish data for this card", not "this card has no finishes" —
// a thin cache row must not make a card unaddable, because turning a data gap
// into a dead end is a worse failure than the over-offering this fixes. The
// same permissive floor deckIdentity.printingChoicesForOracle already applies.
//
// The order is the APP's canonical order, not Scryfall's, so the picker does
// not reshuffle itself from card to card. Values Bindarr cannot store are
// dropped rather than passed through: an option the backend would refuse is
// not an option.
export function getPrintings(finishes) {
  if (!Array.isArray(finishes) || finishes.length === 0) return MTG_PRINTINGS;
  const offered = MTG_PRINTINGS.filter(option => finishes.includes(option.value));
  return offered.length > 0 ? offered : MTG_PRINTINGS;
}

// THE FINISH PICKER'S WHOLE STATE for one render: what to offer, whether the
// held value must be reset, and whether the recorded value contradicts the
// catalogue.
//
// ============================================================================
// WHY AN "INVALID" FINISH IS DELIBERATELY PRESERVED HERE. DO NOT "FIX" THIS.
// ============================================================================
// A future reader will see this function keep a finish that is NOT in the
// printing's finishes array and will want to correct it. That correction is
// the bug this function exists to prevent, and it shipped once already.
//
// What happened: G1 narrowed the picker AND reset the held value whenever it
// was not offered. On an EDIT surface that reset fired ON MOUNT, with no user
// action. So the user opens a card he owns a FOIL of — one whose cached
// finishes array lacks 'foil', which is exactly the bad data the old
// unconditional picker allowed him to create — edits the PRICE, saves, and the
// app quietly rewrites his foil to nonfoil.
//
// The damage is not cosmetic. Finish drives deck availability, so the
// rewritten row stops satisfying the foil slot; the deck reports the card
// MISSING; and the buylist instructs him to BUY A CARD SITTING IN HIS BINDER.
// A save about a price silently produced a false statement about his money.
//
// The standing rule (Zach): the app may REFUSE or WARN about what it cannot
// verify, but it must never quietly fix data describing a PHYSICAL OBJECT. He
// cannot reconcile a silent change against the cards in his hand. Between the
// catalogue and the card he is holding, the card wins — our cache is the thing
// more likely to be wrong, and it is the thing that costs nothing to be wrong.
//
// Hence: on 'edit', an out-of-range recorded finish is KEPT, kept VISIBLE (a
// value he cannot see is a value he cannot correct), and FLAGGED via
// `unverifiedFinish` so he is warned and can decide. Never overwritten.
//
// Resetting remains correct in exactly two places, because neither destroys a
// record:
//   * surface 'add' — nothing is recorded yet. Here the reset is protective:
//     without it, 'foil' held from the previous card would stay in state while
//     the dropdown reads Nonfoil, and the unseen value is the one submitted.
//   * a USER-INITIATED printing change — he acted, so a follow-up correction
//     is a response to his input rather than a mutation behind his back.
//
// An ABSENT or EMPTY finishes array is a DATA GAP, not a contradiction: we
// know nothing, so there is nothing to flag and nothing to reset.
export function finishPickerState({ surface = 'add', finishes, printing } = {}) {
  const known = Array.isArray(finishes) && finishes.length > 0;
  const offered = getPrintings(finishes);
  const isOffered = offered.some(option => option.value === printing);

  if (isOffered || !known) {
    return { options: offered, reset: null, unverifiedFinish: null };
  }

  // Out of range, and we DO have catalogue data to contradict it.
  if (surface === 'edit') {
    // Preserve, surface, flag. See the block comment above before changing.
    const preserved = MTG_PRINTINGS.filter(
      option => finishes.includes(option.value) || option.value === printing
    );
    return {
      options: preserved.length > 0 ? preserved : MTG_PRINTINGS,
      reset: null,
      unverifiedFinish: printing
    };
  }

  return { options: offered, reset: offered[0].value, unverifiedFinish: null };
}

export const isBinderType = (type) => type === 'Binder' || type === 'Toploader Binder';
