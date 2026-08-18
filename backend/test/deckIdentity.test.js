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
    { id: 'island-t12', oracle: 'oracle-island', name: 'Island', set: 'Beta', num: '288' },
    // Dedicated printings for the TEXT IMPORT tests (T17-T22). Import resolves
    // a bare card NAME, so these names must be unique to the import tests --
    // reusing 'Lightning Bolt' would make an import test allocate copies an
    // earlier reservation test had already seeded, and the assertion would
    // silently measure the wrong collection.
    { id: 'aimp-a', oracle: 'oracle-aimp', name: 'Arcane Impulse', set: 'Alpha Test Set', num: '1' },
    { id: 'aimp-b', oracle: 'oracle-aimp', name: 'Arcane Impulse', set: 'Beta Test Set', num: '2' },
    { id: 'aimp-c', oracle: 'oracle-aimp', name: 'Arcane Impulse', set: 'Gamma Test Set', num: '3' },
    { id: 'bpulse-a', oracle: 'oracle-bpulse', name: 'Basalt Pulse', set: 'Alpha Test Set', num: '4' },
    { id: 'cward-a', oracle: 'oracle-cward', name: 'Cinder Ward', set: 'Alpha Test Set', num: '5' },
    { id: 'dhymn-a', oracle: 'oracle-dhymn', name: 'Dusk Hymn', set: 'Alpha Test Set', num: '6' },
    { id: 'egrasp-a', oracle: 'oracle-egrasp', name: 'Ember Grasp', set: 'Alpha Test Set', num: '7' },
    { id: 'egrasp-b', oracle: 'oracle-egrasp', name: 'Ember Grasp', set: 'Beta Test Set', num: '8' }
  ];
  for (const p of printings) {
    await db.run(
      `INSERT OR IGNORE INTO card_cache (id, oracle_id, name, set_name, number, finishes, supertype, subtypes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.id, p.oracle, p.name, p.set, p.num, JSON.stringify(['nonfoil', 'foil']), 'Artifact', '[]']
    );
  }

  // Printings for the EXPLICIT-PRINTING import tests (T24-T29).
  //
  // These carry a real set_id, because that is the column an import line's
  // "(C21)" token is matched against -- the rows above were written before
  // import could read a set code and deliberately have none, which makes them
  // useful negative fixtures but useless positive ones.
  //
  // Names are again unique to these tests: an explicit-printing test asserting
  // "this exact printing was chosen" would silently pass for the wrong reason
  // if another test's allocation happened to land on the same row.
  const explicitPrintings = [
    // Two printings of one card in DIFFERENT sets: the point of Case A is that
    // the line's set code decides between them.
    { id: 'fgale-x1', oracle: 'oracle-fgale', name: 'Frost Gale', setId: 'tx1', set: 'Test Expansion One', num: '101', finishes: ['nonfoil', 'foil'] },
    { id: 'fgale-x2', oracle: 'oracle-fgale', name: 'Frost Gale', setId: 'tx2', set: 'Test Expansion Two', num: '202', finishes: ['nonfoil', 'foil'] },
    // Owned nowhere -- the "auto-pick a printing he does not have" case.
    { id: 'gspire-x1', oracle: 'oracle-gspire', name: 'Gloom Spire', setId: 'tx1', set: 'Test Expansion One', num: '103', finishes: ['nonfoil', 'foil'] },
    { id: 'gspire-x2', oracle: 'oracle-gspire', name: 'Gloom Spire', setId: 'tx2', set: 'Test Expansion Two', num: '204', finishes: ['nonfoil'] },
    // Nonfoil-only, to prove a printing's own finish list is honoured rather
    // than a finish being invented for it.
    { id: 'hmoth-x1', oracle: 'oracle-hmoth', name: 'Hollow Moth', setId: 'tx1', set: 'Test Expansion One', num: '105', finishes: ['nonfoil'] },
    // Two printings, neither owned, for the Case C picker tests.
    { id: 'iveil-x1', oracle: 'oracle-iveil', name: 'Iron Veil', setId: 'tx1', set: 'Test Expansion One', num: '107', finishes: ['nonfoil', 'foil'] },
    { id: 'iveil-x2', oracle: 'oracle-iveil', name: 'Iron Veil', setId: 'tx2', set: 'Test Expansion Two', num: '208', finishes: ['nonfoil'] },
    // Partially owned, for the shortfall-extends-the-owned-printing test.
    { id: 'jthorn-x1', oracle: 'oracle-jthorn', name: 'Jade Thorn', setId: 'tx1', set: 'Test Expansion One', num: '109', finishes: ['nonfoil'] },
    { id: 'jthorn-x2', oracle: 'oracle-jthorn', name: 'Jade Thorn', setId: 'tx2', set: 'Test Expansion Two', num: '210', finishes: ['nonfoil'] },
    // Two printings owned in UNEQUAL depths, for the most-used tie-break test
    // (T30). Unique to that test: it asserts which of two owned printings the
    // shortfall attached to, and another test's allocation landing on either
    // would make that assertion measure the wrong thing.
    { id: 'kglass-x1', oracle: 'oracle-kglass', name: 'Kelp Glass', setId: 'tx1', set: 'Test Expansion One', num: '111', finishes: ['nonfoil'] },
    { id: 'kglass-x2', oracle: 'oracle-kglass', name: 'Kelp Glass', setId: 'tx2', set: 'Test Expansion Two', num: '212', finishes: ['nonfoil'] },
    // T31-T35 (PR 6D defect): TWO LINES FOR ONE CARD WITH DIFFERENT MERGE KEYS.
    //
    // Import merges lines by (name, set, number, finish). Two lines naming the
    // same card in different ways therefore stay SEPARATE, and each one is
    // resolved against the collection independently. These fixtures exist to
    // put a fixed, known number of copies in the binder and then ask for them
    // twice through two differently-keyed lines.
    //
    // Names are unique to these tests for the usual reason: import resolves a
    // bare NAME, so a fixture shared with another test would let that test's
    // allocation absorb copies these assertions are counting.
    { id: 'lspiral-x1', oracle: 'oracle-lspiral', name: 'Lumen Spiral', setId: 'tx1', set: 'Test Expansion One', num: '301', finishes: ['nonfoil'] },
    { id: 'mtide-x1', oracle: 'oracle-mtide', name: 'Moss Tide', setId: 'tx1', set: 'Test Expansion One', num: '302', finishes: ['nonfoil'] },
    { id: 'nquill-x1', oracle: 'oracle-nquill', name: 'Night Quill', setId: 'tx1', set: 'Test Expansion One', num: '303', finishes: ['nonfoil', 'foil'] },
    { id: 'obloom-x1', oracle: 'oracle-obloom', name: 'Onyx Bloom', setId: 'tx1', set: 'Test Expansion One', num: '304', finishes: ['nonfoil'] },
    { id: 'obloom-x2', oracle: 'oracle-obloom', name: 'Onyx Bloom', setId: 'tx2', set: 'Test Expansion Two', num: '305', finishes: ['nonfoil'] },
    { id: 'pfrost-x1', oracle: 'oracle-pfrost', name: 'Pale Frost', setId: 'tx1', set: 'Test Expansion One', num: '306', finishes: ['nonfoil'] },
    { id: 'zward-x1', oracle: 'oracle-zward', name: 'Zephyr Ward', setId: 'tx1', set: 'Test Expansion One', num: '307', finishes: ['nonfoil'] }
  ];
  for (const p of explicitPrintings) {
    await db.run(
      `INSERT OR IGNORE INTO card_cache (id, oracle_id, name, set_id, set_name, number, finishes, supertype, subtypes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.id, p.oracle, p.name, p.setId, p.set, p.num, JSON.stringify(p.finishes), 'Artifact', '[]']
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

// PR 6D removed the deck-level status column. A DECK is never 'considering';
// only an individual CARD is, via its board. The helper takes no status.
async function createDeck(userId, name) {
  const row = await db.run(
    `INSERT INTO decks (user_id, name) VALUES (?, ?)`,
    [userId, name]
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
// T3: saving a deck reserves immediately; considering ENTRIES do not.
//
// This is requirement 2, and it is the difference between the app being useful
// and being a lie. If reservation waited until checkout, the user could build
// three decks that each "own" the same Sol Ring, and only discover the conflict
// standing at the table with two decks that cannot both be legal.
//
// PR 6D removed the deck-level 'considering' status this test used to also
// cover. Reservation now depends on the entry's BOARD and nothing else, which
// is the rule the second half of this test pins down.
// ---------------------------------------------------------------------------
test('F12-TC3', 'T3 decks reserve on save, considering entries do not', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'solring-cmr', { finish: 'nonfoil' });

  const activeDeck = await createDeck(owner.id, 'Active T3');
  const activeReq = await addRequirement(activeDeck, {
    oracleId: 'oracle-solring', cardId: 'solring-cmr', quantity: 1
  });

  const activeView = await deckIdentity.availabilityForDeck(db, activeDeck, owner.id);
  const activeEntry = activeView.entries.find(e => e.id === activeReq);
  assert.strictEqual(activeEntry.reserves, true, 'a real entry reserves');
  assert.strictEqual(activeEntry.quantity_reserved, 1, 'the owned copy is reserved immediately on save');

  // A CONSIDERING entry, even in a second deck, is planning only. Its
  // requirement must leave the inventory untouched for real decks.
  const planningDeck = await createDeck(owner.id, 'Planning T3');
  const consideringReq = await addRequirement(planningDeck, {
    oracleId: 'oracle-solring', cardId: 'solring-cmr', quantity: 1, board: 'considering'
  });
  const consideringView = await deckIdentity.availabilityForDeck(db, planningDeck, owner.id);
  const consideringEntry = consideringView.entries.find(e => e.id === consideringReq);
  assert.strictEqual(consideringEntry.reserves, false, 'a considering entry reserves nothing');
  assert.strictEqual(consideringEntry.quantity_reserved, 0, 'a considering entry claims no physical copy');

  // ...and crucially, it must not appear as competition to anyone else.
  const competing = await deckIdentity.requirementsForVariant(db, owner.id, {
    desired_card_id: 'solring-cmr', desired_finish: 'nonfoil'
  });
  assert.deepStrictEqual(
    competing.map(r => r.id), [activeReq],
    'only the real entry competes for the physical copy'
  );

  // The same rule inside ONE deck: a considering entry alongside a mainboard
  // entry is still a maybe and must not consume inventory.
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

  // A deck whose only entries are CONSIDERING has nothing to pull. Checkout
  // allocates reserving entries only, so it succeeds and allocates nothing --
  // considering cards are not in the deck and must never be taken out of a
  // binder on its behalf.
  const planning = await createDeck(owner.id, 'Planning T8');
  await addOwnedCopy(owner.id, 'bolt-lea', { finish: 'nonfoil' });
  const planningReq = await addRequirement(planning, {
    oracleId: 'oracle-bolt', cardId: 'bolt-lea', finish: 'nonfoil', quantity: 1,
    board: 'considering'
  });
  const planningCheckout = await api(owner.token, `/api/decks/${planning}/checkout`, { method: 'PUT' });
  assert.strictEqual(planningCheckout.status, 200, 'a deck of considering-only entries checks out trivially');
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM deck_card_allocations WHERE deck_card_id = ?`, [planningReq])).n, 0,
    'a considering entry never has a physical copy allocated to it'
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

  // Deck 1 holds the entry on the considering board.
  const deckOne = await createDeck(owner.id, 'Considering Live T9');
  const consideringReq = await addRequirement(deckOne, {
    oracleId: 'oracle-ponder', cardId: 'ponder-t9', finish: 'etched',
    board: 'considering', quantity: 1
  });

  const readOne = async () => (await deckIdentity.availabilityForDeck(db, deckOne, owner.id))
    .entries.find(e => e.id === consideringReq);

  let entry = await readOne();
  assert.strictEqual(entry.reserves, false, 'a considering entry never reserves');
  assert.strictEqual(entry.quantity_reserved, 0, 'a considering entry claims no physical copy');
  assert.strictEqual(entry.quantity_available, 1, 'the free copy is reported as available');
  assert.strictEqual(entry.available, true, 'availability is exposed as a plain yes/no as well as a count');

  // The considering entry must be invisible to the reservation queue: it is not
  // competition for anybody.
  assert.strictEqual(
    (await deckIdentity.requirementsForVariant(db, owner.id, identity)).length, 0,
    'a considering entry does not enter the reservation queue'
  );

  // Snapshot the stored row. Nothing below is allowed to change it.
  const rowBefore = await db.get(
    `SELECT id, deck_id, oracle_id, desired_card_id, desired_finish, board, quantity, checked_out
     FROM deck_cards WHERE id = ?`, [consideringReq]
  );

  // Deck 2 (real board) now takes the last copy.
  const deckTwo = await createDeck(owner.id, 'Taker T9');
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
// T10: a deck has NO status column, and considering is a per-CARD state.
//
// PR 6C modelled "considering" at BOTH levels: a deck could be considering and
// so could a card. That was wrong, and PR 6D removes the deck half. The reason
// is a product one rather than a technical one: "I am considering this card" is
// a real thing a player says about one card in a list, while "this whole deck
// is considering" does not correspond to anything they do. Two spellings of one
// idea also meant two code paths could disagree about whether a deck's cards
// were spoken for.
//
// This test replaces the old "parking a checked-out deck is allowed" case,
// which tested a state that can no longer exist. What it pins down instead is
// that the state cannot come back: the column is gone, the API refuses to
// resurrect it, and a checked-out deck keeps its physical allocation across an
// ordinary metadata edit.
// ---------------------------------------------------------------------------
test('F12-TC10', 'T10 decks have no considering status; considering is per-card', async ({ owner }) => {
  // The column does not exist at all. Asserting on the schema rather than on a
  // route's behaviour is deliberate: as long as the column is absent, no future
  // code path can reintroduce a deck-level considering state by accident.
  const deckColumns = (await db.all(`PRAGMA table_info(decks)`)).map(c => c.name);
  assert.ok(!deckColumns.includes('status'), 'the decks table has no status column');

  // ...while the per-entry board still offers it, because that is where the
  // idea legitimately lives.
  assert.ok(
    deckIdentity.BOARDS.includes('considering'),
    'considering survives as a per-card board'
  );
  assert.ok(
    !deckIdentity.RESERVING_BOARDS.includes('considering'),
    'and it still reserves nothing'
  );

  const copyId = await addOwnedCopy(owner.id, 'brainstorm-t10', { finish: 'foil', quantity: 1 });
  const deckId = await createDeck(owner.id, 'Metadata Edit T10');
  const reqId = await addRequirement(deckId, {
    oracleId: 'oracle-brainstorm', cardId: 'brainstorm-t10', finish: 'foil', quantity: 1
  });

  const checkout = await api(owner.token, `/api/decks/${deckId}/checkout`, { method: 'PUT' });
  assert.strictEqual(checkout.status, 200, `precondition: checkout succeeds: ${JSON.stringify(checkout.body)}`);

  // A status field sent by an old client is simply ignored, not honoured. The
  // edit that IS supported still applies.
  const edited = await api(owner.token, `/api/decks/${deckId}`, {
    method: 'PUT', body: { name: 'Renamed T10', status: 'considering' }
  });
  assert.strictEqual(edited.status, 200, `a metadata edit succeeds: ${JSON.stringify(edited.body)}`);

  const deck = await db.get(`SELECT * FROM decks WHERE id = ?`, [deckId]);
  assert.strictEqual(deck.name, 'Renamed T10', 'the supported edit is persisted');
  assert.strictEqual(deck.status, undefined, 'no status was resurrected on the row');
  assert.strictEqual(deck.checked_out, 1, 'and the deck is still physically checked out');

  // Nothing physical moved. The allocation still names the same sleeve.
  assert.deepStrictEqual(
    await db.all(`SELECT collection_entry_id, quantity FROM deck_card_allocations WHERE deck_card_id = ?`, [reqId]),
    [{ collection_entry_id: copyId, quantity: 1 }],
    'a metadata edit must not release the physical copies the deck is holding'
  );

  // A rival deck still cannot PULL that copy: the allocation, not the
  // reservation, is what protects a card sitting in a deck box.
  const rival = await createDeck(owner.id, 'Rival T10');
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

// ---------------------------------------------------------------------------
// T13 (PR 6D): the restored deck UI's write path sends exact identity, and the
// server writes exactly what it was told.
//
// This is the test that would have caught the whole PR 6C/6D episode. The
// restored DeckBuilder is a large screen with many buttons, and the thing that
// must be true of every one of them is narrow: whatever the user clicks, the
// row that ends up in deck_cards names a SPECIFIC printing and a SPECIFIC
// finish. So this asserts on the ROW, not on a 200.
// ---------------------------------------------------------------------------
test('F12-TC13', 'T13 deck writes persist an exact printing and finish', async ({ owner }) => {
  const deckId = await createDeck(owner.id, 'Exact Write T13');

  // The two halves of the identity are BOTH mandatory. A request naming a card
  // but not a finish is refused rather than defaulted, because a defaulted
  // finish is the app choosing a physical object on the user's behalf.
  const noFinish = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST', body: { desired_card_id: 'bolt-lea', quantity: 1 }
  });
  assert.strictEqual(noFinish.status, 400, 'a write with no finish is refused');

  const noCard = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST', body: { desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(noCard.status, 400, 'a write with no printing is refused');

  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM deck_cards WHERE deck_id = ?`, [deckId])).n, 0,
    'neither refused write left a row behind'
  );

  // A complete write persists precisely the printing and finish requested.
  const added = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'bolt-2x2', desired_finish: 'foil', board: 'mainboard', quantity: 2 }
  });
  assert.strictEqual(added.status, 200, `the write succeeds: ${JSON.stringify(added.body)}`);

  const row = await db.get(
    `SELECT desired_card_id, desired_finish, board, quantity, oracle_id FROM deck_cards WHERE deck_id = ?`,
    [deckId]
  );
  assert.deepStrictEqual(
    row,
    { desired_card_id: 'bolt-2x2', desired_finish: 'foil', board: 'mainboard', quantity: 2, oracle_id: 'oracle-bolt' },
    'the stored row names the exact printing and finish the client chose'
  );

  // Quantity is ABSOLUTE, not a delta. This is what makes an impatient
  // double-tap safe: re-sending the same request cannot double the requirement.
  await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'bolt-2x2', desired_finish: 'foil', board: 'mainboard', quantity: 2 }
  });
  assert.strictEqual(
    (await db.get(`SELECT quantity FROM deck_cards WHERE deck_id = ?`, [deckId])).quantity, 2,
    'a repeated identical write is idempotent, not additive'
  );

  // The SAME printing in a different finish is a DIFFERENT physical object and
  // gets its own row. Collapsing them would be name-matching by another name.
  await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'bolt-2x2', desired_finish: 'nonfoil', board: 'mainboard', quantity: 1 }
  });
  // ...and so is a different printing of the same Oracle card.
  await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'bolt-lea', desired_finish: 'foil', board: 'mainboard', quantity: 1 }
  });

  const variants = await db.all(
    `SELECT desired_card_id, desired_finish FROM deck_cards WHERE deck_id = ? ORDER BY id ASC`,
    [deckId]
  );
  assert.deepStrictEqual(
    variants,
    [
      { desired_card_id: 'bolt-2x2', desired_finish: 'foil' },
      { desired_card_id: 'bolt-2x2', desired_finish: 'nonfoil' },
      { desired_card_id: 'bolt-lea', desired_finish: 'foil' }
    ],
    'each distinct printing+finish is its own requirement'
  );
});

