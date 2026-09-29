// Lowering a stacked tile's quantity must actually remove a copy.
//
// THE BUG (Zach): "when trying to edit a quantity from 2 to 1 the quantity
// wont change. I am trying to edit Jace's Machinations from 2 to 1 for the
// foil version and it wont change."
//
// THE DATA, checked before any code was written. There was no row with
// quantity 2. He owned TWO rows of quantity 1:
//
//     id=18495  qty=1  finish=foil
//     id=18798  qty=1  finish=foil
//
// One physical card is one row -- splitStackedEntries enforces that on
// purpose, so each copy can carry its own condition and storage slot. The
// collection screen SUMS them into a tile reading "2".
//
// So the old code did exactly the wrong thing: it PUT quantity=1 to a single
// entry id, that row was ALREADY 1, the server returned 200, and the tile
// still read 2. Reproduced end to end on dev before the fix.
//
// A SUCCESS RESPONSE FOR A CHANGE THAT CANNOT HAPPEN is worse than an error:
// nothing looks broken, so the user repeats it and doubts the app instead.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const modal = readFileSync(join(HERE, 'CardInspectorModal.jsx'), 'utf8');
const list = readFileSync(join(HERE, 'CollectionList.jsx'), 'utf8');
const route = readFileSync(join(REPO, 'backend/src/routes/collection.js'), 'utf8');

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// QTY-TC1: the premise -- a tile's number is a SUM of rows, not a column.
//
// If this ever changes, the fix below becomes wrong rather than redundant, so
// the assumption is pinned rather than assumed.
{
  start('QTY-TC1');
  assert.match(list, /seen\.quantity = \(seen\.quantity \|\| 1\) \+ \(card\.quantity \|\| 1\)/,
    'the collection screen sums grouped rows into one tile; if it stopped '
    + 'doing that, lowering a quantity would be a simple field edit again');
  assert.match(list, /member_ids: \[card\.entry_id \|\| card\.id\]/,
    'the tile must carry every row it stands for -- that list is the only '
    + 'handle on the copies a quantity edit has to remove');
  pass('QTY-TC1', 'a tile is a sum of rows, and knows which rows');
}

// QTY-TC2: lowering a stacked quantity deletes rows.
{
  start('QTY-TC2');
  assert.match(modal, /const memberIds = Array\.isArray\(card\?\.member_ids\) \? card\.member_ids : null;/,
    'the edit needs the tile\'s member rows');
  assert.match(modal, /wanted < stackSize && wanted >= 1/,
    'only a DECREASE within the stack is handled this way; raising a '
    + 'quantity is adding cards, which is a different operation');
  assert.match(modal, /memberIds\.slice\(wanted\)/,
    'keep the first `wanted` rows and remove the rest -- the oldest row is '
    + 'the one most likely to carry the purchase price and storage slot');
  assert.match(modal, /entry_ids: doomed, action: 'delete'/,
    'removal must go through the same bulk endpoint the selection UI uses, '
    + 'or the two paths can disagree about what removing a copy means');
  pass('QTY-TC2', 'lowering a stack removes the extra rows');
}

// QTY-TC3: it does not fire when it should not.
//
// A quantity edit that deleted rows on a single-row tile, or on a field that
// is not the quantity, would destroy cards silently.
{
  start('QTY-TC3');
  const block = /const memberIds = [\s\S]*?\n      return;\n    \}/.exec(modal);
  assert.ok(block, 'the stacked-quantity branch could not be found');
  assert.match(block[0], /field === 'quantity'/,
    'the delete path must be gated on the quantity field specifically');
  assert.match(block[0], /stackSize > 1/,
    'a single-row tile must take the normal PUT; deleting its only row would '
    + 'remove the card entirely when the user asked to set a number');
  assert.match(block[0], /Number\.isFinite\(wanted\)/,
    'an unparseable quantity must not reach a delete');
  pass('QTY-TC3', 'the delete path is narrowly gated');
}

// QTY-TC4: the removal is recoverable.
//
// Deleting real collection rows is the most destructive thing this app does on
// the user's behalf. Verified on dev: the removed copy lands in
// collection_trash as its own batch.
{
  start('QTY-TC4');
  const bulk = /router\.post\('\/collection\/bulk'[\s\S]*?\n\}\);/.exec(route);
  assert.ok(bulk, 'the bulk route could not be found');
  assert.match(bulk[0], /trashEntries\(ids, req\.user\.id\)/,
    'bulk delete must move rows to collection_trash, not drop them -- a '
    + 'quantity edit that destroys a card with no undo is data loss with a '
    + 'friendly label');
  pass('QTY-TC4', 'the removed copy goes to the trash');
}

// QTY-TC5: the screen refreshes, so the tile actually changes.
//
// The original bug was invisible precisely because the UI reported success.
// If the fix deletes rows but never reloads, the tile still reads 2 and the
// user sees the same bug with cards now missing underneath it.
{
  start('QTY-TC5');
  const block = /const memberIds = [\s\S]*?\n      return;\n    \}/.exec(modal)[0];
  assert.match(block, /onUpdate && onUpdate\(\)/,
    'the collection must be reloaded after the delete, or the tile keeps '
    + 'showing the old number over rows that no longer exist');
  assert.ok(!/showToast\(t\('inspector\.cardUpdated'\)\);\s*\}\s*else/.test(block.replace(/\n/g, ''))
    || /res\.ok/.test(block),
    'success must be reported only on res.ok');
  pass('QTY-TC5', 'the view reloads after the change');
}

console.log(`\nstackedQuantity.test.js: ${passed} cases passed`);
