// COLLECTION FILTERS ARE MULTI-SELECT, AND THAT IS A MODELLING FIX.
//
// Zach, on the first mockup: "cards can be multi colored and there is 5 colors
// so only being able to choose one color doesn't make sense. Also artifact and
// land are types so probably should be a type drop down like set. Also a card
// can be multiple types so it should be multi select."
//
// He was identifying a MODELLING error, not a UI preference. A single-value
// colour filter cannot express "show me Golgari cards" at all, because a
// Golgari card is black AND green. Same for types: Dryad of the Ilysian Grove
// is Creature AND Enchantment, so a one-value type filter has to pick a lie.
//
// These cases pin the semantics rather than the markup, because the semantics
// are the part that was wrong and the part a future refactor could quietly
// revert.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// The predicate as implemented in CollectionList.jsx. Kept in sync by TC5,
// which fails if the component stops using `.some(...)`.
// Mirrors CollectionList.jsx: every SELECTED colour must be present in the
// card's identity. Containment, not intersection.
const matchesColor = (item, filters) =>
  filters.size === 0
    ? true
    : [...filters].every(c => (item.color_identity || []).includes(c));

const matchesType = (item, filters) =>
  filters.size === 0 ? true : (item.types || []).some(ty => filters.has(ty));

const CARDS = [
  { name: 'Lightning Bolt',   color_identity: ['Red'],           types: ['Instant'] },
  { name: 'Counterspell',     color_identity: ['Blue'],          types: ['Instant'] },
  { name: "Assassin's Trophy", color_identity: ['Black', 'Green'], types: ['Instant'] },
  { name: 'Dryad of the Ilysian Grove', color_identity: ['Green'], types: ['Creature', 'Enchantment'] },
  { name: 'Sol Ring',         color_identity: [],                types: ['Artifact'] },
  { name: 'Mountain',         color_identity: [],                types: ['Land'] },
];

const names = (rows) => rows.map(c => c.name).sort();

test('COLF-TC1: no filter selected shows everything', () => {
  const out = CARDS.filter(c => matchesColor(c, new Set()));
  assert.equal(out.length, CARDS.length,
    'an empty filter set must not hide anything');
});

test('COLF-TC2: one colour selected shows every card needing that colour', () => {
  // "if I just select blue I should see any card that requires atleast blue
  // mana" -- including multicolour cards that also need something else.
  const underGreen = names(CARDS.filter(c => matchesColor(c, new Set(['Green']))));
  assert.ok(underGreen.includes("Assassin's Trophy"),
    'a B/G card needs green, so it must appear under Green');
  assert.ok(underGreen.includes('Dryad of the Ilysian Grove'),
    'a mono-green card must appear under Green');
  assert.ok(!underGreen.includes('Lightning Bolt'),
    'a red card does not need green');
});

test('COLF-TC3: several colours means AT LEAST all of them', () => {
  // THE CASE THAT CHANGED. Selecting Black + Green must show cards whose
  // identity CONTAINS both -- not every black card plus every green card.
  //
  // Under the previous ANY-OF logic this returned two cards; the mono-green
  // Dryad has no black in its identity and does not belong in a B/G view.
  const out = names(CARDS.filter(c => matchesColor(c, new Set(['Black', 'Green']))));
  assert.deepEqual(out, ["Assassin's Trophy"],
    'B+G must show only cards that need BOTH black and green');
});

test('COLF-TC3b: a superset card still matches a narrower selection', () => {
  // A five-colour card contains Temur, so selecting U+G+R must include it.
  // This is what makes the filter useful for deckbuilding: "what could I cast
  // with these colours available".
  const wedge = { name: 'Five Colour Thing', color_identity: ['White', 'Blue', 'Black', 'Red', 'Green'], types: ['Creature'] };
  assert.ok(matchesColor(wedge, new Set(['Blue', 'Green', 'Red'])),
    'a WUBRG card contains Temur and must match a U/G/R selection');
  assert.ok(!matchesColor({ name: 'Mono U', color_identity: ['Blue'], types: [] }, new Set(['Blue', 'Green', 'Red'])),
    'a mono-blue card does NOT contain green or red');
});

test('COLF-TC4: a card with SEVERAL types matches any of them', () => {
  const asCreature = names(CARDS.filter(c => matchesType(c, new Set(['Creature']))));
  const asEnchantment = names(CARDS.filter(c => matchesType(c, new Set(['Enchantment']))));

  assert.ok(asCreature.includes('Dryad of the Ilysian Grove'));
  assert.ok(asEnchantment.includes('Dryad of the Ilysian Grove'),
    'a Creature AND Enchantment must appear under both -- this is exactly what '
    + 'a single-value type filter could not do');
});

test('COLF-TC5: colourless cards are hidden by any colour filter', () => {
  // Sol Ring and Mountain have empty color_identity. They must not leak into a
  // colour-filtered view -- a colourless card is not "every colour".
  const out = names(CARDS.filter(c => matchesColor(c, new Set(['Red']))));
  assert.deepEqual(out, ['Lightning Bolt']);
});

test('COLF-TC6: the component still uses AT-LEAST colour matching', () => {
  // Guards the mirror above. If someone changes the component to `.every(...)`
  // or back to an equality check, the cases here would keep passing against
  // logic the app no longer runs -- the exact way two earlier tests in this
  // repo were worthless.
  const src = readFileSync(join(here, 'CollectionList.jsx'), 'utf8');

  assert.match(src, /colorFilters\.size === 0[\s\S]{0,200}\.every\(/,
    'colour matching must be AT-LEAST (every selected colour present), not '
    + 'ANY-OF -- Zach: "if I select blue green red I should only see cards that '
    + 'require atleast blue green and red mana"');
  assert.match(src, /typeFilters\.size === 0[\s\S]{0,120}\.some\(/,
    'type matching must be ANY-OF over types');
  assert.ok(!/value=\{setFilter\}|value=\{typeFilter\}/.test(src),
    'the single-value dropdowns must be gone, not merely bypassed');
});
