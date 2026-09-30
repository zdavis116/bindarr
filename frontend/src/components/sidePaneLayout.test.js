// The desktop side pane must not be drawn through, and card text must wrap.
//
// Zach, with a full screenshot: "the right pane is all messed up".
//
// TWO SEPARATE BUGS in one picture, and neither was a regression from that
// day's work -- both had been there since the pane was built.
//
// 1. THE PANE HAD NO z-index. It is `position: fixed`, so it leaves the flow
//    entirely and stacks by document order, which loses to ANY positioned
//    element. The deck list's sticky section headers are z-index 5, so a
//    header and a stray card count "1" drew straight through the pane on top
//    of the oracle text.
//
// 2. THE ORACLE TEXT DID NOT WRAP. Oscorp Industries' Mayhem reminder is one
//    long line; `white-space: pre-wrap` preserves the card's own breaks but
//    will not break a line that has nowhere to break. The last line rendered
//    as "ng rules still apply.)" -- clipped at the left, not wrapped.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, '..', 'index.css'), 'utf8');
const layers = readFileSync(join(HERE, '..', 'utils', 'zLayers.js'), 'utf8');
const modal = readFileSync(join(HERE, 'CardInspectorModal.jsx'), 'utf8');
const deck = readFileSync(join(HERE, 'DeckView.jsx'), 'utf8');
const card = readFileSync(join(HERE, 'DeckCard.jsx'), 'utf8');
const en = JSON.parse(readFileSync(join(HERE, '..', 'locales', 'en.json'), 'utf8'));

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// PANE-TC1: the pane stays IN its grid track, and declares a stacking order.
//
// TWO FAILURES ARE PINNED HERE, because the fix for each caused the other:
//
//   plain sticky, no height -> started 388px down the document and ran past
//                              the fold; scrolled, its top went negative
//   fixed                   -> pinned to the VIEWPORT, so on a wide window it
//                              floated outside its own reserved track
//                              (Zach drew a red box round the empty track)
//
// Sticky keeps it in the grid so the track IS the pane; `top` and a definite
// viewport-relative `height` handle the reasons sticky failed the first time.
{
  start('PANE-TC1');
  const rule = /\.deck-panes-side \{[\s\S]*?\n  \}/.exec(css);
  assert.ok(rule, '.deck-panes-side could not be found');
  // ANCHORED TO THE DECLARATION, NOT THE WORD.
  //
  // This first matched `position: sticky;` anywhere in the block -- and the
  // comment above it discusses `position: sticky` by name. So switching the
  // real rule back to `fixed`, which is exactly the bug Zach reported, left
  // the test GREEN. Caught by M5.
  //
  // The declaration is four-space indented at the start of a line; prose is
  // not.
  assert.match(rule[0], /\n    position: sticky;/,
    'the pane must stay in its grid track. position:fixed pins to the '
    + 'viewport, which is not where the reserved column is on a wide window');
  assert.ok(!/\n    position: fixed;/.test(rule[0]),
    'position:fixed is the bug: the pane floats outside its own reserved '
    + 'track on a wide window');
  assert.match(rule[0], /top: var\(--deck-pane-top, [\d.]+rem\);/,
    'sticky alone starts at the document offset -- 388px down -- so `top` is '
    + 'what stops it beginning below the fold');
  assert.match(rule[0], /height: calc\(100dvh/,
    'a definite viewport-relative height is what stops it running PAST the '
    + 'fold, and gives the height:100% inspector inside something to resolve '
    + 'against');
  assert.match(rule[0], /min-height:/,
    'the safety net: a layout rule that can evaluate to zero eventually will');
  assert.ok(!/\n    width: clamp/.test(rule[0]),
    'the grid column sizes the pane now; repeating the clamp here is how the '
    + 'element and its track drifted apart before');
  const z = /z-index: (\d+);/.exec(rule[0]);
  assert.ok(z,
    'a positioned pane with NO z-index stacks by document order and loses '
    + "to the list's sticky headers. That is the bug in Zach's screenshot");
  pass('PANE-TC1', 'the pane sits in its track, pinned and stacked');
}

// PANE-TC2: it sits ABOVE the list it covers and BELOW the app header.
//
// Both directions matter. Too low and the list draws through it; too high and
// it covers the header it is positioned beneath.
{
  start('PANE-TC2');
  const rule = /\.deck-panes-side \{[\s\S]*?\n  \}/.exec(css)[0];
  const paneZ = Number(/z-index: (\d+);/.exec(rule)[1]);

  // The list's sticky section headers, set inline in DeckView.
  const listZ = Number(/position: 'sticky', top: 0,[\s\S]{0,120}?zIndex: (\d+)/.exec(deck)[1]);
  assert.ok(paneZ > listZ,
    `the pane (${paneZ}) must sit above the list's sticky headers (${listZ})`);

  // The app header, which the pane is positioned under.
  const headerZ = Number(/\.app-header \{[\s\S]*?z-index: (\d+);/.exec(css)[1]);
  assert.ok(paneZ < headerZ,
    `the pane (${paneZ}) must sit BELOW the app header (${headerZ}); an equal `
    + 'value resolves by document order, which is the accident being fixed');
  pass('PANE-TC2', 'the pane is above the list and below the header');
}

// PANE-TC3: the value is in the shared registry, not only in the stylesheet.
//
// zLayers.js exists because "numbers scattered through JSX cannot be reasoned
// about". A pane z-index that lives only in index.css is the same problem.
{
  start('PANE-TC3');
  assert.match(layers, /export const Z_SIDE_PANE = (\d+);/,
    'the side pane must be a named layer, not a bare number in one stylesheet');
  const declared = Number(/export const Z_SIDE_PANE = (\d+);/.exec(layers)[1]);
  const inCss = Number(/\.deck-panes-side \{[\s\S]*?z-index: (\d+);/.exec(css)[1]);
  assert.strictEqual(declared, inCss,
    `zLayers says ${declared}, index.css says ${inCss}. They must agree or the `
    + 'registry is documentation rather than truth');
  pass('PANE-TC3', 'the layer is registered and matches the stylesheet');
}

// PANE-TC4: long rules text wraps instead of overflowing.
{
  start('PANE-TC4');
  const box = /\{faceRules && \([\s\S]*?\}\}>/.exec(modal);
  assert.ok(box, 'the oracle text box could not be found');
  assert.match(box[0], /whiteSpace: 'pre-wrap'/,
    "the card's own line breaks must be preserved");
  assert.match(box[0], /overflowWrap: 'anywhere'/,
    'pre-wrap alone will not break a long line with nowhere to break, which '
    + 'is how "ng rules still apply.)" ended up clipped');
  assert.match(box[0], /minWidth: 0/,
    'a grid child will not shrink below its content without minWidth:0, so '
    + 'the box would push past its track however the text wraps');
  pass('PANE-TC4', 'rules text wraps to its column');
}

// PANE-TC5: the deck header's money figures are grouped, not adrift.
//
// Zach: "why is the 195 just floating in the middle that needs to be aligned
// better." The row was `space-between` with TWO children and read correctly;
// adding the deck value made three, and space-between parks the middle one in
// the centre with gaps either side. It looked adrift because nothing was
// aligning it to anything.
{
  start('PANE-TC5');
  const row = /<div style=\{\{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0\.7rem'[\s\S]*?\n        <\/div>/.exec(deck);
  assert.ok(row, "the deck header's figures row could not be found");
  assert.match(row[0], /marginLeft: 'auto'/,
    'the two money figures must be grouped and pushed right together; with '
    + 'three loose children space-between strands the middle one');
  const worthAt = row[0].indexOf('deckWorth > 0');
  const groupAt = row[0].indexOf("marginLeft: 'auto'");
  assert.ok(groupAt > 0 && groupAt < worthAt,
    'the grouping wrapper must open BEFORE the value, or it groups nothing');
  pass('PANE-TC5', 'the money figures are grouped right');
}

// PANE-TC6: a finished deck tile still shows what it is worth.
//
// Zach: "the deck cards should also show the total of value of the deck."
// deckValue was fetched and carried all the way to DeckCard, then never
// rendered on a complete deck -- which showed only the word "Complete".
{
  start('PANE-TC6');
  assert.match(card, /deck\.have >= deck\.target\s*\n\s*\? \(/,
    'the complete branch must render more than a bare string now');
  const complete = /deck\.have >= deck\.target[\s\S]*?\n            \)\n            : \(/.exec(card);
  assert.ok(complete, 'the complete-deck branch could not be found');
  assert.match(complete[0], /deck\.deckValue > 0/,
    'a finished deck must show its value -- it is the only money figure that '
    + 'applies to it, and it was being fetched and thrown away');
  assert.match(complete[0], /t\('deck\.priceUnknown'\)/,
    'an unpriced deck must say so rather than render an empty string, which '
    + 'reads as "this is worth nothing"');
  // The new figure needs the same inline rule as the cost, or the footer
  // wraps to two lines -- a failure this file already fixed once.
  assert.match(css, /\.deck-row-foot-run \.deck-row-value \{ display: inline !important; \}/,
    'a <b> computes to display:block in this footer and starts a new line; '
    + 'the value needs the same override the cost has');
  pass('PANE-TC6', 'a complete deck tile shows its value');
}

// PANE-TC7: the savings line does not set the money block's width.
//
// Zach: "why is there still a gap like this it just looks weird."
//
// It lived INSIDE the cost-to-finish block as a third line, nowrap and ~240px
// wide against a "$19.42" above it. A block is as wide as its widest child, so
// the savings line -- not the number -- sized that block and pushed the deck
// value left into the middle of the row. The gap was its overhang.
{
  start('PANE-TC7');
  const row = /<div style=\{\{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0\.7rem'[\s\S]*?\n        <\/div>/.exec(deck);
  assert.ok(row, "the deck header's figures row could not be found");
  assert.ok(!/toFinishCheapest/.test(row[0]),
    'the savings line must NOT sit inside the figures row; it is wider than '
    + 'either number and silently sets its block width');
  assert.match(deck, /\{costToFinish > 0 && savings !== null && \(/,
    'it must render as its own row, and only when there is a saving to state');
  pass('PANE-TC7', 'the savings line cannot widen the money block');
}

// PANE-TC8: catalogue results yield when the card is already in the deck.
//
// Zach: "when I search it shows cards in a drop down but it pushes my deck
// list down further so I have to scroll to see if its even in my deck... if I
// search for something and its in the deck I am searching in it just shows the
// card in the deck no drop down list of other cards."
//
// The answer to "is it in here" was being pushed below the fold by an offer to
// add cards he did not ask for.
{
  start('PANE-TC8');
  assert.match(deck, /\{\(searching \|\| results\.length > 0\) && !deckHasMatch && \(/,
    'the add-a-card results must be suppressed when the deck already has a '
    + 'match, or the answer stays below the fold');

  const memo = /const deckHasMatch = useMemo\([\s\S]*?\n  \}, \[query, deckCards, considering\]\);/.exec(deck);
  assert.ok(memo, 'deckHasMatch could not be found');
  assert.match(memo[0], /\[\.\.\.deckCards, \.\.\.considering\]/,
    'it must check the WHOLE deck, not the filtered list: a card on another '
    + 'tab is still in this deck');
  assert.ok(!/type_line/.test(memo[0]),
    'name only -- matching the type line here would suppress the add results '
    + 'for every search that happens to name a card type');

  // And the list must then tell the truth about where the card is.
  assert.match(deck, /deckHasMatch \? t\('deck\.matchOnAnotherTab'\) : t\('deck\.noCardsMatch'\)/,
    'with the results gone the list is the only answer on screen; saying "no '
    + 'cards match" while the card is on another tab contradicts itself');
  assert.ok('deck.matchOnAnotherTab' in en,
    'deck.matchOnAnotherTab has no string; the app renders the KEY when one '
    + 'is missing');
  pass('PANE-TC8', 'the deck answers first, and says where the card is');
}

console.log(`\nsidePaneLayout.test.js: ${passed} cases passed`);
