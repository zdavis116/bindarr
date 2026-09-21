// THREE DECK-VIEW BUGS Zach reported on 2026-09-21.
//
// Each guard here is written against the RULE, not the rendered symptom: a
// screenshot showing a pane is not proof the cause changed, and this project
// has had the same bug reported three times because of exactly that.
//
// Run: node frontend/src/components/deckViewFixes.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');

const deckView = fs.readFileSync(path.join(here, 'DeckView.jsx'), 'utf8');
const collection = fs.readFileSync(path.join(here, 'CollectionList.jsx'), 'utf8');
const inspector = fs.readFileSync(path.join(here, 'CardInspectorModal.jsx'), 'utf8');
const css = fs.readFileSync(path.join(repo, 'frontend/src/index.css'), 'utf8');
const sync = fs.readFileSync(
  path.join(repo, 'backend/src/utils/moxfieldSync.js'), 'utf8');

// ---------------------------------------------------------------------------
// DV-TC1: THE DETAIL PANE MUST NOT MEASURE A PAGE OFFSET.
//
// Zach: "if I click a card and scroll to the bottom and then click a land card
// the whole side panel or card modal disappears."
//
// --pane-top is subtracted from 100vh, a VIEWPORT height. Measuring it as
// `rect.top + window.scrollY` mixes coordinate systems: scrolled to the bottom
// of a 100-card deck it read 6152px, so calc(100vh - 6152px - 1rem) clamped to
// zero and the pane rendered 472px wide by 0px tall. Present in the DOM,
// invisible on screen. MEASURED on dev at 1855x731.
// ---------------------------------------------------------------------------
for (const [name, src] of [['DeckView', deckView], ['CollectionList', collection]]) {
  const fn = src.slice(src.indexOf('const measure = () => {'));
  const body = fn.slice(0, fn.indexOf('};'));
  assert.doesNotMatch(body, /getBoundingClientRect\(\)\.top\s*\+\s*window\.scrollY/,
    `DV-TC1 ${name} must not add scrollY to a viewport offset`);
  assert.match(body, /getBoundingClientRect\(\)\.top/,
    `DV-TC1 ${name} must still measure where the pane starts`);
  // And the value must be clamped, so no transient measurement can collapse it.
  assert.match(body, /Math\.min\(/,
    `DV-TC1 ${name} must clamp --pane-top`);
}

// ---------------------------------------------------------------------------
// DV-TC2: THE CSS MUST NOT BE ABLE TO PRODUCE A ZERO-HEIGHT PANE.
//
// The JS is fixed, but a layout rule that CAN evaluate to zero will find a way
// to do it again. Every pane using this calc needs a floor. Belt and braces on
// purpose: an invisible pane is indistinguishable from a broken feature.
// ---------------------------------------------------------------------------
{
  // `height:` only, not `max-height:`. A max-height cannot collapse a pane --
  // it caps it. Matching both made this test demand a floor on
  // .cardsearch-stage, which was never part of the bug: a guard that forces
  // unrelated code to change to stay green is a guard I would start ignoring.
  const calcs = [...css.matchAll(/(?<!max-)height:\s*calc\(100vh\s*-\s*var\(--pane-top[^)]*\)[^;]*;/g)];
  assert.ok(calcs.length >= 3,
    `DV-TC2 expected the pane-top height calc in at least 3 rules, found ${calcs.length}`);
  for (const m of calcs) {
    // The min-height must appear within the same rule block.
    const after = css.slice(m.index, m.index + 400);
    assert.match(after, /min-height:\s*\d/,
      'DV-TC2 every pane-top height needs a min-height floor');
  }
}

// ---------------------------------------------------------------------------
// DV-TC3: A PRINTING SWITCH MUST BE CONFIRMED, AND NAME THE PRINTING.
//
// Zach: "I just accidentally switched a card to a printing I own but its in
// use with a precon deck that I dont want to remove from that", and then: "I
// just meant letting me see what printing your switching a card too. Just like
// the sync from moxfield."
//
// A tap in the printings list used to call assignPrintingToDeck directly.
// ---------------------------------------------------------------------------
{
  // The row's own handler must open the confirm, never commit.
  const rowHandler = inspector.slice(
    inspector.indexOf('TAP ASKS FIRST'),
    inspector.indexOf('disabled={repointing === pr.id}'));
  assert.match(rowHandler, /setConfirmRepoint\(pr\)/,
    'DV-TC3 tapping a printing must open the confirm');
  assert.doesNotMatch(rowHandler, /assignPrintingToDeck\(pr\)/,
    'DV-TC3 tapping a printing must NOT commit immediately');

  // The confirm must show the card name and BOTH printings -- "are you sure?"
  // alone would not have prevented the mistake.
  const dlg = inspector.slice(inspector.indexOf('const repointConfirm'),
    inspector.indexOf('// INLINE: the same panel'));
  assert.match(dlg, /ci-confirm-card/, 'DV-TC3 the confirm must name the card');
  assert.match(dlg, /confirmFrom/, 'DV-TC3 the confirm must show the current printing');
  assert.match(dlg, /confirmTo/, 'DV-TC3 the confirm must show the target printing');
  assert.match(dlg, /set_id/, 'DV-TC3 the confirm must show set codes, not just names');
  assert.match(dlg, /number/, 'DV-TC3 the confirm must show collector numbers');
  // It must warn when the copy is already committed elsewhere -- that is the
  // fact that would have saved the precon.
  assert.match(dlg, /confirmInUse/,
    'DV-TC3 the confirm must warn when copies are already in another deck');
  // Only the confirm button may commit.
  assert.match(dlg, /onClick=\{\(\) => assignPrintingToDeck\(to\)\}/,
    'DV-TC3 only the confirm button may commit the switch');
}

// ---------------------------------------------------------------------------
// DV-TC4: THE CONFIRM MUST EXIST IN BOTH RENDER SHAPES.
//
// The inspector returns an inline pane on desktop and a modal on the phone.
// A confirm wired into only one leaves the other committing silently -- and
// the desktop pane is where the mistake actually happened. This project's most
// repeated bug is a control that renders but cannot be reached.
// ---------------------------------------------------------------------------
{
  const inlineReturn = inspector.slice(
    inspector.indexOf('if (inline) {'),
    inspector.indexOf('return (\n    <div className="modal-overlay"'));
  assert.match(inlineReturn, /\{repointConfirm\}/,
    'DV-TC4 the inline pane must render the confirm');
  const modalReturn = inspector.slice(
    inspector.indexOf('return (\n    <div className="modal-overlay"'));
  assert.match(modalReturn, /\{repointConfirm\}/,
    'DV-TC4 the modal must render the confirm');
}

// ---------------------------------------------------------------------------
// DV-TC5: A MOXFIELD RENAME MUST REACH BINDARR.
//
// Zach: "when I updated a deck name in moxfield the deckname didnt update on
// bindarr I would like the deckname to update when I do that."
//
// planSync already fetched the name into plan.deck.name and applySync then
// dropped it, writing only the two timestamps.
// ---------------------------------------------------------------------------
{
  const update = sync.slice(sync.indexOf('UPDATE decks SET moxfield_synced_at'));
  const stmt = update.slice(0, update.indexOf('WHERE id'));
  assert.match(stmt, /name\s*=\s*COALESCE\(\?,\s*name\)/,
    'DV-TC5 the sync must write the deck name');
  // COALESCE, not a bare assignment: a payload with no name must not blank the
  // title. Losing the name is worse than keeping a stale one.
  assert.doesNotMatch(stmt, /name\s*=\s*\?\s*[,\n]/,
    'DV-TC5 a missing name must never blank the deck title');
  // And the value passed must be the fetched name.
  const params = update.slice(update.indexOf('[plan.deck'), update.indexOf(');'));
  assert.match(params, /plan\.deck\.name/,
    'DV-TC5 the name written must be the one fetched from Moxfield');
}

console.log('PASS: DV-TC1 the pane measures a viewport offset, clamped');
console.log('PASS: DV-TC2 no pane-top rule can resolve to zero height');
console.log('PASS: DV-TC3 a printing switch is confirmed and names both printings');
console.log('PASS: DV-TC4 the confirm exists in both the inline pane and the modal');
console.log('PASS: DV-TC5 a Moxfield rename updates the Bindarr deck name');
