// Is MTGJSON's product data faithful enough to ADD TO A COLLECTION unattended?
//
// Zach's collection treats a foil and a nonfoil as two different physical
// objects, and quantity is the whole point (30 Swamps is 30 cards, not one
// row). If either is wrong, the import silently records a collection he does
// not own -- worse than the scanning it replaces, because he would not notice.
//
// Checks, on real products:
//   - do quantities add up to a sensible product size (a Commander deck is 100)?
//   - is isFoil present and does a "Foil Edition" Secret Lair actually say so?
//   - does every row carry an exact scryfall printing id?
const get = async (u) => {
  const r = await fetch(u, { headers: { 'User-Agent': 'Bindarr/1.0' } });
  if (!r.ok) throw new Error(`${u} -> ${r.status}`);
  return r.json();
};

(async () => {
  const list = (await get('https://mtgjson.com/api/v5/DeckList.json')).data;
  const cmd = list.filter((d) => d.type === 'Commander Deck');
  const sld = list.filter((d) => d.type === 'Secret Lair Drop');

  const rowsOf = (d) => [...(d.commander || []), ...(d.mainBoard || []),
    ...(d.sideBoard || [])];

  console.log('=== COMMANDER DECKS: does the card count come to 100? ===');
  for (const p of cmd.slice(-6)) {
    const d = (await get(`https://mtgjson.com/api/v5/decks/${p.fileName}.json`)).data;
    const rows = rowsOf(d);
    const total = rows.reduce((n, c) => n + (c.count || 0), 0);
    const noId = rows.filter((c) => !c.identifiers?.scryfallId).length;
    const foils = rows.filter((c) => c.isFoil).length;
    const flag = total === 100 ? 'OK ' : '!! ';
    console.log(`  ${flag}${String(total).padStart(3)} cards  ${String(rows.length).padStart(3)} rows  `
      + `${foils} foil rows  ${noId} missing id   ${p.name.slice(0, 40)}`);
  }

  console.log('\n=== SECRET LAIR: does a "Foil Edition" actually carry isFoil? ===');
  const foilNamed = sld.filter((d) => /foil/i.test(d.name)).slice(-4);
  const plain = sld.filter((d) => !/foil/i.test(d.name)).slice(-3);
  for (const p of [...foilNamed, ...plain]) {
    const d = (await get(`https://mtgjson.com/api/v5/decks/${p.fileName}.json`)).data;
    const rows = rowsOf(d);
    const foil = rows.filter((c) => c.isFoil).length;
    const etched = rows.filter((c) => c.isEtched).length;
    const nameSaysFoil = /foil/i.test(p.name);
    const consistent = nameSaysFoil ? (foil + etched) === rows.length : true;
    console.log(`  ${consistent ? 'OK ' : '!! '}${String(rows.length).padStart(3)} rows  `
      + `foil=${foil} etched=${etched}  ${p.name.slice(0, 44)}`);
  }

  console.log('\n=== finishes field, to cross-check isFoil ===');
  const d = (await get(`https://mtgjson.com/api/v5/decks/${foilNamed[0].fileName}.json`)).data;
  for (const c of rowsOf(d).slice(0, 4)) {
    console.log(`  ${c.name.slice(0, 30).padEnd(30)} isFoil=${c.isFoil} `
      + `isEtched=${c.isEtched} finishes=${JSON.stringify(c.finishes)} count=${c.count}`);
  }
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
