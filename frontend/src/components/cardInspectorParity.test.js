// THE IMPLEMENTATION MUST CARRY WHAT THE MOCKUP DRAWS.
//
// Zach, twice: "none of these tabs are implemented", then "once again yours
// and deck tabs dont look fully like the mock up".
//
// Both times I had checked the code and believed it matched. The gap is that I
// cannot see the rendered screen, so "looks like the mockup" was my judgement
// about source I had just written -- which is worth nothing.
//
// This compares the two files MECHANICALLY: every section header and status
// label the mockup draws must exist in the component. It cannot prove the
// layout is right, but it makes "I forgot a whole section" impossible, which
// is what actually happened twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const impl = readFileSync(join(here, 'CardInspectorModal.jsx'), 'utf8');
const en = JSON.parse(readFileSync(join(here, '../locales/en.json'), 'utf8'));

// Resolve a t() key to the English string, so the test compares what the USER
// reads rather than an identifier.
const says = (key) => en[key];

test('CIP-TC1: every section header the mockup draws exists', () => {
  // Measured against sketches/010b-card-detail-tabs: THIS PRINTING, OTHER
  // PRINTINGS, IN YOUR DECKS, AVAILABILITY. Three of these were missing when
  // Zach sent his second screenshot.
  const required = {
    'inspector.thisPrinting': 'This printing',
    'inspector.otherPrintings': 'Other printings',
    'inspector.inYourDecks': 'In your decks',
    'inspector.availability': 'Availability',
  };
  for (const [key, text] of Object.entries(required)) {
    assert.equal(says(key), text, `${key} must read "${text}"`);
    assert.ok(impl.includes(key), `the component must render ${key}`);
  }
});

test('CIP-TC2: a deck row states whether the requirement is met', () => {
  // The mockup shows "Covered" in green for a real requirement and
  // "Considering" in muted for a shopping note. Only the second existed.
  assert.equal(says('inspector.covered'), 'Covered');
  assert.equal(says('inspector.considering'), 'Considering');
  assert.match(impl, /d\.board === 'considering'[\s\S]{0,400}inspector\.covered/,
    'the row must choose between Considering and Covered');
});

test('CIP-TC3: the other-printings list says you own none of them', () => {
  // The mockup states it rather than leaving him to infer it from an absence.
  assert.equal(says('inspector.ownNoneOfThese'), 'you own none of these');
  assert.ok(impl.includes('inspector.ownNoneOfThese'));
});

test('CIP-TC4: the decks fetch cannot cancel itself', () => {
  // Zach: "deck tab doesnt work at all just says loading".
  //
  // The effect listed deckUseLoading as a dependency AND set it, so setting
  // the flag re-ran the effect, the previous run's cleanup set cancelled =
  // true, and the arriving response was discarded by a closure that no longer
  // trusted itself. setDeckUse was never called; the spinner was permanent.
  const eff = impl.slice(impl.indexOf('const deckFetchFor'),
                         impl.indexOf('const deckFetchFor') + 1400);
  assert.ok(eff.includes('deckFetchFor'),
    'the in-flight guard must be a ref, not render state');
  assert.doesNotMatch(eff, /\}, \[[^\]]*deckUseLoading[^\]]*\]\)/,
    'deckUseLoading must NOT be a dependency of the effect that sets it');
});

test('CIP-TC5: the in-flight guard resets when the card changes', () => {
  // Otherwise the second card opened never fetches, and the bug comes back
  // wearing a different hat.
  assert.match(impl, /deckFetchFor\.current = null/,
    'the guard must clear when a different card is shown');
});

// --- CIP-TC6: THE CATALOGUE LOOKUP USES THE CATALOGUE ID -------------------
//
// Zach, with three screenshots: "THESE ARE STILL NOT RIGHT NOTHING CHANGED".
//
// The Decks tab rendered EMPTY -- not loading, empty -- and the Yours tab lost
// its other-printings block. One cause for both.
//
// Opened from the collection, the modal receives a row where:
//     id       is undefined
//     entry_id is the COLLECTION row id      (206)
//     card_id  is the card_cache id          (4cea42fd-...)
//
// I fetched /api/card/${card.id}/decks. Measured against the running server:
//     /api/card/206/decks       -> HTTP 404
//     /api/card/4cea42fd.../decks -> HTTP 200, 2 decks, 4 printings
//
// A 404 makes the fetch resolve to null, so deckUse stayed null forever. Null
// is not "loading" and not an error -- it is absent, which is why the tab
// showed nothing at all rather than a spinner or a message.
//
// The component already knew these were different: line 56 reads
// `card?.entry_id || card?.id` for exactly this reason. I ignored it.

test('CIP-TC6: the decks request uses card_id, not the collection entry id', () => {
  // Widened in CIP-TC8 to include desired_card_id for deck entries; this
  // still pins the essential part -- card_id is preferred over the entry id.
  assert.match(impl, /card\?\.card_id \|\|/,
    'the catalogue id must be preferred over the entry id');
  assert.match(impl, /\/api\/card\/\$\{catalogueId\}\/decks/,
    'the request must send the catalogue id');
  assert.doesNotMatch(impl, /\/api\/card\/\$\{card\.id\}\/decks/,
    'sending card.id returns 404 for any card opened from the collection');
});

test('CIP-TC7: an unfiled card still shows a Location row', () => {
  // The mockup draws Location reading "Not filed yet". Dropping the row when
  // location_name is null says nothing at all, and "no row" and "not filed"
  // are different statements -- Zach's copy is unfiled, which is precisely the
  // case the mockup illustrates.
  assert.equal(en['inspector.notFiled'], 'Not filed yet');
  assert.match(impl, /card\.location_name \|\| t\('inspector\.notFiled'\)/,
    'location must fall back to "Not filed yet" rather than disappearing');
});

// --- CIP-TC8: THE INSPECTOR READS BOTH SHAPES ------------------------------
//
// Zach: "I was looking at the card detail through the deck view and its all
// messed up but in the collection it does look better."
//
// Same component, two callers, two different row shapes. Measured against the
// running server:
//
//   field            deck entry             collection row
//   id               618 (deck_cards row)   undefined
//   card_id          undefined              4cea42fd-...
//   desired_card_id  4cea42fd-...           undefined
//   finish           undefined              nonfoil
//   desired_finish   nonfoil                undefined
//   condition        undefined              Near Mint
//
// From a deck the catalogue lookup fell back to id=618 -- a deck_cards row
// number sent to a card_cache endpoint, 404 again, empty Decks tab.

test('CIP-TC8: the catalogue id resolves from either shape', () => {
  assert.match(impl, /card\?\.card_id \|\| card\?\.desired_card_id \|\| card\?\.id/,
    'a deck entry carries desired_card_id; falling straight through to id '
    + 'sends a deck_cards row number to a card_cache lookup');
});

test('CIP-TC9: a deck requirement is not given a condition or a shelf', () => {
  // A deck entry is a REQUIREMENT -- "this deck wants one nonfoil MSH #80" --
  // not a physical card. It has no condition to grade and no location to sit
  // in. Showing "Near Mint" or "Not filed yet" there would be a claim about
  // cardboard that does not exist, which is exactly the wrong-record failure
  // this app exists to prevent.
  assert.match(impl, /card\.entry_id\s*\n?\s*\?\s*\(card\.location_name/,
    'location must only render for a real collection entry');
});
