// THE 7-SCAN BUG: a card with only ONE printing was queued instead of added.
//
// WHAT ZACH MEASURED. On the first fullscreen/full-resolution build he scanned
// one card seven times before it was added, and the review queue filled with
// entries he could not act on usefully. Pulled from the live dev queue, every
// row looked like this:
//
//   matched_name="Captain America's Shield"  reason='unreadable'
//   ocr_number=NULL  ocr_confident=0  ocr_raw='—'
//
// The ART MATCH WAS CONFIDENT AND CORRECT every time (66 ORB inliers, top
// candidate msh #244, the right card). The capture was healthy too: 3024x4032,
// zoom 1.0 (main lens, not the ultra-wide), crop 1653px, all focus-gate scores
// green. Nothing about the photograph was wrong.
//
// What failed was the ORDER OF THE CHECKS. resolveScannedPrinting gated on
// `!ocr.confident || ocr.number == null` BEFORE asking whether the collector
// number could change the answer at all. The collector number is ~6pt text at
// the very edge of the card, the single hardest thing in the frame to read, and
// it sat on the critical path for EVERY scan — including scans where the
// catalogue held exactly one printing and there was nothing to disambiguate.
//
// ZACH'S RULE, which this suite encodes:
//
//   "I'm fine if it's right card wrong printing, fix with the queue — but I
//    would like for that to be the case only if the art isn't unique and we
//    couldn't get set number."
//
// So uniqueness is checked FIRST. One printing -> add it; the number could not
// have changed the outcome. Several printings -> the number is required exactly
// as before, and its absence still queues. That second half is not a detail: it
// is the guarantee that no printing is ever silently guessed, which is the one
// failure Zach cannot reconcile against the physical cards in his hand.
//
// WHY E2E. Frontend suites here are source contracts and a prior PR shipped a
// backend the frontend never called. This drives the REAL express app with the
// REAL collection routes, a REAL database and the REAL /api/scan-resolve route,
// and asserts on what actually lands in the collection table.
const assert = require('assert');
const express = require('express');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-unique-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';

const db = require('../../src/db');
const collectionRoutes = require('../../src/routes/collection');

let server;
let passed = 0;
function pass(id, msg) { passed++; console.log(`PASS: ${id} - ${msg}`); }

// Rows mirror the real catalogue shapes from Zach's actual session.
const CARDS = [
  // --- SINGLE PRINTING: the case that was wrongly queued -------------------
  // A modern-frame card that exists exactly once in the catalogue. There is no
  // second printing for a collector number to choose between.
  { id: 'sol-uniq', oracle_id: 'o-uniq', name: 'Solitary Relic', set_id: 'msh', set_name: 'Marvel Super Heroes', number: '244' },

  // --- MULTIPLE PRINTINGS: must still require the number -------------------
  // Three printings sharing one name, exactly like the real Captain America's
  // Shield rows (msh 244 / 311 / 317) that Zach's scan returned.
  { id: 'shield-244', oracle_id: 'o-shield', name: "Captain America's Shield", set_id: 'msh', set_name: 'Marvel Super Heroes', number: '244' },
  { id: 'shield-311', oracle_id: 'o-shield', name: "Captain America's Shield", set_id: 'msh', set_name: 'Marvel Super Heroes', number: '311' },
  { id: 'shield-317', oracle_id: 'o-shield', name: "Captain America's Shield", set_id: 'msh', set_name: 'Marvel Super Heroes', number: '317' },
];

const SETS = [
  ['msh', 'Marvel Super Heroes', '2025-06-13'],
];

