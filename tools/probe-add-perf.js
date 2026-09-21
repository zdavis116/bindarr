// WHERE DOES THE TIME ACTUALLY GO when adding a precon?
//
// Zach: "it takes way to long to add a deck. Why is it inserting 1 card at a
// time? Shouldnt it be bulk inserting."
//
// He is right that it is slow, but I should not guess at WHY and then optimise
// the wrong thing. The suspicion is that the cost is not the INSERT at all --
// it is that every card opens its own transaction (addCardToCollection wraps
// itself in db.withTransaction), so 72 cards means 72 BEGIN IMMEDIATE/COMMIT
// pairs, each with an fsync, plus 72 placement resolutions.
//
// Measure before changing anything.
const sqlite3 = require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const DB = '/var/lib/bindarr-dev/bindarr.db';

const open = (mode) => new sqlite3.Database(DB, mode);
const runOn = (db, sql, p = []) => new Promise((res, rej) =>
  db.run(sql, p, function cb(e) { return e ? rej(e) : res(this); }));
const allOn = (db, sql, p = []) => new Promise((res, rej) =>
  db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

(async () => {
  const db = open(sqlite3.OPEN_READONLY);

  // 1. Is placement even doing anything? Storage was deleted in Sept 2026, so
  //    resolveCompartmentAndPosition may be pure overhead now.
  const loc = await allOn(db,
    `SELECT COUNT(*) n, SUM(CASE WHEN location_id IS NOT NULL THEN 1 ELSE 0 END) withLoc,
            SUM(CASE WHEN compartment_id IS NOT NULL THEN 1 ELSE 0 END) withComp
       FROM collection`);
  console.log('collection rows:', JSON.stringify(loc[0]));

  const tables = await allOn(db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN
      ('locations','compartments')`);
  console.log('storage tables present:', tables.map((t) => t.name).join(',') || 'NONE');

  const journal = await allOn(db, 'PRAGMA journal_mode');
  const sync = await allOn(db, 'PRAGMA synchronous');
  console.log('journal_mode:', JSON.stringify(journal[0]), 'synchronous:', JSON.stringify(sync[0]));
  db.close();

  // 2. TIME THE TWO SHAPES against a scratch copy, so nothing real is touched.
  const scratch = '/tmp/perf-probe.db';
  require('node:fs').copyFileSync(DB, scratch);
  const w = new sqlite3.Database(scratch);

  const N = 72;
  const sample = await allOn(w, 'SELECT id FROM card_cache LIMIT ?', [N]);
  const ids = sample.map((r) => r.id);

  // Shape A: one transaction PER CARD -- what the code does today.
  const t0 = Date.now();
  for (const id of ids) {
    await runOn(w, 'BEGIN IMMEDIATE');
    await runOn(w,
      `INSERT INTO collection (card_id, user_id, quantity, condition, printing,
        finish, purchase_price, is_trade, list_type)
       VALUES (?, 1, 1, 'Near Mint', 'Normal', 'nonfoil', 0, 0, 'perfprobe')`, [id]);
    await runOn(w, 'COMMIT');
  }
  const perCard = Date.now() - t0;

  // Shape B: ONE transaction for all of them.
  const t1 = Date.now();
  await runOn(w, 'BEGIN IMMEDIATE');
  for (const id of ids) {
    await runOn(w,
      `INSERT INTO collection (card_id, user_id, quantity, condition, printing,
        finish, purchase_price, is_trade, list_type)
       VALUES (?, 1, 1, 'Near Mint', 'Normal', 'nonfoil', 0, 0, 'perfprobe')`, [id]);
  }
  await runOn(w, 'COMMIT');
  const oneTx = Date.now() - t1;

  console.log(`\n${N} inserts, one transaction EACH : ${perCard} ms`);
  console.log(`${N} inserts, ONE transaction total: ${oneTx} ms`);
  console.log(`speedup: ${(perCard / Math.max(oneTx, 1)).toFixed(1)}x`);

  await runOn(w, "DELETE FROM collection WHERE list_type='perfprobe'");
  w.close();
  require('node:fs').unlinkSync(scratch);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
