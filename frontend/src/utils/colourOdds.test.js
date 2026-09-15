// THE COLOUR-SCREW MATH IS CHECKED AGAINST A CLOSED FORM, NOT AGAINST ITSELF.
//
// castOdds() simulates. A simulation that is subtly wrong still returns
// plausible percentages, so the single-colour case -- where an exact
// hypergeometric answer exists -- is compared against that answer. The cases
// with no closed form are then pinned by properties that must hold regardless
// (monotonicity, ordering, bounds).
//
// Run: node --test frontend/src/utils/colourOdds.test.js

import test from 'node:test';
import assert from 'node:assert';
import {
  pipsOf, pipsOfFace, castableCosts, sourceColours, sourceCounts, manaSources,
  castOdds, reliableTurn,
} from './colourOdds.js';
import { probAtLeast } from './handOdds.js';

// --- fixtures ---------------------------------------------------------------

const land = (name, produced, extra = {}) => ({
  name, type_line: 'Land', mana_cost: '', cmc: 0, board: 'mainboard',
  produced_mana: produced, ...extra,
});
const basic = (name, letter) => land(name, [letter], { type_line: `Basic Land — ${name}` });
const spell = (name, cost, cmc) => ({
  name, type_line: 'Sorcery', mana_cost: cost, cmc, board: 'mainboard',
  produced_mana: null,
});

/** A deck of `lands` copies of one land type plus filler up to `size`. */
function monoDeck(size, lands, letter, cost = '{G}', cmc = 1) {
  const cards = [];
  for (let i = 0; i < lands; i += 1) cards.push(basic('Forest', letter));
  for (let i = 0; i < size - lands - 1; i += 1) cards.push(spell(`Filler ${i}`, '{1}', 1));
  cards.push(spell('Target', cost, cmc));
  return cards;
}

// --- pip parsing ------------------------------------------------------------

test('CO-TC1: pips are counted, not just detected', () => {
  // The whole point: {W}{W} needs TWO sources. With 14 sources that is 37%
  // rather than 76%, so collapsing this to a boolean would be wrong by 39pp
  // exactly where casting is hardest.
  assert.deepEqual(pipsOf('{1}{W}{W}'), { W: 2 });
  assert.deepEqual(pipsOf('{1}{W}{B}'), { W: 1, B: 1 });
  assert.deepEqual(pipsOf('{3}'), {});
  assert.deepEqual(pipsOf(''), {});
  assert.deepEqual(pipsOf(null), {});
  assert.deepEqual(pipsOf('{X}{R}{R}{R}'), { R: 3 });
});

test('CO-TC2: hybrid and Phyrexian pips are not counted as hard requirements', () => {
  // {W/U} is payable either way and {W/P} is payable with life. Treating them
  // as a hard W requirement would understate castability.
  assert.deepEqual(pipsOf('{W/U}{W/U}'), {});
  assert.deepEqual(pipsOf('{1}{W/P}'), {});
  assert.deepEqual(pipsOf('{1}{W/U}{B}'), { B: 1 });
});

// --- what counts as a source ------------------------------------------------

test('CO-TC3: produced_mana, not colour identity', () => {
  // Command Tower's colour identity is EMPTY and it taps for all five. Reading
  // identity instead of produced_mana would call it a dead source.
  const tower = land('Command Tower', ['B', 'G', 'R', 'U', 'W']);
  assert.equal(sourceColours(tower, []).size, 5);

  // And a card whose identity is coloured but produces nothing is not a source.
  const bear = { name: 'Bear', type_line: 'Creature', produced_mana: null, oracle_text: '' };
  assert.equal(sourceColours(bear, []).size, 0);
});

test('CO-TC4: fetchlands are credited with what this deck can actually find', () => {
  // Scryfall reports produced_mana: null for Evolving Wilds -- it produces no
  // mana, it fetches. Counted literally it is a dead source, which is wrong.
  const fetch = land('Evolving Wilds', null, {
    oracle_text: '{T}, Sacrifice this land: Search your library for a basic land card...',
  });
  // In a deck with Forests it finds green...
  assert.deepEqual([...sourceColours(fetch, new Set(['G']))], ['G']);
  // ...and in a deck with no basics at all it finds nothing. A fetch in a deck
  // with no Islands cannot produce blue.
  assert.equal(sourceColours(fetch, new Set()).size, 0);
});

