// WHICH ACTIONS LIVE ON WHICH TAB, AND WHAT DELETE MEANS.
//
// Zach, going tab by tab on the deployed build:
//
//   Card  -- "there should be no edit card button in that tab when viewing it
//             from the collection. I don't think I like the delete there or
//             favorite either and is for both the collection and deck view"
//   Yours -- "This is where edit card should be and only be here when coming
//             from the collection and this is where favorite and delete should
//             live as well. The delete when coming from deck view should
//             delete the card from the deck not the collection otherwise seems
//             weird."
//   Decks -- "edit card shouldn't exist here at all. Just an add to deck
//             button styled just like the edit. There should be no delete or
//             favorite here as well. Maybe a delete in each row for the decks
//             it shows in."
//
// THE DANGEROUS ONE IS DELETE. handleDelete targets `entry_id || id`, and from
// a deck that id is a deck_cards row -- so showing it there would DELETE A
// COLLECTION ROW WHOSE ID HAPPENED TO MATCH. Silent destruction of a different
// card than the one on screen, which is the exact failure this app exists to
// avoid: a wrong record costs a recount against cardboard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'CardInspectorModal.jsx'), 'utf8');
const deckView = readFileSync(join(here, 'DeckView.jsx'), 'utf8');

// Bound a tab panel by brace matching, so "which tab is this in" is answered
// structurally rather than by proximity in the file.
function panel(tabName) {
  const start = src.indexOf(`{tab === '${tabName}' &&`);
  assert.ok(start > 0, `the ${tabName} tab must exist`);
  let depth = 0;
  for (let k = start; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, k);
    }
  }
  throw new Error(`could not bound the ${tabName} tab`);
}

const cardTab = panel('card');
const yoursTab = panel('yours');
const decksTab = panel('decks');

test('CIA-TC1: the Card tab carries no card actions', () => {
  // It answers "what is this thing". Editing, favouriting and deleting all act
  // on a collection ROW, which the Card tab says nothing about.
  assert.doesNotMatch(cardTab, /inspector\.editCard/,
    'no edit button on the Card tab');
  assert.doesNotMatch(cardTab, /handleDelete/,
    'no delete on the Card tab');
  assert.doesNotMatch(cardTab, /inspector\.favorite/,
    'no favourite on the Card tab');
});

