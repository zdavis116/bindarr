// PR 9: the FRONTEND scan queue controller driven against the REAL routes.
//
// WHY THIS SUITE EXISTS, and it is the whole lesson of PR 8.
//
// PR 8 shipped a correct OCR pipeline, a correct printing resolver and a
// correct server-side queue. Every one of them was tested and every test
// passed. None of it was connected to the scanner. A green suite proved the
// PARTS worked while the FEATURE did not exist, because nothing anywhere
// exercised the frontend's call against the backend's route.
//
// So this suite imports the ACTUAL controller the scanner uses
// (frontend/src/components/scanReviewQueue.js) and points its injected fetch at
// a REAL express app with the REAL collection routes and a REAL database. If
// the client and the server ever disagree about a path, a field name or a
// response shape, this fails — which is precisely the failure that shipped
// silently last time.
//
// WHAT IT STILL CANNOT PROVE: anything about rendering, layout, touch targets
// or iOS Safari. Nothing here runs a browser. Zach's phone remains the gate.
const assert = require('assert');
const express = require('express');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-pr9-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';

const db = require('../../src/db');
const collectionRoutes = require('../../src/routes/collection');

let base;
let server;
let passed = 0;
function pass(id, msg) { passed++; console.log(`PASS: ${id} - ${msg}`); }

const CARDS = [
  // Two printings sharing one artwork and one number-free read -> must queue.
  { id: 'pr9-solring-c21', oracle_id: 'pr9-o-solring', name: 'Sol Ring',
    set_id: 'c21', set_name: 'Commander 2021', number: '263', finishes: ['nonfoil', 'foil'] },
  { id: 'pr9-solring-lcc', oracle_id: 'pr9-o-solring', name: 'Sol Ring',
    set_id: 'lcc', set_name: 'LOTR Commander', number: '263', finishes: ['nonfoil'] },
  // Single printing: a confident read resolves it outright -> must add.
  { id: 'pr9-bolt', oracle_id: 'pr9-o-bolt', name: 'Lightning Bolt',
    set_id: '2x2', set_name: 'Double Masters 2022', number: '117', finishes: ['nonfoil', 'foil'] },
];

