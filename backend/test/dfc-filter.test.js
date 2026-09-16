// DOUBLE-FACED CARDS MUST BE FINDABLE BY EITHER FACE.
//
// Zach: "when I have artifact type selected and search invincible iron man I
// dont find anything which is wrong but technically he is the flip side of
// Tony Stark which isnt an artifact creature. But I should be able to see the
// artifact creature."
//
// Two separate bugs, one cause: the collection screen only ever looked at the
// FRONT face.
//
//   1. cardTypesOf() did `type_line.split('—')[0]`. A DFC stores both faces in
//      one field joined by " // ":
//        "Legendary Creature — Human Artificer Hero // Legendary Artifact Creature — Human Hero"
//      Splitting on the em dash first stops inside the front face, so the word
//      "Artifact" never appears and the card is invisible to the Artifact filter.
//
//   2. The search matched `name` and `flavor_name` but not `back_name`. The
//      card in his binder reads "The Invincible Iron Man" on one side; typing
//      that found nothing.
//
// Verified against Scryfall: Tony Stark is a modal_dfc whose back face type
// line is "Legendary Artifact Creature — Human Hero". The dev database stores
// the full joined type_line and a separate back_name, so both fixes are pure
// display-side -- the data was always there.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
const pass = (id, what) => { passed += 1; console.log(`PASS: ${id} ${what}`); };

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'CollectionList.jsx'),
  'utf8');

// The real card, exactly as card_cache stores it (verified on dev).
const TONY = {
  name: 'Tony Stark',
  back_name: 'The Invincible Iron Man',
  flavor_name: null,
  type_line: 'Legendary Creature — Human Artificer Hero'
    + ' // Legendary Artifact Creature — Human Hero',
};

// A single-faced card, to prove the fix does not make every card an artifact.
const BEAR = {
  name: 'Grizzly Bears',
  back_name: null,
  flavor_name: null,
  type_line: 'Creature — Bear',
};

// The component's own list, so this test cannot drift from it.
const CARD_TYPES = (() => {
  const m = SRC.match(/const CARD_TYPES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, 'CARD_TYPES must exist in CollectionList.jsx');
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
})();

// --- DFC-TC1 -----------------------------------------------------------------
// The shipped implementation, lifted from source rather than re-typed: a test
// that asserts its own copy of the logic cannot detect the logic being wrong.
const cardTypesOf = (() => {
  const m = SRC.match(/const cardTypesOf = \(card\) => \{[\s\S]*?\n\};/);
  assert.ok(m, 'cardTypesOf must exist in CollectionList.jsx');
  // eslint-disable-next-line no-new-func
  return new Function('CARD_TYPES', `${m[0]}\nreturn cardTypesOf;`)(CARD_TYPES);
})();

{
  const types = cardTypesOf(TONY);
  assert.ok(types.includes('Artifact'),
    'a DFC whose BACK face is an Artifact Creature must match the Artifact '
    + `filter -- got [${types.join(', ')}]`);
  assert.ok(types.includes('Creature'),
    'the front face types must still be present');
  pass('DFC-TC1', 'both faces contribute to the type filter');
}

// --- DFC-TC2 -----------------------------------------------------------------
{
  const types = cardTypesOf(BEAR);
  assert.deepEqual(types, ['Creature'],
    `a single-faced creature must not gain types -- got [${types.join(', ')}]`);
  pass('DFC-TC2', 'single-faced cards are unaffected');
}

// --- DFC-TC3 -----------------------------------------------------------------
// The search must cover the back face's name.
{
  const matches = (card, q) => !q
    || card.name.toLowerCase().includes(q)
    || (card.flavor_name || '').toLowerCase().includes(q)
    || (card.back_name || '').toLowerCase().includes(q);

  assert.ok(matches(TONY, 'invincible iron man'),
    'searching the back face name must find the card');
  assert.ok(matches(TONY, 'tony stark'), 'the front face name must still match');
  assert.ok(!matches(BEAR, 'invincible iron man'),
    'the search must not match unrelated cards');

  // And the shipped filter must actually consult back_name.
  assert.ok(/\(item\.back_name \|\| ''\)\.toLowerCase\(\)\.includes\(q\)/.test(SRC),
    'the collection search must match back_name -- both sides are printed on '
    + 'the card he is holding');
  pass('DFC-TC3', 'search covers the back face name');
}

// --- DFC-TC4 -----------------------------------------------------------------
// Guard the CAUSE, not the symptom: the old one-liner must not come back.
{
  const fn = SRC.match(/const cardTypesOf = \(card\) => \{[\s\S]*?\n\};/)[0];
  assert.ok(!/const line = \(card\.type_line \|\| ''\)\.split\('—'\)\[0\];/.test(fn),
    'cardTypesOf must not split on the em dash BEFORE splitting faces -- that '
    + 'is what hid the back face from the type filter');
  assert.ok(/type_line \|\| ''\)\.split\('\/\/'\)/.test(fn),
    'cardTypesOf must split the type line into faces first');
  pass('DFC-TC4', 'faces are split before types');
}

console.log(`dfc-filter.test.js: ${passed} cases passed`);
