// Extract REAL product data for the mockup, so Zach reviews actual card names,
// counts and foil flags rather than invented placeholders. A mockup built on
// made-up data hides exactly the problems a review is meant to catch -- the
// edition confusion in particular only shows up with real Secret Lair names.
const g = async (u) => {
  const r = await fetch(u, { headers: { 'User-Agent': 'Bindarr/1.0' } });
  if (!r.ok) throw new Error(`${u} -> ${r.status}`);
  return r.json();
};

const section = (c) => {
  const line = (c.type || '').split('—')[0];
  for (const t of ['Land', 'Creature', 'Planeswalker', 'Battle', 'Instant',
    'Sorcery', 'Enchantment', 'Artifact']) {
    if (line.includes(t)) return t;
  }
  return 'Other';
};

(async () => {
  const list = (await g('https://mtgjson.com/api/v5/DeckList.json')).data;

  // The picker's search results: a realistic mix.
  const cmd = list.filter((d) => d.type === 'Commander Deck').slice(-6);
  const sld = list.filter((d) => d.type === 'Secret Lair Drop');

  // The edition-confusion case, which is the whole point of the review.
  const twins = [];
  const byBase = new Map();
  for (const d of sld) {
    const base = d.name.replace(
      /\s*(Traditional Foil|Raised Foil|Galaxy Foil|Rainbow Foil|Textured Foil|Foil|Non-?foil)\s*(Edition)?\s*$/i, '').trim();
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(d);
  }
  for (const [base, ds] of byBase) {
    if (ds.length > 1) twins.push({ base, editions: ds.map((d) => d.name) });
  }

  const deckOf = async (d) => {
    const deck = (await g(`https://mtgjson.com/api/v5/decks/${d.fileName}.json`)).data;
    const rows = [...(deck.commander || []), ...(deck.mainBoard || [])];
    return {
      name: deck.name,
      code: d.code,
      total: rows.reduce((n, c) => n + c.count, 0),
      cards: rows.map((c) => ({
        name: c.name,
        count: c.count,
        section: section(c),
        foil: !!c.isFoil,
        etched: !!c.isEtched,
        set: c.setCode,
        number: c.number,
      })),
    };
  };

  const precon = await deckOf(list.filter((d) => d.type === 'Commander Deck').slice(-1)[0]);

  const out = {
    preconResults: cmd.map((d) => ({ name: d.name, code: d.code, type: d.type })),
    sldTwinCount: twins.length,
    sldTotal: sld.length,
    twinExamples: twins.slice(0, 4),
    precon,
  };
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
