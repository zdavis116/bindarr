// Do MTGJSON's deck card scryfallIds actually exist in Bindarr's card_cache?
//
// THIS IS THE DECIDING QUESTION for the whole feature. Import may only ADD
// collection rows pointing at card_cache entries that ALREADY EXIST -- it must
// never INSERT into card_cache, because that cache is the shared catalogue
// every price, legality and buylist trusts, and a row written from a third
// party's product list becomes a permanent fake card.
//
// So: if a precon's cards are missing from card_cache, those cards CANNOT be
// added, and the feature has to say so rather than silently drop them.
const sqlite3 = require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const db = new sqlite3.Database('/var/lib/bindarr-dev/bindarr.db',
  sqlite3.OPEN_READONLY);
const all = (sql, p = []) => new Promise((res, rej) =>
  db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

const get = async (u) => {
  const r = await fetch(u, { headers: { 'User-Agent': 'Bindarr/1.0' } });
  if (!r.ok) throw new Error(`${u} -> ${r.status}`);
  return r.json();
};

(async () => {
  const list = (await get('https://mtgjson.com/api/v5/DeckList.json')).data;

  // A spread: recent precons, older precons, and Secret Lair drops.
  const picks = [
    ...list.filter((d) => d.type === 'Commander Deck').slice(-4),
    ...list.filter((d) => d.type === 'Commander Deck').slice(0, 2),
    ...list.filter((d) => d.type === 'Secret Lair Drop').slice(-4),
  ];

  let grandTotal = 0; let grandMissing = 0;
  for (const p of picks) {
    let deck;
    try {
      deck = (await get(`https://mtgjson.com/api/v5/decks/${p.fileName}.json`)).data;
    } catch (e) { console.log(`  ${p.name}: FETCH FAILED ${e.message}`); continue; }

    const rows = [...(deck.commander || []), ...(deck.mainBoard || []),
      ...(deck.sideBoard || [])];
    const ids = [...new Set(rows.map((c) => c.identifiers?.scryfallId).filter(Boolean))];
    const noId = rows.filter((c) => !c.identifiers?.scryfallId).length;
    if (ids.length === 0) { console.log(`  ${p.name}: no scryfall ids at all`); continue; }

    // EXACT PRINTING match: card_cache.id IS the scryfall printing id.
    const found = await all(
      `SELECT id FROM card_cache WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    const have = new Set(found.map((r) => r.id));
    const missing = ids.filter((i) => !have.has(i));

    // Fall back to ORACLE id: a different printing of the same card is still a
    // real card, so the miss is a PRINTING gap rather than an unknown card.
    let oracleRescued = 0;
    if (missing.length) {
      const oids = [...new Set(rows
        .filter((c) => missing.includes(c.identifiers?.scryfallId))
        .map((c) => c.identifiers?.scryfallOracleId).filter(Boolean))];
      if (oids.length) {
        const orows = await all(
          `SELECT DISTINCT oracle_id FROM card_cache WHERE oracle_id IN (${oids.map(() => '?').join(',')})`,
          oids);
        oracleRescued = orows.length;
      }
    }

    grandTotal += ids.length; grandMissing += missing.length;
    console.log(`  ${(p.type === 'Secret Lair Drop' ? 'SLD' : 'CMD')} ${p.name.slice(0, 38).padEnd(38)} `
      + `${String(ids.length).padStart(4)} printings, ${String(missing.length).padStart(4)} missing exact, `
      + `${oracleRescued} of those known by oracle id${noId ? `, ${noId} rows with NO id` : ''}`);
  }
  console.log(`\nTOTAL: ${grandMissing} of ${grandTotal} exact printings missing `
    + `(${(100 * grandMissing / grandTotal).toFixed(1)}%)`);
  db.close();
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