test('CIA-TC2: edit, favourite and delete live on Yours', () => {
  assert.match(yoursTab, /inspector\.editCard/, 'edit belongs with ownership');
  assert.match(yoursTab, /handleDelete/, 'delete belongs with ownership');
  assert.match(yoursTab, /handleQuickToggle\('favorite'/,
    'favourite belongs with ownership');
});

test('CIA-TC3: those actions require an owned entry and a writable sheet', () => {
  // Zach: edit should "only be here when coming from the collection". A deck
  // requirement is not a collection row -- there is nothing to edit, favourite
  // or destroy.
  assert.match(yoursTab, /\{ownedEntry && !readOnly && \(/,
    'the collection actions must be gated on owning a copy AND on the sheet '
    + 'being writable');
});

test('CIA-TC4: the Decks tab has add-to-deck and nothing destructive', () => {
  assert.match(decksTab, /<AddToDeckSelect/, 'add to deck lives here');
  assert.doesNotMatch(decksTab, /inspector\.editCard/,
    'no edit on the Decks tab');
  assert.doesNotMatch(decksTab, /handleDelete\b/,
    'no COLLECTION delete on the Decks tab');
  assert.doesNotMatch(decksTab, /handleQuickToggle\('favorite'/,
    'no favourite on the Decks tab');
});

test('CIA-TC5: deck removal never calls the collection delete', () => {
  // The whole point. These must be different functions targeting different
  // endpoints, or a deck delete destroys a physical record.
  assert.match(src, /const handleRemoveFromDeck = async \(\) => \{/,
    'removing from a deck is its own action');
  assert.match(src, /if \(!onRemoveFromDeck\) return;/,
    'it does nothing unless the caller supplied a deck-aware handler');

  const fn = src.slice(src.indexOf('const handleRemoveFromDeck'),
                       src.indexOf('const handleDelete'));
  assert.doesNotMatch(fn, /api\/collection/,
    'a deck removal must never touch the collection endpoint');
  assert.doesNotMatch(fn, /targetEntryId/,
    'targetEntryId is a COLLECTION row id; from a deck it would delete a '
    + 'different card that happens to share the number');
});

test('CIA-TC6: the deck view supplies the deck-aware removal', () => {
  assert.match(deckView, /onRemoveFromDeck=\{removeCard\}/,
    'the deck view owns the deck context and passes its own remover');
  assert.match(deckView, /deckName=\{deck\?\.name/,
    'the confirmation names the deck the card leaves');
});

test('CIA-TC7: the row delete only appears for the deck you opened', () => {
  // The tab lists several decks. A remove button on a deck the caller has no
  // context for would either do nothing or act on the wrong one.
  assert.match(decksTab, /onRemoveFromDeck && deckName === d\.deck_name/,
    'the per-row delete is scoped to the originating deck');
});

test('CIA-TC8: the duplicated printing header is gone', () => {
  // Zach: "has printing line doesn't need to be there exist up above just
  // duplicate data." The header already shows set and number under the name.
  assert.doesNotMatch(src, /inspector\.thisPrinting/,
    'the Yours tab must not repeat the printing shown in the header');
});

test('CIA-TC9: the type line sits under the name, not in the Card tab', () => {
  // Zach: "we need to move the type line to below name of card."
  assert.doesNotMatch(cardTab, /\{faceTypeLine\}/,
    'the type line must not open the Card tab -- that puts the tab bar '
    + "between a card's name and its type");
  assert.match(src, /\{faceTypeLine\}/, 'it must still render somewhere');

  const nameAt = src.indexOf('{faceIndex === 1 && view.back_name');
  const typeAt = src.indexOf('{faceTypeLine}');
  assert.ok(typeAt > nameAt && typeAt - nameAt < 1200,
    'the type line must follow the card name closely');
});

// --- CIA-TC10: ACTIONS CLOSE THE YOURS TAB --------------------------------
//
// Zach: "why is the button now inbetween the 2 grids instead of at the bottom
// of the yours tab"
//
// I inserted them before the other-printings block because it was a convenient
// anchor, not because it was the right place. Actions belong after the
// information they act on.

test('CIA-TC10: the collection actions come last on Yours', () => {
  const copies = yoursTab.indexOf("inspector.copies");
  const printings = yoursTab.indexOf('inspector.otherPrintings');
  const edit = yoursTab.indexOf('inspector.editCard');

  assert.ok(copies > 0 && printings > 0 && edit > 0,
    'all three blocks must be on the Yours tab');
  assert.ok(edit > printings,
    'the action buttons must come AFTER other printings, not between the two '
    + 'grids');
});

// --- CIA-TC11: ADD TO DECK MATCHES THE EDIT BUTTON ------------------------
//
// Zach, twice: "why does the add to deck not look like the edit button please
// make it the same as the edit button"
//
// The first attempt added a .ci-add-deck stylesheet rule and left the inline
// style prop in place -- maxWidth 140px, small font. Inline beats stylesheet,
// so the rule never applied and the control stayed a small dropdown beside a
// full-width button. The values live on the element now, in one place.

test('CIA-TC11: add-to-deck is styled as the primary action', () => {
  const i = src.indexOf('<AddToDeckSelect');
  assert.ok(i > 0, 'the control must exist');
  const el = src.slice(i, i + 800);

  assert.match(el, /className="btn btn-primary"/,
    'it must carry the same class as the Edit button');
  assert.match(el, /width: '100%'/, 'full width, like Edit');
  assert.match(el, /minHeight: 42/, 'same height as Edit');
  assert.doesNotMatch(el, /maxWidth: '140px'/,
    'a 140px cap is what made it look like a dropdown rather than a button');
});

test('CIA-TC12: nothing else styles add-to-deck', () => {
  // A stylesheet rule AND an inline style is two places to disagree, and the
  // inline one silently wins -- which is exactly how the first fix failed.
  const css = readFileSync(join(here, '../index.css'), 'utf8');
  assert.doesNotMatch(css, /\.ci-add-deck select/,
    'the styling belongs in one place, on the element');
});

// --- CIA-TC13: THE PANEL DOES NOT RESIZE BETWEEN TABS ---------------------
//
// Zach: "the modal should stay the same size when changing between tabs it's
// growing when moving to yours"
//
// With max-height alone the panel sized to whatever the current tab held --
// short on Card, taller on Yours. A height makes it the same box on every tab
// and lets .ci-scroll absorb the difference, which is its whole purpose. Same
// distinction as the card art: a cap leaves the size to the content.

test('CIA-TC13: the panel has a height, not only a ceiling', () => {
  const css = readFileSync(join(here, '../index.css'), 'utf8');
  const i = css.indexOf('.card-inspector {');
  const rule = css.slice(i, css.indexOf('}', i)).replace(/\/\*[\s\S]*?\*\//g, '');

  assert.match(rule, /(^|;|\{)\s*height:\s*\d+vh/m,
    'without a height the panel resizes to each tab');
  assert.match(rule, /(^|;|\{)\s*height:\s*\d+dvh/m,
    'and the dynamic-viewport variant, or iOS toolbars change the size');

  // The mobile override too -- it carries !important and would win.
  const j = css.indexOf('.card-inspector {', i + 10);
  const mob = css.slice(j, css.indexOf('}', j));
  assert.match(mob, /(^|;|\{)\s*height:\s*\d+vh\s*!important/m,
    'the mobile rule wins on the phone, so it must set a height as well');
});