// ---------------------------------------------------------------------------
// T14 (PR 6D): moving a card into Considering never reserves, and the deck's
// own card count stops including it.
//
// The deck list screen shows "84 / 100 cards" against a target. If considering
// cards counted toward that, a finished deck would read as over-full and the
// number the user is steering by would be wrong. The count and the reservation
// are two different facts and this pins down both.
// ---------------------------------------------------------------------------
test('F12-TC14', 'T14 considering entries reserve nothing and are excluded from the deck count', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'island-t12', { finish: 'nonfoil', quantity: 2 });
  const deckId = await createDeck(owner.id, 'Considering Count T14');

  const real = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'island-t12', desired_finish: 'nonfoil', board: 'mainboard', quantity: 1 }
  });
  assert.strictEqual(real.status, 200);

  const maybe = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'ponder-m12', desired_finish: 'etched', board: 'considering', quantity: 3 }
  });
  assert.strictEqual(maybe.status, 200, `a considering entry saves: ${JSON.stringify(maybe.body)}`);

  // The vault list count excludes the considering entry entirely.
  const list = await api(owner.token, '/api/decks');
  const listed = list.body.find(d => d.id === deckId);
  assert.strictEqual(listed.total_cards, 1, 'considering cards are not counted toward the deck size');
  assert.strictEqual(listed.considering_cards, 3, 'but they are reported separately');
  assert.strictEqual(listed.total_card_types, 1, 'and they do not inflate the unique-card count');

  // The considering entry reserves nothing, at the database level.
  const consideringRow = await db.get(
    `SELECT id FROM deck_cards WHERE deck_id = ? AND board = 'considering'`, [deckId]
  );
  const entries = (await deckIdentity.availabilityForDeck(db, deckId, owner.id)).entries;
  const consideringEntry = entries.find(e => e.id === consideringRow.id);
  assert.strictEqual(consideringEntry.reserves, false, 'a considering entry never reserves');
  assert.strictEqual(consideringEntry.quantity_reserved, 0, 'and claims no physical copy');

  // It is invisible to the reservation queue, so it is not competition.
  assert.strictEqual(
    (await deckIdentity.requirementsForVariant(db, owner.id, {
      desired_card_id: 'ponder-m12', desired_finish: 'etched'
    })).length,
    0,
    'a considering entry does not enter the reservation queue'
  );
});

