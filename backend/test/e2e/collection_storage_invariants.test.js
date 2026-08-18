// PR 6B: collection/storage authorization, capacity, and atomicity invariants.
//
// Every case here is a *behavior* test through the real HTTP routes, not a unit
// test of a helper, because the invariants being protected (ownership, capacity,
// atomicity) are only meaningful at the request boundary. A helper can be
// perfectly correct and still be bypassed by a route that never calls it.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-cs-invariants-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';
const db = require('../../src/db');
const collectionRoutes = require('../../src/routes/collection');
const storageRoutes = require('../../src/routes/storage');

let base;

async function api(token, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* empty body */ }
  return { status: response.status, body: payload };
}

async function createUser(username) {
  const inserted = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, 'member', ?)`,
    [username, db.hashPassword('test-only-password'), `share-${username}-${process.pid}`]
  );
  const token = `${username}-${process.pid}`;
  await db.run(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
    [token, inserted.lastID, new Date(Date.now() + 600_000).toISOString()]
  );
  return { id: inserted.lastID, token };
}

// A location with a single compartment of a known capacity. Created directly in
// SQL so a test's setup can never be silently reshaped by the route logic it is
// meant to be testing.
async function createLocation(userId, name, { capacity = 4, compartments = 1, sortOrder = 'name-asc' } = {}) {
  const loc = await db.run(
    `INSERT INTO locations (name, type, sort_order, rule_type, user_id) VALUES (?, 'Box', ?, 'any', ?)`,
    [name, sortOrder, userId]
  );
  const compIds = [];
  for (let idx = 1; idx <= compartments; idx++) {
    const comp = await db.run(
      `INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`,
      [loc.lastID, idx, capacity]
    );
    compIds.push(comp.lastID);
  }
  return { id: loc.lastID, compartmentIds: compIds, compartmentId: compIds[0] };
}

async function addEntry(userId, cardId, { locationId = null, compartmentId = null, quantity = 1 } = {}) {
  const row = await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, location_id, compartment_id, position)
     VALUES (?, ?, ?, ?, ?, 1000)`,
    [cardId, userId, quantity, locationId, compartmentId]
  );
  return row.lastID;
}

function occupancy(compartmentId) {
  return db.get(
    `SELECT COALESCE(SUM(quantity), 0) AS n FROM collection WHERE compartment_id = ?`,
    [compartmentId]
  ).then(r => r.n);
}

// Each test carries its harness ID as a literal field. The IDs used to be
// recovered from the test name with `name.slice(1, name.indexOf(' '))`, which
// made the reporting label a function of the prose: renaming a test, or writing
// one whose name did not start with "T<n> ", silently produced a garbage or
// duplicate ID in CI output. An identifier that must survive refactoring should
// be data, not a parse of a human-readable string.
const tests = [];
function test(id, name, fn) { tests.push({ id, name, fn }); }

// ---------------------------------------------------------------------------
// T1: cross-user compartment substitution on the collection update path.
//
// Failure mode: PUT /api/collection/:id accepted a raw compartment_id and wrote
// it straight onto the row. An authenticated attacker who can guess or
// enumerate a compartment ID belonging to another user could file their own
// cards into the victim's binder, consuming the victim's capacity and appearing
// in the victim's storage views. Ownership of the *entry* was checked; ownership
// of the *target container* was not.
// ---------------------------------------------------------------------------
test('F11-TC1', 'T1 cross-user compartment substitution is rejected', async ({ attacker, victim, cardId }) => {
  const victimLoc = await createLocation(victim.id, 'Victim Box T1');
  const entryId = await addEntry(attacker.id, cardId);

  const response = await api(attacker.token, `/api/collection/${entryId}`, {
    method: 'PUT',
    body: { compartment_id: victimLoc.compartmentId }
  });

  assert.ok(
    response.status === 400 || response.status === 404,
    `expected rejection, got ${response.status}: ${JSON.stringify(response.body)}`
  );

  const row = await db.get(`SELECT compartment_id, location_id FROM collection WHERE id = ?`, [entryId]);
  assert.strictEqual(row.compartment_id, null, 'attacker entry must not be filed into a foreign compartment');
  assert.strictEqual(row.location_id, null, 'attacker entry must not reference a foreign location');
  assert.strictEqual(await occupancy(victimLoc.compartmentId), 0, 'victim compartment must remain empty');
});

// ---------------------------------------------------------------------------
// T2: parent/child mismatch on the nested compartment route.
//
// Failure mode: PUT /api/locations/:id/compartments/:comp_id authorized the
// LOCATION in the URL and then addressed the compartment by bare ID. The
// capacity/label UPDATE was scoped `WHERE id = ? AND location_id = ?` and so was
// accidentally safe, but the `assignedFilters` branch ran an unscoped
// `DELETE FROM compartment_assignments WHERE compartment_id = ?`. An attacker
// pairing their own location ID with a foreign compartment ID could therefore
// wipe and rewrite another user's sorting rules. The same shape applies to a
// user's own compartment from a different location: the pair must be consistent,
// not merely individually valid.
// ---------------------------------------------------------------------------
test('F11-TC2', 'T2 parent-child mismatch on nested compartment route is rejected', async ({ attacker, victim, cardId }) => {
  const attackerLoc = await createLocation(attacker.id, 'Attacker Box T2');
  const victimLoc = await createLocation(victim.id, 'Victim Box T2');
  await db.run(
    `INSERT INTO compartment_assignments (compartment_id, filter_value) VALUES (?, 'victim-rule')`,
    [victimLoc.compartmentId]
  );

  // Attacker's own location id in the URL, victim's compartment id as the child.
  const response = await api(attacker.token, `/api/locations/${attackerLoc.id}/compartments/${victimLoc.compartmentId}`, {
    method: 'PUT',
    body: { capacity: 999, assignedFilters: ['attacker-rule'] }
  });

  assert.ok(
    response.status === 400 || response.status === 404,
    `expected rejection, got ${response.status}: ${JSON.stringify(response.body)}`
  );

  const filters = await db.all(
    `SELECT filter_value FROM compartment_assignments WHERE compartment_id = ?`,
    [victimLoc.compartmentId]
  );
  assert.deepStrictEqual(filters.map(f => f.filter_value), ['victim-rule'], 'victim sorting rules must be untouched');

  const comp = await db.get(`SELECT capacity FROM compartments WHERE id = ?`, [victimLoc.compartmentId]);
  assert.strictEqual(comp.capacity, 4, 'victim compartment capacity must be unchanged');
});

// ---------------------------------------------------------------------------
// T3: the exact capacity boundary is reachable but not exceedable.
//
// A capacity check is only trustworthy if it is exact at the edge. An off-by-one
// in either direction is a real defect: too strict wastes the last physical slot
// in every binder page, too loose is the bug this PR exists to close. Filling a
// compartment to exactly capacity must succeed; the very next copy must fail.
// ---------------------------------------------------------------------------
test('F11-TC3', 'T3 exact capacity boundary is reachable and the next copy is refused', async ({ attacker, cardId }) => {
  const loc = await createLocation(attacker.id, 'Boundary Box T3', { capacity: 3 });

  for (let i = 0; i < 3; i++) {
    const filled = await api(attacker.token, '/api/collection', {
      method: 'POST',
      body: { card_id: cardId, location_id: loc.id }
    });
    assert.strictEqual(filled.status, 200, `copy ${i + 1} should fit: ${JSON.stringify(filled.body)}`);
  }
  assert.strictEqual(await occupancy(loc.compartmentId), 3, 'compartment must hold exactly its capacity');

  // The compartment is now full. An explicit move into it must be refused
  // rather than silently overfilling.
  const overflowEntry = await addEntry(attacker.id, cardId);
  const response = await api(attacker.token, `/api/collection/${overflowEntry}`, {
    method: 'PUT',
    body: { compartment_id: loc.compartmentId }
  });
  assert.strictEqual(response.status, 400, `expected COMPARTMENT_FULL, got ${response.status}: ${JSON.stringify(response.body)}`);
  assert.strictEqual(await occupancy(loc.compartmentId), 3, 'a refused move must not change occupancy');

  const row = await db.get(`SELECT compartment_id FROM collection WHERE id = ?`, [overflowEntry]);
  assert.strictEqual(row.compartment_id, null, 'the refused entry must remain unfiled');
});

// ---------------------------------------------------------------------------
// T4: over-capacity rejection leaves zero partial writes.
//
// The dangerous version of a capacity failure is the one that half-succeeds.
// PUT /api/collection/:id with quantity > 1 auto-splits into extra rows in a
// loop; without a transaction and an up-front capacity reservation, the loop
// wrote rows until the compartment overflowed and then either kept going or
// aborted mid-way, leaving the collection in a state no user action produced.
// Requesting more copies than remaining capacity must write nothing at all.
// ---------------------------------------------------------------------------
test('F11-TC4', 'T4 over-capacity expansion is rejected with zero partial writes', async ({ attacker, cardId }) => {
  const loc = await createLocation(attacker.id, 'Atomic Box T4', { capacity: 4 });
  const entryId = await addEntry(attacker.id, cardId, { locationId: loc.id, compartmentId: loc.compartmentId });

  const before = await db.all(
    `SELECT id, compartment_id, quantity FROM collection WHERE user_id = ? ORDER BY id`,
    [attacker.id]
  );
  assert.strictEqual(await occupancy(loc.compartmentId), 1);

  // One row is already filed; asking for 10 copies needs 9 more slots but only
  // 3 remain.
  const response = await api(attacker.token, `/api/collection/${entryId}`, {
    method: 'PUT',
    body: { quantity: 10 }
  });
  assert.strictEqual(response.status, 400, `expected rejection, got ${response.status}: ${JSON.stringify(response.body)}`);

  const after = await db.all(
    `SELECT id, compartment_id, quantity FROM collection WHERE user_id = ? ORDER BY id`,
    [attacker.id]
  );
  assert.deepStrictEqual(after, before, 'a rejected expansion must leave the collection byte-identical');
  assert.strictEqual(await occupancy(loc.compartmentId), 1, 'occupancy must be unchanged');
});

// ---------------------------------------------------------------------------
// T5: concurrent adds into the last free slot serialize.
//
// This is the invariant a non-transactional capacity check cannot provide. Two
// simultaneous requests both read "capacity - 1 occupied", both conclude one
// slot is free, and both write -- a classic TOCTOU. Reading occupancy inside the
// transaction converts it into a serialized check-then-write: SQLite's
// BEGIN IMMEDIATE (PR 6A) admits one writer at a time, so the second request
// sees the first request's committed row and finds the compartment full.
//
// The assertion is deliberately on the *database*, not the response codes. A
// route may legitimately report overflow in several ways; what must never
// happen is physical occupancy exceeding capacity.
// ---------------------------------------------------------------------------
test('F11-TC5', 'T5 concurrent adds cannot both claim the last free slot', async ({ attacker, cardId }) => {
  const loc = await createLocation(attacker.id, 'Race Box T5', { capacity: 2 });
  // Consume one of the two slots so exactly one remains.
  await addEntry(attacker.id, cardId, { locationId: loc.id, compartmentId: loc.compartmentId });
  assert.strictEqual(await occupancy(loc.compartmentId), 1);

  const contenders = 6;
  const responses = await Promise.all(
    Array.from({ length: contenders }, () =>
      api(attacker.token, '/api/collection', {
        method: 'POST',
        body: { card_id: cardId, location_id: loc.id }
      })
    )
  );

  const finalOccupancy = await occupancy(loc.compartmentId);
  assert.ok(
    finalOccupancy <= 2,
    `capacity 2 compartment holds ${finalOccupancy} copies after ${contenders} concurrent adds ` +
    `(statuses: ${responses.map(r => r.status).join(',')})`
  );

  // Nothing may be filed into a compartment that does not exist or is foreign,
  // and no row may reference this location without a compartment inside it.
  const orphaned = await db.get(
    `SELECT COUNT(*) AS n FROM collection c
     LEFT JOIN compartments cp ON c.compartment_id = cp.id
     WHERE c.compartment_id IS NOT NULL AND cp.id IS NULL`,
    []
  );
  assert.strictEqual(orphaned.n, 0, 'no collection row may reference a non-existent compartment');
});

// ---------------------------------------------------------------------------
// T6: a bulk multi-ID move rolls back completely when one entry cannot be filed.
//
// POST /api/collection/bulk with action 'move' looped over entry IDs issuing an
// independent UPDATE per entry. A failure on entry N left entries 1..N-1 moved
// and reported a partial success the client had no way to reconcile. Bulk
// operations are the highest-value place to get this right: they are exactly
// where a user cannot manually verify each row afterwards.
//
// Note on setup: Bindarr deliberately overflows into the user's OTHER locations
// when a destination fills up, and reports that in the placement label. That is
// a feature, not a bug, so this test uses a dedicated user whose only other
// container is locked -- otherwise "the move failed" would really be "the move
// succeeded somewhere else", and the test would be asserting against intended
// product behavior rather than against the atomicity invariant.
// ---------------------------------------------------------------------------
test('F11-TC6', 'T6 bulk move rolls back entirely when an entry cannot be filed anywhere', async ({ cardId }) => {
  const user = await createUser('pr6b-bulk');
  const source = await createLocation(user.id, 'Bulk Source T6', { capacity: 10 });
  const dest = await createLocation(user.id, 'Bulk Dest T6', { capacity: 2 });
  // Close the overflow escape hatch so a genuinely unplaceable entry exists.
  await db.run(`UPDATE locations SET locked = 1 WHERE id = ?`, [source.id]);

  const entryIds = [];
  for (let i = 0; i < 5; i++) {
    entryIds.push(await addEntry(user.id, cardId, {
      locationId: source.id,
      compartmentId: source.compartmentId
    }));
  }

  const before = await db.all(
    `SELECT id, location_id, compartment_id FROM collection WHERE id IN (${entryIds.map(() => '?').join(',')}) ORDER BY id`,
    entryIds
  );
  assert.strictEqual(await occupancy(dest.compartmentId), 0);

  const response = await api(user.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: entryIds, action: 'move', value: String(dest.id) }
  });

  assert.strictEqual(
    response.status, 400,
    `expected all-or-nothing rejection, got ${response.status}: ${JSON.stringify(response.body)}`
  );

  const after = await db.all(
    `SELECT id, location_id, compartment_id FROM collection WHERE id IN (${entryIds.map(() => '?').join(',')}) ORDER BY id`,
    entryIds
  );
  assert.deepStrictEqual(after, before, 'a failed bulk move must leave every entry where it was');
  assert.strictEqual(await occupancy(dest.compartmentId), 0, 'no entry may be partially moved into the destination');
  assert.strictEqual(await occupancy(source.compartmentId), 5, 'the source must still hold all five entries');
});

// ---------------------------------------------------------------------------
// T7: shrinking capacity below current occupancy is refused.
//
// Failure mode: the capacity column was writable by any update path without
// consulting occupancy, so PUT .../compartments/:comp_id { capacity: 1 } on a
// compartment holding 3 cards returned 200 and left the compartment
// over-committed -- occupancy 3 against capacity 1. Every other guard in this
// PR reserves slots against `capacity`, so a capacity that is already violated
// silently poisons all of them: subsequent adds compare against a number the
// database has already broken.
//
// Semantics are REFUSE, not evict. Bindarr never decides on the user's behalf
// which physical cards leave a binder page; the user must move cards out first.
// ---------------------------------------------------------------------------
test('F11-TC7', 'T7 shrinking capacity below occupancy is refused with no state change', async ({ attacker, cardId }) => {
  const loc = await createLocation(attacker.id, 'Shrink Box T7', { capacity: 4 });
  for (let i = 0; i < 3; i++) {
    await addEntry(attacker.id, cardId, { locationId: loc.id, compartmentId: loc.compartmentId });
  }
  assert.strictEqual(await occupancy(loc.compartmentId), 3);

  const response = await api(attacker.token, `/api/locations/${loc.id}/compartments/${loc.compartmentId}`, {
    method: 'PUT',
    body: { capacity: 1 }
  });

  assert.strictEqual(
    response.status, 400,
    `expected refusal, got ${response.status}: ${JSON.stringify(response.body)}`
  );

  const comp = await db.get(`SELECT capacity FROM compartments WHERE id = ?`, [loc.compartmentId]);
  assert.strictEqual(comp.capacity, 4, 'a refused shrink must leave capacity unchanged');
  assert.strictEqual(await occupancy(loc.compartmentId), 3, 'a refused shrink must not move or drop any card');
});

