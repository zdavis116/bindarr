// THE OCR HINT MAY MAKE VERIFICATION STOP EARLIER. IT MAY NEVER CHANGE WHICH
// CARD WINS.
//
// Zach asked the question this whole change came from: "Do you really need orb?
// Like what is orb buying you if set code and number give you the exact card."
//
// The measured answer was: yes, ORB is load-bearing. On his 208-scan corpus the
// printed collector number is right 81% of the time -- but on 10 scans it read a
// CONFIDENT, WRONG printing, and ORB's top candidate contradicted every one of
// them. Dropping ORB would have silently recorded a wrong card on ~5% of scans,
// which is the recount failure he cannot afford.
//
// So the number is used as a STOP CONDITION only:
//
//   hintFirst()  verifies the candidate the number names BEFORE the others
//   the break    stops once artwork and printed text agree on the same printing
//
// Neither adds, removes, or reorders the RESULT. `scored` is sorted by inliers
// afterwards regardless of visit order, so the only observable effect is where
// the loop stops.
//
// These cases pin that invariant, because the failure mode of getting it wrong
// is not a crash -- it is an occasionally wrong card, months later, discovered
// against physical cardboard.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/^0+/, '');

// The production reorder, mirrored. A stable partition: hint matches first,
// everything else in its original order.
function hintFirst(recall, hint) {
  if (!hint) return recall;
  const hit = [];
  const rest = [];
  for (const c of recall) {
    if (hint.numbers.includes(norm(c.number)) && hint.sets.includes(norm(c.set))) hit.push(c);
    else rest.push(c);
  }
  return hit.length ? hit.concat(rest) : recall;
}

// The verify loop's shape: walk in order, score each, stop on agreement.
// `inliersOf` stands in for the real geometric matcher.
// The break requires CERTAIN_INLIERS, not a lower "they agree" floor.
// TC9 below is why: at 35 a wrong hint could win outright.
const CERTAIN_INLIERS = 80;
function verify(recall, hint, inliersOf) {
  const ordered = hintFirst(recall, hint);
  const scored = [];
  let visited = 0;
  for (const cand of ordered) {
    visited += 1;
    const inliers = inliersOf(cand);
    scored.push({ ...cand, inliers });
    if (hint && inliers >= CERTAIN_INLIERS
        && hint.numbers.includes(norm(cand.number))
        && hint.sets.includes(norm(cand.set))) break;
  }
  scored.sort((a, b) => b.inliers - a.inliers);
  return { winner: scored[0], visited };
}

const RECALL = [
  { set: 'lea', number: '1' },
  { set: 'c21', number: '263' },
  { set: 'msh', number: '233' },   // the truth, deliberately buried
  { set: 'zen', number: '131' },
  { set: 'neo', number: '401' },
];
// Realistic: only the true card matches the artwork strongly.
const inliersOf = (c) => (c.set === 'msh' && c.number === '233' ? 120 : 8);

// TC1: with no hint, the winner is whatever ORB scores highest. Baseline.
{
  const { winner, visited } = verify(RECALL, null, inliersOf);
  assert.strictEqual(`${winner.set}#${winner.number}`, 'msh#233');
  assert.strictEqual(visited, 5, 'without a hint every candidate is verified');
  pass('OHINT-TC1', 'no hint: full walk, ORB picks the winner');
}

// TC2: a CORRECT hint promotes the truth and stops immediately -- same winner,
// far less work. This is the entire speed argument.
{
  const hint = { sets: ['msh'], numbers: ['233'] };
  const { winner, visited } = verify(RECALL, hint, inliersOf);
  assert.strictEqual(`${winner.set}#${winner.number}`, 'msh#233', 'same winner as TC1');
  assert.strictEqual(visited, 1, 'the named card is verified first and ends the search');
  pass('OHINT-TC2', 'correct hint: identical winner, one verification');
}

// TC3: THE ONE THAT MATTERS. A WRONG hint must not change the winner.
//
// This models Zach's real failure: the strip read 'msh#213' while the card was
// msh#432. The promoted candidate does not match the artwork, so its inlier
// count stays low, the break never fires, and the full walk continues.
{
  const recall = [...RECALL, { set: 'msh', number: '213' }];
  const hint = { sets: ['msh'], numbers: ['213'] };   // confident, and wrong
  const { winner, visited } = verify(recall, hint, inliersOf);
  assert.strictEqual(`${winner.set}#${winner.number}`, 'msh#233',
    'a wrong hint must NOT be able to win -- this is the recount failure');
  assert.strictEqual(visited, 6, 'and the search is not cut short');
  pass('OHINT-TC3', 'wrong hint costs time, never correctness');
}

