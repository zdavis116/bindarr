// PR 6D: the restored deck builder's presentation rules.
//
// These are BEHAVIOUR tests on real values, not snapshot or render tests. They
// assert what the user ends up SEEING -- which section a card lands in, what a
// row's badge says -- because those are the things Zach rejected the previous
// attempt over, and because they are the last place the exact-only model can
// silently go wrong without any HTTP call failing.
//
// The other half of the contract is enforced by a source scan at the bottom:
// this UI must never recompute ownership or reservation. The server owns those
// numbers, and a second implementation on the screen means the user can be
// shown a figure no database check agrees with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sectionForTypeLine,
  groupDeckCards,
  sectionCount,
  requirementStatus,
  finishLabel
} from './deckSections.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Card types come off the cached Scryfall type_line.
// ---------------------------------------------------------------------------
assert.equal(sectionForTypeLine('Creature — Human Wizard'), 'Creatures');
assert.equal(sectionForTypeLine('Legendary Creature — Elf Druid'), 'Creatures');
assert.equal(sectionForTypeLine('Instant'), 'Instant');
assert.equal(sectionForTypeLine('Sorcery — Arcane'), 'Sorcery');
assert.equal(sectionForTypeLine('Enchantment — Aura'), 'Enchantment');
assert.equal(sectionForTypeLine('Artifact — Equipment'), 'Artifact');
assert.equal(sectionForTypeLine('Legendary Planeswalker — Jace'), 'Planeswalker');
assert.equal(sectionForTypeLine('Basic Land — Swamp'), 'Lands');

// Multi-type cards go where a player would look for them, not where a naive
// first-word match would put them.
assert.equal(
  sectionForTypeLine('Artifact Creature — Golem'), 'Creatures',
  'an artifact creature is a creature you attack with, so it belongs with creatures'
);
assert.equal(
  sectionForTypeLine('Artifact Land'), 'Lands',
  'an artifact land is part of the mana base and belongs with lands'
);
assert.equal(
  sectionForTypeLine('Enchantment Creature — Nymph'), 'Creatures',
  'an enchantment creature is still a creature'
);

// An unknown or missing type must never make a card disappear from the list.
// A user counting to 100 and finding 99 has no way to discover what went wrong.
assert.equal(sectionForTypeLine(''), 'Other');
assert.equal(sectionForTypeLine(undefined), 'Other');
assert.equal(sectionForTypeLine('Vanguard'), 'Other');

// ---------------------------------------------------------------------------
// Sectioning: Commander first, then card types in display order, Considering
// last -- all inside ONE list.
// ---------------------------------------------------------------------------
const deck = [
  { id: 1, board: 'commander', quantity: 1, type_line: 'Legendary Creature — Elf Druid', name: 'Cmdr', reserves: true, quantity_missing: 0, quantity_reserved: 1, quantity_required: 1 },
  { id: 2, board: 'mainboard', quantity: 4, type_line: 'Creature — Human Soldier', name: 'Soldier' },
  { id: 3, board: 'mainboard', quantity: 2, type_line: 'Instant', name: 'Bolt' },
  { id: 4, board: 'mainboard', quantity: 24, type_line: 'Basic Land — Forest', name: 'Forest' },
  { id: 5, board: 'mainboard', quantity: 1, type_line: 'Artifact', name: 'Sol Ring' },
  { id: 6, board: 'considering', quantity: 1, type_line: 'Creature — Dragon', name: 'Maybe Dragon' },
  { id: 7, board: 'sideboard', quantity: 3, type_line: 'Sorcery', name: 'Sweeper' }
];

const sections = groupDeckCards(deck);
assert.deepEqual(
  sections.map(s => s.title),
  ['Commander', 'Creatures', 'Sorcery', 'Instant', 'Artifact', 'Lands', 'Considering'],
  'sections appear in display order, with Commander first and Considering last'
);

assert.equal(sections[0].kind, 'commander');
assert.equal(sections[sections.length - 1].kind, 'considering');

// A commander is filed by its BOARD, not by its type. It is an Elf Druid, but
// it must not appear under Creatures -- it is the deck-defining slot.
const creatures = sections.find(s => s.title === 'Creatures');
assert.deepEqual(
  creatures.cards.map(c => c.id), [2],
  'the commander is not double-counted into the creature section'
);

// A considering card is likewise never mixed into a type section, even though
// it has a perfectly good type line.
assert.ok(
  !creatures.cards.some(c => c.board === 'considering'),
  'a considering card never appears in a card-type section'
);