// ---------------------------------------------------------------------------
// T8: the flat PATCH route is the same invariant, and its updateAll fan-out is
// the worse version of it.
//
// The storage UI edits rows/pages by bare compartment id through
// PATCH /api/compartments/:id, a completely separate handler from the nested
// PUT. Fixing only the nested route would leave the actual path the UI uses
// wide open -- exactly the "one-off inline check" failure mode this PR is
// trying to eliminate. `updateAll=true` is worse still: one request lowers the
// capacity of every compartment in the location, so a single click could
// over-commit an entire binder. Refusal must be all-or-nothing across the
// fan-out: if ANY compartment would end up over-committed, no compartment's
// capacity changes.
// ---------------------------------------------------------------------------
test('F11-TC8', 'T8 flat PATCH refuses a shrink below occupancy, including the updateAll fan-out', async ({ attacker, cardId }) => {
  const loc = await createLocation(attacker.id, 'Flat Box T8', { capacity: 4, compartments: 3 });
  const [first, second, third] = loc.compartmentIds;
  // Only the second compartment is heavily loaded.
  for (let i = 0; i < 3; i++) {
    await addEntry(attacker.id, cardId, { locationId: loc.id, compartmentId: second });
  }
  await addEntry(attacker.id, cardId, { locationId: loc.id, compartmentId: first });

  // Single-compartment shrink below occupancy.
  const single = await api(attacker.token, `/api/compartments/${second}`, {
    method: 'PATCH',
    body: { capacity: 2 }
  });
  assert.strictEqual(single.status, 400, `expected refusal, got ${single.status}: ${JSON.stringify(single.body)}`);
  const afterSingle = await db.get(`SELECT capacity FROM compartments WHERE id = ?`, [second]);
  assert.strictEqual(afterSingle.capacity, 4, 'a refused flat shrink must leave capacity unchanged');

  // Fan-out shrink: capacity 2 fits compartments 1 and 3 but not compartment 2.
  const bulk = await api(attacker.token, `/api/compartments/${first}?updateAll=true`, {
    method: 'PATCH',
    body: { capacity: 2 }
  });
  assert.strictEqual(bulk.status, 400, `expected refusal, got ${bulk.status}: ${JSON.stringify(bulk.body)}`);

  const caps = await db.all(`SELECT id, capacity FROM compartments WHERE location_id = ? ORDER BY id`, [loc.id]);
  assert.deepStrictEqual(
    caps.map(c => c.capacity), [4, 4, 4],
    'a refused fan-out shrink must not lower capacity on ANY compartment'
  );
  assert.strictEqual(await occupancy(second), 3, 'no card may be evicted by a refused shrink');
  assert.strictEqual(await occupancy(third), 0);
});

// ---------------------------------------------------------------------------
// T9: the shrink boundary is exact in both directions.
//
// The refusal rule is `occupied > capacity`, not `occupied >= capacity`. Getting
// this off by one either way is a real defect. Too strict and a user can never
// shrink a page down to the number of cards actually in it -- a legitimate,
// consistent end state, and the obvious thing to do after pulling cards out.
// Too loose and it is the blocker itself. Shrinking an empty compartment is the
// degenerate case of the same rule and must never be blocked.
// ---------------------------------------------------------------------------
test('F11-TC9', 'T9 shrink to exactly occupancy succeeds, one below fails, empty succeeds', async ({ attacker, cardId }) => {
  const loc = await createLocation(attacker.id, 'Boundary Shrink T9', { capacity: 9, compartments: 2 });
  const [loaded, empty] = loc.compartmentIds;
  for (let i = 0; i < 3; i++) {
    await addEntry(attacker.id, cardId, { locationId: loc.id, compartmentId: loaded });
  }
  assert.strictEqual(await occupancy(loaded), 3);

  // Exactly occupancy: allowed.
  const exact = await api(attacker.token, `/api/compartments/${loaded}`, {
    method: 'PATCH',
    body: { capacity: 3 }
  });
  assert.strictEqual(exact.status, 200, `shrink to exactly occupancy must succeed: ${JSON.stringify(exact.body)}`);
  assert.strictEqual(
    (await db.get(`SELECT capacity FROM compartments WHERE id = ?`, [loaded])).capacity, 3,
    'capacity must be lowered to exactly occupancy'
  );

  // One below occupancy: refused.
  const below = await api(attacker.token, `/api/compartments/${loaded}`, {
    method: 'PATCH',
    body: { capacity: 2 }
  });
  assert.strictEqual(below.status, 400, `shrink below occupancy must fail: ${JSON.stringify(below.body)}`);
  assert.strictEqual(
    (await db.get(`SELECT capacity FROM compartments WHERE id = ?`, [loaded])).capacity, 3,
    'capacity must survive the refused shrink'
  );
  assert.strictEqual(await occupancy(loaded), 3, 'no card may be evicted');

  // Empty compartment: shrinking to the floor is always allowed.
  const emptied = await api(attacker.token, `/api/compartments/${empty}`, {
    method: 'PATCH',
    body: { capacity: 1 }
  });
  assert.strictEqual(emptied.status, 200, `shrink of an empty compartment must succeed: ${JSON.stringify(emptied.body)}`);
  assert.strictEqual(
    (await db.get(`SELECT capacity FROM compartments WHERE id = ?`, [empty])).capacity, 1,
    'empty compartment capacity must be lowered'
  );
});

// ---------------------------------------------------------------------------
// T10: a shrink racing an add cannot interleave into an over-commit.
//
// This is the shrink-side mirror of T5, and the reason the guard has to read
// occupancy through the transaction handle rather than the module-level db. The
// dangerous interleaving is: shrink reads occupancy 1 against a proposed
// capacity 1 and decides it fits; an add concurrently reserves the second slot
// against the OLD capacity 2 and commits; the shrink then commits capacity 1
// over an occupancy of 2. Both requests individually observed a legal state and
// the pair produced an illegal one.
//
// PR 6A's BEGIN IMMEDIATE serializes the two transactions, so whichever runs
// second observes the first's committed rows and refuses. As in T5, the
// assertion is on the database rather than on response codes: either outcome
// ordering is legitimate, but the end state must satisfy occupancy <= capacity.
// ---------------------------------------------------------------------------
test('F11-TC10', 'T10 concurrent shrink and add cannot interleave into an over-commit', async ({ attacker, cardId }) => {
  for (let round = 0; round < 5; round++) {
    const loc = await createLocation(attacker.id, `Race Shrink T10-${round}`, { capacity: 2 });
    // One of two slots used: an add has room, and a shrink to 1 is legal right
    // now. Exactly one of the two may win.
    await addEntry(attacker.id, cardId, { locationId: loc.id, compartmentId: loc.compartmentId });
    // Lock the location so a rejected add cannot legitimately overflow into
    // another container and mask the race.
    await db.run(`UPDATE locations SET locked = 1 WHERE id != ? AND user_id = ?`, [loc.id, attacker.id]);

    const [shrink, add] = await Promise.all([
      api(attacker.token, `/api/compartments/${loc.compartmentId}`, {
        method: 'PATCH',
        body: { capacity: 1 }
      }),
      api(attacker.token, '/api/collection', {
        method: 'POST',
        body: { card_id: cardId, location_id: loc.id }
      })
    ]);

    const comp = await db.get(`SELECT capacity FROM compartments WHERE id = ?`, [loc.compartmentId]);
    const occupied = await occupancy(loc.compartmentId);
    assert.ok(
      occupied <= comp.capacity,
      `round ${round}: compartment holds ${occupied} against capacity ${comp.capacity} ` +
      `(shrink ${shrink.status}, add ${add.status}) -- shrink and add interleaved into an over-commit`
    );
    await db.run(`UPDATE locations SET locked = 0 WHERE user_id = ?`, [attacker.id]);
  }
});

// ---------------------------------------------------------------------------
// Fault injection.
//
// Proving a multi-step write is atomic requires it to actually fail partway
// through. Monkeypatching the db module would test the mock rather than the
// route, so instead a SQLite trigger raises ABORT on a chosen row. The failure
// therefore originates inside the real driver, on a real statement, at a point
// the route does not know about -- which is exactly the shape of the production
// failure (disk error, constraint, crash) these transactions must survive.
async function withAbortTrigger(name, sql, fn) {
  await db.run(`DROP TRIGGER IF EXISTS ${name}`);
  await db.run(sql);
  try {
    return await fn();
  } finally {
    await db.run(`DROP TRIGGER IF EXISTS ${name}`);
  }
}

// Snapshot every placement-bearing column for a user's rows, so a test can
// assert the database is byte-identical before and after a failed operation
// rather than spot-checking one field.
async function placements(userId) {
  const rows = await db.all(
    `SELECT id, location_id, compartment_id, position FROM collection WHERE user_id = ? ORDER BY id`,
    [userId]
  );
  return JSON.stringify(rows);
}

// ---------------------------------------------------------------------------
// T11: nested compartment DELETE must enforce the parent-child pair.
//
// Failure mode (reproduced before the fix): the route authorized the location
// in the URL, then unfiled cards by bare compartment_id with no check that the
// compartment actually lives in that location. Deleting an empty compartment in
// Box A while passing a compartment ID belonging to Box B returned HTTP 200 and
// emptied Box B. The DELETE half was correctly scoped so the compartment
// survived -- which makes it worse, not better: the destructive half landed,
// the visible half did not, and the response claimed success.
//
// This is reachable by an ordinary authenticated user through a stale browser
// tab or a mis-click, not only by an attacker; both containers are their own.
// ---------------------------------------------------------------------------
test('F11-TC11', 'T11 nested compartment DELETE rejects a mismatched parent-child pair', async ({ attacker, cardId }) => {
  const boxA = await createLocation(attacker.id, 'Mismatch Parent A T11', { compartments: 2 });
  const boxB = await createLocation(attacker.id, 'Mismatch Child B T11', { compartments: 2 });
  const victimComp = boxB.compartmentIds[0];

  const entryIds = [];
  for (let i = 0; i < 3; i++) {
    entryIds.push(await addEntry(attacker.id, cardId, { locationId: boxB.id, compartmentId: victimComp }));
  }
  assert.strictEqual(await occupancy(victimComp), 3);
  const before = await placements(attacker.id);

  // Location A in the path, a compartment from location B in the body position.
  const response = await api(attacker.token, `/api/locations/${boxA.id}/compartments/${victimComp}`, {
    method: 'DELETE'
  });

  assert.strictEqual(response.status, 400, `mismatched pair must be refused, got ${response.status}: ${JSON.stringify(response.body)}`);

  // The database, not the status code, is the real assertion.
  const stillThere = await db.get(`SELECT id, location_id FROM compartments WHERE id = ?`, [victimComp]);
  assert.ok(stillThere, 'compartment addressed through the wrong parent must survive');
  assert.strictEqual(Number(stillThere.location_id), boxB.id, 'compartment must remain in its true parent');
  assert.strictEqual(await occupancy(victimComp), 3, 'no card may be unfiled by a refused delete');
  assert.strictEqual(await placements(attacker.id), before, 'no placement column may change');
});

// ---------------------------------------------------------------------------
// T12: nested compartment DELETE is atomic.
//
// The handler unfiles the cards and then drops the compartment as two separate
// statements. If the second fails, the cards are already homeless while their
// container still exists -- the user sees an error and an empty box, with no
// indication that anything was lost. Aborting the DELETE proves the unfiling
// rolls back with it.
// ---------------------------------------------------------------------------
test('F11-TC12', 'T12 nested compartment DELETE rolls back the unfiling when the delete fails', async ({ attacker, cardId }) => {
  const box = await createLocation(attacker.id, 'Atomic Nested Delete T12', { compartments: 2 });
  const target = box.compartmentIds[0];
  for (let i = 0; i < 3; i++) {
    await addEntry(attacker.id, cardId, { locationId: box.id, compartmentId: target });
  }
  const before = await placements(attacker.id);

  await withAbortTrigger(
    'pr6b_abort_comp_delete',
    `CREATE TRIGGER pr6b_abort_comp_delete BEFORE DELETE ON compartments
     FOR EACH ROW WHEN OLD.id = ${target}
     BEGIN SELECT RAISE(ABORT, 'injected compartment delete failure'); END`,
    async () => {
      const response = await api(attacker.token, `/api/locations/${box.id}/compartments/${target}`, {
        method: 'DELETE'
      });
      assert.strictEqual(response.status, 500, `injected failure should surface as an error, got ${response.status}`);
    }
  );

  assert.ok(
    await db.get(`SELECT id FROM compartments WHERE id = ?`, [target]),
    'compartment must survive the aborted delete'
  );
  assert.strictEqual(await occupancy(target), 3, 'cards must not be left unfiled by a failed delete');
  assert.strictEqual(await placements(attacker.id), before, 'a failed delete must leave zero partial writes');
});

// ---------------------------------------------------------------------------
// T13: flat compartment DELETE is atomic.
//
// Same two-statement shape as T12 on the flat route the storage UI actually
// calls. Ownership was already correct here; atomicity was not.
// ---------------------------------------------------------------------------
test('F11-TC13', 'T13 flat compartment DELETE rolls back the unfiling when the delete fails', async ({ attacker, cardId }) => {
  const box = await createLocation(attacker.id, 'Atomic Flat Delete T13', { compartments: 2 });
  const target = box.compartmentIds[0];
  for (let i = 0; i < 2; i++) {
    await addEntry(attacker.id, cardId, { locationId: box.id, compartmentId: target });
  }
  const before = await placements(attacker.id);

  await withAbortTrigger(
    'pr6b_abort_flat_delete',
    `CREATE TRIGGER pr6b_abort_flat_delete BEFORE DELETE ON compartments
     FOR EACH ROW WHEN OLD.id = ${target}
     BEGIN SELECT RAISE(ABORT, 'injected flat delete failure'); END`,
    async () => {
      const response = await api(attacker.token, `/api/compartments/${target}`, { method: 'DELETE' });
      assert.strictEqual(response.status, 500, `injected failure should surface as an error, got ${response.status}`);
    }
  );

  assert.ok(await db.get(`SELECT id FROM compartments WHERE id = ?`, [target]), 'compartment must survive');
  assert.strictEqual(await occupancy(target), 2, 'cards must not be left unfiled');
  assert.strictEqual(await placements(attacker.id), before, 'zero partial writes');
});

// ---------------------------------------------------------------------------
// T14: resort must not be able to leave a container unfiled.
//
// This is the highest-severity case in the suite. The handler NULLs
// compartment_id for EVERY card in the location as its first act, then refiles
// them one row at a time. Outside a transaction, any failure after that first
// statement leaves the entire container empty with no rollback and no error the
// user can act on -- their cards silently lose their physical location, which in
// a collection tracker is indistinguishable from losing the cards.
//
// The trigger aborts one refile mid-loop, so some rows have already been
// rewritten when the failure lands. That is precisely the state a non-atomic
// implementation cannot recover from.
// ---------------------------------------------------------------------------
test('F11-TC14', 'T14 a failed resort leaves zero unfiled cards and zero partial writes', async ({ attacker, cardId }) => {
  const box = await createLocation(attacker.id, 'Resort Rollback T14', { capacity: 2, compartments: 3 });
  const entryIds = [];
  for (const comp of box.compartmentIds) {
    for (let i = 0; i < 2; i++) {
      entryIds.push(await addEntry(attacker.id, cardId, { locationId: box.id, compartmentId: comp }));
    }
  }
  assert.strictEqual(entryIds.length, 6);
  const before = await placements(attacker.id);
  const filedBefore = await db.get(
    `SELECT COUNT(*) AS n FROM collection WHERE user_id = ? AND location_id = ? AND compartment_id IS NOT NULL`,
    [attacker.id, box.id]
  );
  assert.strictEqual(filedBefore.n, 6, 'all six cards start filed');

  // Abort when the last entry is refiled: earlier rows have already been
  // rewritten by then, so this cannot pass by accident on a route that simply
  // fails before doing any work.
  const lastEntry = entryIds[entryIds.length - 1];
  await withAbortTrigger(
    'pr6b_abort_resort',
    `CREATE TRIGGER pr6b_abort_resort BEFORE UPDATE ON collection
     FOR EACH ROW WHEN NEW.id = ${lastEntry} AND NEW.compartment_id IS NOT NULL
     BEGIN SELECT RAISE(ABORT, 'injected resort refile failure'); END`,
    async () => {
      const response = await api(attacker.token, `/api/locations/${box.id}/resort`, { method: 'POST' });
      assert.strictEqual(response.status, 500, `injected failure should surface as an error, got ${response.status}`);
    }
  );

  const filedAfter = await db.get(
    `SELECT COUNT(*) AS n FROM collection WHERE user_id = ? AND location_id = ? AND compartment_id IS NOT NULL`,
    [attacker.id, box.id]
  );
  assert.strictEqual(filedAfter.n, 6, 'a failed resort must not leave a single card unfiled');
  assert.strictEqual(await placements(attacker.id), before, 'a failed resort must roll back every refile');
});

