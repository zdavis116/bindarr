// COMPARE VIEW: two deck lists, sectioned like the deck view.
//
// Zach (2026-09-20): "organize each list just like the deck view like by card
// type and do each section in alphabetical order. And then I think we can
// change the views to my deck and the compared deck and highlight the
// differences in red with both decks."
//
// Three things can silently go wrong here and none of them throws:
//
//   1. The two sides section DIFFERENTLY, so a card sits under Creatures on one
//      side and Artifacts on the other and reads as a difference in the decks
//      rather than a difference in our code. That is why both sides are forced
//      through deckSections.sectionForTypeLine, and why the test below feeds
//      the SAME card in both shapes (Scryfall type_line string vs Mana Pool
//      types array) and demands the same section.
//   2. The red highlight gets recomputed on the screen instead of read from the
//      server's `shared` flag -- the duplicate-computation bug that produced
//      four separate Curve defects. A source scan at the bottom guards it.
//   3. Sorting drifts from alphabetical.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sectionCompareCards, compareSectionCount } from './compareSections.js';
import { sectionForCard, groupIntoSections } from './deckListSections.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const names = (section) => section.cards.map((c) => c.name);

// ---------------------------------------------------------------------------
// CS-TC1: sections come out in the deck view's order, not alphabetically by
// section name and not in input order. Commander first, lands last.
// ---------------------------------------------------------------------------
{
  const cards = [
    { oracleId: '1', name: 'Swamp', typeLine: 'Basic Land — Swamp' },
    { oracleId: '2', name: 'Sol Ring', typeLine: 'Artifact' },
    { oracleId: '3', name: 'Atraxa', typeLine: 'Legendary Creature — Angel', isCommander: true },
    { oracleId: '4', name: 'Counterspell', typeLine: 'Instant' },
    { oracleId: '5', name: 'Llanowar Elves', typeLine: 'Creature — Elf Druid' },
  ];
  const sections = sectionCompareCards(cards);
  assert.deepEqual(sections.map((s) => s.title),
    ['Commander', 'Creature', 'Instant', 'Artifact', 'Land'],
    'CS-TC1 sections must follow the deck view order');
}

// ---------------------------------------------------------------------------
// CS-TC2: alphabetical WITHIN a section, case-insensitively. Input is
// deliberately reverse-sorted and mixed-case so an unsorted implementation
// cannot pass by accident.
// ---------------------------------------------------------------------------
{
  const cards = [
    { oracleId: '1', name: 'zombie Apocalypse', typeLine: 'Sorcery' },
    { oracleId: '2', name: 'Brainstorm', typeLine: 'Sorcery' },
    { oracleId: '3', name: 'ancestral Vision', typeLine: 'Sorcery' },
  ];
  const [section] = sectionCompareCards(cards);
  assert.deepEqual(names(section),
    ['ancestral Vision', 'Brainstorm', 'zombie Apocalypse'],
    'CS-TC2 cards must sort alphabetically regardless of case');
}

// ---------------------------------------------------------------------------
// CS-TC3: THE ALIGNMENT GUARANTEE. The same physical card, described the two
// different ways the two sides arrive in, must land in the same section.
//
// Bindarr sends a Scryfall type_line; Mana Pool sends a types array which the
// route joins into a string. If those diverge, the columns stop lining up and
// the whole screen lies.
// ---------------------------------------------------------------------------
{
  const pairs = [
    ['Artifact Creature — Golem', ['Artifact', 'Creature'], 'Creature'],
    ['Legendary Creature — Angel', ['Creature'], 'Creature'],
    ['Artifact Land', ['Artifact', 'Land'], 'Land'],
    ['Enchantment — Aura', ['Enchantment'], 'Enchantment'],
    ['Legendary Planeswalker — Teferi', ['Planeswalker'], 'Planeswalker'],
  ];
  for (const [typeLine, types, expected] of pairs) {
    const [mineSection] = sectionCompareCards(
      [{ oracleId: 'x', name: 'Card', typeLine }]);
    // Exactly what backend/src/routes/decks.js does to their side.
    const [theirSection] = sectionCompareCards(
      [{ oracleId: 'x', name: 'Card', typeLine: types.join(' ') }]);
    assert.equal(mineSection.title, expected,
      `CS-TC3 ${typeLine} must section as ${expected}`);
    assert.equal(theirSection.title, mineSection.title,
      `CS-TC3 both sides must section ${typeLine} identically`);
  }
}

