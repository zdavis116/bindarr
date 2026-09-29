// The Scryfall set list must refresh on a schedule that survives restarts.
//
// Zach: "So are we not refreshing our card catalog daily? How was fra behind?"
// then "fix the set sync so it fires weekly regardless of app being
// restarted."
//
// THE BUG. Reality Fracture was cached while only 43 of its 461 cards were
// spoiled and stayed at 43, so a completion bar would have read 670%. A
// "weekly refresh" did exist:
//
//     await fetchAndCacheSets();                    // startup
//     setInterval(() => fetchAndCacheSets(true), 7 * DAY);
//
// Both halves failed together. The startup call returned early whenever the
// table had ANY rows -- a populate-if-empty, not a refresh. And a setInterval
// of seven days only fires if the process survives seven continuous days;
// this one restarts on every deploy, which resets the timer to zero. The only
// path that could refresh required an uptime that never happened.
//
// 26 of Zach's 105 sets were stale when this was found.
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..', '..');
const api = readFileSync(join(ROOT, 'backend/src/scryfallApi.js'), 'utf8');
const schema = readFileSync(join(ROOT, 'backend/src/db.js'), 'utf8');
const server = readFileSync(join(ROOT, 'backend/src/server.js'), 'utf8');

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// SETS-TC1: the schedule is persisted, not held in process memory.
//
// This is the whole fix. A restart must not be able to reset the clock.
{
  start('SETS-TC1');
  assert.match(schema, /ADD COLUMN sets_synced_at DATETIME/,
    'the last sync time must be stored in the database; a timer or an '
    + 'in-memory variable is reset by every deploy, which IS the bug');
  assert.match(api, /SELECT sets_synced_at AS syncedAt FROM app_settings WHERE id = 1/,
    'the due check must read the persisted timestamp');
  assert.match(api, /UPDATE app_settings SET sets_synced_at = CURRENT_TIMESTAMP/,
    'a successful sync must record when it happened, or every restart '
    + 'refetches ~1000 sets');
  pass('SETS-TC1', 'the sync schedule survives a restart');
}

// SETS-TC2: the decision is AGE-based, not emptiness-based.
//
// The old `if (rows > 0) return;` is what made the startup call useless: the
// table is never empty after the first boot, so it never refreshed again.
{
  start('SETS-TC2');
  const fn = /async function fetchAndCacheSets\([\s\S]*?\n\}/.exec(api);
  assert.ok(fn, 'fetchAndCacheSets could not be found');
  assert.ok(!/SELECT COUNT\(\*\) as count FROM sets/.test(fn[0]),
    'the refresh must not gate on the table being empty -- after the first '
    + 'boot it never is, so it would never refresh again');
  assert.match(fn[0], /!force && !\(await setsSyncIsDue\(\)\)/,
    'the refresh must gate on the stored data being STALE');
  const wk = /const SETS_SYNC_INTERVAL_MS = ([^;]+);/.exec(api);
  assert.ok(wk, 'the sync interval could not be found');
  // eslint-disable-next-line no-eval
  assert.strictEqual(eval(wk[1]), 1000 * 60 * 60 * 24 * 7,
    'Zach asked for weekly');
  pass('SETS-TC2', 'refreshes on age, at a weekly cadence');
}

// SETS-TC3: a failed fetch must not look like a successful one.
//
// If an empty response stamped the sync time, one bad night would freeze the
// set list for a week -- and the totals would silently be whatever they were.
{
  start('SETS-TC3');
  const fn = /async function fetchAndCacheSets\([\s\S]*?\n\}/.exec(api)[0];
  const guard = fn.indexOf('if (!sets.length)');
  const stamp = fn.indexOf('UPDATE app_settings SET sets_synced_at');
  assert.ok(guard > 0, 'an empty Scryfall response must be handled explicitly');
  assert.ok(guard < stamp,
    'the empty-response guard must come BEFORE the sync is recorded, or a '
    + 'failed fetch buys itself another week of silence');
  assert.match(fn.slice(guard, guard + 320), /return;/,
    'an empty response must leave the cached rows alone and return');
  pass('SETS-TC3', 'a failed fetch does not mark itself synced');
}

// SETS-TC4: the in-process timer is documented as a backup, not the schedule.
//
// It is kept deliberately -- a long-running instance should not wait for a
// restart to see a new set -- but the comment has to say it cannot be relied
// on, or the next reader re-derives the same false confidence I had.
{
  start('SETS-TC4');
  assert.match(server, /THIS TIMER IS THE BACKUP, NOT THE SCHEDULE/,
    'the weekly setInterval must be labelled as a backup; it only fires if '
    + 'the process survives seven continuous days');
  assert.match(server, /fetchAndCacheSets\(true\)/,
    'the timer should force, since the interval is itself the cadence');
  pass('SETS-TC4', 'the timer is documented as unreliable');
}

console.log(`\nsetsSync.test.js: ${passed} cases passed`);
