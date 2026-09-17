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

  // Progress lives in DeckCard. Two definitions means two behaviours.
  const progDefs = [dashboard, deckList]
    .filter((s) => /function (Ring|Progress)\(/.test(s)).length;
  assert.strictEqual(progDefs, 0,
    'the progress indicator belongs to DeckCard -- neither screen may '
    + 'redefine it');
  assert.ok(/function Progress\(/.test(deckCard),
    'and DeckCard must actually define it');

  pass('DC-TC2', 'no private copies of the card internals survive');
}

// --- DC-TC3 ------------------------------------------------------------------
// THE CARD MATCHES THE MOCKUP, AND KEEPS THE BADGES.
//
// Zach: "look at the 2 deck card images the mock up is the 2nd image and the
// 3rd image is what currently exists... it should look like the mockup but keep
// the moxfield and updated badges."
//
// sketches/desktop.html section 1: commander art, name, "Commander · 100
// cards", a progress BAR with a percent pill beside it, then "49 missing ·
// $140.35". It was a ring with the number inside -- a different thing, which
// also needed a position rule per container and silently disagreed between the
// deck list and the dashboard.
{
  assert.ok(/deck-source-badge/.test(deckCard),
    'the card must render the Moxfield badge -- Zach asked to KEEP it');
  assert.ok(/deck-drift-badge/.test(deckCard),
    'and the updated badge');
  // Still a direct child of the card, not of the body: the body is the
  // positioned ancestor, so a badge inside it pins to the text area's corner.
  {
    const body = deckCard.slice(deckCard.indexOf('className="deck-row-body"'));
    assert.ok(!/deck-source-badge/.test(body),
      'the badge must NOT live inside .deck-row-body');
  }
  assert.ok(/<Progress\b/.test(deckCard),
    'progress must be the mockup BAR, not a ring');
  assert.ok(/deck-bar-fill/.test(deckCard) && /deck-pct/.test(deckCard),
    'the bar needs a fill and a percent pill beside it');
  assert.ok(!/deck-ring/.test(deckCard),
    'the ring is gone -- it needed a position rule per container '
    + '(.deck-rows / .dash-decks / .dashx-decks) and a missing entry is '
    + 'exactly how the dashboard ended up with it bottom-LEFT');
  assert.ok(/deck-row-sub/.test(deckCard),
    'the card must show format and size -- "Commander · 100 cards"');
  assert.ok(/deck-row-foot/.test(deckCard),
    'and what is left to do -- "49 missing · $140.35"');
  assert.ok(/deck-row-art/.test(deckCard) && /deck-row-body/.test(deckCard),
    'the card must render commander art and a text body');

  pass('DC-TC3', 'the card matches the mockup and keeps the badges');
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

// --- DC-TC6 ------------------------------------------------------------------
// THE MOST-VALUABLE STRIP MUST NOT STRETCH ITS CARDS.
//
// Zach, three separate times: "why the hell are those card boxes so long look
// at all of that gray area."
//
// Cause: `align-items: stretch` on .dash-top with `flex: 1 1 auto`. The strip
// grew to fill leftover height and stretched every card BOX to match -- but
// the art holds a 0.717 aspect ratio and the caption is a fixed height, so the
// surplus rendered as an empty grey panel under each card.
//
// I "fixed" it twice while the edit never landed on this rule, so two later
// rounds of adjustment were built on a stretched base. This case asserts the
// rule itself, not the symptom.
{
  const css = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'index.css'), 'utf8');

  const strip = css.slice(css.indexOf('.dash-top { display: flex'));
  const rule = strip.slice(0, strip.indexOf('}') + 1);

  assert.ok(!/align-items:\s*stretch/.test(rule),
    'the most-valuable strip must NOT stretch its cards -- the art has a fixed '
    + 'aspect ratio, so a stretched box becomes an empty grey panel');
  assert.ok(/align-items:\s*flex-start/.test(rule),
    'cards must align to the start so each box is only as tall as its content');
  assert.ok(!/flex:\s*1 1/.test(rule),
    'the strip must size to its cards, not grow to fill leftover height');

  pass('DC-TC6', 'the most-valuable strip sizes to its cards');
}

