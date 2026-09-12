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

test('SYNC-TC1: the countdown and the timer are ONE clock', () => {
  // Zach: "it's still busted... the automatic is just wrong" -- last refreshed
  // 2:08 PM, next run 8:08 PM, his phone 9:00 PM. Overdue by 53 minutes with
  // nothing having run.
  //
  // My previous fix made the SKIP publish a stamp anchored to the last import
  // (last_success + 6h), but the timer was still setInterval(6h) started at
  // BOOT. Two different moments, so the countdown expired while the timer was
  // still waiting -- and "Due now" was telling the truth.
  //
  // The fix is one function that computes the delay ONCE, publishes it, and
  // arms a timer for exactly that. The guard asserts they cannot diverge again
  // by construction rather than by my keeping two expressions in step.
  for (const [shop, fn, setter, interval] of [
    ['Mana Pool', 'scheduleNextPriceRun', 'setManaPoolNextRun', 'PRICE_INTERVAL_MS'],
    ['Card Kingdom', 'scheduleNextCk', 'setCardKingdomNextRun', 'CK_INTERVAL_MS'],
  ]) {
    const i = server.indexOf(`const ${fn} = async`);
    assert.ok(i > -1, `${shop} must schedule through one function`);
    const block = server.slice(i, server.indexOf('};', server.indexOf('setTimeout', i)));
    assert.match(block, new RegExp(`const due = `),
      `${shop} must compute the delay once`);
    assert.match(block, new RegExp(`${setter}\\(new Date\\(Date\\.now\\(\\) \\+ due\\)`),
      `${shop} must publish exactly the delay it is about to wait`);
    assert.match(block, /setTimeout\(\(\) => \{[\s\S]*?\}, due\)/,
      `${shop} must arm the timer with that same delay`);
    assert.match(block, new RegExp(`${interval} - age`),
      `${shop} must measure from the last import, not from boot`);
  }
  // setInterval is what caused this: it counts from process start and cannot be
  // re-derived after a restart.
  assert.ok(!/setInterval\(runPriceRefresh/.test(server)
    && !/setInterval\(runCk/.test(server),
    'a price sync must not run on a boot-anchored setInterval');
});

test('SYNC-TC1b: a completed run re-arms the schedule, AFTER it settles', () => {
  // A one-shot timer that never re-arms is a sync that runs exactly once and
  // then silently stops -- worse than the bug it replaced, and invisible until
  // prices are days stale.
  //
  // AND IT MUST BE CHAINED, not a timed guess. My first version re-armed with
  // setTimeout(..., 5000) while the import was still in flight, so the failure
  // counter was still 0 when the next delay was computed. The backoff never
  // engaged and Card Kingdom kept returning 429 after I had "fixed" it. Zach
  // saw eleven more failures on the next deploy.
  for (const [shop, fn] of [['Mana Pool', 'scheduleNextPriceRun'],
                            ['Card Kingdom', 'scheduleNextCk']]) {
    const runner = shop === 'Mana Pool' ? 'runPriceRefresh' : 'runCk';
    const i = server.indexOf(`const ${runner} = `);
    const block = server.slice(i, server.indexOf('\n      };', i));
    assert.ok(block.includes(`.finally(() => { ${fn}(); })`),
      `${shop}: the next run must be scheduled from .finally(), so the failure `
      + 'count is already updated when the delay is computed');
    assert.ok(!block.includes(`setTimeout(() => { ${fn}(); },`),
      `${shop}: a timed re-arm races the import it is meant to follow`);
  }
});

test('SYNC-TC1c: a failing import backs off instead of hammering the vendor', () => {
  // FOUND IN THE LOGS, not by reasoning: his box was making a Card Kingdom
  // request every ~6 seconds and collecting HTTP 429s.
  //
  //   Card Kingdom price refresh failed: ... returned HTTP 429   (x6 in 40s)
  //
  // Prices were 7h46m old against a 6h interval, so due = max(0, INTERVAL-age)
  // was 0. The timer fired at once, the import failed, the handler rescheduled,
  // and 0 came out again. A hot loop, and every failure invisible because the
  // error was only logged.
  //
  // A 24h vendor outage cost ~14,400 requests. With a 15-minute floor and
  // exponential backoff it costs 7.
  for (const [shop, failures, interval] of [
    ['Mana Pool', 'priceFailures', 'PRICE_INTERVAL_MS'],
    ['Card Kingdom', 'ckFailures', 'CK_INTERVAL_MS'],
  ]) {
    assert.match(server, new RegExp(`let ${failures} = 0;`),
      `${shop} must count consecutive failures`);
    assert.match(server, new RegExp(`${failures} \\+= 1;`),
      `${shop} must increment on failure`);
    assert.match(server, new RegExp(`${failures} = 0;\\s*\\n\\s*console\\.log`),
      `${shop} must reset the count on success, or backoff never recovers`);
    assert.match(server, new RegExp(`Math\\.min\\(\\s*\\n?\\s*${interval},`),
      `${shop} backoff must be capped at the normal interval`);
  }
  // The floor is what stops the loop: without it an overdue source retries
  // instantly forever.
  assert.match(server, /MIN_RETRY_MS \* Math\.pow\(2,/,
    'backoff must grow exponentially from the minimum gap');
  assert.ok(!/Math\.max\(0, PRICE_INTERVAL_MS - age\)/.test(server)
    && !/Math\.max\(0, CK_INTERVAL_MS - age\)/.test(server),
    'an overdue source must never compute a zero delay');
});

test('SYNC-TC1d: a failed sync is recorded, not just logged', () => {
  // Six failures in forty seconds and the UI said nothing. A stale price that
  // looks current is the exact failure this app exists to avoid -- provenance
  // on every figure is worthless if "this did not refresh" is invisible.
  for (const shop of ['manapool', 'cardkingdom']) {
    const i = server.indexOf(`VALUES ('${shop}', ?)`);
    assert.ok(i > -1, `${shop} must write last_error to source_price_meta`);
  }
  assert.match(server, /ON CONFLICT\(source\) DO UPDATE SET last_error = \?/,
    'and must update the existing row rather than silently doing nothing');
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
