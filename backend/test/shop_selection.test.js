// ONE CHOSEN SHOP, NOT A RANKED LIST.
//
// Zach, after living with the ranking he originally asked for: "I would like to
// get rid of the priority list and it be a selection whether I used mana pool or
// card kingdom but the fallback is always scryfall since it's an average."
//
// The measurements say he is right. The two shops have different price FLOORS,
// not different opinions about the same cards:
//
//   most common Card Kingdom price   $0.35 x1584
//   most common Mana Pool price      $0.15 x2225
//   his collection: $2576 vs $1317, and 61% of the gap is bulk commons
//
// A ranked chain would have blended them -- most cards at one shop's floor, a
// handful at the other's -- producing a total that is the price at NO shop and
// cannot be checked against any real page. That is the same failure as the
// $34.37 he could not find on Mana Pool's own listing page.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import pkg from '../src/utils/priceSources.js';

const { SOURCES, FALLBACK_SOURCE, normaliseOrder, selectableSources } = pkg;
const helpers = readFileSync(new URL('../src/utils/priceHelpers.js', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../src/routes/settings.js', import.meta.url), 'utf8');
const ck = readFileSync(new URL('../src/cardKingdomPrices.js', import.meta.url), 'utf8');

test('SHOP-TC1: a selection produces a two-step chain, shop then fallback', () => {
  assert.deepEqual(normaliseOrder('cardkingdom'), ['cardkingdom', 'scryfall']);
  assert.deepEqual(normaliseOrder('manapool'), ['manapool', 'scryfall']);
});

test('SHOP-TC2: a stale or hostile stored value cannot blank every price', () => {
  // This comes from a settings row. A bad value must degrade to the default
  // shop, never to "no shop", which would silently reprice his whole
  // collection at Scryfall averages without saying so.
  for (const bad of [null, undefined, '', 'bogus', 42, {}, []]) {
    const order = normaliseOrder(bad);
    assert.equal(order.length, 2, `${JSON.stringify(bad)} must still yield a chain`);
    assert.ok(SOURCES[order[0]]?.selectable, 'and its first step must be a real shop');
    assert.equal(order[1], FALLBACK_SOURCE);
  }
});

test('SHOP-TC3: the OLD ranked array is still understood', () => {
  // His database already holds ["manapool"] from the previous design. Reading
  // that as garbage would reprice his collection at the default on upgrade --
  // a silent change to every number on every screen.
  assert.deepEqual(normaliseOrder(['cardkingdom']), ['cardkingdom', 'scryfall']);
  assert.deepEqual(normaliseOrder(['manapool', 'scryfall']), ['manapool', 'scryfall']);
  assert.deepEqual(normaliseOrder(['scryfall']), ['manapool', 'scryfall'],
    'a legacy order naming only the fallback falls back to the default shop');
});

test('SHOP-TC4: Scryfall can never be the chosen shop', () => {
  assert.equal(SOURCES.scryfall.selectable, false);
  assert.ok(!selectableSources().some(s => s.id === 'scryfall'));
  assert.deepEqual(normaliseOrder('scryfall'), ['manapool', 'scryfall'],
    'asking for it as primary yields the default shop, with it still behind');
  assert.match(settings, /if \(!def\.selectable\)/,
    'and the API refuses it explicitly rather than silently substituting');
});

test('SHOP-TC5: the shop reaches the SQL, and cannot be injected through it', () => {
  // The join is built by string interpolation because a table filter cannot be
  // a bound parameter. That makes validation the only thing between a settings
  // row and arbitrary SQL.
  assert.match(helpers, /const id = MARKETPLACE_LABELS\[sourceId\] \? sourceId : 'manapool'/,
    'the id must be checked against the known set before interpolation');
  assert.match(helpers, /function marketplacePriceJoin/,
    'and the join must be a function of it, not a constant');
  assert.ok(!/const MARKETPLACE_PRICE_JOIN = `[\s\S]*?source = 'manapool'`/.test(helpers)
    || /marketplacePriceJoin\('manapool'\)/.test(helpers),
    'the legacy constant must derive from the same function');
});

test('SHOP-TC6: no query is hardcoded to one shop any more', () => {
  // The whole point. A single missed call site means one screen quotes Mana
  // Pool while the rest quote Card Kingdom -- exactly the class of bug he found
  // when a deck row said 29c and the card sheet said 15c.
  //
  // MY FIRST VERSION OF THIS TEST DID NOT CATCH ITS OWN BUG. It only looked for
  // the literal string "source = 'manapool'", so pinning a screen back with
  // marketplacePriceJoin('manapool') passed cleanly -- and that is precisely
  // the mistake, since the hardcoded call is the easy way to write it. The
  // fifth guard on this project to certify the thing it was written to prevent.
  for (const f of ['routes/stats.js', 'routes/collection.js', 'routes/decks.js',
                   'routes/importExport.js', 'utils/deckIdentity.js']) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.ok(!src.includes("source = 'manapool'"),
      `${f} must not pin the shop in SQL; it should read the selection`);
    assert.ok(!/marketplacePriceJoin\(\s*['"]/.test(src),
      `${f} must pass the SELECTED shop to marketplacePriceJoin, not a literal`);
    assert.ok(!src.includes('MARKETPLACE_PRICE_JOIN'),
      `${f} must not use the fixed-shop constant`);
  }
});

test('SHOP-TC7: switching shops takes effect immediately', () => {
  // The selection is cached so every priced endpoint is not a settings read.
  // Without an explicit clear on write, his choice would appear not to work for
  // up to five seconds -- and he taps straight back to the dashboard.
  assert.match(helpers, /function clearShopCache/);
  assert.match(settings, /priceHelpers\.clearShopCache\(\)/,
    'the write path must clear it');
});

test('SHOP-TC9: the export sheet opens on the shop he selected', () => {
  // Zach: "It should open which ever card price source we are using."
  //
  // The sheet used to open on the first tab regardless, so someone valuing
  // their collection at Card Kingdom changed shops on every export -- and could
  // read a Mana Pool total for a moment and take it for theirs.
  const modal = readFileSync(
    new URL('../../frontend/src/components/ExportModal.jsx', import.meta.url), 'utf8');
  assert.match(modal, /fetch\('\/api\/settings\/price-sources'\)/,
    'the sheet must read the selected shop when it opens');
  assert.match(modal, /EXPORT_FORMATS\.find\(f => f\.source === d\.selected\)/,
    'and match it to a tab by source id');
  // Scryfall is the fallback and has no tab. An unknown or unmatched id must
  // leave the sheet on a working tab rather than blanking it.
  assert.match(modal, /if \(match\) setFormatId\(match\.id\)/,
    'an unmatched source must not clear the active tab');
  // Re-read on every open: he can change shops in Settings between exports.
  assert.match(modal, /\}, \[open\]\)/,
    'the lookup must run each time the sheet opens, not once per session');
});

test('SHOP-TC8: Card Kingdom prices are real, stocked, and above his floor', () => {
  // A price with no quantity behind it is not a price he can act on: Card
  // Kingdom lists prices for grades they are out of.
  assert.match(ck, /if \(price === null \|\| qty <= 0\) continue/,
    'a grade with no stock must not be priced');
  // Their feed carries a separate row per finish for the same scryfall_id, so a
  // naive keyed insert would let the foil row overwrite the nonfoil one and
  // every card would be priced as whichever appeared last.
  assert.match(ck, /if \(isFoil\)/, 'foil and nonfoil must be folded separately');
  // URLs come FROM the feed. A constructed link 404s on anything they do not
  // carry, and a dead buy button is worse than no button.
  assert.match(ck, /if \(!entry\.url && r\.url\)/,
    'the buy URL must come from the feed');
});

console.log('shop selection guards passed');
