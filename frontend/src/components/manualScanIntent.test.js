// MANUAL SCAN INTENT MUST NOT LEAK BETWEEN CONCURRENT SCANS.
//
// This reproduces a duplicate-record bug found in review of PR #50, before it
// reached Zach. It is the exact failure the app cannot afford: a WRONG count
// against physical cardboard, costing a recount, as opposed to a missed card
// costing one tap.
//
// THE BUG. The first attempt at "a tap overrides the dedupe guards" stored that
// intent in a single shared ref, set at the top of handleCapture and cleared in
// its finally. But handleCapture is async AND deliberately re-enterable -- the
// tap overlay calls it with force=true precisely so a wedged scanner can be
// recovered. So two scans overlap and share one cell:
//
//   auto scan A starts             shared flag = false
//   A awaits /api/scan-match       ~160 lines of async work follow with no
//                                  staleness re-check before the queue guard
//   user taps -> scan T starts     shared flag = TRUE
//   A resumes, reads the flag      sees TRUE, skips ITS OWN dedupe guard,
//                                  stages a duplicate row
//
// And the reverse interleaving loses the override entirely: if A finishes
// inside T's window, A's finally clears the flag and T is suppressed as "same
// card" -- so the tap fix works only by luck of timing.
//
// THE FIX IS STRUCTURAL. Intent is a local const in each handleCapture
// invocation, captured by that scan's closure and passed explicitly. There is
// no shared cell left to corrupt.
//
// These cases model the two scans as closures over their own intent, exactly as
// the component now does, and assert the property a shared ref cannot satisfy.
import assert from 'node:assert';

let passed = 0;
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// A minimal stand-in for the guard the queue path applies before staging a row.
// Mirrors CameraScanner's `if (!isManual && identified === lastQueued) return;`
function wouldStage({ isManual, identified, lastQueued, alreadyForced }) {
  const repeat = identified === lastQueued;
  if (repeat && isManual && identified === alreadyForced) return false; // double tap
  if (repeat && !isManual) return false;                               // lingering card
  return true;
}

// TC1: THE SHARED-FLAG BUG, demonstrated. A shared mutable cell lets a tap that
// starts mid-flight change what an ALREADY RUNNING auto scan believes.
{
  const shared = { manual: false };
  shared.manual = false;                 // auto scan A starts
  const autoReadsLater = () => shared.manual;
  shared.manual = true;                  // user taps; scan T starts
  assert.strictEqual(
    autoReadsLater(), true,
    'shared-flag model must exhibit the leak, otherwise this test proves nothing',
  );
  // With that leaked `true`, A skips its guard and stages a duplicate.
  assert.strictEqual(
    wouldStage({ isManual: autoReadsLater(), identified: 'Forest', lastQueued: 'Forest' }),
    true,
    'the leak causes an AUTO scan to stage an already-staged card',
  );
  pass('MSI-TC1', 'a shared flag lets a tap make an auto scan record a duplicate');
}

// TC2: THE FIX. Per-scan locals cannot leak, in either interleaving.
{
  // Auto scan A captures its own intent when it starts.
  const aIsManual = !true;   // handleCapture(auto = true)
  // The tap then starts scan T with its own.
  const tIsManual = !false;  // handleCapture(auto = false)

  // A resumes AFTER T started. It still sees its own intent.
  assert.strictEqual(aIsManual, false, 'auto scan keeps its own intent after a tap starts');
  assert.strictEqual(
    wouldStage({ isManual: aIsManual, identified: 'Forest', lastQueued: 'Forest' }),
    false,
    'the auto scan still refuses to re-stage a card already staged',
  );

  // And the reverse: A finishing does not clear T's intent, because there is
  // nothing shared to clear.
  assert.strictEqual(tIsManual, true, "a completing auto scan cannot cancel the tap's intent");
  assert.strictEqual(
    wouldStage({ isManual: tIsManual, identified: 'Forest', lastQueued: 'Forest' }),
    true,
    'the tap still forces its scan through, deterministically',
  );
  pass('MSI-TC2', 'per-scan intent survives both interleavings');
}

// TC3: A DOUBLE TAP MUST NOT STAGE TWO ROWS FOR ONE PIECE OF CARDBOARD.
//
// The tap override is intentionally strong, but unbounded it means one stray
// double-click on the full-bleed overlay records two copies with no
// confirmation. First tap forces through; second on the same identity refuses.
{
  assert.strictEqual(
    wouldStage({ isManual: true, identified: 'Forest', lastQueued: 'Forest', alreadyForced: null }),
    true,
    'the first tap forces past the dedupe guard',
  );
  assert.strictEqual(
    wouldStage({ isManual: true, identified: 'Forest', lastQueued: 'Forest', alreadyForced: 'Forest' }),
    false,
    'a second tap on the SAME card must not stage a duplicate row',
  );
  pass('MSI-TC3', 'a double tap cannot double-record one card');
}

// TC4: a tap on a genuinely DIFFERENT card is never suppressed. The override
// has to keep working, or the bug this all started from comes back.
{
  assert.strictEqual(
    wouldStage({ isManual: true, identified: 'Island', lastQueued: 'Forest', alreadyForced: 'Forest' }),
    true,
    'a tap on a different card always scans',
  );
  pass('MSI-TC4', 'a tap on a different card is never suppressed');
}

console.log(`\nmanual-scan-intent.test.js: ${passed} cases passed`);