// TC4: a hint naming a card that is not in the recall list is inert.
// Measured: this is ~36% of scans, where CLIP never recalled the true printing.
{
  const hint = { sets: ['xyz'], numbers: ['999'] };
  const a = verify(RECALL, null, inliersOf);
  const b = verify(RECALL, hint, inliersOf);
  assert.deepStrictEqual(b.winner, a.winner, 'an absent hint changes nothing');
  assert.strictEqual(b.visited, a.visited);
  pass('OHINT-TC4', 'a hint for a card not recalled is a no-op');
}

// TC5: THE NOISE FLOOR IS LOAD-BEARING. A candidate matching the hint but
// scoring like noise must NOT end the search: agreement between a guess and a
// reading is not agreement. Without this floor a 3-inlier coincidence on the
// right number would stop verification and hand back a wrong card.
{
  const recall = [{ set: 'msh', number: '233' }, { set: 'c21', number: '263' }];
  const hint = { sets: ['msh'], numbers: ['233'] };
  const weak = (c) => (c.set === 'msh' ? 3 : 90);   // hint match is noise
  const { winner, visited } = verify(recall, hint, weak);
  assert.strictEqual(`${winner.set}#${winner.number}`, 'c21#263',
    'a noise-level match on the hinted number must not win');
  assert.strictEqual(visited, 2, 'and must not stop the search');
  pass('OHINT-TC5', 'a noise-level hint match neither wins nor stops the search');
}

// TC6: leading zeros. The card prints '0207'; the catalogue stores '207'.
// Comparing them raw would silently disable the whole optimisation.
{
  const recall = [{ set: 'tla', number: '207' }];
  const hint = { sets: ['tla'], numbers: [norm('0207')] };
  const { visited } = verify(recall, hint, () => 120);
  assert.strictEqual(visited, 1, "'0207' from the card must match '207' in the catalogue");
  pass('OHINT-TC6', 'leading zeros are normalised on both sides');
}

// TC7: the reorder is STABLE for non-matching candidates. If it shuffled the
// rest, two runs could visit a different subset before stopping and produce
// different results from identical inputs.
{
  const hint = { sets: ['msh'], numbers: ['233'] };
  const ordered = hintFirst(RECALL, hint);
  assert.strictEqual(`${ordered[0].set}#${ordered[0].number}`, 'msh#233');
  assert.deepStrictEqual(
    ordered.slice(1).map(c => `${c.set}#${c.number}`),
    ['lea#1', 'c21#263', 'zen#131', 'neo#401'],
    'the remaining candidates keep their original relative order',
  );
  pass('OHINT-TC7', 'the reorder is stable for everything it does not promote');
}

// TC8: THE MIRROR MUST NOT DRIFT FROM PRODUCTION.
//
// Everything above models verifyGame's loop rather than importing it --
// scanMatch.js pulls in opencv-wasm and a 57k-card ORB index at require time,
// which is far too heavy for a unit test. That modelling is a real weakness: if
// the production break gains a condition, or the noise floor moves, these cases
// keep passing while testing a function that no longer exists.
//
// So the source itself is checked for the two things the model depends on.
// Crude, and it beats a green suite that proves nothing.
{
  const src = readFileSync(join(here, '..', 'src', 'scanMatch.js'), 'utf8');

  const certain = /const CERTAIN_INLIERS = (\d+);/.exec(src);
  assert.ok(certain, 'production must define CERTAIN_INLIERS');
  assert.strictEqual(
    Number(certain[1]), CERTAIN_INLIERS,
    `the certainty threshold moved in production (${certain[1]}) but not in `
    + `this test (${CERTAIN_INLIERS}) -- TC9 is now testing a threshold that `
    + 'does not ship',
  );
  assert.ok(
    !/HINT_AGREE_INLIERS/.test(src),
    'the separate low agreement floor must stay deleted -- it let a wrong '
    + 'collector number win outright (see TC9)',
  );

  // The break must still require BOTH an inlier floor AND set+number agreement.
  // Losing any one of these silently converts a stop condition into a way for a
  // misread number to end the search early.
  assert.ok(/ocrHint && inliers >= CERTAIN_INLIERS/.test(src),
    'the hint break must gate on CERTAIN_INLIERS, not a lower floor');
  assert.ok(
    /ocrHint && inliers >= CERTAIN_INLIERS\s*\n\s*&& !BASIC_LAND_NAMES/.test(src),
    'basic lands must be excluded from the hint break -- dozens of Forest '
    + 'printings all score 80+, so the first is not the best',
  );
  assert.ok(/ocrHint\.numbers\.includes\(normHint\(cand\.number\)\)/.test(src),
    'the agreement break must still require the NUMBER to match');
  assert.ok(/ocrHint\.sets\.includes\(normHint\(cand\.set\)\)/.test(src),
    'the agreement break must still require the SET to match');

  // hintFirst must still be a stable partition that returns the ORIGINAL list
  // when nothing matches -- TC4 and TC7 both depend on it.
  assert.ok(/return hit\.length \? hit\.concat\(rest\) : recall;/.test(src),
    'hintFirst must still return the untouched recall list when nothing matches');

  pass('OHINT-TC8', 'the production break and noise floor match what these cases model');
}

