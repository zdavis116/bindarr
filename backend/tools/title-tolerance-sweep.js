// MEASURE the fuzzy-title tolerance. Run: node tools/title-tolerance-sweep.js
//
// This is the parameter that decides whether a near-miss title silently records
// a card Zach does not own, so it is measured against DELIBERATE near-misses
// rather than chosen for looking reasonable.
//
// Two populations, and both matter:
//
//   REAL READS   the 15 actual OCR outputs from the corpus at the chosen band.
//                A tolerance that rejects these is useless.
//   ADVERSARIAL  hand-built corruptions at known edit distances, plus pairs of
//                REAL Scryfall card names that are genuinely close to each
//                other. A tolerance that accepts a wrong one of these is
//                DANGEROUS, which is strictly worse than useless.
//
// The reported answer is the largest tolerance at which zero adversarial case
// resolves to a wrong name.
const { bestTitleMatch, normaliseTitle, boundedDistance } = require('../src/utils/cardTitleMatch');

// Real reads observed at left 0.06 / top 0.052 / width 0.64 / height 0.060.
const REAL_READS = [
  ['Fated Firepower', 'Fated Firepower'],
  ['(a) Avatar Aang', 'Avatar Aang'],
  ['Sol Ring', 'Sol Ring'],
  ['Counterspell', 'Counterspell'],
  ['Spinning Wheel Kick', 'Spinning Wheel Kick'],
  ['Llanowar Elves', 'Llanowar Elves'],
  ['| Skyclave Relic', 'Skyclave Relic'],
  ['Llanowar Wastes', 'Llanowar Wastes'],
  ['Lattice-Blade Mantis', 'Lattice-Blade Mantis'],
  ['Sandstalker Moloch', 'Sandstalker Moloch'],
  ['The One Ring', 'The One Ring'],
  ['Faunsbane Troll', 'Faunsbane Troll'],
  ['Faerie Snoop', 'Faerie Snoop'],
  ['( Lazav, Familiar Stranger', 'Lazav, Familiar Stranger'],
  ['Wear Down', 'Wear Down'],
];

// Real Scryfall names, including families that are close to each other. These
// are the names a wrong resolution would land on.
const CATALOGUE = [
  'Fated Firepower', 'Fated Retribution', 'Fated Conflagration', 'Fated Infatuation',
  'Avatar Aang', 'Avatar of Woe', 'Avatar of Hope', 'Avatar of Might',
  'Sol Ring', 'Sol Talisman', 'Sole Performer',
  'Counterspell', 'Counterflux', 'Countersquall', 'Counterlash',
  'Spinning Wheel Kick', 'Spinning Darkness', 'Spinning Wheel',
  'Llanowar Elves', 'Llanowar Scout', 'Llanowar Wastes', 'Llanowar Visionary',
  'Llanowar Tribe', 'Llanowar Mentor', 'Llanowar Empath',
  'Skyclave Relic', 'Skyclave Shade', 'Skyclave Cleric', 'Skyclave Apparition',
  'Lattice-Blade Mantis', 'Lattice Kraken',
  'Sandstalker Moloch', 'Sandstalker',
  'The One Ring', 'The One Ring Bearer', 'The Ring', 'The Hive',
  'Faunsbane Troll', 'Faunsbane',
  'Faerie Snoop', 'Faerie Mastermind', 'Faerie Miscreant', 'Faerie Vandal',
  'Lazav, Familiar Stranger', 'Lazav, Dimir Mastermind', 'Lazav, the Multifarious',
  'Wear Down', 'Wear // Tear', 'Weather the Storm',
  'Doom Blade', 'Dark Ritual', 'Giant Growth', 'Shock', 'Opt', 'Ponder',
];

// Corruptions of REAL names. THE FIRST VERSION OF THIS WAS USELESS and it is
// worth recording why, because it reported a reassuring zero.
//
// It replaced characters with 'x', which moves a name AWAY from every catalogue
// entry at once. Nothing ever resolved wrong because nothing was ever pulled
// TOWARD a wrong answer — it measured refusal, not confusion, and scored 0
// dangerous at every tolerance including absurd ones. A test that passes at
// maxDistance=6 is not testing the thing that fails.
//
// The real hazard is directional: OCR drops or mangles a few characters and the
// result lands nearer a DIFFERENT real card than the one photographed. Section
// C shows real Scryfall names as close as d=2 ('Avatar of Woe' / 'Avatar of
// Hope'), so this walks each name TOWARD its nearest neighbour one character at
// a time and asks what the matcher does at each step.
function stepsToward(from, to) {
  // Intermediate strings on the edit path from `from` to `to`: prefix of the
  // target grafted onto the tail of the source. Crude, but it produces exactly
  // the shape that matters — a read that is partly one name and partly another.
  const out = [];
  const a = from, b = to;
  for (let k = 1; k < Math.max(a.length, b.length); k++) {
    const mixed = b.slice(0, k) + a.slice(k);
    if (mixed !== a && mixed !== b) out.push(mixed);
  }
  return out;
}

