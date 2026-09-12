// CARD KINGDOM PRICES.
//
// Zach: "would it be possible to now add tcgplayer and card kingdom in the same
// way as manapool."
//
// Card Kingdom yes, TCGplayer no. Their API has been closed to new developers
// since the eBay acquisition -- the docs say plainly they are not granting new
// access -- and the only redistribution I could find (MTGJSON) carries a single
// market number per finish with NO condition, NO stock and NO listing URL. That
// is the same kind of figure as the $34.37 that appeared nowhere on Mana Pool's
// own page. He chose to leave it out rather than mix a computed average in with
// real listings.
//
// Card Kingdom's feed is a genuine fit: public, no auth, keyed by scryfall_id,
// priced per condition with quantities and a real URL path.
//
//   GET https://api.cardkingdom.com/api/v2/pricelist
//   151,005 rows, ~67MB, meta.created_at and meta.base_url
//
//   { sku: '4ED-117', scryfall_id: 'a363bc91-...', name: 'Abomination',
//     url: 'mtg/4th-edition/abomination', is_foil: 'false',
//     price_retail: '0.35', qty_retail: 11,
//     condition_values: { nm_price: '0.35', nm_qty: 0, ex_price: '0.28',
//                         ex_qty: 9, vg_price: '0.25', g_price: '0.18' } }
const https = require('https');
const { StringDecoder } = require('string_decoder');
const zlib = require('zlib');
const db = require('./db');

const SOURCE = 'cardkingdom';
const HOST = 'api.cardkingdom.com';
const PATH = '/api/v2/pricelist';

// GRADE TRANSLATION, AND WHY IT IS NOT A LOOKUP TABLE.
//
// Card Kingdom grades NM / EX / VG / G. Zach's floor is Lightly Played:
// "Lowest condition I would go is lightly played."
//
// EX is the standard equivalent of LP -- both mean light shelf wear, no
// creasing. VG and G sit below it and are excluded, exactly as MP/HP/DMG are
// excluded from Mana Pool. Getting this wrong in the permissive direction would
// put a visibly worn card in his hands for a few cents' saving, which is the
// trade he has already refused.
//
// Ordered cheapest-first is NOT the rule: this is a FLOOR, and the cheapest of
// the acceptable grades wins, the same correction he forced on the Mana Pool
// rule. ("the LP is the cheapest but it doesn't show as the cheapest because
// there is 5.99 shipping.")
const ACCEPTED_GRADES = [
  { key: 'nm', label: 'NM' },
  { key: 'ex', label: 'LP' },   // Card Kingdom EX == Lightly Played
];

