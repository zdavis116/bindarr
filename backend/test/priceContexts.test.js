// Two prices, two questions: what it is WORTH vs what it will COST.
//
// Zach: "I want to use tcgplayer as my price per card for my collection but
// for my decks for cards that I am missing I want to use... mana pool... most
// shops I would sell cards from my collection too would be using tcgplayer but
// when I am buying cards I will be mainly using mana pool and usually mana
// pool prices are cheaper."
//
// Measured before building: across the 80,044 cards both shops price, Mana
// Pool is cheaper than Card Kingdom on 96.5%. His Omnipresence is $42.15 at
// TCGplayer market and $15.00 at Mana Pool.
//
// And on the deck screen specifically -- "I want A because deck_value is what
// I own so I want it to reflect properly":
//     deck_value   -> valuation source
//     missing_cost -> buying source
//
// Verified live on dev: Doctor Doom missing_cost $19.16, which is $0.64 from
// the Mana Pool figure and $8.05 from the Scryfall one.
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..', '..');
const helpers = readFileSync(join(ROOT, 'backend/src/utils/priceHelpers.js'), 'utf8');
const decks = readFileSync(join(ROOT, 'backend/src/routes/decks.js'), 'utf8');
const collection = readFileSync(join(ROOT, 'backend/src/routes/collection.js'), 'utf8');
const stats = readFileSync(join(ROOT, 'backend/src/routes/stats.js'), 'utf8');
const impexp = readFileSync(join(ROOT, 'backend/src/routes/importExport.js'), 'utf8');
const identity = readFileSync(join(ROOT, 'backend/src/utils/deckIdentity.js'), 'utf8');
const settings = readFileSync(join(ROOT, 'backend/src/routes/settings.js'), 'utf8');
const schema = readFileSync(join(ROOT, 'backend/src/db.js'), 'utf8');

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// PRICE-TC1: the context is REQUIRED, and a bad one throws.
//
// This is the guard that makes the rest safe. A default would let a forgotten
// argument silently return the wrong price -- and a wrong price looks exactly
// like a right one on screen.
{
  start('PRICE-TC1');
  const fn = /async function selectedShop\([\s\S]*?\n\}/.exec(helpers);
  assert.ok(fn, 'selectedShop could not be found');
  assert.match(fn[0], /if \(!PRICE_CONTEXTS\.includes\(context\)\) \{\s*\n\s*throw new Error\(/,
    'an unknown or missing context must THROW. Defaulting means a call site '
    + 'that forgets the argument quietly shows a selling price where a '
    + 'buying price belongs, and nothing looks wrong');
  assert.ok(!/function selectedShop\(database, context = /.test(helpers),
    'the context parameter must have no default value');
  pass('PRICE-TC1', 'the context is required and unvalidated input throws');
}

// PRICE-TC2: EVERY call site declares a context. None left implicit.
//
// Six call sites across five files. Missing one is the whole risk of this
// change -- it would keep working and be wrong.
{
  start('PRICE-TC2');
  const files = { decks, collection, stats, impexp, identity };
  for (const [name, src] of Object.entries(files)) {
    // Matched to the END OF THE LINE rather than the first ')': one call is
    // selectedShop(client(database), 'buying'), and stopping at the inner
    // paren reported a false failure on correct code.
    const calls = src.match(/selectedShop\(.*$/gm) || [];
    for (const c of calls) {
      // The helper's own definition and its export are not call sites.
      if (/function selectedShop|^\s*selectedShop,/.test(c)) continue;
      assert.match(c, /'(valuation|buying)'/,
        `${name}: ${c.trim()} does not name a context. Every price read must `
        + 'say whether it is valuing something or costing a purchase');
    }
  }
  // And the ones whose meaning is fixed by what they answer.
  assert.match(collection, /selectedShop\(db, 'valuation'\)/,
    'the collection is valued, not bought');
  assert.match(stats, /selectedShop\(db, 'valuation'\)/,
    'collection stats answer "what is this worth"');
  assert.match(impexp, /selectedShop\(db, 'valuation'\)/,
    'an export of his collection carries its value');
  assert.match(identity, /selectedShop\(client\(database\), 'buying'\)/,
    'deck availability is about acquiring missing cards');
  pass('PRICE-TC2', 'all call sites name their context');
}

// PRICE-TC3: the deck screen uses BOTH, on the right figures.
{
  start('PRICE-TC3');
  assert.match(decks, /const valueShop = await selectedShop\(db, 'valuation'\);/,
    'the deck list needs the valuation source for deck_value');
  assert.match(decks, /const buyShop = await selectedShop\(db, 'buying'\);/,
    'and the buying source for missing_cost');
  // The SELECT wraps across a line, so the gap allowance has to cover the
  // WHERE clause between the SUM and the alias.
  assert.match(decks, /SUM\(\(r\.quantity - r\.owned_here\) \* r\.buy_price\)[\s\S]{0,160}AS missing_cost/,
    'missing_cost must use the BUY price -- it is the only figure on that '
    + 'screen that is money he would spend');
  assert.match(decks, /SUM\(r\.quantity \* r\.price_trend\)[\s\S]{0,160}AS deck_value/,
    'deck_value must use the VALUATION price -- "deck_value is what I own so '
    + 'I want it to reflect properly"');
  pass('PRICE-TC3', 'deck_value values, missing_cost costs');
}

// PRICE-TC4: buy_price survives every CTE between its join and its use.
//
// It did not, on the first attempt. Adding the column to `req` was not enough
// because `resolved` re-selects named columns -- the deck list returned HTTP
// 500 with "no such column: r.buy_price".
{
  start('PRICE-TC4');
  const q = /const rows = await db\.all\(`[\s\S]*?`,/.exec(decks);
  assert.ok(q, 'the deck list query could not be found');
  const sql = q[0];
  assert.match(sql, /AS buy_price/, 'buy_price must be produced');
  assert.match(sql, /LEFT JOIN source_prices bp\s*\n\s*ON bp\.card_id = dcc\.id AND bp\.source = '\$\{buyShop\}'/,
    'a second join is needed: one shop per price, not one join reused');
  const resolved = /resolved AS \([\s\S]*?\n      \)/.exec(sql);
  assert.ok(resolved, 'the resolved CTE could not be found');
  assert.match(resolved[0], /r\.buy_price,/,
    'resolved re-selects named columns, so buy_price must be listed there or '
    + 'it is invisible to missing_cost -- this exact omission returned 500');
  pass('PRICE-TC4', 'buy_price reaches the figure that uses it');
}

// PRICE-TC5: 'scryfall' is a valid valuation source and joins nothing.
{
  start('PRICE-TC5');
  assert.match(helpers, /const VALUATION_SOURCES = \{ scryfall: 'TCGplayer \(via Scryfall\)'/,
    'Scryfall/TCGplayer must be offered for valuation');
  const join = /function marketplacePriceJoin\([\s\S]*?\n\}/.exec(helpers)[0];
  assert.match(join, /if \(sourceId === 'scryfall'\)/,
    'the scryfall source needs its own branch');
  assert.match(join, /__scryfall_no_marketplace__/,
    'it must emit a join that matches nothing rather than no join at all: '
    + 'every query selects the mp_* columns and they must still exist');
  pass('PRICE-TC5', 'scryfall valuation falls through to the card_cache price');
}

// PRICE-TC6: the setting is persisted separately and takes effect at once.
{
  start('PRICE-TC6');
  assert.match(schema, /ADD COLUMN valuation_price_source TEXT/,
    'a SEPARATE column, so choosing a valuation source cannot reinterpret '
    + 'his existing buying choice');
  assert.match(settings, /router\.put\('\/valuation-source'/,
    'there must be a way to change it');
  assert.match(settings, /priceHelpers\.VALUATION_SOURCES\[requested\]/,
    'the submitted source must be validated against the registry');
  const put = /router\.put\('\/valuation-source'[\s\S]*?\n\}\);/.exec(settings)[0];
  assert.match(put, /clearShopCache\(\)/,
    'the 5s cache must be cleared on write, or the setting appears not to '
    + 'work for five seconds');
  pass('PRICE-TC6', 'the setting is separate, validated and immediate');
}

console.log(`\npriceContexts.test.js: ${passed} cases passed`);
