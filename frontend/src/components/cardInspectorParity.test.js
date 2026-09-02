// THE IMPLEMENTATION MUST CARRY WHAT THE MOCKUP DRAWS.
//
// Zach, twice: "none of these tabs are implemented", then "once again yours
// and deck tabs dont look fully like the mock up".
//
// Both times I had checked the code and believed it matched. The gap is that I
// cannot see the rendered screen, so "looks like the mockup" was my judgement
// about source I had just written -- which is worth nothing.
//
// This compares the two files MECHANICALLY: every section header and status
// label the mockup draws must exist in the component. It cannot prove the
// layout is right, but it makes "I forgot a whole section" impossible, which
// is what actually happened twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const impl = readFileSync(join(here, 'CardInspectorModal.jsx'), 'utf8');
const en = JSON.parse(readFileSync(join(here, '../locales/en.json'), 'utf8'));
// The endpoint that feeds this sheet. TC12 asserts the server half of the
// same rule the component half enforces.
const route = readFileSync(
  join(here, '../../../backend/src/routes/collection.js'), 'utf8');

// Resolve a t() key to the English string, so the test compares what the USER
// reads rather than an identifier.
const says = (key) => en[key];

test('CIP-TC1: every section header the mockup draws exists', () => {
  // Measured against sketches/010b-card-detail-tabs: THIS PRINTING, OTHER
  // PRINTINGS, IN YOUR DECKS, AVAILABILITY. Three of these were missing when
  // Zach sent his second screenshot.
  // 'This printing' was REMOVED at Zach's request -- the header above already
  // shows the set and number, so the section hint was duplicate data. Keeping
  // it in this list would fail the behaviour he asked for.
  const required = {
    'inspector.otherPrintings': 'Other printings',
    'inspector.inYourDecks': 'In your decks',
    'inspector.availability': 'Availability',
  };
  for (const [key, text] of Object.entries(required)) {
    assert.equal(says(key), text, `${key} must read "${text}"`);
    assert.ok(impl.includes(key), `the component must render ${key}`);
  }
});

test('CIP-TC2: a deck row states whether the requirement is met', () => {
  // The mockup shows "Covered" in green for a real requirement and
  // "Considering" in muted for a shopping note. Only the second existed.
  assert.equal(says('inspector.covered'), 'Covered');
  assert.equal(says('inspector.considering'), 'Considering');
  assert.match(impl, /d\.board === 'considering'[\s\S]{0,400}inspector\.covered/,
    'the row must choose between Considering and Covered');
});

test('CIP-TC3: the other-printings list says you own none of them', () => {
  // The mockup states it rather than leaving him to infer it from an absence.
  assert.equal(says('inspector.ownNoneOfThese'), 'you own none of these');
  assert.ok(impl.includes('inspector.ownNoneOfThese'));
});

test('CIP-TC4: the decks fetch cannot cancel itself', () => {
  // Zach: "deck tab doesnt work at all just says loading".
  //
  // The effect listed deckUseLoading as a dependency AND set it, so setting
  // the flag re-ran the effect, the previous run's cleanup set cancelled =
  // true, and the arriving response was discarded by a closure that no longer
  // trusted itself. setDeckUse was never called; the spinner was permanent.
  const eff = impl.slice(impl.indexOf('const deckFetchFor'),
                         impl.indexOf('const deckFetchFor') + 1400);
  assert.ok(eff.includes('deckFetchFor'),
    'the in-flight guard must be a ref, not render state');
  assert.doesNotMatch(eff, /\}, \[[^\]]*deckUseLoading[^\]]*\]\)/,
    'deckUseLoading must NOT be a dependency of the effect that sets it');
});

test('CIP-TC5: the in-flight guard resets when the card changes', () => {
  // Otherwise the second card opened never fetches, and the bug comes back
  // wearing a different hat.
  assert.match(impl, /deckFetchFor\.current = null/,
    'the guard must clear when a different card is shown');
});

