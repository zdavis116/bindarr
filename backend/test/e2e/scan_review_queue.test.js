// PR 8: collector-number OCR and the scan review queue.
//
// Every case drives the REAL HTTP routes against a REAL database, per the
// standing lesson in this repo: a suite that seeds rows directly and asserts on
// status codes has twice hidden real bugs. Direct SQL appears only for
// FIXTURES (card_cache rows, users). The thing under test is always a route.
//
// THE CASE THAT MATTERS MOST is F8-TC5/TC6: a queued card is NOT OWNED. It must
// not reach availability, deck matching or a buylist. If that regresses, Bindarr
// tells Zach he owns cards he does not, and there is no way to reconcile that
// against a physical shoebox later.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-pr8-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';

const db = require('../../src/db');
const collectionRoutes = require('../../src/routes/collection');
const deckRoutes = require('../../src/routes/decks');

let base;
let server;

async function api(token, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
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

// --- Fixtures ---------------------------------------------------------------
//
// Sol Ring exists in TWO printings sharing one artwork — the exact case the
// measurement found (index has one entry, catalogue has both). Lightning Bolt
// is single-printing so a confident read can resolve it outright. Black Lotus
// stands in for a card whose frame prints no number.
const CARDS = [
  { id: 'pr8-solring-c21', oracle_id: 'pr8-o-solring', name: 'Sol Ring',
    set_id: 'c21', set_name: 'Commander 2021', number: '263', finishes: ['nonfoil', 'foil'] },
  { id: 'pr8-solring-cmm', oracle_id: 'pr8-o-solring', name: 'Sol Ring',
    set_id: 'cmm', set_name: 'Commander Masters', number: '410', finishes: ['nonfoil', 'foil', 'etched'] },
  // Same COLLECTOR NUMBER as the C21 Sol Ring, different set. This is what makes
  // "number alone is not unique across sets" testable.
  { id: 'pr8-bolt-clash', oracle_id: 'pr8-o-solring', name: 'Sol Ring',
    set_id: 'lcc', set_name: 'LOTR Commander', number: '263', finishes: ['nonfoil'] },
  { id: 'pr8-bolt', oracle_id: 'pr8-o-bolt', name: 'Lightning Bolt',
    set_id: '2x2', set_name: 'Double Masters 2022', number: '117', finishes: ['nonfoil', 'foil'] },
  { id: 'pr8-lotus', oracle_id: 'pr8-o-lotus', name: 'Black Lotus',
    set_id: 'lea', set_name: 'Limited Edition Alpha', number: '232', finishes: ['nonfoil'] },
  // Non-numeric collector number: the string-not-integer case.
  { id: 'pr8-star', oracle_id: 'pr8-o-star', name: 'Test Star Card',
    set_id: 'plst', set_name: 'The List', number: '123a', finishes: ['nonfoil'] },
];

async function seedCards() {
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
  // Release dates so the resolver can word the queue reason. Alpha is pre-2015
  // (no printed number); the rest are modern.
  const sets = [
    ['c21', 'Commander 2021', '2021-04-23'],
    ['cmm', 'Commander Masters', '2023-08-04'],
    ['lcc', 'LOTR Commander', '2023-06-23'],
    ['2x2', 'Double Masters 2022', '2022-07-08'],
    ['lea', 'Limited Edition Alpha', '1993-08-05'],
    ['plst', 'The List', '2020-01-01'],
  ];
  for (const [id, name, date] of sets) {
    await db.run(`INSERT OR REPLACE INTO sets (id, name, release_date) VALUES (?, ?, ?)`, [id, name, date]);
  }
}

let passed = 0;
function pass(id, msg) { passed++; console.log(`PASS: ${id} - ${msg}`); }

async function main() {
  await db.initDb();
  await seedCards();
  const user = await createUser('pr8user');

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api', collectionRoutes);
  // Routers mount at DIFFERENT prefixes in this app: collection at bare /api,
  // decks at /api/decks. Mounting decks at /api would 404 every deck route.
  app.use('/api/decks', deckRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // --- F8-TC1: a confident read matching EXACTLY ONE printing is added -------
  {
    const res = await api(user.token, '/api/scan-resolve', {
      method: 'POST',
      body: { name: 'Lightning Bolt', ocr_text: '117/331 R\n2X2 * EN', finish: 'Normal' },
    });
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.action, 'added', `expected action=added, got ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.card.set_id, '2x2');
    assert.strictEqual(res.body.card.number, '117');
    const owned = await api(user.token, '/api/collection');
    const rows = (owned.body.cards || owned.body).filter(c => c.card_id === 'pr8-bolt');
    assert.strictEqual(rows.length, 1, 'the resolved printing must actually be in the collection');
    pass('F8-TC1', 'confident read matching exactly one printing is added directly');
  }

  // --- F8-TC2: a read matching SEVERAL printings QUEUES, never chooses -------
  {
    // "263" matches BOTH c21/263 and lcc/263. No set code is legible.
    const res = await api(user.token, '/api/scan-resolve', {
      method: 'POST',
      body: { name: 'Sol Ring', ocr_text: '263\n' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.action, 'queued',
      `several printings matched -> must queue, not choose. got ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.reason, 'ambiguous');
    const ids = res.body.candidates.map(c => c.id);
    assert.ok(ids.includes('pr8-solring-c21') && ids.includes('pr8-bolt-clash'),
      'both same-numbered printings must be offered');
    pass('F8-TC2', 'a read matching several printings queues rather than choosing');
  }

  // --- F8-TC3: a card whose frame prints no number queues, reason recorded ---
  {
    const res = await api(user.token, '/api/scan-resolve', {
      method: 'POST',
      body: { name: 'Black Lotus', ocr_text: 'Illus. (c) Christopher Rush' },
    });
    assert.strictEqual(res.body.action, 'queued');
    assert.strictEqual(res.body.reason, 'no_number',
      `a pre-2015 frame carries no number; reason must say so, got ${res.body.reason}`);
    pass('F8-TC3', 'card with no printed number queues with the reason recorded');
  }

  // --- F8-TC4: NEVER GUESS — a fabricated read resolves to nothing ----------
  {
    // "M1508" is a real tesseract misread observed in the benchmark. No such
    // printing of Sol Ring exists, so it must NOT become a card.
    const before = await db.get(`SELECT COUNT(*) n FROM collection WHERE user_id = ?`, [user.id]);
    const res = await api(user.token, '/api/scan-resolve', {
      method: 'POST',
      body: { name: 'Sol Ring', ocr_text: 'M1508 SLD * EN' },
    });
    assert.strictEqual(res.body.action, 'queued',
      'a number matching no catalogue printing must queue, never add');
    const after = await db.get(`SELECT COUNT(*) n FROM collection WHERE user_id = ?`, [user.id]);
    assert.strictEqual(after.n, before.n, 'a misread must not add anything to the collection');
    pass('F8-TC4', 'never guess: a read matching no catalogue printing adds nothing');
  }

  // --- F8-TC5: queued cards do NOT count toward availability ----------------
  {
    const queue = await api(user.token, '/api/scan-queue');
    assert.ok(queue.body.entries.length >= 3, 'queue should hold the entries from TC2/TC3/TC4');

    // Sol Ring was queued three times above and never resolved. Availability
    // must still report zero owned.
    const search = await api(user.token, '/api/search?name=Sol%20Ring&scope=database');
    const solRings = (search.body || []).filter(c => c.name === 'Sol Ring');
    for (const c of solRings) {
      assert.strictEqual(c.owned_qty || 0, 0,
        `a QUEUED card must not count as owned. ${c.set_id}/${c.number} reported owned_qty=${c.owned_qty}`);
      assert.strictEqual(c.available_qty || 0, 0,
        `a QUEUED card must not count as available. ${c.set_id}/${c.number}`);
    }
    const rows = await db.all(
      `SELECT * FROM collection WHERE user_id = ? AND card_id LIKE 'pr8-solring%'`, [user.id]);
    assert.strictEqual(rows.length, 0, 'nothing queued may exist in the collection table');
    pass('F8-TC5', 'queued cards do not count toward availability or ownership');
  }

  // --- F8-TC6: queued cards do NOT affect a buylist -------------------------
  {
    // A non-Commander deck on purpose: the question under test is "does a
    // QUEUED card satisfy a deck requirement", which has nothing to do with
    // format rules. Commander would require a legal commander fixture and add
    // singleton rules that are irrelevant here.
    const deck = await api(user.token, '/api/decks', {
      method: 'POST', body: { name: 'PR8 Deck', format: 'Modern', target_size: 60 },
    });
    assert.strictEqual(deck.status, 201, `deck create failed: ${JSON.stringify(deck.body)}`);
    const deckId = deck.body.id;
    // Want the C21 Sol Ring, which is sitting in the review queue unresolved.
    const want = await api(user.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'pr8-solring-c21', desired_finish: 'nonfoil', quantity: 1 },
    });
    assert.ok(want.status === 200 || want.status === 201,
      `adding a deck requirement failed: ${want.status} ${JSON.stringify(want.body)}`);
    const buylist = await api(user.token, `/api/decks/${deckId}/buylist`);
    const items = buylist.body.items || [];
    const solring = items.find(i =>
      (i.desired_card_id || i.card_id || i.id) === 'pr8-solring-c21' || i.name === 'Sol Ring');
    assert.ok(solring,
      'a card that is only QUEUED is not owned, so the deck must still want to BUY it. ' +
      `buylist items: ${JSON.stringify(items)}`);
    pass('F8-TC6', 'queued cards do not satisfy a deck requirement; buylist still lists them');
  }

  // --- F8-TC7: the queue SURVIVES a restart --------------------------------
  {
    const before = await api(user.token, '/api/scan-queue');
    const countBefore = before.body.entries.length;
    assert.ok(countBefore > 0, 'precondition: queue is not empty');

    // Prove the queue is DURABLE STATE ON DISK, not process memory: open the
    // database file with a brand new, independent sqlite connection — the same
    // thing a restarted server process does — and read the queue back.
    //
    // This is the property the spec demands ("must survive a page reload and a
    // session end"). Browser state cannot survive it; a row in a file does.
    const sqlite3 = require('sqlite3');
    const fresh = await new Promise((resolve, reject) => {
      const c = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, e => e ? reject(e) : resolve(c));
    });
    const rows = await new Promise((resolve, reject) => {
      fresh.all(`SELECT id, matched_name, reason FROM scan_review_queue WHERE user_id = ?`,
        [user.id], (e, r) => e ? reject(e) : resolve(r));
    });
    await new Promise(resolve => fresh.close(resolve));

    assert.strictEqual(rows.length, countBefore,
      'the queue must survive a restart — scanning 500 cards and losing it is unacceptable');
    assert.ok(rows.every(r => r.reason && r.matched_name),
      'each surviving entry must still carry its reason and matched card');
    pass('F8-TC7', 'the review queue survives a restart (durable on disk, not in memory)');
  }

  // --- F8-TC8: owned printings sort FIRST in the candidate list --------------
  {
    // Own the CMM printing, then queue an ambiguous Sol Ring and check ordering.
    await api(user.token, '/api/collection', {
      method: 'POST', body: { card_id: 'pr8-solring-cmm', finish: 'Normal', quantity: 3 },
    });
    const res = await api(user.token, '/api/scan-resolve', {
      method: 'POST', body: { name: 'Sol Ring', ocr_text: '' },
    });
    assert.strictEqual(res.body.action, 'queued');
    assert.strictEqual(res.body.candidates[0].id, 'pr8-solring-cmm',
      `the printing he OWNS must be offered first, got ${res.body.candidates[0].id}`);
    pass('F8-TC8', 'owned printings sort first in the candidate list');
  }

  // --- F8-TC9: a non-numeric collector number is handled as a STRING --------
  {
    const res = await api(user.token, '/api/scan-resolve', {
      method: 'POST', body: { name: 'Test Star Card', ocr_text: '123a\nPLST * EN', finish: 'Normal' },
    });
    assert.strictEqual(res.body.action, 'added',
      `'123a' must resolve as a string, not be parsed to 123. got ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.card.number, '123a');
    pass('F8-TC9', 'a non-numeric collector number is handled as a string');
  }

  // --- F8-TC10: finish is NEVER inferred from the image ---------------------
  {
    // No finish supplied. The card resolves to exactly one printing, but the
    // image cannot tell foil from nonfoil, so it must NOT be auto-added with a
    // guessed finish.
    await db.run(`DELETE FROM collection WHERE user_id = ? AND card_id = 'pr8-bolt'`, [user.id]);
    const res = await api(user.token, '/api/scan-resolve', {
      method: 'POST', body: { name: 'Lightning Bolt', ocr_text: '117/331 R\n2X2 * EN' },
    });
    const rows = await db.all(
      `SELECT finish, printing FROM collection WHERE user_id = ? AND card_id = 'pr8-bolt'`, [user.id]);
    if (res.body.action === 'added') {
      assert.strictEqual(rows[0].finish, 'nonfoil',
        'with no finish supplied the app must DEFAULT explicitly to nonfoil, never infer foil from pixels');
      assert.strictEqual(rows[0].printing, 'Normal',
        'the display mirror must agree with the finish');
    }
    // Whatever it did, it must not have invented a special treatment. This is
    // the real assertion: surge foils and etched cards share artwork AND
    // collector numbers with the standard printing, so any foil/etched value
    // here could only have come from guessing at pixels.
    assert.ok(!rows.some(r => r.finish === 'foil' || r.finish === 'etched'
                           || r.printing === 'Foil' || r.printing === 'Etched'),
      'finish must never be inferred from a still image');
    pass('F8-TC10', 'finish is never inferred from the image');
  }

  // --- F8-TC11: resolving a queue entry moves it into the collection --------
  {
    const queue = await api(user.token, '/api/scan-queue');
    const entry = queue.body.entries.find(e => e.matched_name === 'Sol Ring');
    assert.ok(entry, 'precondition: a Sol Ring entry is queued');
    const res = await api(user.token, `/api/scan-queue/${entry.id}/resolve`, {
      method: 'POST', body: { card_id: 'pr8-solring-c21', finish: 'Normal', quantity: 1 },
    });
    assert.strictEqual(res.status, 200, `resolve failed: ${JSON.stringify(res.body)}`);
    const owned = await db.get(
      `SELECT SUM(quantity) q FROM collection WHERE user_id = ? AND card_id = 'pr8-solring-c21'`, [user.id]);
    assert.strictEqual(owned.q, 1, 'resolving must add the CHOSEN printing to the collection');
    const still = await db.get(`SELECT COUNT(*) n FROM scan_review_queue WHERE id = ?`, [entry.id]);
    assert.strictEqual(still.n, 0, 'a resolved entry must leave the queue — never in both states');
    pass('F8-TC11', 'resolving a queue entry moves it into the collection exactly once');
  }

  console.log(`\nPR8 suite: ${passed} cases passed.`);
}

main()
  .then(async () => { if (server) server.close(); await db.close().catch(() => {}); process.exit(0); })
  .catch(async (err) => {
    console.error(`FAIL: F8-TC? - ${err.message}`);
    console.error(err.stack);
    if (server) server.close();
    process.exit(1);
  });