// ---------------------------------------------------------------------------
// CS-TC4: an unrecognised type line lands in Other and is never DROPPED. A
// card that vanishes is worse than one in a catch-all -- the user counts the
// list, comes up short, and has nothing to look at.
// ---------------------------------------------------------------------------
{
  const cards = [
    { oracleId: '1', name: 'Weird Thing', typeLine: 'Dungeon' },
    { oracleId: '2', name: 'No Type At All', typeLine: '' },
  ];
  const sections = sectionCompareCards(cards);
  const total = sections.reduce((n, s) => n + s.cards.length, 0);
  assert.equal(total, 2, 'CS-TC4 no card may be dropped');
  assert.deepEqual(sections.map((s) => s.title), ['Other']);
}

// ---------------------------------------------------------------------------
// CS-TC5: empty sections are omitted, not rendered as "(0)". On a short screen
// a stack of zero headers pushes the real list out of view.
// ---------------------------------------------------------------------------
{
  const sections = sectionCompareCards([
    { oracleId: '1', name: 'Forest', typeLine: 'Basic Land — Forest' },
  ]);
  assert.deepEqual(sections.map((s) => s.title), ['Land'],
    'CS-TC5 only non-empty sections may appear');
}

// ---------------------------------------------------------------------------
// CS-TC6: the header count is PHYSICAL CARDS, not rows. Four Lightning Bolts on
// one row is four cards, because the player is counting toward 100.
// ---------------------------------------------------------------------------
{
  assert.equal(compareSectionCount([{ quantity: 4 }, { quantity: 1 }]), 5,
    'CS-TC6 count must sum quantities');
  // Their side may omit quantity for a singleton; it must count as one, not
  // zero, or a pre-built deck would report a smaller section than it has.
  assert.equal(compareSectionCount([{}, {}]), 2,
    'CS-TC6 a card with no quantity counts as one');
}

// ---------------------------------------------------------------------------
// CS-TC7: THE RULE, NOT THE SYMPTOM. The modal must read the server's `shared`
// flag and must never rebuild membership itself.
//
// This is a source scan rather than a behaviour assertion because the failure
// it guards against is invisible at runtime until the two answers disagree --
// exactly how the Curve tab shipped a row and a tooltip that contradicted each
// other. Guard the rule.
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(
    path.join(here, 'DeckCompareModal.jsx'), 'utf8');

  assert.match(src, /c\.shared \? '' : 'mpc-differs'/,
    'CS-TC7 the red highlight must be driven by the server shared flag');

  // Re-deriving membership would look like a lookup of one list inside the
  // other. If a future edit reintroduces that, this fails.
  assert.doesNotMatch(src, /\.(some|find|includes|filter)\([^)]*oracleId/,
    'CS-TC7 the modal must not recompute which cards the decks share');

  // The counts in the header come from the server too, so the header can never
  // disagree with the lists under it.
  assert.match(src, /diff\.onlyTheirsCount/, 'CS-TC7 header reads server counts');
  assert.match(src, /diff\.stealableCount/, 'CS-TC7 header reads server counts');
}

