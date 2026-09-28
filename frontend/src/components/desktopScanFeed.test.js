// The desktop table must FETCH a new scan, not just count it.
//
// THE BUG (Zach): "its scanning but its not adding to the staged area though
// it does say its scanning the card successfully."
//
// staging.noteStaged() increments stagedCount and emits. It does NOT append
// to `entries` -- only refresh() ever fills that. On the phone this is
// correct and deliberate: the tray is an overlay that refreshes when it
// OPENS, so the list is accurate by the time anyone looks, and paying a full
// GET (thumbnails and all) after every scan was a real cost that was removed
// on purpose.
//
// The desktop table is visible the whole time and never "opens", so it broke
// that assumption: the counter moved while the table above it stayed empty.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const jsx = readFileSync(join(HERE, 'DesktopScanLayout.jsx'), 'utf8');
const staging = readFileSync(join(HERE, 'scanStaging.js'), 'utf8');

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// FEED-TC1: the premise. noteStaged must NOT be assumed to fill entries.
//
// If this ever changes upstream, the fix below becomes redundant rather than
// wrong -- but the assertion documents WHY the desktop refreshes, so a future
// reader does not delete it as a pointless extra fetch.
{
  start('FEED-TC1');
  const fn = /function noteStaged\([\s\S]*?\n  \}/.exec(staging);
  assert.ok(fn, 'noteStaged could not be found');
  assert.ok(!/entries\s*=|entries\.push|entries\.unshift/.test(fn[0]),
    'noteStaged now writes to entries; the desktop refresh may be redundant, '
    + 'but check before removing it');
  assert.match(staging, /entries = Array\.isArray\(body\?\.entries\)/,
    'entries is filled by the refresh response; if that changed, this whole '
    + 'reasoning needs revisiting');
  pass('FEED-TC1', 'noteStaged only counts — entries come from the server');
}

// FEED-TC2: a new scan triggers a real refresh, not a local re-read.
//
// setState(staging.getState()) was the first attempt and could not work: the
// rows genuinely are not in local state, so re-reading it returns the same
// empty list.
{
  start('FEED-TC2');
  const eff = /useEffect\(\(\) => \{\s*if \(lastScanned\)([\s\S]{0,120}?)\}, \[lastScanned[^\]]*\]\);/.exec(jsx);
  assert.ok(eff, 'the new-scan effect could not be found');
  // THE RULE IS "GO TO THE SERVER", not "call a function named sync".
  //
  // This originally required sync() by name and went red the moment the hot
  // path became refreshSince() -- which still fetches, just incrementally.
  // Asserting the mechanism rather than the spelling: either full refresh or
  // an incremental one is correct here; re-reading local state is not.
  assert.match(eff[1], /sync\(\)|staging\.refreshSince\(\)/,
    'a new scan must FETCH from the server. setState(staging.getState()) '
    + 're-reads local state that does not contain the new row — that IS the '
    + 'bug this test exists for');
  assert.ok(!/setState\(staging\.getState\(\)\)/.test(eff[1]),
    'the new-scan effect must not merely re-read local state');
  pass('FEED-TC2', 'a new scan refreshes from the server');
}

// FEED-TC3: the effect can actually fire twice for the same card.
//
// If lastScanned were keyed on card identity, scanning two copies of the same
// card would not change the dependency and the second would never appear.
{
  start('FEED-TC3');
  const scanner = readFileSync(join(HERE, 'CameraScanner.jsx'), 'utf8');
  const sets = [...scanner.matchAll(/setLastScannedCard\(\{([\s\S]{0,120}?)\}\)/g)];
  assert.ok(sets.length >= 2,
    `setLastScannedCard is called ${sets.length} time(s); both the resolved `
    + 'and unresolved staging paths must set it, or unresolved cards never '
    + 'appear in the desktop table');
  for (const s of sets) {
    assert.ok(/staged_id/.test(s[1]),
      'each call must carry staged_id — it ties the row to the flash and '
      + 'makes a repeat scan of the SAME card a distinct object');
  }
  pass('FEED-TC3', 'both staging paths signal, and repeats are distinguishable');
}

console.log(`\ndesktopScanFeed.test.js: ${passed} cases passed`);
