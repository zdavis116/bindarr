// The inserts are 12ms. So where do the 30-60 seconds actually go?
//
// Time the REAL addCardToCollection path end to end, and the pieces inside it,
// against a scratch copy of the database. Optimising the INSERT would have
// saved 9ms of a 40-second wait -- exactly the "premature optimisation of the
// thing I assumed" failure.
const fs = require('node:fs');
const path = '/tmp/perf2.db';
fs.copyFileSync('/var/lib/bindarr-dev/bindarr.db', path);
process.env.DB_PATH = path;

const sqlite3 = require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const raw = new sqlite3.Database(path);
const all = (sql, p = []) => new Promise((r, j) => raw.all(sql, p, (e, x) => (e ? j(e) : r(x))));

(async () => {
  // How expensive is the placement resolution that runs per card?
  const t0 = Date.now();
  const cards = await all('SELECT id FROM card_cache LIMIT 72');
  console.log('read 72 card ids:', Date.now() - t0, 'ms');

  // The query resolveCompartmentAndPosition does per card, approximated: it
  // scans compartments and existing positions for a free slot.
  const t1 = Date.now();
  for (const c of cards) {
    await all(`SELECT c.id, c.capacity, COUNT(col.id) used
                 FROM compartments c
                 LEFT JOIN collection col ON col.compartment_id = c.id
                GROUP BY c.id`);
  }
  console.log('72x compartment scan:', Date.now() - t1, 'ms');

  // The card_cache lookup addCardToCollection does per card.
  const t2 = Date.now();
  for (const c of cards) {
    await all('SELECT * FROM card_cache WHERE id = ?', [c.id]);
  }
  console.log('72x card_cache lookup:', Date.now() - t2, 'ms');

  // Is there an index on the columns the placement query filters?
  const idx = await all("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('collection','compartments')");
  console.log('\nindexes:');
  for (const i of idx) console.log('  ', i.name, '|', (i.sql || '').replace(/\s+/g, ' ').slice(0, 90));

  const cnt = await all('SELECT COUNT(*) n FROM compartments');
  console.log('\ncompartments:', JSON.stringify(cnt[0]));
  raw.close();
  fs.unlinkSync(path);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
