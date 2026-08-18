// Central authorization and capacity accounting for collection/storage writes.
//
// Why this module exists: before PR 6B these rules were re-derived inline in
// each route. `collection.js` checked that the *entry* belonged to the caller
// but happily accepted an arbitrary `compartment_id`; `storage.js` resolved a
// location by user but then addressed compartments by bare ID. The result was
// that ownership was enforced on the object named in the URL and not on the
// object named in the body. Capacity had the same shape of bug: three separate
// call sites each counted occupancy slightly differently, so whichever path a
// caller chose determined whether the limit applied at all.
//
// Every function here takes an explicit `userId` and an explicit db client. The
// db client parameter matters: inside `db.withTransaction(tx => ...)` the caller
// must pass `tx` so the read participates in the same transaction as the write
// it guards. Reading through the module-level `db` from inside a transaction
// would deadlock on the PR 6A queue.
const db = require('../db');

class InvariantError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function client(database) {
  return database || db;
}

// Resolve a compartment *and* prove the authenticated user owns the location it
// belongs to. Returns null when the compartment does not exist OR belongs to
// someone else -- deliberately indistinguishable, so this cannot be used to
// enumerate which compartment IDs exist in other users' accounts.
async function findOwnedCompartment(database, compartmentId, userId) {
  if (compartmentId === null || compartmentId === undefined) return null;
  const numericId = Number(compartmentId);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  return client(database).get(
    `SELECT cp.*,
            cp.location_id AS loc_id,
            l.type AS location_type, l.type AS loc_type,
            l.name AS location_name,
            l.sort_order, l.foil_sorting,
            l.locked AS location_locked
     FROM compartments cp
     JOIN locations l ON cp.location_id = l.id
     WHERE cp.id = ? AND l.user_id = ?`,
    [numericId, userId]
  );
}

// Same contract for locations.
async function findOwnedLocation(database, locationId, userId) {
  if (locationId === null || locationId === undefined || locationId === '') return null;
  const numericId = Number(locationId);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  return client(database).get(
    `SELECT * FROM locations WHERE id = ? AND user_id = ?`,
    [numericId, userId]
  );
}

// Throwing variants for call sites that treat a foreign/absent ID as a request
// error rather than a branch.
async function requireOwnedCompartment(database, compartmentId, userId) {
  const compartment = await findOwnedCompartment(database, compartmentId, userId);
  if (!compartment) {
    throw new InvariantError(400, 'Invalid compartment', 'COMPARTMENT_NOT_FOUND');
  }
  return compartment;
}

async function requireOwnedLocation(database, locationId, userId) {
  const location = await findOwnedLocation(database, locationId, userId);
  if (!location) {
    throw new InvariantError(400, 'Invalid location ID', 'LOCATION_NOT_FOUND');
  }
  return location;
}

// A compartment must belong to the location named alongside it. Callers that
// accept both a location_id and a compartment_id would otherwise let a client
// pair its own location with its own compartment from a *different* location,
// producing a collection row whose location_id and compartment_id disagree --
// rows that then render in the wrong container and corrupt capacity accounting
// for both.
function assertParentChild(location, compartment) {
  if (!location || !compartment) {
    throw new InvariantError(400, 'Invalid compartment', 'COMPARTMENT_NOT_FOUND');
  }
  if (Number(compartment.location_id) !== Number(location.id)) {
    throw new InvariantError(400, 'Compartment does not belong to the specified location', 'PARENT_CHILD_MISMATCH');
  }
}

// Resolve BOTH halves of a location+compartment URL pair in one call.
//
// Structural, not merely convenient. Every route that accepts a location ID and
// a compartment ID has three obligations -- own the location, own the
// compartment, and prove the second is a child of the first -- and each was
// previously written out longhand at the call site. Three separate statements
// is three separate chances to omit the third, and omitting the third is
// invisible in every happy-path test: the pair is consistent in normal use, so
// only a deliberately mismatched request can tell the difference.
//
// Folding them into one function makes the safe form the only form. A future
// route that takes both IDs cannot forget the pair check, because there is no
// longer a way to resolve the pair without performing it.
//
// Returns { location, compartment } so callers keep both objects they need.
async function requireOwnedCompartmentInLocation(database, locationId, compartmentId, userId) {
  const location = await requireOwnedLocation(database, locationId, userId);
  const compartment = await requireOwnedCompartment(database, compartmentId, userId);
  assertParentChild(location, compartment);
  return { location, compartment };
}