test('CO-TC5: source counts see duals as a source of BOTH colours', () => {
  const cards = [
    land('Sunpetal Grove', ['G', 'W']),
    land('Sunpetal Grove', ['G', 'W']),
    basic('Forest', 'G'),
  ];
  const counts = sourceCounts(cards);
  assert.equal(counts.G, 3, 'two duals plus a Forest is three green sources');
  assert.equal(counts.W, 2, 'the duals are white sources too');
  assert.equal(counts.U, 0);
});

test('CO-TC6: the commander is not in the library', () => {
  // It starts in the command zone, so it is never drawn. Counting it would
  // dilute every probability by one card.
  const cards = [
    { ...basic('Forest', 'G'), board: 'commander' },
    basic('Forest', 'G'),
    spell('Bolt', '{R}', 1),
  ];
  const { deck, commanders } = manaSources(cards);
  assert.equal(commanders, 1);
  assert.equal(deck.length, 2, 'library excludes the commander');
});

test('CO-TC7: the considering pile is excluded', () => {
  // Cards you are thinking about are not cards in the deck; counting them
  // would report odds for a deck you are not playing.
  const cards = [
    basic('Forest', 'G'),
    { ...basic('Forest', 'G'), board: 'considering' },
  ];
  assert.equal(manaSources(cards).deck.length, 1);
});

// --- the simulation, against an exact answer --------------------------------

test('CO-TC8: single-colour odds match the exact hypergeometric answer', () => {
  // With one colour and one pip, "can I cast it" is exactly "do I have >= turn
  // lands, at least one of which is green" -- and since EVERY land here is
  // green, that collapses to probAtLeast(). Any drift means the simulation is
  // wrong, not merely noisy.
  for (const [lands, turn] of [[35, 2], [37, 3], [40, 4]]) {
    const cards = monoDeck(100, lands, 'G', '{G}', 1);
    const library = 100 - 1;                     // minus the commander? none here
    const exact = probAtLeast(library + 0, lands, 7 + (turn - 1), turn);
    const sim = castOdds(cards, cards[cards.length - 1], turn, { trials: 20000 });
    assert.ok(Math.abs(sim - exact) < 0.02,
      `${lands} lands turn ${turn}: simulated ${(sim * 100).toFixed(1)}% vs `
      + `exact ${(exact * 100).toFixed(1)}% -- more than 2pp apart`);
  }
});

test('CO-TC9: a double pip is materially harder than a single', () => {
  // THE COLOUR MUST BE SCARCE for this to mean anything. My first version used
  // a mono-green deck, where EVERY land makes green -- so "at least one green"
  // and "at least two green" are the same requirement once you have the lands,
  // and it reported 25.79% for both. A vacuous pass in the making: it would
  // have gone green while proving nothing.
  //
  // Here green is 12 of 37 sources, so the second pip is a real constraint.
  const cards = [];
  for (let i = 0; i < 12; i += 1) cards.push(basic('Forest', 'G'));
  for (let i = 0; i < 25; i += 1) cards.push(basic('Plains', 'W'));
  while (cards.length < 99) cards.push(spell('Filler', '{1}', 1));

  const single = spell('Single', '{2}{G}', 3);
  const double = spell('Double', '{1}{G}{G}', 3);
  const a = castOdds(cards, single, 3, { trials: 20000 });
  const b = castOdds(cards, double, 3, { trials: 20000 });
  assert.ok(b < a - 0.05,
    `with green scarce, {1}{G}{G} (${(b * 100).toFixed(1)}%) must be clearly `
    + `harder than {2}{G} (${(a * 100).toFixed(1)}%)`);
});

test('CO-TC10: dual lands beat the naive independent product', () => {
  // THE REASON THIS SIMULATES INSTEAD OF MULTIPLYING. A dual is both sources
  // at once, so P(W and U) is HIGHER than P(W) x P(U). Measured at 8.4pp on a
  // dual-heavy base; multiplying would call a good manabase bad.
  const size = 100;
  const build = (duals, monoEach) => {
    const cards = [];
    for (let i = 0; i < duals; i += 1) cards.push(land('Dual', ['W', 'U']));
    for (let i = 0; i < monoEach; i += 1) cards.push(basic('Plains', 'W'));
    for (let i = 0; i < monoEach; i += 1) cards.push(basic('Island', 'U'));
    while (cards.length < size - 1) cards.push(spell('Filler', '{1}', 1));
    return cards;
  };
  const target = spell('WU card', '{1}{W}{U}', 3);
  const dualHeavy = castOdds(build(20, 4), target, 3, { trials: 20000 });
  const noDuals = castOdds(build(0, 14), target, 3, { trials: 20000 });
  assert.ok(dualHeavy > noDuals,
    `28 sources as duals (${(dualHeavy * 100).toFixed(1)}%) should beat the same `
    + `count split mono (${(noDuals * 100).toFixed(1)}%)`);
});

