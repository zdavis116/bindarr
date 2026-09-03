// EVERY SINGLE-CARD SEARCH LOOKS THE SAME.
//
// Zach, after using the deployed build:
//
//   "commander search should function the same as other searches. Honestly all
//    single card searches should function the same. Because for the commander
//    create deck that search just shows Tony stark"
//
// There were three searches against /api/search -- the new-deck commander
// picker, the deck-view commander swap, and the deck-view add-card list --
// and each rendered its own row. The commander ones showed a name and a bare
// set code: no set name, no price, no foil-only marker, and the FRONT face
// only, so the same card read differently depending on which screen you were
// on.
//
// This is the FOURTH duplicated rule to drift on this branch, after deck
// sections, completion percentage, and ownership. Enforcing it structurally --
// one component -- rather than trusting me to edit three files next time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), 'utf8');

const shared = read('CardSearchResult.jsx');

test('CSP-TC1: the shared row shows both faces of a flip card', () => {
  // Zach: "for the commander create deck that search just shows Tony stark".
  // display_name is "Tony Stark // The Invincible Iron Man" and is null for
  // single-faced cards, so the fallback is the normal path.
  assert.match(shared, /card\.display_name \|\| card\.name/,
    'the row must prefer the full two-faced name');
});

test('CSP-TC2: the shared row names the printing', () => {
  // Bindarr records the exact physical card. Zach found four "identical" Tony
  // Starks that were different printings at different prices -- a row that
  // does not name its printing asks the user to choose blind.
  assert.match(shared, /set_id/, 'set code');
  assert.match(shared, /number/, 'collector number');
  assert.match(shared, /set_name/, 'set name');
});

test('CSP-TC3: the shared row marks foil-only printings', () => {
  // MSH #392 exists only as a foil. Picking it expecting a nonfoil is a wrong
  // record about cardboard, which is the failure this app exists to avoid.
  // Checking the RENDER, not the variable name: this test passed while the
  // marker text was replaced with an empty string, because `foilOnly` still
  // appeared as a local variable.
  assert.match(shared, /foilOnly &&/,
    'the foil-only marker must actually be rendered');
  assert.match(shared, /card\.foilOnly|t\(.card\.foilOnly.\)/,
    'and must use the translated label');
});

test('CSP-TC4: no screen renders its own search result row', () => {
  // The structural half. A second implementation is how these drifted in the
  // first place, so the check is "does any component build a result row by
  // hand" rather than "did I remember to update all three".
  const offenders = [];
  for (const f of readdirSync(here).filter(n => n.endsWith('.jsx'))) {
    if (f === 'CardSearchResult.jsx') continue;
    const src = read(f);
    // A search-result map that renders a <button> inline, rather than
    // delegating to the shared row.
    const inline = /(results|commanderResults)\.map\(\s*\w+\s*=>\s*\(?\s*<button/;
    if (inline.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    `these render their own search rows instead of using CardSearchResult: ${offenders.join(', ')}`);
});

test('CSP-TC5: every search screen imports the shared row', () => {
  for (const f of ['NewDeckModal.jsx', 'DeckView.jsx']) {
    assert.match(read(f), /import CardSearchResult from '\.\/CardSearchResult\.jsx'/,
      `${f} must use the shared search row`);
  }
});

test('CSP-TC6: deck-specific facts stay optional', () => {
  // The add-card row shows "1 in this deck" / "2 of 3 free", which only make
  // sense with a deck in hand. A commander picker has no such context and must
  // not be forced to invent ownership numbers -- so the slot is optional and
  // the price stands in its place.
  assert.match(shared, /trailing/,
    'the row must accept a caller-supplied trailing column');
  assert.match(shared, /trailing \|\|/,
    'and fall back to the price when there is none');
});
