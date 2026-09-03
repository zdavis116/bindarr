// The one place that knows card_cache's column list.
//
// Normalized Scryfall cards are written through this single batched upsert.
const db = require('../db');

const COLUMNS = [
  'id', 'name', 'supertype', 'subtypes', 'types', 'rarity', 'set_id', 'set_name',
  'number', 'image_url', 'price_trend', 'price_normal', 'price_holofoil',
  'price_reverse_holofoil', 'price_avg1', 'price_avg7', 'price_avg30', 'cmc',
  'color_identity',
  // THE NAME PRINTED IN LARGE TYPE ON A CROSSOVER CARD.
  //
  // Zach scanned a card reading 'SPLINTER, VENGEFUL SENSEI' and Bindarr called
  // it 'Ink-Eyes, Servant of Oni'. Both are correct: it is one Secret Lair card
  // with a flavor name on top and the real card name in small type beneath.
  //
  // 648 cards across Magic have one (TMNT, Marvel, Doctor Who, Fallout). For
  // those, `name` is a name the owner CANNOT SEE on the card in their hand --
  // so a collection of them is unrecognisable and unsearchable. Zach: "if I
  // want the splinter card I would search that card not ink-eyes."
  //
  // Stored alongside `name` rather than replacing it: `name` remains the
  // catalogue identity everything else keys on, and this is purely what to show
  // and what to match against.
  'flavor_name',
  // DOUBLE-FACED CARDS, display only. `name` stays the front face -- it is
  // the identity the import matches on. These carry what a card's back
  // side is, which had nowhere to live, so the flip side was unviewable.
  'display_name',
  'back_image_url',
  'back_name',
  'back_type_line',
  'oracle_id', 'oracle_name', 'mana_cost', 'oracle_text', 'type_line', 'keywords',
  'legalities', 'finishes', 'layout',
  'tcgplayer_url', 'cardmarket_url',
];

// A page of results can be 250 cards and one round trip per card cost more than
// the provider fetch did, so rows go in batched — chunked small enough that the
// bound-parameter count stays well inside SQLite's limit.
const CHUNK = 50;

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

async function cacheNormalizedCards(cards, opts = {}) {
  const stamp = opts.incomplete ? `'1970-01-01 00:00:00'` : 'CURRENT_TIMESTAMP';
  const rowSql = `(${COLUMNS.map(() => '?').join(', ')}, ${stamp})`;
  const rows = (cards || []).filter(c => c && c.id);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const params = [];
    for (const c of chunk) {
      params.push(
        c.id, c.name || '', c.supertype || '',
        JSON.stringify(c.subtypes || []), JSON.stringify(c.types || []),
        c.rarity || 'Common', c.set_id || '', c.set_name || '', c.number || '',
        c.image_url || '', num(c.price_trend), num(c.price_normal),
        num(c.price_holofoil), num(c.price_reverse_holofoil), num(c.price_avg1),
        num(c.price_avg7), num(c.price_avg30), num(c.cmc),
        JSON.stringify(c.color_identity || []),
        // MUST STAY IN LOCK-STEP WITH `COLUMNS` ABOVE. This list is positional:
        // adding a column there without adding its value here shifts every
        // field after it, silently writing each value into the WRONG column.
        // That is exactly what happened when flavor_name was added -- the
        // oracle-card-cache suite failed with "normal is not valid JSON",
        // because a price string had landed where `finishes` was expected.
        c.flavor_name || null,
        // SAME ORDER as COLUMNS: display_name, back_image_url, back_name,
        // back_type_line sit immediately after flavor_name.
        c.display_name || null,
        c.back_image_url || null,
        c.back_name || null,
        c.back_type_line || null,
        c.oracle_id || null, c.oracle_name || '', c.mana_cost || '',
        c.oracle_text || '', c.type_line || '', JSON.stringify(c.keywords || []),
        JSON.stringify(c.legalities || {}), JSON.stringify(c.finishes || []),
        c.layout || '',
        c.tcgplayer_url || null, c.cardmarket_url || null,
      );
    }
    await db.run(
      `INSERT OR REPLACE INTO card_cache (${COLUMNS.join(', ')}, last_updated)
       VALUES ${chunk.map(() => rowSql).join(', ')}`,
      params
    );
  }
}

module.exports = { cacheNormalizedCards, CARD_CACHE_COLUMNS: COLUMNS };