// ---------------------------------------------------------------------------
// T15 (PR 6D): a considering entry shows LIVE availability that goes red when
// another deck takes the last copy -- without the entry being touched.
//
// This is the behaviour Zach asked for stated as a test. The important word is
// LIVE: nothing writes to the considering row when the world changes around it.
// If availability were stored, the entry would keep cheerfully claiming a card
// was free days after another deck took it, and the user would plan around a
// number that stopped being true.
// ---------------------------------------------------------------------------
test('F12-TC15', 'T15 a considering entry reports live availability and is never rewritten', async ({ owner }) => {
  // Exactly one copy of this exact variant exists.
  await addOwnedCopy(owner.id, 'swamp-t11', { finish: 'etched', quantity: 1 });

  const planning = await createDeck(owner.id, 'Live Considering T15');
  await api(owner.token, `/api/decks/${planning}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'swamp-t11', desired_finish: 'etched', board: 'considering', quantity: 1 }
  });
  const reqRow = await db.get(
    `SELECT * FROM deck_cards WHERE deck_id = ? AND board = 'considering'`, [planning]
  );

  const readEntry = async () => {
    const detail = await api(owner.token, `/api/decks/${planning}`);
    return detail.body.cards.find(c => c.id === reqRow.id);
  };

  // Free right now: available, with a count.
  let entry = await readEntry();
  assert.strictEqual(entry.available, true, 'the free copy reads as available');
  assert.strictEqual(entry.quantity_available, 1, 'and the count says how many');

  // Another deck now takes the last copy on a REAL board.
  const taker = await createDeck(owner.id, 'Taker T15');
  await api(owner.token, `/api/decks/${taker}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'swamp-t11', desired_finish: 'etched', board: 'mainboard', quantity: 1 }
  });

  // The SAME read path, run again, now says unavailable. No write happened to
  // the considering entry between the two reads -- that is what "derived" means.
  entry = await readEntry();
  assert.strictEqual(entry.available, false, 'the considering entry immediately reads as unavailable');
  assert.strictEqual(entry.quantity_available, 0, 'with nothing free');
  assert.strictEqual(entry.quantity_allocated_elsewhere, 1, 'and it can say one copy is spoken for');
  assert.strictEqual(entry.reserves, false, 'it still reserves nothing');

  // The stored row is byte-for-byte unchanged. Losing the last free copy must
  // never remove, dim or edit the card the user is considering.
  const rowAfter = await db.get(`SELECT * FROM deck_cards WHERE id = ?`, [reqRow.id]);
  assert.deepStrictEqual(
    rowAfter, reqRow,
    'losing the last available copy must not alter the considering entry'
  );

  // Buying another copy makes it available again on the next READ, with no
  // write to the considering entry at all.
  await addOwnedCopy(owner.id, 'swamp-t11', { finish: 'etched', quantity: 1 });
  entry = await readEntry();
  assert.strictEqual(entry.available, true, 'availability recovers on read, not on write');
  assert.deepStrictEqual(
    await db.get(`SELECT * FROM deck_cards WHERE id = ?`, [reqRow.id]), reqRow,
    'and recovery still did not write to the entry'
  );
});

