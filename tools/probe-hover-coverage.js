// How many cards on THEIR side of a comparison are missing from card_cache?
//
// This decides whether a hover card can be served from the local catalogue or
// needs a Scryfall fetch. Guessing would mean shipping a hover that is blank
// for exactly the cards Zach is most interested in -- the ones he does not own.
const sqlite3 = require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const db = new sqlite3.Database('/var/lib/bindarr-dev/bindarr.db',
  sqlite3.OPEN_READONLY);
const all = (sql, p = []) => new Promise((res, rej) =>
  db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

(async () => {
  const mp = await import('/opt/bindarr-dev/backend/src/services/manapoolDecks.js');
  const r = await mp.searchDecks(process.argv[2] || 'Atraxa, Praetors\' Voice', {});
  console.log('decks found:', r.decks.length);
  let missingTotal = 0; let cardsTotal = 0;
  for (const d of r.decks.slice(0, 3)) {
    const deck = await mp.fetchDeckCards(d.id);
    const ids = deck.cards.map((c) => c.oracleId).filter(Boolean);
    const uniq = [...new Set(ids)];
    const rows = await all(
      `SELECT DISTINCT oracle_id FROM card_cache WHERE oracle_id IN (${uniq.map(() => '?').join(',')})`,
      uniq);
    const have = new Set(rows.map((x) => x.oracle_id));
    const missing = uniq.filter((o) => !have.has(o));
    cardsTotal += uniq.length; missingTotal += missing.length;
    console.log(`  ${(deck.name || d.id).slice(0, 50)}: ${uniq.length} cards, ${missing.length} NOT in card_cache`);
    if (missing.length) {
      const names = deck.cards.filter((c) => missing.includes(c.oracleId))
        .map((c) => c.name).slice(0, 5);
      console.log('    e.g.', names.join(', '));
    }
  }
  console.log(`\nTOTAL: ${missingTotal} of ${cardsTotal} not in the local catalogue`);
  db.close();
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
