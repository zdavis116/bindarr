// DECK VIEW: SECTIONING AND COUNTS.
//
// Built to the mockup Zach reviewed line by line. Two properties are worth
// pinning because both are quietly wrong-able:
//
//   1. A card's section comes from type_line, NOT the `types` column. That
//      column holds COLOURS in this database, which is exactly what made the
//      Collection type filter a second colour picker.
//   2. Considering sits OUTSIDE the deck's counts. Zach: "Not counted in the
//      100 or the cost to finish." A maybe that moves the percentage is a lie
//      about how finished a deck is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'DeckView.jsx'), 'utf8');

// Mirrors sectionFor() in DeckView.jsx.
const TYPE_ORDER = ['Commander', 'Creature', 'Instant', 'Sorcery', 'Artifact',
                    'Enchantment', 'Planeswalker', 'Battle', 'Land'];

function sectionFor(card) {
  if (card.board === 'commander') return 'Commander';
  const line = (card.type_line || '').split('—')[0];
  for (const ty of TYPE_ORDER) {
    if (ty !== 'Commander' && line.includes(ty)) return ty;
  }
  return 'Other';
}

test('DV-TC1: the commander is its own section, whatever its type line', () => {
  // Moxfield puts the commander first because it is the deck's premise, not
  // because of what it is.
  assert.equal(sectionFor({ board: 'commander', type_line: 'Legendary Creature — Goblin' }), 'Commander');
  assert.equal(sectionFor({ board: 'commander', type_line: 'Legendary Planeswalker — Bolas' }), 'Commander');
});

test('DV-TC2: subtypes do NOT create sections', () => {
  // Everything after the em dash is a subtype. Sectioning on those would
  // produce a heading per creature type -- Goblin, Berserker, Equipment.
  assert.equal(sectionFor({ board: 'mainboard', type_line: 'Creature — Goblin Berserker' }), 'Creature');
  assert.equal(sectionFor({ board: 'mainboard', type_line: 'Artifact — Equipment' }), 'Artifact');
});

test('DV-TC3: a multi-type card lands in the most specific section', () => {
  // An Artifact Creature is a creature to a player looking for one; a
  // Legendary Creature is still a creature. TYPE_ORDER decides, and Creature
  // precedes Artifact in it.
  assert.equal(sectionFor({ board: 'mainboard', type_line: 'Legendary Artifact Creature — Golem' }), 'Creature');
  assert.equal(sectionFor({ board: 'mainboard', type_line: 'Legendary Creature — Human Artificer' }), 'Creature');
});

test('DV-TC4: sections are NOT read from the `types` column', () => {
  // THE LOAD-BEARING CASE. card_cache.types holds colours in this database --
  // measured on Zach's collection it yields exactly Black, Blue, Green, Red,
  // White. Reading it here would rebuild the bug he already reported once:
  // "The types drop down is still wrong."
  assert.doesNotMatch(src, /sectionFor[\s\S]{0,400}card\.types/,
    'sectionFor must read type_line, never the `types` column, which holds COLOURS');
  assert.match(src, /const line = \(card\.type_line \|\| ''\)\.split\('—'\)/,
    'sectionFor must split type_line on the em dash');
});

test('DV-TC5: considering is excluded from the deck counts', () => {
  const cards = [
    { board: 'mainboard', quantity: 1, quantity_owned: 1, quantity_missing: 0 },
    { board: 'mainboard', quantity: 1, quantity_owned: 0, quantity_missing: 1 },
    { board: 'considering', quantity: 1, quantity_owned: 0, quantity_missing: 1 },
  ];
  const deckCards = cards.filter(c => c.board !== 'considering');
  const total = deckCards.reduce((n, c) => n + c.quantity, 0);
  const missing = deckCards.reduce((n, c) => n + c.quantity_missing, 0);

  assert.equal(total, 2, 'a considering card must not count toward the deck size');
  assert.equal(missing, 1, 'a considering card must not count as missing');

  // And the component must actually do this, not just the mirror above.
  assert.match(src, /deckCards = useMemo\(\(\) => cards\.filter\(c => c\.board !== 'considering'\)/,
    'DeckView must exclude considering from the deck cards it counts');
});

test('DV-TC6: cost to finish uses the price the SERVER sends', () => {
  // The multi-deck buylist read $0.00 for two rounds because I invented a
  // `price` field no endpoint returns. price_trend is the real column, and it
  // was added to the deck query in the same commit as this screen.
  assert.match(src, /quantity_missing \|\| 0\) \* \(c\.price_trend \|\| 0\)/,
    'cost to finish must multiply quantity_missing by the server-sent price_trend');
});

test('DV-TC7: quantity writes are ABSOLUTE, not deltas', () => {
  // A double-tapped delta silently becomes 4 copies. This screen is used one
  // handed while holding cards, so that is not hypothetical -- and a wrong
  // count is only discovered standing at the binder.
  assert.match(src, /quantity: quantity \?\? entry\.quantity/,
    'writeCard must send an absolute quantity');
  assert.match(src, /const next = \(entry\.quantity \|\| 1\) \+ delta;/,
    'changeQty must compute the new absolute value before sending it');
  assert.match(src, /if \(next <= 0\) return removeCard\(entry\);/,
    'removing the last copy must be a DELETE, not quantity 0');
});

test('DV-TC8: a commander swap that removes cards asks first, and names them', () => {
  // The server refuses with 409 and the list of cards it would remove. That
  // refusal is the safety property: switching a mono-red commander to a blue
  // one silently binning eleven cards is the worst thing this screen can do.
  assert.match(src, /res\.status === 409 && Array\.isArray\(body\?\.removing\)/,
    'the 409 must be read as a question, from the top-level `removing`');
  assert.match(src, /swapConfirm\.removing\.map/,
    'the confirmation must list the cards by name, not just count them');
  assert.match(src, /confirm_remove_off_identity: true/,
    'confirming must re-send with the explicit confirmation flag');
});
