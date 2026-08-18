// The single definition of what a deck requirement MEANS.
//
// Why this module exists: before it, "does the user own this deck card" was
// re-derived in decks.js, collectionHelpers.js, deckRules.js and the frontend,
// and each one derived it slightly differently -- some by name, some by
// card_id, none by finish. Four definitions of ownership is four different
// answers to the only question the user actually cares about ("do I have to buy
// this card?"), and the one they see depends on which screen they opened.
//
// The rule, stated once:
//
//   A deck requirement is satisfied ONLY by collection rows whose card_id
//   equals desired_card_id AND whose finish equals desired_finish.
//
// oracle_id groups requirements for rules text and display. It never widens
// this match. Language and condition are physical metadata and play no part.
//
// Every function takes an explicit db client. Inside db.withTransaction(tx =>
// ...) callers MUST pass `tx`, so the read participates in the same transaction
// as the write it guards; reading through the module-level `db` from inside a
// transaction deadlocks on the PR 6A queue.
const db = require('../db');

const FINISHES = ['nonfoil', 'foil', 'etched'];
const BOARDS = ['commander', 'mainboard', 'sideboard', 'considering'];

// Boards whose requirements are real-world commitments. 'considering' is not
// one of them: it is a note that the user is thinking about a card, and the
// card is not physically in the deck.
const RESERVING_BOARDS = ['commander', 'mainboard', 'sideboard'];

class DeckIdentityError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function client(database) {
  return database || db;
}

function isFinish(value) {
  return FINISHES.includes(value);
}

function isBoard(value) {
  return BOARDS.includes(value);
}

// THE reservation rule, stated once:
//
//   An entry reserves inventory if and only if it is a real (non-considering)
//   entry on an ACTIVE deck.
//
// Both halves are load-bearing, but they are not symmetric. A considering
// entry never reserves at any level -- being on the considering board is by
// itself sufficient, and the deck's status is irrelevant to it. Deck status
// only decides anything for entries that are on a real board.
//
// This lives in one function because it previously did not: the deck read path
// computed `status === 'active' && boardReserves(board)` while
// availabilityForRequirement fell back to `boardReserves(board)` alone. Two
// spellings of one rule is two answers to "must I buy this card", and which
// one the user saw depended on which function their screen happened to call.
function entryReserves(deckStatus, board) {
  return deckStatus === 'active' && RESERVING_BOARDS.includes(board);
}

// Derive the deck identity of a card_cache row plus a chosen finish.
//
// Takes the oracle_id from the CARD rather than from the caller. A caller-
// supplied oracle_id can disagree with the printing it is attached to, which
// would put a requirement in the wrong rules group while still matching the
// right inventory -- a silent inconsistency with no user-visible symptom until
// Commander colour-identity validation reads the wrong Oracle row.
async function oracleIdentityForCard(database, cardId, finish) {
  if (!isFinish(finish)) {
    throw new DeckIdentityError(400, `Finish must be one of ${FINISHES.join(', ')}`, 'INVALID_FINISH');
  }
  const card = await client(database).get(
    `SELECT id, oracle_id, name, set_name, number, finishes FROM card_cache WHERE id = ?`,
    [cardId]
  );
  if (!card) {
    throw new DeckIdentityError(404, 'Card not found', 'CARD_NOT_FOUND');
  }
  if (!card.oracle_id) {
    // Guarded rather than defaulted. An empty oracle_id would group this
    // requirement with every other card missing one.
    throw new DeckIdentityError(422, 'Card is missing Oracle identity', 'CARD_MISSING_ORACLE');
  }
  return {
    oracle_id: card.oracle_id,
    desired_card_id: card.id,
    desired_finish: finish,
    name: card.name,
    set_name: card.set_name,
    number: card.number
  };
}

// How many physical copies of this EXACT variant the user holds.
//
// Scoped to list_type='collection' so wishlist rows -- cards the user wants but
// does not have -- can never be reported as owned.
async function ownedQuantity(database, userId, identity) {
  const row = await client(database).get(
    `SELECT COALESCE(SUM(quantity), 0) AS owned
     FROM collection
     WHERE user_id = ? AND card_id = ? AND finish = ? AND list_type = 'collection'`,
    [userId, identity.desired_card_id, identity.desired_finish]
  );
  return row ? row.owned : 0;
}

