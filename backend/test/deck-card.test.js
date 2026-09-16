// ONE DECK CARD, USED BY BOTH SCREENS.
//
// Zach: "the cards should be setup identical on the dashboard and card list.
// Right now don't look exactly the same."
//
// They were not identical because they were two parallel implementations: the
// dashboard had .dash-deck markup with .dash-deck-* CSS, the deck list had
// .deck-row with .deck-row-*. Every fix had to be made twice, and the second
// one drifted -- the dashboard silently lost the Moxfield badge, and the two
// used different art heights and font sizes.
//
// Same root cause as cmc-vs-mv on the curve, the chart-vs-list filter, and the
// row-vs-tooltip odds: ONE question answered in TWO places. The fix is always
// to delete the duplicate rather than repair both.
//
// These cases guard the collapse, not the pixels.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
const pass = (id, what) => { passed += 1; console.log(`PASS: ${id} ${what}`); };

const components = path.join(__dirname, '..', '..', 'frontend', 'src', 'components');
const read = (f) => fs.readFileSync(path.join(components, f), 'utf8');

const dashboard = read('Dashboard.jsx');
const deckList = read('DeckList.jsx');
const deckCard = read('DeckCard.jsx');

// --- DC-TC1 ------------------------------------------------------------------
// BOTH SCREENS RENDER THE SHARED COMPONENT.
{
  for (const [name, src] of [['Dashboard.jsx', dashboard], ['DeckList.jsx', deckList]]) {
    assert.ok(/from '\.\/DeckCard'/.test(src),
      `${name} must import the shared DeckCard`);
    assert.ok(/<DeckCard\b/.test(src),
      `${name} must RENDER DeckCard, not its own deck markup`);
  }
  pass('DC-TC1', 'the dashboard and the deck list render the same component');
}

// --- DC-TC2 ------------------------------------------------------------------
// NEITHER SCREEN KEEPS A PRIVATE COPY of the card's internals.
//
// This is the assertion that would have failed before the collapse: the
// dashboard built its own art/name/meta markup and its own progress ring.
{
  assert.ok(!/dash-deck\b/.test(dashboard),
    'Dashboard.jsx must not keep its own .dash-deck card markup');
  assert.ok(!/className="dash-deck-/.test(dashboard),
    'Dashboard.jsx must not keep its own .dash-deck-* internals');

  // The ring lives in DeckCard. Two definitions means two behaviours.
  const ringDefs = [dashboard, deckList].filter((s) => /function Ring\(/.test(s)).length;
  assert.strictEqual(ringDefs, 0,
    'the progress ring belongs to DeckCard -- neither screen may redefine it');
  assert.ok(/function Ring\(/.test(deckCard),
    'and DeckCard must actually define it');

  pass('DC-TC2', 'no private copies of the card internals survive');
}

// --- DC-TC3 ------------------------------------------------------------------
// THE CARD CARRIES THE PARTS ZACH ASKED FOR.
//
// The badge was lost entirely when the dashboard rows became cards ("The card
// for decks in progress lost the moxfield bubble"), and the percentage had to
// move off the art ("the percent should be in the bottom right of the card in
// the gray area so its readable").
{
  assert.ok(/deck-source-badge/.test(deckCard),
    'the card must render the Moxfield badge -- it was lost once already');
  assert.ok(/deck-ring-pct/.test(deckCard),
    'the percentage must live INSIDE the ring -- Zach: "put it around the '
    + 'percentage like it was before". Two separate elements is what let the '
    + 'ring and the number drift onto opposite corners of the card');
  assert.ok(/<Ring\b/.test(deckCard),
    'and the card must render the ring itself');
  assert.ok(/deck-row-art/.test(deckCard) && /deck-row-body/.test(deckCard),
    'the card must render commander art and a text body');

  pass('DC-TC3', 'the card has art, badge, body and percentage');
}

// --- DC-TC4 ------------------------------------------------------------------
// EVERY CLASS THE CARD USES HAS A CSS RULE.
//
// A className with no rule renders with browser defaults -- the invisible
// element bug. uiClassNames.test.js covers this app-wide; this narrows it to
// the card so a failure names the right file.
{
  const css = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'index.css'), 'utf8');
  const defined = new Set(
    [...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]));

  const used = new Set();
  for (const m of deckCard.matchAll(/className="([^"{}]+)"/g)) {
    for (const cls of m[1].trim().split(/\s+/)) used.add(cls);
  }
  // Template-literal classNames carry the base name before the conditional.
  for (const m of deckCard.matchAll(/className=\{`([a-z][a-z0-9-]*)/g)) used.add(m[1]);

  const missing = [...used].filter((c) => !defined.has(c));
  assert.deepStrictEqual(missing, [],
    `DeckCard uses classes with no CSS rule: ${missing.join(', ')}`);
  assert.ok(used.size >= 5,
    `expected to find the card's classes, found ${used.size}`);

  pass('DC-TC4', 'every class the card uses is styled');
}

// --- DC-TC5 ------------------------------------------------------------------
// TWO ACROSS, BOTH SCREENS. Zach: "the cards should be two to a row for the
// deck list and two per scroll for the dashboard."
{
  const css = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'index.css'), 'utf8');

  const rows = css.slice(css.indexOf('.deck-rows {'));
  assert.ok(/grid-template-columns:\s*repeat\(2,/.test(rows.slice(0, 200)),
    'the deck list must be two cards per row on a phone');

  const strip = css.slice(css.indexOf('.dash-decks > .deck-row {'));
  assert.ok(/\/ 2\)/.test(strip.slice(0, 200)),
    'the dashboard strip must show two cards per scroll on a phone');

  pass('DC-TC5', 'two across on both screens');
}

console.log(`deck-card.test.js: ${passed} cases passed`);