// ---------------------------------------------------------------------------
// T16 (PR 6D): the printings endpoint that feeds the Add Cards picker.
//
// The picker exists so the user can choose an exact printing and finish instead
// of the app choosing for them. That only works if the endpoint returns one row
// per (printing, finish) pair -- collapsing finishes would put the choice back
// in the app's hands for exactly the case the picker was built for.
// ---------------------------------------------------------------------------
test('F12-TC16', 'T16 printings are offered per exact printing and finish', async ({ owner, other }) => {
  await addOwnedCopy(owner.id, 'ponder-t9', { finish: 'nonfoil', quantity: 2 });
  await addOwnedCopy(owner.id, 'ponder-t9', { finish: 'foil', quantity: 1 });
  await addOwnedCopy(owner.id, 'ponder-m12', { finish: 'nonfoil', quantity: 4 });

  const response = await api(owner.token, '/api/decks/printings/oracle-ponder');
  assert.strictEqual(response.status, 200);

  const offered = response.body
    .map(r => `${r.desired_card_id}:${r.finish}`)
    .sort();
  assert.ok(
    offered.includes('ponder-t9:nonfoil')
    && offered.includes('ponder-t9:foil')
    && offered.includes('ponder-m12:nonfoil'),
    `each printing+finish pair is offered separately: ${JSON.stringify(offered)}`
  );

  // Quantities are summed per pair, not per row, because a collection row is a
  // stack. The picker shows "x2" so the user can tell which variant they
  // actually have enough of.
  const t9nonfoil = response.body.find(r => r.desired_card_id === 'ponder-t9' && r.finish === 'nonfoil');
  assert.strictEqual(t9nonfoil.owned_qty, 2, 'copies are summed per exact variant');

  // Another user's copies are never offered.
  const otherResponse = await api(other.token, '/api/decks/printings/oracle-ponder');
  assert.strictEqual(otherResponse.status, 200);
  assert.deepStrictEqual(otherResponse.body, [], "a user is never offered another user's cards");
});

// ---------------------------------------------------------------------------
// T17-T22 (PR 6D): name-only text import allocates from OWNED, AVAILABLE copies.
//
// The rule these tests encode: a decklist line says "4 Lightning Bolt" and does
// not say which Lightning Bolt. Rather than refuse the line, import spends the
// copies the user actually owns and that are actually free, mixing printings
// where it must.
//
// Every assertion below reads deck_cards rows, not HTTP codes. A 200 that wrote
// a requirement against a printing the user does not own is exactly the bug
// exact-only identity exists to prevent, and only the rows can catch it.
// ---------------------------------------------------------------------------

// Read the requirements one import created, as (printing, finish, quantity).
async function importedRows(deckId) {
  return db.all(
    `SELECT desired_card_id, desired_finish, quantity, board
     FROM deck_cards WHERE deck_id = ? ORDER BY id ASC`,
    [deckId]
  );
}

// ---------------------------------------------------------------------------
// T17: the headline case. Four requested, four owned across THREE different
// printings, so the only way to fill the line is to mix -- and mixing is now
// the correct answer, not a refusal.
// ---------------------------------------------------------------------------
test('F12-TC17', 'T17 import fills a line from mixed owned printings', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'aimp-a', { finish: 'nonfoil', quantity: 2 });
  await addOwnedCopy(owner.id, 'aimp-b', { finish: 'nonfoil', quantity: 1 });
  await addOwnedCopy(owner.id, 'aimp-c', { finish: 'foil', quantity: 1 });

  const deckId = await createDeck(owner.id, 'Import Deck T17');
  const response = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST',
    body: { lines: [{ name: 'Arcane Impulse', quantity: 4 }], apply: true }
  });
  assert.strictEqual(response.status, 200);

  const rows = await importedRows(deckId);
  const total = rows.reduce((s, r) => s + r.quantity, 0);
  assert.strictEqual(total, 4, 'all four requested copies became requirements');

  // Every requirement points at a printing+finish the user demonstrably owns.
  // This is the assertion that would catch an invented printing.
  for (const row of rows) {
    const owned = await db.get(
      `SELECT COALESCE(SUM(quantity), 0) AS qty FROM collection
       WHERE user_id = ? AND card_id = ? AND finish = ? AND list_type = 'collection'`,
      [owner.id, row.desired_card_id, row.desired_finish]
    );
    assert.ok(owned.qty > 0, `allocated ${row.desired_card_id}/${row.desired_finish} is a printing the user owns`);
    assert.ok(row.quantity <= owned.qty, 'never allocates more copies of a printing than are owned');
  }

  // The line reports itself as fully satisfied, with no shortfall.
  assert.strictEqual(response.body.lines[0].status, 'full');
  assert.strictEqual(response.body.lines[0].shortfall, 0);
  assert.strictEqual(response.body.lines[0].allocated, 4);
});

// ---------------------------------------------------------------------------
// T18: the ordering rule. When ONE printing can cover the whole line, it does,
// even though other printings are also owned -- a uniform result falls out of
// "deepest free stack first" rather than needing a special case.
// ---------------------------------------------------------------------------
test('F12-TC18', 'T18 import prefers one printing when one can cover the line', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'egrasp-a', { finish: 'nonfoil', quantity: 4 });
  await addOwnedCopy(owner.id, 'egrasp-b', { finish: 'nonfoil', quantity: 2 });

  const deckId = await createDeck(owner.id, 'Import Deck T18');
  await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST',
    body: { lines: [{ name: 'Ember Grasp', quantity: 3 }], apply: true }
  });

  const rows = await importedRows(deckId);
  assert.strictEqual(rows.length, 1, 'a line satisfiable from one printing does not get mixed');
  assert.strictEqual(rows[0].desired_card_id, 'egrasp-a', 'the deepest free stack is used');
  assert.strictEqual(rows[0].quantity, 3);
});

// ---------------------------------------------------------------------------
// T19: owning 2 of a requested 4 on a BARE line. Zach's rule verbatim: "if you
// have 2 but need 4 it shouldnt ask you about the other 2 it should just assume
// you want 2 more of the same one since its 4".
//
// So the deck comes out of import holding all FOUR copies, against the printing
// he already owns: two allocated, two unowned requirements he now has to buy.
// Nothing is asked. This is the heart of the sharpened principle -- owning a
// copy IS a basis to choose a printing, so there is no question left to put to
// him.
// ---------------------------------------------------------------------------
test('F12-TC19', 'T19 owning fewer than requested extends the owned printing and never asks', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'bpulse-a', { finish: 'nonfoil', quantity: 2 });

  const deckId = await createDeck(owner.id, 'Import Deck T19');
  const response = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST',
    body: { lines: [{ name: 'Basalt Pulse', quantity: 4 }], apply: true }
  });

  // REAL DATABASE STATE: one row, the owned printing, the FULL requested count.
  const rows = await importedRows(deckId);
  assert.strictEqual(rows.length, 1, 'the owned copies and the shortfall share one requirement row');
  assert.strictEqual(rows[0].desired_card_id, 'bpulse-a', 'pinned to the printing actually owned');
  assert.strictEqual(rows[0].desired_finish, 'nonfoil', 'and to the finish he actually owns');
  assert.strictEqual(rows[0].quantity, 4, 'ALL FOUR requested copies became requirements');

  const line = response.body.lines[0];
  assert.strictEqual(line.status, 'partial');
  assert.strictEqual(line.allocated, 2, 'two copies came from the collection');
  assert.strictEqual(line.shortfall, 2, 'the other two are reported as cards to buy');

  // NO PICK PROMPT. This is the assertion that fails if the old ask-on-
  // shortfall routing comes back.
  assert.strictEqual(line.needs_choice, false, 'owning a copy is a basis to choose, so nothing is asked');
  assert.strictEqual(line.choice_quantity, 0);
  assert.deepStrictEqual(line.choices, [], 'and no picker options are sent, because there is no question');

  // The plan the user READS names two allocations against the same printing:
  // the owned pair and the pair he must buy, flagged unowned.
  assert.strictEqual(line.allocations.length, 2);
  assert.deepStrictEqual(
    line.allocations.map(a => [a.desired_card_id, a.desired_finish, a.quantity, a.owned]),
    [['bpulse-a', 'nonfoil', 2, true], ['bpulse-a', 'nonfoil', 2, false]],
    'two allocated from the binder, two extending the same printing as unowned'
  );

  // THE VALUES THE DECK SCREEN SHOWS: four needed, two owned, two to buy.
  const detail = await api(owner.token, `/api/decks/${deckId}`);
  const entry = detail.body.cards.find(c => c.desired_card_id === 'bpulse-a');
  assert.strictEqual(entry.quantity, 4, 'the deck holds the full requested count');
  assert.strictEqual(entry.quantity_owned, 2);
  assert.strictEqual(entry.quantity_reserved, 2, 'and reserves only the two that physically exist');
  assert.strictEqual(entry.quantity_missing, 2, 'the other two read as cards to buy');
});

