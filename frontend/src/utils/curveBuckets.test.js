// THE CURVE'S MANA VALUES, especially for cards with two faces.
//
// Zach found a live bug here: Kefka, Court Mage sat in the ZERO bucket. His
// front face is {2}{U}{B}{R} and his back face has no cost at all -- he
// transforms, you never cast that side. Bindarr stores every face joined, so
// the cost string is '{2}{U}{B}{R} // ' and taking the cheaper half made a
// five-drop look free.
//
// Run: node --test frontend/src/components/curveBuckets.test.js

import test from 'node:test';
import assert from 'node:assert';
import { bucketFor, curveEntriesFor } from './curveBuckets.js';

test('CB-TC1: a transform card is its FRONT face, not the empty back one', () => {
  // THE BUG THAT SHIPPED. Without the layout check this returns mv 0.
  const kefka = {
    name: 'Kefka, Court Mage',
    layout: 'transform',
    mana_cost: '{2}{U}{B}{R} // ',
    type_line: 'Legendary Creature — Human Wizard // Legendary Creature — Avatar Wizard',
    cmc: 5,
  };
  assert.equal(bucketFor(kefka).mv, 5,
    'a five-drop that transforms is a five-drop, not a zero-drop');

  const delver = {
    name: 'Delver of Secrets', layout: 'transform',
    mana_cost: '{U} // ', type_line: 'Creature // Creature', cmc: 1,
  };
  assert.equal(bucketFor(delver).mv, 1);

  const cathar = {
    name: 'Brutal Cathar', layout: 'transform',
    mana_cost: '{2}{W} // ', type_line: 'Creature // Creature', cmc: 3,
  };
  assert.equal(bucketFor(cathar).mv, 3);
});

test('CB-TC2: a modal DFC buckets at its FRONT face and says it has two', () => {
  // Zach: "tony starks card you pay to flip but his main side is 2 mana and
  // his flip side is 6 mana ... we need to be treating them as separate cards
  // since each has their own mana cost."
  //
  // The curve buckets the front -- that is the turn the card first does
  // something -- and flags it, so a 6-mana back face is not hidden.
  const tony = {
    name: 'Tony Stark', layout: 'modal_dfc',
    mana_cost: '{1}{U} // {4}{U}{R}',
    type_line: 'Legendary Creature // Legendary Artifact Creature', cmc: 2,
  };
  const result = bucketFor(tony);
  assert.equal(result.mv, 2, 'the castable front face is two mana');
  assert.equal(result.note, 'mdfc', 'the second cost must be visible, not silent');
});

test('CB-TC3: split cards still take the CHEAPER half', () => {
  // Unchanged and deliberate: you cast one half, and the cheap one answers
  // "can I use this on turn two".
  const fireIce = {
    name: 'Fire // Ice', layout: 'split',
    mana_cost: '{1}{R} // {1}{U}', type_line: 'Instant // Instant', cmc: 4,
  };
  const result = bucketFor(fireIce);
  assert.equal(result.mv, 2, 'the cheaper half is the castable turn');
  assert.equal(result.note, '//');
});

test('CB-TC4: adventures take the CREATURE half, which is the first face', () => {
  const bonecrusher = {
    name: 'Bonecrusher Giant', layout: 'adventure',
    mana_cost: '{2}{R} // {1}{R}',
    type_line: 'Creature — Giant // Instant — Adventure', cmc: 3,
  };
  const result = bucketFor(bonecrusher);
  assert.equal(result.mv, 3, 'the creature half is what the curve is about');
  assert.equal(result.note, 'adv');
});

test('CB-TC5: ordinary cards are unaffected', () => {
  assert.equal(bucketFor({ mana_cost: '{3}{G}{G}', cmc: 5, type_line: 'Creature' }).mv, 5);
  assert.equal(bucketFor({ mana_cost: '{0}', cmc: 0, type_line: 'Artifact' }).mv, 0);
  // X spells count X as zero off the stack, and say so.
  const x = bucketFor({ mana_cost: '{X}{U}{U}', cmc: 2, type_line: 'Sorcery' });
  assert.equal(x.note, 'X');
});

