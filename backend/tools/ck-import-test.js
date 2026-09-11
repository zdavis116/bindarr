#!/usr/bin/env node
// Does the Card Kingdom import actually work, on a COPY of his real database?
//
// Measured, not assumed: row counts, timing, collection coverage, and the worst
// concurrent read during the import -- the number that matters, because db.js
// serialises every query and a long write starves the UI. That is what made the
// dashboard take 26 seconds once already.
process.env.DB_PATH = '/tmp/cktest.db';
const db = require('../src/db');
const ck = require('../src/cardKingdomPrices');

(async () => {
  await db.initDb();

  // Hammer reads while the import runs, so a queue stall shows up as a number.
  let worst = 0, reads = 0, stop = false;
  const reader = (async () => {
    while (!stop) {
      const t = Date.now();
      await db.get('SELECT COUNT(*) n FROM collection');
      worst = Math.max(worst, Date.now() - t);
      reads += 1;
      await new Promise(r => setTimeout(r, 40));
    }
  })();

  const t0 = Date.now();
  const res = await ck.refreshCardKingdomPrices();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  stop = true;
  await reader;

  console.log(`  feed rows      : ${res.feedRows}`);
  console.log(`  printings kept : ${res.written}`);
  console.log(`  skipped        : ${res.skipped}  (no scryfall_id, or no NM/EX in stock)`);
  console.log(`  import time    : ${secs}s`);
  console.log(`  worst read during import: ${worst}ms over ${reads} reads`);

  const cov = await db.get(
    `SELECT COUNT(DISTINCT cc.id) n
       FROM collection c JOIN card_cache cc ON c.card_id = cc.id
       JOIN source_prices sp ON sp.card_id = cc.id AND sp.source = 'cardkingdom'`);
  const total = await db.get(
    `SELECT COUNT(DISTINCT cc.id) n
       FROM collection c JOIN card_cache cc ON c.card_id = cc.id`);
  console.log(`  collection coverage: ${cov.n}/${total.n} printings`);

  // What would his collection be worth at Card Kingdom vs Mana Pool?
  const val = await db.get(
    `SELECT SUM(c.quantity * (CASE WHEN c.finish IN ('foil','etched')
             THEN sp.price_cents_foil ELSE sp.price_cents END)) / 100.0 v
       FROM collection c JOIN source_prices sp
         ON sp.card_id = c.card_id AND sp.source = 'cardkingdom'`);
  const mp = await db.get(
    `SELECT SUM(c.quantity * (CASE WHEN c.finish IN ('foil','etched')
             THEN sp.price_cents_foil ELSE sp.price_cents END)) / 100.0 v
       FROM collection c JOIN source_prices sp
         ON sp.card_id = c.card_id AND sp.source = 'manapool'`);
  console.log(`  collection at Card Kingdom: $${(val.v || 0).toFixed(2)}`);
  console.log(`  collection at Mana Pool   : $${(mp.v || 0).toFixed(2)}`);

  // Spot-check one card end to end, so a number can be clicked and verified.
  const sample = await db.get(
    `SELECT cc.name, cc.set_id, cc.number, sp.price_cents, sp.condition,
            sp.available_quantity, sp.url
       FROM source_prices sp JOIN card_cache cc ON cc.id = sp.card_id
      WHERE sp.source = 'cardkingdom' AND sp.price_cents > 300
      LIMIT 1`);
  console.log('  sample:', JSON.stringify(sample));
  process.exit(0);
})().catch(e => { console.error('THREW:', e.message); process.exit(1); });