// ---------------------------------------------------------------------------
// T15: a successful resort is still correct and respects capacity.
//
// Wrapping a handler in a transaction is only half the job: the read path must
// use the transaction handle too, or the operation commits against a snapshot it
// never actually verified. This is the GREEN counterpart to T14 -- it proves the
// rewrite did not simply make resort fail safely by making it fail always.
// ---------------------------------------------------------------------------
test('F11-TC15', 'T15 a successful resort refiles every card within capacity', async ({ attacker, cardId }) => {
  const box = await createLocation(attacker.id, 'Resort Success T15', { capacity: 2, compartments: 3 });
  for (const comp of box.compartmentIds) {
    for (let i = 0; i < 2; i++) {
      await addEntry(attacker.id, cardId, { locationId: box.id, compartmentId: comp });
    }
  }

  const response = await api(attacker.token, `/api/locations/${box.id}/resort`, { method: 'POST' });
  assert.strictEqual(response.status, 200, `resort must succeed: ${JSON.stringify(response.body)}`);

  const unfiled = await db.get(
    `SELECT COUNT(*) AS n FROM collection WHERE user_id = ? AND location_id = ? AND compartment_id IS NULL`,
    [attacker.id, box.id]
  );
  assert.strictEqual(unfiled.n, 0, 'every card must end up filed');

  // No compartment may end the operation over its capacity.
  for (const comp of box.compartmentIds) {
    const cap = await db.get(`SELECT capacity FROM compartments WHERE id = ?`, [comp]);
    const used = await occupancy(comp);
    assert.ok(used <= cap.capacity, `compartment ${comp} holds ${used} against capacity ${cap.capacity}`);
  }
});

// ---------------------------------------------------------------------------
// T16: the location rule-change eviction is atomic.
//
// PUT /locations/:id writes the new rule and then evicts the cards the rule no
// longer accepts, as independent statements. A mid-loop failure committed the
// new rule plus an arbitrary prefix of evictions -- the container then reports a
// rule its own contents violate, and the user has no way to tell which cards
// were dropped. The flat PATCH twin of this path was already wrapped; this one
// was missed.
// ---------------------------------------------------------------------------
test('F11-TC16', 'T16 a failed rule-change eviction rolls back both the rule and the evictions', async ({ attacker, cardId }) => {
  const box = await createLocation(attacker.id, 'Rule Eviction T16', { capacity: 9 });
  const entryIds = [];
  for (let i = 0; i < 3; i++) {
    entryIds.push(await addEntry(attacker.id, cardId, { locationId: box.id, compartmentId: box.compartmentId }));
  }
  const before = await placements(attacker.id);
  const ruleBefore = await db.get(`SELECT rule_type, rule_config FROM locations WHERE id = ?`, [box.id]);

  // This rule excludes the test card, so every entry is an eviction candidate.
  const excludeAll = { rules: [{ field: 'name', operator: 'contains', value: 'Invariant', action: 'exclude' }] };

  await withAbortTrigger(
    'pr6b_abort_eviction',
    `CREATE TRIGGER pr6b_abort_eviction BEFORE UPDATE ON collection
     FOR EACH ROW WHEN NEW.id = ${entryIds[entryIds.length - 1]} AND NEW.compartment_id IS NULL
     BEGIN SELECT RAISE(ABORT, 'injected eviction failure'); END`,
    async () => {
      const response = await api(attacker.token, `/api/locations/${box.id}`, {
        method: 'PUT',
        body: { rule_type: 'compound', rule_config: excludeAll }
      });
      assert.strictEqual(response.status, 500, `injected failure should surface as an error, got ${response.status}`);
    }
  );

  const ruleAfter = await db.get(`SELECT rule_type, rule_config FROM locations WHERE id = ?`, [box.id]);
  assert.strictEqual(ruleAfter.rule_type, ruleBefore.rule_type, 'the rule change must roll back with its evictions');
  assert.strictEqual(ruleAfter.rule_config, ruleBefore.rule_config, 'rule_config must roll back');
  assert.strictEqual(await occupancy(box.compartmentId), 3, 'no card may be evicted by a failed rule change');
  assert.strictEqual(await placements(attacker.id), before, 'zero partial writes');
});

// ---------------------------------------------------------------------------
// T17: PUT /compartments/:id/filters is atomic.
//
// The filter rewrite is delete-then-reinsert. A failure between the two leaves
// the compartment with no filters at all -- silently converting a filtered page
// into one that accepts anything, which then mis-files future cards.
// ---------------------------------------------------------------------------
test('F11-TC17', 'T17 a failed filter rewrite does not leave the compartment with no filters', async ({ attacker }) => {
  const box = await createLocation(attacker.id, 'Filter Atomicity T17');
  const comp = box.compartmentId;
  await db.run(`INSERT INTO compartment_assignments (compartment_id, filter_value) VALUES (?, 'original')`, [comp]);

  const before = await db.all(
    `SELECT filter_value FROM compartment_assignments WHERE compartment_id = ? ORDER BY filter_value`, [comp]
  );

  await withAbortTrigger(
    'pr6b_abort_filters',
    `CREATE TRIGGER pr6b_abort_filters BEFORE INSERT ON compartment_assignments
     FOR EACH ROW WHEN NEW.compartment_id = ${comp} AND NEW.filter_value = 'second'
     BEGIN SELECT RAISE(ABORT, 'injected filter insert failure'); END`,
    async () => {
      const response = await api(attacker.token, `/api/compartments/${comp}/filters`, {
        method: 'PUT',
        body: { filters: ['first', 'second'] }
      });
      assert.strictEqual(response.status, 500, `injected failure should surface as an error, got ${response.status}`);
    }
  );

  const after = await db.all(
    `SELECT filter_value FROM compartment_assignments WHERE compartment_id = ? ORDER BY filter_value`, [comp]
  );
  assert.deepStrictEqual(after, before, 'a failed filter rewrite must restore the original filters');
});

// ---------------------------------------------------------------------------
// T18: cross-user isolation on the nested compartment DELETE.
//
// T11 covers the same-user mismatch. This covers the tenant boundary on the same
// route: a foreign location and a foreign compartment must both be refused, and
// the victim's cards must be untouched either way.
// ---------------------------------------------------------------------------
test('F11-TC18', 'T18 nested compartment DELETE cannot address another user container', async ({ attacker, victim, cardId }) => {
  const victimBox = await createLocation(victim.id, 'Victim Box T18', { compartments: 2 });
  const attackerBox = await createLocation(attacker.id, 'Attacker Box T18', { compartments: 2 });
  const victimComp = victimBox.compartmentIds[0];
  for (let i = 0; i < 2; i++) {
    await addEntry(victim.id, cardId, { locationId: victimBox.id, compartmentId: victimComp });
  }
  const victimBefore = await placements(victim.id);

  // Attacker's own location paired with the victim's compartment.
  const substituted = await api(attacker.token, `/api/locations/${attackerBox.id}/compartments/${victimComp}`, {
    method: 'DELETE'
  });
  assert.ok(substituted.status >= 400, `foreign compartment must be refused, got ${substituted.status}`);

  // The victim's location directly.
  const direct = await api(attacker.token, `/api/locations/${victimBox.id}/compartments/${victimComp}`, {
    method: 'DELETE'
  });
  assert.ok(direct.status >= 400, `foreign location must be refused, got ${direct.status}`);

  assert.ok(await db.get(`SELECT id FROM compartments WHERE id = ?`, [victimComp]), 'victim compartment must survive');
  assert.strictEqual(await occupancy(victimComp), 2, 'victim cards must remain filed');
  assert.strictEqual(await placements(victim.id), victimBefore, 'victim rows must be untouched');
});

// ===========================================================================
// ROUND 3: mutation-driven cases.
//
// Everything below exists because a mutation run proved the guard it covers was
// NOT load-bearing: the guard could be deleted outright and the entire suite
// stayed green. A passing suite was therefore not evidence that these guards
// worked -- only that they executed. Each case names the mutant it kills, and
// each asserts on DATABASE STATE rather than on an HTTP status alone, because a
// status code only tells you what the server said, not what it wrote.
// ===========================================================================

// ---------------------------------------------------------------------------
// T19 (kills M2): PUT /collection/:id must authorize the destination LOCATION.
//
// T1 covers substituting a foreign compartment_id. This covers the other half
// of the same handler: the `location_id` move branch, which resolves a slot via
// the placement engine. Without the ownership check an attacker names the
// victim's location and the engine happily finds them a slot inside it.
// ---------------------------------------------------------------------------
test('F11-TC19', 'T19 cross-user location substitution on PUT is rejected', async ({ attacker, victim, cardId }) => {
  const victimLoc = await createLocation(victim.id, 'Victim Box T19', { capacity: 8 });
  const entryId = await addEntry(attacker.id, cardId);
  const victimBefore = await placements(victim.id);

  const response = await api(attacker.token, `/api/collection/${entryId}`, {
    method: 'PUT',
    body: { location_id: victimLoc.id }
  });

  assert.ok(response.status >= 400, `expected rejection, got ${response.status}: ${JSON.stringify(response.body)}`);

  const row = await db.get(`SELECT location_id, compartment_id FROM collection WHERE id = ?`, [entryId]);
  assert.strictEqual(row.location_id, null, 'attacker entry must not reference the victim location');
  assert.strictEqual(row.compartment_id, null, 'attacker entry must not be filed into a victim compartment');
  assert.strictEqual(await occupancy(victimLoc.compartmentId), 0, 'victim compartment must remain empty');
  assert.strictEqual(await placements(victim.id), victimBefore, 'victim rows must be untouched');
});

// ---------------------------------------------------------------------------
// T20 (kills M8, M11): POST /collection/:id/place must authorize BOTH the
// target compartment and the swap partner's compartment.
//
// The place route is the manual tap-to-place path. It takes a raw
// compartment_id and, in the swap branch, adopts the swap partner's placement
// wholesale -- so an unauthorized swap target is a second way to write a
// foreign compartment_id onto one's own row.
// ---------------------------------------------------------------------------
test('F11-TC20', 'T20 place rejects a foreign compartment and a foreign swap partner', async ({ attacker, victim, cardId }) => {
  const victimLoc = await createLocation(victim.id, 'Victim Box T20', { capacity: 8, sortOrder: 'custom' });
  const attackerLoc = await createLocation(attacker.id, 'Attacker Box T20', { capacity: 8, sortOrder: 'custom' });
  const attackerEntry = await addEntry(attacker.id, cardId, {
    locationId: attackerLoc.id, compartmentId: attackerLoc.compartmentId
  });
  const victimEntry = await addEntry(victim.id, cardId, {
    locationId: victimLoc.id, compartmentId: victimLoc.compartmentId
  });
  const victimBefore = await placements(victim.id);

  // Direct: place my card into the victim's compartment.
  const direct = await api(attacker.token, `/api/collection/${attackerEntry}/place`, {
    method: 'POST',
    body: { compartment_id: victimLoc.compartmentId, slot: 1 }
  });
  assert.ok(direct.status >= 400, `foreign compartment must be refused, got ${direct.status}`);

  // Indirect: swap with a victim-owned row, inheriting its placement.
  const swap = await api(attacker.token, `/api/collection/${attackerEntry}/place`, {
    method: 'POST',
    body: { compartment_id: attackerLoc.compartmentId, swap_with: victimEntry }
  });
  assert.ok(swap.status >= 400, `foreign swap partner must be refused, got ${swap.status}`);

  const row = await db.get(`SELECT location_id, compartment_id FROM collection WHERE id = ?`, [attackerEntry]);
  assert.strictEqual(row.compartment_id, attackerLoc.compartmentId, 'attacker row must stay in its own compartment');
  assert.strictEqual(await occupancy(victimLoc.compartmentId), 1, 'victim compartment must hold only the victim card');
  assert.strictEqual(await placements(victim.id), victimBefore, 'victim rows must be untouched');
});

// ---------------------------------------------------------------------------
// T21 (kills M9, M10, M40): the place route must reserve the row's ACTUAL
// quantity.
//
// This is the round-3 data-loss bug. Occupancy is SUM(quantity), but the
// reservation was a hardcoded 1 while the UPDATE moves the WHOLE row. A stacked
// row of quantity 3 therefore consumed three slots having reserved one, and the
// compartment ended up holding more cards than its capacity permits -- which
// then poisons every later guard, since they all compare against a capacity the
// database has already violated.
//
// Asserted on stored state: the move must be REFUSED and occupancy must never
// exceed capacity. M40 (dropping excludeEntryId) is caught by the second half,
// which proves a legal stacked move still succeeds.
// ---------------------------------------------------------------------------
test('F11-TC21', 'T21 place reserves the full stacked quantity, not one slot', async ({ attacker, cardId }) => {
  const loc = await createLocation(attacker.id, 'Stacked Place T21', { capacity: 4, compartments: 2, sortOrder: 'custom' });
  const [target, source] = loc.compartmentIds;

  // Target already holds 2 of its 4 slots.
  for (let i = 0; i < 2; i++) {
    await addEntry(attacker.id, cardId, { locationId: loc.id, compartmentId: target });
  }
  // A stacked row of 3 sitting elsewhere: 2 + 3 = 5 > capacity 4, so it must not fit.
  const stacked = await addEntry(attacker.id, cardId, {
    locationId: loc.id, compartmentId: source, quantity: 3
  });
  assert.strictEqual(await occupancy(target), 2);

  const refused = await api(attacker.token, `/api/collection/${stacked}/place`, {
    method: 'POST',
    body: { compartment_id: target, slot: 3 }
  });

  assert.strictEqual(refused.status, 400, `over-capacity stacked move must be refused, got ${refused.status}: ${JSON.stringify(refused.body)}`);
  const afterRefusal = await db.get(`SELECT compartment_id FROM collection WHERE id = ?`, [stacked]);
  assert.strictEqual(afterRefusal.compartment_id, source, 'the refused row must stay in its source compartment');
  assert.strictEqual(await occupancy(target), 2, 'target occupancy must be unchanged by a refused move');

  // The complement: a stack that genuinely fits must still be accepted, so this
  // test cannot be satisfied by a guard that simply refuses everything.
  const fits = await addEntry(attacker.id, cardId, {
    locationId: loc.id, compartmentId: source, quantity: 2
  });
  const accepted = await api(attacker.token, `/api/collection/${fits}/place`, {
    method: 'POST',
    body: { compartment_id: target, slot: 3 }
  });
  assert.strictEqual(accepted.status, 200, `a stack that fits must be accepted: ${JSON.stringify(accepted.body)}`);
  assert.strictEqual(await occupancy(target), 4, 'target must be exactly full at capacity');
  const cap = await db.get(`SELECT capacity FROM compartments WHERE id = ?`, [target]);
  assert.ok(await occupancy(target) <= cap.capacity, 'occupancy must never exceed capacity');
});

// ---------------------------------------------------------------------------
// T22 (kills M12, M13): bulk move must authorize the destination location and
// reserve capacity per entry.
//
// T6 proves the batch rolls back; it does not prove the batch is authorized or
// bounded. Without the location check a bulk move files an attacker's whole
// selection into a victim's container in one request -- the highest-volume
// version of the T1 bug.
// ---------------------------------------------------------------------------
test('F11-TC22', 'T22 bulk move rejects a foreign destination and respects capacity', async ({ attacker, victim, cardId }) => {
  const victimLoc = await createLocation(victim.id, 'Victim Box T22', { capacity: 20 });
  const attackerLoc = await createLocation(attacker.id, 'Attacker Box T22', { capacity: 20 });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(await addEntry(attacker.id, cardId, { locationId: attackerLoc.id, compartmentId: attackerLoc.compartmentId }));
  }
  const victimBefore = await placements(victim.id);

  const foreign = await api(attacker.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: ids, action: 'move', value: String(victimLoc.id) }
  });
  assert.ok(foreign.status >= 400, `bulk move to a foreign location must be refused, got ${foreign.status}`);
  assert.strictEqual(await occupancy(victimLoc.compartmentId), 0, 'no attacker card may land in the victim container');
  assert.strictEqual(await placements(victim.id), victimBefore, 'victim rows must be untouched');
  const stillHome = await db.get(
    `SELECT COUNT(*) AS n FROM collection WHERE id IN (${ids.map(() => '?').join(',')}) AND compartment_id = ?`,
    [...ids, attackerLoc.compartmentId]
  );
  assert.strictEqual(stillHome.n, 3, 'every attacker row must stay where it was');

  // Capacity half (kills M13): a destination too small for the batch must
  // refuse the whole batch rather than overfill.
  const tiny = await createLocation(attacker.id, 'Tiny Dest T22', { capacity: 2 });
  await db.run(`UPDATE locations SET locked = 1 WHERE user_id = ? AND id != ?`, [attacker.id, tiny.id]);
  const overfill = await api(attacker.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: ids, action: 'move', value: String(tiny.id) }
  });
  await db.run(`UPDATE locations SET locked = 0 WHERE user_id = ?`, [attacker.id]);
  assert.strictEqual(overfill.status, 400, `a batch larger than the destination must be refused, got ${overfill.status}`);
  assert.strictEqual(await occupancy(tiny.compartmentId), 0, 'a refused batch must write nothing');
});