// Header counts are COPIES, not rows.
assert.equal(sectionCount(creatures.cards), 4, 'four copies on one row counts as four cards');
assert.equal(sectionCount(sections.find(s => s.title === 'Lands').cards), 24);
assert.equal(sectionCount(sections.find(s => s.title === 'Commander').cards), 1);

// Empty sections are omitted rather than shown as "(0)".
assert.ok(
  !sections.some(s => s.title === 'Planeswalker'),
  'a section with no cards is not rendered at all'
);

// An empty deck produces no sections at all, not a stack of empty headers.
assert.deepEqual(groupDeckCards([]), []);
assert.deepEqual(groupDeckCards(undefined), []);

// A deck with no commander simply has no Commander section -- it is not
// synthesised, and nothing gets promoted into it.
const noCommander = groupDeckCards([
  { id: 1, board: 'mainboard', quantity: 1, type_line: 'Instant', name: 'Bolt' }
]);
assert.deepEqual(noCommander.map(s => s.title), ['Instant']);

// ---------------------------------------------------------------------------
// Row status badges. Every number here is the SERVER's; this only picks a label.
// ---------------------------------------------------------------------------

// A fully reserved real entry.
assert.deepEqual(
  requirementStatus({ reserves: true, quantity_missing: 0, quantity_reserved: 4, quantity_required: 4 }),
  { tone: 'ok', label: 'Reserved 4 of 4' }
);

// MISSING IS RED, NOT AMBER (Zach, 2026-08-18): "missing should show red not
// yellow."
//
// A missing card means he cannot build the deck AS IT STANDS -- that is a
// problem, not a caution. Amber reads as a warning about something optional.
// Red is already the app's colour for unavailable (the considering-availability
// rule from PR 6C), so this REUSES that existing tone rather than introducing a
// new colour or badge style.
assert.deepEqual(
  requirementStatus({ reserves: true, quantity_missing: 3, quantity_reserved: 1, quantity_required: 4 }),
  { tone: 'unavailable', label: 'Missing 3 of 4' }
);

// A partial shortfall and a total one are the SAME problem and must read the
// same way -- the user cannot build the deck either way.
assert.deepEqual(
  requirementStatus({ reserves: true, quantity_missing: 4, quantity_reserved: 0, quantity_required: 4 }),
  { tone: 'unavailable', label: 'Missing 4 of 4' }
);

// The fully-reserved case is untouched: nothing is missing, so nothing is red.
assert.equal(
  requirementStatus({ reserves: true, quantity_missing: 0, quantity_reserved: 2, quantity_required: 2 }).tone,
  'ok',
  'a fully reserved row must stay green'
);

// A CONSIDERING entry with a copy free. It reserves nothing, so it reports
// availability rather than a shortfall -- "missing" is meaningless for a card
// that is not in the deck.
assert.deepEqual(
  requirementStatus({ reserves: false, available: true, quantity_available: 2 }),
  { tone: 'ok', label: 'Available 2' }
);

// A CONSIDERING entry whose last copy another deck has taken. Red, because it
// answers a yes/no question ("can I actually put this in?"). Crucially this is
// a LABEL change only -- nothing here removes, edits or hides the entry.
assert.deepEqual(
  requirementStatus({ reserves: false, available: false, quantity_available: 0 }),
  { tone: 'unavailable', label: 'Unavailable' }
);

// Live availability: the SAME considering entry, read twice, reports differently
// when the world changes underneath it. Availability is derived by the server on
// every read and is never stored on the row, so this is the shape the UI must
// handle -- and it must handle it without mutating the entry.
const consideringEntry = { id: 42, board: 'considering', quantity: 1, name: 'Ponder', type_line: 'Sorcery' };
const before = requirementStatus({ ...consideringEntry, reserves: false, available: true, quantity_available: 1 });
const after = requirementStatus({ ...consideringEntry, reserves: false, available: false, quantity_available: 0 });
assert.equal(before.tone, 'ok');
assert.equal(after.tone, 'unavailable');
assert.deepEqual(
  consideringEntry,
  { id: 42, board: 'considering', quantity: 1, name: 'Ponder', type_line: 'Sorcery' },
  'reading a status must not mutate the entry it describes'
);

// The considering entry still renders in its own section either way. Losing the
// last free copy must never make the card vanish from the maybeboard.
for (const available of [true, false]) {
  const grouped = groupDeckCards([{ ...consideringEntry, reserves: false, available, quantity_available: available ? 1 : 0 }]);
  assert.deepEqual(grouped.map(s => s.title), ['Considering']);
  assert.equal(grouped[0].cards.length, 1, 'an unavailable considering card is still listed');
}

// An old payload with no availability field stays quiet rather than guessing.
assert.deepEqual(
  requirementStatus({ reserves: false }),
  { tone: 'muted', label: 'Not reserved' }
);

