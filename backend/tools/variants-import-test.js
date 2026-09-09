#!/usr/bin/env node
/**
 * THE VARIANTS IMPORT, AGAINST REAL DATA.
 *
 * Zach found /prices/singles quoting $34.37 for a card whose page never shows
 * that number. This checks the replacement actually fixes it, and that the
 * bigger feed (201MB, 535k rows vs 51MB, 103k) does not starve the app the way
 * the catalogue refresh once did.
 */
const path = require('path');
const db = require('../src/db');
const { refreshManaPoolPrices } = require('../src/manaPoolPrices');

const URDRAGON = '4de700d8-2a0c-439e-b8c9-8663fa813ac7'; // PF25 #15 foil

const READ = `SELECT COUNT(*) AS n FROM collection c
              JOIN card_cache cc ON cc.id = c.card_id
              WHERE c.user_id = 1 AND c.list_type = 'collection'`;

(async () => {
  await db.initDb();

  let worst = 0, reads = 0, done = false;
  const hammer = (async () => {
    while (!done) {
      const t = Date.now();
      await db.all(READ);
      const took = Date.now() - t;
      if (took > worst) worst = took;
      reads++;
      await new Promise(r => setTimeout(r, 100));
    }
  })();

  const t0 = Date.now();
  const res = await refreshManaPoolPrices({
    onProgress: (n, total) => console.log(`  ...${n}/${total}`),
  });
  done = true;
  await hammer;

  console.log('');
  console.log(`variant rows read : ${res.variantRows}`);
  console.log(`printings written : ${res.written}`);
  console.log(`feed as of        : ${res.asOf}`);
  console.log(`elapsed           : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`reads during it   : ${reads}, WORST ${worst}ms`);

  const urd = await db.get(
    `SELECT price_cents, price_cents_foil, condition, condition_foil,
            available_quantity, url
       FROM source_prices WHERE source = 'manapool' AND card_id = ?`, [URDRAGON]);
  console.log('');
  console.log('THE CARD ZACH REPORTED — The Ur-Dragon PF25 #15:');
  console.log(`  foil  : $${((urd?.price_cents_foil || 0) / 100).toFixed(2)}`
            + `  (${urd?.condition_foil || 'n/a'})`);
  console.log(`  stock : ${urd?.available_quantity}`);
  console.log(`  url   : ${urd?.url}`);
  console.log('  EXPECTED $32.99 LP — the cheapest price on their own page');

  const cov = await db.get(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN sp.card_id IS NOT NULL THEN 1 ELSE 0 END) AS priced
      FROM (SELECT DISTINCT card_id FROM collection
             WHERE user_id = 1 AND list_type = 'collection') c
      LEFT JOIN source_prices sp
             ON sp.card_id = c.card_id AND sp.source = 'manapool'`);
  console.log('');
  console.log(`collection coverage: ${cov.priced}/${cov.total}`
            + ` = ${Math.round(cov.priced / cov.total * 100)}%`);

  const conds = await db.all(
    `SELECT condition, COUNT(*) n FROM source_prices
      WHERE source = 'manapool' AND condition IS NOT NULL GROUP BY condition`);
  console.log('conditions stored  :', conds.map(c => `${c.condition} ${c.n}`).join(', '));

  process.exit(0);
})().catch(e => { console.error('THREW:', e.message); process.exit(1); });