// ---------------------------------------------------------------------------
// T23 (kills M16): PUT /collection/:id is atomic.
//
// The handler resolves placement, updates columns, rebalances two compartments
// and performs the auto-split inserts. Without the transaction a failure in the
// split loop commits the column update and an arbitrary prefix of the new rows,
// leaving the user with copies they never asked for and no way to identify them.
// ---------------------------------------------------------------------------
test('F11-TC23', 'T23 a failed collection update rolls back every write', async ({ attacker, cardId }) => {
  const loc = await createLocation(attacker.id, 'Update Atomicity T23', { capacity: 40 });
  const entryId = await addEntry(attacker.id, cardId, {
    locationId: loc.id, compartmentId: loc.compartmentId
  });
  const before = await db.get(`SELECT * FROM collection WHERE id = ?`, [entryId]);
  const rowsBefore = await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ?`, [attacker.id]);

  // Fail on the THIRD auto-split insert, i.e. after the column UPDATE and after
  // some split rows already exist. Only a real transaction can undo those.
  await withAbortTrigger(
    'pr6b_abort_update',
    `CREATE TRIGGER pr6b_abort_update BEFORE INSERT ON collection
     FOR EACH ROW WHEN NEW.user_id = ${attacker.id} AND NEW.position > ${(before.position || 0) + 0.0015}
     BEGIN SELECT RAISE(ABORT, 'injected split insert failure'); END`,
    async () => {
      const response = await api(attacker.token, `/api/collection/${entryId}`, {
        method: 'PUT',
        body: { quantity: 4, condition: 'Damaged' }
      });
      assert.strictEqual(response.status, 500, `injected failure should surface as an error, got ${response.status}`);
    }
  );

  const after = await db.get(`SELECT * FROM collection WHERE id = ?`, [entryId]);
  assert.strictEqual(after.condition, before.condition, 'the column update must roll back with the failed split');
  assert.strictEqual(after.quantity, before.quantity, 'quantity must roll back');
  const rowsAfter = await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ?`, [attacker.id]);
  assert.strictEqual(rowsAfter.n, rowsBefore.n, 'no partial split rows may survive a failed update');
});

// ---------------------------------------------------------------------------
// T24 (kills M18, M35): the nested compartment PUT must enforce the pair.
//
// T2 covers a foreign compartment; both halves are individually unauthorized so
// the plain ownership checks already reject it. This covers the subtler case the
// pair check exists for: BOTH IDs belong to the caller, but the compartment
// lives in a DIFFERENT location. Nothing is foreign, so ownership checks pass --
// only the parent-child comparison can catch it.
// ---------------------------------------------------------------------------
test('F11-TC24', 'T24 nested compartment PUT rejects an own-but-mismatched pair', async ({ attacker, cardId }) => {
  const boxA = await createLocation(attacker.id, 'Own Box A T24', { capacity: 9 });
  const boxB = await createLocation(attacker.id, 'Own Box B T24', { capacity: 9 });
  await db.run(`INSERT INTO compartment_assignments (compartment_id, filter_value) VALUES (?, 'b-rule')`, [boxB.compartmentId]);
  const capBefore = (await db.get(`SELECT capacity FROM compartments WHERE id = ?`, [boxB.compartmentId])).capacity;

  // Location A in the URL, compartment from location B as the child.
  const response = await api(attacker.token, `/api/locations/${boxA.id}/compartments/${boxB.compartmentId}`, {
    method: 'PUT',
    body: { capacity: 99, assignedFilters: ['rewritten'] }
  });

  assert.strictEqual(response.status, 400, `mismatched pair must be refused, got ${response.status}: ${JSON.stringify(response.body)}`);
  const capAfter = (await db.get(`SELECT capacity FROM compartments WHERE id = ?`, [boxB.compartmentId])).capacity;
  assert.strictEqual(capAfter, capBefore, "compartment B's capacity must be unchanged");
  const filters = await db.all(
    `SELECT filter_value FROM compartment_assignments WHERE compartment_id = ? ORDER BY filter_value`, [boxB.compartmentId]
  );
  assert.deepStrictEqual(filters.map(f => f.filter_value), ['b-rule'], "compartment B's filters must not be rewritten");
});

// ---------------------------------------------------------------------------
// T25 (kills M22): resort must RESPECT capacity, not merely roll back.
//
// The headline finding of round 3: the resort reservation could be deleted
// outright and all 73 tests stayed green.
//
// Why the obvious test does not catch it. Resort plans its refile from
// `loadCompartments`, an in-memory projection of how full each compartment is.
// In ordinary data that projection agrees with the database, so the planner
// never proposes an over-capacity slot and the reservation never has to fire.
// Any test built from ordinary data therefore EXERCISES the guard without
// DEPENDING on it -- exactly the distinction mutation testing exposes.
//
// The reservation earns its place where the projection and the database
// disagree. They compute occupancy differently: `loadCompartments` counts only
// rows belonging to the requesting user, while the capacity guard counts every
// row physically in the compartment. A compartment holding a row owned by
// someone else is therefore invisible to the planner and visible to the guard.
//
// That state is not hypothetical: it is precisely what the cross-user
// substitution bug (T1) produced before this PR, so any database that ran the
// old code can contain it. Seeded here directly in SQL, as legacy data would
// be. The reservation is the only thing standing between that row and a
// compartment refilled past its capacity.
// ---------------------------------------------------------------------------
test('F11-TC25', 'T25 resort never files more cards into a compartment than it holds', async ({ victim, cardId }) => {
  const user = await createUser('pr6b-resort-cap');
  // Two compartments, four slots each.
  const box = await createLocation(user.id, 'Resort Capacity T25', { capacity: 4, compartments: 2 });
  const [compA, compB] = box.compartmentIds;

  // Start from a LEGAL state: compartment A holds one foreign copy-stack of 3
  // plus one owner card (4 of 4 used); compartment B holds three owner cards
  // (3 of 4). Nothing is over capacity before the request.
  //
  // The corruption is that the foreign stack in A is invisible to the planner,
  // which filters occupancy by user_id. After resort unfiles the owner's rows,
  // the planner believes A is completely empty (0 of 4) when it physically
  // holds 3 copies, and it is the compartment the sort fills FIRST. Placing the
  // contamination in the first-filled compartment is what makes the blind spot
  // reachable -- in the second compartment the sort never gets that far.
  //
  // This state is not hypothetical: it is exactly what the cross-user
  // substitution bug (T1) produced before this PR, so any database that ran the
  // old code can contain it. Seeded directly in SQL, as legacy data would be.
  await addEntry(victim.id, cardId, { locationId: box.id, compartmentId: compA, quantity: 3 });
  await addEntry(user.id, cardId, { locationId: box.id, compartmentId: compA });
  for (let i = 0; i < 3; i++) {
    await addEntry(user.id, cardId, { locationId: box.id, compartmentId: compB });
  }

  // No escape hatch: every other container of this user is locked, so a card
  // that does not fit cannot be legitimately overflowed elsewhere.
  await db.run(`UPDATE locations SET locked = 1 WHERE user_id = ? AND id != ?`, [user.id, box.id]);

  const response = await api(user.token, `/api/locations/${box.id}/resort`, { method: 'POST' });

  // Either outcome is defensible at the HTTP layer -- refuse the resort, or
  // file what fits and leave the rest unsorted. What is NOT defensible is a
  // compartment holding more copies than its capacity. Assert the invariant,
  // not the status code.
  const overfilled = await db.all(
    `SELECT cp.id, cp.capacity, COALESCE(SUM(c.quantity), 0) AS occupied
     FROM compartments cp
     LEFT JOIN collection c ON c.compartment_id = cp.id
     WHERE cp.location_id = ?
     GROUP BY cp.id
     HAVING occupied > cp.capacity`,
    [box.id]
  );
  assert.deepStrictEqual(
    overfilled, [],
    `resort overfilled ${overfilled.length} compartment(s): ${JSON.stringify(overfilled)} (status ${response.status})`
  );

  // And no copy may be silently destroyed along the way.
  const total = await db.get(`SELECT COALESCE(SUM(quantity), 0) AS n FROM collection WHERE user_id = ?`, [user.id]);
  assert.strictEqual(total.n, 4, 'every copy must still exist after a resort');
});

// ---------------------------------------------------------------------------
// T26 (kills M25, M27, M28): apply-all must authorize and reserve against the
// compartment the placement engine recommends.
//
// Same reasoning as T25, on the sibling batch-filing route: the reservation
// becomes load-bearing exactly where the planner's projection and the stored
// occupancy can disagree. Ownership of the recommended compartment is asserted
// alongside it, because trusting a computed id without re-checking it at the
// write point is how a planning bug becomes a cross-container write.
// ---------------------------------------------------------------------------
test('F11-TC26', 'T26 apply-all respects capacity and files only into owned compartments', async ({ victim, cardId }) => {
  const user = await createUser('pr6b-applyall-cap');
  const box = await createLocation(user.id, 'ApplyAll Capacity T26', { capacity: 4, compartments: 1 });
  await db.run(`UPDATE locations SET locked = 1 WHERE user_id = ? AND id != ?`, [user.id, box.id]);

  // Three of another user's copies physically occupy the single compartment:
  // invisible to the planner, visible to the capacity guard.
  await addEntry(victim.id, cardId, { locationId: box.id, compartmentId: box.compartmentId, quantity: 3 });

  // The owner now tries to file four unsorted cards into the remaining slot.
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await addEntry(user.id, cardId));

  const response = await api(user.token, `/api/locations/${box.id}/apply-all`, {
    method: 'POST',
    body: { entry_ids: ids }
  });
  assert.ok(response.status < 500, `apply-all should not crash, got ${response.status}: ${JSON.stringify(response.body)}`);

  const overfilled = await db.all(
    `SELECT cp.id, cp.capacity, COALESCE(SUM(c.quantity), 0) AS occupied
     FROM compartments cp
     LEFT JOIN collection c ON c.compartment_id = cp.id
     WHERE cp.location_id = ?
     GROUP BY cp.id
     HAVING occupied > cp.capacity`,
    [box.id]
  );
  assert.deepStrictEqual(overfilled, [], `apply-all overfilled: ${JSON.stringify(overfilled)}`);

  // Nothing may reference a compartment that is not this user's.
  const foreign = await db.get(
    `SELECT COUNT(*) AS n FROM collection c
     JOIN compartments cp ON c.compartment_id = cp.id
     JOIN locations l ON cp.location_id = l.id
     WHERE c.user_id = ? AND l.user_id != ?`,
    [user.id, user.id]
  );
  assert.strictEqual(foreign.n, 0, 'no row may be filed into another user container');
});

// ---------------------------------------------------------------------------
// T27 (kills M23): DELETE /locations/:id is atomic.
//
// The most destructive unscoped route in the file: it unfiles every card in the
// location and then drops the location. As two independent statements, a
// failure between them leaves rows pointing at a location that no longer
// exists, or cards unfiled while their container survives. Neither state is
// recoverable by the user, because nothing records where the cards used to be.
// ---------------------------------------------------------------------------
test('F11-TC27', 'T27 a failed location DELETE rolls back the unfiling', async ({ cardId }) => {
  const user = await createUser('pr6b-locdel-atomic');
  const box = await createLocation(user.id, 'Location Delete T27', { capacity: 9 });
  for (let i = 0; i < 3; i++) {
    await addEntry(user.id, cardId, { locationId: box.id, compartmentId: box.compartmentId });
  }
  const before = await placements(user.id);
  assert.strictEqual(await occupancy(box.compartmentId), 3);

  // Fail the DELETE half, after the UPDATE half has already run.
  await withAbortTrigger(
    'pr6b_abort_locdel',
    `CREATE TRIGGER pr6b_abort_locdel BEFORE DELETE ON locations
     FOR EACH ROW WHEN OLD.id = ${box.id}
     BEGIN SELECT RAISE(ABORT, 'injected location delete failure'); END`,
    async () => {
      const response = await api(user.token, `/api/locations/${box.id}`, { method: 'DELETE' });
      assert.strictEqual(response.status, 500, `injected failure should surface as an error, got ${response.status}`);
    }
  );

  assert.ok(await db.get(`SELECT id FROM locations WHERE id = ?`, [box.id]), 'the location must survive a failed delete');
  assert.strictEqual(
    await placements(user.id), before,
    'a failed location delete must not leave cards unfiled -- the UPDATE must roll back with the DELETE'
  );
  assert.strictEqual(await occupancy(box.compartmentId), 3, 'every card must still be filed');
});

// ---------------------------------------------------------------------------
// T28 (kills M24, M37): DELETE /locations/:id must authorize the location.
//
// Unscoped destructive route: without the ownership check, naming any location
// id unfiles that user's cards and deletes their container. This is the single
// highest-blast-radius authorization gap in the PR.
// ---------------------------------------------------------------------------
test('F11-TC28', 'T28 location DELETE cannot destroy another user container', async ({ attacker, victim, cardId }) => {
  const victimBox = await createLocation(victim.id, 'Victim Box T28', { capacity: 9 });
  for (let i = 0; i < 2; i++) {
    await addEntry(victim.id, cardId, { locationId: victimBox.id, compartmentId: victimBox.compartmentId });
  }
  const before = await placements(victim.id);

  const response = await api(attacker.token, `/api/locations/${victimBox.id}`, { method: 'DELETE' });

  assert.ok(response.status >= 400, `deleting a foreign location must be refused, got ${response.status}`);
  assert.ok(await db.get(`SELECT id FROM locations WHERE id = ?`, [victimBox.id]), 'victim location must survive');
  assert.strictEqual(await occupancy(victimBox.compartmentId), 2, "victim's cards must stay filed");
  assert.strictEqual(await placements(victim.id), before, 'victim rows must be byte-identical');
});

// ---------------------------------------------------------------------------
// T29 (kills M32): POST /locations/:id/compartments must authorize the location.
//
// Adding a page to someone else's binder is a write into their container. It
// also silently inflates their capacity accounting.
// ---------------------------------------------------------------------------
test('F11-TC29', 'T29 cannot add a compartment to another user location', async ({ attacker, victim }) => {
  const victimBox = await createLocation(victim.id, 'Victim Box T29', { capacity: 9 });
  const before = await db.get(`SELECT COUNT(*) AS n FROM compartments WHERE location_id = ?`, [victimBox.id]);

  const response = await api(attacker.token, `/api/locations/${victimBox.id}/compartments`, { method: 'POST' });

  assert.ok(response.status >= 400, `adding to a foreign location must be refused, got ${response.status}`);
  const after = await db.get(`SELECT COUNT(*) AS n FROM compartments WHERE location_id = ?`, [victimBox.id]);
  assert.strictEqual(after.n, before.n, 'victim location must not gain a compartment');
});

// ---------------------------------------------------------------------------
// T30: compartment creation is atomic and picks the next index correctly.
//
// The real defect here was the missing transaction, not the SQL. `compartments`
// carries UNIQUE(location_id, idx), and the handler read MAX(idx) and then
// INSERTed as two independent statements. Two simultaneous "add a page" clicks
// therefore both read the same MAX(idx), both computed the same nextIdx, and
// the loser died on a constraint violation the user saw as a 500.
//
// Honest scope note: the accompanying SQL rewrite (splitting the aggregate read
// from the capacity-template read) is a readability change, NOT a behavior fix.
// The original `SELECT MAX(idx), capacity ... ORDER BY idx DESC LIMIT 1` is
// correct on SQLite, which takes bare columns from the row producing a lone
// MAX(); UNIQUE(location_id, idx) also rules out the ties that would make it
// ambiguous. The capacity-inheritance assertion below therefore documents
// intended behavior and guards against a future rewrite breaking it -- it is
// not evidence of a bug that existed.
// ---------------------------------------------------------------------------
test('F11-TC30', 'T30 compartment creation is atomic and indexes stay unique', async () => {
  const user = await createUser('pr6b-comp-create');
  const box = await createLocation(user.id, 'Compartment Create T30', { capacity: 9 });
  // Non-uniform capacities, highest idx last.
  await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 2, 33)`, [box.id]);
  await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 3, 7)`, [box.id]);

  const created = await api(user.token, `/api/locations/${box.id}/compartments`, { method: 'POST' });
  assert.strictEqual(created.status, 201, `compartment creation must succeed: ${JSON.stringify(created.body)}`);

  const row = await db.get(`SELECT idx, capacity FROM compartments WHERE id = ?`, [created.body.id]);
  assert.strictEqual(row.idx, 4, 'the new compartment must take the next index');
  assert.strictEqual(
    row.capacity, 7,
    'a new page must inherit the capacity of the highest-idx compartment'
  );

  // The transaction guard: N simultaneous adds must produce N compartments with
  // distinct indexes and no constraint failure. Without the transaction the
  // losers fail with SQLITE_CONSTRAINT surfaced as a 500.
  const countBefore = (await db.get(`SELECT COUNT(*) AS n FROM compartments WHERE location_id = ?`, [box.id])).n;
  const concurrent = 4;
  const responses = await Promise.all(
    Array.from({ length: concurrent }, () =>
      api(user.token, `/api/locations/${box.id}/compartments`, { method: 'POST' })
    )
  );
  const failures = responses.filter(r => r.status !== 201);
  assert.strictEqual(
    failures.length, 0,
    `concurrent compartment adds must all succeed, got: ${JSON.stringify(responses.map(r => r.status))}`
  );
  const countAfter = (await db.get(`SELECT COUNT(*) AS n FROM compartments WHERE location_id = ?`, [box.id])).n;
  assert.strictEqual(countAfter, countBefore + concurrent, 'every concurrent add must create exactly one compartment');
  const dupes = await db.all(
    `SELECT idx, COUNT(*) AS n FROM compartments WHERE location_id = ? GROUP BY idx HAVING n > 1`, [box.id]
  );
  assert.deepStrictEqual(dupes, [], 'compartment indexes must remain unique');
});