assert.equal(finishLabel('nonfoil'), 'Nonfoil');
assert.equal(finishLabel('etched'), 'Etched');

// ---------------------------------------------------------------------------
// Source contract: exact identity on every write, and no client-side recompute.
// ---------------------------------------------------------------------------
// The deck WRITE path lives in DeckView.jsx since the detail-view rebuild.
// This assertion still read DeckBuilder.jsx and had been failing silently --
// as a bare top-level assert it took the whole file down without naming
// itself, which is why it went unnoticed.
const view = fs.readFileSync(path.join(here, 'DeckView.jsx'), 'utf8');
// Still read by the assertions below, which check what DeckBuilder must NOT do.
const builder = fs.readFileSync(path.join(here, 'DeckBuilder.jsx'), 'utf8');

test('DS-TC24: every write names BOTH halves of the exact identity', () => {
  // desired_card_id AND desired_finish. Sending only the id lets the server
  // pick a finish, which is how a foil silently becomes a nonfoil -- a wrong
  // record about physical cardboard, and the failure this app exists to avoid.
  // Only the WRITE bodies -- `desired_card_id:` with a colon, which is an
  // object property being SENT. `entry.desired_card_id` is a read.
  const writes = [...view.matchAll(/desired_card_id:/g)];
  assert.ok(writes.length > 0, 'the write path must name the card id');
  for (const m of writes) {
    const body = view.slice(m.index, m.index + 260);
    assert.match(body, /desired_finish/,
      'a write sent desired_card_id without desired_finish -- the server would '
      + 'pick a finish, silently turning a foil into a nonfoil');
  }
});

