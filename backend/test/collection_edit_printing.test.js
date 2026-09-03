const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// EDITING WHICH PRINTING A COLLECTION ROW IS.
//
// Zach: "I need to edit a card's set that is in my collection but there is no
// way to do that."
//
// The row's card_id IS the printing, and the edit route never accepted it. That
// bites hardest right after a ManaBox import: a row matched to the wrong
// printing was stuck, and the only way out was delete and re-add -- losing
// condition, location, purchase price and notes.

const route = fs.readFileSync(
  path.join(__dirname, '../src/routes/collection.js'), 'utf8');
const modal = fs.readFileSync(
  path.join(__dirname, '../../frontend/src/components/CardInspectorModal.jsx'), 'utf8');

// The PUT route only, so an assertion cannot accidentally match another route.
const putRoute = route.slice(
  route.indexOf("router.put('/collection/:id'"),
  route.indexOf("router.", route.indexOf("router.put('/collection/:id'") + 10));

test('EDIT-TC1: the edit route accepts a printing change', () => {
  assert.match(putRoute, /card_id\s*\n\s*\} = req\.body;/,
    'card_id must be read from the body');
  assert.match(putRoute, /updates\.push\('card_id = \?'\); params\.push\(finalCardId\);/,
    'and actually written');
});

test('EDIT-TC2: omitting card_id leaves the printing alone', () => {
  // Every existing caller omits it. Treating undefined as a change would
  // rewrite card_id to null on every quantity edit -- destroying the printing
  // of every card he touches.
  assert.match(putRoute, /if \(card_id !== undefined && card_id !== null && card_id !== entry\.card_id\)/,
    'undefined must mean "leave it alone"');
  assert.match(putRoute, /let finalCardId = entry\.card_id;/,
    'and the default is what the row already is');
  assert.match(putRoute, /if \(finalCardId !== entry\.card_id\) \{/,
    'so an unchanged printing writes nothing');
});

test('EDIT-TC3: only another printing of the SAME card is allowed', () => {
  // This fixes "I recorded the wrong set", not "this is a different card". A
  // free-form card_id would turn an edit into a silent swap of one card for
  // another, with the quantity, price and location following it.
  assert.match(putRoute, /target\.oracle_id !== current\.oracle_id/,
    'the oracle id must match');
  assert.match(putRoute, /'DIFFERENT_CARD'/,
    'and a mismatch is refused');
});

test('EDIT-TC4: an unknown printing is refused', () => {
  // The client can post any id at all.
  assert.match(putRoute, /SELECT id, oracle_id FROM card_cache WHERE id = \?/,
    'the target must exist in the catalogue');
  assert.match(putRoute, /'UNKNOWN_PRINTING'/);
});

test('EDIT-TC5: a checked-out copy cannot change printing', () => {
  // A copy allocated to a checked-out deck is physically sleeved. If the row
  // becomes a different printing, the allocation describes a card the deck
  // never asked for -- discoverable only by counting cardboard.
  assert.match(putRoute, /FROM deck_card_allocations WHERE collection_entry_id = \?/,
    'the allocation check must use the real column name');
  assert.doesNotMatch(putRoute, /deck_card_allocations WHERE collection_id = \?/,
    'collection_id does not exist -- that spelling 500s the whole edit');
  assert.match(putRoute, /'ALLOCATED'/);
});

test('EDIT-TC6: the picker is reachable in the edit form', () => {
  // State and a save that nothing can trigger is this project's most repeated
  // failure. The control has to be rendered where he edits.
  assert.match(modal, /\{t\('inspector\.editPrinting'\)\}/,
    'the field must render');
  assert.match(modal, /onChange=\{\(e\) => setEditCardId\(e\.target\.value\)\}/,
    'and be wired to state');
  assert.match(modal, /\.\.\.\(editCardId && editCardId !== \(ownedEntry\?\.card_id \|\| catalogueId\)\s*\n?\s*\? \{ card_id: editCardId \} : \{\}\)/,
    'and only send card_id when he actually changed it');
});

test('EDIT-TC7: the picker resets between entries', () => {
  // Otherwise it carries the previous card's printing into the next edit --
  // and the next save would silently rewrite that card.
  assert.match(modal, /useEffect\(\(\) => \{ setEditCardId\(null\); \}, \[targetEntryId, openedWith\]\)/,
    'the choice must not leak between cards');
});

test('EDIT-TC8: a wishlist entry has no printing to fix', () => {
  // There is no physical card, so there is nothing recorded wrongly.
  assert.match(modal, /listType !== 'wishlist' && \(deckUse\?\.printings \|\| \[\]\)\.length > 1/,
    'the picker is for real collection rows with a choice to make');
});