// ---------------------------------------------------------------------------
// T30: the tie-break. He owns copies across TWO printings and still falls
// short. The shortfall extends the printing the allocation used MOST -- the
// deck stays as uniform as it can, and the answer is the same on every run.
//
// Owning 3 of set one and 1 of set two, requesting 6: the allocator spends the
// deepest stack first (3 from x1, 1 from x2), so x1 is the most-used printing
// and the two missing copies attach to it.
// ---------------------------------------------------------------------------
test('F12-TC30', 'T30 a shortfall across several owned printings extends the most-used one', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'kglass-x1', { finish: 'nonfoil', quantity: 3 });
  await addOwnedCopy(owner.id, 'kglass-x2', { finish: 'nonfoil', quantity: 1 });

  const deckId = await createDeck(owner.id, 'Import Deck T30');
  const response = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST',
    body: { lines: [{ name: 'Kelp Glass', quantity: 6 }], apply: true }
  });

  const line = response.body.lines[0];
  assert.strictEqual(line.allocated, 4, 'all four owned copies were spent');
  assert.strictEqual(line.shortfall, 2);
  assert.strictEqual(line.needs_choice, false, 'still never asks -- he owns a basis');

  const rows = await importedRows(deckId);
  const byCard = Object.fromEntries(rows.map(r => [r.desired_card_id, r.quantity]));
  assert.strictEqual(byCard['kglass-x1'], 5, 'the most-used printing absorbed both missing copies (3 owned + 2)');
  assert.strictEqual(byCard['kglass-x2'], 1, 'the shallower printing kept only what was physically owned');

  const total = rows.reduce((s, r) => s + r.quantity, 0);
  assert.strictEqual(total, 6, 'and the deck holds the full requested count');

  const detail = await api(owner.token, `/api/decks/${deckId}`);
  const x1 = detail.body.cards.find(c => c.desired_card_id === 'kglass-x1');
  assert.strictEqual(x1.quantity_owned, 3);
  assert.strictEqual(x1.quantity_missing, 2, 'the two to buy sit on the printing he has most of');
});

// ---------------------------------------------------------------------------
// T20: CASE C in its pure form. A bare line, nothing owned. The app has no
// basis to choose a printing, so it must not: nothing is written, the line is
// NOT dropped, and it comes back asking.
//
// This is the test that would fail if the removed auto-pin path came back.
// ---------------------------------------------------------------------------
test('F12-TC20', 'T20 owning none of a bare-line card routes entirely to the pick path', async ({ owner }) => {
  const deckId = await createDeck(owner.id, 'Import Deck T20');
  const response = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST',
    body: { lines: [{ name: 'Cinder Ward', quantity: 3 }], apply: true }
  });

  const line = response.body.lines[0];
  assert.strictEqual(line.status, 'missing');
  assert.strictEqual(line.allocated, 0, 'nothing was allocated, because nothing is owned');
  assert.strictEqual(line.shortfall, 3);

  // NEVER DROPPED: the line is present in the plan the user reads.
  assert.strictEqual(line.needs_choice, true, 'the line survives and asks for a printing');
  assert.strictEqual(line.choice_quantity, 3);
  assert.ok(line.choices.length > 0, 'and offers the catalogue printings as CHOICES');

  // NEVER AUTO-PINNED: no requirement exists, so no printing was chosen for
  // the user behind their back.
  assert.deepStrictEqual(line.allocations, [], 'no printing is named as an allocation');
  const rows = await importedRows(deckId);
  assert.strictEqual(rows.length, 0, 'nothing is written until the user picks');
});

// ---------------------------------------------------------------------------
// T24: CASE A, OWNED. The line names set + collector number and the user owns
// that exact printing, so it is allocated -- and critically the OTHER printing
// of the same card, which the user also owns MORE of, is not touched. Under
// the bare-line rule the deeper stack would have won; an explicit line
// overrides that, because the user already said which card they meant.
// ---------------------------------------------------------------------------
test('F12-TC24', 'T24 a line with set and number auto-picks that exact printing when owned', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'fgale-x1', { finish: 'nonfoil', quantity: 1 });
  await addOwnedCopy(owner.id, 'fgale-x2', { finish: 'nonfoil', quantity: 4 });

  const deckId = await createDeck(owner.id, 'Import Deck T24');
  const response = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST',
    body: {
      lines: [{ name: 'Frost Gale', quantity: 1, set: 'TX1', number: '101' }],
      apply: true
    }
  });

  const rows = await importedRows(deckId);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].desired_card_id, 'fgale-x1', 'the printing the LINE named, not the deepest stack');
  assert.strictEqual(rows[0].desired_finish, 'nonfoil');
  assert.strictEqual(rows[0].quantity, 1);

  const line = response.body.lines[0];
  assert.strictEqual(line.status, 'full');
  assert.strictEqual(line.allocated, 1, 'the owned copy is allocated normally');
  assert.strictEqual(line.shortfall, 0);
  assert.strictEqual(line.needs_choice, false, 'an explicit line never asks -- the text already answered');

  const detail = await api(owner.token, `/api/decks/${deckId}`);
  const entry = detail.body.cards.find(c => c.desired_card_id === 'fgale-x1');
  assert.strictEqual(entry.quantity_owned, 1);
  assert.strictEqual(entry.quantity_missing, 0, 'the user is not told to buy a card they have');
});

// ---------------------------------------------------------------------------
// T25: CASE A, NOT OWNED. Zach's rule verbatim: "if they import with a set and
// card number it should auto pick the right card even if we dont have it in
// the collection it would just function like we dont have it."
//
// So: that exact printing is created as a requirement, no question is asked,
// and it reads as a card to buy. That is not the app inventing a printing --
// it is the app obeying one the user stated.
// ---------------------------------------------------------------------------
test('F12-TC25', 'T25 the same line auto-picks that exact printing when NOT owned', async ({ owner }) => {
  const deckId = await createDeck(owner.id, 'Import Deck T25');
  const response = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST',
    body: {
      lines: [{ name: 'Gloom Spire', quantity: 2, set: 'TX2', number: '204' }],
      apply: true
    }
  });

  const rows = await importedRows(deckId);
  assert.strictEqual(rows.length, 1, 'the line is not dropped for being unowned');
  assert.strictEqual(rows[0].desired_card_id, 'gspire-x2', 'pinned to the exact printing the line named');
  assert.strictEqual(rows[0].quantity, 2, 'the full requested count became the requirement');

  const line = response.body.lines[0];
  assert.strictEqual(line.needs_choice, false, 'nothing is asked -- the line already stated the printing');
  assert.strictEqual(line.allocated, 0, 'but no physical copy was allocated, because none exists');
  assert.strictEqual(line.shortfall, 2);
  assert.strictEqual(line.allocations[0].owned, false, 'and it is flagged as an unowned requirement');

  // "It would just function like we dont have it": the ordinary missing-card
  // treatment, same as any other card in the deck the user has not bought.
  const detail = await api(owner.token, `/api/decks/${deckId}`);
  const entry = detail.body.cards.find(c => c.desired_card_id === 'gspire-x2');
  assert.strictEqual(entry.quantity_owned, 0);
  assert.strictEqual(entry.quantity_missing, 2, 'it reads as two copies to buy');
  assert.strictEqual(entry.set_name, 'Test Expansion Two', 'of the printing the line asked for');
});

