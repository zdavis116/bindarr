// BUG 1: a MISREAD SET CODE must never discard a CORRECT collector number.
//
// THE REPORT. Zach scanned Avatar Aang (rarity M, collector number 0207, set
// `tla`) on an iPhone 16. The review queue said:
//
//     Could not read the collector number.
//     Read: #M0207 · TAA
//
// The number was right on the card and the set was misread (`tla` -> `taa`,
// an L read as an A). The card queued as unreadable anyway.
//
// WHY THIS SUITE DRIVES THE REAL ROUTE, and it is the whole lesson of PR 8/9.
// A previous PR shipped a backend the frontend never called; another was tuned
// against a harness feeding the OCR module a crop the real route never
// produces. Both showed green tests. So this suite stands up a REAL express
// app with the REAL collection router and a REAL database, POSTs to
// /api/scan-resolve, and asserts against the COLLECTION TABLE — not against
// the resolver's return value. A unit test on the resolver alone would not
// prove the card actually gets added.
//
// WHAT IT STILL CANNOT PROVE: anything about the camera, the crop, or what
// tesseract really returns for a given photo. The OCR TEXT here is supplied
// directly, in the shapes the real parser produces.
const assert = require('assert');
const express = require('express');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-setmisread-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';

const db = require('../../src/db');
const collectionRoutes = require('../../src/routes/collection');

let server;
let base;
let passed = 0;
function pass(id, msg) { passed++; console.log(`PASS: ${id} - ${msg}`); }

// The real shape of Zach's card, plus the printings needed to prove the
// narrowing rules. `tla` is the real Avatar set code; `taa` is the misread.
const CARDS = [
  // Avatar Aang: transforming DFC, so the catalogue stores the FRONT face only.
  // EXACTLY ONE printing carries #207 -> a right number with a wrong set must
  // still resolve to this row and ADD.
  { id: 'sm-aang-tla-207', oracle_id: 'sm-o-aang', name: 'Avatar Aang',
    set_id: 'tla', set_name: 'Avatar: The Last Airbender', number: '207' },
  // A DIFFERENT number in the same set: proves the number is doing the work,
  // not the set.
  { id: 'sm-aang-tla-311', oracle_id: 'sm-o-aang', name: 'Avatar Aang',
    set_id: 'tla', set_name: 'Avatar: The Last Airbender', number: '311' },
  // Sol Ring: TWO printings share #263, so a right number that is genuinely
  // ambiguous must STILL queue with candidates rather than pick one.
  { id: 'sm-solring-c21', oracle_id: 'sm-o-solring', name: 'Sol Ring',
    set_id: 'c21', set_name: 'Commander 2021', number: '263' },
  { id: 'sm-solring-lcc', oracle_id: 'sm-o-solring', name: 'Sol Ring',
    set_id: 'lcc', set_name: 'LOTR Commander', number: '263' },
];

