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

// --- GROUPING ------------------------------------------------------------
//
// Zach: "why are the cards not grouped. Like I have 2 avatar aangs but they
// separate makes no sense."
//
// Measured on his dev data: Avatar Aang was FIVE collection rows, all Near
// Mint, all Normal printing. The scanner writes a row per scan, so a stack of
// five identical cards became five tiles.
//
// The risk in grouping is the opposite error: merging copies that are NOT the
// same object. A foil is worth several times a non-foil; a Played copy is worth
// less than a Near Mint one. Collapsing those into one count would misreport
// what he owns, which is the "wrong record" failure that matters most here.

// Mirrors the grouping key in CollectionList.jsx.
const groupKey = (c) => [c.card_id, c.condition || '', c.printing || ''].join('|');

function group(rows) {
  const out = new Map();
  for (const c of rows) {
    const k = groupKey(c);
    const seen = out.get(k);
    if (seen) seen.quantity += (c.quantity || 1);
    else out.set(k, { ...c, quantity: c.quantity || 1 });
  }
  return [...out.values()];
}

test('GRP-TC1: identical copies collapse into one tile with a count', () => {
  const rows = [
    { card_id: 'aang', condition: 'Near Mint', printing: 'Normal', quantity: 1 },
    { card_id: 'aang', condition: 'Near Mint', printing: 'Normal', quantity: 1 },
    { card_id: 'aang', condition: 'Near Mint', printing: 'Normal', quantity: 1 },
  ];
  const out = group(rows);
  assert.equal(out.length, 1, 'three identical rows are one card');
  assert.equal(out[0].quantity, 3, 'the count must be preserved, not lost');
});

test('GRP-TC2: a FOIL copy is NOT merged with a non-foil', () => {
  // The load-bearing case. A foil Avatar Aang is a different object worth a
  // different amount; merging it into "x2 Avatar Aang" would misreport the
  // collection and its value.
  const rows = [
    { card_id: 'aang', condition: 'Near Mint', printing: 'Normal', quantity: 1 },
    { card_id: 'aang', condition: 'Near Mint', printing: 'Foil', quantity: 1 },
  ];
  assert.equal(group(rows).length, 2, 'foil and non-foil stay separate');
});

test('GRP-TC3: a different CONDITION is not merged', () => {
  const rows = [
    { card_id: 'aang', condition: 'Near Mint', printing: 'Normal', quantity: 1 },
    { card_id: 'aang', condition: 'Played', printing: 'Normal', quantity: 1 },
  ];
  assert.equal(group(rows).length, 2, 'Near Mint and Played are different copies');
});

test('GRP-TC4: different PRINTINGS of the same card stay separate', () => {
  // Two Forests from different sets are different cards to a collector, and
  // card_id is the exact printing.
  const rows = [
    { card_id: 'forest-msh', condition: 'Near Mint', printing: 'Normal', quantity: 1 },
    { card_id: 'forest-lci', condition: 'Near Mint', printing: 'Normal', quantity: 1 },
  ];
  assert.equal(group(rows).length, 2);
});

test('GRP-TC5: the component still groups on printing AND condition AND finish', () => {
  // Guards the mirror above. If the key is narrowed to card_id alone, foils and
  // damaged copies would silently merge and these cases would keep passing
  // against logic the app no longer runs.
  const src = readFileSync(join(here, 'CollectionList.jsx'), 'utf8');
  assert.match(src, /card\.card_id, card\.condition[^\n]*card\.printing/,
    'the grouping key must include condition and printing, not just card_id');
});
