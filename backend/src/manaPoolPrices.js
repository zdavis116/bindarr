// MANA POOL PRICES, FROM THE PER-CONDITION VARIANTS FEED.
//
// Zach: "I only care about LP or NM and English language for exact printing."
//
// WHY THIS REPLACED /prices/singles. That endpoint returns one summary row per
// printing, and its numbers DO NOT APPEAR ON MANA POOL'S OWN PAGE. Measured on
// The Ur-Dragon PF25 #15 foil:
//
//   /prices/singles   $34.37   <- appears nowhere on their page
//   their page        $32.99, $33.73, $34.27, $34.29, $34.98, $35.69, $35.99
//   /prices/variants  $32.99 LP (5 in stock), $33.73 NM (21 in stock)
//
// Zach caught it: "it says the value is 34.37 but I don't see any value like
// that in mana pool". He was right. I had trusted the field name and the docs
// instead of checking a number against the page it links to. A price Bindarr
// states that the marketplace contradicts is worse than no price -- he finds out
// at the point of buying.
//
// THE RULE, his words: lowest condition is Lightly Played. Use LP when it
// exists, otherwise NM, and never anything below. MP/HP/DMG are real rows in
// this feed (132k/46k/23k of them) and are deliberately ignored -- a Damaged
// card is not a substitute for the one he is pricing.
//
// ENGLISH ONLY. 56,768 keys in this feed differ ONLY by language:
//   7ED #275 NF MP  Czech   $0.20    1 in stock
//   7ED #275 NF MP  English $0.15  141 in stock
// Taking the global minimum would quietly price his collection in Czech.
const https = require('https');
const zlib = require('zlib');
const db = require('./db');

const SOURCE = 'manapool';
const HOST = 'manapool.com';
const PATH = '/api/v1/prices/variants';

// Conditions Zach will accept. A QUALITY FLOOR, not a preference order.
//
// He said: "Lowest condition I would go is lightly played, so if there is value
// for lightly played that is what I would like to use if not use near mint."
//
// I FIRST BUILT THAT AS "PREFER LP, FALL BACK TO NM" AND IT WAS WRONG. On his
// own Ur-Dragon the real listings are:
//
//   Foil MP  $29.73     <- below his floor, ignored
//   Foil NM  $33.73     <- CHEAPEST acceptable copy
//   Foil LP  $34.29
//   Foil LP  $34.98
//
// "Prefer LP" picks $34.29 -- more money for a worse card. He was setting a
// minimum acceptable condition, not asking to be sold played copies. So the
// rule is: among LP and NM, take the CHEAPEST. Nothing below LP is ever
// considered, which is the part that actually mattered to him.
const ACCEPTED_CONDITIONS = ['LP', 'NM'];
const LANGUAGE = 'EN';

// finish_id in the feed -> the column it prices.
const FINISH_COLUMN = { NF: 'nonfoil', FO: 'foil', EF: 'etched' };

// 7 columns x 250 rows = 1,750 bound parameters, inside SQLite's 32,766 limit.
const INSERT_CHUNK = 250;

// Idle between batches so a background import cannot starve a foreground read.
// db.js chains every query onto ONE global queue; back-to-back writes are
// exactly how the catalogue refresh made the dashboard take 26 seconds.
const BATCH_PAUSE_MS = 25;

// The variants feed is ~201MB uncompressed (535,677 rows) against the singles
// feed's 51MB. A cap well above that turns a runaway response into a clear
// error instead of an out-of-memory kill.
const MAX_BYTES = 600 * 1024 * 1024;

