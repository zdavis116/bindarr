// THE CARD DETAIL'S THREE TABS.
//
// Zach reviewed the mockup and set the rules:
//
//   "I want it built but on the card tab remove the add to deck button should
//    only show on the deck tab"
//
//   "that warning should only show if its in the main deck and if we are going
//    to show a card in a deck even if its in considering then we should note
//    that. also can remove the numbers from the tabs seems pointless"
//
// Each tab answers one question -- what the card IS, what you OWN, which decks
// WANT it -- and an action belongs with the context that makes it a decision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'CardInspectorModal.jsx'), 'utf8');
const route = readFileSync(join(here, '../../../backend/src/routes/collection.js'), 'utf8');

test('CIT-TC1: add-to-deck appears ONLY on the Decks tab', () => {
  // Zach: "on the card tab remove the add to deck button should only show on
  // the deck tab." On the Card tab it is an action with no subject; on the
  // Decks tab you can see who already wants the card and how many are free.
  const btn = src.indexOf('<AddToDeckSelect');
  assert.ok(btn > 0, 'the control must still exist');

  // CONTAINMENT, by brace matching. An earlier version of this test searched
  // backwards for the nearest tab guard, which passes even when the button
  // sits in the shared actions row AFTER the decks panel has closed -- the
  // exact arrangement Zach objected to. Verified: that version stayed green
  // when the button was moved back.
  const start = src.indexOf("{tab === 'decks' && (");
  assert.ok(start > 0, 'the decks panel must exist');

  let depth = 0;
  let end = -1;
  for (let k = start; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) { end = k; break; }
    }
  }
  assert.ok(end > start, 'could not find the end of the decks panel');
  assert.ok(btn > start && btn < end,
    'add-to-deck must be INSIDE the decks panel, not in the shared actions row '
    + 'where it renders on every tab');
});

test('CIT-TC2: the shortfall warning ignores considering entries', () => {
  // Zach: "that warning should only show if its in the main deck".
  //
  // The server does the filtering: `reserved` counts only real requirements.
  // The component must not re-derive it from the deck list, because that is
  // how the two copies drift apart -- the failure this branch hit four times.
  assert.match(route, /filter\(r => r\.board !== 'considering'\)[\s\S]{0,120}reduce/,
    'the endpoint must exclude considering entries from `reserved`');
  assert.match(src, /deckUse\.reserved > deckUse\.owned/,
    'the banner must compare the SERVER figures, not a local recount');
  assert.doesNotMatch(src, /decks\.filter[\s\S]{0,80}considering[\s\S]{0,80}reduce/,
    'the component must not recompute the reservation itself');
});

test('CIT-TC3: a considering entry is shown and labelled', () => {
  // Zach: "if we are going to show a card in a deck even if its in considering
  // then we should note that." Shown, and named for what it is -- not flagged
  // as a fault, because considering a card is not a fault.
  assert.match(src, /d\.board === 'considering'[\s\S]{0,220}inspector\.considering/,
    'a considering row must carry a Considering label');
});

test('CIT-TC4: the tabs carry no counts', () => {
  // Zach: "can remove the numbers from the tabs seems pointless".
  const bar = src.slice(src.indexOf("['card', t('inspector.tabCard')"),
                        src.indexOf("['card', t('inspector.tabCard')") + 900);
  assert.doesNotMatch(bar, /\{counts?\.|\bcount\b/,
    'tab labels must be plain words');
});

test('CIT-TC5: each deck row names the printing it wants', () => {
  // The fact that justified the tab: two decks can want DIFFERENT printings of
  // one card at very different prices -- MSH #80 at $6.50 versus MSH #363 at
  // $25.30. A row showing only the deck name hides the thing worth acting on.
  assert.match(src, /inspector\.deckWants/, 'the row states which printing');
  assert.match(src, /d\.set_id[\s\S]{0,60}d\.number/, 'set code and number');
  assert.match(src, /d\.price_trend/, 'and the price of that printing');
});

test('CIT-TC6: the decks endpoint matches on oracle id, not card id', () => {
  // Matching by card id would return only the deck wanting THIS printing and
  // silently hide the other -- which is precisely the information the tab
  // exists to show.
  assert.match(route, /WHERE cc\.oracle_id = \? AND d\.user_id = \?/,
    'decks are found by oracle identity and scoped to the owner');
});

test('CIT-TC7: the card is fetched as soon as a card is shown', () => {
  // THIS TEST USED TO REQUIRE THE OPPOSITE, and the bug it enforced cost Zach
  // four rounds of screenshots.
  //
  // It asserted the request must not fire until the Decks tab is opened -- a
  // performance guard I wrote without noticing that the Card tab is the
  // DEFAULT. With the fetch gated on the tab, `deckUse` was null on first
  // open, so the sheet fell back to the caller's object: fine from the deck
  // view, which carries oracle_text and mana_cost, blank from the collection,
  // which carries neither.
  //
  // The sheet must not look different depending on which screen opened it, and
  // it cannot guarantee that while its data arrives conditionally.
  const i = src.indexOf('const deckFetchFor');
  assert.ok(i > 0, 'the fetch effect must exist');
  const eff = src.slice(i, i + 1400);
  assert.doesNotMatch(eff, /tab !== 'decks'/,
    'gating the fetch on the tab leaves the default tab unmerged');
  assert.match(eff, /if \(!card\) return;/,
    'the card must be fetched whenever a card is shown');
});
