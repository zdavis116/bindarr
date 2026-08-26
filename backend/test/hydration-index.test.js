// THE FAST PATH MUST RESOLVE EXACTLY WHAT THE SLOW PATH DID.
//
// Scan hydration used `(set_id = ? OR LOWER(set_name) = LOWER(?)) AND number = ?`
// and `LOWER(name) = LOWER(?)`. Both are non-sargable -- wrapping an indexed
// column in a function discards the index -- so both did a full SCAN of ~105k
// rows, up to 16 times per scan.
//
// The fix tries an INDEXED equality first and falls back to the original query
// verbatim on a miss. That is only safe if the pair resolves identically to the
// original alone, for every candidate the scanner actually produces.
//
// This checks that against the real dev catalogue rather than assuming it.
'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3');

const DB = process.env.DB_PATH || '/tmp/devcat.db';

let passed = 0;
function pass(id, what) { console.log(`PASS: ${id} - ${what}`); passed++; }

// Read-only: this test must never be able to modify a catalogue.
const raw = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
const get = (sql, params = []) => new Promise((res, rej) =>
  raw.get(sql, params, (e, r) => (e ? rej(e) : res(r))));
const all = (sql, params = []) => new Promise((res, rej) =>
  raw.all(sql, params, (e, r) => (e ? rej(e) : res(r))));

// A spread of real candidates: mixed case, flavor-name cards, basics, and a
// set_name that differs from set_id.
const CANDS = [
  { set: 'msh', number: '128', name: "Evil's Thrall" },
  { set: 'sld', number: '2374', name: 'Ink-Eyes, Servant of Oni' },
  { set: 'lci', number: '176', name: 'Bedrock Tortoise' },
  { set: 'tmt', number: '230', name: 'Turtle-Duck' },
  { set: 'MSH', number: '295', name: 'Forest' },
  { set: 'cmm', number: '263', name: 'Sol Ring' },
  { set: 'zzz', number: '999', name: 'Lightning Bolt' },
  { set: 'pza', number: '18', name: 'Plains' },
];

async function slow(c) {
  let row = null;
  if (c.set && c.number) {
    row = await get(`SELECT * FROM card_cache WHERE (set_id = ? OR LOWER(set_name) = LOWER(?)) AND number = ? LIMIT 1`, [c.set, c.set, c.number]);
  }
  if (!row && c.name) {
    row = await get(`SELECT * FROM card_cache WHERE LOWER(name) = LOWER(?) LIMIT 1`, [c.name]);
  }
  return row || null;
}

async function fast(c) {
  let row = null;
  if (c.set && c.number) {
    row = await get(`SELECT * FROM card_cache WHERE set_id = ? AND number = ? LIMIT 1`, [c.set, c.number]);
    if (!row) {
      row = await get(`SELECT * FROM card_cache WHERE (set_id = ? OR LOWER(set_name) = LOWER(?)) AND number = ? LIMIT 1`, [c.set, c.set, c.number]);
    }
  }
  if (!row && c.name) {
    row = await get(`SELECT * FROM card_cache WHERE name = ? LIMIT 1`, [c.name]);
    if (!row) {
      row = await get(`SELECT * FROM card_cache WHERE LOWER(name) = LOWER(?) LIMIT 1`, [c.name]);
    }
  }
  return row || null;
}

(async () => {
// --- FHYD-TC1: identical resolution on every candidate ----------------------
{
  for (const c of CANDS) {
    const a = await slow(c), b = await fast(c);
    assert.strictEqual(a?.id ?? null, b?.id ?? null,
      `hydration differs for ${c.set} #${c.number} / ${c.name}: `
      + `slow=${a?.id ?? 'null'} fast=${b?.id ?? 'null'}`);
  }
  pass('FHYD-TC1', 'the indexed fast path resolves identically to the original query');
}

// --- FHYD-TC2: the indexes the fast path depends on must exist --------------
//
// Without them the "fast" path is the same full scan with extra steps, and the
// regression would be invisible -- correct answers, silently slow.
{
  const idx = (await all(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='card_cache'`)).map(r => r.name);
  assert.ok(idx.includes('idx_card_cache_set_num'),
    'idx_card_cache_set_num is required by the set+number fast path');
  assert.ok(idx.includes('idx_card_cache_name'),
    'idx_card_cache_name is required by the name fast path');
  pass('FHYD-TC2', 'both hydration indexes exist');
}

// --- FHYD-TC3: and they are actually USED (non-vacuous) ---------------------
{
  const p1 = (await all(`EXPLAIN QUERY PLAN SELECT * FROM card_cache WHERE set_id = ? AND number = ? LIMIT 1`, ['msh','128'])).map(r => r.detail).join(' ');
  assert.ok(/USING INDEX/.test(p1) && !/^SCAN/.test(p1),
    `set+number lookup must use an index, got: ${p1}`);

  const p2 = (await all(`EXPLAIN QUERY PLAN SELECT * FROM card_cache WHERE name = ? LIMIT 1`, ['Forest'])).map(r => r.detail).join(' ');
  assert.ok(/USING INDEX/.test(p2), `name lookup must use an index, got: ${p2}`);

  // And prove the ORIGINAL form really was a scan, so this test cannot pass
  // vacuously against a query that was already fine.
  const p3 = (await all(`EXPLAIN QUERY PLAN SELECT * FROM card_cache WHERE LOWER(name) = LOWER(?) LIMIT 1`, ['Forest'])).map(r => r.detail).join(' ');
  assert.ok(/SCAN/.test(p3),
    'the LOWER() form should still scan — if it does not, this fix is pointless');
  pass('FHYD-TC3', 'the fast path uses indexes and the old form genuinely scanned');
}



  console.log(`\nhydration-index.test.js: ${passed} cases passed`);
  raw.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