// Every reserving requirement for one exact variant, across ALL of a user's
// decks, in reservation priority order.
//
// Priority is deck_cards.id ASC and nothing else. That choice is deliberate:
// the id is assigned at insert and never changes, so the answer to "which deck
// gets the copy" is stable across renames, reorders, edits to other decks, and
// server restarts. Any priority derived from mutable data (deck name, created
// date, quantity) would let an unrelated edit silently move a physical card
// from one deck to another.
async function requirementsForVariant(database, userId, identity, { excludeDeckId = null } = {}) {
  const params = [userId, identity.desired_card_id, identity.desired_finish];
  let sql = `
    SELECT dc.id, dc.deck_id, dc.quantity, dc.board, d.name AS deck_name
    FROM deck_cards dc
    JOIN decks d ON dc.deck_id = d.id
    WHERE d.user_id = ?
      AND dc.desired_card_id = ?
      AND dc.desired_finish = ?
      AND d.status = 'active'
      AND dc.board IN (${RESERVING_BOARDS.map(() => '?').join(',')})
  `;
  params.push(...RESERVING_BOARDS);
  if (excludeDeckId !== null && excludeDeckId !== undefined) {
    sql += ` AND dc.deck_id != ?`;
    params.push(excludeDeckId);
  }
  sql += ` ORDER BY dc.id ASC`;
  return client(database).all(sql, params);
}

// How many copies of this variant are already spoken for by requirements with
// HIGHER priority than `deckCardId`.
//
// "Higher priority" means a strictly smaller deck_cards.id. This is what makes
// two decks wanting the same variant require two physical copies: the second
// deck's requirement sees the first one's claim as already-consumed inventory,
// so with one copy owned the second deck reports one missing. No sharing, no
// double-counting.
//
// When deckCardId is null the caller is asking about a hypothetical new
// requirement, which by construction sorts last (AUTOINCREMENT), so every
// existing requirement outranks it.
async function reservedByHigherPriority(database, userId, identity, deckCardId) {
  const requirements = await requirementsForVariant(database, userId, identity);
  let reserved = 0;
  for (const requirement of requirements) {
    if (deckCardId !== null && deckCardId !== undefined && requirement.id >= deckCardId) break;
    reserved += requirement.quantity;
  }
  return reserved;
}

// The full picture for one requirement, as the UI should show it.
//
// `quantity_reserved` is what THIS requirement actually gets to claim: what it
// needs, capped by what is left after higher-priority requirements have taken
// theirs. `quantity_missing` is the shortfall the user would have to buy.
//
// Note that missing is computed against availability, not raw ownership. Owning
// one Sol Ring while two active decks each require one means the second deck is
// missing one -- which is true in the physical world, and is the number the
// user needs when deciding what to buy.
//
// `quantity_available` and `available` are computed HERE, on every read, for
// reserving and non-reserving entries alike. They are deliberately not stored
// anywhere: availability is a fact about the whole collection at this instant,
// so any copy of it written onto a row starts going stale the moment another
// deck is edited. Deriving it means a considering entry cannot lie.
async function availabilityForRequirement(database, userId, requirement) {
  const identity = {
    desired_card_id: requirement.desired_card_id,
    desired_finish: requirement.desired_finish
  };
  const required = requirement.quantity;
  const owned = await ownedQuantity(database, userId, identity);
  const reserves = requirement.reserves === true;

  // How many copies of this exact variant are spoken for by REAL entries on
  // active decks. For a non-reserving entry every such claim outranks it (it
  // has no claim of its own), so it sees the full reserved total.
  const allocatedElsewhere = reserves
    ? await reservedByHigherPriority(database, userId, identity, requirement.id)
    : await reservedByHigherPriority(database, userId, identity, null);
  const available = Math.max(0, owned - allocatedElsewhere);

  if (!reserves) {
    // A considering entry claims nothing and competes with nobody, so it is
    // never "missing" anything -- it is not a gap in the deck. What it DOES
    // report is whether a matching copy is free right now, which is the
    // question the user is actually asking when they look at a maybeboard.
    return {
      quantity_required: required,
      quantity_owned: owned,
      quantity_allocated_elsewhere: allocatedElsewhere,
      quantity_reserved: 0,
      quantity_available: available,
      quantity_missing: 0,
      available: available > 0,
      reserves: false
    };
  }

  const reserved = Math.min(required, available);

  return {
    quantity_required: required,
    quantity_owned: owned,
    quantity_allocated_elsewhere: allocatedElsewhere,
    quantity_reserved: reserved,
    quantity_available: available,
    quantity_missing: Math.max(0, required - available),
    available: available > 0,
    reserves: true
  };
}

// Every requirement in one deck, each annotated with its reservation position.
async function availabilityForDeck(database, deckId, userId) {
  const deck = await client(database).get(
    `SELECT id, status FROM decks WHERE id = ? AND user_id = ?`, [deckId, userId]
  );
  if (!deck) {
    throw new DeckIdentityError(404, 'Deck not found', 'DECK_NOT_FOUND');
  }
  const rows = await client(database).all(
    `SELECT dc.id, dc.deck_id, dc.oracle_id, dc.desired_card_id, dc.desired_finish,
            dc.board, dc.quantity, dc.checked_out,
            cc.name, cc.set_name, cc.number, cc.image_url, cc.color_identity,
            cc.legalities, cc.type_line, cc.mana_cost
     FROM deck_cards dc
     JOIN card_cache cc ON dc.desired_card_id = cc.id
     WHERE dc.deck_id = ?
     ORDER BY dc.id ASC`,
    [deckId]
  );

  const entries = [];
  for (const row of rows) {
    const reserves = entryReserves(deck.status, row.board);
    const availability = await availabilityForRequirement(database, userId, { ...row, reserves });
    entries.push({ ...row, ...availability });
  }
  return { deck, entries };
}

