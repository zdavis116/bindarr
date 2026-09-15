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
import { bucketFor, curveEntriesFor, faceTextFrom } from './curveBuckets.js';

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

test('CB-TC3: bucketFor is the SINGLE-entry fallback, not the curve path', () => {
  // bucketFor still collapses a split to its cheaper half, and that is fine --
  // it answers "if this card had to sit in ONE bucket, where". But the curve
  // no longer asks it that for multi-cost cards: curveEntriesFor returns both
  // faces instead.
  //
  // This test exists so the distinction is deliberate rather than an
  // inconsistency someone later "fixes" in the wrong direction.
  const fireIce = {
    name: 'Fire // Ice', layout: 'split',
    mana_cost: '{1}{R} // {1}{U}', type_line: 'Instant // Instant', cmc: 4,
  };
  assert.equal(bucketFor(fireIce).mv, 2, 'single-bucket fallback picks the cheaper half');
  assert.equal(curveEntriesFor(fireIce).length, 2, 'the CURVE shows both halves');
});

test('CB-TC4: an adventure yields the creature AND the spell, in that order', () => {
  // The creature face is printed first and is the card's identity, so it leads.
  const bonecrusher = {
    name: 'Bonecrusher Giant // Stomp', layout: 'adventure',
    mana_cost: '{2}{R} // {1}{R}',
    type_line: 'Creature — Giant // Instant — Adventure', cmc: 3,
  };
  const entries = curveEntriesFor(bonecrusher);
  assert.deepEqual(entries.map((e) => e.faceName), ['Bonecrusher Giant', 'Stomp']);
  assert.deepEqual(entries.map((e) => e.mv), [3, 2]);
  assert.equal(entries[1].note, 'adventure-half', 'the second half says why it is here');
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

test('CB-TC8: transform cards are NOT doubled, but adventures and splits ARE', () => {
  // THE LINE IS "does the second face have its own mana cost you pay".
  //
  // Kefka's back face has NO cost -- you flip to it, you never cast it, so
  // counting it would invent a spell that is not in the deck.
  const kefka = {
    name: 'Kefka, Court Mage // Kefka, Ruler of Ruin', layout: 'transform',
    mana_cost: '{2}{U}{B}{R} // ', type_line: 'Creature // Creature', cmc: 5,
  };
  const kefkaEntries = curveEntriesFor(kefka);
  assert.equal(kefkaEntries.length, 1, 'a transform card is one spell');
  assert.equal(kefkaEntries[0].mv, 5);

  // ADVENTURES DO count twice. Zach: "I have sagu wildling that has a sorcery
  // attached those are not done right either." Sagu Wildling is {4}{G} and
  // Roost Seek is {G} -- a five-drop and a one-drop, and the curve showed only
  // the five.
  const sagu = {
    name: 'Sagu Wildling // Roost Seek', layout: 'adventure',
    mana_cost: '{4}{G} // {G}',
    type_line: 'Creature — Dragon // Sorcery — Omen', cmc: 5,
  };
  const saguEntries = curveEntriesFor(sagu);
  assert.equal(saguEntries.length, 2, 'both halves are castable spells');
  assert.deepEqual(saguEntries.map((e) => e.mv), [5, 1]);
  assert.equal(saguEntries[0].faceName, 'Sagu Wildling');
  assert.equal(saguEntries[1].faceName, 'Roost Seek');

  // SPLITS too. Wear {1}{R} and Tear {W} are a two-drop and a one-drop; the
  // old rule kept only the cheaper and hid the other.
  const wearTear = {
    name: 'Wear // Tear', layout: 'split',
    mana_cost: '{1}{R} // {W}', type_line: 'Instant // Instant', cmc: 3,
  };
  const wt = curveEntriesFor(wearTear);
  assert.equal(wt.length, 2);
  assert.deepEqual(wt.map((e) => e.mv), [2, 1]);

  // Ordinary cards, obviously.
  assert.equal(curveEntriesFor({ mana_cost: '{3}{G}', cmc: 4, type_line: 'Creature' }).length, 1);

  // PREPARE cards behave exactly like Adventure -- 108 of them in the real
  // catalogue. A WHITELIST of layouts missed them silently, which is why the
  // rule is now structural (exclude flip-only layouts) rather than a list of
  // mechanics that goes stale every set.
  const prepare = {
    name: 'Adventurous Eater // Have a Bite', layout: 'prepare',
    mana_cost: '{2}{B} // {B}', type_line: 'Creature — Human // Sorcery', cmc: 3,
  };
  const pe = curveEntriesFor(prepare);
  assert.equal(pe.length, 2, 'Prepare cards have two castable costs');
  assert.deepEqual(pe.map((e) => e.mv), [3, 1]);

  // A layout NOBODY has written a rule for must still split, because the rule
  // is about structure. This is the future-set case.
  const unknown = {
    name: 'Front // Back', layout: 'some_future_mechanic',
    mana_cost: '{2}{W} // {U}', type_line: 'Creature // Instant', cmc: 3,
  };
  assert.equal(curveEntriesFor(unknown).length, 2,
    'an unknown two-cost layout still counts twice');

  // AND THE FLIP-ONLY SET MUST BE DOING REAL WORK.
  //
  // Mutation-testing caught that removing 'transform' from FLIP_ONLY_LAYOUTS
  // broke NOTHING: the castable filter already drops cost-less faces, so
  // Kefka stays single for a second, unrelated reason. The Kefka assertion
  // above was passing for the wrong reason.
  //
  // A transform card whose stored string DOES carry a back cost is the case
  // that separates them. Werewolves print a cost-looking back on some
  // printings, and a future importer change could reintroduce one. If only
  // the filter protected us, this would wrongly become two entries.
  const oddTransform = {
    name: 'Front // Back', layout: 'transform',
    mana_cost: '{2}{G} // {4}{G}', type_line: 'Creature // Creature', cmc: 3,
  };
  assert.equal(curveEntriesFor(oddTransform).length, 1,
    'a transform back face is never cast, whatever cost the string carries');
});

test('CB-TC10: every face carries its OWN name, never the joined string', () => {
  // Zach: "Why does it say Tony stark and not the invincible iron man because
  // that's wrong." Both rows were labelled with the full 'A // B' name, so the
  // six-drop row read as the two-drop.
  const tony = {
    name: 'Tony Stark // The Invincible Iron Man', layout: 'modal_dfc',
    mana_cost: '{1}{U} // {4}{U}{R}',
    type_line: 'Legendary Creature — Human // Legendary Artifact Creature', cmc: 2,
  };
  const [front, back] = curveEntriesFor(tony);
  assert.equal(front.faceName, 'Tony Stark');
  assert.equal(back.faceName, 'The Invincible Iron Man');
  assert.ok(!front.faceName.includes('//'), 'no joined string on a face row');
  assert.ok(!back.faceName.includes('//'));

  // And each face gets its own type line, so a Sorcery half does not claim to
  // be a Creature.
  assert.match(front.faceType, /Creature/);
  assert.match(back.faceType, /Artifact/);

  // Single-faced cards are unaffected, and a plain name stays plain.
  const bolt = curveEntriesFor({ name: 'Lightning Bolt', mana_cost: '{R}', cmc: 1, type_line: 'Instant' });
  assert.equal(bolt[0].faceName, 'Lightning Bolt');
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

// THE SHAPE BINDARR ACTUALLY STORES for Tony Stark, read off the live dev
// database. NOT a guess: `name` is the FRONT face only, the joined form lives
// in display_name, the second face in back_name, and oracle_text carries both
// faces under === headers. Splitting `name` on '//' therefore gave BOTH rows
// the name 'Tony Stark' -- the bug Zach screenshotted.
const TONY = {
  name: 'Tony Stark',
  display_name: 'Tony Stark // The Invincible Iron Man',
  back_name: 'The Invincible Iron Man',
  back_type_line: 'Legendary Artifact Creature — Human Hero',
  type_line: 'Legendary Creature — Human Artificer Hero // Legendary Artifact Creature — Human Hero',
  mana_cost: '{1}{U} // {4}{U}{R}',
  layout: 'modal_dfc',
  cmc: 2,
  image_url: 'https://cards.scryfall.io/normal/front/4/c/4cea.jpg',
  back_image_url: 'https://cards.scryfall.io/normal/back/4/c/4cea.jpg',
  oracle_text: [
    '=== Tony Stark ===',
    '{1}, {T}: Look at the top four cards of your library.',
    '{4}{U}{R}: Transform Tony Stark. Activate only as a sorcery.',
    '',
    '=== The Invincible Iron Man ===',
    'Flying, haste',
    'At the beginning of combat on your turn, you may put an artifact card',
  ].join('\n'),
};

test('CB-TC11: the 6-mana row is named The Invincible Iron Man', () => {
  // Zach, with a screenshot: "it should say the invincible iron man for the 6
  // mana one". The row showed 'Tony Stark' because `name` has no '//' in it,
  // so splitting it produced the same string for both faces.
  const [front, back] = curveEntriesFor(TONY);
  assert.equal(front.mv, 2);
  assert.equal(back.mv, 6);
  assert.equal(front.faceName, 'Tony Stark');
  assert.equal(back.faceName, 'The Invincible Iron Man',
    'the six-drop is the back face and must be named as it');
});

test('CB-TC12: each face shows ONLY its own rules text', () => {
  // "and only have that card description". The row was printing the whole
  // joined blob, so the six-drop explained the two-drop as well.
  const [front, back] = curveEntriesFor(TONY);

  assert.match(front.faceText, /Look at the top four/);
  assert.ok(!front.faceText.includes('Flying, haste'),
    'the front face must not carry the back face rules');

  assert.match(back.faceText, /Flying, haste/);
  assert.ok(!back.faceText.includes('Look at the top four'),
    'the back face must not carry the front face rules');

  // And the === headers themselves are gone: the row already has a title.
  assert.ok(!back.faceText.includes('==='), 'no leftover section headers');
});

test('CB-TC13: the back face uses the BACK art', () => {
  // The screenshot showed Tony Stark's picture on the six-drop row.
  const [front, back] = curveEntriesFor(TONY);
  assert.match(front.faceImage, /\/front\//);
  assert.match(back.faceImage, /\/back\//, 'the back face has its own image');
});

test('CB-TC14: faceTextFrom is safe on ordinary and malformed text', () => {
  // Single-faced cards have no headers and must pass straight through.
  assert.equal(faceTextFrom('Flying', 'Serra Angel', 0), 'Flying');
  assert.equal(faceTextFrom('', 'X', 0), '');
  assert.equal(faceTextFrom(null, 'X', 0), '');

  // Unknown face name falls back to position rather than returning nothing --
  // a blank rules box is worse than the wrong half.
  const two = '=== A ===\nalpha\n\n=== B ===\nbeta';
  assert.equal(faceTextFrom(two, 'Nonexistent', 1), 'beta');
  assert.equal(faceTextFrom(two, 'B', 0), 'beta', 'name wins over index');
});