// TC9: THE REVIEW BLOCKER. A wrong hint must not be able to WIN.
//
// The first version of this break used a 35-inlier floor and this file did not
// catch it, because TC3 only models a wrongly-hinted candidate scoring 8 --
// deep in the noise band, where any floor rejects it. Code review found the
// real hole and it reproduced immediately:
//
//   recall: [.., msh#213 (OCR's WRONG read, 40), .., msh#432 (TRUE, 60)]
//   no hint    -> msh#432 wins  (visits 4)
//   wrong hint -> msh#213 WINS  (visits 1)   <-- a wrong card, recorded
//
// The safety argument was "scored is sorted afterwards, so visit order cannot
// change the winner". That is only true while the loop visits the SAME SET of
// candidates. The break truncates the set; hintFirst decides what falls inside
// the truncation. The winner is max(inliers) over the VISITED PREFIX.
//
// 40 inliers is NOT noise -- measured right matches run 35-162 -- so a wrong
// card scoring 40 sits inside the legitimate band and no floor in that range
// could exclude it. And OCR reads a confident wrong printing on ~5% of scans.
//
// This is the case that must fail if anyone lowers the threshold again.
{
  const recall = [
    { set: 'lea', number: '1' },
    { set: 'msh', number: '213' },   // what OCR wrongly read
    { set: 'c21', number: '263' },
    { set: 'msh', number: '432' },   // the card actually photographed
  ];
  const inliers = (c) => {
    if (c.set === 'msh' && c.number === '432') return 60;   // true card
    if (c.set === 'msh' && c.number === '213') return 40;   // wrong, but plausible
    return 8;
  };
  const clean = verify(recall, null, inliers);
  const hinted = verify(recall, { sets: ['msh'], numbers: ['213'] }, inliers);

  assert.strictEqual(`${clean.winner.set}#${clean.winner.number}`, 'msh#432',
    'without a hint the true card wins on inliers');
  assert.strictEqual(
    `${hinted.winner.set}#${hinted.winner.number}`, 'msh#432',
    'A CONFIDENTLY WRONG NUMBER MUST NOT WIN. If this fails, a misread '
    + 'collector number silently records the wrong card in the collection -- '
    + 'the recount failure. Lowering the break threshold reintroduces it.',
  );
  pass('OHINT-TC9', 'a mid-band wrong hint cannot beat a stronger true match');
}

// TC10: and the speed win still exists -- a CORRECT hint on a strong match
// still stops after one verification. Without this, TC9 could be "fixed" by
// disabling the optimisation entirely and nothing would notice.
{
  const recall = [
    { set: 'lea', number: '1' },
    { set: 'c21', number: '263' },
    { set: 'msh', number: '432' },
  ];
  const inliers = (c) => (c.set === 'msh' && c.number === '432' ? 120 : 8);
  const clean = verify(recall, null, inliers);
  const hinted = verify(recall, { sets: ['msh'], numbers: ['432'] }, inliers);
  assert.strictEqual(`${hinted.winner.set}#${hinted.winner.number}`, 'msh#432');
  assert.ok(hinted.visited < clean.visited,
    'a correct hint on a strong match must still short-circuit the walk');
  assert.strictEqual(hinted.visited, 1, 'and it should stop on the first candidate');
  pass('OHINT-TC10', 'a correct hint on a strong match still stops immediately');
}

console.log(`\nocr-hint-safety.test.js: ${passed} cases passed`);