// Pick the specific physical rows to pull for a deck's requirements.
//
// Ordering (located copies first, then oldest-added, then id) is deterministic
// and must stay that way: the user is going to walk to a binder and pull the
// card this function names. Calling it twice with unchanged inventory must name
// the same sleeve both times, or the app is telling them a different story each
// time they open it.
//
// This only PROPOSES an allocation. Persisting it is checkout's job -- see
// deck_card_allocations, which exists so an allocation already made survives
// later changes to the collection.
//
// THE UNIT OF EVERYTHING HERE IS THE COPY, NOT THE ROW.
//
// A collection row is a STACK: "3x Swamp, Unlimited, nonfoil, binder 1 pocket 4"
// is one row carrying three physical cards. This function previously took a
// list of collection row IDS to skip, which quietly assumed one row equals one
// card. Under that assumption the moment any deck pulled a single Swamp, the
// entire stack of three was struck off the list, and the next deck was told to
// go buy a card that was sitting in the binder. The availability view -- which
// correctly sums quantity -- said "3 owned, 2 free", and checkout said "none
// free". Two numbers, two answers, and the one the user acts on is whichever
// screen they opened.
//
// So the accounting is per-copy on both sides:
//
//   free(row) = row.quantity
//             - copies already PHYSICALLY pulled (deck_card_allocations)
//             - copies claimed earlier in this same pass (`claimedCopies`)
//
// Subtracting persisted allocations INSIDE this function is deliberate. It was
// previously the caller's job in decks.js, which meant every future call site
// had to remember to do it, and the two existing call sites already disagreed
// (checkout excluded other decks' allocations; the locator did not). A rule
// that has to be re-implemented per caller is a rule that will eventually be
// implemented three ways. An allocation row exists if and only if a card is
// physically out of the binder -- returning a deck deletes them, deleting a
// deck deletes them -- so "allocated" and "not on the shelf" are the same fact,
// and this function can establish it for itself.
//
// `claimedCopies` is a Map of collection row id -> copies already spoken for by
// earlier requirements in the CURRENT, not-yet-persisted pass. It stays a
// parameter because in-flight intent is not in the database yet and only the
// caller knows about it. It is read, never mutated: the caller owns its own
// bookkeeping.
async function selectPhysicalCopies(database, userId, requirement, { claimedCopies = new Map() } = {}) {
  // The LEFT JOIN totals what is already pulled per row. COALESCE turns "no
  // allocation rows" into 0 rather than NULL, so the arithmetic below never
  // has to special-case a never-allocated stack.
  const rows = await client(database).all(
    `SELECT c.id AS entry_id, c.quantity, c.location_id, c.compartment_id, c.position,
            COALESCE((
              SELECT SUM(a.quantity) FROM deck_card_allocations a
              WHERE a.collection_entry_id = c.id
            ), 0) AS allocated
     FROM collection c
     WHERE c.user_id = ? AND c.card_id = ? AND c.finish = ? AND c.list_type = 'collection'
     ORDER BY (c.location_id IS NOT NULL) DESC, c.added_at ASC, c.id ASC`,
    [userId, requirement.desired_card_id, requirement.desired_finish]
  );

  const picks = [];
  let needed = requirement.quantity;
  for (const row of rows) {
    if (needed <= 0) break;
    // max(0, ...) rather than trusting the subtraction: an over-allocated row
    // (only reachable via direct database surgery) must read as "nothing free",
    // never as a negative that would silently cancel out another stack's copies.
    const free = Math.max(0, row.quantity - row.allocated - (claimedCopies.get(row.entry_id) || 0));
    if (free <= 0) continue;
    const take = Math.min(free, needed);
    needed -= take;
    picks.push({ entry_id: row.entry_id, take, location_id: row.location_id, compartment_id: row.compartment_id });
  }
  return { picks, shortfall: needed };
}

module.exports = {
  FINISHES,
  BOARDS,
  RESERVING_BOARDS,
  DeckIdentityError,
  isFinish,
  isBoard,
  entryReserves,
  oracleIdentityForCard,
  ownedQuantity,
  requirementsForVariant,
  reservedByHigherPriority,
  availabilityForRequirement,
  availabilityForDeck,
  selectPhysicalCopies
};
