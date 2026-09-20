// What can Bindarr actually retrieve for "add a whole product to my collection"?
//
// Three sources Zach named, and they are three different problems:
//   1. precons        -- a named deck product (Commander decks)
//   2. Secret Lair    -- a small numbered drop
//   3. Mana Pool orders -- what HE bought, behind his account
//
// Guessing which of these has a real list is how this feature would ship half
// broken. Probe before designing.
const UA = { 'User-Agent': 'Bindarr/1.0', Accept: 'application/json' };
const get = async (url) => {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return { status: r.status, body: null };
  return { status: r.status, body: await r.json() };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const sets = (await get('https://api.scryfall.com/sets')).body.data;
  const types = {};
  for (const s of sets) types[s.set_type] = (types[s.set_type] || 0) + 1;
  console.log('=== set_type counts ===');
  console.log(Object.entries(types).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`).join(', '));

  // 1. PRECONS. Are Commander decks individually addressable, or is a whole
  //    set one undifferentiated bag of cards?
  const cmd = sets.filter((s) => s.set_type === 'commander');
  console.log(`\n=== commander sets: ${cmd.length} ===`);
  for (const s of cmd.slice(0, 6)) {
    console.log(`  ${s.code}  ${s.card_count.toString().padStart(4)} cards  ${s.name}`);
  }

  // A Commander set holds SEVERAL decks. Does Scryfall say which deck a card
  // belongs to? That is the whole question for precons.
  await sleep(120);
  const sample = cmd.find((s) => s.card_count > 100 && s.card_count < 800);
  console.log(`\n=== probing ${sample.code} (${sample.name}) for deck grouping ===`);
  const cards = await get(
    `https://api.scryfall.com/cards/search?q=set%3A${sample.code}&unique=prints&order=set`);
  if (cards.body?.data?.length) {
    const c = cards.body.data[0];
    const interesting = ['name', 'collector_number', 'rarity', 'set_name',
      'promo_types', 'frame_effects', 'booster', 'digital'];
    console.log('  first card fields:',
      JSON.stringify(Object.fromEntries(
        interesting.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]))));
    const keys = Object.keys(c).filter((k) => /deck|product|preconstructed/i.test(k));
    console.log('  any deck/product field on a card?', keys.length ? keys : 'NO');
  }

  // 2. SECRET LAIR. Small, numbered, and the whole drop is the product.
  const sld = sets.filter((s) => /secret lair/i.test(s.name));
  console.log(`\n=== secret lair sets: ${sld.length} ===`);
  for (const s of sld.slice(0, 5)) {
    console.log(`  ${s.code}  ${s.card_count.toString().padStart(5)} cards  ${s.set_type}  ${s.name}`);
  }
  console.log('  NOTE: one SLD "set" holds every drop ever, so the SET is not the product.');
})().catch((e) => console.log('ERR', e.message));
