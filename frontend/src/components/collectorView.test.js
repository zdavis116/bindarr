// The Collector view: how complete is each set?
//
// Zach: "show how many of the cards I have collected from the set like x out
// of x" / "it should be a view change in the collection section. Like grid
// view, list view and then collector view. We would see a bar with
// percentage."
//
// HIS RULES, which are the whole specification:
//   "the full set... every number for a set 1 to whatever like lands are 389
//    they should be included like borderless has its own number as well"
//   "foil doesn't count as long as I have 1 card for that set and number combo"
//   "Don't include tokens though, just main set cards"
//
// Verified against his real collection on dev: 103 sets, 0 over 100%,
// Reality Fracture 288/461.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const route = readFileSync(join(REPO, 'backend/src/routes/collection.js'), 'utf8');
const view = readFileSync(join(HERE, 'CollectorView.jsx'), 'utf8');
const list = readFileSync(join(HERE, 'CollectionList.jsx'), 'utf8');

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// COLL-TC1: the counting rules are Zach's, expressed in SQL.
{
  start('COLL-TC1');
  const q = /router\.get\('\/set-completion'[\s\S]*?\n\}\);/.exec(route);
  assert.ok(q, '/set-completion could not be found');
  // ANCHORED TO THE SELECTED COLUMN, not to the expression anywhere in the
  // query. COUNT(DISTINCT c.number) also appears in the ORDER BY, so a loose
  // match stayed green when the SELECT was changed to COUNT(c.number) --
  // meaning a foil and a non-foil of the same card would each advance the
  // bar, and the guard for Zach's clearest rule was vacuous.
  assert.match(q[0], /COUNT\(DISTINCT c\.number\)\s+AS owned/,
    'the numerator must count DISTINCT collector numbers -- "foil doesn\'t '
    + 'count as long as I have 1 card for that set and number combo", and '
    + 'four copies of one card is still one card toward the set');
  assert.match(q[0], /s\.series != 'token'/,
    'token sets must be excluded -- "just main set cards"');
  assert.match(q[0], /CAST\(c\.number AS INTEGER\) BETWEEN 1 AND s\.total/,
    'the range is 1..total, so borderless counts (it has its own number) '
    + 'while promos numbered above the set do not push the bar past full');
  assert.match(q[0], /c\.number GLOB '\[0-9\]\*'/,
    'non-numeric collector numbers cannot be range-checked and must be '
    + 'excluded rather than silently casting to 0');
  pass('COLL-TC1', 'distinct numbers in range, no tokens');
}

// COLL-TC2: the denominator is the set's real size, and cannot exceed 100%.
//
// The `sets` table was stale when this was built -- Reality Fracture cached at
// 43 of its real 461 -- which would have rendered 670%. That is fixed
// separately, but a UI that can render an impossible number will eventually
// render one.
{
  start('COLL-TC2');
  const q = /router\.get\('\/set-completion'[\s\S]*?\n\}\);/.exec(route)[0];
  assert.match(q, /Math\.min\(100,/,
    'the percentage must be clamped: a bar reading 101% destroys trust in '
    + 'every other number on the screen');
  assert.match(q, /s\.total > 0/,
    'a set with no known size must be skipped, not divided by');
  pass('COLL-TC2', 'percent is clamped and never divides by zero');
}

// COLL-TC3: the work happens in SQL, not on the phone's main thread.
{
  start('COLL-TC3');
  assert.match(view, /fetch\('\/api\/set-completion'\)/,
    'the view must read the server endpoint rather than regrouping the '
    + 'whole collection in the browser');
  assert.ok(!/collection\.(reduce|filter|forEach)\(/.test(view),
    'CollectorView must not compute completion from the collection array; '
    + 'that is 4,968 rows grouped on the main thread for a number the '
    + 'database produces in one indexed pass');
  pass('COLL-TC3', 'completion is computed server-side');
}

// COLL-TC4: it is a third VIEW MODE, beside gallery and list.
{
  start('COLL-TC4');
  assert.match(list, /m: 'collector', Icon: Library/,
    'collector must be a third button in the existing view switcher -- '
    + '"like grid view, list view and then collector view"');
  assert.match(list, /Library[,\s].*from 'lucide-react'|Library,/,
    'the Library icon must be imported, or the button throws at render');
  assert.match(list, /viewMode === 'collector' \? \(/,
    'the collector branch must exist in the render');
  pass('COLL-TC4', 'collector is a third view mode');
}

// COLL-TC5: the collector view ignores the card filters.
//
// The filters narrow which cards are LISTED; set completion is about which
// cards are MISSING. Running it through `shown` would mean filtering to Mythic
// renders "no cards match" instead of progress bars, and the branch has to sit
// before the empty-state check for that to hold.
{
  start('COLL-TC5');
  const idx = list.indexOf("viewMode === 'collector' ? (");
  const empty = list.indexOf('shown.length === 0 ? (');
  assert.ok(idx > 0 && empty > 0, 'the render branches could not be found');
  assert.ok(idx < empty,
    'the collector branch must come BEFORE the empty-state branch, or a '
    + 'filter matching nothing hides the whole view');
  assert.ok(!/<CollectorView[^>]*shown/.test(list),
    'the collector view must not be handed the filtered list');
  pass('COLL-TC5', 'set progress is not hidden by card filters');
}

// COLL-TC6: every string exists, and a failed load does not blank the screen.
{
  start('COLL-TC6');
  const en = JSON.parse(readFileSync(join(HERE, '..', 'locales', 'en.json'), 'utf8'));
  for (const k of [...view.matchAll(/\bt\('([^']+)'/g)].map(m => m[1])) {
    assert.ok(k in en || `${k}.one` in en,
      `${k} has no string; this app renders the KEY when one is missing, so `
      + 'the screen would show "' + k + '"');
  }
  assert.ok(!/setRows\(\[\]\)/.test(view) && !/setRows\(null\)/.test(view.split('catch')[1] || ''),
    'a failed refresh must keep what is already on screen rather than '
    + 'blanking a view the user is reading');
  pass('COLL-TC6', 'strings exist and a failed refresh is non-destructive');
}

console.log(`\ncollectorView.test.js: ${passed} cases passed`);
