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
// The search-result rows moved into the shared CardSearchResult when Zach
// asked for every single-card search to behave the same. Assertions about
// what a RESULT ROW shows must read that file; assertions about the deck
// screen itself still read DeckView.
const searchRow = readFileSync(join(here, 'CardSearchResult.jsx'), 'utf8');

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

// --- AVAILABILITY, NOT OWNERSHIP -----------------------------------------
//
// Zach: "if I add Tony stark to that deck he shows in both owned and missing
// but for that deck he would be missing because his other copy is used in
// another deck."
//
// He owns one Tony Stark. Another deck has it. So for THIS deck:
//   quantity_owned     = 1   (he has one, somewhere)
//   quantity_available = 0   (none free -- the other deck holds it)
//   quantity_missing   = 1   (he must buy one to finish this deck)
//
// Testing Owned with quantity_owned put him in BOTH tabs and counted him as
// done in the progress ring. The deck said it was ready while the card sat in
// a box across the room -- the wrong-record failure, not a cosmetic one.

test('DV-TC9: owned and missing are complementary, never both', () => {
  const tony = { quantity: 1, quantity_owned: 1, quantity_available: 0, quantity_missing: 1 };
  const sol  = { quantity: 1, quantity_owned: 1, quantity_available: 1, quantity_missing: 0 };
  const cards = [tony, sol];

  const have = cards.filter(c => (c.quantity_missing || 0) === 0);
  const need = cards.filter(c => (c.quantity_missing || 0) > 0);

  assert.equal(have.length, 1, 'only the genuinely usable card is Owned');
  assert.equal(need.length, 1, 'the reserved-elsewhere card is Missing');
  assert.equal(have.length + need.length, cards.length,
    'every card must land in exactly one of the two tabs');
  assert.ok(!have.includes(tony), 'a card held by another deck must NOT read as Owned here');

  // And the component must use the missing test, not an ownership test.
  assert.match(src, /tab === 'have'\) return deckCards\.filter\(c => \(c\.quantity_missing \|\| 0\) === 0\)/,
    'the Owned tab must be defined as "nothing missing"');
});

test('DV-TC10: progress counts copies AVAILABLE here, not owned anywhere', () => {
  // A deck of two cards where one copy is sleeved into another deck is 50%
  // built, not 100%. Counting owned-anywhere would report it finished.
  const cards = [
    { quantity: 1, quantity_owned: 1, quantity_available: 0 },
    { quantity: 1, quantity_owned: 1, quantity_available: 1 },
  ];
  const owned = cards.reduce((n, c) => n + Math.min(c.quantity, c.quantity_available), 0);
  const total = cards.reduce((n, c) => n + c.quantity, 0);

  assert.equal(owned, 1, 'only the free copy counts toward progress');
  assert.equal(Math.round((owned / total) * 100), 50);

  assert.match(src, /Math\.min\(c\.quantity \|\| 0, c\.quantity_available \|\| 0\)/,
    'the progress reducer must use quantity_available');
});

test('DV-TC11: "already in this deck" is counted from THIS deck', () => {
  // in_deck_qty from /api/search counts EVERY deck (routes/collection.js:46),
  // so labelling it "in this deck" told Zach a card was here when it was
  // somewhere else -- the exact opposite of the truth he needed.
  assert.match(src, /const hereQty = \(cardId\) => deckCards/,
    'the count must come from the deck on screen');
  assert.doesNotMatch(src, /alreadyHere[^)]*c\.in_deck_qty/,
    'the "already here" label must never be fed from the all-decks figure');
});

test('DV-TC12: the export dialog is shared with the deck list', () => {
  // Zach: "can we have the functionality be the same as for the missing in the
  // deck view." Two copies of an export dialog is how they drifted apart in
  // the first place.
  assert.match(src, /import ExportModal from '\.\/ExportModal'/,
    'DeckView must use the shared ExportModal');
  const listSrc = readFileSync(join(here, 'DeckList.jsx'), 'utf8');
  assert.match(listSrc, /import ExportModal from '\.\/ExportModal'/,
    'DeckList must use the same component, not its own copy');
  assert.doesNotMatch(listSrc, /navigator\.clipboard\.writeText/,
    'DeckList must not silently copy: the text is shown before it is taken');
});