// ---------------------------------------------------------------------------
// T31 (kills M34): occupancy is SUM(quantity), never COUNT(*).
//
// The two agree whenever every row holds one card, which is why the difference
// stayed invisible. On a stacked row COUNT(*) under-reports, so the capacity
// guard compares against a number smaller than the real contents and lets the
// compartment overfill. This pins the definition directly at the request
// boundary.
// ---------------------------------------------------------------------------
test('F11-TC31', 'T31 capacity counts copies, not rows', async ({ attacker, cardId }) => {
  const loc = await createLocation(attacker.id, 'Occupancy Definition T31', { capacity: 4, compartments: 2, sortOrder: 'custom' });
  const [target, source] = loc.compartmentIds;

  // ONE row holding FOUR copies fills a capacity-4 compartment completely.
  await addEntry(attacker.id, cardId, { locationId: loc.id, compartmentId: target, quantity: 4 });
  assert.strictEqual(await occupancy(target), 4, 'occupancy must count copies');

  // Under COUNT(*) the target looks like it holds 1 of 4 and this would be let in.
  const extra = await addEntry(attacker.id, cardId, { locationId: loc.id, compartmentId: source });
  const response = await api(attacker.token, `/api/collection/${extra}/place`, {
    method: 'POST',
    body: { compartment_id: target, slot: 2 }
  });

  assert.strictEqual(response.status, 400, `a full compartment must refuse another card, got ${response.status}: ${JSON.stringify(response.body)}`);
  assert.strictEqual(await occupancy(target), 4, 'a full compartment must not exceed its capacity');
  const row = await db.get(`SELECT compartment_id FROM collection WHERE id = ?`, [extra]);
  assert.strictEqual(row.compartment_id, source, 'the refused card must stay put');
});

// ---------------------------------------------------------------------------
// T32 (kills M12): bulk move must authorize the destination location itself.
//
// T22 already sends a bulk move at a foreign location, and it is refused -- but
// for the WRONG REASON. With the ownership check deleted the request still
// fails 400, because the placement engine runs as the attacker and finds no
// slot it is willing to use, so the batch aborts with COMPARTMENT_FULL. The
// status is identical, which is exactly why asserting on status alone let this
// mutant survive.
//
// Distinguishing the two requires reading the ERROR the server gives. An
// authorization failure and an out-of-space failure are different answers to
// different questions, and only the first is correct here: the request must be
// rejected because the location is not the caller's, not because it happened to
// be full. A foreign location with plenty of room makes "full" indefensible.
// ---------------------------------------------------------------------------
test('F11-TC32', 'T32 bulk move to a roomy foreign location is refused as unauthorized', async ({ attacker, victim, cardId }) => {
  // Deliberately roomy: 200 free slots. "No space" is not an available excuse.
  const victimLoc = await createLocation(victim.id, 'Victim Roomy T32', { capacity: 200 });
  const attackerLoc = await createLocation(attacker.id, 'Attacker Box T32', { capacity: 20 });
  const ids = [];
  for (let i = 0; i < 2; i++) {
    ids.push(await addEntry(attacker.id, cardId, { locationId: attackerLoc.id, compartmentId: attackerLoc.compartmentId }));
  }
  const victimBefore = await placements(victim.id);

  const response = await api(attacker.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: ids, action: 'move', value: String(victimLoc.id) }
  });

  assert.strictEqual(response.status, 400, `expected rejection, got ${response.status}`);
  assert.strictEqual(
    response.body && response.body.error, 'Invalid location ID',
    `a foreign destination must be refused as unauthorized, not as full -- got: ${JSON.stringify(response.body)}`
  );
  assert.strictEqual(await occupancy(victimLoc.compartmentId), 0, 'nothing may land in the victim container');
  assert.strictEqual(await placements(victim.id), victimBefore, 'victim rows must be untouched');
});

// ---------------------------------------------------------------------------
// T33 (kills M13): bulk move must reserve capacity per entry.
//
// T22's capacity half locks every other container, so a batch that does not fit
// fails because the engine can find no slot anywhere -- the reservation is not
// what refuses it. To make the reservation load-bearing the engine must WANT to
// place a card the guard must then refuse.
//
// The same planner blind spot as T25 creates that situation: `loadCompartments`
// counts only the caller's rows, so a foreign row sitting in the destination is
// invisible to the planner and visible to the guard. The planner offers the
// slot; only the reservation knows the slot is already physically taken.
// ---------------------------------------------------------------------------
test('F11-TC33', 'T33 bulk move refuses a slot the planner cannot see is occupied', async ({ victim, cardId }) => {
  const user = await createUser('pr6b-bulk-cap');
  const source = await createLocation(user.id, 'Bulk Source T33', { capacity: 10 });
  const dest = await createLocation(user.id, 'Bulk Dest T33', { capacity: 2 });
  // The destination looks empty to the planner but physically holds 2 copies.
  await addEntry(victim.id, cardId, { locationId: dest.id, compartmentId: dest.compartmentId, quantity: 2 });
  // No overflow escape hatch.
  await db.run(`UPDATE locations SET locked = 1 WHERE user_id = ? AND id != ?`, [user.id, dest.id]);

  const ids = [];
  for (let i = 0; i < 2; i++) {
    ids.push(await addEntry(user.id, cardId, { locationId: source.id, compartmentId: source.compartmentId }));
  }
  const before = await placements(user.id);

  const response = await api(user.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: ids, action: 'move', value: String(dest.id) }
  });

  assert.strictEqual(response.status, 400, `move into a physically full compartment must be refused, got ${response.status}: ${JSON.stringify(response.body)}`);
  const occupied = await occupancy(dest.compartmentId);
  const cap = (await db.get(`SELECT capacity FROM compartments WHERE id = ?`, [dest.compartmentId])).capacity;
  assert.ok(occupied <= cap, `destination overfilled: ${occupied} copies against capacity ${cap}`);
  assert.strictEqual(occupied, 2, 'the destination must still hold only the pre-existing copies');
  assert.strictEqual(await placements(user.id), before, 'a refused bulk move must write nothing');
});

// ---------------------------------------------------------------------------
// T34 (kills M11): the swap branch of place must authorize the partner's
// compartment.
//
// T20 swaps against a row owned by another USER, which the entry lookup already
// rejects (`WHERE id = ? AND user_id = ?`), so the compartment check never has
// to fire. The check exists for the case the entry lookup cannot catch: a row
// the caller legitimately owns whose compartment_id points somewhere it should
// not -- exactly the corruption the pre-PR cross-user bug produced.
//
// Swapping with such a row copies its placement onto the caller's own row, so
// without the check the corruption spreads instead of being contained.
// ---------------------------------------------------------------------------
test('F11-TC34', 'T34 place refuses to swap placement in from a foreign compartment', async ({ attacker, victim, cardId }) => {
  const victimLoc = await createLocation(victim.id, 'Victim Box T34', { capacity: 8, sortOrder: 'custom' });
  const attackerLoc = await createLocation(attacker.id, 'Attacker Box T34', { capacity: 8, sortOrder: 'custom' });

  const ownRow = await addEntry(attacker.id, cardId, {
    locationId: attackerLoc.id, compartmentId: attackerLoc.compartmentId
  });
  // A row the attacker OWNS that is already (illegally) filed into the victim's
  // compartment -- the residue of the pre-PR substitution bug.
  const contaminated = await addEntry(attacker.id, cardId, {
    locationId: victimLoc.id, compartmentId: victimLoc.compartmentId
  });

  const response = await api(attacker.token, `/api/collection/${ownRow}/place`, {
    method: 'POST',
    body: { compartment_id: attackerLoc.compartmentId, swap_with: contaminated }
  });

  assert.ok(response.status >= 400, `swapping in a foreign placement must be refused, got ${response.status}: ${JSON.stringify(response.body)}`);
  const row = await db.get(`SELECT compartment_id, location_id FROM collection WHERE id = ?`, [ownRow]);
  assert.strictEqual(
    row.compartment_id, attackerLoc.compartmentId,
    'the caller row must not inherit a compartment it does not own'
  );
  assert.strictEqual(row.location_id, attackerLoc.id, 'the caller row must not inherit a foreign location');
});

// ---------------------------------------------------------------------------
// T35 (kills M25, M28): resort and apply-all must re-authorize the compartment
// the planner recommends, not merely trust the id it returns.
//
// `recommendSlot` computes a compartment id from a projection. Both routes then
// write to that id. If the planner can ever be induced to name a compartment
// outside the location being processed, an unchecked write follows it.
//
// Bindarr's documented overflow behavior makes that reachable by design: when a
// location is full the planner deliberately recommends a slot in ANOTHER of the
// user's locations. Re-resolving the id through the ownership helper is what
// keeps that feature confined to containers the caller actually owns, and it is
// also what supplies the true parent location for the row -- a write that
// trusts the recommendation's own location field can produce a row whose
// location and compartment disagree.
// ---------------------------------------------------------------------------
test('F11-TC35', 'T35 overflow placement stays inside the caller own containers', async ({ victim, cardId }) => {
  const user = await createUser('pr6b-overflow');
  // Full source, so the planner must overflow somewhere.
  const full = await createLocation(user.id, 'Overflow Source T35', { capacity: 1 });
  const spare = await createLocation(user.id, 'Overflow Spare T35', { capacity: 10 });
  // A victim container that must never be chosen.
  const victimLoc = await createLocation(victim.id, 'Victim Box T35', { capacity: 50 });

  await addEntry(user.id, cardId, { locationId: full.id, compartmentId: full.compartmentId });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await addEntry(user.id, cardId));

  const response = await api(user.token, `/api/locations/${full.id}/apply-all`, {
    method: 'POST',
    body: { entry_ids: ids }
  });
  assert.ok(response.status < 500, `apply-all should not crash, got ${response.status}: ${JSON.stringify(response.body)}`);

  // Nothing may have been filed into the victim's container.
  assert.strictEqual(await occupancy(victimLoc.compartmentId), 0, 'overflow must never target another user container');

  // Every filed row must sit in a compartment the user owns, and its
  // location_id must be that compartment's REAL parent.
  const mismatched = await db.all(
    `SELECT c.id, c.location_id, c.compartment_id, cp.location_id AS real_parent, l.user_id AS owner
     FROM collection c
     JOIN compartments cp ON c.compartment_id = cp.id
     JOIN locations l ON cp.location_id = l.id
     WHERE c.user_id = ? AND (l.user_id != ? OR c.location_id != cp.location_id)`,
    [user.id, user.id]
  );
  assert.deepStrictEqual(mismatched, [], `rows filed into an unowned or mismatched container: ${JSON.stringify(mismatched)}`);

  // And capacity still holds everywhere.
  const overfilled = await db.all(
    `SELECT cp.id, cp.capacity, COALESCE(SUM(c.quantity), 0) AS occupied
     FROM compartments cp LEFT JOIN collection c ON c.compartment_id = cp.id
     WHERE cp.location_id IN (?, ?) GROUP BY cp.id HAVING occupied > cp.capacity`,
    [full.id, spare.id]
  );
  assert.deepStrictEqual(overfilled, [], `overflow overfilled: ${JSON.stringify(overfilled)}`);
});

// ---------------------------------------------------------------------------
// T36 (kills M40): the reservation must exclude the row being reserved for.
//
// `excludeEntryId` is the false-negative counterpart to the capacity guard.
// Every other capacity case asserts a REFUSAL, so a guard that simply refuses
// more often passes all of them; only a case asserting a legal write succeeds
// can catch over-refusal.
//
// Route choice matters here. The `place` route sidesteps the question by
// skipping the reservation entirely when the card is already in the target
// compartment (`if (entry.compartment_id !== comp.id)`), so it never exercises
// the exclusion. PUT /collection/:id does: it reserves for a row that is
// already sitting in the destination, so without the exclusion the row is
// counted against the space it is already occupying -- double-counted -- and a
// plain edit of a card in a full compartment is refused for no reason.
// ---------------------------------------------------------------------------
test('F11-TC36', 'T36 editing a card in a full compartment is not double-counted', async ({ attacker, cardId }) => {
  const loc = await createLocation(attacker.id, 'Reposition T36', { capacity: 2 });
  const comp = loc.compartmentId;
  const first = await addEntry(attacker.id, cardId, { locationId: loc.id, compartmentId: comp });
  await addEntry(attacker.id, cardId, { locationId: loc.id, compartmentId: comp });
  assert.strictEqual(await occupancy(comp), 2, 'compartment starts exactly full');

  // Re-assert the row's CURRENT compartment while editing it. Net occupancy
  // change is zero: the row is already there. Without excludeEntryId the guard
  // counts this row twice (2 occupied + 1 wanted > 2) and refuses a legal edit.
  const response = await api(attacker.token, `/api/collection/${first}`, {
    method: 'PUT',
    body: { compartment_id: comp, condition: 'Lightly Played' }
  });

  assert.strictEqual(
    response.status, 200,
    `editing a card already inside a full compartment must be allowed: ${JSON.stringify(response.body)}`
  );
  const row = await db.get(`SELECT compartment_id, condition FROM collection WHERE id = ?`, [first]);
  assert.strictEqual(row.compartment_id, comp, 'the card must remain in its compartment');
  assert.strictEqual(row.condition, 'Lightly Played', 'the edit must actually be applied');
  assert.strictEqual(await occupancy(comp), 2, 'occupancy must be unchanged by an in-place edit');
});

// ===========================================================================
// ROUND 5: the guards no mutant had ever named.
//
// Rounds 2-4 each failed the same way: whatever was not deliberately examined
// turned out to be broken. The catalogue only ever grew to cover the routes
// that had already failed a PREVIOUS round, so "uncatalogued" and "untested"
// were the same set, and it was always the next round's defect.
//
// The cases below close that by construction rather than by list: every route
// in collection.js and storage.js, and every guard in each route, now has a
// mutant and a named killer. Several of these are bare `AND user_id = ?`
// clauses -- unglamorous, never discussed in review, and each one a working
// cross-tenant attack when deleted.
// ===========================================================================

// ---------------------------------------------------------------------------
// T37 (kills M45, M50): the single-row DELETE routes must be tenant-scoped.
//
// `DELETE FROM collection WHERE id = ?` with no user_id lets any authenticated
// user destroy any row in the table by guessing an integer. The route reports
// 200 either way, so only the surviving rows distinguish the two versions.
// ---------------------------------------------------------------------------
test('F11-TC37', 'T37 single DELETE cannot destroy another user row or preset', async ({ attacker, victim, cardId }) => {
  const victimEntry = await addEntry(victim.id, cardId);
  const preset = await db.run(
    `INSERT INTO saved_filter_presets (user_id, name, filter_config, sort_config) VALUES (?, 'victim preset', '{}', '[]')`,
    [victim.id]
  );

  const entryResponse = await api(attacker.token, `/api/collection/${victimEntry}`, { method: 'DELETE' });
  assert.strictEqual(entryResponse.status, 404, `foreign entry delete must 404, got ${entryResponse.status}`);
  assert.ok(
    await db.get(`SELECT id FROM collection WHERE id = ?`, [victimEntry]),
    "victim's collection row must still exist after a foreign DELETE"
  );

  const presetResponse = await api(attacker.token, `/api/collection/filters/presets/${preset.lastID}`, { method: 'DELETE' });
  assert.strictEqual(presetResponse.status, 404, `foreign preset delete must 404, got ${presetResponse.status}`);
  assert.ok(
    await db.get(`SELECT id FROM saved_filter_presets WHERE id = ?`, [preset.lastID]),
    "victim's saved filter preset must still exist"
  );
});

