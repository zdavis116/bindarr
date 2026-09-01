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
import { readFileSync } from 'node:fs';
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
  const sql = route.slice(route.indexOf('AS owned_cards') - 1400,
                          route.indexOf('AS owned_cards'));
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
