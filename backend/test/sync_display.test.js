// A HEALTHY SYNC MUST NOT LOOK BROKEN, AND A STALE ONE MUST NOT LOOK FRESH.
//
// Zach: "the automatic section says due now for both mana pool and card kingdom
// and the last run time is behind 1 hr. Also for the last refreshed date can it
// be date and time. I want that for all data sources."
//
// Two separate bugs, both shipped past a green suite:
//
//   1. The startup freshness check -- itself a fix from the previous session --
//      returned WITHOUT advancing the next-run stamp. The stamp stayed at
//      boot+8min, expired, and read "Due now" forever while the sync was
//      perfectly healthy and running on its interval.
//
//   2. SQLite's CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' with no zone marker,
//      and new Date() reads that as LOCAL. The dev box runs Etc/UTC and he is on
//      EDT, so every timestamp rendered four hours adrift -- always in the
//      direction that makes a stale feed look fresh.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const settingsUi = readFileSync(
  new URL('../../frontend/src/components/SettingsScreen.jsx', import.meta.url), 'utf8');

test('SYNC-TC1: skipping a startup import still publishes the next run', () => {
  // The bug was a bare `return` on the skip path. Both shops must set their
  // next-run stamp BEFORE returning, or the countdown expires and sits at
  // "Due now" indefinitely.
  for (const [shop, setter] of [['Mana Pool', 'setManaPoolNextRun'],
                                ['Card Kingdom', 'setCardKingdomNextRun']]) {
    const i = server.indexOf(`${shop} prices are`);
    assert.ok(i > -1, `${shop} skip path must exist`);
    const block = server.slice(i, server.indexOf('return;', i));
    assert.match(block, new RegExp(`syncSchedule\\.${setter}`),
      `${shop} must publish a next run before returning from a skip`);
  }
});

test('SYNC-TC2: the next run is anchored to the last success, not to now', () => {
  // Anchoring to now would push the schedule one full interval later on EVERY
  // restart, so a box that reboots often would quietly stop refreshing prices
  // -- a silent failure, which is the kind he cannot see.
  assert.match(server, /PRICE_INTERVAL_MS - age/,
    'Mana Pool must subtract the age of the existing prices');
  assert.match(server, /CK_INTERVAL_MS - age/,
    'Card Kingdom must subtract the age of the existing prices');
});

test('SYNC-TC3: a UTC timestamp is parsed as UTC', () => {
  // SQLite returns no zone marker. Without this the app reads server time as if
  // it were his, and the error always flatters the data.
  const fn = settingsUi.slice(settingsUi.indexOf('function when(iso, t)'),
                              settingsUi.indexOf('// A COUNTDOWN TO THE NEXT SYNC'));
  assert.match(fn, /\[Zz\]/,
    'it must detect a timestamp that already carries a zone');
  assert.match(fn, /replace\(' ', 'T'\) \+ 'Z'/,
    "and treat a bare SQLite timestamp as UTC rather than local");
});

test('SYNC-TC4: last refreshed shows a time, not just a date', () => {
  // "for the last refreshed date can it be date and time. I want that for all
  // data sources." A source that syncs every 6 hours cannot answer "are these
  // prices current" with a date alone.
  const fn = settingsUi.slice(settingsUi.indexOf('function when(iso, t)'),
                              settingsUi.indexOf('// A COUNTDOWN TO THE NEXT SYNC'));
  assert.ok(!/toLocaleDateString\(\)/.test(fn),
    'toLocaleDateString drops the time and hides staleness');
  assert.match(fn, /hour: 'numeric'/, 'the hour must be rendered');
  assert.match(fn, /minute: '2-digit'/, 'and the minute');
});

test('SYNC-TC5: every data source uses the same formatter', () => {
  // "I want that for all data sources." One helper, so a source added later
  // cannot quietly render a date-only stamp.
  const uses = settingsUi.match(/when\(/g) || [];
  assert.ok(uses.length >= 4,
    `every source must format through when(); found ${uses.length} uses`);
  // Strip comments before scanning for the banned call: the first version of
  // this matched the word inside the explanation of why it was removed, and
  // failed on correct code. Same false positive that hit EST-TC2 earlier in
  // this project -- a test that reads prose as if it were behaviour.
  const code = settingsUi.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/toLocaleDateString/.test(code),
    'no screen may bypass the shared formatter with a date-only render');
});

console.log('sync display guards passed');