// --- DC-TC7 ------------------------------------------------------------------
// THE COLLECTION PANE REUSES THE CARD INSPECTOR.
//
// Zach approved the two-pane collection: grid left, card right. The detail is
// the SAME CardInspectorModal the phone opens, via its existing `inline` prop
// and .card-inspector-inline layout -- which the deck view already used.
//
// I began writing a SECOND pane mode (`asPane`) before checking, which is the
// deck-card bug again: two implementations of one surface, the second quietly
// worse. This locks the reuse.
{
  const coll = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'CollectionList.jsx'), 'utf8');

  const collCode = coll.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(/<CardInspectorModal[\s\S]{0,400}?\n\s*inline\n/.test(collCode),
    'the collection pane must render CardInspectorModal with `inline` -- not a '
    + 'second card-detail component that would drift from the phone modal');
  const inspector = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'components',
              'CardInspectorModal.jsx'), 'utf8');
  assert.ok(!/\basPane\s*=/.test(inspector) && !/\basPane\b(?!\w)/.test(
    inspector.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')),
    'there must be exactly ONE inline mode on the card inspector -- `inline` '
    + 'already existed for the deck view; a second one drifts');
  assert.ok(/coll-split/.test(coll) && /coll-pane/.test(coll),
    'the split wrapper and pane must exist for the grid to reflow beside the card');

  const css = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'index.css'), 'utf8');
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const pane = bare.slice(bare.indexOf('.coll-pane {'));
  assert.ok(/height:\s*calc\([^)]*--pane-top/.test(pane.slice(0, pane.indexOf('}'))),
    'the pane height must come from the measured --pane-top; without it the '
    + 'body row under the tabs collapses to ~23px and the card looks empty');

  pass('DC-TC7', 'the collection pane reuses the card inspector');
}

// --- DC-TC8 ------------------------------------------------------------------
// THE BADGES PIN TO THE CARD'S OWN TOP-RIGHT CORNER, IN EVERY CONTAINER.
//
// Zach: "the moxfield badge and updated badge both are not in the top right
// corner like they should be. Mobile has it right."
//
// The badges carry position:absolute / top / right, but the SIZING rule is
// scoped per container -- .deck-rows, .dash-decks, .dashx-decks. A container
// missing from that list gets full-size badges on an otherwise identical card,
// which is how the desktop dashboard drifted. Every container that renders a
// DeckCard must appear.
{
  const css = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'index.css'), 'utf8');
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // Which containers actually render a DeckCard?
  const containers = ['deck-rows', 'dash-decks', 'dashx-decks'];
  // The CONTAINER-scoped rule, not the base `.deck-source-badge {}` -- the
  // base one has font-size too, and matching it made this assertion pass
  // regardless of which containers were listed.
  const sizingRule = bare.split('}').find(
    (block) => /\.\w[\w-]*\s+\.deck-source-badge/.test(block)
      && /font-size/.test(block));
  assert.ok(sizingRule, 'the badge sizing rule must exist');
  for (const c of containers) {
    assert.ok(new RegExp(`\\.${c}\\s+\\.deck-source-badge`).test(sizingRule),
      `.${c} is missing from the badge sizing rule, so its cards wear `
      + 'full-size badges while every other screen wears small ones');
  }

  // And the badges must still be pinned to the card, not the text body.
  assert.ok(/\.deck-row\s*>\s*\.deck-source-badge/.test(bare),
    'the badge must pin to .deck-row itself -- pinned from inside '
    + '.deck-row-body it lands in the corner of the TEXT area');

  pass('DC-TC8', 'badges pin to the card in every container');
}

console.log(`deck-card.test.js: ${passed} cases passed`);
