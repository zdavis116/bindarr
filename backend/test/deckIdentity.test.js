// PR 6C: exact-only deck identity, reservation, and checkout allocation.
//
// These are BEHAVIOR tests asserting on DATABASE STATE, not HTTP status codes.
// A route can return 200 and still have written the wrong rows; the rows are
// what the user's physical binder has to agree with, so the rows are what we
// assert on.
//
// Everything runs against a real temporary SQLite file through the real
// db.initDb() schema. No network, no mocks of the database: the invariants
// under test are SQL-level invariants, and a fake client would let a broken
// query pass.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-pr6c-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';

const db = require('../src/db');
const deckIdentity = require('../src/utils/deckIdentity');
const deckRoutes = require('../src/routes/decks');

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

// Two distinct PRINTINGS of one Oracle card. This pair is the whole point of
// the PR: they share an oracle_id and must never substitute for each other.
async function seedCards() {
  const printings = [
    { id: 'bolt-lea', oracle: 'oracle-bolt', name: 'Lightning Bolt', set: 'Limited Edition Alpha', num: '161' },
    { id: 'bolt-2x2', oracle: 'oracle-bolt', name: 'Lightning Bolt', set: 'Double Masters 2022', num: '117' },
    { id: 'solring-cmr', oracle: 'oracle-solring', name: 'Sol Ring', set: 'Commander Legends', num: '472' },
    // Dedicated printings for T9/T10. The suite shares one database, so tests
    // that assert on scarcity ("exactly one copy in the world") must not reuse
    // a variant another test has already reserved -- otherwise the assertion
    // silently measures the other test's leftovers.
    { id: 'ponder-t9', oracle: 'oracle-ponder', name: 'Ponder', set: 'Lorwyn', num: '75' },
    { id: 'ponder-m12', oracle: 'oracle-ponder', name: 'Ponder', set: 'Magic 2012', num: '66' },
    { id: 'brainstorm-t10', oracle: 'oracle-brainstorm', name: 'Brainstorm', set: 'Ice Age', num: '65' },
    // Dedicated printings for the STACKED-ROW tests (T11/T12). These must not
    // be touched by any other test: the whole point is that exactly one
    // collection row exists for them, carrying several physical copies.
    { id: 'swamp-t11', oracle: 'oracle-swamp', name: 'Swamp', set: 'Unlimited Edition', num: '299' },
    { id: 'island-t12', oracle: 'oracle-island', name: 'Island', set: 'Beta', num: '288' }
  ];
  for (const p of printings) {
    await db.run(
      `INSERT OR IGNORE INTO card_cache (id, oracle_id, name, set_name, number, finishes, supertype, subtypes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.id, p.oracle, p.name, p.set, p.num, JSON.stringify(['nonfoil', 'foil']), 'Artifact', '[]']
    );
  }
}

async function addOwnedCopy(userId, cardId, { finish = 'nonfoil', quantity = 1 } = {}) {
  const row = await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, finish, list_type, position)
     VALUES (?, ?, ?, ?, 'collection', 1000)`,
    [cardId, userId, quantity, finish]
  );
  return row.lastID;
}

async function createDeck(userId, name, { status = 'active' } = {}) {
  const row = await db.run(
    `INSERT INTO decks (user_id, name, status) VALUES (?, ?, ?)`,
    [userId, name, status]
  );
  return row.lastID;
}

async function addRequirement(deckId, { oracleId, cardId, finish = 'nonfoil', board = 'mainboard', quantity = 1 }) {
  const row = await db.run(
    `INSERT INTO deck_cards (deck_id, oracle_id, desired_card_id, desired_finish, board, quantity)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [deckId, oracleId, cardId, finish, board, quantity]
  );
  return row.lastID;
}

const tests = [];
function test(id, name, fn) { tests.push({ id, name, fn }); }

// ---------------------------------------------------------------------------
// T1: the schema itself enforces exact identity.
//
// This is a schema test rather than a helper test on purpose. If the columns
// are nullable, every downstream helper has to defensively handle a NULL
// desired printing, and one that forgets silently reintroduces "flexible"
// matching. Making the database refuse the row means no code path can create
// an ambiguous requirement in the first place.
// ---------------------------------------------------------------------------
test('F12-TC1', 'T1 deck_cards requires an exact printing and finish', async ({ owner }) => {
  const deckId = await createDeck(owner.id, 'Schema Deck T1');

  await assert.rejects(
    db.run(
      `INSERT INTO deck_cards (deck_id, oracle_id, desired_finish, board, quantity)
       VALUES (?, 'oracle-bolt', 'nonfoil', 'mainboard', 1)`,
      [deckId]
    ),
    /NOT NULL|constraint/i,
    'a requirement without a desired printing must be refused by the database'
  );

  await assert.rejects(
    db.run(
      `INSERT INTO deck_cards (deck_id, oracle_id, desired_card_id, board, quantity)
       VALUES (?, 'oracle-bolt', 'bolt-lea', 'mainboard', 1)`,
      [deckId]
    ),
    /NOT NULL|constraint/i,
    'a requirement without a canonical finish must be refused by the database'
  );

  // Finish is a closed set. An open TEXT column lets 'Foil', 'foiled', and
  // 'FOIL' all coexist, and every one of them is a requirement that can never
  // be satisfied because no collection row will ever equal it.
  await assert.rejects(
    db.run(
      `INSERT INTO deck_cards (deck_id, oracle_id, desired_card_id, desired_finish, board, quantity)
       VALUES (?, 'oracle-bolt', 'bolt-lea', 'Foil', 'mainboard', 1)`,
      [deckId]
    ),
    /constraint/i,
    'finish must be constrained to the canonical MTG values'
  );

  // Same Oracle card, two different desired printings: legal, and the reason
  // the unique key includes desired_card_id.
  await addRequirement(deckId, { oracleId: 'oracle-bolt', cardId: 'bolt-lea' });
  await addRequirement(deckId, { oracleId: 'oracle-bolt', cardId: 'bolt-2x2' });
  const rows = await db.all(`SELECT desired_card_id FROM deck_cards WHERE deck_id = ? ORDER BY id`, [deckId]);
  assert.deepStrictEqual(
    rows.map(r => r.desired_card_id), ['bolt-lea', 'bolt-2x2'],
    'two printings of one Oracle card are distinct requirements'
  );

  // But the same variant twice in the same board is a duplicate, not a second
  // requirement -- quantity is the field for "two copies".
  await assert.rejects(
    addRequirement(deckId, { oracleId: 'oracle-bolt', cardId: 'bolt-lea' }),
    /UNIQUE|constraint/i,
    'the same variant may not appear twice in one board'
  );
});

// ---------------------------------------------------------------------------
// T2: ownership counts the exact printing AND finish, nothing else.
//
// The failure this prevents is the most user-visible one in the whole feature:
// the app says "you own it", the user goes to the binder, and the card there is
// the wrong printing or the wrong finish for the deck they are building.
// ---------------------------------------------------------------------------
test('F12-TC2', 'T2 only the exact printing and finish satisfy a requirement', async ({ owner }) => {
  // One Alpha nonfoil (the desired variant), one 2x2 nonfoil (wrong printing),
  // one Alpha foil (right printing, wrong finish).
  await addOwnedCopy(owner.id, 'bolt-lea', { finish: 'nonfoil' });
  await addOwnedCopy(owner.id, 'bolt-2x2', { finish: 'nonfoil' });
  await addOwnedCopy(owner.id, 'bolt-lea', { finish: 'foil' });

  const owned = await deckIdentity.ownedQuantity(db, owner.id, {
    desired_card_id: 'bolt-lea',
    desired_finish: 'nonfoil'
  });

  assert.strictEqual(
    owned, 1,
    'only the Alpha nonfoil counts: the 2x2 printing and the Alpha foil are different physical objects'
  );

  const foilOwned = await deckIdentity.ownedQuantity(db, owner.id, {
    desired_card_id: 'bolt-lea',
    desired_finish: 'foil'
  });
  assert.strictEqual(foilOwned, 1, 'the foil requirement is satisfied only by the foil copy');

  // Language and condition are explicitly NOT part of matching. A Heavily
  // Played copy of the right printing still satisfies the requirement.
  await db.run(`UPDATE collection SET condition = 'Heavily Played' WHERE card_id = 'bolt-lea' AND finish = 'nonfoil'`);
  assert.strictEqual(
    await deckIdentity.ownedQuantity(db, owner.id, { desired_card_id: 'bolt-lea', desired_finish: 'nonfoil' }),
    1,
    'condition does not affect deck matching'
  );
});

// ---------------------------------------------------------------------------
// T3: saving an ACTIVE deck reserves immediately; 'considering' does not.
//
// This is requirement 2, and it is the difference between the app being useful
// and being a lie. If reservation waited until checkout, the user could build
// three decks that each "own" the same Sol Ring, and only discover the conflict
// standing at the table with two decks that cannot both be legal.
// ---------------------------------------------------------------------------
test('F12-TC3', 'T3 active decks reserve on save, considering decks do not', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'solring-cmr', { finish: 'nonfoil' });

  const activeDeck = await createDeck(owner.id, 'Active T3', { status: 'active' });
  const activeReq = await addRequirement(activeDeck, {
    oracleId: 'oracle-solring', cardId: 'solring-cmr', quantity: 1
  });

  const activeView = await deckIdentity.availabilityForDeck(db, activeDeck, owner.id);
  const activeEntry = activeView.entries.find(e => e.id === activeReq);
  assert.strictEqual(activeEntry.reserves, true, 'an active deck reserves');
  assert.strictEqual(activeEntry.quantity_reserved, 1, 'the owned copy is reserved immediately on save');

  // A 'considering' DECK is planning only. Its requirements must leave the
  // inventory untouched for real decks.
  const consideringDeck = await createDeck(owner.id, 'Considering T3', { status: 'considering' });
  const consideringReq = await addRequirement(consideringDeck, {
    oracleId: 'oracle-solring', cardId: 'solring-cmr', quantity: 1
  });
  const consideringView = await deckIdentity.availabilityForDeck(db, consideringDeck, owner.id);
  const consideringEntry = consideringView.entries.find(e => e.id === consideringReq);
  assert.strictEqual(consideringEntry.reserves, false, 'a considering deck reserves nothing');
  assert.strictEqual(consideringEntry.quantity_reserved, 0, 'a considering deck claims no physical copy');

  // ...and crucially, it must not appear as competition to anyone else.
  const competing = await deckIdentity.requirementsForVariant(db, owner.id, {
    desired_card_id: 'solring-cmr', desired_finish: 'nonfoil'
  });
  assert.deepStrictEqual(
    competing.map(r => r.id), [activeReq],
    'only the active deck competes for the physical copy'
  );

  // The same rule applies at ENTRY level: a considering BOARD inside an ACTIVE
  // deck is still a maybe and must not consume inventory.
  const consideringBoardReq = await addRequirement(activeDeck, {
    oracleId: 'oracle-solring', cardId: 'solring-cmr', quantity: 1, board: 'considering'
  });
  const reView = await deckIdentity.availabilityForDeck(db, activeDeck, owner.id);
  const boardEntry = reView.entries.find(e => e.id === consideringBoardReq);
  assert.strictEqual(boardEntry.quantity_reserved, 0, 'a considering board entry reserves nothing');
  assert.strictEqual(
    reView.entries.find(e => e.id === activeReq).quantity_reserved, 1,
    "the mainboard requirement's reservation is unaffected by a considering entry"
  );
});

// ---------------------------------------------------------------------------
// T4: reservation priority is deck_cards.id ascending, and two decks wanting
// the same variant need two physical copies.
//
// Requirements 3 and 4 together. The property that matters is that priority is
// STABLE: whichever deck claimed the copy first keeps it, and editing an
// unrelated deck cannot silently take a card out of it.
// ---------------------------------------------------------------------------
test('F12-TC4', 'T4 reservation priority is deck_cards.id ascending and copies are not shared', async ({ owner }) => {
  // Exactly ONE physical copy in the world.
  await addOwnedCopy(owner.id, 'bolt-2x2', { finish: 'foil' });

  const identity = { desired_card_id: 'bolt-2x2', desired_finish: 'foil' };
  const first = await createDeck(owner.id, 'First T4');
  const second = await createDeck(owner.id, 'Second T4');

  const firstReq = await addRequirement(first, {
    oracleId: 'oracle-bolt', cardId: 'bolt-2x2', finish: 'foil', quantity: 1
  });
  const secondReq = await addRequirement(second, {
    oracleId: 'oracle-bolt', cardId: 'bolt-2x2', finish: 'foil', quantity: 1
  });
  assert.ok(secondReq > firstReq, 'the later requirement has the higher id');

  const firstEntry = (await deckIdentity.availabilityForDeck(db, first, owner.id))
    .entries.find(e => e.id === firstReq);
  const secondEntry = (await deckIdentity.availabilityForDeck(db, second, owner.id))
    .entries.find(e => e.id === secondReq);

  assert.strictEqual(firstEntry.quantity_reserved, 1, 'the lower deck_cards.id wins the copy');
  assert.strictEqual(firstEntry.quantity_missing, 0, 'the winning deck is not missing anything');

  assert.strictEqual(secondEntry.quantity_owned, 1, 'the user does own one such card');
  assert.strictEqual(secondEntry.quantity_allocated_elsewhere, 1, 'but it is already claimed');
  assert.strictEqual(secondEntry.quantity_reserved, 0, 'no sharing: the second deck reserves nothing');
  assert.strictEqual(
    secondEntry.quantity_missing, 1,
    'two decks needing the same variant require two physical copies'
  );

  // Buying a second copy resolves it without touching the first deck's claim.
  await addOwnedCopy(owner.id, 'bolt-2x2', { finish: 'foil' });
  const secondAfter = (await deckIdentity.availabilityForDeck(db, second, owner.id))
    .entries.find(e => e.id === secondReq);
  assert.strictEqual(secondAfter.quantity_missing, 0, 'a second copy satisfies the second deck');
  const firstAfter = (await deckIdentity.availabilityForDeck(db, first, owner.id))
    .entries.find(e => e.id === firstReq);
  assert.strictEqual(firstAfter.quantity_reserved, 1, "the first deck's claim is undisturbed");

  // Priority must not be derived from anything mutable. Renaming the first deck
  // (a pure display change) must not move a physical card between decks.
  await db.run(`UPDATE decks SET name = 'zzz renamed' WHERE id = ?`, [first]);
  const afterRename = await deckIdentity.reservedByHigherPriority(db, owner.id, identity, secondReq);
  assert.strictEqual(afterRename, 1, 'priority survives unrelated edits: it is id-based, not name-based');
});

// ---------------------------------------------------------------------------
// T5: unowned requirements still save, and surface as a WARNING.
//
// Requirement 5. Refusing to save an unowned card would make the deck builder
// useless for its main job -- planning a deck you have not finished buying.
// The user is told what is missing; they are not blocked.
// ---------------------------------------------------------------------------
test('F12-TC5', 'T5 unowned requirements save and report a warning, not an error', async ({ owner }) => {
  const deckId = await createDeck(owner.id, 'Unowned T5');

  // 'bolt-lea' foil: the user owns none of this variant at all.
  const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'bolt-lea', desired_finish: 'etched', quantity: 4 }
  });

  assert.strictEqual(response.status, 200, `saving an unowned requirement must succeed: ${JSON.stringify(response.body)}`);

  // The DATABASE is what proves it saved -- a 200 with no row would pass a
  // status-code-only assertion.
  const saved = await db.get(
    `SELECT quantity, desired_finish FROM deck_cards WHERE deck_id = ? AND desired_card_id = 'bolt-lea'`,
    [deckId]
  );
  assert.ok(saved, 'the requirement row must exist');
  assert.strictEqual(saved.quantity, 4, 'the full requested quantity is saved');
  assert.strictEqual(saved.desired_finish, 'etched', 'the exact chosen finish is saved');

  assert.ok(
    Array.isArray(response.body.warnings) && response.body.warnings.length > 0,
    'the response must carry a warning about the missing copies'
  );
  assert.ok(
    response.body.warnings.some(w => /own|missing/i.test(w.message || w)),
    `a warning should explain the ownership shortfall: ${JSON.stringify(response.body.warnings)}`
  );

  const view = await deckIdentity.availabilityForDeck(db, deckId, owner.id);
  const entry = view.entries[0];
  assert.strictEqual(entry.quantity_owned, 0, 'owned is zero');
  assert.strictEqual(entry.quantity_missing, 4, 'missing equals required');
});

// ---------------------------------------------------------------------------
// T6: checkout allocation is STABLE once made.
//
// Requirement 6, and the reason allocation is a stored table rather than a
// derived query. The user has physically pulled a specific sleeve out of a
// specific binder pocket. If the app later decides a *different* copy is the
// one in the deck, there is no way for the user to reconcile the app against
// reality -- the cards are identical to look at, and only the app claimed to
// know which was which.
//
// The adversarial part is what happens AFTER checkout: adding copies, adding a
// competing deck, and re-reading the locator must all leave the recorded
// allocation byte-for-byte unchanged.
// ---------------------------------------------------------------------------
test('F12-TC6', 'T6 checkout allocation does not silently move', async ({ owner }) => {
  const entryId = await addOwnedCopy(owner.id, 'solring-cmr', { finish: 'etched' });
  const deckId = await createDeck(owner.id, 'Checkout T6');
  const reqId = await addRequirement(deckId, {
    oracleId: 'oracle-solring', cardId: 'solring-cmr', finish: 'etched', quantity: 1
  });

  const checkout = await api(owner.token, `/api/decks/${deckId}/checkout`, { method: 'PUT' });
  assert.strictEqual(checkout.status, 200, `checkout should succeed: ${JSON.stringify(checkout.body)}`);

  const allocation = await db.all(
    `SELECT collection_entry_id, quantity FROM deck_card_allocations WHERE deck_card_id = ?`, [reqId]
  );
  assert.deepStrictEqual(
    allocation, [{ collection_entry_id: entryId, quantity: 1 }],
    'checkout must record exactly which physical row was pulled'
  );

  // Now perturb the world in the specific way that would tempt a DERIVED
  // allocation to change its mind: add a copy that outranks the allocated one
  // under the selection ordering. selectPhysicalCopies prefers copies with a
  // known location, so a filed copy sorts ahead of the unfiled one that was
  // actually pulled. If the locator re-derived instead of reading the stored
  // allocation, it would now name this new card -- a card still sitting in the
  // binder -- as the one inside the deck box.
  const locationRow = await db.run(
    `INSERT INTO locations (name, type, user_id) VALUES ('T6 Binder', 'Binder', ?)`, [owner.id]
  );
  const compartmentRow = await db.run(
    `INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 9)`, [locationRow.lastID]
  );
  const decoyCopy = await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, finish, list_type, location_id, compartment_id, position)
     VALUES ('solring-cmr', ?, 1, 'etched', 'collection', ?, ?, 1000)`,
    [owner.id, locationRow.lastID, compartmentRow.lastID]
  );
  assert.ok(decoyCopy.lastID !== entryId, 'precondition: the decoy is a different physical row');

  // Sanity-check the trap actually springs: a fresh derivation DOES prefer the
  // decoy. This is what makes the assertion below meaningful rather than
  // accidentally true.
  const rederived = await deckIdentity.selectPhysicalCopies(db, owner.id, {
    desired_card_id: 'solring-cmr', desired_finish: 'etched', quantity: 1
  });
  assert.strictEqual(
    rederived.picks[0].entry_id, decoyCopy.lastID,
    'precondition: re-deriving would pick the decoy, so reading the stored allocation is observable'
  );

  const rivalDeck = await createDeck(owner.id, 'Rival T6');
  await addRequirement(rivalDeck, {
    oracleId: 'oracle-solring', cardId: 'solring-cmr', finish: 'etched', quantity: 1
  });
  await api(owner.token, `/api/decks/${deckId}/locations`);

  const after = await db.all(
    `SELECT collection_entry_id, quantity FROM deck_card_allocations WHERE deck_card_id = ?`, [reqId]
  );
  assert.deepStrictEqual(
    after, [{ collection_entry_id: entryId, quantity: 1 }],
    'the allocation must still name the SAME physical copy after inventory and deck changes'
  );

  // The locator must report the pulled copy, not recompute a new answer.
  const locations = await api(owner.token, `/api/decks/${deckId}/locations`);
  const reported = locations.body.find(r => r.deck_card_id === reqId);
  assert.deepStrictEqual(
    reported.locations.map(l => l.entry_id), [entryId],
    'the locator for a checked-out deck reads the stored allocation, not a fresh derivation'
  );

  // A rival deck that checks out afterwards must take the OTHER copy -- copies
  // already physically pulled are not on the table.
  const rivalCheckout = await api(owner.token, `/api/decks/${rivalDeck}/checkout`, { method: 'PUT' });
  assert.strictEqual(rivalCheckout.status, 200, `rival checkout should succeed: ${JSON.stringify(rivalCheckout.body)}`);
  const rivalAllocation = await db.get(`
    SELECT a.collection_entry_id FROM deck_card_allocations a
    JOIN deck_cards dc ON a.deck_card_id = dc.id WHERE dc.deck_id = ?
  `, [rivalDeck]);
  assert.strictEqual(
    rivalAllocation.collection_entry_id, decoyCopy.lastID,
    'a second checked-out deck must be given a different physical copy'
  );

  // Returning releases the physical claim but NOT the reservation: an active
  // deck still wants its cards even when it is sitting in a binder.
  await api(owner.token, `/api/decks/${deckId}/return`, { method: 'PUT' });
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM deck_card_allocations WHERE deck_card_id = ?`, [reqId])).n, 0,
    'returning a deck releases its physical allocation'
  );
  const stillReserved = (await deckIdentity.availabilityForDeck(db, deckId, owner.id))
    .entries.find(e => e.id === reqId);
  assert.strictEqual(
    stillReserved.quantity_reserved, 1,
    'an active deck keeps its reservation after being returned to storage'
  );
});

// ---------------------------------------------------------------------------
// T7: multi-step deck mutations roll back completely on failure.
//
// Checkout is the worst case: it writes one allocation row per requirement and
// then flips the deck. A failure partway through without a transaction leaves
// some copies marked as pulled for a deck that is not checked out -- inventory
// that looks busy, belongs to nothing, and no screen in the app can explain.
//
// The failure is induced with a real constraint violation rather than a stubbed
// throw, so this exercises the same rollback path a genuine bug would hit.
// ---------------------------------------------------------------------------
test('F12-TC7', 'T7 a failed multi-step deck mutation leaves no partial state', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'bolt-lea', { finish: 'foil' });
  await addOwnedCopy(owner.id, 'bolt-2x2', { finish: 'etched' });

  const deckId = await createDeck(owner.id, 'Rollback T7');
  const firstReq = await addRequirement(deckId, {
    oracleId: 'oracle-bolt', cardId: 'bolt-lea', finish: 'foil', quantity: 1
  });
  const secondReq = await addRequirement(deckId, {
    oracleId: 'oracle-bolt', cardId: 'bolt-2x2', finish: 'etched', quantity: 1
  });

  // Pre-insert a conflicting allocation for the SECOND requirement. Checkout
  // walks requirements in id order, so it will write the first allocation
  // successfully and then collide on the second's UNIQUE constraint -- a
  // genuine mid-transaction failure.
  const conflictEntry = await db.get(
    `SELECT id FROM collection WHERE user_id = ? AND card_id = 'bolt-2x2' AND finish = 'etched'`,
    [owner.id]
  );
  await db.run(
    `INSERT INTO deck_card_allocations (deck_card_id, collection_entry_id, quantity) VALUES (?, ?, 1)`,
    [secondReq, conflictEntry.id]
  );

  const before = await db.get(
    `SELECT COUNT(*) AS n FROM deck_card_allocations WHERE deck_card_id IN (?, ?)`,
    [firstReq, secondReq]
  );
  assert.strictEqual(before.n, 1, 'precondition: exactly the planted allocation exists');

  const checkout = await api(owner.token, `/api/decks/${deckId}/checkout`, { method: 'PUT' });
  assert.ok(checkout.status >= 400, `the conflicting checkout must fail, got ${checkout.status}`);

  // Everything the failed transaction touched must be back where it started.
  const after = await db.all(
    `SELECT deck_card_id, collection_entry_id FROM deck_card_allocations
     WHERE deck_card_id IN (?, ?) ORDER BY deck_card_id`,
    [firstReq, secondReq]
  );
  assert.deepStrictEqual(
    after, [{ deck_card_id: secondReq, collection_entry_id: conflictEntry.id }],
    'the allocation written before the failure must be rolled back, leaving only the planted row'
  );

  const deck = await db.get(`SELECT checked_out, checked_out_at FROM decks WHERE id = ?`, [deckId]);
  assert.strictEqual(deck.checked_out, 0, 'a failed checkout must not mark the deck as checked out');
  assert.strictEqual(deck.checked_out_at, null, 'nor stamp a checkout time');

  const flags = await db.all(
    `SELECT checked_out FROM deck_cards WHERE deck_id = ? ORDER BY id`, [deckId]
  );
  assert.deepStrictEqual(
    flags.map(f => f.checked_out), [0, 0],
    'no requirement may be left flagged as checked out'
  );

  // And deck deletion -- the other multi-step mutation -- must remove
  // requirements and allocations together, never orphaning one.
  await db.run(`DELETE FROM deck_card_allocations WHERE deck_card_id = ?`, [secondReq]);
  const deleted = await api(owner.token, `/api/decks/${deckId}`, { method: 'DELETE' });
  assert.strictEqual(deleted.status, 200, 'deck deletion should succeed');
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM deck_cards WHERE deck_id = ?`, [deckId])).n, 0,
    'deleting a deck removes its requirements'
  );
  assert.strictEqual(
    (await db.get(
      `SELECT COUNT(*) AS n FROM deck_card_allocations WHERE deck_card_id IN (?, ?)`,
      [firstReq, secondReq]
    )).n, 0,
    'deleting a deck leaves no orphaned allocations pointing at collection rows'
  );
});

