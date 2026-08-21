// BUG 1: a TRANSFORMING double-faced card produced an UNRESOLVABLE queue entry.
//
// THE SHAPE OF THE BUG, measured against the live dev database:
//
//   the scan index (Scryfall `unique_artwork`) returns, for Avatar Aang:
//       'Avatar Aang // Aang, Master of Elements'
//   card_cache stores the card object's OWN name, which for a TRANSFORMING
//   DFC is the FRONT FACE ONLY:
//       name='Avatar Aang'  set_id='tla'  number='207' (plus tla 308, tla 363, ptla 207s)
//
// printingsByName looked up the combined name, found ZERO rows, and
// resolveScannedPrinting took its `!all.length` branch: reason 'unreadable'
// with candidates: []. The queue entry then rendered 'No printings of this
// card are in your catalog yet' with NOTHING TO TAP. The card could not be
// added to the collection at all — not by scanning, not by resolving.
//
// WHY THE OBVIOUS FIX IS WRONG. "Strip everything after //" would break 916
// rows in the live catalogue. SPLIT and ADVENTURE cards — 'Dusk // Dawn',
// 'Consecrate // Consume', "Obyra's Attendants // Desperate Parry" — are
// STORED under the combined name. Truncating their name would turn a card
// that resolves today into one that does not, trading one unresolvable queue
// entry for 916 of them.
//
// Two live rows make that concrete: 'Bind // Liberate' and
// 'Smelt // Herd // Saw' BOTH have a standalone catalogue row for their front
// face ('Bind', 'Smelt') as well as the combined row. A truncating lookup
// would silently return the WRONG card's printings for those. So the order is
// load-bearing: COMBINED FIRST, front face only as a FALLBACK when the
// combined name yields nothing.
//
// WHAT THIS SUITE PROVES, and why it is an e2e suite rather than a unit test.
// A prior PR shipped a backend the frontend never called, and a prior fix was
// tuned against a harness feeding the OCR module a crop the real route never
// produces. Both were green. So this drives the REAL express app with the REAL
// collection routes and a REAL database, through the REAL /api/scan-resolve
// route, and asserts the queue entry that comes back HAS CANDIDATES. A unit
// test calling printingsByName directly would not prove the queue entry is
// resolvable — which is the only property Zach cares about.
const assert = require('assert');
const express = require('express');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-dfc-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';

const db = require('../../src/db');
const collectionRoutes = require('../../src/routes/collection');

let server;
let passed = 0;
function pass(id, msg) { passed++; console.log(`PASS: ${id} - ${msg}`); }

// Every row here mirrors a REAL row in the live dev catalogue (104,473 rows),
// including the exact set codes and collector numbers, so the shapes under
// test are the shapes that actually shipped.
const CARDS = [
  // --- TRANSFORMING DFC: stored under the FRONT FACE name only -------------
  { id: 'fe29e909-50e9-4f04-b1a3-2cc5d7e3efe8', oracle_id: 'o-aang', name: 'Avatar Aang', set_id: 'tla', set_name: 'Avatar: The Last Airbender', number: '207' },
  { id: '257928ba-27ae-4a11-ae41-76dfcd626ed4', oracle_id: 'o-aang', name: 'Avatar Aang', set_id: 'tla', set_name: 'Avatar: The Last Airbender', number: '308' },
  { id: 'd0467b6f-8c7d-4fcd-99f8-d335bb736484', oracle_id: 'o-aang', name: 'Avatar Aang', set_id: 'tla', set_name: 'Avatar: The Last Airbender', number: '363' },
  { id: 'd197ea70-5d41-4ad3-b473-a794f20a2109', oracle_id: 'o-aang', name: 'Avatar Aang', set_id: 'ptla', set_name: 'Avatar Promos', number: '207s' },

  // --- SPLIT CARD: stored under the COMBINED name -------------------------
  { id: 'dusk-akh', oracle_id: 'o-dusk', name: 'Dusk // Dawn', set_id: 'akh', set_name: 'Amonkhet', number: '210' },
  { id: 'dusk-c19', oracle_id: 'o-dusk', name: 'Dusk // Dawn', set_id: 'c19', set_name: 'Commander 2019', number: '63' },

  // --- THE COLLISION CASE, and it is why order matters --------------------
  // 'Bind // Liberate' is stored combined, AND a completely different card
  // named 'Bind' has its own row. If the front-face fallback ran FIRST (or
  // unconditionally), scanning 'Bind // Liberate' would return Bind's
  // printings — a WRONG card, silently.
  { id: 'bind-liberate', oracle_id: 'o-bindlib', name: 'Bind // Liberate', set_id: 'grn', set_name: 'Guilds of Ravnica', number: '221' },
  { id: 'bind-solo', oracle_id: 'o-bind', name: 'Bind', set_id: 'wth', set_name: 'Weatherlight', number: '52' },
];