test('CO-TC11: you cannot cast above your curve', () => {
  const cards = monoDeck(100, 40, 'G');
  assert.equal(castOdds(cards, spell('Five drop', '{4}{G}', 5), 3), 0,
    'a 5-drop is not castable on turn 3 at any colour quality');
});

test('CO-TC12: colourless costs get the LAND odds, not null', () => {
  // I originally returned null here, reasoning that handOdds already answered
  // it. Zach saw the consequence: "the castable on turn 1 percentage why
  // doesnt it show on every card" -- Sol Ring, Arcane Signet and Fellwar Stone
  // had no percentage while every coloured card around them did.
  //
  // "Can I cast this on curve" HAS an answer for a colourless card: you need
  // N lands rather than N lands of the right colours. Answering it from the
  // same function keeps the two kinds of card from drifting apart.
  const cards = monoDeck(100, 37, 'G');
  const p = castOdds(cards, spell('Sol Ring', '{1}', 1), 1);
  assert.ok(p > 0 && p < 1, `a one-drop needs one land: expected a real probability, got ${p}`);

  // More lands, better odds -- the number must actually depend on the deck.
  const fewer = monoDeck(100, 20, 'G');
  assert.ok(castOdds(fewer, spell('Sol Ring', '{1}', 1), 1) < p,
    'a 20-land deck casts a one-drop on turn 1 less often than a 37-land deck');

  // And the mana value still gates it: a six-drop is not castable on turn 1.
  assert.equal(castOdds(cards, spell('Big Thing', '{6}', 6), 1), 0);
});

test('CO-TC13: more sources is never worse', () => {
  // Monotonicity catches a whole class of assignment bugs that still produce
  // numbers in a believable range.
  let previous = -1;
  for (let lands = 10; lands <= 45; lands += 5) {
    const cards = monoDeck(100, lands, 'G', '{1}{G}', 2);
    const p = castOdds(cards, cards[cards.length - 1], 3, { trials: 8000 });
    assert.ok(p >= previous - 0.03,
      `${lands} lands (${p}) was worse than ${lands - 5} (${previous})`);
    previous = p;
  }
});

test('CO-TC14: the scarcest colour is assigned first', () => {
  // One dual is the ONLY blue source. Spending it on white -- which has other
  // sources -- makes the hand look uncastable when it is not. Taking colours
  // in cost order does exactly that.
  const cards = [];
  cards.push(land('Sole WU dual', ['W', 'U']));
  for (let i = 0; i < 30; i += 1) cards.push(basic('Plains', 'W'));
  while (cards.length < 99) cards.push(spell('Filler', '{1}', 1));
  const target = spell('WU', '{W}{U}', 2);
  const p = castOdds(cards, target, 2, { trials: 20000 });
  assert.ok(p > 0.01,
    `with 31 W sources and one of them also blue, {W}{U} on turn 2 should be `
    + `possible sometimes, got ${p}`);
});

test('CO-TC15: results are deterministic across calls', () => {
  // Math.random() would make the same deck show different odds on every
  // render. That reads as a bug and discredits every number beside it.
  const cards = monoDeck(100, 37, 'G', '{1}{G}', 2);
  const a = castOdds(cards, cards[cards.length - 1], 3, { trials: 4000 });
  const b = castOdds(cards, cards[cards.length - 1], 3, { trials: 4000 });
  assert.equal(a, b);
});

test('CO-TC16: reliableTurn never reports earlier than the mana value', () => {
  const cards = monoDeck(100, 40, 'G', '{3}{G}', 4);
  const result = reliableTurn(cards, cards[cards.length - 1]);
  assert.ok(result, 'a 4-drop in a 40-land mono deck should become reliable');
  assert.ok(result.turn >= 4, `reported turn ${result.turn} for a 4-drop`);
});