// ---------------------------------------------------------------------------
// T8: checkout is refused when the copies are not physically available, and
// refusing changes nothing.
//
// The mirror of T5. Editing a deck never requires ownership; assembling one
// always does. This is the point where "warning" becomes "no".
// ---------------------------------------------------------------------------
test('F12-TC8', 'F12-TC8 checkout refuses an unowned deck without side effects', async ({ owner }) => {
  const deckId = await createDeck(owner.id, 'Unavailable T8');
  const reqId = await addRequirement(deckId, {
    oracleId: 'oracle-solring', cardId: 'solring-cmr', finish: 'foil', quantity: 2
  });

  const checkout = await api(owner.token, `/api/decks/${deckId}/checkout`, { method: 'PUT' });
  assert.strictEqual(checkout.status, 400, 'checking out cards you do not have must be refused');

  assert.strictEqual(
    (await db.get(`SELECT checked_out FROM decks WHERE id = ?`, [deckId])).checked_out, 0,
    'the deck stays in storage'
  );
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM deck_card_allocations WHERE deck_card_id = ?`, [reqId])).n, 0,
    'a refused checkout allocates nothing'
  );

  // A considering DECK cannot be checked out at all: it never reserved the
  // cards, so letting it pull them would bypass reservation entirely.
  const considering = await createDeck(owner.id, 'Considering T8', { status: 'considering' });
  await addOwnedCopy(owner.id, 'bolt-lea', { finish: 'nonfoil' });
  await addRequirement(considering, {
    oracleId: 'oracle-bolt', cardId: 'bolt-lea', finish: 'nonfoil', quantity: 1
  });
  const consideringCheckout = await api(owner.token, `/api/decks/${considering}/checkout`, { method: 'PUT' });
  assert.strictEqual(consideringCheckout.status, 400, 'a considering deck cannot be checked out');
  assert.strictEqual(
    (await db.get(`SELECT checked_out FROM decks WHERE id = ?`, [considering])).checked_out, 0,
    'the considering deck stays in storage'
  );
});

// ---------------------------------------------------------------------------
// T9: a considering entry never reserves, and shows LIVE availability.
//
// 'considering' is a note that the user is thinking about a card. The card is
// not physically in the deck, so the entry reserves nothing at any level --
// deck status is irrelevant, being on the considering board is by itself
// enough.
//
// The part that matters most here is that availability is DERIVED at read
// time. If it were stored on the entry, another deck taking the last copy
// would leave this entry cheerfully claiming the card is available, and the
// user would plan around a number that stopped being true days ago.
// ---------------------------------------------------------------------------
test('F12-TC9', 'T9 considering entries never reserve and report live availability', async ({ owner }) => {
  // Exactly one physical copy of the exact variant in the world.
  await addOwnedCopy(owner.id, 'ponder-t9', { finish: 'etched', quantity: 1 });
  const identity = { desired_card_id: 'ponder-t9', desired_finish: 'etched' };

  // Deck 1 is ACTIVE, and the entry is on the considering board.
  const deckOne = await createDeck(owner.id, 'Considering Live T9', { status: 'active' });
  const consideringReq = await addRequirement(deckOne, {
    oracleId: 'oracle-ponder', cardId: 'ponder-t9', finish: 'etched',
    board: 'considering', quantity: 1
  });

  const readOne = async () => (await deckIdentity.availabilityForDeck(db, deckOne, owner.id))
    .entries.find(e => e.id === consideringReq);

  let entry = await readOne();
  assert.strictEqual(entry.reserves, false, 'a considering entry never reserves, even in an active deck');
  assert.strictEqual(entry.quantity_reserved, 0, 'a considering entry claims no physical copy');
  assert.strictEqual(entry.quantity_available, 1, 'the free copy is reported as available');
  assert.strictEqual(entry.available, true, 'availability is exposed as a plain yes/no as well as a count');

  // The considering entry must be invisible to the reservation queue: it is not
  // competition for anybody.
  assert.strictEqual(
    (await deckIdentity.requirementsForVariant(db, owner.id, identity)).length, 0,
    'a considering entry does not enter the reservation queue'
  );

  // Parking deck 1 must not change any of that -- status is irrelevant to a
  // considering entry.
  await db.run(`UPDATE decks SET status = 'considering' WHERE id = ?`, [deckOne]);
  entry = await readOne();
  assert.strictEqual(entry.reserves, false, 'still does not reserve in a parked deck');
  assert.strictEqual(entry.quantity_available, 1, 'and still sees the free copy');
  await db.run(`UPDATE decks SET status = 'active' WHERE id = ?`, [deckOne]);

  // Snapshot the stored row. Nothing below is allowed to change it.
  const rowBefore = await db.get(
    `SELECT id, deck_id, oracle_id, desired_card_id, desired_finish, board, quantity, checked_out
     FROM deck_cards WHERE id = ?`, [consideringReq]
  );

  // Deck 2 (active, real board) now takes the last copy.
  const deckTwo = await createDeck(owner.id, 'Taker T9', { status: 'active' });
  const takerReq = await addRequirement(deckTwo, {
    oracleId: 'oracle-ponder', cardId: 'ponder-t9', finish: 'etched',
    board: 'mainboard', quantity: 1
  });
  const takerEntry = (await deckIdentity.availabilityForDeck(db, deckTwo, owner.id))
    .entries.find(e => e.id === takerReq);
  assert.strictEqual(takerEntry.quantity_reserved, 1, 'the real deck entry takes the copy');

  // The SAME read path, run again, must now say unavailable. No write happened
  // to deck 1 between the two reads -- this is the definition of derived.
  entry = await readOne();
  assert.strictEqual(entry.quantity_available, 0, 'the considering entry immediately reflects the loss');
  assert.strictEqual(entry.available, false, 'and reads as unavailable');
  assert.strictEqual(entry.quantity_allocated_elsewhere, 1, 'it can say who took it: one copy is spoken for');

  // ...and it must NOT have been removed, dropped or edited.
  const rowAfter = await db.get(
    `SELECT id, deck_id, oracle_id, desired_card_id, desired_finish, board, quantity, checked_out
     FROM deck_cards WHERE id = ?`, [consideringReq]
  );
  assert.deepStrictEqual(
    rowAfter, rowBefore,
    'losing the last available copy must not remove or alter the considering entry'
  );

  // Buying another copy makes it available again on the next read, with no
  // write to the considering entry at all.
  await addOwnedCopy(owner.id, 'ponder-t9', { finish: 'etched', quantity: 1 });
  entry = await readOne();
  assert.strictEqual(entry.quantity_available, 1, 'availability recovers on read, not on write');

  // Exact identity still governs. Owning a DIFFERENT printing, and the same
  // printing in a different finish, must not make this entry available.
  await db.run(`DELETE FROM collection WHERE user_id = ? AND card_id = 'ponder-t9' AND finish = 'etched'`, [owner.id]);
  await addOwnedCopy(owner.id, 'ponder-m12', { finish: 'etched', quantity: 3 });
  await addOwnedCopy(owner.id, 'ponder-t9', { finish: 'foil', quantity: 3 });
  entry = await readOne();
  assert.strictEqual(entry.quantity_owned, 0, 'a different printing or finish is a different physical object');
  assert.strictEqual(entry.quantity_available, 0, 'so the considering entry stays unavailable');
});

// ---------------------------------------------------------------------------
// T10: parking a CHECKED-OUT deck as 'considering' is allowed.
//
// The old code refused this with a 400. That refusal was built on the idea that
// 'considering' releases cards which are physically sleeved -- but the physical
// claim lives in deck_card_allocations, not in the reservation view, and
// checkout already excludes copies held by any checked-out deck. So the flip is
// a plain status edit: it changes what the deck RESERVES, and touches nothing
// physical.
// ---------------------------------------------------------------------------
test('F12-TC10', 'T10 a checked-out deck can be parked as considering', async ({ owner }) => {
  const copyId = await addOwnedCopy(owner.id, 'brainstorm-t10', { finish: 'foil', quantity: 1 });
  const deckId = await createDeck(owner.id, 'Park Checked Out T10', { status: 'active' });
  const reqId = await addRequirement(deckId, {
    oracleId: 'oracle-brainstorm', cardId: 'brainstorm-t10', finish: 'foil', quantity: 1
  });

  const checkout = await api(owner.token, `/api/decks/${deckId}/checkout`, { method: 'PUT' });
  assert.strictEqual(checkout.status, 200, `precondition: checkout succeeds: ${JSON.stringify(checkout.body)}`);

  const parked = await api(owner.token, `/api/decks/${deckId}`, {
    method: 'PUT', body: { status: 'considering' }
  });
  assert.strictEqual(parked.status, 200, `parking a checked-out deck must be allowed: ${JSON.stringify(parked.body)}`);

  // The status actually changed in the database -- a 200 with no write would
  // pass a status-code-only assertion.
  const deck = await db.get(`SELECT status, checked_out FROM decks WHERE id = ?`, [deckId]);
  assert.strictEqual(deck.status, 'considering', 'the status is persisted');
  assert.strictEqual(deck.checked_out, 1, 'and the deck is still physically checked out');

  // Nothing physical moved. The allocation still names the same sleeve.
  assert.deepStrictEqual(
    await db.all(`SELECT collection_entry_id, quantity FROM deck_card_allocations WHERE deck_card_id = ?`, [reqId]),
    [{ collection_entry_id: copyId, quantity: 1 }],
    'parking a deck must not release the physical copies it is holding'
  );

  // A rival deck still cannot PULL that copy: the allocation, not the
  // reservation, is what protects a card sitting in a deck box.
  const rival = await createDeck(owner.id, 'Rival T10', { status: 'active' });
  await addRequirement(rival, {
    oracleId: 'oracle-brainstorm', cardId: 'brainstorm-t10', finish: 'foil', quantity: 1
  });
  const rivalCheckout = await api(owner.token, `/api/decks/${rival}/checkout`, { method: 'PUT' });
  assert.strictEqual(
    rivalCheckout.status, 400,
    'a copy physically sleeved in a checked-out deck cannot be pulled by another deck'
  );
});

// ---------------------------------------------------------------------------
// T11: a STACKED collection row (quantity > 1) is N physical copies, not one.
//
// A collection row is not a card. It is a stack: "3x Swamp, Unlimited, nonfoil,
// in this binder pocket". Nothing in the schema forces a user to store three
// copies as three rows, and the collection UI has always let quantity be edited
// in place, so stacks are the normal shape of a real collection.
//
// Every part of the reservation machinery therefore has to count COPIES, never
// rows. If any of it treats a stack as one object, Zach is shown a false
// picture of what he owns: either he is told to buy cards he already has, or --
// worse -- two decks are both told they hold a card there is only one of.
// ---------------------------------------------------------------------------
test('F12-TC11', 'T11 one collection row of quantity 3 is three reservable copies', async ({ owner }) => {
  // ONE row, THREE physical copies. This is the whole fixture.
  const stackId = await addOwnedCopy(owner.id, 'swamp-t11', { finish: 'nonfoil', quantity: 3 });
  const identity = { desired_card_id: 'swamp-t11', desired_finish: 'nonfoil' };

  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ? AND card_id = 'swamp-t11'`, [owner.id])).n,
    1,
    'precondition: the three copies live in exactly ONE collection row'
  );

  // (a) The stack reports three available copies.
  assert.strictEqual(
    await deckIdentity.ownedQuantity(db, owner.id, identity), 3,
    'a stacked row of 3 is 3 owned copies, not 1'
  );

  // (b) Three separate deck requirements can each reserve one copy from that
  // single row. Priority is deck_cards.id, so they claim in creation order.
  const deckA = await createDeck(owner.id, 'Stack A T11');
  const deckB = await createDeck(owner.id, 'Stack B T11');
  const deckC = await createDeck(owner.id, 'Stack C T11');
  const reqA = await addRequirement(deckA, { oracleId: 'oracle-swamp', cardId: 'swamp-t11', quantity: 1 });
  const reqB = await addRequirement(deckB, { oracleId: 'oracle-swamp', cardId: 'swamp-t11', quantity: 1 });
  const reqC = await addRequirement(deckC, { oracleId: 'oracle-swamp', cardId: 'swamp-t11', quantity: 1 });

  const entryFor = async (deckId, reqId) =>
    (await deckIdentity.availabilityForDeck(db, deckId, owner.id)).entries.find(e => e.id === reqId);

  const a = await entryFor(deckA, reqA);
  const b = await entryFor(deckB, reqB);
  const c = await entryFor(deckC, reqC);

  assert.strictEqual(a.quantity_owned, 3, 'deck A sees all three copies of the stack');
  assert.strictEqual(a.quantity_allocated_elsewhere, 0, 'deck A is first in line');
  assert.strictEqual(a.quantity_reserved, 1, 'deck A reserves one copy from the stack');
  assert.strictEqual(a.quantity_missing, 0, 'deck A is not missing anything');

  assert.strictEqual(b.quantity_allocated_elsewhere, 1, 'deck B sees deck A holding one copy');
  assert.strictEqual(b.quantity_reserved, 1, 'a second copy of the SAME row is still reservable');
  assert.strictEqual(b.quantity_missing, 0, 'deck B is not missing anything');

  assert.strictEqual(c.quantity_allocated_elsewhere, 2, 'deck C sees two copies spoken for');
  assert.strictEqual(c.quantity_reserved, 1, 'the third copy of the stack is reservable too');
  assert.strictEqual(c.quantity_missing, 0, 'three copies satisfy three requirements');

  // (c) A FOURTH requirement finds none available -- the stack is finite.
  const deckD = await createDeck(owner.id, 'Stack D T11');
  const reqD = await addRequirement(deckD, { oracleId: 'oracle-swamp', cardId: 'swamp-t11', quantity: 1 });
  const d = await entryFor(deckD, reqD);
  assert.strictEqual(d.quantity_owned, 3, 'the fourth deck still sees three owned');
  assert.strictEqual(d.quantity_allocated_elsewhere, 3, 'but all three are claimed');
  assert.strictEqual(d.quantity_reserved, 0, 'a stack of three cannot satisfy a fourth requirement');
  assert.strictEqual(d.quantity_missing, 1, 'the fourth deck must buy a copy');
  assert.strictEqual(d.available, false, 'and reads as unavailable');

  // Retire deck D's requirement so the live-count checks below measure exactly
  // the three claims A/B/C, not D's leftovers.
  await db.run(`DELETE FROM deck_cards WHERE id = ?`, [reqD]);

  // (d) A CONSIDERING entry against the stacked row reports the correct live
  // count as copies are taken. It reserves nothing, so it sees every claim.
  const maybeDeck = await createDeck(owner.id, 'Stack Maybe T11');
  const maybeReq = await addRequirement(maybeDeck, {
    oracleId: 'oracle-swamp', cardId: 'swamp-t11', board: 'considering', quantity: 1
  });
  const readMaybe = async () => entryFor(maybeDeck, maybeReq);

  let maybe = await readMaybe();
  assert.strictEqual(maybe.reserves, false, 'the considering entry reserves nothing');
  assert.strictEqual(maybe.quantity_allocated_elsewhere, 3, 'it sees all three copies spoken for');
  assert.strictEqual(maybe.quantity_available, 0, 'so none of the stack is free right now');

  // Release deck C's claim: exactly one copy of the stack comes back.
  await db.run(`DELETE FROM deck_cards WHERE id = ?`, [reqC]);
  maybe = await readMaybe();
  assert.strictEqual(maybe.quantity_available, 1, 'releasing one requirement frees exactly one copy of the stack');
  assert.strictEqual(maybe.available, true, 'and the maybeboard says so');

  // Release deck B's too: two free.
  await db.run(`DELETE FROM deck_cards WHERE id = ?`, [reqB]);
  maybe = await readMaybe();
  assert.strictEqual(maybe.quantity_available, 2, 'the live count tracks copies, not rows');

  // Growing the stack in place (quantity 3 -> 5) is the same operation as
  // buying two more cards, and must read that way.
  await db.run(`UPDATE collection SET quantity = 5 WHERE id = ?`, [stackId]);
  maybe = await readMaybe();
  assert.strictEqual(maybe.quantity_owned, 5, 'editing a stack quantity is buying copies');
  assert.strictEqual(maybe.quantity_available, 4, 'four of the five are free with deck A still holding one');

  // A single requirement wanting several copies is satisfied by ONE stack.
  const bulkDeck = await createDeck(owner.id, 'Stack Bulk T11');
  const bulkReq = await addRequirement(bulkDeck, {
    oracleId: 'oracle-swamp', cardId: 'swamp-t11', quantity: 4
  });
  const bulk = await entryFor(bulkDeck, bulkReq);
  assert.strictEqual(bulk.quantity_reserved, 4, 'one row can satisfy a 4-of requirement on its own');
  assert.strictEqual(bulk.quantity_missing, 0, 'nothing to buy');
});

