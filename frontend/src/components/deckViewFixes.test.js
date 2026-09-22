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
// DV-TC6: "USE MY PRINTINGS" MUST SHOW WHAT IT WILL CHANGE, MOXFIELD-STYLE.
//
// Zach first: "This still doesnt let me view the printing switch 1st." Then,
// on the modal I built for it: "Can this work just like the moxfield sync?
// Where I can just click see changes and see it that way"
//
// So the shape is the drift banner's: act / see changes / dismiss, with the
// detail expanding INLINE in the banner's own markup -- not a second dialog
// pattern for the same job.
//
// The guard is on the DETAIL: the banner must be able to show every card it
// would switch, with both printings, before anything is written.
// ---------------------------------------------------------------------------
{
  const banner = deckView.slice(
    deckView.indexOf('THE MOXFIELD SHAPE'),
    deckView.indexOf('{/* MOXFIELD HAS CHANGES'));

  // A "see changes" toggle, using the drift panel's own labels.
  assert.match(banner, /setRepointDetail\(/,
    'DV-TC6 the banner needs a see-changes toggle');
  assert.match(banner, /driftSeeChanges/,
    'DV-TC6 the toggle must reuse the Moxfield label');
  assert.match(banner, /driftHideChanges/,
    'DV-TC6 the toggle must collapse again');

  // The expanded detail, in the drift panel's markup rather than a lookalike.
  // "Like the moxfield sync" means USE ITS CLASSES: a lookalike drifts the
  // moment one of them is restyled, and then the two panels disagree.
  assert.match(banner, /mfx-group-label/,
    'DV-TC6 the detail must use the drift panel markup');
  assert.match(banner, /className="mfx-row"/,
    'DV-TC6 each row must be a drift-panel row, not a private class');
  assert.match(banner, /mfx-row-name/, 'DV-TC6 the detail must name each card');
  assert.match(banner, /mfx-row-meta/, 'DV-TC6 the detail must use the drift meta line');
  assert.match(banner, /wants\?\.set_id/,
    'DV-TC6 the detail must show the printing the deck asks for now');
  assert.match(banner, /to\?\.set_id/,
    'DV-TC6 the detail must show the printing it would switch to');
  assert.match(banner, /repointInUse/,
    'DV-TC6 the detail must warn when copies are already in another deck');

  // THE META LINE MUST FIT. .mfx-row-meta is `white-space: nowrap` with no
  // shrink, sized for the drift panel's short "AKH #123 · main". Appending the
  // full set name overflowed the row at 390px: the name clipped at the screen
  // edge and the card name wrapped mid-word. Set code + number is the
  // identifier he matches against the card in hand; the long name was the
  // redundant half. Measured on dev at 390x844.
  const meta = banner.slice(banner.indexOf('className="mfx-row-meta"'),
    banner.indexOf('</span>', banner.indexOf('className="mfx-row-meta"')));
  assert.doesNotMatch(meta, /set_name/,
    'DV-TC6 the nowrap meta line must not carry the full set name');

  // ONE path to the write, and it is a named function.
  assert.match(banner, /onClick=\{applyRepointAll\}/,
    'DV-TC6 the apply button must call the single named write path');
  assert.doesNotMatch(banner, /method:\s*'POST'/,
    'DV-TC6 the banner must not inline a second POST');

  // And the modal it replaced must be gone, not left behind as a dead second
  // surface. He has pushed back on redundant surfaces before.
  assert.doesNotMatch(deckView, /rp-preview/,
    'DV-TC6 the old preview modal must be removed, not left orphaned');
  assert.doesNotMatch(deckView, /repointPreview/,
    'DV-TC6 no leftover preview state');
}

// ---------------------------------------------------------------------------
// DV-TC7: THE DETAIL MUST READ THE FIELD THE SERVER ACTUALLY SENDS.
//
// deckRepoint.js builds alternatives with `quantity_owned`; the card sheet's
// printings list uses `owned_qty`. They are different shapes from different
// endpoints. Reading the wrong one here fails SILENTLY -- no warning renders,
// which looks exactly like "no copies are committed elsewhere". That is the
// one thing this panel must never say wrongly, because it is the fact that
// would have saved his precon.
// ---------------------------------------------------------------------------
{
  const banner = deckView.slice(
    deckView.indexOf('THE MOXFIELD SHAPE'),
    deckView.indexOf('{/* MOXFIELD HAS CHANGES'));
  assert.match(banner, /quantity_owned/,
    'DV-TC7 the detail must read quantity_owned');
  assert.doesNotMatch(banner, /to\?\.owned_qty/,
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
console.log('PASS: DV-TC6 Use my printings has a see-changes panel, Moxfield-style');
console.log('PASS: DV-TC7 the detail reads quantity_owned, the field actually sent');
