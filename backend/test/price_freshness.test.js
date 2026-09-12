// A RESTART IS NOT A REASON TO RE-IMPORT 201MB.
//
// Zach: "where is there a delay in loading total and showing which printing is
// the cheapest in the manapool section I thought it wasn't working at first. I
// went into the export and it just showed only what the deck wanted and then
// about a minute later it updated to be what I would expect."
//
// Root cause, from the deployed logs: every restart armed an 8-minute timer, so
// four deploys in an hour meant four full imports.
//
//   16:14  98727 rows updated
//   16:27  98727 rows updated      13 minutes later
//   16:52  98735 rows updated
//   17:12  98736 rows updated
//
// An import holds the single database queue in db.js, so his reads waited behind
// it. This is the same pile-up that made /api/stats take 26 seconds during a
// catalogue refresh -- the catalogue was fixed weeks ago and I did not apply the
// same rule here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const prices = readFileSync(new URL('../src/manaPoolPrices.js', import.meta.url), 'utf8');
const modal = readFileSync(
  new URL('../../frontend/src/components/ExportModal.jsx', import.meta.url), 'utf8');

// The Mana Pool scheduling block, isolated so these assertions cannot
// accidentally pass on the catalogue's own staleness check above it.
const block = server.slice(server.indexOf("MANAPOOL_PRICES !== 'off'"),
                           server.indexOf('MOXFIELD BACKGROUND POLL'));

test('FRESH-TC1: the schedule consults freshness before importing', () => {
  assert.match(block, /msSinceLastRefresh\(\)/,
    'the scheduling path must ask how old the prices are');
  assert.match(prices, /async function msSinceLastRefresh/,
    'and the price module must expose that age');

  // THE BOOT TIMER MUST CALL THE CHECKED PATH.
  //
  // My first version of this only asserted that the checked function EXISTED
  // somewhere in the file. Pointing the boot timer straight at runPriceRefresh
  // -- which IS the bug Zach hit -- left it defined but unused and the test
  // still passed. A guard that survives its own bug certifies the thing it was
  // written to prevent.
  // The BOOT timer specifically -- the 8-minute one, not the 5s re-arm that
  // follows a completed import.
  const timer = block.slice(block.indexOf('}, 8 * MINUTE_MS);') - 120,
                            block.indexOf('}, 8 * MINUTE_MS);') + 20);
  assert.match(timer, /scheduleNextPriceRun\(\)/,
    'the boot timer must schedule through the freshness-aware path');
  // The boot timer must not be the raw import. Scoped to the 8-minute timer:
  // matching the whole block caught the 5s re-arm inside runPriceRefresh, which
  // is correct code -- the test was wrong, not the server.
  assert.ok(!/runPriceRefresh\(\);?\s*\}, 8 \* MINUTE_MS\)/.test(block),
    'the boot timer must never call the raw import directly');
});

test('FRESH-TC2: fresh prices delay the import rather than repeating it', () => {
  // A restart must not re-pull 201MB that is minutes old. Under the old design
  // that was an early return; it is now a positive delay, which additionally
  // fixes the bug the early return caused -- it left the countdown unset and
  // reading "Due now" forever.
  const sched = block.slice(block.indexOf('const scheduleNextPriceRun'));
  // The delay is INTERVAL minus what has already elapsed -- floored at a
  // minimum gap, because max(0, ...) let an overdue source retry instantly and
  // loop, which is what earned HTTP 429 from Card Kingdom.
  assert.match(sched, /PRICE_INTERVAL_MS - age/,
    'fresh prices must push the next run out by the time already elapsed');
  // Asserted as the FLOOR of the delay, not merely present in the file: my
  // first version matched MIN_RETRY_MS anywhere, so reverting this very line to
  // max(0, ...) still passed while the constant sat unused a few lines up. The
  // sixth guard on this project to survive its own bug.
  assert.match(sched, /Math\.max\(\s*\n?\s*priceFailures > 0 \? backoff : MIN_RETRY_MS,/,
    'the delay must be floored at the minimum gap, never at zero');
  assert.ok(sched.indexOf('const due =') < sched.indexOf('setTimeout'),
    'the delay must be decided before the timer is armed');
  // The import is reached only through the timer, never called inline, or a
  // restart would import immediately regardless of freshness.
  const beforeTimer = sched.slice(0, sched.indexOf('setTimeout'));
  assert.ok(!beforeTimer.includes('runPriceRefresh()'),
    'scheduling must not trigger an import as a side effect');
});

test('FRESH-TC3: never having imported counts as stale, not fresh', () => {
  // msSinceLastRefresh returns null on a first boot. Treating null as "recent"
  // would mean a brand new install never fetches prices at all and every screen
  // silently falls back to Scryfall averages.
  assert.match(prices, /if \(!row\?\.last_success_at\) return null/,
    'no successful run must report null');
  const sched = block.slice(block.indexOf('const scheduleNextPriceRun'));
  assert.match(sched, /age === null/,
    'null must be handled explicitly, not folded into the arithmetic');
  // With null the delay is the short startup window, not a full interval --
  // otherwise a fresh install would wait six hours before its first prices.
  assert.match(sched, /age === null\s*\n?\s*\? 8 \* MINUTE_MS/,
    'a never-imported source must be scheduled promptly, not an interval away');
});

test('FRESH-TC4: the stale window is shorter than the interval', () => {
  // If the window were longer than the gap between runs, a scheduled refresh
  // could be skipped by its own predecessor and prices would freeze.
  const stale = block.match(/PRICE_STALE_MS = (\d+) \* 60 \* MINUTE_MS/);
  const interval = block.match(/PRICE_INTERVAL_MS = (\d+) \* 60 \* MINUTE_MS/);
  assert.ok(stale && interval, 'both windows must be declared in hours');
  assert.ok(Number(stale[1]) < Number(interval[1]),
    `stale window (${stale?.[1]}h) must be shorter than the interval (${interval?.[1]}h)`);
});

test('FRESH-TC5: the sheet never shows printings it has not priced', () => {
  // The visible half of the same bug: while the estimate was in flight the rows
  // rendered the DECK's printings with no prices, which looks like a finished
  // answer. He read it as broken, then watched it change a minute later. A
  // number that looks settled and then moves is worse than an honest wait.
  assert.match(modal, /const \[estimateLoading, setEstimateLoading\]/,
    '"still asking" must be distinguishable from "answered"');
  assert.match(modal, /onManaPool && text && estimate && cards\.map/,
    'rows must wait for the estimate before rendering a printing');
  assert.match(modal, /estimateLoading && !estimate/,
    'and say so while it is in flight');
});

console.log('price freshness guards passed');