// ---------------------------------------------------------------------------
// T38 (kills M46, M62): bulk delete must be tenant-scoped.
//
// The blast radius here is the whole point: `entry_ids` is caller-supplied and
// accepts up to 1000 ids, so an unscoped bulk delete is a one-request wipe of
// another user's collection. `affected` is also asserted, because a route that
// deletes foreign rows while reporting 0 is still a data-loss bug.
// ---------------------------------------------------------------------------
test('F11-TC38', 'T38 bulk delete cannot destroy another user rows', async ({ attacker, victim, cardId }) => {
  const victimEntries = [];
  for (let i = 0; i < 3; i++) victimEntries.push(await addEntry(victim.id, cardId));
  const attackerEntry = await addEntry(attacker.id, cardId);

  const response = await api(attacker.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: [...victimEntries, attackerEntry], action: 'delete' }
  });

  assert.strictEqual(response.status, 200, `bulk delete of own rows should succeed: ${JSON.stringify(response.body)}`);
  assert.strictEqual(response.body.affected, 1, 'only the attacker own row may be counted as deleted');

  const survivors = await db.all(
    `SELECT id FROM collection WHERE id IN (${victimEntries.map(() => '?').join(',')})`,
    victimEntries
  );
  assert.strictEqual(survivors.length, 3, "every one of the victim's rows must survive a foreign bulk delete");
  assert.strictEqual(
    await db.get(`SELECT id FROM collection WHERE id = ?`, [attackerEntry]), undefined,
    'the attacker own row should have been deleted'
  );
});

// ---------------------------------------------------------------------------
// T39 (kills M47, M48, M49, M59, M60): every bulk MUTATE branch is scoped.
//
// The bulk handler has four separate UPDATE branches, each with its own
// `AND user_id = ?`. Testing one proves nothing about the other three -- they
// are independent statements, and this route is exactly where a copy-paste
// omission hides. Each branch is asserted against the victim's stored columns.
//
// The two whitelists are covered here too: `action` is interpolated straight
// into the SQL column position, so losing the whitelist is a column-write
// primitive, and losing the VALUE whitelist writes data the CHECK constraint
// forbids.
// ---------------------------------------------------------------------------
test('F11-TC39', 'T39 every bulk mutate branch is tenant-scoped and whitelisted', async ({ attacker, victim, cardId }) => {
  const victimEntry = await addEntry(victim.id, cardId);
  const before = await db.get(
    `SELECT is_trade, list_type, condition, printing FROM collection WHERE id = ?`, [victimEntry]
  );

  for (const [action, value] of [
    ['trade', undefined],
    ['list_type', 'wishlist'],
    ['condition', 'Damaged'],
    ['printing', 'Promo']
  ]) {
    const response = await api(attacker.token, '/api/collection/bulk', {
      method: 'POST',
      body: { entry_ids: [victimEntry], action, value }
    });
    assert.strictEqual(response.status, 200, `${action} should return 200: ${JSON.stringify(response.body)}`);
    assert.strictEqual(response.body.affected, 0, `${action} must affect zero foreign rows`);
  }

  const after = await db.get(
    `SELECT is_trade, list_type, condition, printing FROM collection WHERE id = ?`, [victimEntry]
  );
  assert.deepStrictEqual(after, before, "no bulk branch may mutate another user's row");

  // Whitelists. An unknown action must be refused outright rather than falling
  // through to another branch.
  //
  // Choosing the probe carefully matters here. With `value: 999` the mutant
  // still returns 400 -- an unknown action falls through to the bulk-MOVE
  // branch, which rejects 999 as an unowned location. Same status, different
  // reason, and the mutant survives. `value: null` instead routes the
  // fall-through into the UNFILE branch, which succeeds: so the observable
  // difference is whether the caller's card gets silently unfiled by an action
  // name the server does not recognise.
  const ownLoc = await createLocation(attacker.id, 'Whitelist Probe T39', { capacity: 4 });
  const ownEntry = await addEntry(attacker.id, cardId, {
    locationId: ownLoc.id, compartmentId: ownLoc.compartmentId
  });
  const badAction = await api(attacker.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: [ownEntry], action: 'user_id', value: null }
  });
  assert.strictEqual(badAction.status, 400, 'an action outside the whitelist must be refused');
  const ownRow = await db.get(`SELECT user_id, condition, compartment_id FROM collection WHERE id = ?`, [ownEntry]);
  assert.strictEqual(ownRow.user_id, attacker.id, 'a non-whitelisted action must not write an arbitrary column');
  assert.strictEqual(
    ownRow.compartment_id, ownLoc.compartmentId,
    'an unrecognised action must not fall through into another branch and unfile the card'
  );

  const badValue = await api(attacker.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: [ownEntry], action: 'condition', value: 'Pristine' }
  });
  assert.strictEqual(badValue.status, 400, 'a condition outside the whitelist must be refused');
  assert.strictEqual(
    (await db.get(`SELECT condition FROM collection WHERE id = ?`, [ownEntry])).condition,
    'Near Mint',
    'a rejected value must not be written'
  );
});

// ---------------------------------------------------------------------------
// T40 (kills M51): purchase_split must only price the caller's own rows.
//
// This branch selects rows, computes a split, and writes purchase_price back.
// Unscoped, it both leaks the victim's row set into the divisor and overwrites
// the victim's purchase prices -- financial data in a collection tracker.
// ---------------------------------------------------------------------------
test('F11-TC40', 'T40 purchase_split cannot reprice another user rows', async ({ attacker, victim, cardId }) => {
  const victimEntry = await addEntry(victim.id, cardId);
  await db.run(`UPDATE collection SET purchase_price = 42.5 WHERE id = ?`, [victimEntry]);

  const response = await api(attacker.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: [victimEntry], action: 'purchase_split', value: { total: 100, method: 'equal' } }
  });

  assert.strictEqual(response.status, 400, 'a split over only foreign rows must find no valid entries');
  assert.strictEqual(
    (await db.get(`SELECT purchase_price FROM collection WHERE id = ?`, [victimEntry])).purchase_price,
    42.5,
    "the victim's purchase price must be untouched"
  );
});

// ---------------------------------------------------------------------------
// T41 (kills M52, M53): add_to_deck must own both the deck and the cards.
//
// Two distinct guards on one branch. Dropping the deck check writes into
// another user's deck; dropping the row scope lets the caller add cards they do
// not own to their OWN deck, which defeats the owned-quantity deck rule.
// ---------------------------------------------------------------------------
test('F11-TC41', 'T41 add_to_deck authorizes both the deck and the source rows', async ({ attacker, victim, cardId }) => {
  const victimDeck = await db.run(`INSERT INTO decks (user_id, name) VALUES (?, 'Victim Deck T41')`, [victim.id]);
  const attackerDeck = await db.run(`INSERT INTO decks (user_id, name) VALUES (?, 'Attacker Deck T41')`, [attacker.id]);
  const victimEntry = await addEntry(victim.id, cardId);
  const attackerEntry = await addEntry(attacker.id, cardId);

  // Guard 1: the deck must belong to the caller.
  const foreignDeck = await api(attacker.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: [attackerEntry], action: 'add_to_deck', value: victimDeck.lastID }
  });
  assert.strictEqual(foreignDeck.status, 404, 'writing into a foreign deck must be refused');
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM deck_cards WHERE deck_id = ?`, [victimDeck.lastID])).n, 0,
    "nothing may be written into the victim's deck"
  );

  // Guard 2: the source rows must belong to the caller. The attacker owns one
  // copy, so feeding in the victim's row as well must not inflate the total
  // past what the deck rules allow them to hold.
  const foreignRows = await api(attacker.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: [attackerEntry, victimEntry], action: 'add_to_deck', value: attackerDeck.lastID }
  });
  assert.strictEqual(foreignRows.status, 200, `own-deck add should respond 200: ${JSON.stringify(foreignRows.body)}`);
  const deckRow = await db.get(
    `SELECT quantity FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [attackerDeck.lastID, cardId]
  );
  assert.strictEqual(
    deckRow ? deckRow.quantity : 0, 1,
    'only the copy the attacker actually owns may reach the deck'
  );
});

// ---------------------------------------------------------------------------
// T42 (kills M55, M56, M57, M58): the single-entry write paths are scoped.
//
// PUT /collection/:id and POST /collection/:id/place both load the entry by id
// and then write it back. Unscoped, the load succeeds on a foreign row and the
// route happily rewrites another user's card -- the entry-ownership half of the
// same bug class T1 covers for the destination half.
//
// The slot bound is included because it shares the route: a slot of 0 or a
// negative slot writes a position the sort engine cannot represent.
// ---------------------------------------------------------------------------
test('F11-TC42', 'T42 update and place cannot rewrite another user entry', async ({ attacker, victim, cardId }) => {
  const victimEntry = await addEntry(victim.id, cardId);
  const before = await placements(victim.id);
  const attackerLoc = await createLocation(attacker.id, 'Attacker Box T42', { sortOrder: 'custom' });

  const update = await api(attacker.token, `/api/collection/${victimEntry}`, {
    method: 'PUT',
    body: { condition: 'Damaged', notes: 'pwned' }
  });
  assert.strictEqual(update.status, 404, `PUT on a foreign entry must 404, got ${update.status}`);
  const row = await db.get(`SELECT condition, notes, user_id FROM collection WHERE id = ?`, [victimEntry]);
  assert.strictEqual(row.condition, 'Near Mint', "the victim's condition must be unchanged");
  assert.ok(!row.notes, "the victim's notes must be unchanged");

  // Placing a foreign card into the attacker's OWN compartment: the destination
  // is legitimately theirs, so only the entry scope can refuse this.
  const place = await api(attacker.token, `/api/collection/${victimEntry}/place`, {
    method: 'POST',
    body: { compartment_id: attackerLoc.compartmentId, slot: 1 }
  });
  assert.ok(place.status >= 400, `placing a foreign card must be refused, got ${place.status}`);
  assert.strictEqual(await placements(victim.id), before, "the victim's placement rows must be byte-identical");
  assert.strictEqual(await occupancy(attackerLoc.compartmentId), 0, 'no foreign card may land in the attacker compartment');

  // Swap partner scope: the attacker's own card must not be swappable with a
  // foreign row, which would write the victim's placement onto it and vice versa.
  const ownEntry = await addEntry(attacker.id, cardId, {
    locationId: attackerLoc.id, compartmentId: attackerLoc.compartmentId
  });
  const swap = await api(attacker.token, `/api/collection/${ownEntry}/place`, {
    method: 'POST',
    body: { compartment_id: attackerLoc.compartmentId, swap_with: victimEntry }
  });
  assert.ok(swap.status >= 400, `swapping with a foreign row must be refused, got ${swap.status}`);
  assert.strictEqual(await placements(victim.id), before, "a refused swap must not move the victim's card");

  // Slot bounds on the same route.
  const badSlot = await api(attacker.token, `/api/collection/${ownEntry}/place`, {
    method: 'POST',
    body: { compartment_id: attackerLoc.compartmentId, slot: 0 }
  });
  assert.strictEqual(badSlot.status, 400, 'slot 0 must be refused');
  assert.strictEqual(
    (await db.get(`SELECT position FROM collection WHERE id = ?`, [ownEntry])).position, 1000,
    'a refused slot must not write a position'
  );
});

// ---------------------------------------------------------------------------
// T43 (kills M54): the bulk-move UNFILE branch is scoped.
//
// Bulk move with no destination unfiles the selected rows. It is a separate
// statement from the filing branch T22/T32 cover, with its own user_id clause,
// and it is the destructive one: it strips placement rather than setting it.
// ---------------------------------------------------------------------------
test('F11-TC43', 'T43 bulk unfile cannot strip placement from another user cards', async ({ attacker, victim, cardId }) => {
  const victimBox = await createLocation(victim.id, 'Victim Box T43', { capacity: 4 });
  const victimEntry = await addEntry(victim.id, cardId, {
    locationId: victimBox.id, compartmentId: victimBox.compartmentId
  });
  const before = await placements(victim.id);

  const response = await api(attacker.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: [victimEntry], action: 'move', value: null }
  });

  assert.strictEqual(response.status, 200, `unfile of an empty own-selection returns 200: ${JSON.stringify(response.body)}`);
  assert.strictEqual(response.body.affected, 0, 'zero foreign rows may be unfiled');
  assert.strictEqual(await placements(victim.id), before, "the victim's cards must stay filed");
  assert.strictEqual(await occupancy(victimBox.compartmentId), 1, 'the victim compartment must still hold its card');
});

// ---------------------------------------------------------------------------
// T44 (kills M63): PUT /locations/:id must authorize the location.
//
// The rule-change branch of this route EVICTS cards. Unscoped, an attacker can
// rewrite another user's container rules and, in the same request, unfile every
// card in it that the new rule rejects.
// ---------------------------------------------------------------------------
test('F11-TC44', 'T44 location PUT cannot rewrite or evict from another user container', async ({ attacker, victim, cardId }) => {
  const victimBox = await createLocation(victim.id, 'Victim Box T44', { capacity: 9 });
  await addEntry(victim.id, cardId, { locationId: victimBox.id, compartmentId: victimBox.compartmentId });
  const before = await placements(victim.id);

  const response = await api(attacker.token, `/api/locations/${victimBox.id}`, {
    method: 'PUT',
    body: { name: 'seized', rule_type: 'specific_sets', rule_config: { sets: ['nonexistent-set'] } }
  });

  assert.strictEqual(response.status, 404, `editing a foreign location must 404, got ${response.status}`);
  const loc = await db.get(`SELECT name, rule_type FROM locations WHERE id = ?`, [victimBox.id]);
  assert.strictEqual(loc.name, 'Victim Box T44', 'the victim location name must be unchanged');
  assert.strictEqual(loc.rule_type, 'any', 'the victim location rule must be unchanged');
  assert.strictEqual(await placements(victim.id), before, 'no victim card may be evicted');
  assert.strictEqual(await occupancy(victimBox.compartmentId), 1, "the victim's card must stay filed");
});

// ---------------------------------------------------------------------------
// T45 (kills M64, M65, M66, M84): the FLAT compartment routes are scoped.
//
// These address a compartment by bare globally-unique id, with no location in
// the URL to constrain them, so `getOwnedCompartment` is the ONLY thing
// standing between a caller and any compartment in the database. Three routes
// share that single helper and each was uncovered.
//
// M84 belongs here too: the updateAll fan-out writes `WHERE location_id = ?`,
// and widening that predicate rewrites capacity across every user's containers.
// ---------------------------------------------------------------------------
test('F11-TC45', 'T45 flat compartment routes cannot address another user compartment', async ({ attacker, victim, cardId }) => {
  const victimBox = await createLocation(victim.id, 'Victim Box T45', { capacity: 4, compartments: 2 });
  const victimComp = victimBox.compartmentId;
  await addEntry(victim.id, cardId, { locationId: victimBox.id, compartmentId: victimComp });
  await db.run(
    `INSERT INTO compartment_assignments (compartment_id, filter_value) VALUES (?, 'victim-rule-t45')`,
    [victimComp]
  );

  // PATCH: capacity/label rewrite.
  const patchResponse = await api(attacker.token, `/api/compartments/${victimComp}`, {
    method: 'PATCH',
    body: { capacity: 999, label: 'seized' }
  });
  assert.strictEqual(patchResponse.status, 404, `flat PATCH on a foreign compartment must 404, got ${patchResponse.status}`);
  const comp = await db.get(`SELECT capacity, label FROM compartments WHERE id = ?`, [victimComp]);
  assert.strictEqual(comp.capacity, 4, 'victim compartment capacity must be unchanged');
  assert.strictEqual(comp.label, null, 'victim compartment label must be unchanged');

  // PUT filters: wipe-and-rewrite of the sorting rules.
  const filterResponse = await api(attacker.token, `/api/compartments/${victimComp}/filters`, {
    method: 'PUT',
    body: { filters: ['attacker-rule'] }
  });
  assert.strictEqual(filterResponse.status, 404, `flat filter PUT must 404, got ${filterResponse.status}`);
  const filters = await db.all(
    `SELECT filter_value FROM compartment_assignments WHERE compartment_id = ?`, [victimComp]
  );
  assert.deepStrictEqual(
    filters.map(f => f.filter_value), ['victim-rule-t45'],
    "the victim's sorting rules must be untouched"
  );

  // DELETE: destroys the compartment and unfiles everything in it.
  const deleteResponse = await api(attacker.token, `/api/compartments/${victimComp}`, { method: 'DELETE' });
  assert.strictEqual(deleteResponse.status, 404, `flat compartment DELETE must 404, got ${deleteResponse.status}`);
  assert.ok(await db.get(`SELECT id FROM compartments WHERE id = ?`, [victimComp]), 'victim compartment must survive');
  assert.strictEqual(await occupancy(victimComp), 1, "the victim's card must stay filed");

  // updateAll fan-out must stay inside the caller's own location.
  const attackerBox = await createLocation(attacker.id, 'Attacker Box T45', { capacity: 4, compartments: 2 });
  const fanout = await api(attacker.token, `/api/compartments/${attackerBox.compartmentId}?updateAll=true`, {
    method: 'PATCH',
    body: { capacity: 7 }
  });
  assert.strictEqual(fanout.status, 200, `own updateAll should succeed: ${JSON.stringify(fanout.body)}`);
  const attackerCaps = await db.all(
    `SELECT capacity FROM compartments WHERE location_id = ? ORDER BY idx`, [attackerBox.id]
  );
  assert.deepStrictEqual(attackerCaps.map(c => c.capacity), [7, 7], 'the fan-out must apply to the caller own location');
  const victimCaps = await db.all(
    `SELECT capacity FROM compartments WHERE location_id = ? ORDER BY idx`, [victimBox.id]
  );
  assert.deepStrictEqual(victimCaps.map(c => c.capacity), [4, 4], 'the fan-out must NOT cross into another user location');
});

