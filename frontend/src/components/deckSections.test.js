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
const builder = fs.readFileSync(path.join(here, 'DeckBuilder.jsx'), 'utf8');

// Every POST to the deck cards endpoint goes through writeRequirement, which is
// the one place that names both halves of the identity.
assert.ok(
  builder.includes('desired_card_id, desired_finish, board, quantity'),
  'the single write path sends both halves of the exact identity'
);

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
for (const fn of ['repinEntryPrinting', 'swapCommander', 'handleMoveBoard']) {
  const body = builder.slice(builder.indexOf(`const ${fn} = async`));
  const scoped = body.slice(0, body.indexOf('\n  };'));
  assert.ok(
    /replacing_deck_card_id/.test(scoped),
    `${fn} must tell the server which row it is editing`
  );
  assert.ok(
    !/method:\s*'DELETE'/.test(scoped),
    `${fn} must not follow its write with a separate DELETE -- the replace is atomic server-side`
  );
}

// The restored screens are all still present. This is the regression that
// prompted PR 6D: the previous attempt replaced them with a minimal panel.
for (const marker of [
  'deck.vaultTitle',        // Deck Vault list
  'deck.createTitle',       // Create New Deck modal
  'deck.healthTitle',       // Deck Health & Rules
  'deck.addCardsTitle',     // Add Cards to Deck
  'deck.browseCollection',  // Browse Collection
  'Draw Simulator',
  'Check Out for Play',
  'CheckoutWizardModal'
]) {
  assert.ok(builder.includes(marker), `the restored deck UI must still contain ${marker}`);
}

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
for (const [file, source] of [['DeckBuilder.jsx', builder], ['CollectionList.jsx', collection]]) {
  assert.ok(
    /from '\.\/CardTile'/.test(source),
    `${file} must render cards through the shared CardTile`
  );
}

// The deck grid's own bespoke badges must be gone, not merely unused. Leaving
// them behind is how the two implementations reappear.
assert.ok(
  !/x\{card\.quantity\}\s*\n\s*<\/span>/.test(builder),
  'the deck grid must not draw its own quantity pill'
);

// A Browse Collection row is one exact (printing, finish), so clicking + is
// already a complete instruction. The add path must short-circuit on that
// rather than opening the printing picker again.
assert.ok(
  /card\.exact\s*&&\s*card\.finish/.test(builder),
  'an exact browse row must add directly, with no intermediate picker'
);

// ...but the picker itself must SURVIVE, for the case it was built for: a
// genuinely ambiguous line with no printing the app can infer. Deleting it
// would trade one wrong behaviour for another.
assert.ok(
  /setVariantPicker\(\{/.test(builder),
  'the printing picker must still exist for genuinely ambiguous adds'
);

// Commander controls are gated on the FORMAT. The spec is explicit that other
// formats see no extra field, no extra validation and no visual change, so an
// ungated commander input would be a bug even if it worked.
assert.ok(
  /newDeckIsCommander\s*&&/.test(builder),
  'commander inputs must be gated on the Commander format'
);

// ---------------------------------------------------------------------------
// PR 6G source contracts.
// ---------------------------------------------------------------------------

// MISSING IS RED EVERYWHERE IT APPEARS, not just on the deck row badge.
//
// The import compare screen renders its OWN status pill from the same
// TONE_STYLES table, and it mapped `missing` to 'warn'. Fixing only the deck
// badge would leave the same word amber on the screen the user reads before
// committing an import -- the inconsistency Zach would then have to report a
// second time.
assert.ok(
  !/item\.status === 'missing' \? 'warn'/.test(builder),
  'the import compare screen must not render a missing line as amber'
);
assert.ok(
  /item\.status === 'missing' \? 'unavailable'/.test(builder),
  'the import compare screen must render a missing line in the existing red tone'
);

// THE DECK SEARCH SHOWS THE AVAILABLE COUNT INLINE.
//
// Zach: "that is where show available count becomes nice ... because you can
// see if you even have it". The count must come from the SERVER's
// available_qty, which is owned minus committed across ALL decks. A count
// derived on the client could only ever see the open deck, which is the
// false-availability bug this PR exists to remove.
assert.ok(
  /available_qty/.test(builder),
  'the deck search row must render the server-computed available count'
);

console.log('deckSections + DeckBuilder exact-identity self-check passed');