function cents(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

// Pick the cheapest acceptable grade for one row, or null if neither is stocked.
//
// A price with no quantity behind it is not a price he can act on: Card Kingdom
// lists a price for grades they are out of. Requiring qty > 0 is the difference
// between "this costs $0.35" and "this could be bought for $0.35".
function cheapestAcceptable(conditionValues) {
  let best = null;
  for (const grade of ACCEPTED_GRADES) {
    const price = cents((conditionValues || {})[`${grade.key}_price`]);
    const qty = Number((conditionValues || {})[`${grade.key}_qty`]) || 0;
    if (price === null || qty <= 0) continue;
    if (!best || price < best.price_cents) {
      best = { price_cents: price, condition: grade.label, qty };
    }
  }
  return best;
}

// Fold the feed into one row per printing, with the foil and nonfoil prices
// side by side.
//
// The feed carries a SEPARATE row per finish -- same scryfall_id, is_foil
// differing -- so a naive keyed insert would have the foil row overwrite the
// nonfoil one and every card would be priced as whichever appeared last.
function foldPricelist(rows, baseUrl) {
  const byCard = new Map();
  let skipped = 0;

  for (const r of rows) {
    const id = r.scryfall_id;
    if (!id) { skipped += 1; continue; }

    const best = cheapestAcceptable(r.condition_values);
    if (!best) { skipped += 1; continue; }

    const isFoil = String(r.is_foil) === 'true';
    const entry = byCard.get(id) || {
      card_id: id,
      price_cents: null, price_cents_foil: null, price_cents_etched: null,
      condition: null, condition_foil: null, condition_etched: null,
      available_quantity: 0,
      url: null,
    };

    if (isFoil) {
      if (entry.price_cents_foil === null || best.price_cents < entry.price_cents_foil) {
        entry.price_cents_foil = best.price_cents;
        entry.condition_foil = best.condition;
      }
    } else if (entry.price_cents === null || best.price_cents < entry.price_cents) {
      entry.price_cents = best.price_cents;
      entry.condition = best.condition;
    }

    entry.available_quantity = Math.max(entry.available_quantity, best.qty);

    // THE URL COMES FROM THE FEED, never built from a set code. A constructed
    // link 404s on anything they do not carry, and a dead buy button is worse
    // than no button -- the rule established with Mana Pool.
    if (!entry.url && r.url) {
      entry.url = String(r.url).startsWith('http')
        ? r.url
        : (baseUrl || 'https://www.cardkingdom.com/').replace(/\/$/, '') + '/' + String(r.url).replace(/^\//, '');
    }
    byCard.set(id, entry);
  }

  return { rows: [...byCard.values()], skipped };
}

function fetchPricelist() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, path: PATH, method: 'GET', timeout: 120000,
      headers: { 'User-Agent': 'Bindarr/1.0', 'Accept-Encoding': 'gzip' },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Card Kingdom pricelist returned HTTP ${res.statusCode}`));
        return;
      }
      // Streamed and decoded incrementally: the payload is ~67MB and buffering
      // it as one string before parsing is a needless spike on a 2-core box.
      const stream = /gzip/i.test(res.headers['content-encoding'] || '')
        ? res.pipe(zlib.createGunzip())
        : res;
      const decoder = new StringDecoder('utf8');
      let body = '';
      stream.on('data', (c) => { body += decoder.write(c); });
      stream.on('end', () => {
        body += decoder.end();
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`Card Kingdom pricelist was not JSON: ${err.message}`)); }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Card Kingdom pricelist timed out')); });
    req.end();
  });
}

async function refreshCardKingdomPrices() {
  const payload = await fetchPricelist();
  const raw = payload?.data || [];
  const baseUrl = payload?.meta?.base_url;
  const asOf = payload?.meta?.created_at || null;
  const { rows, skipped } = foldPricelist(raw, baseUrl);

  let written = 0;
  // Batched so the single operation queue in db.js is not held for the whole
  // import. Measured on Mana Pool: 500-row batches keep the worst concurrent
  // read to 54ms during a 535k-row import.
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = batch.map(() =>
      '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').join(', ');
    const params = [];
    for (const r of batch) {
      params.push(SOURCE, r.card_id, r.price_cents, r.price_cents_foil,
                  r.price_cents_etched, r.condition, r.condition_foil,
                  r.condition_etched, r.available_quantity, r.url);
    }
    await db.run(
      `INSERT INTO source_prices
         (source, card_id, price_cents, price_cents_foil, price_cents_etched,
          condition, condition_foil, condition_etched,
          available_quantity, url, updated_at)
       VALUES ${values}
       ON CONFLICT(source, card_id) DO UPDATE SET
         price_cents        = excluded.price_cents,
         price_cents_foil   = excluded.price_cents_foil,
         price_cents_etched = excluded.price_cents_etched,
         condition          = excluded.condition,
         condition_foil     = excluded.condition_foil,
         condition_etched   = excluded.condition_etched,
         available_quantity = excluded.available_quantity,
         url                = excluded.url,
         updated_at         = CURRENT_TIMESTAMP`,
      params
    );
    written += batch.length;
  }

  await db.run(
    `INSERT INTO source_price_meta (source, last_success_at, last_error, row_count)
     VALUES (?, CURRENT_TIMESTAMP, NULL, ?)
     ON CONFLICT(source) DO UPDATE
        SET last_success_at = CURRENT_TIMESTAMP, last_error = NULL, row_count = ?`,
    [SOURCE, written, written]);

  return { written, skipped, feedRows: raw.length, asOf };
}

// Same freshness check as Mana Pool: a restart is not a reason to re-import
// 67MB. Null means it has never succeeded, which callers treat as stale.
async function msSinceLastRefresh() {
  const row = await db.get(
    `SELECT last_success_at FROM source_price_meta WHERE source = ?`, [SOURCE]);
  if (!row?.last_success_at) return null;
  const t = Date.parse(String(row.last_success_at).replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? Date.now() - t : null;
}

module.exports = {
  refreshCardKingdomPrices,
  msSinceLastRefresh,
  foldPricelist,
  cheapestAcceptable,
  ACCEPTED_GRADES,
  SOURCE,
};
