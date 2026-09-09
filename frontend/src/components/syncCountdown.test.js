// EVERY SYNC MUST SAY WHEN IT NEXT RUNS, IN THE READER'S OWN CLOCK.
//
// Zach: "one small update I would like in settings is for each sync to show
// when the next sync to run like a countdown. Because you say scryfall syncs at
// 0400 but I see on the site 0300 hundred is that local time zone adjusted if
// so can I also see 0300 est or something like that."
//
// He was reading THREE different numbers for one schedule:
//
//   * the scheduler ran at "04:00 local" -- but both hosts are Etc/UTC, so that
//     was 04:00 UTC, which is MIDNIGHT for him in EDT
//   * Settings displayed a hardcoded "Nightly at 03:00", matching neither
//   * the startup log said 04:00 UTC
//
// The fix is structural rather than cosmetic: the schedulers PUBLISH their real
// next-run timestamp, the settings route reports it, and the UI formats it in
// the reader's zone. Nothing displays a time that was typed by hand, because a
// schedule written into the UI is a second source of truth and this one had
// already drifted.
//
// VERIFIED in a real browser with the timezone forced to America/New_York:
//   Scryfall  "Next run at 12:00 AM EDT"  /  "in 1h 10m"
//   Moxfield  "Next run at 10:54 PM EDT"  /  "in 5m"
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = fs.readFileSync(path.join(here, 'SettingsScreen.jsx'), 'utf8');
const server = fs.readFileSync(
  path.join(here, '..', '..', '..', 'backend', 'src', 'server.js'), 'utf8');
const route = fs.readFileSync(
  path.join(here, '..', '..', '..', 'backend', 'src', 'routes', 'settings.js'), 'utf8');
const en = JSON.parse(fs.readFileSync(
  path.join(here, '..', 'locales', 'en.json'), 'utf8'));

// The comments quote his message and describe the bug; asserting against them
// would pass on prose alone. This project has already had a guard fire on a
// word inside a comment.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const uiCode = strip(ui);
const serverCode = strip(server);

test('SYNC-TC1: the schedule is UTC-explicit, not "local" on a UTC host', () => {
  // setHours() reads the SERVER's zone. Both hosts are Etc/UTC, so it silently
  // meant something different from what the comment claimed.
  assert.doesNotMatch(serverCode, /nextRun\.setHours\(/,
    'setHours() is server-local — on a UTC host that is not Zach\'s 4am');
  assert.match(serverCode, /setUTCHours\(CATALOGUE_HOUR_UTC/,
    'the catalogue schedule must be stated explicitly in UTC');
});

test('SYNC-TC2: both schedulers publish their real next-run time', () => {
  assert.match(serverCode, /syncSchedule\.setCatalogueNextRun\(/,
    'the catalogue scheduler must publish when it next runs');
  assert.match(serverCode, /syncSchedule\.setMoxfieldNextRun\(/,
    'the Moxfield poll must publish when it next runs');
});

test('SYNC-TC3: the countdown is re-published after every run', () => {
  // The failure this whole change exists to remove: a number that looks live
  // and is not. Publishing once would freeze the countdown at the first value.
  const scheduled = serverCode.slice(
    serverCode.indexOf('setTimeout(() => {'),
    serverCode.indexOf('Card catalogue refresh scheduled for')
  );
  const republishes = (scheduled.match(/setCatalogueNextRun\(/g) || []).length;
  assert.ok(republishes >= 2,
    'the next-run time must be recomputed after each refresh, not published once');
});

test('SYNC-TC4: the API reports the schedule as timestamps', () => {
  // ISO instants, not a description. A description cannot be rendered in the
  // reader's timezone, which is the entire request.
  assert.match(route, /\.\.\.syncSchedule\.getSchedule\(\)/,
    'the catalogue endpoint must include the published schedule');
});

test('SYNC-TC5: the UI renders the timestamp, never a hardcoded hour', () => {
  // "Nightly at 03:00" was a locale string nobody updated when the scheduler
  // changed. Any literal clock time in these keys can drift the same way.
  for (const [key, value] of Object.entries(en)) {
    if (!key.startsWith('settings.')) continue;
    if (!/sync|automatic|nightly|refresh/i.test(key)) continue;
    assert.doesNotMatch(String(value), /\b\d{1,2}:\d{2}\b/,
      `${key} hardcodes a clock time ("${value}") — it will drift from the scheduler`);
  }
  assert.match(uiCode, /timeZoneName: 'short'/,
    'the clock time must be labelled with the reader\'s zone, so 12:00 AM EDT '
    + 'and 04:00 UTC are visibly the same instant');
});

test('SYNC-TC6: the countdown corrects for a wrong device clock', () => {
  // A phone running minutes fast would otherwise disagree with when the sync
  // actually fires, and "why didn't it sync?" becomes unanswerable.
  assert.match(uiCode, /server_now/,
    'the countdown must measure against the server clock, not the device');
});

test('SYNC-TC7: a disabled scheduler says so instead of counting to nothing', () => {
  // CARD_CATALOGUE_REFRESH=off / MOXFIELD_POLL=off leave next-run null. Showing
  // a countdown then would promise a sync that is never coming.
  assert.match(uiCode, /untilText\([^)]*\)\s*\n?\s*\|\|\s*t\('settings\.off'\)/,
    'a null next-run must fall back to an explicit off state');
  assert.ok(en['settings.off'], 'the off state needs its own string');
});

console.log('sync countdown guards passed');
