// The scan staging area, exercised THROUGH THE REAL ROUTES.
//
// WHY THIS SUITE EXISTS. Zach asked for staging because he does not trust silent
// automatic writes to a collection that tracks PHYSICAL objects: "instead of
// auto putting in my collection. Just putting aside and at the end letting me
// add all. That way I can ensure no weirdness occurred or ensure there isn't any
// dupes."
//
// So the properties worth testing are not "does the endpoint return 200". They
// are: staged cards are NOT owned until he says so; the commit is ALL OR
// NOTHING; and the list tells him where to look instead of making him find it.
//
// Every case POSTs to a real express app with the real routes and a real
// database. A test that called the helpers directly would pass on code that is
// broken through the route, which this repo has been bitten by before.
const assert = require('assert');
const express = require('express');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-staging-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';

const db = require('../../src/db');
const collectionRoutes = require('../../src/routes/collection');

let server, base, token, passed = 0;
function pass(id, msg) { passed++; console.log(`PASS: ${id} - ${msg}`); }

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

async function main() {
  await db.initDb();
  const u = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?,?,'member',?)`,
    ['stager', db.hashPassword('test-only-password'), `share-stage-${process.pid}`]);
  token = `stage-${process.pid}`;
  await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)`,
    [token, u.lastID, new Date(Date.now() + 600000).toISOString()]);
  const userId = u.lastID;

  // Two real catalogue rows to stage.
  await db.run(
    `INSERT INTO card_cache (id, oracle_id, name, set_id, number)
     VALUES (?,?,?,?,?), (?,?,?,?,?), (?,?,?,?,?)`,
    ['card-sol', 'oracle-sol', 'Sol Ring', 'cmm', '263',
     'card-bolt', 'oracle-bolt', 'Lightning Bolt', 'lea', '161',
     // A card Zach ALREADY OWNS, for FST-TC3B.
     'card-owned', 'oracle-owned', 'Counterspell', 'tmp', '61']);

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api', collectionRoutes);
  server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  // --- FST-TC1: a staged card is NOT in the collection --------------------
  //
  // The entire promise of staging. If a staged scan were visible as owned, the
  // feature would be a lie and he would be reconciling against a collection
  // containing cards he never approved.
  {
    const r = await api('/api/scan-stage', { method: 'POST', body: { card_id: 'card-sol' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.staged);

    const owned = await db.get(
      `SELECT COUNT(*) n FROM collection WHERE user_id = ?`, [userId]);
    assert.strictEqual(owned.n, 0, 'staging must not write to the collection');
    pass('FST-TC1', 'a staged scan is not owned until committed');
  }

  // --- FST-TC2: the session survives and lists what was staged ------------
  {
    const r = await api('/api/scan-stage');
    assert.strictEqual(r.body.total, 1);
    assert.strictEqual(r.body.entries[0].name, 'Sol Ring',
      'the list must resolve card names, or a review list is unreadable');
    pass('FST-TC2', 'the staged session lists resolved cards');
  }

  // --- FST-TC3: scanning the same printing twice is FLAGGED, not silently
  //     merged and not silently duplicated ---------------------------------
  //
  // Zach's stated reason for wanting staging at all: "ensure there isn't any
  // dupes". Both silent options are wrong — merging hides that he scanned twice,
  // duplicating hides it just as well. Flagging tells him and lets him decide.
  {
    const r = await api('/api/scan-stage', { method: 'POST', body: { card_id: 'card-sol' } });
    assert.strictEqual(r.body.flag, 'duplicate_in_session',
      `a repeat scan must be flagged, got ${r.body.flag}`);
    const list = await api('/api/scan-stage');
    assert.strictEqual(list.body.total, 2, 'the repeat is kept, not swallowed');
    assert.strictEqual(list.body.flagged, 1, 'and it is counted as needing a look');
    pass('FST-TC3', 'a duplicate scan is flagged rather than silently merged or hidden');
  }

  // --- FST-TC3B: ALREADY OWNING A COPY IS NOT A WARNING --------------------
  //
  // Zach: "I shouldnt get a warning in the scanned list if this card is in my
  // collection already only if I scanned it twice this session."
  //
  // Owning a second copy is a normal, intentional thing for a collector to do.
  // Flagging it warns about the intended outcome of the action he just took --
  // and a flag that fires on ordinary behaviour trains him to skim past ALL of
  // them, including 'low_confidence', which is the only one questioning whether
  // the app identified the right card.
  //
  // The distinction that survives: scanning the same card twice IN ONE SESSION
  // usually means the scanner double-fired on one piece of cardboard, which is
  // a real question about the physical stack (FST-TC3 above).
  {
    // Put a card in the collection, then start a clean session and scan it.
    await api('/api/collection', { method: 'POST', body: { card_id: 'card-owned', quantity: 1 } });
    const list = await api('/api/scan-stage');
    for (const e of list.body.entries) {
      await api(`/api/scan-stage/${e.id}`, { method: 'DELETE' });
    }
    const r = await api('/api/scan-stage', { method: 'POST', body: { card_id: 'card-owned' } });
    assert.strictEqual(r.body.flag, null,
      `owning a copy already must NOT flag the scan, got ${r.body.flag}`);

    // ...but scanning it a second time in the SAME session still does.
    const again = await api('/api/scan-stage', { method: 'POST', body: { card_id: 'card-owned' } });
    assert.strictEqual(again.body.flag, 'duplicate_in_session',
      `a repeat within the session must still flag, got ${again.body.flag}`);
    pass('FST-TC3B', 'owning a copy is not flagged; scanning twice in a session still is');
  }

  // --- FST-TC4: a staged row can be corrected before it becomes real -------
  {
    const list = await api('/api/scan-stage');
    const id = list.body.entries[0].id;
    const r = await api(`/api/scan-stage/${id}`, { method: 'PATCH', body: { quantity: 3, condition: 'Lightly Played' } });
    assert.strictEqual(r.status, 200);
    const after = await api('/api/scan-stage');
    const row = after.body.entries.find(e => e.id === id);
    assert.strictEqual(row.quantity, 3);
    assert.strictEqual(row.condition, 'Lightly Played');
    pass('FST-TC4', 'a staged row can be fixed before commit');
  }

  // --- FST-TC5: discarding one row leaves the rest of the session ----------
  {
    const list = await api('/api/scan-stage');
    const id = list.body.entries[1].id;
    await api(`/api/scan-stage/${id}`, { method: 'DELETE' });
    const after = await api('/api/scan-stage');
    assert.strictEqual(after.body.total, 1, 'only the discarded row goes');
    pass('FST-TC5', 'a mis-scan can be dropped without losing the session');
  }

  // --- FST-TC6: COMMIT moves everything into the collection and empties
  //     staging, so a card is in exactly one place ---------------------------
  {
    await api('/api/scan-stage', { method: 'POST', body: { card_id: 'card-bolt' } });
    const before = await api('/api/scan-stage');
    const n = before.body.total;
    assert.ok(n >= 2, 'need several rows to prove a batch commit');

    const r = await api('/api/scan-stage/commit', { method: 'POST' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.committed, n, `expected ${n} committed, got ${r.body.committed}`);

    const after = await api('/api/scan-stage');
    assert.strictEqual(after.body.total, 0, 'staging must be empty after commit');
    const owned = await db.get(`SELECT COUNT(*) n FROM collection WHERE user_id = ?`, [userId]);
    assert.ok(owned.n >= 1, 'the cards must now actually be owned');
    pass('FST-TC6', 'commit moves the whole session into the collection and clears staging');
  }

  // --- FST-TC7: THE DANGEROUS ONE — a failing commit changes NOTHING -------
  //
  // A partial commit is the worst available outcome: some unknown subset of a
  // physical stack lands in the collection, and Zach cannot tell which. He has
  // already put the cards away. Refusing loudly and changing nothing is
  // recoverable; a silent partial write is not.
  //
  // The failure is forced by pointing the SECOND staging row at a card_id that
  // is not in the catalogue, written straight to the table so it bypasses the
  // stage endpoint's own validation. That models the realistic shape of this
  // bug — a row that looks fine in the list but that the add path rejects when
  // it finally runs — and because it is the second row, a non-atomic
  // implementation will already have committed the first.
  {
    await api('/api/scan-stage', { method: 'POST', body: { card_id: 'card-sol' } });
    await api('/api/scan-stage', { method: 'POST', body: { card_id: 'card-sol' } });
    const staged = await api('/api/scan-stage');
    assert.strictEqual(staged.body.total, 2);

    const ownedBefore = await db.get(
      `SELECT COALESCE(SUM(quantity),0) q FROM collection WHERE user_id = ?`, [userId]);

    const second = staged.body.entries[1].id;
    await db.run(`UPDATE scan_staging SET card_id = 'no-such-card' WHERE id = ?`, [second]);

    const r = await api('/api/scan-stage/commit', { method: 'POST' });
    assert.notStrictEqual(r.status, 200, 'a commit that cannot complete must not report success');
    assert.strictEqual(r.body.committed, 0, 'a failed commit must report zero committed');

    const ownedAfter = await db.get(
      `SELECT COALESCE(SUM(quantity),0) q FROM collection WHERE user_id = ?`, [userId]);
    assert.strictEqual(ownedAfter.q, ownedBefore.q,
      `a failed commit must not add ANY card: had ${ownedBefore.q}, now ${ownedAfter.q}`);

    const stillStaged = await api('/api/scan-stage');
    assert.strictEqual(stillStaged.body.total, 2,
      'the session must survive a failed commit so he can fix it and retry');
    pass('FST-TC7', 'a failing commit is all-or-nothing: nothing added, session intact');
  }

  // --- FST-TC8: abandoning the session adds nothing ------------------------
  {
    const r = await api('/api/scan-stage', { method: 'DELETE' });
    assert.strictEqual(r.status, 200);
    const after = await api('/api/scan-stage');
    assert.strictEqual(after.body.total, 0);
    pass('FST-TC8', 'the whole session can be abandoned without adding anything');
  }

  console.log(`\nscan_staging.test.js: ${passed} cases passed`);
  server.close();
  process.exit(0);
}

main().catch(e => { console.error('FAIL:', e.message); if (server) server.close(); process.exit(1); });