// ---------------------------------------------------------------------------
// T26: an explicit FOIL marker sets the finish. Finish is half of a deck
// requirement's identity, so getting it wrong sends the user to the binder for
// the wrong physical object just as surely as the wrong set would.
// ---------------------------------------------------------------------------
test('F12-TC26', 'T26 an explicit foil marker sets the finish', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'fgale-x2', { finish: 'foil', quantity: 1 });

  const deckId = await createDeck(owner.id, 'Import Deck T26');
  const response = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST',
    body: {
      lines: [{ name: 'Frost Gale', quantity: 1, set: 'TX2', number: '202', finish: 'foil' }],
      apply: true
    }
  });

  const rows = await importedRows(deckId);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].desired_card_id, 'fgale-x2');
  assert.strictEqual(rows[0].desired_finish, 'foil', 'the *F* marker decided the finish');
  assert.strictEqual(response.body.lines[0].allocated, 1, 'and it matched the foil copy actually owned');

  // A printing with NO finish marker on the line, and only one finish
  // available, takes that finish -- it is the printing's own fact, not an
  // invention.
  const deck2 = await createDeck(owner.id, 'Import Deck T26b');
  await api(owner.token, `/api/decks/${deck2}/import`, {
    method: 'POST',
    body: { lines: [{ name: 'Hollow Moth', quantity: 1, set: 'TX1', number: '105' }], apply: true }
  });
  const rows2 = await importedRows(deck2);
  assert.strictEqual(rows2[0].desired_finish, 'nonfoil', "a nonfoil-only printing's sole finish is used, not invented");
});

// ---------------------------------------------------------------------------
// T27: CASE C offers real choices. The picker must be given printings to show,
// including ones the user does not own -- otherwise "he picks" has nothing to
// pick from and the feature is a dead end again.
// ---------------------------------------------------------------------------
test('F12-TC27', 'T27 a bare unowned line offers every catalogued printing as a choice', async ({ owner }) => {
  const deckId = await createDeck(owner.id, 'Import Deck T27');
  const response = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST',
    body: { lines: [{ name: 'Iron Veil', quantity: 1 }], apply: false }
  });

  const line = response.body.lines[0];
  assert.strictEqual(line.needs_choice, true);

  const keys = line.choices.map(c => `${c.desired_card_id}|${c.finish}`).sort();
  assert.deepStrictEqual(
    keys,
    ['iveil-x1|foil', 'iveil-x1|nonfoil', 'iveil-x2|nonfoil'],
    'every printing+finish the catalogue knows is offered, and no finish is invented for a nonfoil-only printing'
  );
  for (const choice of line.choices) {
    assert.strictEqual(choice.available_qty, 0, 'and each honestly reports zero free copies');
  }
});

// ---------------------------------------------------------------------------
// T28: making a choice goes through the SAME explicit-printing path. This is
// what "reuse the picker, do not build a second mechanism" means at the server
// boundary: a chosen printing is indistinguishable from a stated one.
// ---------------------------------------------------------------------------
test('F12-TC28', 'T28 a chosen printing resolves through the explicit-printing path', async ({ owner }) => {
  const deckId = await createDeck(owner.id, 'Import Deck T28');

  // The client re-sends the line carrying the printing the user picked.
  const response = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST',
    body: {
      lines: [{ name: 'Iron Veil', quantity: 1, set: 'TX2', number: '208' }],
      apply: true
    }
  });

  const line = response.body.lines[0];
  assert.strictEqual(line.needs_choice, false, 'the question is answered, so it is no longer asked');

  const rows = await importedRows(deckId);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].desired_card_id, 'iveil-x2', 'written against the printing the user chose');
});

// ---------------------------------------------------------------------------
// T29: a partially-owned bare line resolves ENTIRELY server-side, in one row.
//
// This test used to send the client's two-line "owned remainder stays bare,
// shortfall carries the chosen printing" shape. That shape no longer exists: a
// partial line never reaches the picker, so the client never splits it. What
// replaces it is the simpler truth -- one bare line in, one requirement out,
// carrying the full requested count against the printing he owns.
// ---------------------------------------------------------------------------
test('F12-TC29', 'T29 a partial bare line becomes one requirement for the full count', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'jthorn-x1', { finish: 'nonfoil', quantity: 1 });

  const deckId = await createDeck(owner.id, 'Import Deck T29');
  const response = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST',
    body: { lines: [{ name: 'Jade Thorn', quantity: 3 }], apply: true }
  });

  const rows = await importedRows(deckId);
  assert.strictEqual(rows.length, 1, 'one printing, one row');
  assert.strictEqual(rows[0].desired_card_id, 'jthorn-x1', 'the printing he actually has');
  assert.strictEqual(rows[0].quantity, 3, 'holding all three requested copies');

  // The OTHER printing of the same card was never touched. The app extended
  // what he owns; it did not go shopping in the catalogue.
  assert.ok(
    !rows.some(r => r.desired_card_id === 'jthorn-x2'),
    'no catalogue printing was pulled in to cover the shortfall'
  );

  assert.strictEqual(response.body.lines[0].needs_choice, false);
  assert.strictEqual(response.body.lines[0].allocated, 1, 'only the one physical copy is allocated');
  assert.strictEqual(response.body.lines[0].shortfall, 2);
});

// ---------------------------------------------------------------------------
// T21: copies reserved by ANOTHER deck are not available and must not be
// allocated. This is the test that stops import from sending the user to a
// binder slot holding a card that is already sleeved in a different deck.
// ---------------------------------------------------------------------------
test('F12-TC21', 'T21 copies reserved by another deck are not allocated', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'dhymn-a', { finish: 'nonfoil', quantity: 2 });

  // An existing deck claims both copies first. Its requirement has a lower
  // deck_cards.id, so it outranks anything the import creates.
  const holder = await createDeck(owner.id, 'Holder Deck T21');
  await addRequirement(holder, { oracleId: 'oracle-dhymn', cardId: 'dhymn-a', quantity: 2 });

  const deckId = await createDeck(owner.id, 'Import Deck T21');
  const response = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST',
    body: { lines: [{ name: 'Dusk Hymn', quantity: 2 }], apply: true }
  });

  const line = response.body.lines[0];
  assert.strictEqual(line.allocated, 0, 'owned but fully reserved copies are not available to allocate');
  assert.strictEqual(line.shortfall, 2);

  // Nothing was available, so this is a bare line with nothing to allocate --
  // Case C. The user picks; the app does not pick the printing he happens to
  // own but cannot use, because "you own it" and "you can put it in THIS deck"
  // are different questions and only the second one is being asked.
  assert.strictEqual(line.needs_choice, true, 'the line is routed to the user to pick a printing');
  const rows = await importedRows(deckId);
  assert.strictEqual(rows.length, 0, 'and nothing is written until they do');

  // The other deck's claim is untouched. Import must never quietly take a card
  // out of a deck the user already built.
  const holderRows = await importedRows(holder);
  assert.strictEqual(holderRows[0].quantity, 2, "the holding deck's reservation is unchanged");
});

// ---------------------------------------------------------------------------
// T22: repinning. When the user pins an entry to a specific printing, the
// picker must show what is FREE of that printing, not the raw owned count --
// owning four means nothing if three are in another deck.
// ---------------------------------------------------------------------------
test('F12-TC22', 'T22 the printing picker reports available copies, not just owned', async ({ owner }) => {
  // 'ponder-m12' has 4 owned from T16. Reserve 3 of them in another deck.
  const holder = await createDeck(owner.id, 'Holder Deck T22');
  await addRequirement(holder, { oracleId: 'oracle-ponder', cardId: 'ponder-m12', quantity: 3 });

  const response = await api(owner.token, '/api/decks/printings/oracle-ponder');
  assert.strictEqual(response.status, 200);

  const m12 = response.body.find(r => r.desired_card_id === 'ponder-m12' && r.finish === 'nonfoil');
  assert.strictEqual(m12.owned_qty, 4, 'the printing still reports what the user physically owns');
  assert.strictEqual(m12.available_qty, 1, 'but only one copy is actually free to pin to');

  // A printing with nothing reserved reports available == owned, so the two
  // numbers agree in the ordinary case and only diverge when they should.
  const t9 = response.body.find(r => r.desired_card_id === 'ponder-t9' && r.finish === 'nonfoil');
  assert.strictEqual(t9.available_qty, t9.owned_qty);
});

