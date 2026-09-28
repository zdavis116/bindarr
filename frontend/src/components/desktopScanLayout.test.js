// Does the built desktop layout match the mockup Zach approved?
//
// "Copy this mockup 1 to 1."
//
// The approved artifact is sketches/scanner-desktop/c-balanced.html, and it
// stays the spec for as long as this is under review. This test reads THAT
// FILE -- not my description of it -- so a later round can check the artifact
// instead of my memory, which is exactly how the scanner port went wrong five
// times over.
//
// Markup and CSS survive a port because they get copied. INTERACTIONS do not,
// because they are re-implemented, so the handler inventory is checked too.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const mock = readFileSync(join(REPO, 'sketches/scanner-desktop/c-balanced.html'), 'utf8');
const jsx = readFileSync(join(HERE, 'DesktopScanLayout.jsx'), 'utf8');
const css = readFileSync(join(REPO, 'frontend/src/styles/desktop-scanner.css'), 'utf8');

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// DSK-TC1: the split geometry, read from the mockup rather than restated.
//
// This is the single number the whole variant exists for: "too big on A, too
// small on B". A fraction instead of a fixed width would re-introduce A's
// problem on a wider monitor.
{
  start('DSK-TC1');
  const m = /grid-template-columns:\s*(\d+)px\s+minmax\(0,\s*1fr\)/.exec(mock);
  assert.ok(m, 'the mockup no longer declares a fixed camera column');
  const want = m[1];
  const built = new RegExp(`grid-template-columns:\\s*${want}px\\s+minmax\\(0,\\s*1fr\\)`);
  assert.match(css, built,
    `the mockup pins the camera column at ${want}px; the build must use the `
    + 'same FIXED width. A fraction grows the camera on a wide monitor, which '
    + 'is the half of variant A that was rejected');
  pass('DSK-TC1', `camera column is a fixed ${want}px, as approved`);
}

// DSK-TC2: the columns, in the mockup's order, with Status gone.
//
// "we can remove status from the grid" -- and the removal must not silently
// drop the unresolved signal the pill was carrying.
{
  start('DSK-TC2');
  const head = /<thead>([\s\S]*?)<\/thead>/.exec(mock);
  assert.ok(head, 'the mockup table head could not be found');
  const wanted = [...head[1].matchAll(/>([A-Z][a-z]+)</g)].map(m => m[1]);
  assert.deepStrictEqual(wanted, ['Card', 'Set', 'Finish', 'When', 'Qty'],
    `the approved mockup's columns are ${wanted.join(', ')}; this test is `
    + 'stale if they changed');

  for (const col of wanted) {
    assert.ok(jsx.includes(`'${col}'`),
      `the built table is missing the ${col} column the mockup has`);
  }
  assert.ok(!/>Status</.test(mock), 'the mockup still has a Status column');
  assert.ok(!/'Status'/.test(jsx), 'the build still renders a Status column');

  // The pill was the only thing saying "unresolved" in words. With it gone the
  // Set cell has to say so, or the row shows a bare dash that reads as missing
  // data rather than as a question.
  assert.match(jsx, /needsPrintingShort/,
    'with Status removed, an unresolved row must still say so in the Set cell');
  pass('DSK-TC2', 'columns match the mockup and Status is gone without losing the signal');
}

// DSK-TC3: every interaction the mockup supports is wired in the build.
{
  start('DSK-TC3');
  const handlers = new Set([...mock.matchAll(/on(?:click|input)="(\w+)\(/g)].map(m => m[1]));
  handlers.delete('event');    // event.stopPropagation, not a feature
  handlers.delete('render');   // the mockup's own redraw, not a user action

  // Each mockup handler maps to a prop or local action in the build.
  const map = {
    toggle: /setOpenId\(/,          // expand a row
    pick: /onResolve\(/,            // choose a printing
    bump: /onSetQty\(/,             // change quantity
    addAll: /onAddAll\b/,           // commit
    clearAll: /onClear\b/,          // discard
  };
  for (const h of handlers) {
    assert.ok(map[h], `the mockup wires ${h}() and this test does not know about it`);
    assert.match(jsx, map[h],
      `the mockup supports ${h}() but the build never calls its equivalent -- `
      + 'interactions are re-implemented during a port, so they are what goes '
      + 'missing');
  }
  pass('DSK-TC3', `all ${handlers.size} mockup interactions are wired`);
}

// DSK-TC4: features the mockup was SILENT about are kept from the phone.
//
// Silence is not permission to drop a shipped feature. The mockup never showed
// a weak match, a search fallback, or removing a row, because none came up in
// a short demo -- all three exist on the phone today.
{
  start('DSK-TC4');
  for (const [what, re] of [
    ['weak-match warning', /isWeakMatch/],
    ['per-row search fallback', /onSearch\(/],
    ['remove a staged row', /onRemove\(/],
  ]) {
    assert.match(jsx, re,
      `${what} exists on the phone and the mockup was silent about it; a port `
      + 'must not drop it by omission');
  }
  pass('DSK-TC4', 'shipped features the mockup omitted are preserved');
}

// DSK-TC5: the phone layout is not touched.
//
// "don't touch the phone layout." Two independent guarantees: every rule is
// behind the desktop breakpoint, AND under a container the phone never mounts.
{
  start('DSK-TC5');
  assert.match(css, /@media \(min-width: 769px\)/,
    'the desktop layout must be behind the app\'s existing 769px breakpoint');

  // Nothing outside that query. Strip the guarded block and assert what is
  // left contains no rules -- a rule outside it would reach the phone.
  const withoutGuard = css.replace(/@media \(min-width: 769px\)\s*\{[\s\S]*\n\}/, '');
  const strayRule = /^[^@\/\s][^{}]*\{/m.test(
    withoutGuard.replace(/\/\*[\s\S]*?\*\//g, ''));
  assert.ok(!strayRule,
    'a CSS rule sits OUTSIDE the desktop media query; it would apply on the '
    + 'phone, which was explicitly ruled out');

  // And the component must not reach into the phone's classes.
  for (const phoneClass of ['camera-fullscreen', 'camera-preview-wrapper', 'scan-line']) {
    assert.ok(!css.includes(phoneClass) && !jsx.includes(phoneClass),
      `the desktop layout references '${phoneClass}', a phone class -- it must `
      + 'not override or reset the phone path');
  }
  pass('DSK-TC5', 'the phone layout is untouched by breakpoint and by scope');
}

// DSK-TC6: the two touches that carry the design's intent.
{
  start('DSK-TC6');
  assert.ok(/animation:\s*land|@keyframes land/.test(mock),
    'the mockup no longer flashes a landing row; this test is stale');
  assert.match(css, /animation: dsk-land/,
    'a newly staged row must flash, so "I scanned that" and "that row" connect '
    + 'without hunting');

  assert.ok(/Last scanned/.test(mock), 'the mockup no longer has a Last scanned panel');
  assert.match(jsx, /lastScanned/,
    'the large last-scanned card is the part of variant A worth keeping: it '
    + 'makes a misread visible while the card is still in hand');

  assert.match(css, /aspect-ratio: 4 \/ 3/,
    'the camera pane keeps the mockup\'s 4:3 box');
  pass('DSK-TC6', 'landing flash, last-scanned panel and camera box preserved');
}

console.log(`\ndesktopScanLayout.test.js: ${passed} cases passed`);