const SETS = [
  ['tla', 'Avatar: The Last Airbender', '2025-11-21'],
  ['ptla', 'Avatar Promos', '2025-11-21'],
  ['akh', 'Amonkhet', '2017-04-28'],
  ['c19', 'Commander 2019', '2019-08-23'],
  ['grn', 'Guilds of Ravnica', '2018-10-05'],
  ['wth', 'Weatherlight', '1997-06-09'],
];

async function seed() {
  for (const c of CARDS) {
    await db.run(
      `INSERT OR REPLACE INTO card_cache
        (id, oracle_id, name, supertype, subtypes, types, rarity, set_id, set_name,
         number, image_url, type_line, cmc, color_identity, legalities, finishes, last_updated)
       VALUES (?, ?, ?, 'MTG', '[]', '[]', 'Rare', ?, ?, ?, '', 'Creature', 3, '[]', ?, ?, CURRENT_TIMESTAMP)`,
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
  const user = await createUser('dfcuser');

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  // Routers mount at BARE /api in this app.
  app.use('/api', collectionRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;

  // The REAL route, over real HTTP, with a real auth session.
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

  // --- FDFC-TC1: THE BUG. A transforming DFC must come back RESOLVABLE ------
  //
  // This is the case Zach hit. The assertion that matters is not the reason
  // string — it is `candidates.length > 0`. An entry with no candidates has
  // nothing to tap and the card can never enter the collection.
  {
    const { status, body } = await scanResolve({
      name: 'Avatar Aang // Aang, Master of Elements',
      ocr_text: '',   // blurred / unreadable number: the common auto-scan case
    });
    assert.strictEqual(status, 200, `scan-resolve failed: ${JSON.stringify(body)}`);
    assert.strictEqual(body.action, 'queued', 'no confident number -> must queue');
    assert.ok(body.candidates.length > 0,
      'THE BUG: a DFC queue entry came back with NO candidates and is unresolvable');
    assert.strictEqual(body.candidates.length, 4,
      `all four Avatar Aang printings must be offered, got ${body.candidates.map(c => `${c.set_id}:${c.number}`).join(',')}`);
    const numbers = body.candidates.map(c => c.number).sort();
    assert.deepStrictEqual(numbers, ['207', '207s', '308', '363'],
      'the front-face printings in card_cache must all be offered');
    pass('FDFC-TC1', 'a transforming DFC resolves to its front-face printings through the real route');
  }

  // --- FDFC-TC2: and that entry is ACTUALLY RESOLVABLE ---------------------
  //
  // TC1 proves candidates came back. This proves the whole loop closes: read
  // the entry from the server as the review screen does, pick a candidate,
  // and confirm the card reaches the collection. That is the property the
  // 'No printings of this card are in your catalog yet' dead end denied him.
  {
    const listResp = await fetch(`${base}/api/scan-queue`, {
      headers: { Authorization: `Bearer ${user.token}` },
    });
    const list = await listResp.json();
    const entry = list.entries.find(e => e.matched_name === 'Avatar Aang // Aang, Master of Elements');
    assert.ok(entry, 'the DFC entry must be readable from the server');
    assert.ok(entry.candidates.length > 0,
      'the STORED entry must carry candidates too — the review screen reads this, not the scan response');

    const before = await ownedCount();
    const chosen = entry.candidates.find(c => c.number === '207');
    assert.ok(chosen, 'the tla 207 printing Zach actually holds must be among the stored candidates');
    const resolveResp = await fetch(`${base}/api/scan-queue/${entry.id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
      body: JSON.stringify({ card_id: chosen.id, printing: 'nonfoil', quantity: 1 }),
    });
    assert.strictEqual(resolveResp.status, 200,
      `resolving the DFC entry failed: ${JSON.stringify(await resolveResp.json())}`);
    assert.strictEqual(await ownedCount(), before + 1,
      'THE POINT OF THE FIX: the DFC must actually be addable to the collection');
    pass('FDFC-TC2', 'the DFC queue entry is resolvable and the card reaches the collection');
  }

  // --- FDFC-TC3: a DFC with a READABLE number resolves to ONE printing -----
  //
  // The fallback must feed the whole resolver, not just the candidate list.
  // With a confident read of '207' there is exactly one match, so the card is
  // ADDED outright and never troubles the queue at all.
  {
    const before = await ownedCount();
    const { body } = await scanResolve({
      name: 'Avatar Aang // Aang, Master of Elements',
      ocr_text: '207/234 M\nTLA * EN',
    });
    assert.strictEqual(body.action, 'added',
      `a confident read of a DFC must add outright, got ${JSON.stringify(body)}`);
    assert.strictEqual(body.card.number, '207');
    assert.strictEqual(body.card.set_id, 'tla');
    assert.strictEqual(await ownedCount(), before + 1);
    pass('FDFC-TC3', 'a confidently-read DFC adds the exact front-face printing, no queue entry');
  }

  // --- FDFC-TC4: a SPLIT card still matches its COMBINED name --------------
  //
  // The regression guard for the 916 rows. 'Dusk // Dawn' is STORED combined,
  // so it must resolve on the combined name and must NOT be truncated to
  // 'Dusk' (which is not in the catalogue at all and would return nothing).
  {
    const { body } = await scanResolve({ name: 'Dusk // Dawn', ocr_text: '' });
    assert.strictEqual(body.action, 'queued');
    assert.strictEqual(body.candidates.length, 2,
      `the split card's combined name must still match both printings, got ${body.candidates.length}`);
    for (const c of body.candidates) {
      assert.strictEqual(c.name, 'Dusk // Dawn',
        'a split card must keep its COMBINED name — truncation would break 916 catalogue rows');
    }
    pass('FDFC-TC4', 'a split card still resolves under its combined name and is not truncated');
  }

  // --- FDFC-TC5: COMBINED IS TRIED FIRST — the collision case --------------
  //
  // 'Bind // Liberate' is in the catalogue combined, and an unrelated card
  // called 'Bind' also exists. If the front-face fallback were tried first,
  // or applied unconditionally, this scan would return Weatherlight's 'Bind'.
  // That is the silent-wrong-card failure the whole resolver exists to
  // prevent, so it gets its own case rather than riding on TC4.
  //
  // REVISED for the art-first ordering: 'Bind // Liberate' has exactly ONE
  // printing, so it is now ADDED rather than queued. The property under test
  // is unchanged and is the only one that matters here — WHICH card was
  // identified. Asserting on the added printing is in fact a stronger check
  // than asserting on a candidate list, because it proves the wrong card did
  // not merely fail to be offered, but never reached the collection.
  {
    const before = await ownedCount();
    const { body } = await scanResolve({ name: 'Bind // Liberate', ocr_text: '' });
    assert.strictEqual(body.action, 'added',
      `one printing exists for the combined name, so it resolves outright. got ${JSON.stringify(body)}`);
    assert.strictEqual(body.card.id, 'bind-liberate',
      `the COMBINED-name printing must be the one added, got ${body.card.id}`);
    assert.strictEqual(body.card.name, 'Bind // Liberate');
    assert.notStrictEqual(body.card.id, 'bind-solo',
      'the unrelated card named "Bind" must NEVER be added — the combined name matched, so no fallback may run');
    assert.strictEqual(await ownedCount(), before + 1);
    pass('FDFC-TC5', 'the combined name is tried FIRST; the fallback never runs when it matches');
  }

  // --- FDFC-TC6: a genuinely absent card still queues EMPTY ----------------
  //
  // The fix must not invent candidates. A card that is in no form in the
  // catalogue must still produce the honest 'nothing here' entry, otherwise
  // the fallback would be papering over a real catalogue gap.
  {
    const { body } = await scanResolve({ name: 'Nonexistent Card // Nonexistent Back', ocr_text: '' });
    assert.strictEqual(body.action, 'queued');
    assert.strictEqual(body.candidates.length, 0,
      'a card absent from the catalogue must NOT gain invented candidates');
    pass('FDFC-TC6', 'a card genuinely absent from the catalogue still queues with no candidates');
  }

  console.log(`\nscan_dfc_name.test.js: ${passed} cases passed`);
}

main()
  .then(async () => {
    if (server) server.close();
    await db.close?.();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('FAIL: FDFC-TC0', err);
    if (server) server.close();
    process.exit(1);
  });