// --- CIP-TC6: THE CATALOGUE LOOKUP USES THE CATALOGUE ID -------------------
//
// Zach, with three screenshots: "THESE ARE STILL NOT RIGHT NOTHING CHANGED".
//
// The Decks tab rendered EMPTY -- not loading, empty -- and the Yours tab lost
// its other-printings block. One cause for both.
//
// Opened from the collection, the modal receives a row where:
//     id       is undefined
//     entry_id is the COLLECTION row id      (206)
//     card_id  is the card_cache id          (4cea42fd-...)
//
// I fetched /api/card/${card.id}/decks. Measured against the running server:
//     /api/card/206/decks       -> HTTP 404
//     /api/card/4cea42fd.../decks -> HTTP 200, 2 decks, 4 printings
//
// A 404 makes the fetch resolve to null, so deckUse stayed null forever. Null
// is not "loading" and not an error -- it is absent, which is why the tab
// showed nothing at all rather than a spinner or a message.
//
// The component already knew these were different: line 56 reads
// `card?.entry_id || card?.id` for exactly this reason. I ignored it.

test('CIP-TC6: the decks request uses card_id, not the collection entry id', () => {
  // Widened in CIP-TC8 to include desired_card_id for deck entries; this
  // still pins the essential part -- card_id is preferred over the entry id.
  assert.match(impl, /card\?\.card_id \|\|/,
    'the catalogue id must be preferred over the entry id');
  assert.match(impl, /\/api\/card\/\$\{catalogueId\}\/decks/,
    'the request must send the catalogue id');
  assert.doesNotMatch(impl, /\/api\/card\/\$\{card\.id\}\/decks/,
    'sending card.id returns 404 for any card opened from the collection');
});

