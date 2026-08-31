// EVERY className MUST ACTUALLY EXIST IN THE STYLESHEET.
//
// Zach, on the manual card search in the Scanned list: "when you type in it you
// can't see what you typed like text color blends in with white text box."
//
// THE BUG. The input used className="input". There is no `.input` rule in
// index.css -- the app's 58 other inputs all use `input-control`. So it matched
// NOTHING, fell back to the browser's default input styling, and rendered
// unreadable text in a dark app. The class it should have had carries both
// `color: var(--text-primary)` and the app's input background, which is exactly
// why no other input has this problem.
//
// WHY A TEST, AND WHY THIS SHAPE. This is the FOURTH control Zach has reported
// as rendering-but-unusable:
//
//   1. Add All          -- underneath the bottom nav bar
//   2. the Scanned badge -- underneath the torch button
//   3. the camera exit   -- below the fold, off-screen
//   4. this input        -- styled by a class that does not exist
//
// Every one rendered. Every one had correct behaviour. Every one passed the
// entire suite. They are invisible to unit tests for the same reason: nothing
// checked whether a human could SEE or REACH the thing.
//
// A misspelled class name is silent in CSS by design -- there is no error, the
// element just gets nothing. That silence is what a machine should be catching,
// so this walks every className in the scan components and asserts the
// stylesheet actually defines it.
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'index.css'), 'utf8');

let passed = 0;
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// Every class the stylesheet defines, including grouped selectors
// (`.input-control, .select-control { ... }`).
const defined = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) defined.add(m[1]);

// Classes that genuinely have no stylesheet rule and do not need one. Listed
// individually so each exemption is a DECISION with a reason, not a hole that
// silently swallows the next real bug.
//
// Both of these were found by TC1 on its first run, which is the test earning
// its keep. Neither is a defect: the two modal backdrops in CameraScanner set
// every visual property inline (position, background, blur, layout), so the
// missing class changes nothing on screen. They read as intent markers.
//
// The card-search input was a different case entirely -- it had NO inline
// colour, so the absent class left the text unreadable. That distinction is the
// point: a missing class matters exactly when the element depends on it.
const ALLOWED_UNDEFINED = new Set([
  'modal-backdrop',    // fully styled inline; the name is documentation
  'animate-fade-in',   // animation never defined; purely decorative if added
]);

const FILES = readdirSync(join(here))
  .filter(f => /^(ScanStagingReview|CameraScanner)\.jsx$/.test(f));

// TC1: THE REGRESSION. No className in the scan UI may reference a class the
// stylesheet does not define.
{
  const missing = [];
  for (const f of FILES) {
    const src = readFileSync(join(here, f), 'utf8');
    // Only literal className="..." — template/expression forms are dynamic and
    // cannot be checked this way.
    for (const m of src.matchAll(/className="([^"{}]+)"/g)) {
      for (const cls of m[1].trim().split(/\s+/)) {
        if (!cls || defined.has(cls) || ALLOWED_UNDEFINED.has(cls)) continue;
        missing.push(`${f}: "${cls}"`);
      }
    }
  }
  assert.deepStrictEqual(
    missing, [],
    'className references a class that does not exist in index.css, so the '
    + 'element renders with NO styling at all:\n  ' + missing.join('\n  ')
    + '\nThis is silent in CSS -- no error, the element just gets nothing. It is '
    + 'how the card-search box ended up with invisible text.',
  );
  pass('CSS-TC1', 'every className in the scan UI exists in the stylesheet');
}

// TC2: the manual search input specifically uses the app's input class, so it
// inherits the text colour. Pinned by name because this is the control Zach
// reported and the search fallback is the ONLY way to fix a card whose printing
// the app could not work out.
{
  const src = readFileSync(join(here, 'ScanStagingReview.jsx'), 'utf8');
  const i = src.indexOf('placeholder="Card name"');
  assert.ok(i > 0, 'the manual card-search input must exist');
  // Wide enough to clear the explanatory comment between the placeholder and
  // the className -- an earlier 700-char window fell short and failed on
  // correct code.
  const block = src.slice(i, i + 1400);
  assert.ok(
    /className="input-control"/.test(block),
    'the card-search input must use input-control -- it carries color: '
    + 'var(--text-primary), without which the typed text is unreadable',
  );
  pass('CSS-TC2', 'the manual card-search input is styled and readable');
}

// TC3: and input-control really does set a text colour. If someone strips that
// declaration later, every input in the app inherits the bug at once.
{
  const rule = /\.input-control[^{]*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'index.css must define .input-control');
  assert.ok(
    /color:\s*var\(--text-primary\)/.test(rule[1]),
    'input-control must set an explicit text colour -- browser defaults are '
    + 'unreadable against this app\'s dark inputs',
  );
  pass('CSS-TC3', 'input-control sets an explicit, readable text colour');
}

console.log(`\nscanClassNames.test.js: ${passed} cases passed`);