async function seed() {
  for (const c of CARDS) {
    await db.run(
      `INSERT OR REPLACE INTO card_cache
        (id, oracle_id, name, supertype, subtypes, types, rarity, set_id, set_name,
         number, image_url, type_line, cmc, color_identity, legalities, finishes, last_updated)
       VALUES (?, ?, ?, 'MTG', '[]', '[]', 'Rare', ?, ?, ?, '', 'Artifact', 2, '[]', ?, ?, CURRENT_TIMESTAMP)`,
      [c.id, c.oracle_id, c.name, c.set_id, c.set_name, c.number,
       JSON.stringify({ commander: 'legal' }), JSON.stringify(['nonfoil', 'foil'])]
    );
  }
  for (const [id, name, date] of SETS) {
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
  const user = await createUser('uniqueuser');

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  // Routers mount at BARE /api in this app.
  app.use('/api', collectionRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const scanResolve = async (body) => {
    const resp = await fetch(`${base}/api/scan-resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
      body: JSON.stringify(body),
    });
    return { status: resp.status, body: await resp.json() };
  };

  const ownedCount = async () => {
    const row = await db.get(`SELECT COUNT(*) n FROM collection WHERE user_id = ?`, [user.id]);
    return row.n;
  };

  const queueCount = async () => {
    const row = await db.get(`SELECT COUNT(*) n FROM scan_review_queue WHERE user_id = ?`, [user.id]);
    return row.n;
  };

  // --- FUNIQ-TC1: THE BUG. One printing + unreadable strip -> ADD ----------
  //
  // This is the exact request the scanner sent seven times. `ocr_text: ''` is
  // the real, measured input: the OCR read '—' or nothing at all off a
  // perfectly sharp 1653px crop, because 6pt edge text is simply that hard.
  {
    const beforeOwned = await ownedCount();
    const beforeQueue = await queueCount();
    const { status, body } = await scanResolve({
      name: 'Solitary Relic',
      ocr_text: '',   // the measured reality: the strip did not read
    });
    assert.strictEqual(status, 200, `scan-resolve failed: ${JSON.stringify(body)}`);
    assert.strictEqual(body.action, 'added',
      'THE BUG: the art identified the card and only one printing exists, so it must be ADDED, not queued');
    assert.strictEqual(await ownedCount(), beforeOwned + 1,
      'the card must actually reach the collection');
    assert.strictEqual(await queueCount(), beforeQueue,
      'nothing may be queued when there was never anything to disambiguate');
    pass('FUNIQ-TC1', 'a single-printing card with an unreadable collector number is added, not queued');
  }

  // --- FUNIQ-TC2: THE GUARANTEE. Several printings -> still QUEUE ----------
  //
  // The half that must NOT change. Zach's rule permits a wrong printing only
  // when the art is genuinely ambiguous AND the number is unreadable — and even
  // then it goes to the queue rather than being guessed. If this ever flips to
  // 'added', the app has silently picked a printing, which for software
  // tracking physical objects is the unforgivable outcome.
  {
    const beforeOwned = await ownedCount();
    const { status, body } = await scanResolve({
      name: "Captain America's Shield",
      ocr_text: '',   // same unreadable strip, but now it actually matters
    });
    assert.strictEqual(status, 200, `scan-resolve failed: ${JSON.stringify(body)}`);
    assert.strictEqual(body.action, 'staged_unresolved',
      'THE GUARANTEE: three printings share this art, so an unreadable number MUST queue rather than guess');
    assert.strictEqual(body.candidates.length, 3,
      `all three printings must be offered, got ${body.candidates.map(c => `${c.set_id}:${c.number}`).join(',')}`);
    assert.strictEqual(await ownedCount(), beforeOwned,
      'nothing may enter the collection while the printing is undecided');
    pass('FUNIQ-TC2', 'a multi-printing card with an unreadable number still queues — no silent guess');
  }

  // --- FUNIQ-TC3: the number still resolves an ambiguous card outright -----
  //
  // Proves the fix did not make the collector number dead code. When the strip
  // DOES read on an ambiguous card, it does exactly the job it is good at:
  // picking the exact printing, with no queue entry at all.
  {
    const beforeOwned = await ownedCount();
    const beforeQueue = await queueCount();
    const { status, body } = await scanResolve({
      name: "Captain America's Shield",
      ocr_text: '0311 MSH \u2022 EN',
    });
    assert.strictEqual(status, 200, `scan-resolve failed: ${JSON.stringify(body)}`);
    assert.strictEqual(body.action, 'added',
      'a legible number on an ambiguous card must resolve it outright');
    assert.strictEqual(body.card.number, '311',
      `the number must select the EXACT printing, got ${body.card.number}`);
    assert.strictEqual(await ownedCount(), beforeOwned + 1, 'the chosen printing must reach the collection');
    assert.strictEqual(await queueCount(), beforeQueue, 'a resolved scan must not also queue');
    pass('FUNIQ-TC3', 'a readable collector number still picks the exact printing on an ambiguous card');
  }

  // --- FUNIQ-TC4: an unknown name is still queued with no candidates -------
  //
  // The pre-existing behaviour for a card the catalogue does not hold. The fix
  // must not turn "we have no idea" into an add.
  {
    const beforeOwned = await ownedCount();
    const { status, body } = await scanResolve({
      name: 'Not A Real Card Name At All',
      ocr_text: '',
    });
    assert.strictEqual(status, 200, `scan-resolve failed: ${JSON.stringify(body)}`);
    assert.strictEqual(body.action, 'staged_unresolved', 'an unknown card must still queue');
    assert.strictEqual(await ownedCount(), beforeOwned,
      'an unidentifiable scan must never add anything');
    pass('FUNIQ-TC4', 'an unknown card name still queues and adds nothing');
  }

  // --- FUNIQ-TC5: THE ALT-ART CASE. The artwork named the printing ---------
  //
  // Zach: "some should be auto matches like legend of Roku and dai li agents
  // because they are alt arts of the card so image alone should be enough."
  //
  // The scan index is per-ARTWORK, so a confident match identifies ONE printing.
  // The client used to send only the name, so this queued all three printings
  // and asked a question the matcher had already answered.
  {
    const beforeOwned = await ownedCount();
    const beforeQueue = await queueCount();
    const { status, body } = await scanResolve({
      name: "Captain America's Shield",
      ocr_text: '',                                  // strip still unreadable
      printing_hint: { set: 'msh', number: '317' },  // but the ART knew
    });
    assert.strictEqual(status, 200, `scan-resolve failed: ${JSON.stringify(body)}`);
    assert.strictEqual(body.action, 'added',
      'THE ALT-ART CASE: the artwork identified one printing, so it must be added');
    assert.strictEqual(body.card.number, '317',
      `the HINTED printing must be the one added, got ${body.card.number}`);
    assert.strictEqual(await ownedCount(), beforeOwned + 1);
    assert.strictEqual(await queueCount(), beforeQueue, 'nothing may queue when the art resolved it');
    pass('FUNIQ-TC5', 'an artwork-identified printing is added without needing the collector number');
  }

  // --- FUNIQ-TC6: A HINT THAT MATCHES NOTHING IS DISCARDED -----------------
  //
  // The hint is VALIDATED, never trusted. A stale client, a renamed set or a
  // plain bug must not be able to add a printing that does not exist — it falls
  // through to the normal number-then-queue path.
  {
    const beforeOwned = await ownedCount();
    const { status, body } = await scanResolve({
      name: "Captain America's Shield",
      ocr_text: '',
      printing_hint: { set: 'zzz', number: '999' },  // no such printing
    });
    assert.strictEqual(status, 200, `scan-resolve failed: ${JSON.stringify(body)}`);
    assert.strictEqual(body.action, 'staged_unresolved',
      'a hint matching no catalogue row must be discarded, not invented');
    assert.strictEqual(await ownedCount(), beforeOwned,
      'a bogus hint must never add anything');
    pass('FUNIQ-TC6', 'a printing hint that matches no catalogue row is discarded and the scan queues');
  }

  // --- FUNIQ-TC7: A HINT FOR A DIFFERENT CARD CANNOT CROSS OVER ------------
  //
  // The hint is filtered against THIS card's printings only. A hint naming a
  // real printing of some OTHER card must not pull that card in — that would be
  // the silent-wrong-card failure the resolver exists to prevent.
  {
    const beforeOwned = await ownedCount();
    const { body } = await scanResolve({
      name: "Captain America's Shield",
      ocr_text: '',
      printing_hint: { set: 'msh', number: '244' },  // real, but Solitary Relic's row too
    });
    // msh 244 IS a Captain America's Shield printing, so this one resolves —
    // the point is that it resolved to the SHIELD, never to Solitary Relic,
    // which shares that exact set and number.
    assert.strictEqual(body.action, 'added');
    assert.strictEqual(body.card.name, "Captain America's Shield",
      `the hint must be scoped to THIS card's printings, got ${body.card.name}`);
    assert.strictEqual(body.card.id, 'shield-244');
    assert.strictEqual(await ownedCount(), beforeOwned + 1);
    pass('FUNIQ-TC7', 'a printing hint is scoped to the matched card and cannot pull in another card');
  }

  console.log(`\nscan_unique_printing.test.js: ${passed} cases passed`);
}

main()
  .then(() => { if (server) server.close(); process.exit(0); })
  .catch((err) => {
    console.error('FAIL:', err && err.message);
    console.error(err);
    if (server) server.close();
    process.exit(1);
  });
