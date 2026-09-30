// A deck screen answers two money questions, from two sources.
//
// Zach: "can I have a search that lets me search my deck for the card? Also
// when a deck is complete can I see what my deck is worth?" then, decisively:
// "we should always be using TCGPlayer market price for cards we own even in
// deck view screen. And yeah we can always show the total deck value for cards
// we own but right now if we are missing cards we show the cost of those
// missing cards I dont want to lose that either."
//
//   worth        -- copies he HAS,     at the VALUATION source
//   costToFinish -- copies he NEEDS,   at the BUYING source
//
// Verified live on his decks:
//   Doctor Doom   worth $201.95 (TCG) vs $165.47 (buy), cost to finish $19.42
//   Ur-Dragon     worth  $84.59 (TCG) vs  $63.36 (buy)
// A "worth" built from the buying price would have understated Doctor Doom by
// $36 while calling it a TCGplayer figure.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const view = readFileSync(join(HERE, 'DeckView.jsx'), 'utf8');
const identity = readFileSync(join(REPO, 'backend/src/utils/deckIdentity.js'), 'utf8');
const en = JSON.parse(readFileSync(join(HERE, '..', 'locales', 'en.json'), 'utf8'));

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// DW-TC1: deck rows carry BOTH prices, from two joins.
{
  start('DW-TC1');
  assert.match(identity, /const valueShop = await selectedShop\(client\(database\), 'valuation'\);/,
    'the deck query needs the valuation source as well as the buying one');
  assert.match(identity, /AS value_price/,
    'each row must carry what an owned copy is WORTH');
  assert.match(identity, /LEFT JOIN source_prices vp\s*\n\s*ON vp\.card_id = cc\.id AND vp\.source = '\$\{valueShop\}'/,
    'a second join: one shop per price. Reusing the buying join would make '
    + 'both figures the same number wearing two labels');
  assert.match(identity, /value_price: entry\.value_price,/,
    'value_price must survive into the response, or the screen never sees it');
  pass('DW-TC1', 'rows carry a buy price and a value price');
}

// DW-TC2: worth uses the VALUE price; cost to finish keeps the BUY price.
//
// Zach was explicit that the missing-cost figure must not be lost, so this
// asserts both, not just the new one.
{
  start('DW-TC2');
  const worth = /const deckWorth = useMemo\([\s\S]*?\n    \[deckCards\]\);/.exec(view);
  assert.ok(worth, 'deckWorth could not be found');
  assert.match(worth[0], /c\.value_price \?\? c\.price_trend \?\? 0/,
    'worth must prefer the VALUATION price, falling back only when absent');

  const cost = /const costToFinish = useMemo\([\s\S]*?\n    \[deckCards\]\);/.exec(view);
  assert.ok(cost, 'costToFinish could not be found');
  assert.match(cost[0], /\(c\.quantity_missing \|\| 0\) \* \(c\.price_trend \|\| 0\)/,
    'cost to finish must keep using the BUYING price -- "I dont want to lose '
    + 'that either"');
  pass('DW-TC2', 'worth values, cost to finish costs');
}

// DW-TC3: worth counts AVAILABLE copies, not owned ones.
//
// The same rule the completion ring uses. A copy sleeved into another deck is
// not part of this deck's worth, or two decks each claim the same card and the
// collection appears to be worth more than it is.
{
  start('DW-TC3');
  const worth = /const deckWorth = useMemo\([\s\S]*?\n    \[deckCards\]\);/.exec(view)[0];
  assert.match(worth, /Math\.min\(c\.quantity \|\| 0, c\.quantity_available \|\| 0\)/,
    'worth must count available copies, matching the completion ring; '
    + 'counting owned copies double-counts a card lent to another deck');
  assert.ok(!/quantity_owned/.test(worth),
    'quantity_owned is the field that lets two decks claim one card');
  pass('DW-TC3', 'worth counts what this deck can actually use');
}

// DW-TC4: the two totals are shown separately, never summed.
{
  start('DW-TC4');
  assert.match(view, /\$\{formatPrice\(deckWorth\)\}|\$\{?formatPrice\(deckWorth\)/,
    'the worth must be rendered');
  assert.ok(!/deckWorth \+ costToFinish|costToFinish \+ deckWorth/.test(view),
    'the two totals must never be added: one is money he could get, the '
    + 'other money he would spend');
  assert.match(view, /\{counts\.missing > 0 \? t\('deck\.worthOwned'\) : t\('deck\.worth'\)\}/,
    'an incomplete deck must say the figure covers only the cards he has');
  pass('DW-TC4', 'both totals shown, never combined');
}

// DW-TC5: ONE search box filters the deck AND adds cards.
//
// Zach: "can we combine the search with the add because 2 search bars is
// dumb." He was right -- typing a name means "where is this" when the card is
// in the deck and "add this" when it is not, so one `query` drives both.
//
// The risk in merging them is losing the add path silently, so this asserts
// BOTH behaviours still hang off the same state.
{
  start('DW-TC5');
  const shown = /const shown = useMemo\([\s\S]*?\n  \}, \[tab, deckCards, considering, query\]\);/.exec(view);
  assert.ok(shown, 'the filtered list could not be found, or it no longer reads `query`');
  assert.match(shown[0], /const byTab = \(\(\) => \{/,
    'the tab filter must run first');
  assert.match(shown[0], /return byTab\.filter\(c =>/,
    "the search must narrow the TAB's cards, not all cards -- searching "
    + 'inside Missing must stay inside Missing');

  // Exactly ONE search input on this screen.
  const inputs = (view.match(/placeholder=\{t\('deck\.(searchOrAdd|addCardPlaceholder|searchDeck)'\)\}/g) || []);
  assert.strictEqual(inputs.length, 1,
    `${inputs.length} search boxes found; there must be exactly one`);

  // And the add path still exists behind that same box.
  assert.match(view, /\/api\/search\?name=\$\{encodeURIComponent\(q\)\}/,
    'merging the boxes must not drop the catalogue lookup that adds cards');
  pass('DW-TC5', 'one box filters the deck and still adds cards');
}

// DW-TC6: an empty search result does not read as an empty deck.
{
  start('DW-TC6');
  // The empty state now has THREE cases, not two: no match at all, and a
  // match that is simply on another tab (PANE-TC8 owns that distinction).
  // What this case still guards is that an active search never falls through
  // to "no cards in this deck", which reads as data loss.
  assert.match(view, /\{query\.trim\(\)\n\s*\? \(deckHasMatch \? t\('deck\.matchOnAnotherTab'\) : t\('deck\.noCardsMatch'\)\)/,
    'a search matching nothing must say so; "no cards in this deck" while a '
    + 'filter is active reads as data loss');
  for (const k of ['deck.worth', 'deck.worthOwned', 'deck.searchOrAdd',
                   'deck.noCardsMatch']) {
    assert.ok(k in en,
      `${k} has no string; this app renders the KEY when one is missing, so `
      + `the screen would show "${k}"`);
  }
  pass('DW-TC6', 'empty results are explained and every string exists');
}

console.log(`\ndeckWorth.test.js: ${passed} cases passed`);
