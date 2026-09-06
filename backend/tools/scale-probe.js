#!/usr/bin/env node
/**
 * SCALE PROBE -- how do the hot queries behave as the collection grows?
 *
 * Zach: "I want to make sure in the future it can handle 10k cards."
 *
 * SAFETY: operates on a COPY of the database. It never opens the live file.
 * The copy is scaled by duplicating existing collection rows onto real
 * card_cache ids, so the joins and indexes behave as they would with genuine
 * data rather than against synthetic ids that index perfectly.
 *
 * Reports the SHAPE of the curve, which is the thing that matters: 2x the rows
 * costing 2x is survivable, 2x costing 4x is a wall.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = process.argv[2];
const SIZES = (process.argv[3] || '2438,5000,10000,20000').split(',').map(Number);
const WORK = '/tmp/scaleprobe';

if (!SRC || !fs.existsSync(SRC)) { console.error('usage: scale-probe.js <path-to-db> [sizes]'); process.exit(1); }
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const DB = path.join(WORK, 'probe.db');
fs.copyFileSync(SRC, DB);
for (const ext of ['-wal', '-shm']) {
  if (fs.existsSync(SRC + ext)) fs.copyFileSync(SRC + ext, DB + ext);
}

process.env.DB_PATH = DB;
const db = require('/opt/bindarr-dev/backend/src/db');

const DECK_LIST_SQL = fs.readFileSync('/tmp/decklist.sql', 'utf8');

// The collection query, read from the route itself rather than retyped -- my
// first attempt invented a column (cc.image_uri) that does not exist, which
// would have measured a query the app never runs.
const COLLECTION_SQL = fs.readFileSync('/tmp/collection.sql', 'utf8');

async function timeIt(label, fn, n = 5) {
  await fn();                                   // warm
  const runs = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    await fn();
    runs.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  runs.sort((a, b) => a - b);
  return { label, median: runs[Math.floor(runs.length / 2)], max: runs[runs.length - 1] };
}

(async () => {
  const uid = (await db.get(`SELECT user_id FROM collection LIMIT 1`)).user_id;
  const out = [];

  for (const target of SIZES) {
    let have = (await db.get(`SELECT COUNT(*) c FROM collection WHERE user_id = ?`, [uid])).c;
    // Grow by cloning real rows onto real catalogue ids.
    while (have < target) {
      const need = Math.min(target - have, 5000);
      await db.run(`
        INSERT INTO collection (user_id, card_id, quantity, finish, list_type, condition)
        SELECT user_id, card_id, 1, finish, list_type, condition
          FROM collection WHERE user_id = ? LIMIT ?`, [uid, need]);
      have = (await db.get(`SELECT COUNT(*) c FROM collection WHERE user_id = ?`, [uid])).c;
    }

    const rows = (await db.get(`SELECT COUNT(*) c FROM collection WHERE user_id = ?`, [uid])).c;
    const deckList = await timeIt('deck-list', () => db.all(DECK_LIST_SQL, [uid]));
    const collection = await timeIt('collection', () => db.all(COLLECTION_SQL, [uid, 'collection']));
    const search = await timeIt('catalogue-search',
      () => db.all(`SELECT id,name,set_id,number FROM card_cache WHERE name LIKE ? LIMIT 50`, ['%dragon%']));

    out.push({ rows, deckListMs: +deckList.median.toFixed(1),
               collectionMs: +collection.median.toFixed(1),
               searchMs: +search.median.toFixed(1) });
    console.error(`  measured at ${rows} rows`);
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})();
