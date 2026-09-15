// HOW OFTEN YOU ACTUALLY HAVE THE LANDS.
//
// The "castable by turn N" chart used to assume you hit every land drop. Zach:
// "Technically if I draw only 1 land by turn 2 I still can't play 2 mana cards.
// So I think it shows a decent picture but not 100%."
//
// He is right, and the assumption was doing all the work while being invisible.
// This replaces it with the real probability.
//
// THE MATH
//
// Drawing cards is sampling WITHOUT replacement, so the distribution is
// hypergeometric, not binomial. For a library of N cards containing K lands,
// drawing n of them:
//
//   P(exactly k lands) = C(K,k) * C(N-K, n-k) / C(N,n)
//
// and P(at least k) is 1 minus the sum of the cases below k. Computing the
// complement matters: summing from k upward to n is many more terms, and each
// is a ratio of huge factorials.
//
// VERIFIED against a 300,000-trial Monte Carlo simulation before being wired to
// anything: 99 cards / 37 lands / 9 drawn / >=3 lands gives 72.68% closed-form
// versus 72.76% simulated, and three other cases agreed within 0.16pp. A
// closed form that merely LOOKS like the textbook is not evidence.
//
// WHAT IT DELIBERATELY DOES NOT MODEL
//
//   - mulligans: modelling those means modelling YOUR keep decisions, which is
//     guesswork dressed as math. Zach: "I do play with mulligans but I think
//     that can be messy and I'm just trying to get an idea of the on average."
//   - ramp resolving: P(land) and P(rock in hand AND cast on time) are
//     different questions, and multiplying them assumes an independence that
//     is not there.
//   - colours: three lands that cannot cast your three-drop are not three mana.
//
// So the claim this makes is narrow ON PURPOSE -- "how often you have N lands
// by turn N", never "how often you can cast your turn-N play". The UI says so
// in those words.

// n! grows past Number.MAX_SAFE_INTEGER around 18!, and a 99-card library needs
// C(99, 16). Computed as a running product of ratios instead, which keeps the
// intermediate values small and exact enough for a percentage.
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= kk; i += 1) {
    result = (result * (n - kk + i)) / i;
  }
  return result;
}

/**
 * P(at least `need` lands among `drawn` cards) from a library of `library`
 * cards containing `lands` lands. Returns 0..1.
 */
export function probAtLeast(library, lands, drawn, need) {
  if (need <= 0) return 1;
  if (library <= 0 || lands <= 0) return 0;
  const n = Math.min(drawn, library);
  if (need > n) return 0;
  if (lands >= library) return 1;

  const total = choose(library, n);
  if (!total) return 0;

  let below = 0;
  for (let i = 0; i < need; i += 1) {
    below += choose(lands, i) * choose(library - lands, n - i);
  }
  const p = 1 - below / total;
  // Floating point can push this a hair outside [0,1]; a "100.4%" on screen
  // would discredit every other number beside it.
  return Math.min(1, Math.max(0, p));
}

/**
 * How many cards you have SEEN by the start of turn `turn`.
 *
 * ON THE PLAY, which is the pessimistic reading: no draw on turn one. In a
 * four-player game you are on the play once in four, and reporting the
 * friendlier on-the-draw number would flatter every deck -- measured at up to
 * +9.7 percentage points on turn five, which is not a rounding difference.
 */
export function cardsSeenByTurn(turn, handSize = 7) {
  return handSize + Math.max(0, turn - 1);
}

/**
 * P(having `turn` lands in play on turn `turn`) -- i.e. hitting every land drop
 * up to that point. This is the number the turn rows show.
 */
export function probLandsByTurn(library, lands, turn, handSize = 7) {
  return probAtLeast(library, lands, cardsSeenByTurn(turn, handSize), turn);
}
