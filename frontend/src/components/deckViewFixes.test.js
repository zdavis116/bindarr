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

// ---------------------------------------------------------------------------
// DV-TC6: "USE MY PRINTINGS" MUST PREVIEW TOO.
//
// Zach: "This still doesnt let me view the printing switch 1st." -- after the
// single-printing confirm shipped.
//
// I fixed the per-row tap in the card sheet and left the BULK banner posting
// an empty body, which repoints every unambiguous card at once with no preview
// and no undo. That is the same mistake he reported, multiplied: one press
// moves N cards. I had even asked whether this button needed covering, got no
// answer, and shipped without it.
//
// The guard is on the BUTTON: it may open the preview, never write.
// ---------------------------------------------------------------------------
{
  const banner = deckView.slice(
    deckView.indexOf('SHOW WHAT IT WILL DO'),
    deckView.indexOf("{t('deck.repointDismiss')}"));
  assert.match(banner, /setRepointPreview\(/,
    'DV-TC6 the bulk button must open a preview');
  assert.doesNotMatch(banner, /fetch\(/,
    'DV-TC6 the bulk button must not POST directly');
  assert.doesNotMatch(banner, /method:\s*'POST'/,
    'DV-TC6 the bulk button must not write');

  // The preview must show each card and BOTH printings -- a count alone
  // ("switch 3 cards?") would not have told him a precon card was involved.
  const dlg = deckView.slice(
    deckView.indexOf('THE PREVIEW, before any card moves'),
    deckView.indexOf('{/* COMMANDER SWAP */}'));
  assert.match(dlg, /rp-name/, 'DV-TC6 the preview must name each card');
  assert.match(dlg, /confirmFrom/, 'DV-TC6 the preview must show the current printing');
  assert.match(dlg, /confirmTo/, 'DV-TC6 the preview must show the target printing');
  assert.match(dlg, /wants\?\.set_id/, 'DV-TC6 the preview must show set codes');
  assert.match(dlg, /wants\?\.number/, 'DV-TC6 the preview must show collector numbers');
  assert.match(dlg, /confirmInUse/,
    'DV-TC6 the preview must warn when copies are already in another deck');
  // Only the preview's own button may commit.
  assert.match(dlg, /onClick=\{applyRepointAll\}/,
    'DV-TC6 only the preview may apply the switch');
}

// ---------------------------------------------------------------------------
// DV-TC7: THE PREVIEW MUST READ THE FIELD THE SERVER ACTUALLY SENDS.
//
// deckRepoint.js builds alternatives with `quantity_owned`; the card sheet's
// printings list uses `owned_qty`. They are different shapes from different
// endpoints. Reading the wrong one here fails SILENTLY -- no warning renders,
// which looks exactly like "no copies are committed elsewhere". That is the
// one thing this dialog must never say wrongly, because it is the fact that
// would have saved his precon.
// ---------------------------------------------------------------------------
{
  const dlg = deckView.slice(
    deckView.indexOf('THE PREVIEW, before any card moves'),
    deckView.indexOf('{/* COMMANDER SWAP */}'));
  assert.match(dlg, /quantity_owned/,
    'DV-TC7 the preview must read quantity_owned');
  assert.doesNotMatch(dlg, /to\?\.owned_qty/,
    'DV-TC7 owned_qty is the other endpoint\'s field and is always undefined here');

  // And the producer must still emit it, or this guard is asserting a fact
  // that stopped being true.
  const repointSrc = fs.readFileSync(
    path.join(repo, 'backend/src/utils/deckRepoint.js'), 'utf8');
  const alt = repointSrc.slice(repointSrc.indexOf('alternatives.push({'));
  assert.match(alt.slice(0, 600), /quantity_owned:/,
    'DV-TC7 deckRepoint must still send quantity_owned');
  assert.match(alt.slice(0, 600), /quantity_available:/,
    'DV-TC7 deckRepoint must still send quantity_available');
}

console.log('PASS: DV-TC1 the pane measures a viewport offset, clamped');
console.log('PASS: DV-TC2 no pane-top rule can resolve to zero height');
console.log('PASS: DV-TC3 a printing switch is confirmed and names both printings');
console.log('PASS: DV-TC4 the confirm exists in both the inline pane and the modal');
console.log('PASS: DV-TC5 a Moxfield rename updates the Bindarr deck name');
console.log('PASS: DV-TC6 Use my printings previews before it switches anything');
console.log('PASS: DV-TC7 the preview reads quantity_owned, the field actually sent');