// The pre-6C shape must be gone entirely. `card_id:` in a deck write is the bug
// this whole model exists to prevent -- it names a card without naming which
// physical printing and finish.
assert.ok(
  !/body: JSON\.stringify\(\{\s*card_id:/.test(builder),
  'no deck write may send a bare card_id'
);

// No deck-level considering state anywhere in the UI. Considering is a property
// of a CARD; a deck is never in that state.
assert.ok(
  !/status:\s*['"]considering['"]/.test(builder),
  'the UI must never set a deck-level considering status'
);
assert.ok(
  !/deck\.status\b(?!Ready|Building)/.test(builder.replace(/deck\.status(Ready|Building)/g, '')),
  'the UI must not read a deck status field that no longer exists'
);

// The UI must not re-derive what the server already computed. Each of these
// would be a second implementation of a business rule, and the copy the user
// believes is the one on their screen.
for (const pattern of [/quantity_owned\s*-/, /owned_qty\s*-\s*/, /quantity_required\s*-\s*quantity/]) {
  assert.ok(
    !pattern.test(builder),
    `DeckBuilder must not recompute server-owned quantities (matched ${pattern})`
  );
}

// EVERY EDIT OF AN EXISTING ENTRY NAMES THE ROW IT IS EDITING.
//
// The three in-place rewrite paths -- re-pin a printing, swap a commander, move
// between boards -- all used to be an add followed by a separate DELETE. Two
// requests have a window between them in which the deck holds the card twice,
// and the server's own singleton rule calls that state illegal; if the delete
// never lands (dropped connection, restart) the deck holds it permanently.
//
// It also made re-pinning impossible in a Commander deck: the add half looked
// exactly like a request for a second copy by name, because nothing in it said
// "this is an edit". Singleton has no override by design, so the refusal was a
// dead end on a feature that is supposed to work.
//
// Both are fixed by naming the row: the server excludes exactly that row from
// the singleton count and does the replace in ONE transaction.
test('DS-TC25: deck edits are one atomic replace, never delete-then-add', () => {
  // The writes live in DeckView.jsx since the rebuild. Checked by behaviour
  // rather than by function name, so the guard survives the next rename.
  //
  // A delete followed by an add loses the card outright if the second call
  // fails -- and in a Commander deck the add half looks like a request for a
  // second copy by name, which singleton refuses, so re-pinning a printing
  // becomes impossible.
  // A DELETE is fine on its own: removeCard drops a requirement, confirmDelete
  // drops the deck. What must not happen is a DELETE followed by a POST for
  // the SAME card -- that loses the card outright if the second call fails,
  // and in a Commander deck the add half reads as a request for a second copy
  // by name, which singleton refuses.
  for (const m of [...view.matchAll(/method:\s*'DELETE'/g)]) {
    const after = view.slice(m.index, m.index + 700);
    assert.doesNotMatch(after, /method:\s*'POST'[\s\S]{0,200}desired_card_id/,
      'a DELETE is followed by a POST for the same card -- the replace must be '
      + 'one atomic server-side operation');
  }
});

test('DS-TC26: every deck capability is still reachable somewhere', () => {
  // The regression this guards: a previous attempt replaced the deck screens
  // with a minimal panel and the features silently vanished.
  //
  // Asserted as CAPABILITIES rather than literal strings, because this branch
  // rebuilt the UI and renamed all of them -- a string check would break on
  // every rename until someone deleted it, taking the real guard with it.
  const ui = ['DeckBuilder.jsx', 'DeckView.jsx', 'DeckList.jsx',
              'NewDeckModal.jsx', 'ExportModal.jsx']
    .map(f => {
      try { return fs.readFileSync(path.join(here, f), 'utf8'); }
      catch { return ''; }
    })
    .join('\n');

  const capabilities = {
    'list your decks':     /DeckList/,
    'create a deck':       /NewDeckModal/,
    'see rule problems':   /warnings/,
    'add cards to a deck': /addCard|deck\.addCards/,
    'export a decklist':   /ExportModal/,
    'delete a deck':       /deleteDeck|confirmDelete/,
    'import a decklist':   /postImport|importOptional/,
  };

  for (const [what, pattern] of Object.entries(capabilities)) {
    assert.match(ui, pattern, `the deck UI must still let the user ${what}`);
  }
});

// A printing choice covers the WHOLE line, because the server only asks about
// a line the user owns nothing free of. The client used to split a partially
// owned import line into an owned-remainder line plus a chosen-printing line;
// a partial line no longer reaches the picker at all, so that split is dead
// code and its return would silently re-pin copies the server had already
// decided. Anchored to the split's own shape -- `Math.min(chosen.quantity,`
// and a bare re-pushed remainder line -- rather than to variable names, which
// are used innocently elsewhere on this screen.
assert.ok(
  !/Math\.min\(\s*chosen\.quantity/.test(builder),
  'the client must not carve a chosen printing down to a line shortfall'
);
assert.ok(
  !/chosen\.quantity/.test(builder),
  'a stored printing choice carries no per-line quantity any more'
);

// ---------------------------------------------------------------------------
// PR 6F source contracts.
// ---------------------------------------------------------------------------

// The deck grid and the Collection grid must render through the SAME tile.
// Two implementations of one card is the drift PR 6F removed: the deck grid
// had grown its own yellow x1 pill and green Reserved bar while the Collection
// grid showed a rarity chip, a quantity badge and a FOIL badge.
const collection = fs.readFileSync(path.join(here, 'CollectionList.jsx'), 'utf8');

test('DS-TC27: the Collection grid renders through the shared CardTile', () => {
  // PR 6F removed two implementations of one card: the deck grid had grown its
  // own yellow x1 pill and green Reserved bar while the Collection grid showed
  // a rarity chip, a quantity badge and a FOIL badge.
  //
  // The DECK side is no longer a grid -- DeckView renders a type-sectioned
  // LIST, which is the approved mockup (sketches/009-deck-view). Requiring a
  // CardTile import there would assert a design that was deliberately
  // replaced. The Collection grid still is a grid, and still must not fork.
  assert.match(collection, /from '\.\/CardTile'/,
    'CollectionList.jsx must render cards through the shared CardTile');
});


test('DS-TC21: DeckView does not use its display order as type priority', () => {
  // The exact shape of the bug: one array serving as both "how the sections
  // read down the page" and "which type wins". They are not the same list --
  // display puts Artifact before Land, priority must not.
  const view = fs.readFileSync(path.join(here, 'DeckView.jsx'), 'utf8');

  assert.match(view, /const TYPE_PRIORITY = \['Land'/,
    'type priority must be its own list, starting with Land');
  assert.doesNotMatch(view, /for \(const ty of TYPE_ORDER\) \{[\s\S]{0,120}return ty;/,
    'sectionFor must not walk the DISPLAY order to pick a type');
});

test('DS-TC22: an artifact creature is still a creature', () => {
  // The other multi-type case, and the reason priority is not simply
  // "everything before Artifact". A creature you cast and attack with belongs
  // in the creature count.
  assert.equal(sectionForTypeLine('Artifact Creature — Golem'), 'Creatures');
  assert.equal(sectionForTypeLine('Legendary Artifact Creature — Human'), 'Creatures');
});

test('DS-TC23: a creature land counts as a land', () => {
  // Dryad Arbor and the manlands. Same rule, different pair: it taps for mana
  // and belongs in the mana base.
  assert.equal(sectionForTypeLine('Land Creature — Forest Dryad'), 'Lands');
});
