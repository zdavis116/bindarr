#!/usr/bin/env node
/**
 * EQUIVALENCE CHECK: does the rewritten deck-list query return EXACTLY what the
 * old one does?
 *
 * This is the whole safety argument for the rewrite. The completion figure has
 * burned Zach twice ("it shows 97% complete ... but actually I am missing 97
 * cards"), so a faster query that is even slightly different is a regression,
 * not an optimisation.
 *
 * Runs both against a COPY of the real database, compares every field of every
 * row, and repeats at 10k collection rows -- because a bug in the claims window
 * function would only show up once several requirements compete for one pool.
 */
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2];
const WORK = '/tmp/equivprobe';
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const DB = path.join(WORK, 'probe.db');
fs.copyFileSync(SRC, DB);
for (const ext of ['-wal', '-shm']) {
  if (fs.existsSync(SRC + ext)) fs.copyFileSync(SRC + ext, DB + ext);
}
process.env.DB_PATH = DB;
const db = require('/opt/bindarr-dev/backend/src/db');

const OLD = fs.readFileSync('/tmp/decklist.sql', 'utf8');
const NEW = fs.readFileSync('/tmp/newdecklist.sql', 'utf8');

function diff(a, b) {
  const out = [];
  if (a.length !== b.length) out.push(`ROW COUNT ${a.length} vs ${b.length}`);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    for (const k of new Set([...Object.keys(a[i]), ...Object.keys(b[i])])) {
      const x = a[i][k], y = b[i][k];
      // Money is floating point; compare to the cent.
      const num = typeof x === 'number' && typeof y === 'number';
      const same = num ? Math.abs(x - y) < 0.005 : String(x) === String(y);
      if (!same) out.push(`deck ${a[i].name} field ${k}: OLD=${JSON.stringify(x)} NEW=${JSON.stringify(y)}`);
    }
  }
  return out;
}

async function timeIt(sql, params, n = 5) {
  await db.all(sql, params);
  const runs = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    await db.all(sql, params);
    runs.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)];
}

(async () => {
  const uid = (await db.get(`SELECT user_id FROM collection LIMIT 1`)).user_id;

  for (const target of [null, 10000]) {
    if (target) {
      let have = (await db.get(`SELECT COUNT(*) c FROM collection WHERE user_id=?`, [uid])).c;
      while (have < target) {
        await db.run(`INSERT INTO collection (user_id, card_id, quantity, finish, list_type, condition)
                      SELECT user_id, card_id, 1, finish, list_type, condition
                        FROM collection WHERE user_id = ? LIMIT ?`,
                     [uid, Math.min(target - have, 5000)]);
        have = (await db.get(`SELECT COUNT(*) c FROM collection WHERE user_id=?`, [uid])).c;
      }
    }
    const rows = (await db.get(`SELECT COUNT(*) c FROM collection WHERE user_id=?`, [uid])).c;

    const oldRows = await db.all(OLD, [uid]);
    const newRows = await db.all(NEW, [uid, uid]);
    const d = diff(oldRows, newRows);

    const oldMs = await timeIt(OLD, [uid]);
    const newMs = await timeIt(NEW, [uid, uid]);

    console.log(`\n=== collection rows: ${rows} ===`);
    console.log(`  OLD ${oldMs.toFixed(1)}ms   NEW ${newMs.toFixed(1)}ms   speedup ${(oldMs / newMs).toFixed(1)}x`);
    console.log(d.length ? `  *** ${d.length} DIFFERENCES ***` : '  IDENTICAL output');
    for (const line of d.slice(0, 12)) console.log('   ', line);
    if (rows >= 2000 && !target) {
      console.log('  sample:', JSON.stringify(oldRows.map(r =>
        ({ name: r.name, owned: r.owned_cards, total: r.total_cards, val: Math.round(r.deck_value) }))));
    }
  }
  process.exit(0);
})();
