#!/usr/bin/env node
/**
 * IS THE WAL THE CAUSE? Prove it before fixing it.
 *
 * Measured on dev during a real refresh:
 *   staging phase        stats ~2.2s, steady
 *   swap phase           stats 28-31s, WAL grown to 177MB
 *   after checkpoint     same read 1ms, WAL truncated
 *
 * That is suggestive, not proof. This runs the SAME batched upsert the swap
 * runs, against a COPY of the dev database, and measures read latency in two
 * arms: without checkpointing, and checkpointing every N batches. If the WAL is
 * the mechanism, arm 1 degrades as the WAL grows and arm 2 does not.
 *
 * I have now twice "fixed" a phase I had not measured. This exists so the fix
 * is aimed at something demonstrated.
 *
 * Usage: node wal-probe.js <db-copy> [checkpointEvery]
 */
const path = require('path');
const dbPath = process.argv[2];
const CHECKPOINT_EVERY = Number(process.argv[3] || 0);   // 0 = never
if (!dbPath) { console.error('usage: wal-probe.js <db-copy> [checkpointEvery]'); process.exit(1); }

process.env.DB_PATH = dbPath;
const db = require(path.join(__dirname, '..', 'src', 'db'));

const READ = `SELECT COUNT(*) AS n, SUM(c.quantity) AS q
                FROM collection c
                JOIN card_cache cc ON cc.id = c.card_id
               WHERE c.user_id = 1 AND c.list_type = 'collection'`;

const walMB = () => {
  try { return Math.round(require('fs').statSync(dbPath + '-wal').size / 1048576); }
  catch { return 0; }
};

(async () => {
  await db.run(`PRAGMA journal_mode = WAL`);
  await db.run(`PRAGMA wal_checkpoint(TRUNCATE)`);

  // A staging table shaped like the real one: every column of card_cache.
  const cols = (await db.all(`PRAGMA table_info(card_cache)`))
    .map(c => c.name).filter(n => n !== 'last_updated');
  await db.run(`DROP TABLE IF EXISTS wal_probe_stage`);
  await db.run(`CREATE TABLE wal_probe_stage AS
                SELECT ${cols.join(', ')} FROM card_cache`);
  const { total } = await db.get(`SELECT COUNT(*) AS total FROM wal_probe_stage`);

  let idle = Infinity;
  for (let i = 0; i < 5; i++) {
    const t = Date.now(); await db.all(READ); idle = Math.min(idle, Date.now() - t);
  }

  console.log(`rows to swap : ${total}`);
  console.log(`idle read    : ${idle}ms`);
  console.log(`checkpoint   : ${CHECKPOINT_EVERY ? `every ${CHECKPOINT_EVERY} batches` : 'NEVER (current behaviour)'}`);
  console.log('');
  console.log('  batch |  wal   | read');
  console.log('  ------+--------+------');

  const BATCH = 2000;
  let lastRowid = 0, done = 0, batchNo = 0, worst = 0;

  while (done < total) {
    const rows = await db.all(
      `SELECT rowid AS rid FROM wal_probe_stage WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      [lastRowid, BATCH]);
    if (!rows.length) break;
    const hi = rows[rows.length - 1].rid;

    await db.run(`INSERT OR REPLACE INTO card_cache (${cols.join(', ')}, last_updated)
                  SELECT ${cols.join(', ')}, CURRENT_TIMESTAMP
                    FROM wal_probe_stage WHERE rowid > ? AND rowid <= ?`,
                 [lastRowid, hi]);

    lastRowid = hi; done += rows.length; batchNo++;

    if (CHECKPOINT_EVERY && batchNo % CHECKPOINT_EVERY === 0) {
      await db.run(`PRAGMA wal_checkpoint(TRUNCATE)`);
    }

    const t = Date.now();
    await db.all(READ);
    const took = Date.now() - t;
    if (took > worst) worst = took;
    if (batchNo % 8 === 0) {
      console.log(`  ${String(batchNo).padStart(5)} | ${String(walMB()).padStart(4)}MB | ${took}ms`);
    }
    await new Promise(r => setTimeout(r, 25));
  }

  console.log('');
  console.log(`WORST read during the swap: ${worst}ms   (idle ${idle}ms, final WAL ${walMB()}MB)`);
  await db.run(`DROP TABLE IF EXISTS wal_probe_stage`);
  await db.run(`PRAGMA wal_checkpoint(TRUNCATE)`);
  process.exit(0);
})().catch(e => { console.error('THREW:', e.message); process.exit(1); });