test('CIP-TC7: ownership rows come from the server, not the caller', () => {
  // Zach: "The card detail view should be no different between collection and
  // deck view though deck view should be read only."
  //
  // An earlier version asserted the OPPOSITE -- that a deck entry shows no
  // condition and no location. That was my reasoning, not his rule. The Yours
  // tab answers "what do I own", which does not change with the screen.
  assert.equal(en['inspector.notFiled'], 'Not filed yet');
  assert.match(impl, /ownedEntry\?\.condition/,
    'condition comes from the owned entry the server resolved');
  assert.doesNotMatch(impl, /\[t\('inspector\.condition'\), card\.condition/,
    'reading condition off the caller is what made the two screens differ');
});

test('CIP-TC8: the catalogue id resolves from either shape', () => {
  assert.match(impl, /card\?\.card_id \|\| card\?\.desired_card_id \|\| card\?\.id/,
    'a deck entry carries desired_card_id; falling straight through to id '
    + 'sends a deck_cards row number to a card_cache lookup');
});

test('CIP-TC9: the two callers cannot supply different card data', () => {
  // The structural guarantee: both screens call the same endpoint and render
  // its response. The caller's object survives only for what the server cannot
  // know -- which collection entry, which deck board.
  assert.match(impl, /const view = deckUse\?\.card \? \{ \.\.\.card, \.\.\.deckUse\.card \} : card;/,
    'one merged object, server values winning');
  assert.match(impl, /const ownedEntry = deckUse\?\.owned_entries/,
    'ownership resolved by the server, once');
});

test('CIP-TC10: the card tab renders catalogue facts from the server', () => {
  const start = impl.indexOf("{tab === 'card' && (");
  assert.ok(start > 0, 'the card tab must exist');
  const end = impl.indexOf("{mode === 'edit' ? (", start);
  assert.ok(end > start, 'could not bound the card tab');
  const cardTab = impl.slice(start, end);

  // Every catalogue fact must come from the merged view, never the caller.
  // cmc: the Mana value row was removed at Zach's request.
  // type_line / oracle_text / mana_cost: now read through the per-face
  // helpers (faceTypeLine, faceRules, facePart) so the tab shows only the
  // face on screen -- but those helpers derive from `view`, which CIP-TC15
  // pins. Checking the derivation source here instead.
  assert.match(impl, /const faceTypeLine[\s\S]{0,200}view\?\.type_line/,
    'the face type line must derive from the merged view');
  assert.match(impl, /const txt = view\?\.oracle_text;/,
    'the face rules must derive from the merged view');

  // rarity and color_identity NO LONGER RENDER IN THIS TAB -- Zach had them
  // duplicated (rarity in the header, colour identity as the pips), so the
  // facts grid was removed. What still matters is that IF the tab reads them,
  // it reads them from the merged view and never from the caller.
  for (const field of ['rarity', 'color_identity']) {
    assert.doesNotMatch(cardTab, new RegExp(`\\bcard\\.${field}\\b`),
      `card.${field} is a fact about the CARD, not about the row that `
      + 'referenced it -- reading it from the caller makes the same card look '
      + 'different depending on which screen opened the sheet');
  }
});

test('CIP-TC11: server card values win over the caller object', () => {
  // The caller keeps only what the server cannot know -- which collection
  // entry this is, which deck board it sits on. Everything about the CARD
  // comes from the catalogue.
  assert.match(impl, /\{ \.\.\.card, \.\.\.deckUse\.card \}/,
    'the spread order decides which source wins; server last means server wins');
});

test('CIP-TC12: the endpoint serves the whole catalogue row', () => {
  // SCOPED to this endpoint. `SELECT *` appears three times in the file, so an
  // unscoped match stayed green when I broke the one that matters -- verified
  // by breaking it. A test that passes while the bug is present is worthless.
  const start = route.indexOf("router.get('/card/:cardId/decks'");
  assert.ok(start > 0, 'the decks endpoint must exist');
  const scope = route.slice(start, route.indexOf('res.json({', start));
  assert.match(scope, /SELECT \* FROM card_cache WHERE id = \?/,
    'selecting named columns here is how fields go missing one at a time');
  // The response body that carries owned_entries must also carry the card.
  const i = route.indexOf('owned_entries: ownedRows');
  assert.ok(i > 0, 'owned_entries must be returned');
  assert.match(route.slice(i, i + 220), /^[\s\S]*\n\s*card,/,
    'the card row must be returned to the client');
});

// --- CIP-TC13: THE CARD IS FETCHED ON OPEN, NOT ON TAB CHANGE --------------
//
// Zach: "This is deck view card detail I want collection card detail view to
// look the same. It still doesn't."
//
// I made the endpoint serve the card and merged it into `view` -- then gated
// the fetch to the Yours and Decks tabs, reasoning that most opens never leave
// the Card tab.
//
// THE CARD TAB IS THE DEFAULT. So on first open deckUse was null, `view` fell
// back to the caller's object, and from the collection that object has no
// oracle_text and no mana_cost. Rules text and mana cost were simply blank on
// the screen you land on. From the deck view the caller HAS both, so it looked
// right -- which is precisely the difference he kept reporting.
//
// MY PARITY TEST MISSED IT because it compared MERGED objects: a state that
// assumes a fetch which never happened. It measured a screen the user never
// sees. That is the second test on this branch to pass while the bug was live.

test('CIP-TC13: the card request is not gated on the tab', () => {
  // Anchor on the EFFECT BODY. The invalidator now sits between the ref
  // declaration and the effect, so a fixed window from the ref reads the
  // wrong code -- the same slicing mistake as CIT-TC7.
  const at = impl.indexOf('if (!card) return;', impl.indexOf('const deckFetchFor'));
  assert.ok(at > 0, 'the fetch effect must exist');
  const eff = impl.slice(at, at + 1200);

  assert.doesNotMatch(eff, /tab !== 'decks'/,
    'gating the fetch on the tab leaves the DEFAULT tab unmerged, so the '
    + 'sheet renders the caller object and the two screens differ');
  assert.match(eff, /if \(!card\) return;/,
    'the card must be fetched as soon as a card is shown');
});

test('CIP-TC14: mana value is not shown', () => {
  // Zach: "please remove mana value from the view."
  assert.doesNotMatch(impl, /inspector\.manaValue/,
    'the mana value row must be gone from the card tab');
});

// --- CIP-TC15: THE CARD TAB SHOWS THE FACE YOU ARE LOOKING AT --------------
//
// Zach: "for card tab if it's a flip card should only show the side of the
// card showing so if Tony stark is showing that's the card info that should
// show. If I flip Tony stark to invincible iron man then that info should
// show"
//
// It previously showed BOTH faces stacked -- my choice, so you would never
// flip merely to read the back. Once the ART flips, that is worse than showing
// one: the picture says one thing and the text says two, and the reader has to
// work out which half belongs to what they are seeing.
//
// Scryfall stores the faces joined -- "front // back" for type_line and
// mana_cost, "=== Face ===" blocks for oracle_text -- so the split happens
// here rather than at import, keeping one row per printing.

test('CIP-TC15: rules text, type line and mana cost follow the shown face', () => {
  assert.match(impl, /const faceIndex = showBack && view\?\.back_image_url \? 1 : 0;/,
    'the face index must follow the flip state');

  const start = impl.indexOf("{tab === 'card' && (");
  const end = impl.indexOf("{mode === 'edit' ? (", start);
  const cardTab = impl.slice(start, end);

  assert.match(cardTab, /\{faceRules\}/,
    'rules text must render the shown face, not both');
  assert.doesNotMatch(cardTab, /\{view\.oracle_text\}/,
    'rendering the whole oracle_text shows both faces at once');
  // The type line MOVED OUT of the card tab, under the card name, so the tab
  // bar no longer sits between a card's name and its type. It must still
  // follow the shown face, which is what this checks now.
  assert.match(impl, /\{faceTypeLine\}/,
    'the type line must still render, and follow the shown face');
  assert.doesNotMatch(cardTab, /\{faceTypeLine\}/,
    'it belongs under the name now, not at the top of the Card tab');
  assert.match(cardTab, /facePart\(view\.mana_cost\)/,
    'the mana cost must be the shown face');
});

test('CIP-TC16: a single-faced card is unaffected by the face split', () => {
  // The split must collapse to a no-op when there is no separator, or every
  // ordinary card loses its rules text -- a far worse bug than the one being
  // fixed. Exercising the real helpers' logic on single-faced input.
  const facePart = (val, faceIndex) => {
    if (typeof val !== 'string') return val;
    const parts = val.split(' // ');
    return parts.length > 1 ? (parts[faceIndex] ?? parts[0]) : val;
  };
  assert.equal(facePart('{2}{R}', 0), '{2}{R}');
  assert.equal(facePart('{2}{R}', 1), '{2}{R}',
    'a single-faced card has no back to switch to');
  assert.equal(facePart('Creature — Goblin', 0), 'Creature — Goblin');
  assert.equal(facePart('{1}{U} // {4}{U}{R}', 1), '{4}{U}{R}',
    'a double-faced cost splits on the separator');
});

// --- CIP-TC17: THE CARD TAB DOES NOT REPEAT THE HEADER --------------------
//
// Zach: "there is a lot of redundant things showing. 1 rarity at the bottom is
// also at the top. Color identity is now in 2 spots as well. I think we get
// rid of the bottom grid and add mana value next to the red blue chips"
//
// He was right twice, and the colour-identity duplication was one I created an
// hour earlier: the pips rendered EMPTY until I parsed `types`, so the grid row
// was the only place colours appeared. Fixing that bug made this one visible --
// a reminder that removing a duplicate is only safe once you know which copy
// the user was actually reading.

test('CIP-TC17: rarity appears once, in the header', () => {
  const cardTab = (() => {
    const start = impl.indexOf("{tab === 'card' &&");
    let depth = 0;
    for (let k = start; k < impl.length; k++) {
      if (impl[k] === '{') depth++;
      else if (impl[k] === '}' && --depth === 0) return impl.slice(start, k);
    }
    throw new Error('card tab not bounded');
  })();

  assert.doesNotMatch(cardTab, /view\.rarity|inspector\.rarity/,
    'rarity is already in the header line under the card name');
  assert.match(impl, /card\.rarity \?/,
    'and it must still be there');
});

test('CIP-TC18: colour identity appears once, as the pips', () => {
  assert.doesNotMatch(impl, /inspector\.colorIdentity/,
    'the coloured pips ARE the colour identity -- a text row repeating them '
    + 'in grey says the same thing worse');
  assert.match(impl, /cardColors\.map/, 'the pips must still render');
});

test('CIP-TC19: mana cost survived the grid removal', () => {
  // The one fact in that grid that was NOT shown anywhere else. Deleting a
  // block of duplicates is only safe if you check every row first.
  assert.match(impl, /\{facePart\(view\.mana_cost\) && \(/,
    'mana cost must render somewhere');

  // Beside the pips, in the same row -- same kind of fact.
  const pips = impl.indexOf('cardColors.map');
  const cost = impl.indexOf('facePart(view.mana_cost) && (');
  assert.ok(cost > pips && cost - pips < 1400,
    'mana cost belongs next to the colour pips, per Zach');
});

test('CIP-TC20: the pip row renders when there is anything to show', () => {
  // A colourless card with a mana cost must still get the row, or the cost
  // silently vanishes -- the wrapper-guard-too-tight mistake in reverse.
  assert.match(impl,
    /view\.supertype === 'MTG' && \(cardColors\.length > 0 \|\| facePart\(view\.mana_cost\)\) && \(/,
    'the row must render for colours OR a mana cost, not colours alone');
});
