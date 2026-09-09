// ONE PRICE PER SHEET, AND NEVER THE PREVIOUS PRINTING'S.
//
// Zach, on Ant-Man, Elusive Avenger: "when I look at other printing it says 15
// cents but when I click on it 1 the card doesn't update right away I have to
// exit card detail and go back in and 2 when I go back in the value row says 24
// cents. When I navigate to mana pool it says value for card is 24 cents but
// then it shows cheapest list at 15 cents so I feel like we are using 2
// different values I would think we should be showing the cheapest one."
//
// THREE FAULTS, all real:
//
//   1. The Value row read `card.price_trend` -- the RAW card_cache row, which is
//      Scryfall's number and never went through resolvePricedCard. So the
//      printings list showed Mana Pool's $0.15 while the Value row above it
//      showed a different figure, on the same sheet, for the same card.
//
//   2. switchPrinting cleared deckUse but `card` is the PROP -- still the
//      printing he came from. Until the refetch landed, the sheet fell back to
//      it and displayed the old printing. Leaving and re-entering "fixed" it.
//
//   3. Mana Pool's own page shows both numbers: price_market (24c) as the
//      card's "value" and price_cents (15c) as the cheapest listing. Bindarr
//      stores price_cents, which is what he asked for -- "I would think we
//      should be showing the cheapest one". Guarded so a later change cannot
//      quietly switch to the market figure.
//
// VERIFIED on the deployed build: /api/card/<MSC #73>/decks returns
// price_trend $0.15 from Mana Pool with 544 in stock.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const inspector = fs.readFileSync(path.join(here, 'CardInspectorModal.jsx'), 'utf8');
const fetcher = fs.readFileSync(
  path.join(here, '..', '..', '..', 'backend', 'src', 'manaPoolPrices.js'), 'utf8');

const strip = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
                      .replace(/\/\*[\s\S]*?\*\//g, '')
                      .replace(/^\s*\/\/.*$/gm, '');
const ui = strip(inspector);
const feed = strip(fetcher);

test('AM-TC1: the Value row prices through the chain, not the raw catalogue', () => {
  const row = ui.slice(ui.indexOf("t('inspector.value')"),
                       ui.indexOf("t('inspector.value')") + 400);
  assert.match(row, /thisPrinting\?\.price_trend/,
    'the Value row must use the chain-priced printing, or it shows Scryfall\'s '
    + 'number directly above a Mana Pool one for the same card');
});

test('AM-TC2: the sheet does not fall back to the printing being switched away from', () => {
  const block = ui.slice(ui.indexOf('const switching ='), ui.indexOf('const switching =') + 400);
  assert.match(block, /switchedCardId/,
    'a switch in flight must be detectable');
  assert.match(block, /deckUse\?\.card_id !== switchedCardId/,
    'the switch is only complete when the server responds FOR THAT printing');
  assert.match(ui, /switching \? \{ \.\.\.card, id: switchedCardId, card_id: switchedCardId \}/,
    'while switching, the sheet must not assert the previous printing\'s identity');
});

test('AM-TC3: switchedCardId is declared before the code that reads it', () => {
  // A const used above its declaration is a temporal dead zone THROW on every
  // open, not a warning. I introduced exactly that while fixing this bug.
  const decl = ui.indexOf('const [switchedCardId');
  const use = ui.indexOf('const switching =');
  assert.ok(decl >= 0 && use >= 0, 'both must exist');
  assert.ok(decl < use,
    `switchedCardId is declared at ${decl} but read at ${use} -- that throws on open`);
});

test('AM-TC4: the stored price is the CHEAPEST listing, not the market figure', () => {
  // Mana Pool's page shows price_market as the card's "value" and price_cents
  // as the cheapest listing. Zach: "I would think we should be showing the
  // cheapest one."
  const norm = feed.slice(feed.indexOf('function normalise'),
                          feed.indexOf('function normalise') + 900);
  assert.match(norm, /n\(row\.price_cents\)/,
    'the headline price must be price_cents -- the cheapest listing');
  assert.doesNotMatch(norm, /price_market/,
    'price_market is the marketplace\'s average, not what the card costs today');
});

test('AM-TC5: a card with no usable price is a miss, not a zero', () => {
  // Storing a zero would make the source look like it has an answer, and the
  // fallback chain would stop at it rather than trying Scryfall.
  const norm = feed.slice(feed.indexOf('function normalise'),
                          feed.indexOf('function normalise') + 900);
  assert.match(norm, /if \(cents === null && foil === null && etched === null\) return null/,
    'a row with no price at all must not be stored as a priced row');
});

console.log('ant-man price guards passed');
