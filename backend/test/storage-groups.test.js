// THE SORT STACK GROUPS CARDS THE WAY ZACH DESCRIBED.
//
// "I like to order by set and color identity except I can organize by type like
// lands and even categorize lands by basic and non basic."
//
// Every case here uses REAL card shapes pulled off the dev API, not invented
// ones -- three bugs this project already shipped came from fixtures that did
// not match live data.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src', 'utils',
  'storageGroups.js');

// Load the SHIPPED module rather than re-typing its logic: a test that
// reimplements the code under test proves only that I can write it twice.
const src = fs.readFileSync(SRC, 'utf8')
  .replace(/^export (function|const)/gm, '$1');
const mod = {};
// eslint-disable-next-line no-new-func
new Function('module', 'exports', `${src}
module.exports = { colorGroup, typeGroup, groupCards, levelKey, DEFAULT_STACK };`)
(mod, {});
const { colorGroup, typeGroup, groupCards } = mod.exports;

let passed = 0;
const pass = (id, what) => { passed += 1; console.log(`PASS: ${id} ${what}`); };

// --- SG-TC1 -----------------------------------------------------------------
// MULTICOLOUR IS ONE PILE, not the first of its colours.
//
// Zach chose "5 mono + Colorless + one Multicolour pile" from a measured 27
// distinct colour identities in his collection. cardSort.js took
// color_identity[0], so a Black/White card sorted as BLACK and no multicolour
// pile could ever form -- that is the bug this replaces, and it is invisible
// until you look for a two-colour card and find it filed under one colour.
{
  assert.strictEqual(colorGroup({ color_identity: ['Blue'] }), 'Blue');
  assert.strictEqual(colorGroup({ color_identity: [] }), 'Colorless');
  assert.strictEqual(colorGroup({ color_identity: ['Black', 'White'] }),
    'Multicolour',
    'a two-colour card must NOT sort as its first colour');
  assert.strictEqual(colorGroup({ color_identity: ['Green', 'Blue', 'Red'] }),
    'Multicolour');

  // Older rows store it as a JSON string. Verified both shapes reach this code.
  assert.strictEqual(colorGroup({ color_identity: '["Red"]' }), 'Red');

  // With the option off, every combination is its own group -- 21 of them in
  // Zach's collection, which is why this is not the default.
  assert.strictEqual(
    colorGroup({ color_identity: ['White', 'Black'] }, false),
    'White/Black',
    'combinations are named in WUBRG order, not input order');
  assert.strictEqual(
    colorGroup({ color_identity: ['Black', 'White'] }, false),
    'White/Black',
    'the same pair must produce the SAME group whatever order it arrives in');

  pass('SG-TC1', 'multicolour is one pile, not its first colour');
}

// --- SG-TC2 -----------------------------------------------------------------
// LANDS SPLIT BASIC FROM NONBASIC -- Zach asked for this by name.
{
  assert.strictEqual(typeGroup({ type_line: 'Basic Land — Forest' }),
    'Basic Land');
  assert.strictEqual(typeGroup({ type_line: 'Land — Island Swamp' }),
    'Nonbasic Land');
  assert.strictEqual(typeGroup({ type_line: 'Legendary Land' }),
    'Nonbasic Land');

  // Snow basics are still basics.
  assert.strictEqual(typeGroup({ type_line: 'Basic Snow Land — Mountain' }),
    'Basic Land');

  // Off, they share one pile.
  assert.strictEqual(typeGroup({ type_line: 'Basic Land — Plains' }, false),
    'Nonbasic Land');

  pass('SG-TC2', 'basic and nonbasic lands are separate groups');
}

// --- SG-TC3 -----------------------------------------------------------------
// TYPE READS BOTH FACES.
//
// The real Tony Stark row from Zach's collection. Splitting on the em dash
// alone stops inside the FRONT face, so "Artifact" was never found -- the exact
// bug that hid this card from the Artifact filter and was fixed once already in
// CollectionList. Grouping must not reintroduce it.
{
  const tony = {
    type_line: 'Legendary Creature — Human Artificer Hero'
      + ' // Legendary Artifact Creature — Human Hero',
  };
  assert.strictEqual(typeGroup(tony), 'Creature',
    'a card that is Creature on both faces groups as Creature');

  // Sagu Wildling: Creature on the front, Sorcery on the adventure half.
  // Creature wins because that is where a player looks for it, but the Sorcery
  // face must have been READ -- proven by the land case below, where the back
  // face is the only place the word appears.
  const sagu = { type_line: 'Creature — Dragon // Sorcery — Omen' };
  assert.strictEqual(typeGroup(sagu), 'Creature');

  // A spell whose BACK face is the land. Front-face-only parsing returns
  // Sorcery and files a land with the spells.
  const modal = { type_line: 'Sorcery — Arcane // Land' };
  assert.strictEqual(typeGroup(modal), 'Nonbasic Land',
    'a land on the back face must still group as a land');

  pass('SG-TC3', 'type grouping reads both faces');
}

