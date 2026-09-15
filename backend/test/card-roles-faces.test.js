// PER-FACE ROLES.
//
// Zach: "for cards like sagu wildling with roast seek. Roost Seek is being
// considered a threat when its ramp I believe. So cards like that, that have 2
// different types should reflect appropriately."
//
// The role was derived ONCE per oracle_id from the JOINED type line. For
// 'Creature - Dragon // Sorcery - Omen' that string contains 'creature', so
// the card was a Threat -- and the curve then painted the Sorcery half as a
// Threat too. Measured on the dev catalogue: EVERY adventure and prepare card
// was a Threat on both faces.
//
// Run: node backend/test/card-roles-faces.test.js

const assert = require('assert');
const { rolesForFaces, roleForCard, ROLE_ROOTS } = require('../src/cardRoles');

let passed = 0;
const pass = (id, what) => { console.log(`PASS: ${id} ${what}`); passed += 1; };

// A stand-in tag universe: the real one is built from Scryfall's tag file, but
// the judgement under test is the TYPE LINE, not the tags.
const families = new Map([
  ['ramp', new Set(['search-for-basic-land', 'mana-rock'])],
  ['removal', new Set(['damage-creature'])],
  ['draw', new Set(['cantrip'])],
]);
for (const { role } of ROLE_ROOTS) {
  if (!families.has(role)) families.set(role, new Set());
}

// --- CRF-TC1 -----------------------------------------------------------------
// The bug exactly as Zach reported it.
{
  const sagu = {
    typeLine: 'Creature — Dragon // Sorcery — Omen',
    oracleText: [
      '=== Sagu Wildling ===',
      'Flying',
      '',
      '=== Roost Seek ===',
      'Search your library for a basic land card, reveal it, put it into your hand.',
    ].join('\n'),
    tagSlugs: new Set(['search-for-basic-land']),
    families,
  };

  const { role, backRole } = rolesForFaces(sagu);
  assert.strictEqual(role, 'threat', 'the Dragon half is a threat');
  assert.strictEqual(backRole, 'ramp',
    'Roost Seek searches for a land -- it is ramp, not a threat');

  // And the OLD behaviour, to show what changed: the joined type line makes
  // the whole card a threat because it contains the word "creature".
  const joined = roleForCard(sagu);
  assert.strictEqual(joined.role, 'threat',
    'the joined type line is why both faces used to be threats');

  pass('CRF-TC1', "an Adventure's spell half is classified on its own type line");
}

// --- CRF-TC2 -----------------------------------------------------------------
// Single-faced cards must be untouched.
{
  const bolt = {
    typeLine: 'Instant',
    oracleText: 'Lightning Bolt deals 3 damage to any target.',
    tagSlugs: new Set(['damage-creature']),
    families,
  };
  const r = rolesForFaces(bolt);
  assert.strictEqual(r.role, 'removal');
  assert.strictEqual(r.backRole, null, 'no second face, no second role');

  const bear = {
    typeLine: 'Creature — Bear',
    oracleText: '',
    tagSlugs: new Set(),
    families,
  };
  assert.strictEqual(rolesForFaces(bear).role, 'threat');
  assert.strictEqual(rolesForFaces(bear).backRole, null);

  pass('CRF-TC2', 'single-faced cards keep exactly one role');
}

// --- CRF-TC3 -----------------------------------------------------------------
// A modal DFC whose BOTH faces are creatures stays a threat on both -- the fix
// must not invent variety where there is none.
{
  const tony = {
    typeLine: 'Legendary Creature — Human // Legendary Artifact Creature — Human',
    oracleText: '=== Tony Stark ===\nLook at the top four.\n\n=== The Invincible Iron Man ===\nFlying, haste',
    tagSlugs: new Set(),
    families,
  };
  const r = rolesForFaces(tony);
  assert.strictEqual(r.role, 'threat');
  assert.strictEqual(r.backRole, 'threat', 'both faces are creatures');

  pass('CRF-TC3', 'two creature faces are both threats');
}

// --- CRF-TC4 -----------------------------------------------------------------
// The text must be split per face too, not just the type line: a creature face
// that taps for mana is ramp, and that judgement reads the RULES text.
{
  const card = {
    typeLine: 'Creature — Elf Druid // Sorcery',
    oracleText: '=== Llanowar Elves ===\n{T}: Add {G}.\n\n=== Some Spell ===\nDraw a card.',
    tagSlugs: new Set(['mana-rock', 'cantrip']),
    families,
  };
  const r = rolesForFaces(card);
  assert.strictEqual(r.role, 'ramp',
    'the creature half taps for mana, so it is ramp -- read from ITS text');
  assert.strictEqual(r.backRole, 'draw', 'the sorcery half is a cantrip');

  pass('CRF-TC4', 'rules text is split per face, not shared');
}

// --- CRF-TC6 -----------------------------------------------------------------
// THE BACK FACE'S OWN RULES TEXT MUST DECIDE ITS ROLE.
//
// Mutation-testing caught that CRF-TC4 did not prove this: its back face is a
// Sorcery, which is not a creature, so it falls through to the card-level tags
// and the front face's text never mattered.
//
// The text is only load-bearing when the back face IS a creature, because then
// roleForCard reads the rules to tell "taps for mana" ramp from a threat. Give
// it the wrong face's text and you get the wrong role.
{
  const card = {
    // Front: a creature that taps for mana. Back: a creature that does not.
    typeLine: 'Creature — Elf Druid // Creature — Beast',
    oracleText: '=== Front Elf ===\n{T}: Add {G}.\n\n=== Back Beast ===\nTrample',
    tagSlugs: new Set(['mana-rock']),
    families,
  };
  const r = rolesForFaces(card);
  assert.strictEqual(r.role, 'ramp', 'the front taps for mana');
  assert.strictEqual(r.backRole, 'threat',
    'the back face does NOT tap for mana -- reading the front face text here '
    + 'would wrongly call it ramp');

  pass('CRF-TC6', "a creature back face is judged on ITS own rules text");
}

// --- CRF-TC5 -----------------------------------------------------------------
// Malformed or missing text must not throw or silently blank a role.
{
  const noHeaders = {
    typeLine: 'Creature — Giant // Instant',
    oracleText: 'all one blob with no headers',
    tagSlugs: new Set(['damage-creature']),
    families,
  };
  const r = rolesForFaces(noHeaders);
  assert.strictEqual(r.role, 'threat');
  assert.strictEqual(r.backRole, 'removal',
    'without headers the type line still decides, and tags still apply');

  assert.doesNotThrow(() => rolesForFaces({
    typeLine: null, oracleText: null, tagSlugs: new Set(), families,
  }));

  pass('CRF-TC5', 'missing or unheadered text degrades safely');
}

console.log(`card-roles-faces.test.js: ${passed} cases passed`);