// --- OVERSUBSCRIPTION MUST BE VISIBLE ------------------------------------
//
// Zach searched Tony Stark from a THIRD deck and read "1 owned, in other
// decks". Measured on dev:
//
//     owned        = 1     one physical card
//     in_deck_qty  = 2     'Test' (commander) AND 'Test 2' (mainboard)
//     available    = 0
//
// Two decks had claimed one card. The old wording implied a tidy situation --
// "it's in another deck" -- when in fact his decks promise more copies than he
// owns. Sleeve one and the other is silently short, discovered at the table.
//
// The permissive rules make this REACHABLE by design: nothing stops a second
// deck claiming a spoken-for copy. So the screen has to say it, because
// nothing else will.

test('DV-TC13: more decks than copies is reported as over-committed', () => {
  const tony = { id: 'tony', owned_qty: 1, available_qty: 0, in_deck_qty: 2 };

  // Searching from a deck that does NOT contain him: all 2 claims are elsewhere.
  const hereQty = 0;
  const elsewhere = Math.max(0, tony.in_deck_qty - hereQty);

  assert.equal(elsewhere, 2, 'both claims are in other decks');
  assert.ok(elsewhere > tony.owned_qty,
    'two decks want one card -- this is the case that must be called out');

  assert.match(src, /elsewhere\(c\) > c\.owned_qty/,
    'the component must compare claims against copies owned');
  assert.match(src, /deck\.overCommitted/,
    'and use a distinct message when more decks want it than exist');
});

test('DV-TC14: this deck\'s own claim is not counted as "elsewhere"', () => {
  // in_deck_qty counts EVERY deck including the one on screen. Without the
  // subtraction, a card you just added here would also be reported as being
  // somewhere else -- the same confusion in a new place.
  const card = { id: 'tony', owned_qty: 1, available_qty: 0, in_deck_qty: 2 };
  const hereQty = 1;                       // this deck holds one of the two
  const elsewhere = Math.max(0, card.in_deck_qty - hereQty);

  assert.equal(elsewhere, 1, 'only the OTHER deck counts as elsewhere');
  assert.ok(!(elsewhere > card.owned_qty),
    'one copy claimed by one other deck is not over-committed');

  assert.match(src, /const elsewhere = \(c\) => Math\.max\(0, \(c\.in_deck_qty \|\| 0\) - hereQty\(c\.id\)\)/,
    'elsewhere must subtract this deck\'s own claim');
});

test('DV-TC15: the availability line never says just "in other decks"', () => {
  // Zach: "Feel like we need better wording here." The old string named
  // neither how many copies nor how many decks, so it could not be acted on.
  assert.doesNotMatch(src, /deck\.inOtherDecks/,
    'the vague message must be gone');
  assert.match(src, /deck\.usedInDecks/,
    'replaced by one that states the deck count');
});

// --- SEARCH RESULTS MUST IDENTIFY THE PRINTING ---------------------------
//
// Zach: "we need set numbers in the search results because the 2nd photo is
// what I see so how do I know which to choose?"
//
// Measured on dev -- searching "Tony Stark" returns four rows that all read
// "Tony Stark / Marvel Super Heroes" and are four DIFFERENT cards:
//
//     #350  Mythic  nonfoil, foil
//     #363  Mythic  nonfoil, foil
//     #392  Mythic  FOIL ONLY
//
// This app's premise is exact identity: it records the printing owned, not the
// card name. A picker that hides the printing asks him to choose blind and
// then stores that blind choice as a fact about his cardboard. #392 being
// foil-only means one of those rows silently commits to a foil.

test('DV-TC16: search rows show the collector number, not just the set', () => {
  // The rows are the shared CardSearchResult now.
  assert.match(searchRow, /card\.number/,
    'the collector number is the only thing distinguishing same-set printings');
  assert.match(searchRow, /card\.set_id/,
    'the set code should be shown alongside it');
});

test('DV-TC17: a foil-only printing says so', () => {
  // Choosing it commits to a foil, which is a real price difference. The
  // finishes array is already on every search result.
  assert.match(searchRow, /finishes\.length === 1[\s\S]{0,40}=== 'foil'/,
    'a printing available only in foil must be marked');
  assert.match(searchRow, /card\.foilOnly/,
    'and use a labelled string, not a bare word');
});

test('DV-TC18: the commander picker identifies printings too', () => {
  // Commanders have multiple printings and the deck records the exact one, so
  // the same blind-choice problem applies.
  // Structural now, not a count. Both searches render the SAME row, so a
  // commander result cannot show a name without its printing -- which is what
  // Zach asked for: "all single card searches should function the same".
  const uses = src.match(/<CardSearchResult/g) || [];
  assert.ok(uses.length >= 2,
    'both the add-card search and the commander picker must use the shared row');
  assert.match(searchRow, /card\.set_id/,
    'and that row must name the printing');
});
