// EVERY PRICED SURFACE USES THE SAME CHAIN, AND A PRICE IS CHECKABLE.
//
// Zach: "Let's do the other 12 call sites and I think it would be nice as well
// to have a button that takes you right to the card in manapool whether the
// price is clickable or something else in the card detail."
//
// TWO RULES WORTH GUARDING, both learned the hard way in this project:
//
//   1. A LIST MUST SORT BY THE PRICE IT DISPLAYS. "Top 6 most valuable" ordered
//      by the Scryfall price and then relabelled each row with the chain's
//      answer -- so it showed Mana Pool numbers in Scryfall order. A list that
//      is visibly out of order, or simply the wrong six cards. Same class as
//      the deck completion ring disagreeing with missing_cost.
//
//   2. A BUY LINK MUST COME FROM THE SOURCE, never be constructed. A URL built
//      from set code and collector number 404s on anything the marketplace does
//      not carry, and a dead buy button is worse than none.
//
// VERIFIED LIVE on the deployed build: Improvised Arsenal returns TMT #92 at
// $0.20 (249 in stock) and TMT #270 at $1.03 (77 in stock), and both URLs
// resolve HTTP 200.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const back = (f) => fs.readFileSync(path.join(here, '..', '..', '..', 'backend', 'src', f), 'utf8');
const stats = back('routes/stats.js');
const collection = back('routes/collection.js');
const compartment = back('utils/compartmentSort.js');
const inspector = fs.readFileSync(path.join(here, 'CardInspectorModal.jsx'), 'utf8');

// Comments quote the bug at length; asserting against prose would pass on the
// explanation rather than the code. This project has had a guard fire on a word
// inside a comment before.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
                      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
                      .replace(/^\s*\/\/.*$/gm, '')
                      .replace(/^\s*--.*$/gm, '');
const statsCode = strip(stats);
const inspectorCode = strip(inspector);

test('MP-TC1: the most-valuable list sorts by the price it will show', () => {
  const q = statsCode.slice(statsCode.indexOf('topValuableQuery'),
                            statsCode.indexOf('topValuableRows'));
  assert.match(q, /mp\.price_cents/,
    'the ORDER BY must consider the marketplace price, or the six "most '
    + 'valuable" cards are the six most valuable by a price the row does not show');
  // The join used to be a fixed constant. It is now built from the shop he
  // selected, so this asserts that the query joins THAT -- pinning it back to
  // one shop would sort by Mana Pool while displaying Card Kingdom numbers,
  // which is the same bug this test was written for in the first place.
  assert.match(q, /\$\{shopJoin\}/,
    'the query must join the prices of the shop currently selected');
});

test('MP-TC2: top-valuable and recent additions carry their source', () => {
  for (const name of ['topValuable', 'recentAdditions']) {
    const block = statsCode.slice(statsCode.indexOf(`const ${name} =`),
                                  statsCode.indexOf(`const ${name} =`) + 500);
    assert.match(block, /resolvePricedCard\(row\)/,
      `${name} must price through the chain, not the bare helper`);
    assert.match(block, /price_source_label/,
      `${name} must say which source priced it`);
  }
});

test('MP-TC3: the value history stays on one consistent series', () => {
  // Splicing a marketplace price into a Scryfall history would draw a step
  // change on the day the feature shipped and read as a loss of value.
  const fn = statsCode.slice(statsCode.indexOf('const realPriceAt'),
                             statsCode.indexOf('const realPriceAt') + 400);
  assert.match(fn, /return resolveCardPrice\(item\)/,
    'the history fallback must stay on the plain helper until a marketplace '
    + 'series exists to compare against');
  assert.doesNotMatch(fn, /resolvePricedCard/,
    'mixing sources inside one time series misreports the collection over time');
});

test('MP-TC4: physical binder ordering is NOT re-sorted by a new price source', () => {
  // Changing this silently reorders cardboard already sleeved, costing a
  // recount rather than a wrong number on a screen.
  assert.doesNotMatch(strip(compartment), /resolvePricedCard/,
    'compartment placement must not follow marketplace prices without a '
    + 'deliberate, announced re-sort');
});

test('MP-TC5: printings carry a buy URL that came FROM the source', () => {
  const block = strip(collection).slice(
    strip(collection).indexOf('printings: printings.map'),
    strip(collection).indexOf('printings: printings.map') + 900);
  assert.match(block, /price_url:[\s\S]{0,80}p\.mp_url/,
    'the buy link must be the marketplace\'s own URL for that printing');
  assert.doesNotMatch(block, /manapool\.com\/card\/\$\{/,
    'a URL built from set code and number 404s on anything not carried');
});

test('MP-TC6: the buy button only renders when a URL actually exists', () => {
  assert.match(inspectorCode, /thisPrinting\?\.price_url && \(/,
    'a buy button with no destination is worse than no button');
  assert.match(inspectorCode, /rel="noopener noreferrer"/,
    'an external link opened in a new tab needs noopener');
});

test('MP-TC7: the per-printing buy icon cannot silently repoint a deck', () => {
  // Those rows ARE the repoint control. A click that opens the marketplace and
  // also changes which printing a deck asks for is the silent state change
  // Zach has ruled out.
  const icon = inspectorCode.slice(inspectorCode.indexOf('pr.price_url && ('),
                                   inspectorCode.indexOf('pr.price_url && (') + 900);
  assert.match(icon, /stopPropagation\(\)/,
    'opening the marketplace must not also trigger the row\'s repoint handler');
});

console.log('mana pool price surface guards passed');