// ---------------------------------------------------------------------------
// T12: checkout allocates DISTINCT copies out of one stacked row, and those
// allocations stay put.
//
// This is the physical end of the same rule. Two decks that each pull a Swamp
// from the same three-card stack must be recorded as holding two different
// copies of that stack -- 2 of the 3 -- and a third deck must be able to take
// the last one. If checkout instead treats the row as consumed the moment the
// first deck touches it, Zach is told to go buy Swamps that are sitting in his
// binder.
// ---------------------------------------------------------------------------
test('F12-TC12', 'T12 checkout draws distinct copies from a stacked row', async ({ owner }) => {
  const stackId = await addOwnedCopy(owner.id, 'island-t12', { finish: 'foil', quantity: 3 });

  const one = await createDeck(owner.id, 'Stack Checkout One T12');
  const two = await createDeck(owner.id, 'Stack Checkout Two T12');
  const three = await createDeck(owner.id, 'Stack Checkout Three T12');
  const four = await createDeck(owner.id, 'Stack Checkout Four T12');
  const reqOne = await addRequirement(one, { oracleId: 'oracle-island', cardId: 'island-t12', finish: 'foil', quantity: 1 });
  const reqTwo = await addRequirement(two, { oracleId: 'oracle-island', cardId: 'island-t12', finish: 'foil', quantity: 1 });
  const reqThree = await addRequirement(three, { oracleId: 'oracle-island', cardId: 'island-t12', finish: 'foil', quantity: 1 });
  const reqFour = await addRequirement(four, { oracleId: 'oracle-island', cardId: 'island-t12', finish: 'foil', quantity: 1 });

  // Deck one pulls a copy.
  const outOne = await api(owner.token, `/api/decks/${one}/checkout`, { method: 'PUT' });
  assert.strictEqual(outOne.status, 200, `first checkout should succeed: ${JSON.stringify(outOne.body)}`);
  assert.deepStrictEqual(
    await db.all(`SELECT collection_entry_id, quantity FROM deck_card_allocations WHERE deck_card_id = ?`, [reqOne]),
    [{ collection_entry_id: stackId, quantity: 1 }],
    'the first deck is recorded as holding ONE copy of the stack'
  );

  // Deck two must be able to pull a SECOND copy from the SAME row.
  const outTwo = await api(owner.token, `/api/decks/${two}/checkout`, { method: 'PUT' });
  assert.strictEqual(
    outTwo.status, 200,
    `a second copy of a stacked row must still be pullable: ${JSON.stringify(outTwo.body)}`
  );
  assert.deepStrictEqual(
    await db.all(`SELECT collection_entry_id, quantity FROM deck_card_allocations WHERE deck_card_id = ?`, [reqTwo]),
    [{ collection_entry_id: stackId, quantity: 1 }],
    'the second deck holds a second copy of that same row'
  );

  // ...and deck three the third.
  const outThree = await api(owner.token, `/api/decks/${three}/checkout`, { method: 'PUT' });
  assert.strictEqual(
    outThree.status, 200,
    `the third copy of the stack must be pullable: ${JSON.stringify(outThree.body)}`
  );

  // The database now says: three copies of one row are out, one per deck.
  const held = await db.get(
    `SELECT COALESCE(SUM(quantity), 0) AS total FROM deck_card_allocations WHERE collection_entry_id = ?`,
    [stackId]
  );
  assert.strictEqual(held.total, 3, 'all three physical copies of the stack are accounted for, one per deck');

  // The FOURTH deck has nothing left to pull. The stack is exhausted, and
  // over-allocating would be the app claiming a card that does not exist.
  const outFour = await api(owner.token, `/api/decks/${four}/checkout`, { method: 'PUT' });
  assert.strictEqual(
    outFour.status, 400,
    'a stack of three cannot supply a fourth deck'
  );
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM deck_card_allocations WHERE deck_card_id = ?`, [reqFour])).n, 0,
    'the refused checkout allocates nothing'
  );
  assert.strictEqual(
    (await db.get(`SELECT checked_out FROM decks WHERE id = ?`, [four])).checked_out, 0,
    'and leaves the fourth deck in storage'
  );

  // Allocations are stable: reading the locator, and other decks coming and
  // going, must not renumber who holds what.
  await api(owner.token, `/api/decks/${one}/locations`);
  await api(owner.token, `/api/decks/${two}/locations`);
  const stable = await db.all(
    `SELECT deck_card_id, collection_entry_id, quantity FROM deck_card_allocations
     WHERE deck_card_id IN (?, ?, ?) ORDER BY deck_card_id`,
    [reqOne, reqTwo, reqThree]
  );
  assert.deepStrictEqual(
    stable,
    [
      { deck_card_id: reqOne, collection_entry_id: stackId, quantity: 1 },
      { deck_card_id: reqTwo, collection_entry_id: stackId, quantity: 1 },
      { deck_card_id: reqThree, collection_entry_id: stackId, quantity: 1 }
    ],
    'each deck keeps its own copy of the stack across reads'
  );

  // The locator must report a real, findable copy for a checked-out deck.
  const locations = await api(owner.token, `/api/decks/${two}/locations`);
  const reported = locations.body.find(r => r.deck_card_id === reqTwo);
  assert.strictEqual(reported.found, 1, 'the locator finds the copy the second deck is holding');
  assert.strictEqual(reported.missing, 0, 'nothing is reported missing');

  // Returning deck one puts exactly one copy back on the shelf.
  await api(owner.token, `/api/decks/${one}/return`, { method: 'PUT' });
  assert.strictEqual(
    (await db.get(
      `SELECT COALESCE(SUM(quantity), 0) AS total FROM deck_card_allocations WHERE collection_entry_id = ?`,
      [stackId]
    )).total,
    2,
    'returning one deck releases exactly one copy of the stack'
  );

  // But deck four still cannot check out, and that is CORRECT. Returning a deck
  // to storage releases the physical card, not the deck's claim on it -- deck
  // one is still an active deck that wants its Island. Deck four remains fourth
  // in line for three copies, so the reservation layer refuses it before
  // allocation is ever attempted. This is the distinction the whole design
  // rests on: an allocation is "where is the card right now", a reservation is
  // "who is entitled to it".
  const stillFourth = await api(owner.token, `/api/decks/${four}/checkout`, { method: 'PUT' });
  assert.strictEqual(
    stillFourth.status, 400,
    'returning a deck frees the card but not the claim: the fourth deck is still last in line'
  );
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM deck_card_allocations WHERE deck_card_id = ?`, [reqFour])).n, 0,
    'and still allocates nothing'
  );

  // Deck one giving up the requirement entirely IS a release of the claim.
  // Deck four moves up to third of three and can now pull the freed copy.
  await api(owner.token, `/api/decks/${one}/cards/${reqOne}`, { method: 'DELETE' });
  const fourEntry = (await deckIdentity.availabilityForDeck(db, four, owner.id))
    .entries.find(e => e.id === reqFour);
  assert.strictEqual(fourEntry.quantity_missing, 0, 'the fourth deck is now third of three and owed a copy');

  const outFourAgain = await api(owner.token, `/api/decks/${four}/checkout`, { method: 'PUT' });
  assert.strictEqual(
    outFourAgain.status, 200,
    `the freed copy of the stack is now pullable: ${JSON.stringify(outFourAgain.body)}`
  );
  assert.deepStrictEqual(
    await db.all(`SELECT collection_entry_id, quantity FROM deck_card_allocations WHERE deck_card_id = ?`, [reqFour]),
    [{ collection_entry_id: stackId, quantity: 1 }],
    'the fourth deck now holds the returned copy of the stack'
  );

  // And the stack is fully accounted for again: three copies, three holders,
  // never more than the row actually contains.
  assert.strictEqual(
    (await db.get(
      `SELECT COALESCE(SUM(quantity), 0) AS total FROM deck_card_allocations WHERE collection_entry_id = ?`,
      [stackId]
    )).total,
    3,
    'a stack of three is never allocated more than three times'
  );
});

async function main() {


  await db.initDb();
  const owner = await createUser('pr6c-owner');
  const other = await createUser('pr6c-other');
  await seedCards();

  const app = express();
  app.use(express.json());
  app.use('/api/decks', deckRoutes);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const context = { owner, other };
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
  if (failed > 0) throw new Error(`${failed} deck identity test(s) failed`);
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error.message);
  process.exit(1);
});
