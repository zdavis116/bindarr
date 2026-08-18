// PR 6E: MTG finishes are storable, canonical, and identity-bearing.
//
// Every case here goes through the REAL HTTP routes. That is the entire point
// of this file. The bug it was written for -- a Pokemon-era CHECK constraint
// that made every foil add return 500 -- survived a green suite because every
// existing fixture inserted collection rows with direct SQL, using values that
// already satisfied the constraint. A constraint on a column can only be proven
// by the code path that actually writes that column.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-mtg-finishes-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';
const db = require('../../src/db');
const collectionRoutes = require('../../src/routes/collection');
const importExportRoutes = require('../../src/routes/importExport');
const deckRoutes = require('../../src/routes/decks');

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

const tests = [];
function test(id, name, fn) { tests.push({ id, name, fn }); }

// ---------------------------------------------------------------------------
// T1: the bug, stated as a test. Adding a FOIL card through the real add route
// must succeed and must store the canonical MTG finish.
//
// Before the fix this returned HTTP 500 with
//   SQLITE_CONSTRAINT: CHECK constraint failed:
//   printing IN ('Normal','Holofoil','Reverse Holofoil','1st Edition','Promo')
// ---------------------------------------------------------------------------
test('F12-TC1', 'T1 adding a foil card succeeds and stores finish=foil', async ({ user, cardId }) => {
  const response = await api(user.token, '/api/collection', {
    method: 'POST',
    body: { card_id: cardId, printing: 'Foil' }
  });
  assert.strictEqual(response.status, 200, `foil add must succeed: ${JSON.stringify(response.body)}`);

  const row = await db.get(
    `SELECT finish FROM collection WHERE id = ?`, [response.body.id]
  );
  assert.strictEqual(row.finish, 'foil', 'a foil add must store the canonical finish, not the nonfoil default');
});

// ---------------------------------------------------------------------------
// T2: the ordinary case still works, and still stores 'nonfoil'.
// A fix that made every card foil would also make T1 pass.
// ---------------------------------------------------------------------------
test('F12-TC2', 'T2 adding a nonfoil card still succeeds and stores finish=nonfoil', async ({ user, cardId }) => {
  const response = await api(user.token, '/api/collection', {
    method: 'POST',
    body: { card_id: cardId, printing: 'Normal' }
  });
  assert.strictEqual(response.status, 200, `nonfoil add must succeed: ${JSON.stringify(response.body)}`);

  const row = await db.get(`SELECT finish FROM collection WHERE id = ?`, [response.body.id]);
  assert.strictEqual(row.finish, 'nonfoil', 'a normal add must store nonfoil');
});

// ---------------------------------------------------------------------------
// T3: etched is a real Magic finish and must be storable end to end.
// ---------------------------------------------------------------------------
test('F12-TC3', 'T3 adding an etched card succeeds and stores finish=etched', async ({ user, cardId }) => {
  const response = await api(user.token, '/api/collection', {
    method: 'POST',
    body: { card_id: cardId, printing: 'Etched' }
  });
  assert.strictEqual(response.status, 200, `etched add must succeed: ${JSON.stringify(response.body)}`);

  const row = await db.get(`SELECT finish FROM collection WHERE id = ?`, [response.body.id]);
  assert.strictEqual(row.finish, 'etched', 'an etched add must store etched');
});

// ---------------------------------------------------------------------------
// T4: the canonical finish vocabulary is accepted directly.
//
// The API historically took a display-form `printing` field. Canonical finish
// values are the source of truth everywhere else in the app, so the write path
// must accept them without a caller having to translate back into display form.
// ---------------------------------------------------------------------------
test('F12-TC4', 'T4 the canonical finish vocabulary is accepted on the add route', async ({ user, cardId }) => {
  for (const finish of ['nonfoil', 'foil', 'etched']) {
    const response = await api(user.token, '/api/collection', {
      method: 'POST',
      body: { card_id: cardId, finish }
    });
    assert.strictEqual(response.status, 200, `finish=${finish} must be accepted: ${JSON.stringify(response.body)}`);
    const row = await db.get(`SELECT finish FROM collection WHERE id = ?`, [response.body.id]);
    assert.strictEqual(row.finish, finish, `finish=${finish} must round-trip unchanged`);
  }
});

