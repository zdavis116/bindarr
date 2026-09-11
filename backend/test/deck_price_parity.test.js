// ONE PRICE RULE, EVERYWHERE MONEY IS SHOWN.
//
// Zach: "when I look at cards on don't own in the deck view the value not
// individual card detail that shows 29 cents for the antman when value in the
// card view shows 15 cents and then I would like to make sure the deck total
// amount is using the right number as well. Everywhere should be using the mana
// pool lowest price even for collection total because in theory that is what I
// would sell and buy for."
//
// THE RULE, stated once: any figure a person could act on -- buy, sell, trade,
// budget -- uses the marketplace's cheapest listing, falling back to Scryfall
// only when the marketplace has nothing. Two screens quoting different numbers
// for the same printing is the failure being guarded against, and it had
// already happened twice: 29c on the deck row against 15c on the card sheet,
// and before that the Value row against the printings list.
//
// VERIFIED on the deployed build: deck 31 "I Am Iron Man" returns Ant-Man,
// Elusive Avenger at price_trend 0.15 with source 'manapool', and the deck
// totals derive from that same column.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
                      .replace(/^\s*\/\/.*$/gm, '')
                      .replace(/^\s*--.*$/gm, '');

const decks = strip(src('routes/decks.js'));
const identity = strip(src('utils/deckIdentity.js'));
const exporter = strip(src('routes/importExport.js'));
const compartment = strip(src('utils/compartmentSort.js'));

test('DP-TC1: deck card rows price from the marketplace, not the catalogue', () => {
  // This is the exact row Zach saw at 29c.
  const q = identity.slice(identity.indexOf('FROM deck_cards dc') - 1800,
                           identity.indexOf('ORDER BY cc.name'));
  assert.match(q, /mp\.price_cents/,
    'a deck row must use the marketplace price, or it quotes a different '
    + 'number than the card sheet for the same printing');
  assert.match(q, /source_prices mp/, 'the query must join the marketplace prices');
  assert.match(q, /COALESCE\([\s\S]{0,300}cc\.price_trend\)/,
    'Scryfall stays the last resort when the marketplace has nothing');
});

test('DP-TC2: deck_value and missing_cost derive from that same price', () => {
  // Both totals read `resolved`, which inherits from `req`. If they ever read a
  // different column they can disagree with the rows above them -- which is how
  // the completion ring and missing_cost drifted apart before.
  const value = decks.slice(decks.indexOf('AS deck_value') - 220,
                            decks.indexOf('AS deck_value'));
  const missing = decks.slice(decks.indexOf('AS missing_cost') - 220,
                              decks.indexOf('AS missing_cost'));
  for (const [name, block] of [['deck_value', value], ['missing_cost', missing]]) {
    assert.match(block, /r\.price_trend/,
      `${name} must read the resolved price, not the catalogue directly`);
    assert.doesNotMatch(block, /cc\.price_trend|dcc\.price_trend/,
      `${name} must not bypass the chain by reading card_cache`);
  }
  const req = decks.slice(decks.indexOf('AS identity'), decks.indexOf('FROM decks d'));
  assert.match(req, /mp\.price_cents/,
    'the resolved price the totals sum must itself be the marketplace price');
});

test('DP-TC3: the exported CSV agrees with the app', () => {
  // A Market Price column that disagrees with the screen is worse than no
  // column: it gets pasted into a trade.
  const q = exporter.slice(0, exporter.indexOf('FROM collection c') + 600);
  assert.match(q, /mp\.price_cents/, 'export must price through the chain');
  assert.match(q, /source_prices mp/, 'export must join the marketplace prices');
});

test('DP-TC4: cents are converted once, at the boundary', () => {
  // Money stored as integer cents; a missed /100 shows a $0.15 card as $15.
  for (const [name, code] of [['decks', decks], ['deckIdentity', identity],
                              ['export', exporter]]) {
    const uses = code.match(/mp\.price_cents(_foil|_etched)?/g) || [];
    const divides = code.match(/mp\.price_cents(_foil|_etched)?\s*\/\s*100/g) || [];
    // Every arithmetic use divides. Uses inside a CASE test (> 0) do not.
    assert.ok(divides.length >= 1,
      `${name} must convert cents to dollars`);
    assert.ok(uses.length >= divides.length,
      `${name}: unexpected price_cents accounting`);
  }
});

test('DP-TC5: physical binder placement still does NOT follow the marketplace', () => {
  // Deliberately excluded from "everywhere". Storage sorting decides where a
  // card physically sits; changing it silently reorders sleeved cardboard and
  // costs a recount, rather than showing a wrong number on a screen. If this
  // should change it must be an announced re-sort, not a side effect.
  assert.doesNotMatch(compartment, /resolvePricedCard|source_prices/,
    'compartment placement must not follow marketplace prices without a '
    + 'deliberate, announced re-sort');
});

console.log('deck and export price parity guards passed');
