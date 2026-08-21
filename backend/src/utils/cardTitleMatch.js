// Match an OCR'd card TITLE against the catalogue.
//
// WHY THIS FILE IS THE RISKIEST THING IN THE TEXT-FIRST PATH
//
// The collector-number path is safe almost by accident: a misread number is
// usually not a real collector number, so `card_cache` returns zero rows and
// the card queues. The CATALOGUE is the validator, and that is what PR 8 leaned
// on.
//
// A title cannot lean on that, because fuzzy matching DELIBERATELY accepts
// near-misses. Every character of slack handed out here is a chance that
// 'Fated Firepower' resolves to 'Fated Retribution' — a real catalogue row, a
// perfectly successful-looking add, and a card Zach does not own sitting in his
// collection with nothing to reconcile it against. There is no queue entry to
// catch that, because nothing ever admitted doubt.
//
// So the rule is the same one the rest of the scan pipeline follows: REFUSE
// rather than guess. Two independent gates, both of which must pass:
//
//   1. ABSOLUTE distance. The edit distance to the winner must be small in
//      absolute terms, so a long name cannot buy a large budget of errors.
//   2. MARGIN over the runner-up. If two catalogue names are nearly equally
//      close to the read, the read did not identify a card — it identified a
//      neighbourhood. Ambiguity here is a refusal, not a coin flip.
//
// Both numbers were MEASURED, not chosen. See tools/title-tolerance-sweep.js
// and the PR report: they are the widest values at which zero real OCR read in
// the corpus resolves to a wrong card.
//
// This module is PURE and knows nothing about the database. That is deliberate:
// the sweep and the tests drive it with explicit name lists, so what is measured
// is exactly what runs.

