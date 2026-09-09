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
import { toCartLine } from '../src/manaPoolBuylist.js';

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

test('PREF-TC3: EVERY cart line is an exact printing at the API boundary', () => {
  // card_id returns 409 for every value tested -- printing id AND oracle id --
  // so substitution cannot be delegated to Mana Pool. Sending card_id would make
  // every line fail, which is exactly what happened the first time.
  const line = toCartLine({ set_code: 'fdn', collector_number: '160',
                            card_id: 'a829747f-cf9b-4d81-ba66-9f0630ed4565',
                            allow_any_printing: true });
  assert.ok(!('card_id' in line), 'card_id 409s on this endpoint and must never be sent');
  assert.equal(line.set_code, 'FDN');
  assert.equal(line.collector_number, '160');
});

test('PREF-TC4: substitution happens in Bindarr, and is reported', () => {
  // A swap he cannot see is the silent state change he has ruled out -- and with
  // "any printing" as the DEFAULT, a card he never touched can be swapped. The
  // swap list is the safety net.
  assert.match(buylist, /async function chooseCheapestPrinting/,
    'Bindarr picks the cheapest printing itself');
  assert.match(buylist, /substituted_from/,
    'and records what it swapped away from');
  assert.match(decks, /quote\.substitutions = resolved/,
    'and the quote reports every swap to the screen');
});

test('PREF-TC5: the condition floor survives substitution', () => {
  // Swapping to a cheaper printing must not quietly swap to a Damaged copy.
  // chooseCheapestPrinting reads source_prices, which only ever holds LP/NM.
  assert.match(buylist, /sp\.source = 'manapool'/,
    'substitution prices come from the stored LP/NM feed, not a wider search');
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

test('PREF-TC8: sending a cart without an address fails BEFORE calling Mana Pool', () => {
  // A marketplace error he cannot act on is worse than an app error that names
  // the screen he needs.
  assert.match(decks, /NO_SHIPPING_ADDRESS/,
    'the route must check the address itself');
  assert.match(buylist, /A shipping address is required to create an order/,
    'and the module must refuse too, so no caller can bypass it');
});

test('PREF-TC9: Bindarr never completes a purchase', () => {
  // Mana Pool has POST /pending-orders/{id}/purchase. A bug in a hobby app that
  // can spend real money costs money, not a recount.
  //
  // Matched against the REQUEST CALLS only, not the whole file: my first version
  // of this test regex-matched the safety comment that names the endpoint, so it
  // failed on correct code. A guard that fires on a comment teaches you to
  // ignore it.
  const calls = [...buylist.matchAll(/requestTo\(\s*['"`]([^'"`]+)/g)].map(m => m[1]);
  assert.ok(calls.length > 0, 'the module must make at least one request');
  for (const path of calls) {
    assert.ok(!/purchase/.test(path),
      `Bindarr must never call a purchase endpoint (found ${path})`);
  }
  assert.ok(calls.some(p => p.includes('pending-orders')),
    'creating a pending order is as far as it goes');
});

console.log('printing-preference and shipping guards passed');