// ---------------------------------------------------------------------------
// T46 (kills M67, M68): a location may never be left with zero compartments.
//
// Both DELETE routes carry this guard and neither was covered. A location with
// no compartments is unreachable through the UI: nothing can be filed into it
// and it cannot be repaired, so the cards it held are stranded.
// ---------------------------------------------------------------------------
test('F11-TC46', 'T46 the last compartment of a location cannot be deleted', async ({ attacker, cardId }) => {
  const box = await createLocation(attacker.id, 'Single Comp T46', { capacity: 4, compartments: 1 });
  await addEntry(attacker.id, cardId, { locationId: box.id, compartmentId: box.compartmentId });

  const nested = await api(attacker.token, `/api/locations/${box.id}/compartments/${box.compartmentId}`, { method: 'DELETE' });
  assert.strictEqual(nested.status, 400, `nested delete of the last compartment must be refused, got ${nested.status}`);

  const flat = await api(attacker.token, `/api/compartments/${box.compartmentId}`, { method: 'DELETE' });
  assert.strictEqual(flat.status, 400, `flat delete of the last compartment must be refused, got ${flat.status}`);

  assert.ok(
    await db.get(`SELECT id FROM compartments WHERE id = ?`, [box.compartmentId]),
    'the last compartment must still exist'
  );
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM compartments WHERE location_id = ?`, [box.id])).n, 1,
    'the location must never be left with zero compartments'
  );
  assert.strictEqual(await occupancy(box.compartmentId), 1, 'the card inside must not be unfiled');
});

// ---------------------------------------------------------------------------
// T47 (kills M69, M70, M80, M81): the batch write routes authorize the location.
//
// apply-all and resort are the two highest-blast-radius routes in storage.js:
// resort's first act is to NULL compartment_id for every card in the location.
// Unscoped, naming a foreign location id scrambles or unfiles that user's
// entire container.
//
// M80/M81 are the per-row scopes inside those same handlers. They matter
// independently: even with the location check intact, an unscoped row read
// picks up rows belonging to another user that happen to sit in a shared
// container, and the handler then rewrites their placement.
// ---------------------------------------------------------------------------
test('F11-TC47', 'T47 apply-all and resort cannot touch another user container', async ({ attacker, victim, cardId }) => {
  const victimBox = await createLocation(victim.id, 'Victim Box T47', { capacity: 9, compartments: 2 });
  const victimEntries = [];
  for (let i = 0; i < 3; i++) {
    victimEntries.push(await addEntry(victim.id, cardId, {
      locationId: victimBox.id, compartmentId: victimBox.compartmentId
    }));
  }
  const before = await placements(victim.id);

  const resort = await api(attacker.token, `/api/locations/${victimBox.id}/resort`, { method: 'POST' });
  assert.ok(resort.status >= 400, `resorting a foreign location must be refused, got ${resort.status}`);
  assert.strictEqual(
    await placements(victim.id), before,
    "a refused resort must leave every one of the victim's placements byte-identical"
  );
  assert.strictEqual(await occupancy(victimBox.compartmentId), 3, 'no victim card may be unfiled');

  const applyAll = await api(attacker.token, `/api/locations/${victimBox.id}/apply-all`, {
    method: 'POST',
    body: { entry_ids: victimEntries }
  });
  assert.ok(applyAll.status >= 400, `apply-all on a foreign location must be refused, got ${applyAll.status}`);
  assert.strictEqual(await placements(victim.id), before, 'apply-all must not refile foreign rows');

  // Row scope, with the location check satisfied: the attacker names their OWN
  // location but feeds in the victim's entry ids. Only the per-row user_id
  // clause can refuse this one.
  const attackerBox = await createLocation(attacker.id, 'Attacker Box T47', { capacity: 9 });
  const ownApplyAll = await api(attacker.token, `/api/locations/${attackerBox.id}/apply-all`, {
    method: 'POST',
    body: { entry_ids: victimEntries }
  });
  assert.strictEqual(ownApplyAll.status, 200, `own-location apply-all responds 200: ${JSON.stringify(ownApplyAll.body)}`);
  assert.strictEqual(ownApplyAll.body.filed, 0, 'zero foreign rows may be filed');
  assert.strictEqual(await placements(victim.id), before, "the victim's rows must not be pulled into a foreign container");
  assert.strictEqual(await occupancy(attackerBox.compartmentId), 0, 'no foreign card may land in the attacker container');

  // Resort's row scope, with the location check satisfied. Resort reads every
  // card in the location, unfiles them, and refiles them in sorted order.
  //
  // Both WRITE statements are separately user-scoped, so an unscoped READ does
  // not directly move another user's card. What it does is put that card into
  // the SORT PLAN, where it consumes a slot in the projection -- so the
  // caller's own cards get pushed down to make room for a card that is not
  // theirs and that the resort cannot actually move. The observable symptom is
  // a hole: the caller resorts their box and their first card lands in slot 2.
  //
  // The foreign row is created FIRST so that it sorts ahead of the caller's
  // card on the id tiebreak, which is what makes the displacement visible.
  const sharedBox = await createLocation(attacker.id, 'Shared Resort T47', { capacity: 9, compartments: 1 });
  const foreignCard = await addEntry(victim.id, cardId, {
    locationId: sharedBox.id, compartmentId: sharedBox.compartmentId
  });
  const ownCard = await addEntry(attacker.id, cardId, {
    locationId: sharedBox.id, compartmentId: sharedBox.compartmentId
  });
  const foreignBefore = await db.get(
    `SELECT location_id, compartment_id, position FROM collection WHERE id = ?`, [foreignCard]
  );

  const ownResort = await api(attacker.token, `/api/locations/${sharedBox.id}/resort`, { method: 'POST' });
  assert.strictEqual(ownResort.status, 200, `resorting an owned location should succeed: ${JSON.stringify(ownResort.body)}`);

  const ownAfter = await db.get(
    `SELECT compartment_id, position FROM collection WHERE id = ?`, [ownCard]
  );
  assert.strictEqual(ownAfter.compartment_id, sharedBox.compartmentId, 'the caller own card must be refiled');
  assert.strictEqual(
    ownAfter.position, 1000,
    'the caller own card must take the FIRST slot -- a foreign row must not occupy a place in the sort plan'
  );

  const foreignAfter = await db.get(
    `SELECT location_id, compartment_id, position FROM collection WHERE id = ?`, [foreignCard]
  );
  assert.deepStrictEqual(
    foreignAfter, foreignBefore,
    "another user's row inside the container must be left byte-identical by a resort"
  );
});

// ---------------------------------------------------------------------------
// T48 (kills M75, M76, M77): the nested compartment routes scope every write.
//
// The pair check (T11/T24) proves the route REFUSES a mismatched pair. It says
// nothing about whether the statements that run on a VALID pair are themselves
// scoped -- and those are separate clauses. This is the same shape as the
// original nested-DELETE bug: the pair was checked, but one statement addressed
// the compartment by bare id.
//
// Constructed so the mutants are distinguishable: a second user's row is filed
// into the caller's own compartment (legacy/shared-container data), so an
// unscoped unfile reaches a row the scoped version leaves alone.
// ---------------------------------------------------------------------------
test('F11-TC48', 'T48 nested compartment writes stay scoped to owner and parent', async ({ attacker, victim, cardId }) => {
  const box = await createLocation(attacker.id, 'Nested Scope T48', { capacity: 9, compartments: 2 });
  const [compA, compB] = box.compartmentIds;
  const attackerEntry = await addEntry(attacker.id, cardId, { locationId: box.id, compartmentId: compA });
  // A foreign row physically sitting in the caller's compartment. The scoped
  // UPDATE must leave it alone; an unscoped one unfiles it.
  const victimEntry = await addEntry(victim.id, cardId, { locationId: box.id, compartmentId: compA });

  const deleteResponse = await api(attacker.token, `/api/locations/${box.id}/compartments/${compA}`, { method: 'DELETE' });
  assert.strictEqual(deleteResponse.status, 200, `deleting an owned compartment should succeed: ${JSON.stringify(deleteResponse.body)}`);

  // What distinguishes the scoped UPDATE from an unscoped one is NOT
  // compartment_id: the schema declares
  // `FOREIGN KEY(compartment_id) REFERENCES compartments(id) ON DELETE SET NULL`,
  // so SQLite nulls that column for EVERY row pointing at the dropped
  // compartment, whoever owns it. Verified empirically, not assumed.
  //
  // The handler's UPDATE additionally clears `location_id` and `position`, and
  // the cascade does not touch those. They are therefore the columns that
  // actually witness the user_id scope.
  const own = await db.get(`SELECT location_id, compartment_id, position FROM collection WHERE id = ?`, [attackerEntry]);
  assert.strictEqual(own.compartment_id, null, 'the caller own card must be unfiled by the delete');
  assert.strictEqual(own.location_id, null, "the caller own card must lose its location too");
  assert.strictEqual(own.position, 0, "the caller own card must have its position reset");

  const foreign = await db.get(`SELECT location_id, position FROM collection WHERE id = ?`, [victimEntry]);
  assert.strictEqual(
    foreign.location_id, box.id,
    "another user's row must NOT be unfiled by this caller's compartment delete"
  );
  assert.strictEqual(
    foreign.position, 1000,
    "another user's row must keep its position -- the UPDATE must be user-scoped"
  );
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM compartments WHERE id = ?`, [compA])).n, 0,
    'the compartment itself must be gone'
  );

  // The UPDATE statement on the sibling PUT carries the same parent scope.
  const putResponse = await api(attacker.token, `/api/locations/${box.id}/compartments/${compB}`, {
    method: 'PUT',
    body: { label: 'renamed T48' }
  });
  assert.strictEqual(putResponse.status, 200, `owned nested PUT should succeed: ${JSON.stringify(putResponse.body)}`);
  assert.strictEqual(
    (await db.get(`SELECT label FROM compartments WHERE id = ?`, [compB])).label, 'renamed T48',
    'the edit must actually be applied to the addressed compartment'
  );

  // NOTE ON THE `AND location_id = ?` CLAUSES (M76/M77). The nested UPDATE and
  // DELETE each carry a parent-scope predicate in addition to the pair check
  // above. Those clauses are NOT provable by any behavior test, and the attempt
  // is recorded here so the next reviewer does not repeat it:
  //
  //   - The pair check (requireOwnedCompartmentInLocation) has already refused
  //     every mismatched pair before either statement runs, so on any request
  //     that reaches the write, `compartment.location_id === loc.id` holds.
  //   - Forcing a divergence by reparenting the compartment mid-statement with
  //     a BEFORE UPDATE trigger does not work either: SQLite evaluates the
  //     outer statement's WHERE before firing the trigger, so the write lands
  //     regardless. Verified by reproduction against a live database.
  //
  // They are therefore documented as redundant survivors in mutants.js, not
  // claimed as tested. They stay because they keep the statements safe if the
  // pair check is ever weakened or reordered -- which is exactly the bug this
  // route shipped once already.
});

// ---------------------------------------------------------------------------
// T49: DELETE /locations/:id unfiles the caller's cards.
//
// NOTE ON WHAT THIS CASE CAN AND CANNOT PROVE. The handler's UPDATE clears
// location_id and compartment_id for the caller's rows. Both of those columns
// are ALSO cleared by the schema's foreign keys --
// `REFERENCES locations(id) ON DELETE SET NULL` and the compartment equivalent
// -- which fire for every row regardless of owner. Verified empirically.
//
// So the `AND user_id = ?` on that statement is genuinely shadowed by the
// database: there is no observable difference between the scoped and unscoped
// versions once the DELETE commits. That mutant (M82) is documented as
// equivalent in mutants.js rather than papered over with a test that appears
// to kill it. This case pins the OBSERVABLE contract instead: an owned delete
// unfiles the caller's cards and destroys the container.
// ---------------------------------------------------------------------------
test('F11-TC49', 'T49 location DELETE unfiles the caller own cards and drops the container', async ({ attacker, cardId }) => {
  const box = await createLocation(attacker.id, 'Location Scope T49', { capacity: 9 });
  const attackerEntry = await addEntry(attacker.id, cardId, { locationId: box.id, compartmentId: box.compartmentId });

  const response = await api(attacker.token, `/api/locations/${box.id}`, { method: 'DELETE' });
  assert.strictEqual(response.status, 200, `deleting an owned location should succeed: ${JSON.stringify(response.body)}`);

  const row = await db.get(`SELECT location_id, compartment_id FROM collection WHERE id = ?`, [attackerEntry]);
  assert.strictEqual(row.location_id, null, 'the card must be unfiled, not deleted');
  assert.strictEqual(row.compartment_id, null, 'the card must lose its compartment too');
  assert.ok(
    await db.get(`SELECT id FROM collection WHERE id = ?`, [attackerEntry]),
    'the card itself must survive -- deleting a container must never delete cards'
  );
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM locations WHERE id = ?`, [box.id])).n, 0,
    'the location must be gone'
  );
});

// ---------------------------------------------------------------------------
// T50 (kills M71, M72, M83): POST /locations bounds, atomicity, and uniqueness.
//
// compartmentPlan is caller-supplied and drives an INSERT LOOP. Without the
// bound, one request can be made to insert an unbounded number of rows -- the
// resource-exhaustion twin of the quantity bound on the add path.
//
// The transaction wrapper matters because a location with zero compartments is
// the broken object described in the route comment, and nothing in the UI can
// repair it.
// ---------------------------------------------------------------------------
test('F11-TC50', 'T50 location creation is bounded, unique, and atomic', async ({ attacker }) => {
  const before = (await db.get(`SELECT COUNT(*) AS n FROM compartments`)).n;

  const huge = await api(attacker.token, '/api/locations', {
    method: 'POST',
    body: { name: 'Unbounded T50', type: 'Box', compartmentPlan: { count: 500000, capacity: 4 } }
  });
  assert.strictEqual(huge.status, 413, `an out-of-bounds compartment plan must be refused, got ${huge.status}`);
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM compartments`)).n, before,
    'a refused plan must not insert a single compartment'
  );
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM locations WHERE name = ?`, ['Unbounded T50'])).n, 0,
    'a refused plan must not leave a location behind'
  );

  const first = await api(attacker.token, '/api/locations', {
    method: 'POST',
    body: { name: 'Unique T50', type: 'Box', compartmentPlan: { count: 3, capacity: 4 } }
  });
  assert.strictEqual(first.status, 200, `a valid location should be created: ${JSON.stringify(first.body)}`);
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM compartments WHERE location_id = ?`, [first.body.id])).n, 3,
    'a created location must have exactly its planned compartments -- never zero'
  );

  const duplicate = await api(attacker.token, '/api/locations', {
    method: 'POST',
    body: { name: 'Unique T50', type: 'Box', compartmentPlan: { count: 2, capacity: 4 } }
  });
  assert.strictEqual(duplicate.status, 400, `a duplicate location name must be refused, got ${duplicate.status}`);
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM locations WHERE name = ? AND user_id = ?`, ['Unique T50', attacker.id])).n, 1,
    'a refused duplicate must not create a second location'
  );

  // Atomicity. The bounds and duplicate checks above both fail BEFORE any write,
  // so they say nothing about the transaction wrapper -- a handler with no
  // transaction at all passes them. The wrapper only matters when a failure
  // lands PARTWAY through, so inject one into the compartment insert loop: the
  // location row is already written by then, and without the transaction it
  // commits with a partial set of compartments (or none), which is the broken,
  // unrepairable object the route comment describes.
  await withAbortTrigger(
    'pr6b_abort_loccreate',
    `CREATE TRIGGER pr6b_abort_loccreate BEFORE INSERT ON compartments
     FOR EACH ROW WHEN NEW.idx = 3
     BEGIN SELECT RAISE(ABORT, 'injected compartment insert failure'); END`,
    async () => {
      const response = await api(attacker.token, '/api/locations', {
        method: 'POST',
        body: { name: 'Atomic T50', type: 'Box', compartmentPlan: { count: 4, capacity: 4 } }
      });
      assert.strictEqual(response.status, 500, `injected failure should surface as an error, got ${response.status}`);
    }
  );

  const orphan = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ?`, ['Atomic T50', attacker.id]);
  assert.strictEqual(
    orphan, undefined,
    'a failed compartment insert must roll back the location row too -- never leave a location with a partial compartment set'
  );
});

