// DO NOT RE-ARM AUTO-CAPTURE FROM AN ARTWORK FINGERPRINT.
//
// This test exists to stop a specific idea being rebuilt. It is a good idea in
// principle and it does not work on this hardware, and the only thing that
// separates those two statements is a measurement nobody will repeat by
// accident.
//
// THE IDEA. Geometry cannot answer "is the card on top of the stack a NEW
// card?" -- two cards in the same position produce the same quad. So compare a
// cheap brightness fingerprint of the artwork: same card scores low, different
// card scores high, and a high score re-arms capture. That would fix Zach's
// "I put down 3 forest in a row and it only scanned the 1st."
//
// WHY IT WAS REMOVED. Measured over 140 labelled scans from his real sessions
// (/var/lib/bindarr-dev/scandump, via tools/measure-artprint-corpus.cjs):
//
//     consecutive REAL captures, SAME card    min 9.0   p50 18.6   max 28.6
//     consecutive REAL captures, DIFF card    min 19.0  p50 39.0   max 67.8
//
// THE RANGES OVERLAP (19.0 < 28.6). No threshold separates them. At the shipped
// value of 10, the same card was called "different" in 7 of 9 cases, which is
// continuous rescanning of a card that never moved -- exactly what he reported:
// "The scanner just keeps scanning doesn't wait for a new card to be put down."
//
// THE TRAP, AND IT IS SUBTLE. The original measurement said same-card scored
// 1.3-2.4 against different-card 19.9-86.6 -- an eight-fold gap with nothing in
// it, which is why this looked safe. That measurement used SYNTHETIC
// consecutive frames, where only sensor noise differs. Real captures also
// differ by autofocus breathing, exposure drift, hand shadow and shifting
// glare, and those are an order of magnitude larger than noise. Anyone
// re-deriving the threshold from generated frames will get the same reassuring
// numbers and ship the same regression.
//
// So this test asserts the CORPUS MEASUREMENT, not an implementation. If
// someone wants to bring the feature back, these numbers have to be disproved
// on real scans first.
import assert from 'node:assert';

let passed = 0;
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// Measured on 140 labelled scans. Recorded here so the finding survives even if
// the scandump directory is pruned.
const CORPUS = {
  sameCard: { n: 9, min: 9.0, p50: 18.6, max: 28.6 },
  diffCard: { n: 130, min: 19.0, p50: 39.0, max: 67.8 },
};

// TC1: the two distributions overlap, so no single threshold can separate them.
{
  const overlaps = CORPUS.diffCard.min < CORPUS.sameCard.max;
  assert.ok(
    overlaps,
    'same-card and different-card fingerprint distances overlap on real scans; '
    + 'if this ever stops being true the feature can be reconsidered -- but only '
    + 'with a fresh corpus measurement, never with synthetic frames',
  );
  pass('NOAR-TC1', 'artwork distances overlap on real captures — no valid threshold');
}

// TC2: state the consequence in Zach's terms. At any threshold low enough to
// catch a real card change (<= 19.0), a large share of SAME-card pairs are
// misread as new -- continuous rescanning.
{
  const thresholdThatCatchesRealChanges = CORPUS.diffCard.min; // 19.0
  assert.ok(
    CORPUS.sameCard.p50 < thresholdThatCatchesRealChanges
      && CORPUS.sameCard.max > thresholdThatCatchesRealChanges,
    'a threshold low enough to catch real card changes also fires on cards that '
    + 'never moved',
  );
  pass('NOAR-TC2', 'any usable threshold causes nonstop rescanning');
}

// TC3: the shipped threshold of 10 sat BELOW the same-card median, so most
// still cards read as new. This is the number that reached Zach's phone.
{
  const SHIPPED = 10;
  assert.ok(
    SHIPPED < CORPUS.sameCard.p50,
    'the shipped threshold was below the median same-card distance, so the '
    + 'typical still card re-armed capture on every frame',
  );
  pass('NOAR-TC3', 'the shipped threshold (10) misread the median still card as new');
}

// TC4: the synthetic numbers that justified it are not comparable. Kept so the
// contrast is impossible to miss.
{
  const SYNTHETIC_SAME_MAX = 2.4;
  assert.ok(
    CORPUS.sameCard.min > SYNTHETIC_SAME_MAX * 3,
    'real same-card distances are several times larger than synthetic ones; '
    + 'synthetic frames cannot validate this threshold',
  );
  pass('NOAR-TC4', 'synthetic frames underestimate same-card distance badly');
}

console.log(`\nno-artwork-rearm.test.js: ${passed} cases passed`);
