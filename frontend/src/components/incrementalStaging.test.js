// The desktop's per-scan refresh must be INCREMENTAL, and still correct.
//
// THE BUG (Zach): "I did scan a large set over 50 cards and I did notice the
// scan and everything slowing down."
//
// Measured on dev before the fix. Every staged row carries its crop as a
// base64 JPEG (~13KB), so GET /api/scan-stage grows linearly:
//
//     rows   GET ms   payload KB
//       10        8         134
//       50       11         672
//       75       19        1008
//
// The desktop table is always visible, so it refreshed after EVERY scan --
// a megabyte re-sent roughly three times a second to learn about one new row.
//
// After: 1007KB -> 13KB at 75 cards, a 99% reduction.
//
// SPEED IS THE EASY HALF. The dangerous failure is a partial response that
// also reports partial COUNTS: `total` and `unresolved` gate Add All, so a
// client believing "0 unresolved" would enable a commit the server then
// refuses -- or worse, commit a session with unreviewed rows in it.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const route = readFileSync(join(REPO, 'backend/src/routes/collection.js'), 'utf8');
const staging = readFileSync(join(HERE, 'scanStaging.js'), 'utf8');
const desktop = readFileSync(join(HERE, 'DesktopScanLayout.jsx'), 'utf8');

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// INCR-TC1: the hot path is incremental.
{
  start('INCR-TC1');
  assert.match(desktop, /staging\.refreshSince\(\)/,
    'the per-scan effect must use refreshSince(); a full refresh() here is '
    + 'the megabyte-per-scan bug');
  const eff = /useEffect\(\(\) => \{\s*if \(lastScanned\)([\s\S]{0,120}?)\}, \[lastScanned/.exec(desktop);
  assert.ok(eff, 'the new-scan effect could not be found');
  assert.ok(!/\bsync\(\)/.test(eff[1]),
    'the new-scan effect must not call the full sync()');
  pass('INCR-TC1', 'a new scan fetches only what is new');
}

// INCR-TC2: the counts describe the whole session, not the page.
//
// This is the one that protects Add All.
{
  start('INCR-TC2');
  assert.match(route, /SELECT COUNT\(\*\) AS total,[\s\S]{0,160}?FROM scan_staging WHERE user_id = \?/,
    'when `since` is used the totals must be queried across the WHOLE table; '
    + 'counting the returned page would report "1 staged" during a 75-card '
    + 'session and could enable Add All while unresolved rows remain');
  assert.match(route, /total: totals \? totals\.total : rows\.length/,
    'total must prefer the session-wide count');
  assert.match(route, /unresolved: totals \? \(totals\.unresolved \|\| 0\)/,
    'unresolved must prefer the session-wide count -- it is the Add All gate');
  pass('INCR-TC2', 'counts stay session-wide when the entries are partial');
}

// INCR-TC3: a partial response is flagged, so a client cannot mistake
// "nothing new" for "the session is empty" and wipe its table.
{
  start('INCR-TC3');
  assert.match(route, /partial: !!since/,
    'the response must say whether it is an increment or the full list');
  assert.match(staging, /entries = entries\.concat\(/,
    'refreshSince must APPEND; assigning would replace the table with just '
    + 'the new row');
  assert.match(staging, /const seen = new Set\(entries\.map\(e => e\.id\)\)/,
    'appending must dedupe by id -- a server that ignored `since` would '
    + 'otherwise double every row');
  pass('INCR-TC3', 'increments append and cannot duplicate or blank the list');
}

// INCR-TC4: a bad `since` degrades to the full list rather than failing.
//
// Falling back is always correct, just slower. Rejecting the request would
// empty the user's tray mid-session.
{
  start('INCR-TC4');
  assert.match(route, /Number\.isSafeInteger\(sinceRaw\) && sinceRaw > 0 \? sinceRaw : null/,
    'an unparseable or negative `since` must fall back to the full list');
  assert.match(staging, /if \(!since\) return refresh\(\)/,
    'with nothing held yet there is nothing to be incremental about');
  pass('INCR-TC4', 'a bad since degrades to the full list');
}

// INCR-TC5: mutations still reconcile against the server.
//
// An append-only client never sees a row that was EDITED or DELETED. The
// optimisation is for one hot case only.
{
  start('INCR-TC5');
  for (const fn of ['resolveEntry', 'updateEntry', 'discardEntry']) {
    const body = new RegExp(`async function ${fn}\\([\\s\\S]{0,900}?\\n  \\}`).exec(staging);
    assert.ok(body, `${fn} could not be found`);
    assert.match(body[0], /await refresh\(\)/,
      `${fn} must call the FULL refresh -- an incremental fetch cannot see `
      + 'the row it just changed, so the table would show stale data');
  }
  pass('INCR-TC5', 'mutations reconcile with a full refresh');
}

console.log(`\nincrementalStaging.test.js: ${passed} cases passed`);
