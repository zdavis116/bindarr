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

// Mirrors CollectionList.jsx: every SELECTED type must be present on the card.
// Zach: "if I select artifact and creature it should show me artifact creatures
// not creatures, artifacts and artifact creatures".
const matchesType = (item, filters) =>
  filters.size === 0
    ? true
    : [...filters].every(ty => (item.types || []).includes(ty));

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

test('COLF-TC4: several types means AT LEAST all of them', () => {
  // THE CASE ZACH CORRECTED. Artifact + Creature must show Artifact Creatures
  // only -- not every artifact plus every creature.
  const cards = [
    { name: 'Sol Ring',        types: ['Artifact'] },
    { name: 'Grizzly Bears',   types: ['Creature'] },
    { name: 'Solemn Simulacrum', types: ['Artifact', 'Creature'] },
  ];
  const out = cards.filter(c => matchesType(c, new Set(['Artifact', 'Creature'])))
                   .map(c => c.name);
  assert.deepEqual(out, ['Solemn Simulacrum'],
    'only cards that are BOTH an artifact and a creature');
});

test('COLF-TC4b: one type selected still shows every card of that type', () => {
  const cards = [
    { name: 'Sol Ring',          types: ['Artifact'] },
    { name: 'Solemn Simulacrum', types: ['Artifact', 'Creature'] },
    { name: 'Grizzly Bears',     types: ['Creature'] },
  ];
  const out = cards.filter(c => matchesType(c, new Set(['Artifact']))).map(c => c.name);
  assert.deepEqual(out, ['Sol Ring', 'Solemn Simulacrum'],
    'a lone type must not exclude multi-type cards');
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
  assert.match(src, /typeFilters\.size === 0[\s\S]{0,200}\.every\(/,
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

// THE REAL KEY, imported. This used to be a hand-written mirror of the key in
// CollectionList.jsx, and a mirror is a second implementation: it can stay
// green while the app does something else entirely. Importing the shipped
// function means these cases test the code that runs.
// The .js extension is REQUIRED here even though the components import the
// same file without one: Vite resolves extensionless paths, `node --test` runs
// real Node ESM and does not.
import { collectionGroupKey, isBasicLandTypeLine } from '../utils/basicLands.js';

function group(rows) {
  const out = new Map();
  for (const c of rows) {
    const k = collectionGroupKey(c);
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

test('GRP-TC4: different PRINTINGS of a NON-BASIC card stay separate', () => {
  // Two printings of a real card are two different objects at two different
  // prices, and card_id is the exact printing.
  //
  // This case used to use two Forests, which became exactly wrong when basics
  // started pooling (2026-09-23). The example was changed rather than the
  // rule: the rule is still right, the illustration had just picked the one
  // card type it does not apply to.
  const rows = [
    { card_id: 'solring-c21', type_line: 'Artifact', condition: 'Near Mint', printing: 'Normal', quantity: 1 },
    { card_id: 'solring-cmm', type_line: 'Artifact', condition: 'Near Mint', printing: 'Normal', quantity: 1 },
  ];
  assert.equal(group(rows).length, 2);
});

// --- BASIC LANDS IGNORE PRINTING ENTIRELY --------------------------------
//
// Zach: "For basic lands I want to remove anything about printing from them.
// Like right now basic lands are grouped by set and number in collection...
// I want that all to go away and basic lands to be grouped by type like
// mountain or island and that's it. I don't care about printings at all."
//
// The server already believed this -- ownedQuantity pools basics by name
// (backend/test/basic_land_pool.test.js) -- so before this change the
// COLLECTION SCREEN and the DECK AVAILABILITY figure disagreed about what a
// Mountain was. These cases pin the display side to the side that was already
// right.

test('GRP-TC6: basics from different sets are ONE tile', () => {
  const rows = [
    { card_id: 'mtn-mh2', name: 'Mountain', type_line: 'Basic Land — Mountain', condition: 'Near Mint', printing: 'Normal', quantity: 4 },
    { card_id: 'mtn-lci', name: 'Mountain', type_line: 'Basic Land — Mountain', condition: 'Near Mint', printing: 'Normal', quantity: 7 },
    { card_id: 'mtn-znr', name: 'Mountain', type_line: 'Basic Land — Mountain', condition: 'Played',    printing: 'Foil',   quantity: 2 },
  ];
  const out = group(rows);
  assert.equal(out.length, 1, 'every Mountain is one Mountain');
  // The COUNT is the load-bearing half. A grouping that merged the rows but
  // dropped their quantities would look right on screen and understate what he
  // owns -- the failure he could not see.
  assert.equal(out[0].quantity, 13, 'all 13 copies must survive the merge');
});

test('GRP-TC7: a Mountain and an Island are still two tiles', () => {
  // "Grouped by type like mountain or island" -- pooling by name must not
  // collapse into pooling ALL basics, which would report one meaningless
  // "lands" count.
  const rows = [
    { card_id: 'mtn-mh2', name: 'Mountain', type_line: 'Basic Land — Mountain', quantity: 5 },
    { card_id: 'isl-mh2', name: 'Island',   type_line: 'Basic Land — Island',   quantity: 5 },
  ];
  assert.equal(group(rows).length, 2);
});

test('GRP-TC8: SNOW-COVERED basics do not pool with plain basics', () => {
  // A Snow-Covered Mountain turns on snow permanents a plain Mountain does
  // not, so it is a different card and cannot be substituted for one. The
  // backend draws the line in the same place (BLP-TC4); if these two ever
  // disagree the deck builder will promise a card the collection cannot fill.
  const rows = [
    { card_id: 'mtn-mh2',  name: 'Mountain',              type_line: 'Basic Land — Mountain',      quantity: 5 },
    { card_id: 'snow-mh2', name: 'Snow-Covered Mountain', type_line: 'Basic Snow Land — Mountain', quantity: 5 },
  ];
  assert.equal(group(rows).length, 2);
});

test('GRP-TC8b: the PREFIX itself rejects a snow land', () => {
  // TC8 ABOVE IS VACUOUS ON ITS OWN, and the mutation harness proved it:
  // widening the prefix to accept snow lands leaves TC8 green, because the two
  // rows keep their separate tiles via their different NAMES regardless.
  //
  // So TC8 verifies the OUTCOME through a path that does not depend on the
  // rule, and only this case verifies the rule. The distinction matters
  // because the prefix is also what the inspector and the tile read to decide
  // whether to hide a printing -- and on THAT path a widened prefix would
  // silently strip the set code from every snow land, which is real
  // information about a card whose printing does matter.
  assert.equal(isBasicLandTypeLine('Basic Land — Mountain'), true);
  assert.equal(isBasicLandTypeLine('Basic Snow Land — Mountain'), false,
    'a snow land must NOT satisfy the basic-land rule');
  assert.equal(isBasicLandTypeLine('Land'), false, 'a nonbasic land is not a basic');
  assert.equal(isBasicLandTypeLine('Basic Land — Wastes'), true,
    'Wastes is a basic, and is caught by the type line without being named');
  assert.equal(isBasicLandTypeLine(undefined), false, 'a missing type line is not a basic');
});

test('GRP-TC5: the component uses the SHARED key, not its own copy', () => {
  // Guards the mirror above. The key used to be written inline here and in
  // CollectionList.jsx; it now lives in utils/basicLands.js so that the
  // collection list, the grid tile and the inspector cannot drift into three
  // different definitions of "basic land".
  //
  // Asserts the IMPORT and the CALL, not the key's contents: the contents are
  // tested directly above, and grepping for them here is what made the old
  // version of this case a copy that could pass while the app did something
  // else.
  const src = readFileSync(join(here, 'CollectionList.jsx'), 'utf8');
  assert.match(src, /import\s*\{[^}]*collectionGroupKey[^}]*\}\s*from\s*'\.\.\/utils\/basicLands'/,
    'CollectionList must import the shared grouping key');
  assert.match(src, /const key = collectionGroupKey\(card\)/,
    'and must build its groups with it, not with an inline key');
  assert.doesNotMatch(src, /const key = \[card\.card_id/,
    'the old inline key must be GONE, not merely unused');
});

test('GRP-TC9: no surface prints a set code for a basic land', () => {
  // THE UI BLIND SPOT: the grouping can be perfect while the tile still says
  // "MH2 #250" over a count of Mountains from nine sets -- which is not noise,
  // it is a false statement.
  //
  // FOUR ROUNDS FOR ONE RULE. Each surface was fixed only when Zach reported
  // that specific screen: the deck view first ("I don't actually own 6 of the
  // one msh set"), then the collection list and grid tile, then the inspector
  // HEADER -- which was the worst of them, because it printed a set code
  // directly beside the pooled owned count: "The Lost Caverns of Ixalan • #395
  // • x3 owned" for three Islands from three different sets.
  //
  // So this case enumerates every surface rather than testing the one that was
  // reported. Adding a new card-detail surface without handling basics should
  // fail HERE, not in a fifth screenshot.
  const surfaces = {
    'CollectionList.jsx':     /isBasicLand\(card\)\s*\?\s*''/,
    'CardTile.jsx':           /isBasicLand\(card\)\s*\?\s*''/,
    'DeckView.jsx':           /!isBasicLand\(card\)\s*&&/,
    'CardInspectorModal.jsx': /isBasicLand \? '' : card\.set_name/,
  };
  for (const [file, rule] of Object.entries(surfaces)) {
    const src = readFileSync(join(here, file), 'utf8');
    assert.match(src, rule, `${file} must suppress the printing line for basics`);
    // AND MUST NOT CARRY ITS OWN COPY OF THE RULE. Five inline
    // startsWith('Basic Land') checks are what made this take four rounds:
    // fixing one left the others stating the opposite.
    assert.doesNotMatch(src, /startsWith\('Basic Land'\)/,
      `${file} must use the shared rule, not its own inline copy`);
  }
});

test('GRP-TC10: the inspector header drops the collector number too', () => {
  // The set NAME and the collector NUMBER are two separate renders on that
  // line. Removing only the name would leave "• #395 • Common" -- still a
  // claim about one printing, just a more cryptic one. Zach's screenshot
  // underlined both.
  const src = readFileSync(join(here, 'CardInspectorModal.jsx'), 'utf8');
  assert.match(src, /!isBasicLand && cardNumber \? ` • #\$\{cardNumber\}` : ''/,
    'the collector number must be suppressed for basics as well');
});

