// Runnable check for price-history recording. The sweep runs on every boot and
// nodemon reboots on every edit, which wrote a fresh row per card per restart —
// 17k identical rows in one day. Only movements belong in a price series.
// No framework — plain node + assert. Run: `node test/pricehistory.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bindarr-pricehist-${process.pid}.db`);
const db = require('../src/db');
const { recordPrice, shouldSweepPrices, markPricesSwept } = require('../src/utils/priceHelpers');

const CARD = 'mtg-test-card';
const count = async () => (await db.get(`SELECT COUNT(*) n FROM price_history WHERE card_id = ?`, [CARD])).n;

async function main() {
  await db.initDb();

  // 1. First price is recorded.
  assert.strictEqual(await recordPrice(CARD, 1.5), true, 'first price should be recorded');
  assert.strictEqual(await count(), 1);

  // 2. The same price again is NOT recorded, however many times the sweep runs.
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(await recordPrice(CARD, 1.5), false, 'unchanged price must not be recorded');
  }
  assert.strictEqual(await count(), 1, 'restarts must not pile up identical rows');

  // 3. A real movement IS recorded.
  assert.strictEqual(await recordPrice(CARD, 2.25), true, 'a price change should be recorded');
  assert.strictEqual(await count(), 2);

  // 4. Returning to an earlier price is still a movement worth recording.
  assert.strictEqual(await recordPrice(CARD, 1.5), true, 'a move back down is still a move');
  assert.strictEqual(await count(), 3);

  // 5. Junk is ignored rather than written as a zero-price data point.
  assert.strictEqual(await recordPrice(CARD, 0), false, 'zero is not a price');
  assert.strictEqual(await recordPrice(CARD, null), false, 'null is not a price');
  assert.strictEqual(await recordPrice(null, 5), false, 'no card id, no row');
  assert.strictEqual(await count(), 3, 'junk must not reach the table');

  // 6. Concurrent identical observations represent one movement, not five.
  const identicalResults = await Promise.all(
    Array.from({ length: 5 }, () => recordPrice(CARD, 2.25))
  );
  assert.strictEqual(identicalResults.filter(Boolean).length, 1, 'only one concurrent identical update should insert');
  assert.strictEqual(await count(), 4, 'concurrent identical updates must create one row');

  // 7. Per-card calls are processed in invocation order, so a rapid reversal is
  // not lost when both observations arrive before either database callback runs.
  const reversalResults = await Promise.all([
    recordPrice(CARD, 3.0),
    recordPrice(CARD, 2.25)
  ]);
  assert.deepStrictEqual(reversalResults, [true, true], 'both concurrent movements must be recorded');
  assert.strictEqual(await count(), 6);
  const latest = await db.get(
    `SELECT price FROM price_history WHERE card_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    [CARD]
  );
  assert.strictEqual(latest.price, 2.25, 'latest price must reflect the queued reversal');

  // --- Once-a-day sweep gate ---
  // Scryfall only moves prices once a day, so sweeping more often is pure load.
  // The boot sweep used to re-run on every restart; under nodemon that meant a
  // full sweep per code edit.
  assert.strictEqual(await shouldSweepPrices('mtg'), true, 'a never-swept DB should sweep');
  await markPricesSwept('mtg');
  assert.strictEqual(await shouldSweepPrices('mtg'), false, 'must not re-sweep right after sweeping');
  assert.strictEqual(await shouldSweepPrices('pokemon'), false, 'removed providers must not have sweep clocks');
  assert.strictEqual(await shouldSweepPrices('tcgdex'), false, 'removed providers must not have sweep clocks');

  await db.run(`UPDATE app_settings SET mtg_prices_swept_at = datetime('now', '-25 hours') WHERE id = 1`);
  assert.strictEqual(await shouldSweepPrices('mtg'), true, 'over 24h old should sweep again');

  // Just under a day is still too soon.
  await db.run(`UPDATE app_settings SET mtg_prices_swept_at = datetime('now', '-23 hours') WHERE id = 1`);
  assert.strictEqual(await shouldSweepPrices('mtg'), false, '23h is inside the daily window');

  console.log('pricehistory.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