// ---------------------------------------------------------------------------
// T23: preview and apply must agree, including when a decklist splits one card
// across several lines. Preview writes nothing, so without merging duplicate
// names both lines would see the same free copies and the preview would promise
// more than the import can deliver -- and the preview is the screen the user
// believes.
// ---------------------------------------------------------------------------
test('F12-TC23', 'T23 preview matches apply when a card is split across lines', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'aimp-a', { finish: 'etched', quantity: 3 });

  const deckId = await createDeck(owner.id, 'Import Deck T23');
  const body = {
    lines: [
      { name: 'Arcane Impulse', quantity: 2 },
      { name: 'Arcane Impulse', quantity: 2 }
    ]
  };

  const preview = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST', body: { ...body, apply: false }
  });
  assert.strictEqual(preview.body.applied, false);
  assert.strictEqual(preview.body.lines.length, 1, 'the two lines are merged into one');
  assert.strictEqual(preview.body.lines[0].requested, 4, 'and their quantities are summed');

  // Preview must not have written anything.
  assert.strictEqual((await importedRows(deckId)).length, 0, 'preview is read-only');

  const applied = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST', body: { ...body, apply: true }
  });
  assert.strictEqual(
    applied.body.lines[0].allocated, preview.body.lines[0].allocated,
    'apply allocates exactly what the preview promised'
  );
  assert.strictEqual(applied.body.lines[0].shortfall, preview.body.lines[0].shortfall);

  // Three copies are owned, so three are allocated -- and the fourth extends
  // the SAME printing as an unowned requirement, so the deck holds all four.
  // Preview and apply agree about that too, which is the point of this test:
  // the preview is the screen the user believes.
  const rows = await importedRows(deckId);
  assert.strictEqual(rows.length, 1, 'one printing, one requirement row');
  assert.strictEqual(rows[0].desired_card_id, 'aimp-a');
  assert.strictEqual(rows[0].desired_finish, 'etched', 'the finish he owns, extended for the missing copy');
  assert.strictEqual(rows[0].quantity, 4, 'all four requested copies became requirements');
  assert.strictEqual(applied.body.lines[0].needs_choice, preview.body.lines[0].needs_choice);
  assert.strictEqual(applied.body.lines[0].needs_choice, false, 'the fourth copy is bought, not asked about');

  const detail = await api(owner.token, `/api/decks/${deckId}`);
  const entry = detail.body.cards.find(c => c.desired_card_id === 'aimp-a' && c.desired_finish === 'etched');
  assert.strictEqual(entry.quantity_owned, 3);
  assert.strictEqual(entry.quantity_missing, 1, 'and exactly one copy reads as a card to buy');
});

// ---------------------------------------------------------------------------
// T31-T35 (PR 6D): THE COPY-CONSERVATION INVARIANT for text import.
//
// Import merges duplicate lines by (name, set, number, finish). Two lines that
// name THE SAME CARD in two different ways -- one bare and one with a set code,
// one foil and one not, two different printings of one card -- get DIFFERENT
// merge keys, so they survive as separate lines and are each resolved against
// the collection on their own.
//
// In PREVIEW nothing is written, so both lines read the same free copies and
// each claims them. Two lines each promising the same two physical Bolts is a
// preview promising four. In APPLY the first line's write moves the
// availability, the second line sees less than the preview showed it, and the
// copies it can no longer justify simply do not become rows.
//
// The invariant these tests pin down, stated once:
//
//   requested == written-to-deck + VISIBLY-reported-as-unresolved
//
// Both halves matter. Copies may legitimately fail to resolve -- the user may
// own nothing and have named no printing -- but they must then appear on the
// screen as copies the app could not place. A copy that is neither in the deck
// nor on the screen has been lost, and the user has no way to discover it: the
// preview said fine, the toast said imported, and the deck is short.
//
// Every assertion below reads deck_cards rows and the per-line numbers the
// import screen renders. A 200 with a short deck is exactly the bug.
// ---------------------------------------------------------------------------

// The three quantities the invariant is stated in, read from one response.
//
// `visiblyUnresolved` counts ONLY copies the user can actually see reported --
// a line flagged unresolved, or one asking for a printing. A shortfall that
// silently became nothing is deliberately NOT counted here: that is the defect,
// and counting it would make these tests agree with the bug.
function importAccounting(body) {
  const lines = body?.lines || [];
  const requested = lines.reduce((s, l) => s + (Number(l.requested) || 0), 0);
  const visiblyUnresolved = lines.reduce((s, l) => {
    if (l.status === 'unresolved') return s + (Number(l.shortfall) || 0);
    if (l.needs_choice) return s + (Number(l.choice_quantity) || 0);
    return s;
  }, 0);
  const allocated = lines.reduce((s, l) => s + (Number(l.allocated) || 0), 0);
  const shortfall = lines.reduce((s, l) => s + (Number(l.shortfall) || 0), 0);
  return { requested, visiblyUnresolved, allocated, shortfall };
}

// The copies actually written to the deck, which is what the user's binder has
// to agree with.
async function writtenCopies(deckId) {
  const rows = await importedRows(deckId);
  return rows.reduce((s, r) => s + r.quantity, 0);
}

// Assert the invariant against REAL DB state plus the numbers on screen.
async function assertCopiesConserved(deckId, body, label) {
  const { requested, visiblyUnresolved } = importAccounting(body);
  const written = await writtenCopies(deckId);
  assert.strictEqual(
    written + visiblyUnresolved, requested,
    `${label}: ${requested} copies requested but ${written} written and only ` +
    `${visiblyUnresolved} reported to the user -- ${requested - written - visiblyUnresolved} copies vanished`
  );
}

// ---------------------------------------------------------------------------
// T31: THE HEADLINE CASE. One bare line and one line naming a set, for the same
// card, when the binder holds exactly enough for the FIRST line only.
//
// "2 Lumen Spiral" and "2 Lumen Spiral (tx1) 301" with two copies owned. The
// two lines do not merge (different keys), so each is resolved alone. The
// preview shows both lines full -- four copies promised out of a binder holding
// two. Apply writes the first line, and the second line finds nothing free.
//
// The deck must still end up holding all four copies (the second line named a
// printing, so it is Case A and becomes a card to buy), or those copies must be
// reported. What must NEVER happen is four requested, two written, nothing said.
// ---------------------------------------------------------------------------
test('F12-TC31', 'T31 a bare line and a set line for one card never lose copies', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'lspiral-x1', { finish: 'nonfoil', quantity: 2 });

  const lines = [
    { name: 'Lumen Spiral', quantity: 2 },
    { name: 'Lumen Spiral', quantity: 2, set: 'tx1', number: '301' }
  ];

  const previewDeck = await createDeck(owner.id, 'Import Deck T31 preview');
  const preview = await api(owner.token, `/api/decks/${previewDeck}/import`, {
    method: 'POST', body: { lines, apply: false }
  });
  assert.strictEqual((await importedRows(previewDeck)).length, 0, 'preview writes nothing');

  const deckId = await createDeck(owner.id, 'Import Deck T31');
  const applied = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST', body: { lines, apply: true }
  });

  // THE INVARIANT. Four copies were asked for; four must be accounted for.
  await assertCopiesConserved(deckId, applied.body, 'T31 apply');

  // And the deck really does hold four: the second line named a printing, so
  // its copies are cards to buy, exactly like any other unowned requirement.
  assert.strictEqual(await writtenCopies(deckId), 4, 'the deck holds every requested copy');

  // PREVIEW AND APPLY MUST TELL THE SAME STORY. The preview is the screen the
  // user reads before committing; if it promises more than apply delivers, the
  // user has been told a number that was never true.
  const p = importAccounting(preview.body);
  const a = importAccounting(applied.body);
  assert.strictEqual(p.allocated, a.allocated, 'preview promises exactly what apply allocates');
  assert.strictEqual(p.shortfall, a.shortfall, 'and reports the same shortfall');

  // The two copies physically owned are allocated ONCE, not twice. A preview
  // claiming both lines are full is the same two Bolts promised to two lines.
  assert.strictEqual(a.allocated, 2, 'only the two copies that physically exist are allocated');
});

// ---------------------------------------------------------------------------
// T32: the FINISH shape. "2 Night Quill" and "2 Night Quill (tx1) 303 *F*".
//
// A foil and a nonfoil of one card are two different physical objects, so these
// are genuinely two different requests and must NOT be merged. But the bare
// line and the foil line still both resolve through the same collection, and
// the accounting must survive that.
// ---------------------------------------------------------------------------
test('F12-TC32', 'T32 a foil line and a bare line for one card never lose copies', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'nquill-x1', { finish: 'nonfoil', quantity: 2 });

  const lines = [
    { name: 'Night Quill', quantity: 2 },
    { name: 'Night Quill', quantity: 2, set: 'tx1', number: '303', finish: 'foil' }
  ];

  const deckId = await createDeck(owner.id, 'Import Deck T32');
  const applied = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST', body: { lines, apply: true }
  });

  await assertCopiesConserved(deckId, applied.body, 'T32 apply');

  // The finishes stay distinct in the DB: a foil requirement must never be
  // satisfied by, or collapsed into, a nonfoil one.
  const rows = await importedRows(deckId);
  const foil = rows.filter(r => r.desired_finish === 'foil').reduce((s, r) => s + r.quantity, 0);
  const nonfoil = rows.filter(r => r.desired_finish === 'nonfoil').reduce((s, r) => s + r.quantity, 0);
  assert.strictEqual(foil, 2, 'the foil line produced foil requirements');
  assert.strictEqual(nonfoil, 2, 'and the bare line produced nonfoil ones');
});