async function seed() {
  for (const c of CARDS) {
    await db.run(
      `INSERT OR REPLACE INTO card_cache
        (id, oracle_id, name, supertype, subtypes, types, rarity, set_id, set_name,
         number, image_url, type_line, cmc, color_identity, legalities, finishes, last_updated)
       VALUES (?, ?, ?, 'MTG', '[]', '[]', 'Rare', ?, ?, ?, '', 'Artifact', 1, '[]', ?, ?, CURRENT_TIMESTAMP)`,
      [c.id, c.oracle_id, c.name, c.set_id, c.set_name, c.number,
       JSON.stringify({ commander: 'legal' }), JSON.stringify(c.finishes)]
    );
  }
  for (const [id, name, date] of [
    ['c21', 'Commander 2021', '2021-04-23'],
    ['lcc', 'LOTR Commander', '2023-06-23'],
    ['2x2', 'Double Masters 2022', '2022-07-08'],
  ]) {
    await db.run(`INSERT OR REPLACE INTO sets (id, name, release_date) VALUES (?, ?, ?)`, [id, name, date]);
  }
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

async function main() {
  await db.initDb();
  await seed();
  const user = await createUser('pr9user');

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  // Routers mount at BARE /api in this app.
  app.use('/api', collectionRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // The controller is ESM and this suite is CJS, so it is imported dynamically.
  // It is the REAL file the scanner imports — not a copy, not a reimplementation.
  const { createScanReviewQueue } = await import(
    path.join(__dirname, '..', '..', '..', 'frontend', 'src', 'components', 'scanReviewQueue.js')
  );

  // The injected fetch is the ONLY thing standing in for the browser: it adds
  // the auth header and resolves the relative URL the component really sends.
  // Paths, methods and bodies all come from the controller itself.
  const fetchImpl = (url, options = {}) => fetch(`${base}${url}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}`, ...(options.headers || {}) },
  });

  const queue = createScanReviewQueue({ fetchImpl });

  const ownedCount = async () => {
    const row = await db.get(`SELECT COUNT(*) n FROM collection WHERE user_id = ?`, [user.id]);
    return row.n;
  };

  // --- F9E-TC1: a confident single-printing read is ADDED -------------------
  {
    const before = await ownedCount();
    const outcome = await queue.submitScan({
      name: 'Lightning Bolt',
      ocrText: '117/331 R\n2X2 * EN',
    });
    assert.strictEqual(outcome.action, 'added',
      `expected added, got ${JSON.stringify(outcome)}`);
    assert.strictEqual(outcome.added, true);
    assert.strictEqual(await ownedCount(), before + 1,
      'a resolved printing must actually reach the collection');
    pass('F9E-TC1', 'the scanner controller adds a confidently resolved printing via the real route');
  }

  // --- F9E-TC2: an ambiguous read QUEUES and adds NOTHING -------------------
  {
    const before = await ownedCount();
    const outcome = await queue.submitScan({
      name: 'Sol Ring',
      ocrText: '263\n',
      crop: 'data:image/jpeg;base64,AAAA',
    });
    assert.strictEqual(outcome.action, 'queued',
      `two printings share #263 -> must queue. got ${JSON.stringify(outcome)}`);
    assert.strictEqual(outcome.added, false);
    assert.strictEqual(outcome.reason, 'ambiguous');
    // THE PROPERTY THAT MATTERS: nothing entered the collection.
    assert.strictEqual(await ownedCount(), before,
      'a queued card must NOT be in the collection');
    pass('F9E-TC2', 'an ambiguous scan queues and puts nothing in the collection');
  }

  // --- F9E-TC3: the queue is readable from the server (survives a reload) ---
  {
    // A BRAND NEW controller, as if the page had just been reloaded: it has no
    // memory of anything queued above.
    const fresh = createScanReviewQueue({ fetchImpl });
    assert.strictEqual(fresh.getState().pendingCount, 0, 'a fresh controller starts empty');
    const state = await fresh.refresh();
    assert.ok(state.entries.length >= 1,
      'the queue must come back from the server after a reload');
    assert.strictEqual(state.pendingCount, state.entries.length);
    const entry = state.entries.find(e => e.matched_name === 'Sol Ring');
    assert.ok(entry, 'the queued Sol Ring must be readable from the server');
    assert.strictEqual(entry.reason, 'ambiguous');
    assert.ok(entry.candidates.length >= 2, 'the stored candidates must come back too');
    pass('F9E-TC3', 'the queue is read from the server and survives a fresh controller');
  }

  // --- F9E-TC4: owned printings sort FIRST ---------------------------------
  {
    // Give the user copies of the LCC printing only. The next ambiguous scan of
    // Sol Ring must offer LCC first, because that is the one he is holding.
    await db.run(
      `INSERT INTO collection (user_id, card_id, quantity, condition, list_type)
       VALUES (?, 'pr9-solring-lcc', 3, 'Near Mint', 'collection')`,
      [user.id]
    );
    const outcome = await queue.submitScan({ name: 'Sol Ring', ocrText: '263\n' });
    assert.strictEqual(outcome.action, 'queued');
    assert.strictEqual(outcome.candidates[0].id, 'pr9-solring-lcc',
      `owned printing must sort first, got ${outcome.candidates.map(c => c.id).join(',')}`);

    const state = await queue.refresh();
    const stored = state.entries.filter(e => e.matched_name === 'Sol Ring').pop();
    assert.strictEqual(stored.candidates[0].id, 'pr9-solring-lcc',
      'the owned-first order must be preserved as stored and re-read');
    assert.ok(stored.candidates[0].owned_qty >= 3, 'the owned quantity must be carried through');
    pass('F9E-TC4', 'owned printings sort first, through the real resolver and back');
  }

  // --- F9E-TC5: resolving moves the card OUT of the queue INTO the collection
  {
    const state = await queue.refresh();
    const entry = state.entries.find(e => e.matched_name === 'Sol Ring');
    const chosen = entry.candidates[0];
    const beforeOwned = await ownedCount();
    const beforeQueue = state.entries.length;

    const result = await queue.resolveEntry(entry.id, {
      card_id: chosen.id,
      printing: 'nonfoil',
      quantity: 1,
    });
    assert.strictEqual(result.ok, true, `resolve failed: ${JSON.stringify(result)}`);
    assert.strictEqual(await ownedCount(), beforeOwned + 1,
      'a resolved queue entry must enter the collection');
    const after = queue.getState();
    assert.strictEqual(after.entries.length, beforeQueue - 1,
      'the resolved entry must leave the queue');
    assert.ok(!after.entries.some(e => e.id === entry.id), 'that exact entry is gone');
    const row = await db.get(
      `SELECT * FROM scan_review_queue WHERE id = ?`, [entry.id]);
    assert.strictEqual(row, undefined, 'the queue row must be deleted server-side');
    pass('F9E-TC5', 'resolving one entry moves it from the queue into the collection');
  }

  // --- F9E-TC6: a rejected printing leaves the entry in the queue -----------
  {
    const state = await queue.refresh();
    const entry = state.entries[0];
    assert.ok(entry, 'need a queued entry for this case');
    const beforeOwned = await ownedCount();

    // A card id that was never among the scanned candidates. The server refuses
    // it; the entry must SURVIVE. Losing a card Zach physically scanned would
    // be worse than asking him again.
    const result = await queue.resolveEntry(entry.id, { card_id: 'pr9-bolt' });
    assert.strictEqual(result.ok, false, 'a non-candidate printing must be refused');
    assert.strictEqual(await ownedCount(), beforeOwned, 'and must add nothing');
    const still = await db.get(`SELECT * FROM scan_review_queue WHERE id = ?`, [entry.id]);
    assert.ok(still, 'the entry must still be in the queue after a refused resolve');
    assert.ok(queue.getState().entries.some(e => e.id === entry.id),
      'and the UI state must still show it');
    pass('F9E-TC6', 'a refused printing leaves the queue entry intact and adds nothing');
  }

  // --- F9E-TC7: discarding removes the entry and touches nothing owned ------
  {
    const state = await queue.refresh();
    const entry = state.entries[0];
    const beforeOwned = await ownedCount();

    const result = await queue.discardEntry(entry.id);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(await ownedCount(), beforeOwned,
      'discarding from the queue must never remove anything he owns');
    const gone = await db.get(`SELECT * FROM scan_review_queue WHERE id = ?`, [entry.id]);
    assert.strictEqual(gone, undefined, 'the discarded entry is deleted');
    pass('F9E-TC7', 'discarding an entry removes it and leaves the collection untouched');
  }

  console.log(`\nscan_wiring.test.js: ${passed} cases passed`);
}

main()
  .then(async () => {
    if (server) server.close();
    await db.close?.();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('FAIL:', err);
    if (server) server.close();
    process.exit(1);
  });