// The single definition of "how full is this compartment".
//
// Occupancy is SUM(quantity), not COUNT(*). The old inline checks disagreed on
// this: `resolveCompartmentAndPosition` counted rows while `loadCompartments`
// summed quantity. With one-row-per-card that difference is invisible, but any
// stacked row (import, legacy data, the auto-split path mid-flight) made the
// row-count check silently under-report and let a compartment overfill.
// `excludeEntryId` supports the move case, where the entry being moved must not
// be counted against the destination it is already sitting in.
async function compartmentOccupancy(database, compartmentId, { excludeEntryId = null } = {}) {
  let sql = `SELECT COALESCE(SUM(quantity), 0) AS occupied FROM collection WHERE compartment_id = ?`;
  const params = [compartmentId];
  if (excludeEntryId !== null && excludeEntryId !== undefined) {
    sql += ` AND id != ?`;
    params.push(excludeEntryId);
  }
  const row = await client(database).get(sql, params);
  return row ? row.occupied : 0;
}

// Reserve `additional` copies in a compartment, or refuse.
//
// This is the choke point every add/move/expand path must call while holding the
// transaction. Checking capacity outside the transaction and writing inside it
// is a TOCTOU race: two requests both read "3 of 4 used", both conclude there is
// room, and both insert. PR 6A's BEGIN IMMEDIATE serializes transactions, so
// performing this read inside the transaction makes the check-then-write pair
// atomic and the second caller observes the first caller's write.
async function assertCapacityFor(database, compartment, additional, { excludeEntryId = null } = {}) {
  if (!compartment) {
    throw new InvariantError(400, 'Invalid compartment', 'COMPARTMENT_NOT_FOUND');
  }
  const wanted = Number(additional);
  if (!Number.isInteger(wanted) || wanted < 0) {
    throw new InvariantError(400, 'Invalid copy count', 'INVALID_QUANTITY');
  }
  const occupied = await compartmentOccupancy(database, compartment.id, { excludeEntryId });
  const capacity = Number(compartment.capacity);
  if (occupied + wanted > capacity) {
    throw new InvariantError(400, 'COMPARTMENT_FULL', 'COMPARTMENT_FULL');
  }
  return { occupied, capacity, remaining: capacity - occupied - wanted };
}

// Refuse a capacity change that would leave the compartment over-committed.
//
// This is the mirror image of `assertCapacityFor`. That function guards the
// occupancy side of `occupancy <= capacity`; this one guards the capacity side.
// Without it the invariant had a hole big enough to drive the whole PR through:
// every add path reserved slots correctly, and then a single capacity UPDATE
// re-broke the same inequality from the other direction, leaving a compartment
// whose stored capacity the database had already violated.
//
// Semantics are REFUSE, never evict. Cards are physical objects; the server does
// not get to decide which ones leave a binder page. The user must move cards out
// first, then shrink.
//
// Must be called with the transaction handle. Reading occupancy outside the
// transaction that performs the UPDATE is the same TOCTOU as the add path: a
// concurrent add can land between the check and the write, so the shrink commits
// against an occupancy that is already stale.
async function assertCapacityShrinkAllowed(database, compartment, nextCapacity) {
  if (!compartment) {
    throw new InvariantError(400, 'Invalid compartment', 'COMPARTMENT_NOT_FOUND');
  }
  const capacity = Number(nextCapacity);
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new InvariantError(400, 'Capacity must be a positive integer', 'INVALID_CAPACITY');
  }
  const occupied = await compartmentOccupancy(database, compartment.id);
  // Shrinking to exactly occupancy is allowed: the inequality is `<=`, and a
  // compartment packed to its new limit is a legitimate, consistent state.
  if (occupied > capacity) {
    throw new InvariantError(
      400,
      `Cannot reduce capacity to ${capacity}: this compartment currently holds ${occupied} card(s). Move cards out first.`,
      'CAPACITY_BELOW_OCCUPANCY'
    );
  }
  return { occupied, capacity };
}

module.exports = {
  InvariantError,
  findOwnedCompartment,
  findOwnedLocation,
  requireOwnedCompartment,
  requireOwnedLocation,
  assertParentChild,
  requireOwnedCompartmentInLocation,
  compartmentOccupancy,
  assertCapacityFor,
  assertCapacityShrinkAllowed
};
