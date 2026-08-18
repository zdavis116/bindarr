// THE single definition of what a FINISH is on a physical collection row.
//
// Why this module exists
// ----------------------
// Bindarr carried two parallel vocabularies for the same fact:
//
//   * `collection.printing` -- a display string, with a CHECK constraint left
//     over from before this fork went MTG-only:
//       ('Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo')
//     Those are POKEMON finishes.
//
//   * `collection.finish` -- the canonical MTG vocabulary added by PR 6C
//     ('nonfoil', 'foil', 'etched'), which is what deck identity matches on.
//
// Two vocabularies for one fact is two answers to "is this card foil", and
// which one the user saw depended on which screen they opened. Worse, the two
// were not merely different -- they were incompatible: the API accepted
// printing='Foil', which no Pokemon-era CHECK value permits, so EVERY foil add
// died with SQLITE_CONSTRAINT and returned HTTP 500. And on the paths that did
// succeed, `finish` was never written at all, so every row silently fell back
// to the 'nonfoil' column default regardless of what the user actually added.
//
// The resolution, stated once
// ---------------------------
//   `finish` is the SOURCE OF TRUTH. It is canonical, it is what deck identity
//   matches on, and it is the only value any correctness decision may read.
//
//   `printing` is a DERIVED DISPLAY MIRROR. It exists because sorting schemes,
//   CSV export and the collection UI already render from it. It is never an
//   input to a decision and is only ever written by deriving it from `finish`.
//
// One value is authoritative and the other is computed from it, so they cannot
// drift. That is the whole point: a translation performed at every call site is
// the kind of duplicated rule that eventually gets spelled four different ways.
//
// Accepting both forms on input is deliberate and is NOT a third vocabulary.
// The API's historical contract takes a display-form `printing` field, and the
// shipped frontend still sends it. Normalizing at the boundary means old and
// new clients converge on one stored representation rather than the backend
// having to guess later which dialect a row was written in.
const { FINISHES } = require('./deckIdentity');

// Display form for each canonical finish. This is the ONLY place the mapping
// is written down.
const DISPLAY_BY_FINISH = {
  nonfoil: 'Normal',
  foil: 'Foil',
  etched: 'Etched'
};

// Every spelling of a finish the API will accept, mapped to its canonical form.
//
// 'Normal' is retained because the shipped frontend sends it and it is the
// honest display name for nonfoil. Pokemon values are deliberately ABSENT: see
// normalizeFinish below for why they are refused rather than coerced.
const FINISH_BY_INPUT = new Map([
  ['nonfoil', 'nonfoil'],
  ['normal', 'nonfoil'],
  ['foil', 'foil'],
  ['etched', 'etched']
]);

class FinishError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = 'INVALID_FINISH';
  }
}

// Canonical finish for a caller-supplied value, or throw.
//
// Refusing an unrecognised value rather than defaulting it to 'nonfoil' is the
// standing rule applied to a real case: this software tracks physical objects.
// Silently storing a card the user said was 'Holofoil' as a nonfoil produces a
// row that describes a piece of cardboard incorrectly, with no error anywhere
// to point at. The user would later be told a foil requirement is satisfied by
// a card that is not foil -- and they cannot reconcile that against the binder,
// because the app never admitted to changing anything. A 400 is recoverable; a
// wrong row that looks right is not.
function normalizeFinish(value, { field = 'printing' } = {}) {
  if (value === undefined || value === null || value === '') {
    return 'nonfoil';
  }
  if (typeof value !== 'string') {
    throw new FinishError(`${field} must be one of ${FINISHES.join(', ')}`);
  }
  const canonical = FINISH_BY_INPUT.get(value.trim().toLowerCase());
  if (!canonical) {
    throw new FinishError(`${field} must be one of ${FINISHES.join(', ')}`);
  }
  return canonical;
}

// The display mirror for a canonical finish. Falls back to the nonfoil display
// name only for values that are already known-invalid, which normalizeFinish
// prevents from ever reaching storage.
function displayPrinting(finish) {
  return DISPLAY_BY_FINISH[finish] || DISPLAY_BY_FINISH.nonfoil;
}

// Resolve a request body's finish once, returning BOTH columns to write.
//
// Callers take the pair and write both. They must not compute either half
// themselves -- that is exactly the per-call-site translation this module
// exists to delete.
//
// `finish` wins when both fields are present: it is the canonical field, so a
// client that knows about it is the more current client.
function finishColumnsFromBody(body = {}) {
  const source = body.finish !== undefined && body.finish !== null && body.finish !== ''
    ? { value: body.finish, field: 'finish' }
    : { value: body.printing, field: 'printing' };
  const finish = normalizeFinish(source.value, { field: source.field });
  return { finish, printing: displayPrinting(finish) };
}

module.exports = {
  FINISHES,
  DISPLAY_PRINTINGS: FINISHES.map(f => DISPLAY_BY_FINISH[f]),
  FinishError,
  normalizeFinish,
  displayPrinting,
  finishColumnsFromBody
};
