// The desktop side pane must not be drawn through, and card text must wrap.
//
// Zach, with a full screenshot: "the right pane is all messed up".
//
// TWO SEPARATE BUGS in one picture, and neither was a regression from that
// day's work -- both had been there since the pane was built.
//
// 1. THE PANE HAD NO z-index. It is `position: fixed`, so it leaves the flow
//    entirely and stacks by document order, which loses to ANY positioned
//    element. The deck list's sticky section headers are z-index 5, so a
//    header and a stray card count "1" drew straight through the pane on top
//    of the oracle text.
//
// 2. THE ORACLE TEXT DID NOT WRAP. Oscorp Industries' Mayhem reminder is one
//    long line; `white-space: pre-wrap` preserves the card's own breaks but
//    will not break a line that has nowhere to break. The last line rendered
//    as "ng rules still apply.)" -- clipped at the left, not wrapped.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, '..', 'index.css'), 'utf8');
const layers = readFileSync(join(HERE, '..', 'utils', 'zLayers.js'), 'utf8');
const modal = readFileSync(join(HERE, 'CardInspectorModal.jsx'), 'utf8');
const deck = readFileSync(join(HERE, 'DeckView.jsx'), 'utf8');

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// PANE-TC1: the fixed pane declares a stacking order.
{
  start('PANE-TC1');
  const rule = /\.deck-panes-side \{[\s\S]*?\n  \}/.exec(css);
  assert.ok(rule, '.deck-panes-side could not be found');
  assert.match(rule[0], /position: fixed;/,
    'the pane is fixed -- which is exactly why it needs a z-index');
  const z = /z-index: (\d+);/.exec(rule[0]);
  assert.ok(z,
    'a position:fixed pane with NO z-index stacks by document order and loses '
    + "to the list's sticky headers. That is the bug in Zach's screenshot");
  pass('PANE-TC1', 'the pane declares a stacking order');
}

// PANE-TC2: it sits ABOVE the list it covers and BELOW the app header.
//
// Both directions matter. Too low and the list draws through it; too high and
// it covers the header it is positioned beneath.
{
  start('PANE-TC2');
  const rule = /\.deck-panes-side \{[\s\S]*?\n  \}/.exec(css)[0];
  const paneZ = Number(/z-index: (\d+);/.exec(rule)[1]);

  // The list's sticky section headers, set inline in DeckView.
  const listZ = Number(/position: 'sticky', top: 0,[\s\S]{0,120}?zIndex: (\d+)/.exec(deck)[1]);
  assert.ok(paneZ > listZ,
    `the pane (${paneZ}) must sit above the list's sticky headers (${listZ})`);

  // The app header, which the pane is positioned under.
  const headerZ = Number(/\.app-header \{[\s\S]*?z-index: (\d+);/.exec(css)[1]);
  assert.ok(paneZ < headerZ,
    `the pane (${paneZ}) must sit BELOW the app header (${headerZ}); an equal `
    + 'value resolves by document order, which is the accident being fixed');
  pass('PANE-TC2', 'the pane is above the list and below the header');
}

// PANE-TC3: the value is in the shared registry, not only in the stylesheet.
//
// zLayers.js exists because "numbers scattered through JSX cannot be reasoned
// about". A pane z-index that lives only in index.css is the same problem.
{
  start('PANE-TC3');
  assert.match(layers, /export const Z_SIDE_PANE = (\d+);/,
    'the side pane must be a named layer, not a bare number in one stylesheet');
  const declared = Number(/export const Z_SIDE_PANE = (\d+);/.exec(layers)[1]);
  const inCss = Number(/\.deck-panes-side \{[\s\S]*?z-index: (\d+);/.exec(css)[1]);
  assert.strictEqual(declared, inCss,
    `zLayers says ${declared}, index.css says ${inCss}. They must agree or the `
    + 'registry is documentation rather than truth');
  pass('PANE-TC3', 'the layer is registered and matches the stylesheet');
}

// PANE-TC4: long rules text wraps instead of overflowing.
{
  start('PANE-TC4');
  const box = /\{faceRules && \([\s\S]*?\}\}>/.exec(modal);
  assert.ok(box, 'the oracle text box could not be found');
  assert.match(box[0], /whiteSpace: 'pre-wrap'/,
    "the card's own line breaks must be preserved");
  assert.match(box[0], /overflowWrap: 'anywhere'/,
    'pre-wrap alone will not break a long line with nowhere to break, which '
    + 'is how "ng rules still apply.)" ended up clipped');
  assert.match(box[0], /minWidth: 0/,
    'a grid child will not shrink below its content without minWidth:0, so '
    + 'the box would push past its track however the text wraps');
  pass('PANE-TC4', 'rules text wraps to its column');
}

console.log(`\nsidePaneLayout.test.js: ${passed} cases passed`);
