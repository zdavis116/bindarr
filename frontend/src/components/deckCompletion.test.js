// THE COMPLETION RING MUST COUNT WHAT YOU OWN.
//
// Zach, from the deployed build:
//
//   "it shows 97% complete with only 3 missing cards but actually I am missing
//    97 cards."
//
// Measured on his real data: the Tony Stark deck was 97 cards LISTED against a
// target of 100, so the ring read 97%. He owned THREE of them. He had just
// imported the list, and a listed card was being counted as a card in hand.
//
// This is the wrong-record failure in its purest form: the screen said a deck
// was ready to play while 94 of its cards were not in the binder. A missing
// entry costs a tap; this costs a recount against cardboard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const list = readFileSync(join(here, 'DeckList.jsx'), 'utf8');
const route = readFileSync(join(here, '../../../backend/src/routes/decks.js'), 'utf8');

test('DC-TC1: the ring reads owned_cards, never total_cards', () => {
  assert.match(list, /const have = d\.owned_cards/,
    'completion must be computed from cards OWNED');
  assert.doesNotMatch(list, /const have = d\.total_cards/,
    'total_cards counts what is LISTED -- a fully listed deck can be entirely unowned');
});

test('DC-TC2: the list endpoint actually returns ownership', () => {
  // A ring reading a field the server never sends shows 0% for everything,
  // which is a different lie with the same cause.
  assert.match(route, /AS owned_cards/,
    'GET /api/decks must return owned_cards');
});

test('DC-TC3: ownership uses the same rule as the deck view', () => {
  // deckIdentity.js: exact printing AND finish, collection list only. If the
  // list and the detail view disagree, one of them is lying to Zach and he
  // cannot tell which.
  const sql = route.slice(route.indexOf('AS owned_cards') - 1400,
                          route.indexOf('AS owned_cards'));
  assert.match(sql, /uc\.card_id = dc\.desired_card_id/, 'must match the exact printing');
  assert.match(sql, /uc\.finish = dc\.desired_finish/, 'must match the finish');
  assert.match(sql, /uc\.list_type = 'collection'/, 'wishlist rows are not owned cards');
});

test('DC-TC4: a copy claimed by another deck is not counted twice', () => {
  // Owning one Sol Ring while two decks require it means the second deck is
  // missing one. Without this, both decks report it owned and both look ready.
  const sql = route.slice(route.indexOf('AS owned_cards') - 1400,
                          route.indexOf('AS owned_cards'));
  assert.match(sql, /o\.id < dc\.id/,
    'higher-priority requirements must reserve the copy first');
});

test('DC-TC5: a spare copy cannot push a deck over its requirement', () => {
  // Anchored on the subquery, not a byte offset: the pooling change made this
  // SQL longer and a fixed 1400-char window stopped covering the cap, failing
  // on correct code.
  const start = route.indexOf("COALESCE(SUM(\n          CASE WHEN dc.board != 'considering' THEN");
  const sql = route.slice(start, route.indexOf('AS owned_cards'));
  assert.match(sql, /MIN\(dc\.quantity/,
    'owned is capped at the quantity the deck actually needs');
});

test('DC-TC6: an unknown price is not reported as free', () => {
  // A card with no cached price contributes nothing to the cost. Showing $0.00
  // for a card nobody has priced would understate what a deck costs to finish,
  // which is the number Zach buys against.
  assert.match(list, /deck\.priceUnknown/,
    'the row must be able to say the price is unknown');
});

// --- DC-TC7: NO SCREEN MAY COMPUTE COMPLETION FROM total_cards -------------
//
// Zach, after the DeckList fix shipped: "The dashboard still shows the deck
// list percentage in correctly."
//
// I fixed one reader and never looked for the other. Dashboard.jsx had the
// identical (total_cards / target_size), so the same deck showed 97% there for
// the same reason.
//
// The ownership rule lives in SQL precisely so every screen reads ONE number.
// A per-file fix cannot enforce that; this checks every component instead, so
// the next screen to render a completion figure cannot quietly reintroduce it.

test('DC-TC7: no component divides total_cards by target_size', () => {
  const dir = here;
  const files = readdirSync(dir).filter(f => f.endsWith('.jsx'));
  const offenders = [];

  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    // Strip comments -- discussing the old bug is fine, computing it is not.
    const code = src
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');

    // total_cards appearing anywhere near a division by the target size.
    if (/total_cards[^\n]{0,80}\/[^\n]{0,40}target_size/.test(code)
        || /target_size[^\n]{0,80}total_cards/.test(code)) {
      offenders.push(f);
    }
  }

  assert.deepEqual(offenders, [],
    `these compute completion from cards LISTED rather than cards OWNED: ${offenders.join(', ')}`);
});

test('DC-TC8: the deck list states what the whole deck is worth', () => {
  // Zach: "I wanted the price on the deck list to show the total cost of the
  // deck not just the missing total cost." Both figures come from the
  // endpoint; the value is the headline and the shortfall qualifies it.
  assert.match(route, /AS deck_value/, 'the endpoint must return a deck value');
  // The rendered figure must be formatted FROM the field. Asserting only that
  // the identifier appears somewhere passes even when the displayed number is
  // hardcoded -- verified: this test used to pass with ${(0).toFixed(2)}.
  assert.match(list, /\$\{deck\.deckValue\.toFixed\(2\)\}/,
    'the deck value shown must come from deck_value, not a literal');
  assert.match(list, /deck\.deckValue > 0/,
    'and a deck with no priced cards must not claim to be worth $0.00');
});

// --- DC-TC9: READY TO PLAY MEANS FINISHED ---------------------------------
//
// Zach: "both avatar aang and Hashaton say ready to play when they are 1%
// complete that doesn't make sense."
//
// Both decks hold ONE card and own it. The row computed missing as
// listed - owned = 0 and concluded the deck was ready -- so a deck the ring
// correctly showed at 1% simultaneously claimed to be playable.
//
// "Nothing missing from the list" and "the deck is finished" are different
// claims. Only the second one is Ready to play.

test('DC-TC9: ready-to-play is judged against the target, not the shortfall', () => {
  assert.match(list, /deck\.have >= deck\.target[\s\S]{0,120}readyToPlay/,
    'a deck is ready when its owned cards reach the target size');
  // The old test: missing === 0, which a one-card deck satisfies.
  assert.doesNotMatch(list, /\{missing\s*\?[\s\S]{0,200}readyToPlay/,
    'a deck with nothing missing from a one-card list is not ready to play');
});

test('DC-TC10: the deck row shows ONE dollar figure', () => {
  // Zach: "I didn't want 2 dollar amounts just the total cost that's it."
  const row = list.slice(list.indexOf('{deck.name}'), list.indexOf('{deck.name}') + 1800);
  const dollars = (row.match(/\$\{/g) || []).length;
  assert.ok(dollars <= 1,
    `the deck row renders ${dollars} dollar figures; it should render one`);
});

test('DC-TC11: the selection bar is just the two actions', () => {
  // Zach: "get rid of all the text that says how many cards just delete and
  // export." A count and a rule explanation stacked above two buttons is not
  // what he asked for; the rule belongs in the export sheet.
  assert.doesNotMatch(list, /deck\.decksSelected/,
    'no selected-deck count in the bar');
  assert.doesNotMatch(list, /deck\.oneCopyPerDeck/,
    'no buylist rule text in the bar');
  assert.match(list, /deck\.delete/, 'delete stays');
  assert.match(list, /deck\.export/, 'export stays');
});