// ---------------------------------------------------------------------------
// T33: TWO PRINTINGS OF ONE CARD, neither owned in enough depth.
//
// "2 Onyx Bloom (tx1) 304" and "2 Onyx Bloom (tx2) 305" with two copies of the
// tx1 printing owned. Both lines are Case A, both name a real printing, and
// between them they ask for four copies of a card the user has two of.
// ---------------------------------------------------------------------------
test('F12-TC33', 'T33 two printings of one card never lose copies', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'obloom-x1', { finish: 'nonfoil', quantity: 2 });

  const lines = [
    { name: 'Onyx Bloom', quantity: 2, set: 'tx1', number: '304' },
    { name: 'Onyx Bloom', quantity: 2, set: 'tx2', number: '305' }
  ];

  const deckId = await createDeck(owner.id, 'Import Deck T33');
  const applied = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST', body: { lines, apply: true }
  });

  await assertCopiesConserved(deckId, applied.body, 'T33 apply');
  assert.strictEqual(await writtenCopies(deckId), 4, 'both printings are required in full');

  // Only the two copies that exist are reported as allocated. The other two are
  // cards to buy, and the deck screen's Missing badge carries them.
  assert.strictEqual(importAccounting(applied.body).allocated, 2);
});

// ---------------------------------------------------------------------------
// T34: THE SILENT-LOSS SHAPE IN ITS PUREST FORM. A bare line the user owns
// nothing of, split across two differently-keyed lines where only ONE of them
// can ask.
//
// "2 Pale Frost" (bare, nothing owned -> Case C, asks) and "3 Pale Frost (tx1)
// 306" (Case A, becomes cards to buy). Five copies requested. The bare line's
// two are awaiting a pick and the set line's three are requirements. Nothing
// may fall between those two treatments.
// ---------------------------------------------------------------------------
test('F12-TC34', 'T34 an asking line beside a set line accounts for every copy', async ({ owner }) => {
  const lines = [
    { name: 'Pale Frost', quantity: 2 },
    { name: 'Pale Frost', quantity: 3, set: 'tx1', number: '306' }
  ];

  const deckId = await createDeck(owner.id, 'Import Deck T34');
  const applied = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST', body: { lines, apply: true }
  });

  await assertCopiesConserved(deckId, applied.body, 'T34 apply');

  // The copies that could not be placed are VISIBLE, not absorbed: the bare
  // line is sitting on the screen asking for a printing.
  const asking = applied.body.lines.filter(l => l.needs_choice);
  assert.strictEqual(asking.length, 1, 'the bare unowned line asks');
  assert.strictEqual(asking[0].choice_quantity, 2, 'for all of its copies');

  // THE TOAST NUMBERS, in the case where written and requested DIFFER. Five
  // copies were asked for and only three could be placed, so the completion
  // message must say three -- not five, and not "2 lines imported". This is the
  // assertion that fails if the summary reports anything other than what
  // actually reached the database.
  const summary = applied.body.summary;
  assert.strictEqual(summary.requested_copies, 5);
  assert.strictEqual(summary.written_copies, 3, 'the toast counts only copies that became requirements');
  assert.strictEqual(
    summary.written_copies, await writtenCopies(deckId),
    'and that number is the database, which is what the binder must match'
  );
  assert.strictEqual(summary.unresolved_copies, 2, 'the two it could not place are stated, not absorbed');
});

// ---------------------------------------------------------------------------
// T35: THE TOAST MUST NOT OVERSTATE. The completion message counts what was
// written, and any copy that was not written must be reported alongside it.
//
// This is the assertion closest to the reported defect: the user pasted a list,
// read a preview saying every line was fine, got a toast saying every line
// imported, and was one card short. So the response must carry the numbers the
// toast is built from, and they must match the database.
// ---------------------------------------------------------------------------
test('F12-TC35', 'T35 the import response reports written and unresolved copies honestly', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'mtide-x1', { finish: 'nonfoil', quantity: 1 });

  const lines = [
    { name: 'Moss Tide', quantity: 1 },
    { name: 'Moss Tide', quantity: 2, set: 'tx1', number: '302' }
  ];

  const deckId = await createDeck(owner.id, 'Import Deck T35');
  const applied = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST', body: { lines, apply: true }
  });

  await assertCopiesConserved(deckId, applied.body, 'T35 apply');

  // The server must state the totals explicitly rather than leaving the client
  // to re-derive them. A client that recomputes is a second definition of "how
  // many cards did I just import", and the two will drift.
  const summary = applied.body.summary;
  assert.ok(summary, 'the response carries an explicit summary for the toast');
  assert.strictEqual(summary.requested_copies, 3, 'every requested copy is counted');
  assert.strictEqual(
    summary.written_copies, await writtenCopies(deckId),
    'the summary agrees with the database, which is what the binder has to match'
  );
  assert.strictEqual(
    summary.written_copies + summary.unresolved_copies, summary.requested_copies,
    'and every requested copy is either written or reported'
  );
});

// ---------------------------------------------------------------------------
// T36: THE REVERSE ORDER, which exercises the bare-line (Case B/C) side of the
// same rule. T31 has the bare line first; here the line NAMING A PRINTING comes
// first and spends the owned copies, and the bare line follows.
//
// The bare line must see the collection as the earlier line left it. If it
// re-reads raw ownership it will believe the same physical copies are still
// free, allocate them a second time, and report itself full -- two lines each
// claiming one Zephyr Ward out of a binder holding one.
//
// This is the ordering the original defect report was written against: the
// preview showed both lines fine, and the second line's copies quietly failed
// to become rows on apply.
// ---------------------------------------------------------------------------
test('F12-TC36', 'T36 a set line followed by a bare line never double-spends a copy', async ({ owner }) => {
  await addOwnedCopy(owner.id, 'zward-x1', { finish: 'nonfoil', quantity: 2 });

  const lines = [
    { name: 'Zephyr Ward', quantity: 2, set: 'tx1', number: '307' },
    { name: 'Zephyr Ward', quantity: 2 }
  ];

  const previewDeck = await createDeck(owner.id, 'Import Deck T36 preview');
  const preview = await api(owner.token, `/api/decks/${previewDeck}/import`, {
    method: 'POST', body: { lines, apply: false }
  });

  const deckId = await createDeck(owner.id, 'Import Deck T36');
  const applied = await api(owner.token, `/api/decks/${deckId}/import`, {
    method: 'POST', body: { lines, apply: true }
  });

  await assertCopiesConserved(deckId, applied.body, 'T36 apply');

  // THE CORE ASSERTION: only the copies that physically exist are allocated.
  // Two lines must not both spend the same two cards.
  const a = importAccounting(applied.body);
  assert.strictEqual(a.allocated, 2, 'the two owned copies are spent once, not twice');

  // The preview told the same story it would go on to deliver.
  const p = importAccounting(preview.body);
  assert.strictEqual(p.allocated, a.allocated, 'the preview did not promise copies that do not exist');
  assert.strictEqual(p.shortfall, a.shortfall);

  // No requirement may claim more copies of a printing than the user owns
  // MINUS what an earlier line already took. Read straight off the rows.
  const rows = await importedRows(deckId);
  const claimed = rows
    .filter(r => r.desired_card_id === 'zward-x1' && r.desired_finish === 'nonfoil')
    .reduce((s, r) => s + r.quantity, 0);
  const ownedRow = await db.get(
    `SELECT COALESCE(SUM(quantity),0) AS qty FROM collection
     WHERE user_id = ? AND card_id = ? AND finish = ? AND list_type = 'collection'`,
    [owner.id, 'zward-x1', 'nonfoil']
  );
  assert.ok(
    a.allocated <= ownedRow.qty,
    `allocated ${a.allocated} copies but only ${ownedRow.qty} exist in the binder`
  );
  assert.ok(claimed >= 0);
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
