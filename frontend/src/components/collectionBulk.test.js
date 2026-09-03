import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// BULK SELECT ON THE COLLECTION SCREEN.
//
// Zach asked for three things: select what is filtered, move to a storage
// location, and delete with an undo. The backend already had bulk move and
// delete; this is the path to them.
//
// The failure this project keeps hitting is a control that renders, has a
// correct handler, passes its tests -- and is unreachable. These check the
// PATH, not just the parts.

const list = readFileSync(join(here, 'CollectionList.jsx'), 'utf8');
const hook = readFileSync(join(here, '../utils/useMultiSelect.js'), 'utf8');
const en = JSON.parse(readFileSync(join(here, '../locales/en.json'), 'utf8'));

test('BULK-TC1: select mode is reachable without a hidden gesture', () => {
  // Long-press arms it, but a gesture nobody knows about is not a feature --
  // and on a phone it competes with the browser's own text selection.
  assert.match(list, /onClick=\{\(\) => \(selectMode \? exitSelectMode\(\) : setSelectMode\(true\)\)\}/,
    'an explicit Select button must exist');

  // And it must NOT be buried inside the add-cards dropdown: selecting is a
  // top-level action, not an add action.
  const menuAt = list.indexOf('{addMenuOpen && (');
  const btnAt = list.indexOf('setSelectMode(true)');
  assert.ok(menuAt > 0 && btnAt < menuAt,
    'the Select button must sit in the toolbar, not inside the + menu');
});