function fetchVariants() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, path: PATH, method: 'GET',
      headers: {
        'User-Agent': 'Bindarr/1.0 (self-hosted collection manager)',
        'Accept-Encoding': 'gzip',
      },
      timeout: 300000,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Mana Pool returned HTTP ${res.statusCode}`));
      }
      const stream = /gzip/i.test(res.headers['content-encoding'] || '')
        ? res.pipe(zlib.createGunzip())
        : res;
      const chunks = [];
      let bytes = 0;
      stream.on('data', (c) => {
        bytes += c.length;
        if (bytes > MAX_BYTES) {
          req.destroy();
          return reject(new Error('Mana Pool response exceeded 600MB; refusing it'));
        }
        chunks.push(c);
      });
      stream.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error(`Mana Pool sent unparseable JSON: ${e.message}`));
        }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Mana Pool request timed out')); });
    req.end();
  });
}

// Fold 535k condition-level rows down to one row per printing.
//
// For each (printing, finish) keep the best ACCEPTED condition: LP if it has a
// price, else NM. Exported for tests -- this is the whole rule.
function foldVariants(rows) {
  const byCard = new Map();

  for (const r of rows) {
    if (!r || r.language_id !== LANGUAGE) continue;
    const cardId = r.scryfall_id;
    if (!cardId) continue;

    const finish = FINISH_COLUMN[r.finish_id];
    if (!finish) continue;

    const rank = ACCEPTED_CONDITIONS.indexOf(r.condition_id);
    if (rank < 0) continue;                       // MP / HP / DMG: below the floor

    const price = Number(r.low_price);
    if (!Number.isFinite(price) || price <= 0) continue;

    let entry = byCard.get(cardId);
    if (!entry) {
      entry = { card_id: cardId, url: r.url || null, finishes: {} };
      byCard.set(cardId, entry);
    }
    if (!entry.url && r.url) entry.url = r.url;

    const cur = entry.finishes[finish];
    // CHEAPEST ACCEPTABLE COPY WINS.
    //
    // Both LP and NM are above his floor, so between them the only thing that
    // matters is price. Preferring LP by rank would pay $34.29 for a played
    // copy when a Near Mint one is listed at $33.73 -- which is what the first
    // version of this did, and what he caught.
    if (!cur || Math.round(price) < cur.price_cents) {
      entry.finishes[finish] = {
        price_cents: Math.round(price),
        condition: r.condition_id,
        qty: Number.isFinite(r.available_quantity) ? r.available_quantity : null,
      };
    }
  }

  const out = [];
  for (const e of byCard.values()) {
    const nf = e.finishes.nonfoil, fo = e.finishes.foil, ef = e.finishes.etched;
    if (!nf && !fo && !ef) continue;
    out.push({
      card_id: e.card_id,
      price_cents: nf ? nf.price_cents : null,
      price_cents_foil: fo ? fo.price_cents : null,
      price_cents_etched: ef ? ef.price_cents : null,
      condition: nf ? nf.condition : null,
      condition_foil: fo ? fo.condition : null,
      condition_etched: ef ? ef.condition : null,
      // Stock for whichever finish priced; a price with nothing behind it is a
      // quote rather than an offer.
      available_quantity: (nf || fo || ef).qty,
      url: e.url,
    });
  }
  return out;
}

async function refreshManaPoolPrices({ onProgress } = {}) {
  await db.run(
    `INSERT INTO source_price_meta (source, last_attempt_at)
     VALUES (?, CURRENT_TIMESTAMP)
     ON CONFLICT(source) DO UPDATE SET last_attempt_at = CURRENT_TIMESTAMP`,
    [SOURCE]
  );

  let payload;
  try {
    payload = await fetchVariants();
  } catch (err) {
    // RECORD THE FAILURE so Settings can say WHY a price is stale rather than
    // just showing an old number.
    await db.run(`UPDATE source_price_meta SET last_error = ? WHERE source = ?`,
                 [err.message, SOURCE]);
    throw err;
  }

  const raw = Array.isArray(payload?.data) ? payload.data : [];
  if (raw.length === 0) {
    const msg = 'Mana Pool returned no rows; keeping the previous prices';
    await db.run(`UPDATE source_price_meta SET last_error = ? WHERE source = ?`, [msg, SOURCE]);
    throw new Error(msg);
  }

  const priced = foldVariants(raw);

  // UPSERT IN PLACE, never delete-then-insert: emptying the table first would
  // leave every screen unpriced for the duration of the import, and a crash
  // mid-run would leave it that way permanently.
  let written = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
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
    batch = [];
    await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
    if (onProgress && written % 20000 < INSERT_CHUNK) onProgress(written, priced.length);
  };

  for (const r of priced) {
    batch.push(r);
    if (batch.length >= INSERT_CHUNK) await flush();
  }
  await flush();

  await db.run(
    `UPDATE source_price_meta
        SET last_success_at = CURRENT_TIMESTAMP, last_error = NULL, row_count = ?
      WHERE source = ?`,
    [written, SOURCE]
  );

  return { written, skipped: raw.length - priced.length,
           variantRows: raw.length, asOf: payload?.meta?.as_of || null };
}

// HOW LONG AGO DID THE PRICES LAST LAND?
//
// Zach: "where is there a delay in loading total and showing which printing is
// the cheapest... I went into the export and it just showed only what the deck
// wanted and then about a minute later it updated."
//
// The cause was a 201MB import running while he read the screen. Every restart
// armed an 8-minute timer, so four deploys in an hour meant four full imports --
// and an import holds the single database queue, so his reads waited behind it.
// This is the same pile-up that made the dashboard take 26 seconds, in a new
// place.
//
// Returns null when the source has never succeeded, which callers must treat as
// "stale" rather than "fresh".
async function msSinceLastRefresh() {
  const row = await db.get(
    `SELECT last_success_at FROM source_price_meta WHERE source = ?`, [SOURCE]);
  if (!row?.last_success_at) return null;
  const t = Date.parse(String(row.last_success_at).replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? Date.now() - t : null;
}

module.exports = {
  refreshManaPoolPrices,
  msSinceLastRefresh,
  foldVariants,
  ACCEPTED_CONDITIONS,
  LANGUAGE,
  SOURCE,
};
