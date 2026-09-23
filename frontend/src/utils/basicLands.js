// IS THIS CARD A BASIC LAND — asked in ONE place.
//
// Zach (2026-09-23): "For basic lands I want to remove anything about printing
// from them... I want that all to go away and basic lands to be grouped by type
// like mountain or island and that's it. I don't care about printings at all."
//
// This question was already being answered in three different ways before this
// file existed:
//
//   * backend deckIdentity.isBasicLandTypeLine  -> type_line prefix
//   * backend SQL                               -> type_line LIKE 'Basic Land%'
//   * CardInspectorModal.jsx                    -> an inline startsWith()
//   * scanStaging.js                            -> a hard-coded set of NAMES
//
// Four surfaces deciding the same fact is how they drift. The name list is the
// dangerous one: it silently answers "no" for any basic it was not told about,
// and nothing fails loudly when that happens.
//
// THE TYPE LINE IS THE AUTHORITY, not the name. Scryfall states the type on
// every printing, so a basic from a set nobody has heard of is still a basic.
// A name list has to be maintained; a type line does not.
//
// SNOW-COVERED LANDS ARE NOT BASICS HERE, and that is deliberate. Their type
// line reads 'Basic Snow Land — Mountain', which does not start with
// 'Basic Land', so the prefix excludes them. A Snow-Covered Mountain is a
// genuinely different card -- it turns on snow permanents that a plain Mountain
// does not -- so pooling the two would put cards in a deck that cannot use
// them. The backend already draws the line in exactly this place
// (backend/test/basic_land_pool.test.js BLP-TC4); this matches it rather than
// inventing a second answer.
//
// Wastes is a basic (type line 'Basic Land — Wastes') and is included by the
// same rule, without needing to be named.
const BASIC_LAND_PREFIX = 'Basic Land';

export function isBasicLandTypeLine(typeLine) {
  return String(typeLine || '').startsWith(BASIC_LAND_PREFIX);
}

// The convenience form for the common case: a card-shaped object from the
// collection, a deck row, or the catalogue. All three carry `type_line`.
export function isBasicLand(card) {
  return isBasicLandTypeLine(card?.type_line);
}

// THE COLLECTION GROUPING KEY.
//
// For an ordinary card a copy is identified by its exact printing, condition
// and finish, because those are what make two physical cards worth different
// amounts. Merging a foil into a non-foil count would misreport the collection
// (see collectionFilters.test.js GRP-TC2).
//
// For a BASIC LAND none of that applies. Every Mountain fills the same slot in
// every deck, they are not traded on condition, and Zach does not track which
// set his lands came from. So the key is the NAME alone: one 'Mountain' row,
// however many sets, finishes and conditions it was assembled from.
//
// The name, not the oracle id: oracle ids are per-card and would already give
// the right answer, but the name is what is rendered and what the backend pools
// on (deckIdentity ownedQuantity matches `cc.name = ?`). Using the same field
// as the ownership pool means the tile count and the deck's availability figure
// cannot disagree.
export function collectionGroupKey(card) {
  if (isBasicLand(card)) return `basic|${card?.name || ''}`;
  return [card?.card_id, card?.condition || '', card?.printing || ''].join('|');
}
