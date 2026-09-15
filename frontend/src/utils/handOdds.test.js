// THE HAND-ODDS MATH IS CHECKED AGAINST SIMULATION, NOT AGAINST ITSELF.
//
// A closed-form probability that merely LOOKS like the textbook formula is not
// evidence -- an off-by-one in the complement, or choose() overflowing, would
// still produce plausible percentages. So the headline case is verified by
// actually dealing hands.
//
// Run: node --test frontend/src/utils/handOdds.test.js

import test from 'node:test';
import assert from 'node:assert';
import { probAtLeast, cardsSeenByTurn, probLandsByTurn } from './handOdds.js';

// Deterministic PRNG so a failure is reproducible. Math.random() would make
// this test flaky at the boundary, and a flaky test gets disabled.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function simulate(library, lands, drawn, need, trials, seed) {
  const rng = makeRng(seed);
  let hits = 0;
  for (let t = 0; t < trials; t += 1) {
    // Partial Fisher-Yates: only shuffle the cards we actually draw.
    const deck = new Uint8Array(library);
    deck.fill(1, 0, lands);
    let got = 0;
    for (let i = 0; i < drawn; i += 1) {
      const j = i + Math.floor(rng() * (library - i));
      const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
      got += deck[i];
    }
    if (got >= need) hits += 1;
  }
  return hits / trials;
}

test('HO-TC1: matches a Monte Carlo simulation', () => {
  const cases = [
    [99, 37, 9, 3],    // EDH, three lands by turn three
    [99, 38, 7, 3],    // opening hand
    [99, 35, 11, 5],   // turn five
    [60, 24, 7, 1],    // a 60-card deck, at least one land
  ];
  for (const [lib, lands, drawn, need] of cases) {
    const formula = probAtLeast(lib, lands, drawn, need);
    const sim = simulate(lib, lands, drawn, need, 200000, 12345);
    assert.ok(Math.abs(formula - sim) < 0.01,
      `${lib}/${lands} draw ${drawn} need ${need}: formula ${(formula * 100).toFixed(2)}% `
      + `vs simulated ${(sim * 100).toFixed(2)}% -- more than 1pp apart`);
  }
});

test('HO-TC2: the degenerate cases are exact, not approximately right', () => {
  assert.equal(probAtLeast(99, 99, 7, 3), 1, 'an all-land deck always has lands');
  assert.equal(probAtLeast(99, 0, 7, 1), 0, 'a deck with no lands never has one');
  assert.equal(probAtLeast(99, 37, 7, 0), 1, 'needing zero lands is certain');
  assert.equal(probAtLeast(99, 37, 7, 8), 0, 'cannot have 8 lands in 7 cards');
  assert.equal(probAtLeast(0, 0, 7, 1), 0, 'an empty library cannot deliver');
});

test('HO-TC3: probabilities stay inside 0..1', () => {
  // Floating point can push the complement a hair outside the range, and a
  // "100.4%" on screen would discredit every number beside it.
  for (let lands = 0; lands <= 99; lands += 1) {
    for (let turn = 1; turn <= 8; turn += 1) {
      const p = probLandsByTurn(99, lands, turn);
      assert.ok(p >= 0 && p <= 1, `${lands} lands turn ${turn} gave ${p}`);
    }
  }
});

test('HO-TC4: more lands is never worse', () => {
  // Monotonicity catches a whole class of indexing errors that still produce
  // numbers in the right ballpark.
  for (let turn = 1; turn <= 6; turn += 1) {
    let previous = -1;
    for (let lands = 20; lands <= 45; lands += 1) {
      const p = probLandsByTurn(99, lands, turn);
      assert.ok(p >= previous - 1e-12,
        `turn ${turn}: ${lands} lands (${p}) was worse than ${lands - 1} (${previous})`);
      previous = p;
    }
  }
});

test('HO-TC5: later turns are harder, because you need MORE lands', () => {
  // Each turn needs one more land than the last but only draws one more card,
  // so the odds must fall. If this ever rises, the "need" and "drawn" terms
  // have been transposed.
  let previous = 2;
  for (let turn = 1; turn <= 6; turn += 1) {
    const p = probLandsByTurn(99, 37, turn);
    assert.ok(p < previous, `turn ${turn} (${p}) was not harder than turn ${turn - 1} (${previous})`);
    previous = p;
  }
});

test('HO-TC6: ON THE PLAY -- no draw step on turn one', () => {
  // The pessimistic reading, on purpose: in a four-player game you are on the
  // play once in four, and the on-the-draw number is up to 9.7pp friendlier.
  // Quoting the better one would flatter every deck.
  assert.equal(cardsSeenByTurn(1), 7, 'turn one is the opening hand, no draw');
  assert.equal(cardsSeenByTurn(2), 8);
  assert.equal(cardsSeenByTurn(5), 11);
  assert.equal(cardsSeenByTurn(1, 6), 6, 'a mulligan-to-six hand is six cards');
});

test('HO-TC7: choose() survives the numbers a real deck needs', () => {
  // 99! overflows a double many times over; choose() must not compute it. If
  // this returns Infinity or NaN the probabilities silently become garbage.
  const c = probAtLeast(99, 37, 16, 6);
  assert.ok(Number.isFinite(c) && c > 0 && c < 1,
    `C(99,16)-scale case returned ${c}`);
});
