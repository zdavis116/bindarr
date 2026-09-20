// Does the compare route's new image lookup actually produce an image for
// EVERY card on both sides, on real data?
//
// A unit test cannot answer this: the query is SQL against the real catalogue,
// and the failure mode is a hover that silently shows nothing. This exercises
// the same SQL the route runs, against a live Mana Pool deck.
const sqlite3 = require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const db = new sqlite3.Database('/var/lib/bindarr-dev/bindarr.db',
  sqlite3.OPEN_READONLY);
const all = (sql, p = []) => new Promise((res, rej) =>
  db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

(async () => {
  const mp = await import('/opt/bindarr-dev/backend/src/services/manapoolDecks.js');
  const r = await mp.searchDecks(process.argv[2] || 'Atraxa, Praetors\' Voice', {});
  let worst = null;
  for (const d of r.decks.slice(0, 3)) {
    const deck = await mp.fetchDeckCards(d.id);
    const ids = [...new Set(deck.cards.map((c) => c.oracleId).filter(Boolean))];

    // EXACTLY the query the route runs.
    const rows = await all(
      `SELECT oracle_id, MAX(image_url) AS image_url
         FROM card_cache
        WHERE oracle_id IN (${ids.map(() => '?').join(',')})
          AND image_url IS NOT NULL AND image_url <> ''
        GROUP BY oracle_id`, ids);

    const got = new Map(rows.map((x) => [x.oracle_id, x.image_url]));
    const missing = ids.filter((o) => !got.has(o));
    const bad = [...got.values()].filter((u) => !/^https?:\/\//.test(u));
    console.log(`${(deck.name || d.id).slice(0, 46)}: ${ids.length} cards, `
      + `${got.size} with image, ${missing.length} missing, ${bad.length} malformed URLs`);
    if (missing.length) {
      const names = deck.cards.filter((c) => missing.includes(c.oracleId))
        .map((c) => c.name).slice(0, 6);
      console.log('   MISSING:', names.join(', '));
      worst = worst || names;
    }
  }
  // One sample URL, to confirm it is a real image and not a page link.
  const [sample] = await all(
    "SELECT image_url FROM card_cache WHERE image_url IS NOT NULL LIMIT 1");
  console.log('\nsample URL:', sample.image_url);
  console.log(worst ? 'RESULT: some cards would show a blank preview'
    : 'RESULT: every card on both sides resolves to an image');
  db.close();
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