test('CB-TC7: a modal DFC produces TWO curve entries, one per castable face', () => {
  // Zach: "cards that have a flip side both cards should be counted in the
  // mana value like Tony stark should account for 2 and 6 because technically
  // I still need 6 mana to play his flip side."
  //
  // Both faces are real spells you pay for, so showing only the {1}{U} front
  // hides a six-drop -- exactly the card a curve exists to warn you about.
  const tony = {
    name: 'Tony Stark // The Invincible Iron Man', layout: 'modal_dfc',
    mana_cost: '{1}{U} // {4}{U}{R}',
    type_line: 'Legendary Creature // Legendary Artifact Creature', cmc: 2,
  };
  const entries = curveEntriesFor(tony);
  assert.equal(entries.length, 2, 'both castable faces count');
  assert.equal(entries[0].mv, 2, 'front face is two mana');
  assert.equal(entries[1].mv, 6, 'back face is six mana -- you pay to flip him');
  assert.equal(entries[0].faceName, 'Tony Stark');
  assert.equal(entries[1].faceName, 'The Invincible Iron Man');
  assert.equal(entries[1].note, 'mdfc-back', 'the back face says why it is here');
  assert.equal(entries[0].note, null, 'the front is an ordinary card');
});

test('CB-TC8: transform and split cards are NOT doubled', () => {
  // The rule is specific to modal DFCs. Kefka's back face has NO cost -- you
  // flip to it, you never cast it, so counting it would invent a spell.
  const kefka = {
    name: 'Kefka, Court Mage // Kefka, Ruler of Ruin', layout: 'transform',
    mana_cost: '{2}{U}{B}{R} // ', type_line: 'Creature // Creature', cmc: 5,
  };
  const kefkaEntries = curveEntriesFor(kefka);
  assert.equal(kefkaEntries.length, 1, 'a transform card is one spell');
  assert.equal(kefkaEntries[0].mv, 5);

  // And Fire // Ice is ONE spell with two ways to cast it -- you only ever
  // cast one, so counting both would double the card in the deck.
  const fireIce = {
    name: 'Fire // Ice', layout: 'split',
    mana_cost: '{1}{R} // {1}{U}', type_line: 'Instant // Instant', cmc: 4,
  };
  assert.equal(curveEntriesFor(fireIce).length, 1, 'a split card is one spell');

  // Ordinary cards, obviously.
  assert.equal(curveEntriesFor({ mana_cost: '{3}{G}', cmc: 4, type_line: 'Creature' }).length, 1);
});

test('CB-TC9: each face is addressable, so the two do not collide', () => {
  // The dropdown, the React key and the hard-to-cast map all key on id. If
  // both faces shared one id, clicking the six-drop would open the two-drop.
  const tony = {
    name: 'Tony Stark // The Invincible Iron Man', layout: 'modal_dfc',
    mana_cost: '{1}{U} // {4}{U}{R}', type_line: 'Creature // Creature', cmc: 2,
  };
  const [front, back] = curveEntriesFor(tony);
  assert.equal(front.faceIndex, 0);
  assert.equal(back.faceIndex, 1);
  assert.notEqual(front.faceCost, back.faceCost,
    'each face carries its own cost, so the pips and odds differ');
});

test('CB-TC6: layout beats the string, because both look the same', () => {
  // A transform card and a split card BOTH stringify with ' // '. Only the
  // layout field distinguishes them, which is why the check cannot be a regex
  // on the cost -- the original bug was exactly that.
  const asTransform = {
    layout: 'transform', mana_cost: '{2}{U}{B}{R} // ', type_line: 'Creature // Creature', cmc: 5,
  };
  const asSplit = {
    layout: 'split', mana_cost: '{2}{U}{B}{R} // {U}', type_line: 'Instant // Instant', cmc: 5,
  };
  assert.equal(bucketFor(asTransform).mv, 5);
  assert.equal(bucketFor(asSplit).mv, 1, 'a real split card does take the cheap half');
});