// ---------------------------------------------------------------------------
// CS-TC8: THE REGRESSION THAT ACTUALLY HAPPENED. "Organize it just like the
// deck view" must mean the deck view's OWN rule, not a rule that resembles it.
//
// The first version of this screen borrowed deckSections.js, which looked
// equivalent and was not: it has no Battle section and uses plural labels. A
// battle card ("Invasion of Kaldheim // Pyre of the World Tree") landed in an
// OTHER section that the deck view does not have -- caught only by opening the
// deployed page, never by a green test.
//
// So this asserts the compare screen sections a battle exactly where the deck
// view does, and that both call the SAME module.
// ---------------------------------------------------------------------------
{
  const sections = sectionCompareCards([
    { oracleId: '1', name: 'Invasion of Kaldheim', typeLine: 'Battle — Siege' },
  ]);
  // Read the section the card actually landed in, so a card that VANISHED
  // reports as a failed assertion rather than a TypeError on undefined.
  const battleSection = sections.find((s) => s.cards.length > 0);
  assert.equal(battleSection && battleSection.title, 'Battle',
    'CS-TC8 a battle must get the deck view Battle section, not Other');

  // Same rule, literally: both screens import from deckListSections.
  assert.equal(sectionForCard('Battle — Siege', false), 'Battle');

  const deckView = fs.readFileSync(path.join(here, 'DeckView.jsx'), 'utf8');
  const compare = fs.readFileSync(path.join(here, 'compareSections.js'), 'utf8');
  assert.match(deckView, /from '\.\/deckListSections\.js'/,
    'CS-TC8 the deck view must use the shared sectioning module');
  assert.match(compare, /from '\.\/deckListSections\.js'/,
    'CS-TC8 the compare screen must use the shared sectioning module');
  // No second copy of the priority list anywhere.
  assert.doesNotMatch(deckView, /const TYPE_PRIORITY/,
    'CS-TC8 the deck view must not keep its own copy of the priority order');
}

// ---------------------------------------------------------------------------
// CS-TC9: the labels shown must be the deck view's labels. Plural headings
// ("Creatures", "Lands") were part of the same near-copy bug: even once the
// sections matched, the two screens would still have READ differently.
// ---------------------------------------------------------------------------
{
  const en = JSON.parse(fs.readFileSync(
    path.join(here, '..', 'locales', 'en.json'), 'utf8'));
  for (const name of ['Commander', 'Creature', 'Instant', 'Sorcery', 'Artifact',
    'Enchantment', 'Planeswalker', 'Battle', 'Land', 'Other']) {
    const key = `mpc.section${name}`;
    assert.equal(en[key], name,
      `CS-TC9 ${key} must read "${name}", matching the deck view`);
  }
}

// ---------------------------------------------------------------------------
// CS-TC10: A SECTION MISSING FROM THE DISPLAY ORDER MUST NOT DELETE ITS CARDS.
//
// Found by mutation-testing CS-TC8: removing 'Battle' from TYPE_ORDER did not
// just misplace battles, it made them VANISH -- the grouping filtered strictly
// by the order list. That is the worst failure this screen has, because the
// user counts the list, comes up short, and has nothing to look at.
//
// An unlisted section must cost ORDERING (it sorts last), never cards.
// ---------------------------------------------------------------------------
{
  const cards = [
    { oracleId: '1', name: 'Invasion of Kaldheim', typeLine: 'Battle — Siege' },
    { oracleId: '2', name: 'Forest', typeLine: 'Basic Land — Forest' },
  ];
  const placed = sectionCompareCards(cards)
    .reduce((n, s) => n + s.cards.length, 0);
  assert.equal(placed, cards.length,
    'CS-TC10 every card must survive sectioning');

  // Directly: a section name the display order does not mention still appears.
  const odd = groupIntoSections([{ name: 'X', typeLine: 'Dungeon' }]);
  assert.equal(odd.reduce((n, s) => n + s.cards.length, 0), 1,
    'CS-TC10 an unlisted section must still render its cards');
}

console.log('PASS: CS-TC1 deck view section order');
console.log('PASS: CS-TC2 alphabetical within section');
console.log('PASS: CS-TC3 both sides section identically');
console.log('PASS: CS-TC4 unknown types land in Other, never dropped');
console.log('PASS: CS-TC5 empty sections omitted');
console.log('PASS: CS-TC6 counts are physical cards');
console.log('PASS: CS-TC7 red highlight reads the server flag');
console.log('PASS: CS-TC8 battles section like the deck view, one shared rule');
console.log('PASS: CS-TC9 section labels match the deck view');
console.log('PASS: CS-TC10 an unlisted section never deletes its cards');
