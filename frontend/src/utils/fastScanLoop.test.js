// Is fastScanLoop.js a faithful transcription of upstream's scan loop?
//
// Four rounds of bugs in this port were all the same shape: I paraphrased
// upstream's control flow and the paraphrase lost something. So this does not
// test behaviour -- it tests FIDELITY, by extracting the decision structure
// from BOTH files and comparing them.
//
// It reads the real scrybox source when it is present (the reference clone),
// and skips with a loud message when it is not, rather than silently passing.
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MINE = readFileSync(join(HERE, 'fastScanLoop.js'), 'utf8');
const UPSTREAM_PATH = '/home/hermes/repos/scrybox/frontend/src/components/FastScanner.jsx';

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// Comments stripped: every assertion below is about CODE. Asserting a string
// that also appears in a comment is how an earlier guard in this repo passed
// while the real line was deleted.
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const mine = strip(MINE);

// FID-TC1: the four-way decision, in upstream's order.
//
// if (out) abort -> else if (hedged) -> else if (backoff) hold -> else upload.
// Reordering these is not a style choice: putting the backoff before the hedge
// would make a shutter press hold, and putting the upload before the backoff
// would defeat the backoff entirely.
{
  start('FID-TC1');
  const i1 = mine.indexOf('if (out) abort.abort();');
  const i2 = mine.indexOf('else if (hedged)');
  const i3 = mine.indexOf('else if (autoPass && !serverAllowed(');
  const i4 = mine.indexOf('out = await serverRead((async () =>');
  assert.ok(i1 > 0, 'the proven-card branch must exist');
  assert.ok(i2 > i1, 'the hedge branch must follow the proven branch');
  assert.ok(i3 > i2, 'the backoff hold must follow the hedge');
  assert.ok(i4 > i3, 'the upload must be the LAST branch -- everything else uploads');
  pass('FID-TC1', 'the four-way decision is in upstream order');
}

// FID-TC2: exactly one duplicate rule, keyed on card.id, with a time window.
//
// The bug this port existed to fix: two scan paths with two different dedupe
// keys, neither able to see the other's entries.
{
  start('FID-TC2');
  // Only get/set are keyed; clear() takes no key, so it is excluded rather
  // than counted. The first draft matched all three and asserted a COUNT,
  // which is both brittle and blind to WHICH key is used -- the actual bug.
  const keys = mine.match(/seenIdsRef\.current\.(?:get|set)\(([^,)]+)/g) || [];
  assert.ok(keys.length >= 2, `only ${keys.length} keyed seenIds accesses; expected a get and a set`);
  for (const k of keys) {
    assert.match(k, /h\.card\.id/,
      `dedupe keyed on ${k} -- every access must key on card.id, or two paths `
      + 'will write keys that can never match');
  }
  assert.match(mine, /now - last > SEEN_CARD_MS/,
    'the window must be time-based, not a latch');
  pass('FID-TC2', 'one dedupe rule, keyed on card.id, expiring on a clock');
}

// FID-TC3: the streak is cleared on an empty frame AND set from the answer.
// serverAllowed() without nextFailStreak() is a gate wired to a dead sensor.
{
  start('FID-TC3');
  // ANCHORED TO THE NO-CARD BRANCH, not to the bare assignment.
  //
  // The first draft asserted `failStreakRef.current = null` appeared anywhere.
  // It appears TWICE -- once in the no-card branch (the rule that matters) and
  // once in setAutoRunning's reset. Deleting the first left the second, so the
  // mutation harness deleted a real behaviour and the test stayed green. That
  // is precisely the vacuous-guard failure this harness exists to surface.
  assert.match(mine, /!local\?\.candidates\?\.length[^\n]*failStreakRef\.current = null/,
    'an empty frame must clear the streak IN THE NO-CARD BRANCH, or a new card '
    + "inherits the previous card's backoff and is held back");
  assert.match(mine, /failStreakRef\.current = nextFailStreak\(/,
    'the answer must be folded back into the streak');
  pass('FID-TC3', 'the backoff is both armed and cleared');
}

// FID-TC4: hints come from the outcome, AFTER the pass.
// A "working on it" message written before the work cannot survive an early
// return -- that is what made the scanner look wedged on "Initializing".
{
  start('FID-TC4');
  const scanStart = mine.indexOf('const scan = async');
  const firstHint = mine.indexOf('onHint(', scanStart);
  const decision = mine.indexOf('if (out) abort.abort();');
  assert.ok(firstHint > decision,
    'the first hint must come AFTER the scan decision; a hint set before the '
    + 'work is left on screen by every early return');
  pass('FID-TC4', 'hints are derived from the result, not painted up front');
}

// FID-TC5: busy is always released.
{
  start('FID-TC5');
  assert.match(mine, /finally \{[\s\S]{0,200}busyRef\.current = false;/,
    'busyRef must be cleared in a finally, or one early return wedges the loop');
  pass('FID-TC5', 'the busy flag cannot leak');
}

// FID-TC6: THE REAL FIDELITY CHECK -- compare against the actual source.
//
// The assertions above encode what I BELIEVE upstream does. This one reads
// upstream and checks the claim, so a misremembering fails here rather than
// shipping.
{
  start('FID-TC6');
  if (!existsSync(UPSTREAM_PATH)) {
    console.log('  SKIPPED: scrybox reference clone not present at ' + UPSTREAM_PATH);
    console.log('  (this guard is only meaningful with the reference checkout)');
  } else {
    const up = strip(readFileSync(UPSTREAM_PATH, 'utf8'));
    // The load-bearing lines, verbatim from upstream. If any of these is not
    // in the source, my transcription is built on a misreading.
    const anchors = [
      'if (out) abort.abort();',
      'else if (hedged) out = await hedged;',
      'failStreakRef.current = null;',
      'const last = seenIdsRef.current.get(h.card.id);',
      'for (const h of hits) seenIdsRef.current.set(h.card.id, now);',
      'busyRef.current = false;',
    ];
    for (const a of anchors) {
      assert.ok(up.includes(a),
        `anchor not found in upstream: ${a} -- my transcription assumes a line `
        + 'that is not there');
    }
    // And the constants must match, not merely be "about right".
    const upGap = /const AUTO_GAP_MS = (\d+)/.exec(up);
    const upIdle = /const AUTO_IDLE_MS = (\d+)/.exec(up);
    const upBusy = /const AUTO_BUSY_MS = (\d+)/.exec(up);
    const myGap = /export const AUTO_GAP_MS = (\d+)/.exec(mine);
    const myIdle = /export const AUTO_IDLE_MS = (\d+)/.exec(mine);
    const myBusy = /export const AUTO_BUSY_MS = (\d+)/.exec(mine);
    assert.strictEqual(myGap[1], upGap[1], `gap ${myGap[1]} != upstream ${upGap[1]}`);
    assert.strictEqual(myIdle[1], upIdle[1], `idle ${myIdle[1]} != upstream ${upIdle[1]}`);
    assert.strictEqual(myBusy[1], upBusy[1], `busy ${myBusy[1]} != upstream ${upBusy[1]}`);
    const upSeen = /now - last > (\d+)/.exec(up);
    const mySeen = /export const SEEN_CARD_MS = (\d+)/.exec(mine);
    assert.strictEqual(mySeen[1], upSeen[1],
      `dedupe window ${mySeen[1]}ms != upstream ${upSeen[1]}ms`);
    pass('FID-TC6', 'every anchor and constant verified against the real source');
  }
}

console.log(`\nfastScanLoop.test.js: ${passed} cases passed`);