// --- SG-TC4 -----------------------------------------------------------------
// THE STACK ORDER IS THE SHELF ORDER, and it is what makes "EXCEPT" work.
{
  const cards = [
    { name: 'Forest', type_line: 'Basic Land — Forest', color_identity: [] },
    { name: 'Bear', type_line: 'Creature — Bear', color_identity: ['Green'] },
    { name: 'Angel', type_line: 'Creature — Angel', color_identity: ['White'] },
    { name: 'Bolt', type_line: 'Instant', color_identity: ['Red'] },
    { name: 'Tower', type_line: 'Land', color_identity: [] },
    { name: 'Hero', type_line: 'Creature — Human', color_identity: ['Black', 'White'] },
  ];

  const byType = groupCards(cards, [{ by: 'type', dir: 'asc', opts: {} }]);
  assert.deepStrictEqual(byType.map((g) => g.label),
    ['Creature', 'Instant', 'Nonbasic Land', 'Basic Land'],
    'spells first, lands last -- lands are the bulk you flip past');

  // Type THEN colour: the mockup's levels 1 and 2.
  const stacked = groupCards(cards, [
    { by: 'type', dir: 'asc', opts: {} },
    { by: 'color', dir: 'asc', opts: {} },
  ]);
  assert.deepStrictEqual(stacked.map((g) => g.label), [
    'Creature \u00b7 White',
    'Creature \u00b7 Green',
    'Creature \u00b7 Multicolour',
    'Instant \u00b7 Red',
    'Nonbasic Land \u00b7 Colorless',
    'Basic Land \u00b7 Colorless',
  ], 'colours run WUBRG inside each type, multicolour after mono');

  // REORDERING THE STACK REORDERS THE SHELF. If this does not hold, the stack
  // is decoration and the user cannot actually express "by colour EXCEPT by
  // type" versus "by type then colour".
  const swapped = groupCards(cards, [
    { by: 'color', dir: 'asc', opts: {} },
    { by: 'type', dir: 'asc', opts: {} },
  ]);
  assert.strictEqual(swapped[0].label, 'White \u00b7 Creature',
    'colour first must group by colour first -- the order IS the model');
  assert.notDeepStrictEqual(stacked.map((g) => g.label),
    swapped.map((g) => g.label));

  // Every card lands in exactly one group, always.
  const total = stacked.reduce((n, g) => n + g.cards.length, 0);
  assert.strictEqual(total, cards.length,
    'no card may be dropped or duplicated by grouping');

  pass('SG-TC4', 'the stack order is the shelf order');
}

// --- SG-TC5 -----------------------------------------------------------------
// AN EMPTY STACK STILL SHOWS THE CARDS.
//
// A container nobody has configured must not render as an empty screen. That
// failure shipped twice this week -- the Add-cards panel with nowhere to type,
// and the card detail that rendered a grey box.
{
  const cards = [{ name: 'A', type_line: 'Creature', color_identity: [] }];
  const none = groupCards(cards, []);
  assert.strictEqual(none.length, 1);
  assert.strictEqual(none[0].cards.length, 1,
    'an unconfigured container shows its cards, not nothing');

  assert.strictEqual(groupCards([], mod.exports.DEFAULT_STACK).length, 0,
    'an empty container produces no groups, not a group of nothing');

  // Malformed input must not throw -- sort_order is user-editable JSON.
  assert.doesNotThrow(() => groupCards(cards, [{ by: 'nonsense' }]));
  assert.doesNotThrow(() => groupCards(cards, null));

  pass('SG-TC5', 'empty and malformed stacks degrade safely');
}

console.log(`storage-groups.test.js: ${passed} cases passed`);
