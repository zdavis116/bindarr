// Does card_cache actually carry the fields a hover card would show?
// Guessing a column name here is how three earlier bugs on this feature
// happened -- read the real database instead.
//
// The driver is sqlite3 (callback-based), NOT better-sqlite3.
const sqlite3 = require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const db = new sqlite3.Database('/var/lib/bindarr-dev/bindarr.db',
  sqlite3.OPEN_READONLY);

const all = (sql) => new Promise((res, rej) =>
  db.all(sql, (e, r) => (e ? rej(e) : res(r))));

(async () => {
  const info = await all('PRAGMA table_info(card_cache)');
  const cols = info.map((c) => c.name);
  console.log('card_cache columns:\n  ' + cols.join(', '));

  const want = ['image_url', 'type_line', 'mana_cost', 'cmc', 'oracle_text',
    'rarity', 'set_name', 'back_image_url', 'power', 'toughness', 'color_identity'];
  console.log('\nfields a hover card might want:');
  for (const w of want) {
    console.log(`  ${w}: ${cols.includes(w) ? 'EXISTS' : 'MISSING'}`);
  }

  // Coverage per ORACLE id, not per printing: card_cache holds ~3 rows per
  // card, so a LIMIT 1 spot-check says nothing (a known trap on this project).
  const present = want.filter((w) => cols.includes(w));
  const sel = present.map((c) => `MAX(${c}) AS ${c}`).join(', ');
  const rows = await all(
    `SELECT oracle_id, ${sel} FROM card_cache GROUP BY oracle_id`);
  console.log(`\ndistinct oracle ids: ${rows.length}`);
  for (const c of present) {
    const n = rows.filter((r) => r[c] !== null && r[c] !== '').length;
    console.log(`  ${c}: ${n} (${(100 * n / rows.length).toFixed(1)}%)`);
  }
  db.close();
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