// ---------------------------------------------------------------------------
// T5: an unknown finish is REFUSED, not silently coerced.
//
// Zach's standing rule: when an operation cannot complete correctly, error out
// rather than produce a wrong result. Silently storing a Pokemon finish as
// 'nonfoil' would put a card in the binder that the app describes wrongly, and
// the user has no way to reconcile that against the physical card.
// ---------------------------------------------------------------------------
test('F12-TC5', 'T5 a non-MTG finish is refused rather than silently coerced', async ({ user, cardId }) => {
  const before = (await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ?`, [user.id])).n;

  for (const bogus of ['Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo']) {
    const response = await api(user.token, '/api/collection', {
      method: 'POST',
      body: { card_id: cardId, printing: bogus }
    });
    assert.strictEqual(response.status, 400, `${bogus} must be refused with 400, got ${response.status}`);
  }

  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM collection WHERE user_id = ?`, [user.id])).n, before,
    'a refused add must write nothing at all'
  );
});

// ---------------------------------------------------------------------------
// T6: finish round-trips through the READ path the UI actually renders from.
//
// Storing the right value is only half the promise. If GET /api/collection does
// not report the finish back, the collection screen cannot tell a foil from a
// nonfoil and the user sees a list that does not match their binder.
// ---------------------------------------------------------------------------
test('F12-TC6', 'T6 finish round-trips through the collection read path', async ({ user, cardId }) => {
  const added = await api(user.token, '/api/collection', {
    method: 'POST',
    body: { card_id: cardId, printing: 'Foil' }
  });
  assert.strictEqual(added.status, 200, `setup add must succeed: ${JSON.stringify(added.body)}`);

  const list = await api(user.token, '/api/collection');
  assert.strictEqual(list.status, 200, `collection read must succeed: ${JSON.stringify(list.body)}`);

  const items = Array.isArray(list.body) ? list.body : (list.body.items || list.body.cards || []);
  const entry = items.find(i => (i.entry_id || i.id) === added.body.id);
  assert.ok(entry, 'the added entry must appear in the collection read');
  assert.strictEqual(entry.finish, 'foil', 'the read path must report the canonical finish');
});

// ---------------------------------------------------------------------------
// T7: THE REASON THIS MATTERS. A deck requirement for a FOIL printing must be
// satisfied only by foil copies -- the nonfoil of the very same printing must
// not count.
//
// This is the promise PR 6C made and that the storage bug silently broke: if a
// foil can't be stored, exact-only identity is meaningless for every foil card
// Zach owns, and the app would tell him he needs to buy a card sitting in his
// binder.
// ---------------------------------------------------------------------------
test('F12-TC7', 'T7 a foil deck requirement is not satisfied by the nonfoil of the same printing', async ({ user, isolatedCardId }) => {
  // Deliberately a DIFFERENT card from the other cases. Earlier tests add foil
  // copies of the shared card, and those copies are legitimately owned -- so
  // asserting "0 owned" against the shared card would be testing the test's
  // setup rather than the finish-matching rule.
  const cardId = isolatedCardId;

  // Own exactly ONE nonfoil copy of this printing, through the real route.
  const nonfoil = await api(user.token, '/api/collection', {
    method: 'POST',
    body: { card_id: cardId, finish: 'nonfoil' }
  });
  assert.strictEqual(nonfoil.status, 200, `nonfoil setup add must succeed: ${JSON.stringify(nonfoil.body)}`);

  const deck = await api(user.token, '/api/decks', {
    method: 'POST',
    body: { name: `Foil Identity Deck ${process.pid}` }
  });
  assert.strictEqual(deck.status, 201, `deck create must succeed: ${JSON.stringify(deck.body)}`);
  const deckId = deck.body.id ?? deck.body.deck_id;

  // Require the FOIL of that same printing.
  const required = await api(user.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: { desired_card_id: cardId, desired_finish: 'foil', board: 'mainboard', quantity: 1 }
  });
  assert.strictEqual(required.status, 200, `foil requirement must be accepted: ${JSON.stringify(required.body)}`);

  const before = await api(user.token, `/api/decks/${deckId}`);
  assert.strictEqual(before.status, 200, `deck read must succeed: ${JSON.stringify(before.body)}`);
  const entryBefore = (before.body.entries || before.body.cards || [])
    .find(e => e.desired_finish === 'foil');
  assert.ok(entryBefore, 'the foil requirement must be present on the deck');
  assert.strictEqual(entryBefore.quantity_owned, 0, 'the nonfoil copy must NOT count towards a foil requirement');
  assert.strictEqual(entryBefore.quantity_missing, 1, 'the user must still be told to buy the foil');

  // Now actually acquire the foil. The same requirement must become satisfied.
  const foil = await api(user.token, '/api/collection', {
    method: 'POST',
    body: { card_id: cardId, finish: 'foil' }
  });
  assert.strictEqual(foil.status, 200, `foil add must succeed: ${JSON.stringify(foil.body)}`);

  const after = await api(user.token, `/api/decks/${deckId}`);
  const entryAfter = (after.body.entries || after.body.cards || [])
    .find(e => e.desired_finish === 'foil');
  assert.strictEqual(entryAfter.quantity_owned, 1, 'the foil copy must satisfy the foil requirement');
  assert.strictEqual(entryAfter.quantity_missing, 0, 'nothing should remain missing once the foil is owned');
});

