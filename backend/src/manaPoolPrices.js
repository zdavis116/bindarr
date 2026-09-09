// MANA POOL PRICES.
//
// Zach: "I would like to see price of card from mana pool".
//
// GET /prices/singles is PUBLIC -- no key, no account. Verified against the
// live endpoint: 102,929 rows, every one carrying a scryfall_id, and measured
// coverage of Zach's real data at 1,508/1,508 collection rows and 472/474 deck
// cards. That clean join on the printing id is what makes this worth doing;
// name-matching marketplaces is where these integrations usually go wrong.
//
// (The BUYER side -- POST /buyer/optimizer -- does need an API key, despite the
// OpenAPI spec declaring no security on it. The live endpoint returns 401
// "Anonymous API access is not permitted". That half is not built yet.)
const https = require('https');
const zlib = require('zlib');
const db = require('./db');

const SOURCE = 'manapool';
const HOST = 'manapool.com';
const PATH = '/api/v1/prices/singles';

// Same reasoning as the catalogue's INSERT_CHUNK: one round trip per card costs
// far more than the download, but the bound-parameter count must stay inside
// SQLite's limit. 7 columns x 300 rows = 2,100 parameters.
const INSERT_CHUNK = 300;

// Milliseconds of idle between batches.
//
// NOT COSMETIC, and this project has already paid for learning why. db.js chains
// every query onto ONE global operation queue, so a long run of back-to-back
// writes leaves no gap for a waiting read -- that is exactly how the catalogue
// refresh made Zach's dashboard take 26 seconds. A background price import must
// not repeat it.
const BATCH_PAUSE_MS = 25;

function fetchPrices() {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, path: PATH, method: 'GET',
      headers: {
        'User-Agent': 'Bindarr/1.0 (self-hosted collection manager)',
        'Accept-Encoding': 'gzip',
      },
      timeout: 120000,
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
        // The payload measured ~51MB uncompressed. A cap well above that turns a
        // runaway response into a clear error instead of an out-of-memory kill.
        if (bytes > 250 * 1024 * 1024) {
          req.destroy();
          return reject(new Error('Mana Pool response exceeded 250MB; refusing it'));
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

// Which price to take for a row.
//
// price_cents is Mana Pool's headline number -- the cheapest listing in any
// condition. price_cents_nm is near-mint only. The headline is what their site
// leads with and what "what would this cost me" means in practice, so that is
// what Bindarr shows; NM is deliberately not substituted, because quietly
// showing a higher number than the marketplace does would make Bindarr look
// wrong to anyone who clicks through.
function normalise(row) {
  if (!row || !row.scryfall_id) return null;
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  const cents = n(row.price_cents);
  const foil = n(row.price_cents_foil);
  const etched = n(row.price_cents_etched);
  // A row with no usable price at all is a miss, not a zero -- storing it would
  // make the source look like it has an answer when it does not, and the
  // fallback chain would stop at it.
  if (cents === null && foil === null && etched === null) return null;
  return {
    card_id: row.scryfall_id,
    price_cents: cents,
    price_cents_foil: foil,
    price_cents_etched: etched,
    available_quantity: Number.isFinite(row.available_quantity) ? row.available_quantity : null,
    url: typeof row.url === 'string' ? row.url : null,
  };
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
    payload = await fetchPrices();
  } catch (err) {
    // RECORD THE FAILURE. A price that is three days old because the fetch has
    // been failing must be diagnosable in Settings, not just quietly stale.
    await db.run(
      `UPDATE source_price_meta SET last_error = ? WHERE source = ?`,
      [err.message, SOURCE]
    );
    throw err;
  }

  const rows = Array.isArray(payload?.data) ? payload.data : [];
  if (rows.length === 0) {
    const msg = 'Mana Pool returned no rows; keeping the previous prices';
    await db.run(`UPDATE source_price_meta SET last_error = ? WHERE source = ?`, [msg, SOURCE]);
    throw new Error(msg);
  }

  // UPSERT IN PLACE, never delete-then-insert.
  //
  // Emptying the table first would leave every screen showing no Mana Pool price
  // for the minute the import runs, and a crash mid-import would leave it that
  // way permanently. Rows for cards that vanish from the feed keep their last
  // known price and their updated_at stops moving, which is visible as staleness
  // rather than as a silent disappearance.
  let written = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)').join(', ');
    const params = [];
    for (const r of batch) {
      params.push(SOURCE, r.card_id, r.price_cents, r.price_cents_foil,
                  r.price_cents_etched, r.available_quantity, r.url);
    }
    await db.run(
      `INSERT INTO source_prices
         (source, card_id, price_cents, price_cents_foil, price_cents_etched,
          available_quantity, url, updated_at)
       VALUES ${values}
       ON CONFLICT(source, card_id) DO UPDATE SET
         price_cents        = excluded.price_cents,
         price_cents_foil   = excluded.price_cents_foil,
         price_cents_etched = excluded.price_cents_etched,
         available_quantity = excluded.available_quantity,
         url                = excluded.url,
         updated_at         = CURRENT_TIMESTAMP`,
      params
    );
    written += batch.length;
    batch = [];
    await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
    if (onProgress && written % 20000 < INSERT_CHUNK) onProgress(written, rows.length);
  };

  let skipped = 0;
  for (const raw of rows) {
    const r = normalise(raw);
    if (!r) { skipped++; continue; }
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

  return { written, skipped, asOf: payload?.meta?.as_of || null };
}

module.exports = { refreshManaPoolPrices, normalise, SOURCE };
