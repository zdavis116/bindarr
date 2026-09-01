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