// ---------------------------------------------------------------------------
// T8: CSV export works at all, and reports the correct finish.
//
// The export route was selecting `c.sub_location_1`, a column db.js drops on
// upgrade, so GET /api/export returned 500 for every user regardless of
// finishes. Nothing caught it because no test called the route. Once fixed, the
// exporter also has to read the canonical finish -- it previously tested
// `printing === 'Holofoil'`, which MTG rows can never hold, so every foil would
// have exported as a nonfoil.
// ---------------------------------------------------------------------------
test('F12-TC8', 'T8 CSV export succeeds and reports the correct finish', async ({ user, exportCardId }) => {
  const foil = await api(user.token, '/api/collection', {
    method: 'POST',
    body: { card_id: exportCardId, finish: 'foil' }
  });
  assert.strictEqual(foil.status, 200, `setup add must succeed: ${JSON.stringify(foil.body)}`);

  const response = await fetch(`${base}/api/export?ecosystem=tcgplayer`, {
    headers: { Authorization: `Bearer ${user.token}` }
  });
  assert.strictEqual(response.status, 200, 'export must not 500');

  const csv = await response.text();
  const line = csv.split('\n').find(l => l.includes('Export Bolt'));
  assert.ok(line, `the exported card must appear in the CSV: ${csv}`);
  assert.ok(line.includes('Foil'), `a foil must export as Foil, got: ${line}`);
});

async function main() {
  await db.initDb();
  const user = await createUser('pr6e-user');
  const cardId = 'pr6e-card';
  const oracleId = 'pr6e-oracle';
  const isolatedCardId = 'pr6e-card-isolated';
  await db.run(
    `INSERT INTO card_cache (id, oracle_id, name, set_name, number, finishes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [cardId, oracleId, 'Finish Bolt', 'Test Set', '1', JSON.stringify(['nonfoil', 'foil', 'etched'])]
  );
  // A card no other case touches, so T7 can assert exact ownership counts.
  await db.run(
    `INSERT INTO card_cache (id, oracle_id, name, set_name, number, finishes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [isolatedCardId, 'pr6e-oracle-isolated', 'Identity Bolt', 'Test Set', '2', JSON.stringify(['nonfoil', 'foil'])]
  );

  // A card only the export case uses, so its CSV line is unambiguous.
  const exportCardId = 'pr6e-card-export';
  await db.run(
    `INSERT INTO card_cache (id, oracle_id, name, set_name, set_id, number, finishes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [exportCardId, 'pr6e-oracle-export', 'Export Bolt', 'Test Set', 'tst', '3', JSON.stringify(['nonfoil', 'foil'])]
  );

  const app = express();
  app.use(express.json());
  // Mount points must match src/server.js exactly. The collection router
  // declares full paths internally and mounts bare; the decks router mounts
  // under /api/decks. Guessing either way tests a route the app does not serve.
  app.use('/api', collectionRoutes);
  app.use('/api/decks', deckRoutes);
  app.use('/api', importExportRoutes);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const context = { user, cardId, oracleId, isolatedCardId, exportCardId };
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
  if (failed > 0) throw new Error(`${failed} MTG finish test(s) failed`);
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error.message);
  process.exit(1);
});
