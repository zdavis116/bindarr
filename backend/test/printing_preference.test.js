// BUYING PREFERENCES AND THE ADDRESS THAT MAKES A CART POSSIBLE.
//
// Zach, after seeing the first version: "Printing list is horrible definitely
// needs a better design... It should default to any printing and I pick the
// cards I want exact printing. Also maybe an option to select all for exact
// printing just in case I want all cards to be exact printing."
//
// And on storing his address: "I'm fine with A makes sense."
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import pkg from '../src/manaPoolBuylist.js';
const { CONDITION_IDS } = pkg;

const db = readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
const decks = readFileSync(new URL('../src/routes/decks.js', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../src/routes/settings.js', import.meta.url), 'utf8');
const buylist = readFileSync(new URL('../src/manaPoolBuylist.js', import.meta.url), 'utf8');

test('PREF-TC1: a card defaults to ANY printing, not exact', () => {
  // His instruction. The previous default was the opposite and he corrected it:
  // buying the cheapest printing is the common case, pinning is the exception.
  assert.match(db, /allow_any_printing INTEGER NOT NULL DEFAULT 1,/,
    'new deck cards must default to allowing any printing');
  assert.match(db, /ADD COLUMN allow_any_printing INTEGER NOT NULL DEFAULT 1/,
    'and so must the column added to existing databases');
});

test('PREF-TC2: rows written under the OLD default are corrected exactly once', () => {
  // The column shipped for one afternoon defaulting to 0. Those rows are
  // indistinguishable from a deliberate pin, so they are reset -- but only once,
  // or a later restart would silently unpin every card he had chosen.
  assert.match(db, /anyprinting_default_flipped/,
    'the one-time correction must be guarded by a persisted flag');
  assert.match(db, /UPDATE deck_cards SET allow_any_printing = 1/,
    'and it must actually reset the old rows');
});

test('PREF-TC3: substitution is resolved by Bindarr, never delegated', () => {
  // ORIGINALLY this asserted the cart line sent to Mana Pool used set_code +
  // collector_number rather than card_id, because card_id 409s for every value
  // tested (printing id AND oracle id).
  //
  // There is no cart line any more -- the optimizer integration is gone. The
  // rule survives in a stronger form: Bindarr picks the printing itself, from
  // its own price data, and never asks a marketplace to choose for him.
  assert.match(buylist, /async function chooseCheapestPrintings/,
    'Bindarr must resolve the printing itself');
  assert.ok(!/card_id: card\.card_id/.test(buylist),
    'card_id must never be sent as a substitution instruction');
});

test('PREF-TC4: substitution happens in Bindarr, and is reported', () => {
  // A swap he cannot see is the silent state change he has ruled out -- and with
  // "any printing" as the DEFAULT, a card he never touched can be swapped. The
  // swap list is the safety net.
  assert.match(buylist, /async function chooseCheapestPrintings/,
    'Bindarr picks the cheapest printing itself');
  assert.match(buylist, /substituted_from/,
    'and records what it swapped away from');
  assert.match(decks, /substitutions\.push\(/,
    'and the quote reports every swap to the screen');
});

test('PREF-TC5: the condition floor survives substitution', () => {
  // Swapping to a cheaper printing must not quietly swap to a Damaged copy.
  // chooseCheapestPrinting reads source_prices, which only ever holds LP/NM.
  assert.match(buylist, /sp\.source = 'manapool'/,
    'substitution prices come from the stored LP/NM feed, not a wider search');
  assert.deepEqual(CONDITION_IDS, ['LP', 'NM'],
    'and the floor itself is unchanged');
});

test('PREF-TC6: one call pins or unpins the whole deck', () => {
  // "maybe an option to select all for exact printing". Server-side so a
  // partial sweep cannot leave the deck in a state the screen does not describe.
  assert.match(decks, /router\.patch\('\/:id\/cards\/printing-preference'/,
    'a bulk endpoint must exist');
  assert.match(decks, /UPDATE deck_cards SET allow_any_printing = \? WHERE deck_id = \?/,
    'and it must update the whole deck in one statement');
});

test('PREF-TC7: a partial shipping address is refused, not stored', () => {
  // Storing three of four fields would let the send button look ready and then
  // fail at the marketplace -- after he has already committed to buying.
  assert.match(settings, /INCOMPLETE_ADDRESS/,
    'an incomplete address must be rejected with a named code');
  assert.match(settings, /if \(!line1\) missing\.push\('line1'\)/,
    'and it must say which fields are missing');
});

// PREF-TC8 and PREF-TC9 covered the send-to-cart route and the purchase
// endpoint. Both are deleted -- Mana Pool's "pending order" was a checkout, not
// a cart, and his cart stayed empty. EST-TC2 in buylist_estimate.test.js now
// owns that rule and checks executable code rather than prose.

console.log('printing-preference and shipping guards passed');