// Titles come off the card in mixed case with punctuation the catalogue also
// carries ("Lazav, Familiar Stranger", "Ajani's Pridemate") and diacritics it
// sometimes does ("Juzám Djinn", "Lim-Dûl's Vault"). OCR reproduces almost none
// of that reliably: it drops apostrophes, turns commas into periods, and
// flattens accents.
//
// So both sides are folded to a comparison form BEFORE distance is measured.
// Folding is applied to the CATALOGUE side too — never only to the read — or
// every accented card would be permanently unmatchable.
//
// NFD + combining-mark strip is what handles diacritics: 'á' decomposes to
// 'a' + U+0301, and the mark is removed. This is a comparison key only; the
// catalogue's own spelling is what gets returned and stored.
function normaliseTitle(raw) {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // The face separator is preserved as a space rather than deleted, so
    // 'Wear // Tear' folds to 'wear tear' and cannot collide with 'weartear'.
    .replace(/\/\//g, ' ')
    .toLowerCase()
    // Everything that is not a letter, digit or space is dropped: apostrophes,
    // commas, hyphens and the em-dashes OCR invents all vanish from BOTH sides,
    // so they can never contribute distance.
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Levenshtein with an EARLY-EXIT BOUND.
//
// The bound is not only a speed measure, though it is that: this runs against
// every name in the catalogue for a card. It is also a correctness aid — a
// caller asking "is this within 3?" gets `Infinity` for anything past 3 rather
// than a large number it might be tempted to compare against something else.
//
// Two rolling rows instead of a full matrix: the catalogue can be large and the
// full O(n*m) table buys nothing here.
function boundedDistance(a, b, max) {
  if (a === b) return 0;
  // A length gap alone already exceeds the budget — no alignment can recover.
  if (Math.abs(a.length - b.length) > max) return Infinity;
  if (!a.length) return b.length <= max ? b.length : Infinity;
  if (!b.length) return a.length <= max ? a.length : Infinity;

  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    // Every alignment through this row already costs more than the budget.
    if (rowMin > max) return Infinity;
    const t = prev; prev = cur; cur = t;
  }
  return prev[b.length] <= max ? prev[b.length] : Infinity;
}

// MEASURED TOLERANCES. tools/title-tolerance-sweep.js; table in the PR report.
//
// MAX_DISTANCE = 2. Chosen as the SMALLEST value that costs nothing, not the
// largest that seemed to get away with it, and the measurement is what changed
// my mind — I had written 3 first.
//
//   real OCR reads resolved correctly:  d=1 -> 14/15,  d=2 -> 15/15,  d=3+ -> 15/15
//
// So 2 already buys full accuracy on the corpus and 3 buys literally nothing.
// That alone would be reason enough, but there is a harder bound underneath it:
//
//   closest pair of REAL Scryfall names measured:  d=2
//     'Avatar of Woe'   <->  'Avatar of Hope'      d=2
//     'Sol Ring'        <->  'The Ring'            d=3
//     'Counterspell'    <->  'Countersquall'       d=3
//     'Skyclave Relic'  <->  'Skyclave Cleric'     d=3
//
// Distinct, unrelated, simultaneously-legal cards live 2-3 edits apart. Every
// unit of tolerance past that is a unit in which two REAL cards are
// indistinguishable, and the collection has no way to tell Zach which one it
// recorded. Spending slack that does not improve a single real read, in the
// exact range where real cards collide, would be paying in the only currency
// this project refuses to spend.
//
// MIN_MARGIN = 2 is the gate that actually does the work, because the dangerous
// case is not "the read was bad" — it is "the read was fine and two cards are
// named almost the same thing". Driving 420 adversarial reads along the edit
// path BETWEEN close real names:
//
//   minMargin=1 -> 52 refused    minMargin=2 -> 147 refused   minMargin=3 -> 172
//
// Zero of those resolved to a name that was not genuinely the closest at ANY
// setting, so no setting is outright broken. What the margin changes is what
// happens in the middle ground: at margin 1 the matcher commits on reads that
// sit between two names; at margin 2 it refuses them and the card queues, which
// is the outcome this project wants. Margin 3 refuses more without evidence it
// is refusing anything dangerous, and every extra refusal is a card Zach has to
// resolve by hand — so 2 is where the curve stops buying safety and starts
// buying tedium.
//
// Exact reads are unaffected by the margin (10/10 close-pair names still accept
// at every setting), because distance 0 bypasses it — see bestTitleMatch.
const MAX_DISTANCE = 2;
const MIN_MARGIN = 2;

// A floor on how much text must survive normalisation before a match is even
// attempted. Without it, a nearly-empty read like 'or' is within distance 3 of
// several short card names and would resolve. Distance alone cannot express
// "there was not enough here to identify anything".
const MIN_TITLE_CHARS = 4;

// Resolve an OCR'd title to exactly one catalogue name, or to null.
//
// Returns { name, distance, runnerUp } on a confident match, else null. NULL IS
// A NORMAL, FREQUENT AND CORRECT OUTCOME — the caller falls back to CLIP.
//
// `names` may contain duplicates (many printings share a name); ties on the
// SAME name are not ambiguity, so the margin is measured against the closest
// name that is genuinely DIFFERENT.
function bestTitleMatch(rawTitle, names, opts = {}) {
  const maxDistance = opts.maxDistance ?? MAX_DISTANCE;
  const minMargin = opts.minMargin ?? MIN_MARGIN;

  const read = normaliseTitle(rawTitle);
  if (read.length < MIN_TITLE_CHARS) return null;

  let best = null, bestD = Infinity, secondD = Infinity;
  for (const name of names) {
    const cand = normaliseTitle(name);
    if (!cand) continue;
    const d = boundedDistance(read, cand, maxDistance);
    if (d === Infinity) continue;
    if (d < bestD) {
      // The old winner becomes the runner-up only if it is a DIFFERENT name.
      if (best !== null && normaliseTitle(best) !== cand) secondD = bestD;
      best = name; bestD = d;
    } else if (normaliseTitle(best || '') !== cand && d < secondD) {
      secondD = d;
    }
  }

  if (best === null) return null;
  // An exact match (distance 0) is accepted regardless of what else is nearby:
  // the read reproduced a catalogue name character for character, and refusing
  // that because a similarly-named card exists would reject the clearest signal
  // this module can receive.
  if (bestD > 0 && secondD - bestD < minMargin) return null;

  // THE TRUNCATION GUARD, and it was found by the glare harness rather than by
  // reasoning — which is why the harness exists.
  //
  // Under a heavy highlight 'Sandstalker Moloch' read as 'Sandstalker A': the
  // second word was destroyed. That read is 2 edits from the catalogue name
  // 'Sandstalker' and 5 edits from the true 'Sandstalker Moloch', so plain
  // distance confidently picked THE WRONG CARD, with no runner-up close enough
  // for the margin gate to catch it. It was the single FALSE ADD in the whole
  // comparison, and a false add is the one outcome this project blocks on.
  //
  // Edit distance cannot see this hazard, because a truncated read is genuinely
  // NEARER the shorter name — that is what truncation means. The signal is
  // structural, not metric: the winner is a PREFIX of some other catalogue
  // name, so the read is equally consistent with "the short card" and with "the
  // long card, with its tail destroyed". Those are different cards.
  //
  // So when the winner is a strict prefix of another candidate, this refuses
  // and the card goes to the review queue with both options — the correct
  // outcome for an genuinely ambiguous read, and the one Zach asked for over
  // default-and-correct. This costs a queue entry in the rare case where the
  // short card really was the one photographed; it prevents silently recording
  // a card he does not own.
  // The guard applies ONLY to inexact matches. A read of exactly 'Sandstalker'
  // (distance 0) reproduced that name character for character and IS that card;
  // refusing it because a longer name starts the same way would make every
  // short card permanently unscannable. Truncation always leaves residue — the
  // destroyed tail reads as something ('Sandstalker A'), which is why the real
  // failure had distance 2 rather than 0.
  const winner = normaliseTitle(best);
  if (bestD > 0) {
    for (const name of names) {
      const cand = normaliseTitle(name);
      if (cand.length > winner.length && cand.startsWith(`${winner} `)) return null;
    }
  }
  return { name: best, distance: bestD, runnerUp: secondD === Infinity ? null : secondD };
}

module.exports = {
  normaliseTitle,
  boundedDistance,
  bestTitleMatch,
  MAX_DISTANCE,
  MIN_MARGIN,
  MIN_TITLE_CHARS,
};