// ---------------------------------------------------------------------------
// T51 (kills M73, M74): the compartment EDIT routes are atomic.
//
// Both routes perform a capacity guard and then several independent writes. The
// guard being correct is not enough: if the writes are not wrapped, a REFUSED
// shrink can still leave a label or rule_config change committed behind it, so
// the user sees a partially-applied edit they never authorized.
// ---------------------------------------------------------------------------
test('F11-TC51', 'T51 a refused shrink leaves no partial compartment edit', async ({ attacker, cardId }) => {
  // Flat PATCH: capacity guard runs first, label write follows it.
  const flatBox = await createLocation(attacker.id, 'Atomic Patch T51', { capacity: 4 });
  for (let i = 0; i < 3; i++) {
    await addEntry(attacker.id, cardId, { locationId: flatBox.id, compartmentId: flatBox.compartmentId });
  }
  const flat = await api(attacker.token, `/api/compartments/${flatBox.compartmentId}`, {
    method: 'PATCH',
    body: { capacity: 1, label: 'should-not-persist' }
  });
  assert.strictEqual(flat.status, 400, `a shrink below occupancy must be refused, got ${flat.status}`);
  const flatComp = await db.get(`SELECT capacity, label FROM compartments WHERE id = ?`, [flatBox.compartmentId]);
  assert.strictEqual(flatComp.capacity, 4, 'the refused capacity must not be written');
  assert.strictEqual(flatComp.label, null, 'the label write must roll back with the refused shrink');

  // Nested PUT: same shape, plus the assignedFilters rewrite.
  const nestedBox = await createLocation(attacker.id, 'Atomic Put T51', { capacity: 4 });
  for (let i = 0; i < 3; i++) {
    await addEntry(attacker.id, cardId, { locationId: nestedBox.id, compartmentId: nestedBox.compartmentId });
  }
  await db.run(
    `INSERT INTO compartment_assignments (compartment_id, filter_value) VALUES (?, 'original-t51')`,
    [nestedBox.compartmentId]
  );
  const nested = await api(attacker.token, `/api/locations/${nestedBox.id}/compartments/${nestedBox.compartmentId}`, {
    method: 'PUT',
    body: { capacity: 1, label: 'should-not-persist', assignedFilters: ['rewritten-t51'] }
  });
  assert.strictEqual(nested.status, 400, `a nested shrink below occupancy must be refused, got ${nested.status}`);
  const nestedComp = await db.get(`SELECT capacity, label FROM compartments WHERE id = ?`, [nestedBox.compartmentId]);
  assert.strictEqual(nestedComp.capacity, 4, 'the refused capacity must not be written');
  assert.strictEqual(nestedComp.label, null, 'the label write must roll back');
  const nestedFilters = await db.all(
    `SELECT filter_value FROM compartment_assignments WHERE compartment_id = ?`, [nestedBox.compartmentId]
  );
  assert.deepStrictEqual(
    nestedFilters.map(f => f.filter_value), ['original-t51'],
    'the filter rewrite must roll back with the refused shrink'
  );

  // The two refusals above both throw BEFORE any write, so they demonstrate the
  // guard but NOT the transaction: a handler with no wrapper at all passes them.
  // Proving the wrapper needs a failure that lands after an earlier write has
  // already happened. Inject one into the filter-insert step, by which point the
  // capacity/label UPDATE has run.
  const wrapBox = await createLocation(attacker.id, 'Wrapper T51', { capacity: 9 });
  const wrapComp = wrapBox.compartmentId;
  await withAbortTrigger(
    'pr6b_abort_nestedput',
    `CREATE TRIGGER pr6b_abort_nestedput BEFORE INSERT ON compartment_assignments
     FOR EACH ROW WHEN NEW.compartment_id = ${wrapComp} AND NEW.filter_value = 'boom-t51'
     BEGIN SELECT RAISE(ABORT, 'injected filter insert failure'); END`,
    async () => {
      const response = await api(attacker.token, `/api/locations/${wrapBox.id}/compartments/${wrapComp}`, {
        method: 'PUT',
        body: { capacity: 7, label: 'partial-t51', assignedFilters: ['ok-t51', 'boom-t51'] }
      });
      assert.strictEqual(response.status, 500, `injected failure should surface as an error, got ${response.status}`);
    }
  );

  const wrapped = await db.get(`SELECT capacity, label FROM compartments WHERE id = ?`, [wrapComp]);
  assert.strictEqual(wrapped.capacity, 9, 'the capacity UPDATE must roll back with the failed filter insert');
  assert.strictEqual(wrapped.label, null, 'the label UPDATE must roll back with the failed filter insert');
  const wrappedFilters = await db.all(
    `SELECT filter_value FROM compartment_assignments WHERE compartment_id = ?`, [wrapComp]
  );
  assert.deepStrictEqual(wrappedFilters, [], 'no partial filter set may be committed');

  // Same proof for the flat PATCH twin: the eviction loop runs after the
  // capacity/label writes, so failing an eviction must roll those back too.
  const flatWrapBox = await createLocation(attacker.id, 'Flat Wrapper T51', { capacity: 9 });
  const flatWrapComp = flatWrapBox.compartmentId;
  const evictEntry = await addEntry(attacker.id, cardId, {
    locationId: flatWrapBox.id, compartmentId: flatWrapComp
  });
  await withAbortTrigger(
    'pr6b_abort_flatpatch',
    `CREATE TRIGGER pr6b_abort_flatpatch BEFORE UPDATE ON collection
     FOR EACH ROW WHEN OLD.id = ${evictEntry} AND NEW.compartment_id IS NULL
     BEGIN SELECT RAISE(ABORT, 'injected eviction failure'); END`,
    async () => {
      const response = await api(attacker.token, `/api/compartments/${flatWrapComp}`, {
        method: 'PATCH',
        body: { capacity: 5, label: 'partial-flat-t51', rule_config: { rules: [{ field: 'name', operator: 'equals', value: 'no-such-card-t51', action: 'include' }] } }
      });
      assert.strictEqual(response.status, 500, `injected failure should surface as an error, got ${response.status}`);
    }
  );

  const flatWrapped = await db.get(`SELECT capacity, label, rule_config FROM compartments WHERE id = ?`, [flatWrapComp]);
  assert.strictEqual(flatWrapped.capacity, 9, 'the capacity write must roll back with the failed eviction');
  assert.strictEqual(flatWrapped.label, null, 'the label write must roll back with the failed eviction');
  assert.strictEqual(flatWrapped.rule_config, null, 'the rule_config write must roll back with the failed eviction');
  assert.strictEqual(
    (await db.get(`SELECT compartment_id FROM collection WHERE id = ?`, [evictEntry])).compartment_id,
    flatWrapComp,
    'the card must stay filed when the eviction fails'
  );
});

// ---------------------------------------------------------------------------
// T52 (kills M5, M6, M7, M17, M42, M43, M44): POST /api/collection.
//
// This is the route the spec reviewer named: "mutation coverage stopped at the
// routes that failed round 3 and never reached POST /api/collection - and that
// is where the same class of bug is still sitting."
//
// It is the single most-used write path in the app, and it carries the full set
// of guards: destination ownership, compartment ownership, capacity reservation
// for the REQUESTED copy count, the quantity bound, and the transaction that
// makes the reserve-then-insert pair atomic.
// ---------------------------------------------------------------------------
test('F11-TC52', 'T52 the add path authorizes, reserves, and bounds every copy', async ({ attacker, victim, cardId }) => {
  // Guard 1: destination location ownership. A foreign location with plenty of
  // room -- so "full" is not a defensible reason to refuse -- must still be
  // rejected as unauthorized, and nothing may be written into it.
  const victimBox = await createLocation(victim.id, 'Victim Box T52', { capacity: 50 });
  const foreign = await api(attacker.token, '/api/collection', {
    method: 'POST',
    body: { card_id: cardId, location_id: victimBox.id }
  });
  assert.strictEqual(foreign.status, 400, `adding into a foreign location must be refused, got ${foreign.status}`);
  assert.strictEqual(foreign.body.error, 'Invalid location ID', `must fail as unauthorized, not as full: ${JSON.stringify(foreign.body)}`);
  assert.strictEqual(await occupancy(victimBox.compartmentId), 0, 'nothing may be filed into a foreign compartment');

  // Guard 2: the reservation must cover the REQUESTED copy count, not one copy.
  // Capacity 5 with 3 already filed leaves room for 2; asking for 4 must be
  // refused outright rather than filing some and overflowing on the rest.
  const box = await createLocation(attacker.id, 'Add Path T52', { capacity: 5 });
  for (let i = 0; i < 3; i++) {
    const seed = await api(attacker.token, '/api/collection', {
      method: 'POST',
      body: { card_id: cardId, location_id: box.id }
    });
    assert.strictEqual(seed.status, 200, `seed copy ${i + 1} should fit: ${JSON.stringify(seed.body)}`);
  }
  assert.strictEqual(await occupancy(box.compartmentId), 3, 'the seed copies must be filed');

  const partial = await api(attacker.token, '/api/collection', {
    method: 'POST',
    body: { card_id: cardId, location_id: box.id, quantity: 4 }
  });
  assert.strictEqual(partial.status, 400, `a partially-fitting add must be refused: ${JSON.stringify(partial.body)}`);
  assert.strictEqual(
    await occupancy(box.compartmentId), 3,
    'a refused add must leave ZERO partial copies -- this is what the transaction and the full-count reservation buy'
  );

  // The exact remaining room must still be usable: the guard must not
  // over-refuse. This is the direction a "reserve 1" mutant cannot fake.
  const exact = await api(attacker.token, '/api/collection', {
    method: 'POST',
    body: { card_id: cardId, location_id: box.id, quantity: 2 }
  });
  assert.strictEqual(exact.status, 200, `the exactly-fitting add must succeed: ${JSON.stringify(exact.body)}`);
  assert.strictEqual(await occupancy(box.compartmentId), 5, 'the compartment must now be exactly full');

  // Guard 3: the quantity bound. Without it this value drives an insert loop.
  const beforeUnbounded = (await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ?`, [attacker.id])).n;
  const unbounded = await api(attacker.token, '/api/collection', {
    method: 'POST',
    body: { card_id: cardId, quantity: 100000 }
  });
  assert.strictEqual(unbounded.status, 413, `an out-of-bounds quantity must be refused, got ${unbounded.status}`);
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ?`, [attacker.id])).n, beforeUnbounded,
    'a refused quantity must not insert a single row'
  );
});

// ---------------------------------------------------------------------------
// T53 (kills M6 specifically, and M44): the add path resolves placement inside
// the caller's transaction, against a compartment it has authorized.
//
// The placement helper used to read through the module-level `db` while the
// route reserved capacity through `tx`. The slot was therefore chosen against a
// snapshot the transaction never took: the planner could hand out a slot based
// on stale occupancy, and the COUNT(*)-vs-SUM(quantity) split meant it measured
// fullness differently from the guard that had to honour it.
//
// A stacked row makes the two definitions disagree: one row, three cards.
// ---------------------------------------------------------------------------
test('F11-TC53', 'T53 add-path placement measures occupancy in copies, inside the transaction', async ({ attacker, cardId }) => {
  const box = await createLocation(attacker.id, 'Stacked Planner T53', { capacity: 4 });
  // One ROW holding three CARDS. COUNT(*) says 1 (room for 3 more);
  // SUM(quantity) says 3 (room for 1).
  await addEntry(attacker.id, cardId, {
    locationId: box.id, compartmentId: box.compartmentId, quantity: 3
  });
  assert.strictEqual(await occupancy(box.compartmentId), 3, 'the stacked row occupies three slots');

  const fits = await api(attacker.token, '/api/collection', {
    method: 'POST',
    body: { card_id: cardId, location_id: box.id }
  });
  assert.strictEqual(fits.status, 200, `the one genuinely free slot must be usable: ${JSON.stringify(fits.body)}`);
  assert.strictEqual(await occupancy(box.compartmentId), 4, 'the compartment is now exactly full');

  // Under COUNT(*) the planner believes one row means room for three more and
  // hands out a slot in THIS compartment that the SUM(quantity) guard then has
  // to refuse. The correct outcome is that this compartment never exceeds its
  // capacity -- the card either overflows into another of the user's containers
  // (documented behavior, see T35) or is left unfiled. What must never happen
  // is a fifth card in a compartment of capacity four.
  const overflows = await api(attacker.token, '/api/collection', {
    method: 'POST',
    body: { card_id: cardId, location_id: box.id }
  });
  assert.strictEqual(
    await occupancy(box.compartmentId), 4,
    'a full compartment must never exceed capacity, whatever the planner recommended'
  );

  // And no compartment anywhere may be over-committed as a result.
  const overfilled = await db.all(
    `SELECT cp.id, cp.capacity, COALESCE(SUM(c.quantity), 0) AS occupied
     FROM compartments cp LEFT JOIN collection c ON c.compartment_id = cp.id
     GROUP BY cp.id HAVING occupied > cp.capacity`
  );
  assert.deepStrictEqual(overfilled, [], `a compartment was overfilled: ${JSON.stringify(overfilled)}`);

  if (overflows.status === 200 && overflows.body.id) {
    const row = await db.get(`SELECT compartment_id FROM collection WHERE id = ?`, [overflows.body.id]);
    assert.notStrictEqual(
      row.compartment_id, box.compartmentId,
      'the extra copy must not be filed into the compartment that is already full'
    );
  }
});

// ---------------------------------------------------------------------------
// T54 (kills M61, M78, M79): the batch entry points are bounded.
//
// Every one of these takes a caller-supplied array and loops over it doing
// per-item database work. Unbounded, a single request is an availability
// attack; the PR already added the bounds, but nothing proved they were live.
// ---------------------------------------------------------------------------
test('F11-TC54', 'T54 every batch entry point enforces its request bound', async ({ attacker, cardId }) => {
  const box = await createLocation(attacker.id, 'Bounds T54', { capacity: 9 });
  const tooMany = Array.from({ length: 1001 }, (_, i) => i + 1);

  const recommendBatch = await api(attacker.token, `/api/locations/${box.id}/recommend-batch`, {
    method: 'POST',
    body: { entry_ids: tooMany }
  });
  assert.strictEqual(recommendBatch.status, 413, `recommend-batch must enforce its bound, got ${recommendBatch.status}`);

  const applyAll = await api(attacker.token, `/api/locations/${box.id}/apply-all`, {
    method: 'POST',
    body: { entry_ids: tooMany }
  });
  assert.strictEqual(applyAll.status, 413, `apply-all must enforce its bound, got ${applyAll.status}`);
  assert.strictEqual(await occupancy(box.compartmentId), 0, 'a refused batch must file nothing');

  // bulk-add bounds the EXPANSION (cards x quantity), not just the list length:
  // 250 cards at quantity 100 is 25000 inserts from a request that passes both
  // individual limits.
  const before = (await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ?`, [attacker.id])).n;
  const bulkAdd = await api(attacker.token, '/api/collection/bulk-add', {
    method: 'POST',
    body: { card_ids: Array.from({ length: 200 }, (_, i) => `t54-card-${i}`), quantity: 100 }
  });
  assert.strictEqual(bulkAdd.status, 413, `bulk-add must bound the expanded operation count, got ${bulkAdd.status}`);
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ?`, [attacker.id])).n, before,
    'a refused bulk-add must insert nothing'
  );

  // POST /collection/bulk sanitises entry_ids: bounded length AND unique
  // positive integers. Both halves matter. The length bound is the availability
  // guard; the integer check is what keeps a caller from putting arbitrary
  // values into the `id IN (...)` parameter list, where SQLite's type affinity
  // decides what they mean.
  const bulkTooMany = await api(attacker.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: tooMany, action: 'delete' }
  });
  assert.strictEqual(bulkTooMany.status, 413, `bulk must enforce its entry_ids bound, got ${bulkTooMany.status}`);

  const ownEntry = await addEntry(attacker.id, cardId);
  const bulkBadIds = await api(attacker.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: [String(ownEntry), -1, null], action: 'delete' }
  });
  assert.strictEqual(bulkBadIds.status, 400, `bulk must reject non-integer entry_ids, got ${bulkBadIds.status}`);
  assert.ok(
    await db.get(`SELECT id FROM collection WHERE id = ?`, [ownEntry]),
    'a rejected bulk request must delete nothing at all'
  );
});

async function main() {
  await db.initDb();
  const attacker = await createUser('pr6b-attacker');
  const victim = await createUser('pr6b-victim');
  const cardId = 'pr6b-card';
  await db.run(
    `INSERT INTO card_cache (id, oracle_id, name, set_name, number) VALUES (?, ?, ?, ?, ?)`,
    [cardId, 'pr6b-oracle', 'Invariant Bolt', 'Test Set', '1']
  );

  const app = express();
  app.use(express.json());
  app.use('/api', collectionRoutes);
  app.use('/api', storageRoutes);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const context = { attacker, victim, cardId };
  let failed = 0;
  try {
    for (const { id, name, fn } of tests) {
      try {
        await fn(context);
        console.log(`PASS: ${id} ${name}`);
      } catch (error) {
        failed++;
        console.error(`FAIL: ${id} ${name} - ${error.message}`);
      }
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await db.close().catch(() => {});
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* already removed */ }
    }
  }
  if (failed > 0) throw new Error(`${failed} invariant test(s) failed`);
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error.message);
  process.exit(1);
});
