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
  assert.match(list, /setSelectedIds\(new Set\(shown\.map\(c => c\.entry_id \|\| c\.id\)\)\)/,
    'select-all must read `shown`, not `collection`');
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
  const selectCalls = list.match(/selectAt\(card\.entry_id \|\| card\.id,/g) || [];
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