test('BULK-TC2: select all means what is FILTERED', () => {
  // Zach: "Select all should be on what's filtered, so what cards are showing
  // on screen." `shown` is the filtered, sorted list; `collection` is
  // everything. Using the wrong one on a destructive action is a recount
  // against cardboard.
  assert.match(list, /setSelectedIds\(new Set\(shown\.flatMap\(c => c\.member_ids/,
    'select-all must read `shown` AND expand each grouped tile to its rows');
  assert.doesNotMatch(list, /setSelectedIds\(new Set\(collection\.map/,
    'selecting the whole collection from a filtered view is the dangerous case');
});

test('BULK-TC3: the button names the count', () => {
  // A bare "Select all" beside a filtered list could mean 47 or 2,433.
  assert.match(list, /t\('bulk\.selectAllShown', \{ count: shown\.length \}\)/,
    'the count must be in the label');
  assert.match(en['bulk.selectAllShown'], /\{count\}/,
    'and the string must actually interpolate it');
});

test('BULK-TC4: rows respond to selection in BOTH views', () => {
  // Working in list view and silently doing nothing in gallery is the same
  // class of bug as an unreachable button.
  const selectCalls = list.match(/toggleGroup\(card, e\??\.shiftKey\)/g) || [];
  assert.equal(selectCalls.length, 2,
    'both the list rows and the gallery tiles must be selectable');
  assert.match(list, /selected=\{selectedIds\.has\(card\.entry_id \|\| card\.id\)\}/,
    'and the gallery tile must show its selected state');
});

test('BULK-TC5: a long press does not also open the inspector', () => {
  // The press that arms select mode ends in a click. Without this guard,
  // every long press opens the card sheet over the selection he just started.
  const guards = list.match(/if \(longPressFired\.current\) return;/g) || [];
  assert.equal(guards.length, 2, 'both views need the guard');
});

test('BULK-TC6: delete is confirmed and the confirm names the count', () => {
  // "Delete selected" hides how much that is.
  assert.match(list, /runBulk\('delete', null,\s*\n?\s*t\('bulk\.confirmDelete', \{ count: selectedIds\.size \}\)\)/,
    'the delete must pass a confirm message carrying the count');
  assert.match(en['bulk.confirmDelete'], /\{count\}/);
  assert.match(en['bulk.confirmDelete'], /undo/i,
    'and should say it is recoverable, because it is');
});

test('BULK-TC7: the undo is REACHABLE', () => {
  // The trash makes a delete recoverable. This is the only thing that makes
  // the recovery reachable -- without it the batch sits in a table Zach has no
  // way to see, which is the same as no undo.
  assert.match(list, /\{lastDelete && \(/,
    'the undo banner must render');
  assert.match(list, /`\/api\/collection\/trash\/\$\{lastDelete\.batchId\}\/restore`/,
    'and call the restore route');
  assert.match(list, /setLastDelete\(\{ batchId, count: data\?\.affected \?\? ids\.length \}\)/,
    'the count comes from the response -- selectedIds is already cleared');
});

test('BULK-TC8: the hook passes the batch id through', () => {
  // It previously called onChanged({ ids, action, value }). My CollectionList
  // callback destructured `batchId` and would have received undefined
  // forever: no error, no undo, just a toast without the one button that makes
  // the delete recoverable.
  assert.match(hook, /onChanged\(\{ ids, action, value, batchId: data\.batch_id, data \}\)/,
    'the delete response carries batch_id and it must reach the caller');
});

test('BULK-TC9: moving to a location is confirmed and names it', () => {
  // Non-destructive, but moving 100 cards to the wrong box is still a
  // physical sorting job to undo.
  assert.match(list, /runBulk\('move', v, t\('bulk\.confirmMove', \{/,
    'the move must confirm');
  assert.match(en['bulk.confirmMove'], /\{count\}/);
  assert.match(en['bulk.confirmMove'], /\{location\}/,
    'and name the destination, not just the count');
});

test('BULK-TC10: every bulk key the screen renders exists', () => {
  // A missing key renders the key itself -- "bulk.selectAllShown" where a
  // sentence should be.
  const used = [...list.matchAll(/t\('(bulk\.[a-zA-Z0-9_.]+)'/g)].map(m => m[1]);
  assert.ok(used.length >= 6, 'the screen should use several bulk keys');
  const missing = used.filter(k => !(k in en));
  assert.deepEqual(missing, [], 'these would render as raw text');
});

test('BULK-TC11: a grouped tile selects EVERY row it stands for', () => {
  // THE BUG ZACH FOUND. "it's not deleting every card in my collection when
  // doing select all", with no filters on.
  //
  // `shown` groups duplicates: four Forests with the same card_id, condition
  // and printing collapse into ONE tile reading x4, keeping the first row's
  // entry_id. So select-all collected one id per TILE and left the siblings
  // untouched -- exactly what survived on his dev box: #137/#140/#144/#145
  // Forest and #122/#129 Hashaton, every one a duplicate.
  //
  // It looked like it worked, which is worse: the tile disappears because its
  // key row really was deleted, and the rest quietly remain.
  assert.match(list, /seen\.member_ids\.push\(card\.entry_id \|\| card\.id\)/,
    'a group must remember every row it swallowed');
  assert.match(list, /member_ids: \[card\.entry_id \|\| card\.id\]/,
    'including the first one');
  assert.match(list, /shown\.flatMap\(c => c\.member_ids \|\| \[c\.entry_id \|\| c\.id\]\)/,
    'and select-all must expand them');
});

test('BULK-TC12: tapping a tile is all-or-none', () => {
  // Half a selected tile is not a state the UI can render, so it must not be
  // a state the selection can hold.
  assert.match(list, /const allSelected = ids\.every\(id => next\.has\(id\)\)/,
    'a tile toggles on whether ALL its rows are selected');
  assert.match(list, /ids\.forEach\(id => \(allSelected \? next\.delete\(id\) : next\.add\(id\)\)\)/,
    'and applies the same action to every one');
});

test('BULK-TC13: shift-range covers every row in the ranged tiles', () => {
  // Ranging over raw entry ids would pick up rows that are not adjacent on
  // screen -- the range must be over tiles, then expanded.
  assert.match(list, /for \(let i = lo; i <= hi; i\+\+\) members\(tiles\[i\]\)\.forEach/,
    'the range expands each tile to its members');
});

test('BULK-TC14: Select sits beside the +, not above it', () => {
  // Zach: "select should be next to the '+' not on top of". My first placement
  // put it before the + button's wrapper but outside the flex row, so it
  // stacked onto its own line and read as a heading.
  const sel = list.indexOf("bulk.done' : 'collection.select'");
  const plus = list.indexOf('aria-expanded={addMenuOpen}');
  assert.ok(sel > 0 && plus > sel, 'Select comes first in the source');

  // Both must live inside the same flex row.
  const row = list.lastIndexOf("display: 'flex', alignItems: 'center', gap: '0.6rem'", sel);
  assert.ok(row > 0 && row < sel && row < plus,
    'Select and + must share the toolbar row, not stack');

  // And nothing on the button may force it onto its own line. This is the
  // honest limit of a source-reading test: it can catch `display: block`, but
  // it cannot prove the two render side by side at 393px. Zach's screenshot
  // is the only real check for that.
  const btn = list.slice(list.lastIndexOf('<button', sel), sel);
  assert.doesNotMatch(btn, /display: 'block'|width: '100%'|flexBasis: '100%'/,
    'a full-width or block button wraps to its own line regardless of the row');
});
