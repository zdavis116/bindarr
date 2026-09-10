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

test('FRESH-TC1: startup consults freshness before importing', () => {
  assert.match(block, /msSinceLastRefresh\(\)/,
    'the startup path must ask how old the prices are');
  assert.match(prices, /async function msSinceLastRefresh/,
    'and the price module must expose that age');

  // THE BOOT TIMER MUST CALL THE CHECKED PATH.
  //
  // My first version of this test only asserted that startupPriceRefresh
  // EXISTED somewhere in the file. Swapping the boot timer back to
  // runPriceRefresh() -- which IS the bug Zach hit -- left the function defined
  // but unused, and the test still passed. A guard that survives its own bug is
  // worse than no guard: it certifies the thing it was written to prevent.
  const timer = block.slice(block.indexOf('setTimeout(() => {'));
  assert.match(timer, /setTimeout\(\(\) => \{\s*startupPriceRefresh\(\);/,
    'the boot timer must call the freshness-checked path, not the raw import');
});

test('FRESH-TC2: fresh prices skip the import entirely', () => {
  const guard = block.slice(block.indexOf('const startupPriceRefresh'),
                            block.indexOf('// Published before the first run'));
  assert.match(guard, /age < PRICE_STALE_MS/,
    'a recent import must short-circuit');
  assert.match(guard, /return;/,
    'and return WITHOUT calling runPriceRefresh');
  // The early return must come before the refresh call, or the guard does
  // nothing at all.
  assert.ok(guard.indexOf('return;') < guard.indexOf('runPriceRefresh()'),
    'the skip must happen before the import is triggered');
});

test('FRESH-TC3: never having imported counts as stale, not fresh', () => {
  // msSinceLastRefresh returns null on a first boot. Treating null as "recent"
  // would mean a brand new install never fetches prices at all and every screen
  // silently falls back to Scryfall.
  assert.match(prices, /if \(!row\?\.last_success_at\) return null/,
    'no successful run must report null');
  const guard = block.slice(block.indexOf('const startupPriceRefresh'),
                            block.indexOf('// Published before the first run'));
  assert.match(guard, /age !== null && age < PRICE_STALE_MS/,
    'and null must NOT satisfy the skip condition');
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
