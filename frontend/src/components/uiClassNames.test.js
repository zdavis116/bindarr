// EVERY className IN THE APP MUST MATCH A REAL CSS RULE.
//
// This is the generalised version of scanClassNames.test.js, which was written
// after Zach reported: "when you type in it you can't see what you typed like
// text color blends in with white text box."
//
// The cause was a one-word bug. The manual card search used className="input";
// the app's class is "input-control". "input" matches NO rule anywhere, so the
// element fell back to browser defaults -- black-on-white in a dark app. CSS is
// silent about this by design: a class that matches nothing is not an error,
// the element simply gets nothing.
//
// That was the FOURTH control this week that rendered, had a correct handler,
// passed every test, and could not be used:
//   1. Add All            -- under the nav bar
//   2. Scanned badge      -- pinned to the same corner as the torch
//   3. Camera exit        -- below the fold
//   4. Manual search      -- a class matching no rule
//
// Nothing in the suite knew whether a human could see or reach any of them.
// This test closes exactly one of those holes -- the mechanical one -- across
// the WHOLE app rather than one screen, because the UI overhaul is about to
// rewrite eleven screens and a typo'd class is invisible until Zach hits it.
//
// It does NOT prove reachability. Position, z-index, and fold are still only
// caught by a human looking at a phone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..');
const cssPath = join(srcDir, 'index.css');
const css = readFileSync(cssPath, 'utf8');

// Class names the stylesheet actually defines.
const defined = new Set(
  [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]),
);

// Utility classes applied inline or by a library rather than by index.css.
// Each is listed with its reason: an unexplained allowlist grows until the
// test stops meaning anything.
const ALLOWED = new Map([
  // Every visual property is set inline via style={{...}}; the class is a hook
  // for querying in tests, not a style. Verified by reading the JSX.
  ['modal-backdrop', 'all styling inline; class is a test hook'],
  ['animate-fade-in', 'animation applied inline'],
  // Recharts injects these itself.
  ['recharts-wrapper', 'injected by recharts'],
  ['recharts-surface', 'injected by recharts'],

  // --- Found by this test on its first run, in shipped code -------------
  //
  // MODIFIERS ON AN ALREADY-STYLED BASE. These appear as the second or third
  // class ("btn btn-secondary btn-sm"), so the element is fully styled by the
  // base class and the modifier is inert -- it changes nothing today, but it
  // also cannot make the control unusable. Left as-is rather than deleted:
  // Phase B rewrites these screens, and churning them now would collide.
  ['btn-sm', 'modifier on .btn/.btn-secondary; base class carries all styling'],
  ['empty', 'modifier on .binder-pocket; base class carries all styling'],

  // LAYOUT WRAPPERS whose grid is set inline via style={{...}}. Verified by
  // reading each call site.
  ['admin-grid-layout', 'grid set inline at AdminPanel.jsx:544'],
  ['settings-grid', 'grid set inline at Settings.jsx:385'],
  ['switch-control', 'all styling inline at Settings.jsx (3 call sites)'],
  ['badge', 'all styling inline at CheckoutWizardModal.jsx:196'],

  // NOT ALLOWED, and deliberately absent from this list:
  //   slot-number (CompartmentView.jsx:636) -- a bare class with NO rule and
  //   NO inline style. It is the same shape as the invisible-text bug. Fixed
  //   in the same commit as this test rather than allowlisted, because
  //   allowlisting a genuine miss is how the check stops being a check.
]);

function componentFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...componentFiles(p));
    else if (entry.name.endsWith('.jsx')) out.push(p);
  }
  return out;
}

const files = componentFiles(join(srcDir, 'components'))
  .concat([join(srcDir, 'App.jsx')].filter(p => {
    try { readFileSync(p); return true; } catch { return false; }
  }));

test('UICN-TC1: the stylesheet parsed and defines real classes', () => {
  // If the regex ever silently matches nothing, every other case in this file
  // would pass vacuously -- the failure mode that made two earlier tests in
  // this repo worthless.
  assert.ok(defined.size > 50,
    `expected the stylesheet to define many classes, found ${defined.size}`);
  assert.ok(defined.has('input-control'),
    'input-control must be found -- it is the class the invisible-text bug '
    + 'should have used');
});

test('UICN-TC2: found the components to check', () => {
  assert.ok(files.length > 15,
    `expected to scan the app's components, found ${files.length} files`);
});

test('UICN-TC3: every className matches a defined CSS class', () => {
  const problems = [];

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    // Static className="a b c" only. Template literals and conditionals are
    // deliberately skipped: they cannot be resolved without evaluating the
    // component, and a test that guesses at them would produce false failures
    // and get disabled.
    for (const m of src.matchAll(/className="([^"{}]+)"/g)) {
      for (const cls of m[1].trim().split(/\s+/)) {
        if (!cls || defined.has(cls) || ALLOWED.has(cls)) continue;
        problems.push(`${file.replace(srcDir, 'src')}: "${cls}"`);
      }
    }
  }

  assert.deepEqual(problems, [],
    'These classNames match NO rule in index.css, so the elements get browser '
    + 'defaults -- the invisible-text bug. Either fix the name or add it to '
    + 'ALLOWED with a reason:\n  ' + problems.join('\n  '));
});
