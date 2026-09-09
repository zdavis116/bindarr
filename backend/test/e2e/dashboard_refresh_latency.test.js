// THE DASHBOARD MUST NOT ASK THE DATABASE TWENTY TIMES.
//
// Zach, right after a deploy: "my dashboard doesn't load and everything else
// seems slow to load as well like collections and deck list."
//
// MEASURED ON DEV during a real catalogue refresh, before the fix:
//
//     /api/stats   28-31s        <- would not load
//     /api/decks    2.9s         <- "slow"
//     /api/health   2.2s
//
// The mechanism, found only after three wrong guesses:
//
//   db.js chains EVERY query onto one global operation queue, and
//   withTransaction() holds its slot for the whole BEGIN..COMMIT block. During
//   the catalogue swap the queue interleaves [swap txn][query][swap txn][query].
//   A request issuing N sequential queries waits N swap transactions.
//
//   stats.js ran a COUNT per set inside a for-loop -- about twenty round trips.
//   Twenty waits, not one. That is why the DASHBOARD was unloadable while other
//   screens were merely sluggish: it was not that any query was slow, it was
//   that it asked twenty times.
//
// Ruled out by measurement first, each of which I had believed:
//   staging phase          steady 2.2s        not it
//   colour-identity query  20ms               not it
//   WAL grown to 150MB     reads still 3ms    not it
//
// AFTER: worst /api/stats during a full refresh 3682ms, and idle dropped
// 373ms -> 81ms as a side effect. setProgress numbers verified byte-identical.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const statsSrc = fs.readFileSync(
  path.join(here, '..', '..', 'src', 'routes', 'stats.js'), 'utf8');
const catalogueSrc = fs.readFileSync(
  path.join(here, '..', '..', 'src', 'cardCatalogue.js'), 'utf8');

// Comments describe the bug at length; asserting against them would pass on
// prose alone. Strip them.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stats = strip(statsSrc);
const catalogue = strip(catalogueSrc);

test('DASH-TC1: set progress is ONE grouped query, not one per set', () => {
  // The exact shape that made the dashboard unloadable: an awaited query inside
  // a loop over set ids.
  const loopBody = stats.slice(
    stats.indexOf('for (const setId in setCounts)'),
    stats.indexOf('setProgress.push')
  );
  assert.ok(loopBody.length > 0, 'the setProgress loop must still exist');
  assert.doesNotMatch(loopBody, /await\s+db\.(get|all)\(/,
    'no database call may happen inside the per-set loop — that is N queued '
    + 'waits during a catalogue swap, one per set');

  assert.match(stats, /GROUP BY cc\.set_id/,
    'the per-set counts must come from a single grouped query');
});

test('DASH-TC2: the grouped query still counts DISTINCT cards for THIS user', () => {
  // Faster and wrong is worse than slow and right: a wrong count sends Zach to
  // recount cardboard.
  const q = stats.slice(stats.indexOf('SELECT cc.set_id AS setId'),
                        stats.indexOf('GROUP BY cc.set_id') + 40);
  assert.match(q, /COUNT\(DISTINCT c\.card_id\)/,
    'set progress counts distinct printings owned, not total copies');
  assert.match(q, /WHERE c\.user_id = \?/,
    'set progress must be scoped to the requesting user');
});

test('DASH-TC3: a set the user owns nothing from still reports zero', () => {
  // The old per-set COUNT returned 0 for an unowned set. A grouped query simply
  // omits that row, so the lookup MUST default rather than yield undefined —
  // otherwise the dashboard renders NaN% for every set he has not started.
  assert.match(stats, /ownedBySet\.get\(setId\) \|\| 0/,
    'a missing set must fall back to 0, not undefined');
});

test('DASH-TC4: the swap transaction stays small enough to interleave', () => {
  // Sized by how long ONE transaction blocks a waiting reader, not throughput.
  // At 2000 rows a transaction took ~1.4s; twenty queued queries meant ~28s.
  const m = catalogue.match(/const APPLY_BATCH_ROWS = (\d+)/);
  assert.ok(m, 'APPLY_BATCH_ROWS must be defined');
  assert.ok(Number(m[1]) <= 500,
    `APPLY_BATCH_ROWS is ${m[1]}; a batch this large holds the single global `
    + 'operation queue long enough to stall any request that issues several '
    + 'queries');
});

test('DASH-TC5: both refresh phases yield between batches', () => {
  // Necessary but NOT sufficient — yielding alone did not fix this, and
  // believing it did is what shipped a change that made things worse (26.4s ->
  // 30.0s). Kept because removing it regresses the staging phase.
  const pauses = catalogue.match(/setTimeout\(resolve, APPLY_BATCH_PAUSE_MS\)/g) || [];
  assert.ok(pauses.length >= 2,
    'staging AND the swap must each yield the event loop between batches');
});

console.log('dashboard-during-refresh guards passed');