test('CO-TC17: a deck with no sources of a colour reports zero, not a crash', () => {
  const cards = monoDeck(100, 37, 'G');
  assert.equal(castOdds(cards, spell('Island card', '{U}', 1), 3, { trials: 2000 }), 0);
});

test('CO-TC19: transform cards use the FRONT face only', () => {
  // Zach found this: Kefka, Court Mage is '{2}{U}{B}{R}' on the front and
  // NOTHING on the back -- it transforms, you never cast that side. Bindarr
  // joins every face, so the stored cost is '{2}{U}{B}{R} // ' and the split
  // rule (cheaper half) made him a ZERO-DROP with no colour requirement.
  const kefka = {
    name: 'Kefka, Court Mage', layout: 'transform',
    mana_cost: '{2}{U}{B}{R} // ', cmc: 5, mv: 5,
    type_line: 'Legendary Creature // Legendary Creature',
  };
  assert.deepEqual(pipsOf(kefka), { U: 1, B: 1, R: 1 },
    'the front face costs UBR -- the empty back face must not win');

  const delver = {
    name: 'Delver of Secrets', layout: 'transform',
    mana_cost: '{U} // ', cmc: 1, mv: 1, type_line: 'Creature // Creature',
  };
  assert.deepEqual(pipsOf(delver), { U: 1 });
});

test('CO-TC20: modal DFCs keep BOTH costs, because you pay for both', () => {
  // Zach: "for a card like tony stark we need to be treating them as separate
  // cards since each has their own mana cost because you have to pay to flip
  // him." Tony Stark is {1}{U}; The Invincible Iron Man is {4}{U}{R}.
  const tony = {
    name: 'Tony Stark', layout: 'modal_dfc',
    mana_cost: '{1}{U} // {4}{U}{R}', cmc: 2, mv: 2,
    type_line: 'Legendary Creature // Legendary Artifact Creature',
  };
  const costs = castableCosts(tony);
  assert.equal(costs.length, 2, 'both faces are independently castable');
  assert.deepEqual(costs[0], { U: 1 });
  assert.deepEqual(costs[1], { U: 1, R: 1 });

  // Castability asks "is this card live in my hand", so the EASIER face wins.
  assert.deepEqual(pipsOf(tony), { U: 1 });

  // And a transform card must NOT be treated this way.
  const kefka = { layout: 'transform', mana_cost: '{2}{U}{B}{R} // ' };
  assert.equal(castableCosts(kefka).length, 1,
    'a transform back face is not a second castable cost');
});
test('CO-TC18: split cards are ONE half, not both halves at once', () => {
  // FOUND IN THE BROWSER, not by a test. Fire // Ice showed as 0% castable
  // because Scryfall's cost is '{1}{R} // {1}{U}' and parsing it whole
  // demanded red AND blue simultaneously -- a requirement no hand ever meets.
  //
  // You cast ONE half. The easier half is the honest answer, and it agrees
  // with the curve, which already buckets split cards at the cheaper side.
  assert.deepEqual(pipsOf('{1}{R} // {1}{U}'), { R: 1 },
    'must not require both halves at once');
  assert.deepEqual(pipsOf('{2}{W} // {W}{W}'), { W: 1 },
    'the half with fewer pips is the easier cast');

  // And end to end, WITH THE DISAGREEMENT THAT ACTUALLY SHIPPED: Scryfall's
  // cmc for Fire // Ice is 4 (both halves) while the curve buckets it at mv 2
  // (the half you cast). My first version of this test passed `cmc: 2` and so
  // never exercised that gap -- it went green while the browser showed 0%.
  const cards = [];
  for (let i = 0; i < 20; i += 1) cards.push(basic('Mountain', 'R'));
  while (cards.length < 99) cards.push(spell('Filler', '{1}', 1));
  const fireIce = {
    name: 'Fire // Ice', type_line: 'Instant // Instant',
    mana_cost: '{1}{R} // {1}{U}', cmc: 4, mv: 2,
    board: 'mainboard', produced_mana: null,
  };
  const p = castOdds(cards, fireIce, 2, { trials: 8000 });
  assert.ok(p > 0.2,
    `Fire // Ice in a red deck should be castable on turn 2, got ${(p * 100).toFixed(1)}%`);
});
