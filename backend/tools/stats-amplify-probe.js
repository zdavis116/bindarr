#!/usr/bin/env node
/**
 * WHY /api/stats SPECIFICALLY? Prove the amplifier before fixing anything.
 *
 * Established by measurement so far:
 *   staging phase                stats ~2.2s steady        NOT the problem
 *   colour-identity query        20ms                      NOT the problem
 *   WAL growth to 150MB          reads stay 3ms            NOT the problem
 *   swap phase                   stats 28-31s              <- here
 *
 * A SINGLE read during the swap is fast (3ms, measured). So the stall is not one
 * query waiting -- it is /api/stats issuing MANY queries in sequence, each of
 * which has to wait its turn behind the next swap batch. stats.js runs a loop
 * over sets with one db.get per set, plus a dozen other queries.
 *
 * N sequential queries x (time waiting for the current batch) = the 28 seconds.
 *
 * This arm-tests that directly: same swap workload, but timing a ONE-query read
 * against a MANY-query read.
 *
 * Usage: node stats-amplify-probe.js <db-copy>
 */
const path = require('path');
const dbPath = process.argv[2];
if (!dbPath) { console.error('usage: stats-amplify-probe.js <db-copy>'); process.exit(1); }
process.env.DB_PATH = dbPath;
const db = require(path.join(__dirname, '..', 'src', 'db'));

const ONE = `SELECT COUNT(*) AS n FROM collection WHERE user_id = 1`;

// What stats.js actually does: a per-set query in a loop, sequentially.
async function manyQueryRead() {
  const sets = ['akh', 'dft', 'msh', 'tmt', 'hob', 'rix', 'tdm', 'tla',
                'j25', 'jmp', 'znr', 'c21', 'lea', 'mh2', 'ltr', 'woe'];
  for (const s of sets) {
    await db.get(
      `SELECT COUNT(DISTINCT card_id) AS c FROM collection c
        JOIN card_cache cc ON cc.id = c.card_id
       WHERE cc.set_id = ? AND c.user_id = 1`, [s]);
  }
}

(async () => {
  const cols = (await db.all(`PRAGMA table_info(card_cache)`))
    .map(c => c.name).filter(n => n !== 'last_updated');
  await db.run(`DROP TABLE IF EXISTS amp_stage`);
  await db.run(`CREATE TABLE amp_stage AS SELECT ${cols.join(', ')} FROM card_cache`);
  const { total } = await db.get(`SELECT COUNT(*) AS total FROM amp_stage`);

  let t = Date.now(); await db.all(ONE);       const idleOne = Date.now() - t;
  t = Date.now(); await manyQueryRead();       const idleMany = Date.now() - t;
  console.log(`idle: one-query ${idleOne}ms | many-query ${idleMany}ms`);
  console.log('');

  const BATCH = 2000;
  let lastRowid = 0, done = 0, n = 0, worstOne = 0, worstMany = 0;

  while (done < total) {
    const rows = await db.all(
      `SELECT rowid AS rid FROM amp_stage WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      [lastRowid, BATCH]);
    if (!rows.length) break;
    const hi = rows[rows.length - 1].rid;

    await db.run(`INSERT OR REPLACE INTO card_cache (${cols.join(', ')}, last_updated)
                  SELECT ${cols.join(', ')}, CURRENT_TIMESTAMP
                    FROM amp_stage WHERE rowid > ? AND rowid <= ?`, [lastRowid, hi]);
    lastRowid = hi; done += rows.length; n++;

    // Do NOT await the swap pause before reading -- a real request arrives at an
    // arbitrary moment, usually mid-batch.
    const a = Date.now(); await db.all(ONE);        const one = Date.now() - a;
    const b = Date.now(); await manyQueryRead();    const many = Date.now() - b;
    if (one > worstOne) worstOne = one;
    if (many > worstMany) worstMany = many;
    if (n % 10 === 0) console.log(`  batch ${String(n).padStart(3)}: one=${one}ms  many=${many}ms`);
    await new Promise(r => setTimeout(r, 25));
  }

  console.log('');
  console.log(`WORST one-query read : ${worstOne}ms`);
  console.log(`WORST many-query read: ${worstMany}ms   <- what /api/stats does`);
  console.log(worstMany > worstOne * 3
    ? 'CONFIRMED: the amplifier is the number of sequential queries, not any one of them.'
    : 'NOT CONFIRMED: something else explains the stall.');
  await db.run(`DROP TABLE IF EXISTS amp_stage`);
  process.exit(0);
})().catch(e => { console.error('THREW:', e.message); process.exit(1); });