// Every ordered pair of catalogue names within edit distance 6 of each other.
// These are the pairs that can actually be confused.
function closePairs(maxD) {
  const pairs = [];
  for (let i = 0; i < CATALOGUE.length; i++) {
    for (let j = 0; j < CATALOGUE.length; j++) {
      if (i === j) continue;
      const d = boundedDistance(normaliseTitle(CATALOGUE[i]), normaliseTitle(CATALOGUE[j]), maxD);
      if (d !== Infinity) pairs.push([CATALOGUE[i], CATALOGUE[j], d]);
    }
  }
  return pairs;
}

function report() {
  console.log('=== A. REAL READS: how many resolve correctly, per tolerance ===');
  console.log('maxDist  minMargin  correct  wrong  refused');
  for (const maxDistance of [1, 2, 3, 4, 5, 6]) {
    for (const minMargin of [1, 2, 3]) {
      let ok = 0, wrong = 0, refused = 0;
      for (const [read, truth] of REAL_READS) {
        const m = bestTitleMatch(read, CATALOGUE, { maxDistance, minMargin });
        if (!m) refused++;
        else if (m.name === truth) ok++;
        else wrong++;
      }
      console.log(`  ${maxDistance}        ${minMargin}        ${String(ok).padStart(2)}/15    ${wrong}      ${refused}`);
    }
  }

  console.log('\n=== B. ADVERSARIAL: reads pulled TOWARD a different real card ===');
  console.log('Each case is a string on the edit path between two real names.');
  console.log('SAFE   = resolves to the name it is still closest to, or refuses.');
  console.log('WRONG  = resolves to a name it is NOT closest to (a silent wrong card).\n');
  console.log('maxDist  minMargin   cases  refused  WRONG');
  const pairs = closePairs(6);
  const cases = [];
  for (const [from, to] of pairs) {
    for (const mixed of stepsToward(from, to)) cases.push({ mixed, from, to });
  }  for (const maxDistance of [1, 2, 3, 4, 5, 6]) {
    for (const minMargin of [1, 2, 3]) {
      let refused = 0, safe = 0; const wrong = [];
      for (const { mixed } of cases) {
        const m = bestTitleMatch(mixed, CATALOGUE, { maxDistance, minMargin });
        if (!m) { refused++; continue; }
        // The honest question: of ALL catalogue names, is the one it picked
        // genuinely the closest? If something else is strictly closer, the
        // matcher chose wrong.
        const rd = normaliseTitle(mixed);
        let bestD = Infinity, bestName = null;
        for (const n of CATALOGUE) {
          const d = boundedDistance(rd, normaliseTitle(n), 40);
          if (d < bestD) { bestD = d; bestName = n; }
        }
        if (m.name === bestName) safe++;
        else wrong.push(`"${mixed}" -> ${m.name} (closest was ${bestName})`);
      }
      console.log(`  ${maxDistance}        ${minMargin}        ${cases.length}    ${String(refused).padStart(4)}   ${wrong.length}${wrong.length ? '  e.g. ' + wrong[0] : ''}`);
    }
  }

  console.log('\n=== B2. THE CASE THAT DECIDES IT: distinct cards within tolerance ===');
  console.log('For each close pair, is the TRUE name still separable from its');
  console.log('neighbour after the read loses characters? This is the margin gate.\n');
  for (const minMargin of [1, 2, 3]) {
    let picked = 0, refusedAmbiguous = 0;
    for (const [from, to, d] of closePairs(3)) {
      if (d === 0) continue;
      // A read that is EXACTLY the true name, with a neighbour d away.
      const m = bestTitleMatch(from, CATALOGUE, { maxDistance: 3, minMargin });
      if (m && m.name === from) picked++; else refusedAmbiguous++;
      void to;
    }
    console.log(`  minMargin=${minMargin}: exact reads accepted ${picked}, refused ${refusedAmbiguous}`);
  }

  console.log('\n=== C. NEAREST-NEIGHBOUR distances within the real catalogue ===');
  console.log('How close do REAL card names get to each other? This bounds any');
  console.log('tolerance: a tolerance at or above the closest pair can confuse them.\n');
  const nnPairs = [];
  for (let i = 0; i < CATALOGUE.length; i++) {
    for (let j = i + 1; j < CATALOGUE.length; j++) {
      const a = normaliseTitle(CATALOGUE[i]), b = normaliseTitle(CATALOGUE[j]);
      const d = boundedDistance(a, b, 8);
      if (d !== Infinity) nnPairs.push([d, CATALOGUE[i], CATALOGUE[j]]);
    }
  }
  nnPairs.sort((x, y) => x[0] - y[0]);
  for (const [d, a, b] of nnPairs.slice(0, 12)) console.log(`  d=${d}  ${a}  <->  ${b}`);
}

report();