async function seed() {
  for (const c of CARDS) {
    await db.run(
      `INSERT OR REPLACE INTO card_cache
        (id, oracle_id, name, supertype, subtypes, types, rarity, set_id, set_name,
         number, image_url, type_line, cmc, color_identity, legalities, finishes, last_updated)
       VALUES (?, ?, ?, 'MTG', '[]', '[]', 'Mythic', ?, ?, ?, '', 'Creature', 3, '[]', ?, ?, CURRENT_TIMESTAMP)`,
      [c.id, c.oracle_id, c.name, c.set_id, c.set_name, c.number,
       JSON.stringify({ commander: 'legal' }), JSON.stringify(['nonfoil', 'foil'])]
    );
  }
  // Modern release dates: these frames DO print a collector number, so a queue
  // reason of 'no_number' would be wrong for any of them.
  for (const [id, name, date] of [
    ['tla', 'Avatar: The Last Airbender', '2025-11-21'],
    ['c21', 'Commander 2021', '2021-04-23'],
    ['lcc', 'LOTR Commander', '2023-06-23'],
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
  const user = await createUser('setmisread');

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  // Routers mount at a BARE /api in this app.
  app.use('/api', collectionRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  // The REAL route, over real HTTP, with real auth.
  const scanResolve = async (body) => {
    const res = await fetch(`${base}/api/scan-resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${user.token}`,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  // Assert against the COLLECTION, not against the response. This is the
  // difference between "the resolver returned add" and "the card is his".
  const ownedRows = async (cardId) => {
    const rows = await db.all(
      `SELECT * FROM collection WHERE user_id = ? AND card_id = ? AND list_type = 'collection'`,
      [user.id, cardId]
    );
    return rows;
  };
  const totalOwned = async () => {
    const row = await db.get(
      `SELECT COUNT(*) n FROM collection WHERE user_id = ?`, [user.id]);
    return row.n;
  };

  // --- FSET-TC1: THE REPORTED BUG -----------------------------------------
  // A CORRECT number with a WRONG set must still resolve and be ADDED.
  //
  // The OCR text is exactly the shape the real parser produces from Zach's
  // card: the rarity letter glued to the padded number, and the misread set.
  // Verified against collectorNumberParse: this yields number='M0207',
  // set='taa'. Both halves of the reported defect are therefore in play.
  {
    const before = await totalOwned();
    const { status, body } = await scanResolve({
      name: 'Avatar Aang',
      ocr_text: 'M0207/0286\nTAA * EN Some Artist',
    });
    assert.strictEqual(status, 200, `scan-resolve failed: ${JSON.stringify(body)}`);
    assert.strictEqual(body.action, 'added',
      `a right number with a WRONG set must ADD, not queue. got ${JSON.stringify(body)}`);
    assert.strictEqual(body.card.id, 'sm-aang-tla-207',
      `must add the printing the NUMBER identifies, got ${body.card && body.card.id}`);
    // THE PROPERTY THAT MATTERS: it is actually in the collection.
    const rows = await ownedRows('sm-aang-tla-207');
    assert.strictEqual(rows.length, 1, 'the resolved printing must really be in the collection');
    assert.strictEqual(await totalOwned(), before + 1, 'exactly one card was added');
    // And nothing was invented: the set we report is the catalogue's, and the
    // queue is untouched.
    const queued = await db.get(
      `SELECT COUNT(*) n FROM scan_review_queue WHERE user_id = ?`, [user.id]);
    assert.strictEqual(queued.n, 0, 'a resolved card must not also be queued');
    pass('FSET-TC1', 'a CORRECT number with a MISREAD set resolves and is ADDED via the real route');
  }

  // --- FSET-TC2: a correct number with a CORRECT set still resolves --------
  // The narrowing path must not be broken by the fallback.
  {
    const before = await totalOwned();
    const { body } = await scanResolve({
      name: 'Avatar Aang',
      ocr_text: '0311/0286 M\nTLA * EN Some Artist',
    });
    assert.strictEqual(body.action, 'added',
      `a right number with the RIGHT set must still add. got ${JSON.stringify(body)}`);
    assert.strictEqual(body.card.id, 'sm-aang-tla-311');
    assert.strictEqual((await ownedRows('sm-aang-tla-311')).length, 1);
    assert.strictEqual(await totalOwned(), before + 1);
    pass('FSET-TC2', 'a correct number with a correct set still resolves and adds');
  }

  // --- FSET-TC3: a genuinely ambiguous number still QUEUES, owned-first ----
  // The set is only ever a NARROWING hint. When the number alone matches
  // several printings and no set disambiguates them, the app must ask.
  {
    // He owns the LCC printing, so that must be offered first.
    await db.run(
      `INSERT INTO collection (user_id, card_id, quantity, condition, list_type)
       VALUES (?, 'sm-solring-lcc', 2, 'Near Mint', 'collection')`,
      [user.id]
    );
    const before = await totalOwned();
    const { body } = await scanResolve({
      name: 'Sol Ring',
      // A set that matches NEITHER printing: the filter empties, so it is
      // discarded and we are left with the genuine two-way ambiguity.
      ocr_text: '0263/0281 U\nZZZ * EN',
    });
    assert.strictEqual(body.action, 'staged_unresolved',
      `two printings share #263 -> must ASK. got ${JSON.stringify(body)}`);
    assert.strictEqual(body.reason, 'ambiguous');
    assert.strictEqual(body.candidates.length, 2, 'both printings must be offered');
    assert.strictEqual(body.candidates[0].id, 'sm-solring-lcc',
      `owned printing must sort first, got ${body.candidates.map(c => c.id).join(',')}`);
    // Nothing was added, and specifically nothing was GUESSED.
    assert.strictEqual(await totalOwned(), before,
      'an ambiguous scan must put nothing in the collection');
    pass('FSET-TC3', 'a number matching several printings still queues with candidates, owned-first');
  }

  // --- FSET-TC4: a number matching NOTHING never adds ----------------------
  // The catalogue is the validator. A fabricated read must become a question,
  // never a card. This is the guard that makes discarding the set filter safe:
  // widening the candidate list back to number-only cannot invent a printing,
  // because the number still has to match a real catalogue row.
  {
    const before = await totalOwned();
    const { body } = await scanResolve({
      name: 'Avatar Aang',
      ocr_text: 'M1508/0286\nTLA * EN',
    });
    assert.strictEqual(body.action, 'staged_unresolved',
      `a number matching no printing must QUEUE. got ${JSON.stringify(body)}`);
    assert.strictEqual(body.reason, 'unreadable');
    assert.strictEqual(await totalOwned(), before,
      'a number that matches nothing must NEVER add a card');
    // It still offers the real printings so he can pick one by hand.
    assert.ok(body.candidates.length >= 2,
      'the queue entry must still offer the real printings to choose from');
    pass('FSET-TC4', 'a number matching nothing never adds — the catalogue is still the validator');
  }

  // --- FSET-TC5: a WRONG set never selects a WRONG printing ---------------
  // The dangerous inverse of TC1. Discarding an emptying set filter must not
  // become "ignore the set", which would let a misread set silently pick a
  // different card's printing. Here the number is ambiguous AND the set is
  // wrong: the correct behaviour is to ASK, never to fall through to one.
  {
    const before = await totalOwned();
    const { body } = await scanResolve({
      name: 'Sol Ring',
      // 'tla' is a REAL set code, but no Sol Ring printing is in it.
      ocr_text: '0263/0281 U\nTLA * EN',
    });
    assert.strictEqual(body.action, 'staged_unresolved',
      `a wrong-but-real set must not pick a printing. got ${JSON.stringify(body)}`);
    assert.strictEqual(await totalOwned(), before, 'and must add nothing');
    pass('FSET-TC5', 'a wrong set code never silently selects a printing');
  }

  console.log(`\nscan_set_misread.test.js: ${passed} cases passed`);
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
