#!/usr/bin/env node
/**
 * "ANY PRINTING" FAILS. WHY?
 *
 * Setting every line to any-printing returns 409 no_candidates with a null set
 * code -- the signature of the card_id path. I already measured that card_id
 * 409s as an EXACT identifier; the schema claims it is how you allow
 * substitution. Both cannot be true.
 *
 * Testing the documented alternatives one at a time on a single ordinary card
 * that is definitely in stock, so a 409 means the FIELD is wrong rather than the
 * card being unavailable.
 */
const https = require('https');

const EMAIL = process.env.MANAPOOL_EMAIL;
const KEY = process.env.MANAPOOL_API_KEY;

function post(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'manapool.com', path: '/api/v1/buyer/optimizer', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-ManaPool-Email': EMAIL,
        'X-ManaPool-Access-Token': KEY,
        'User-Agent': 'Bindarr/1.0',
      },
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const lines = data.split('\n').map(s => s.trim()).filter(Boolean);
        let final = null;
        for (const l of lines) { try { final = JSON.parse(l); } catch { /* partial */ } }
        resolve({ status: res.statusCode, final, raw: data.slice(0, 260) });
      });
    });
    req.on('error', e => resolve({ status: 0, raw: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, raw: 'timeout' }); });
    req.end(payload);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const base = {
  type: 'mtg_single', quantity_requested: 1,
  language_ids: ['EN'], finish_ids: ['NF'], condition_ids: ['LP', 'NM'],
};

// An Offer You Can't Refuse, FDN #160 -- from Zach's own buylist, in stock.
const SET = 'FDN', NUM = '160';
const SCRYFALL_ID = null; // filled in below from the database

const show = (label, r) => {
  if (r.status === 200 && r.final?.totals) {
    const t = r.final.totals;
    console.log(`  ${label.padEnd(34)} 200  items $${(t.subtotal_cents/100).toFixed(2)}`
      + ` total $${(t.total_cents/100).toFixed(2)}  ${t.seller_count} seller(s)`);
  } else {
    console.log(`  ${label.padEnd(34)} ${r.status}  ${String(r.raw).slice(0, 150)}`);
  }
};

(async () => {
  const db = require('./src/db');
  await db.initDb();
  const row = await db.get(
    `SELECT id, oracle_id FROM card_cache WHERE set_id = ? AND number = ?`,
    [SET.toLowerCase(), NUM]);
  console.log('card:', SET, '#' + NUM, '| scryfall id', row?.id, '| oracle', row?.oracle_id);
  console.log('');

  const attempts = [
    ['set_code + collector_number (exact)', { set_code: SET, collector_number: NUM }],
    ['card_id = scryfall PRINTING id', { card_id: row.id }],
    ['card_id = ORACLE id', { card_id: row.oracle_id }],
  ];

  for (const [label, over] of attempts) {
    const r = await post({ cart: [{ ...base, ...over }], model: 'lowest_price',
                           destination_country: 'US' });
    show(label, r);
    await sleep(25000);
  }
  process.exit(0);
})().catch(e => { console.error('THREW:', e.message); process.exit(1); });
