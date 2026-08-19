// PR 7A — the multi-deck buylist's presentation fixes.
//
// WHAT THESE CAN AND CANNOT PROVE, stated plainly, in the same style as
// deckPolish.test.js.
//
// DeckBuilder.jsx is a 4000-line component and this repo has no render harness,
// so these are SOURCE CONTRACT assertions. They prove the wiring exists and
// that the three specific mistakes this PR fixes cannot silently come back:
//
//   * the entry point is named for the OUTCOME ("Build a buylist"), not for the
//     mechanism ("Select decks")
//   * selected decks are marked on the deck itself in BOTH view modes, not only
//     by a checkbox, and in the table view a checkbox exists at all
//   * the selected marker costs ZERO width, so it cannot reintroduce the
//     horizontal overflow PR 6I fixed on a phone
//
// They CANNOT prove that the yellow is legible, that the ring reads as
// "selected" at a glance, or that anything fits an iPhone 16. Those need Zach's
// eyes on a real phone, and the report for this PR says so rather than implying
// the tests covered it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const builder = fs.readFileSync(path.join(here, 'DeckBuilder.jsx'), 'utf8');
const panel = fs.readFileSync(path.join(here, 'MissingCardsPanel.jsx'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'locales', 'en.json'), 'utf8'));

// ---------------------------------------------------------------------------
// PROBLEM 1 — the entry point names the GOAL, not the mechanism.
// ---------------------------------------------------------------------------

// The string he reads BEFORE entering the flow must describe the outcome. The
// old wording ("Select decks") told him to perform a step without ever saying
// what the step was for; he only learned the purpose after ticking boxes.
assert.match(
  en['deck.multiBuylistSelect'],
  /buylist/i,
  'the entry-point label must name the buylist — the outcome — not the selection step'
);
assert.doesNotMatch(
  en['deck.multiBuylistSelect'],
  /^select/i,
  'the entry point must not be named for the first interaction inside the flow'
);

// And the toolbar button must actually use that key, with a way back out once
// the mode is active. A mode entered from a button that does not release it is
// the "panel with no exit" defect class.
assert.ok(
  /deck\.multiBuylistSelect/.test(builder) && /deck\.multiBuylistCancel/.test(builder),
  'the toolbar button must show the build label when idle and a cancel label while selecting'
);
assert.ok(
  typeof en['deck.multiBuylistCancel'] === 'string',
  'the cancel label must exist in en.json'
);

// Deck selection is presented as a STEP INSIDE the flow, so the panel states
// what the ticking is for rather than leaving it implicit.
assert.ok(
  typeof en['deck.multiBuylistStepHint'] === 'string'
    && /buylist/i.test(en['deck.multiBuylistStepHint']),
  'the selection panel must state that ticking decks feeds the buylist'
);
assert.ok(
  /deck\.multiBuylistStepHint/.test(builder),
  'the step hint must actually be rendered in the selection panel'
);

// ---------------------------------------------------------------------------
// PROBLEM 2 — selected decks are unmistakable in BOTH view modes.
// ---------------------------------------------------------------------------

// Both branches of the view-mode switch must derive a selected flag. Without
// this the only feedback is a checkbox, which he reported was not enough — and
// the cost of missing it is shopping for a deck he never meant to include.
const gridBranch = builder.slice(
  builder.indexOf("deckSelectionViewMode === 'grid'"),
  builder.indexOf('--- TABLE VIEW ---') > -1
    ? builder.indexOf('--- TABLE VIEW ---')
    : builder.indexOf('<thead>')
);
const tableBranch = builder.slice(
  builder.indexOf('<thead>'),
  builder.indexOf('</table>')
);

for (const [name, source] of [['grid', gridBranch], ['table', tableBranch]]) {
  assert.ok(
    /const isSelected\s*=\s*selectMode && selectedDeckIds\.includes\(deck\.id\)/.test(source),
    `the ${name} view must derive a selected flag from the real selection`
  );
  assert.ok(
    /isSelected\s*\?/.test(source),
    `the ${name} view must style the deck itself on that flag, not only the checkbox`
  );
}

// THE TABLE VIEW HAD NO CHECKBOX AT ALL. Its only selection feedback was the
// counter in the panel above, which is not on the row he just tapped.
assert.ok(
  /type="checkbox"/.test(tableBranch),
  'the table view must offer a checkbox on the row, as the grid view already does'
);

// SELECTION MUST SURVIVE HOVER. Both views set background/boxShadow imperatively
// on mouse events, so a naive handler resetting to the unselected value would
// erase the selected look under the pointer — worse than no marker at all.
assert.ok(
  /onMouseLeave=\{e => \{[\s\S]{0,400}?isSelected/.test(gridBranch),
  'leaving a hovered grid card must restore its selected ring, not clear it'
);
assert.ok(
  /onMouseLeave=\{e => e\.currentTarget\.style\.background = restingBackground\}/.test(tableBranch),
  'leaving a hovered table row must restore its selected background, not go transparent'
);

// ---------------------------------------------------------------------------
// MOBILE — the selected marker must cost ZERO width.
//
// PR 6I fixed horizontal overflow on an iPhone 16. A wider border or an extra
// table column on the selected state would reintroduce exactly that, and it
// would only show up on the phone, only while selecting.
// ---------------------------------------------------------------------------

// The markers are inset box-shadows, which paint inside the existing box and do
// not participate in layout.
assert.ok(
  /boxShadow: isSelected \? 'inset /.test(gridBranch),
  'the grid selected ring must be an INSET shadow — it must not add width'
);
assert.ok(
  /boxShadow: isSelected \? 'inset /.test(tableBranch),
  'the table selected bar must be an INSET shadow — a real left border would widen the table'
);

// The border stays 1px in every state; only its colour changes.
const gridBorders = gridBranch.match(/'\d+(?:\.\d+)?px solid [^']+'/g) || [];
for (const border of gridBorders) {
  assert.ok(
    /^'1px /.test(border),
    `every deck-card border must stay 1px so selection cannot change the card's box (saw ${border})`
  );
}

// No new table column: the tick goes inside the existing first cell.
const headerCells = (tableBranch.match(/<th /g) || []).length;
assert.strictEqual(
  headerCells, 6,
  'the table must keep its six columns — an extra selection column would widen it on a phone'
);

// ---------------------------------------------------------------------------
// PROBLEM 3 — the generated list says what it covers.
// ---------------------------------------------------------------------------

assert.ok(
  /buylistCoverage/.test(panel),
  'the panel must render the coverage line for the combined buylist'
);
assert.ok(
  /deck\.multiBuylistCovers/.test(panel),
  'and it must use the coverage string'
);
assert.ok(
  typeof en['deck.multiBuylistCovers.one'] === 'string'
    && typeof en['deck.multiBuylistCovers.other'] === 'string',
  'the coverage string is counted, so it must exist as a plural pair'
);
for (const key of ['deck.multiBuylistCovers.one', 'deck.multiBuylistCovers.other']) {
  assert.ok(
    en[key].includes('{count}') && en[key].includes('{names}'),
    `${key} must carry both the count and the deck names — the names are what make the list self-describing`
  );
}

// ---------------------------------------------------------------------------
// PR 7B — the redundant controls are gone, and ONE exit remains.
//
// Zach: "the build buylist/cancel seem redundant when I click build a buylist
// and check off decks it should just automatically update".
// ---------------------------------------------------------------------------

// The build and clear ACTIONS are gone from the panel. Ticking a deck is the
// instruction; a confirm button re-asks a question already answered on screen,
// which is the defect class PR 6F removed from the printing picker.
assert.doesNotMatch(
  builder, /deck\.multiBuylistBuild/,
  'there must be no "Build buylist" button — the selection already says to build it'
);
assert.doesNotMatch(
  builder, /deck\.multiBuylistClear/,
  'there must be no "Clear" button — unticking every deck already empties the list'
);
// And the dead strings must not linger in en.json to be re-wired later.
for (const dead of ['deck.multiBuylistBuild', 'deck.multiBuylistClear']) {
  assert.equal(en[dead], undefined, `${dead} is a removed action and must not remain a string`);
}

// The hint must not instruct him to press a button that no longer exists.
assert.doesNotMatch(
  en['deck.multiBuylistStepHint'], /then build/i,
  'the step hint must not tell him to build — the list follows the ticks'
);

// EXACTLY ONE EXIT. The toolbar button he entered from is the way out; a second
// dismiss inside the panel would be two controls for one outcome.
assert.equal(
  (builder.match(/deck\.multiBuylistCancel/g) || []).length, 1,
  'the flow must have exactly one exit affordance'
);
assert.ok(
  /exitBuylistMode/.test(builder),
  'leaving the mode must go through one function that also drops the list and any in-flight request'
);

// THE LIST IS DRIVEN BY THE SELECTION, not by a click handler. This is the
// correctness property: a list that does not follow the ticks would tell him to
// buy cards for a deck he unticked.
assert.ok(
  /useEffect\(\(\) => \{[\s\S]{0,200}?buylistSyncRef\.current\.select\(selectedDeckIds\)/.test(builder),
  'the combined buylist must be driven by the selection itself'
);
assert.doesNotMatch(
  builder, /refreshMultiBuylist/,
  'the old imperative build path must be gone — two paths to the list would drift'
);

// ---------------------------------------------------------------------------
// PR 7C — THE BRACKET-STYLE CHOICE.
//
// Zach: "the set code needs to be in brackets not parenthesis" ... "I think you
// should be able to choose brackets or paranthesis before copy. Maybe default
// to brackets."
//
// The formatting itself is proven in utils/deckText.test.js, which can call the
// exporter directly. What CANNOT be proven there is the wiring, and the wiring
// carries the one property that matters here: the per-deck buylist and the
// multi-deck buylist must never be able to disagree about the format. These are
// source-contract assertions on that wiring.
// ---------------------------------------------------------------------------

// ONE PIECE OF STATE, not one per panel. Two independent toggles would let him
// copy one list in brackets and the other in parentheses on the same shopping
// trip, and he would only find out at the counter.
assert.equal(
  (builder.match(/const \[buylistBracketStyle, setBuylistBracketStyleState\] = useState/g) || []).length,
  1,
  'the bracket style must be a single piece of state shared by both buylists'
);

// And BOTH panels must actually be fed it, with a way to change it. A panel
// that received the value but no setter would show a choice it could not honour.
// The multi-deck panel carries inline handlers, so the window is generous; the
// match is non-greedy and stops at that element's own closing `/>`.
const panelUses = builder.match(/<MissingCardsPanel[\s\S]{0,1500}?\/>/g) || [];
assert.equal(panelUses.length, 2, 'there are exactly two buylist panels: per-deck and multi-deck');
for (const use of panelUses) {
  assert.ok(
    /bracketStyle=\{buylistBracketStyle\}/.test(use),
    'every buylist panel must render the SAME shared bracket style'
  );
  assert.ok(
    /onBracketStyleChange=\{setBuylistBracketStyle\}/.test(use),
    'every buylist panel must change that same shared style, not a local copy'
  );
}

// BOTH text builders must pass the choice through. A missed one would copy in
// the default while the panel above it displayed the other form — the exact
// "what I read is not what I pasted" surprise this PR exists to remove.
for (const fn of ['multiBuylistText', 'buylistText']) {
  const body = builder.slice(builder.indexOf(`const ${fn} = () => buildDeckExport`));
  assert.ok(
    /bracketStyle: buylistBracketStyle/.test(body.slice(0, 400)),
    `${fn} must pass the chosen bracket style to the exporter`
  );
}

// THE PANEL IS ITS OWN PREVIEW: what is on screen is what gets copied, so the
// displayed printing must be built from the chosen style rather than hardcoded.
assert.ok(
  /const \[open, close\] = style === 'brackets'/.test(panel),
  'the on-screen printing label must use the chosen delimiters, so reading and pasting agree'
);

// THE CHOICE IS OFFERED BEFORE COPYING, in the same row as the copy actions —
// not in a settings screen, and not behind a modal.
const copyRow = panel.slice(panel.indexOf("aria-label={t('deck.buylistBracketStyle')}"), panel.indexOf("deck.copyOpenTcg"));
assert.ok(copyRow.length > 0, 'the style toggle must sit above the copy buttons in the same row');
assert.ok(
  /aria-pressed=\{style === option\}/.test(copyRow),
  'the toggle must expose its two-state selection, and the selected side must be visible'
);
assert.ok(
  /btn-primary.*:.*btn-secondary|\$\{style === option \? 'btn-primary' : 'btn-secondary'\}/.test(copyRow),
  'the selected style must be visually obvious, reusing the app\'s existing segmented-toggle look'
);

// MOBILE — the toggle must not widen the panel. PR 6I fixed horizontal overflow
// on an iPhone 16 caused by a flex-basis wider than the viewport; a fixed width
// or a basis here would bring it straight back, and only on the phone.
assert.doesNotMatch(
  copyRow, /flexBasis|minWidth:\s*'\d/,
  'the style toggle must not set a flex-basis or min-width — that is how PR 6I\'s overflow came back'
);
// The row that holds the toggle AND both copy buttons must wrap, so a narrow
// screen stacks them instead of pushing the panel wider than the viewport.
const actionRow = panel.slice(
  panel.lastIndexOf('<div style={{ display:', panel.indexOf("aria-label={t('deck.buylistBracketStyle')}")),
  panel.indexOf('deck.copyOpenTcg')
);
assert.ok(
  /flexWrap: 'wrap'/.test(actionRow),
  'the row holding the toggle must wrap, so a narrow screen stacks it instead of overflowing'
);

// iOS SAFARI — no browser API may be called with a non-Window receiver.
//
// PR 7B1: a debounce seam packed bare setTimeout/clearTimeout into a plain
// object and threw "Can only call Window.setTimeout on instances of Window" on
// iOS Safari, crashing the panel on first tap — after passing every gate,
// because nothing in this repo runs a browser. This PR adds no timers at all,
// and this assertion keeps it that way.
assert.doesNotMatch(
  panel, /\bsetTimeout\b|\bclearTimeout\b|\bsetInterval\b/,
  'the buylist panel must not introduce timers — see PR 7B1, they crash on iOS Safari when detached from Window'
);

// THE PREFERENCE IS REMEMBERED, using the store the app ALREADY uses for UI
// preferences (theme, search_page_size, bindarr_ui_lang). No new persistence
// layer was invented for a two-value toggle.
assert.ok(
  /localStorage\.getItem\('buylist_bracket_style'\)/.test(builder)
    && /localStorage\.setItem\('buylist_bracket_style', style\)/.test(builder),
  'the chosen style must be remembered across visits in the existing preference store'
);
// A stale or hand-edited stored value must not produce a third format.
assert.ok(
  /BRACKET_STYLES\.includes\(stored\) \? stored : DEFAULT_BRACKET_STYLE/.test(builder),
  'an unrecognised stored style must fall back to the default rather than be trusted'
);

// The labels he reads must exist and must say what each choice is FOR — the
// destination is the whole reason there are two.
for (const key of ['deck.buylistBracketStyle', 'deck.buylistBracketsHint', 'deck.buylistParenthesesHint']) {
  assert.equal(typeof en[key], 'string', `${key} must exist in en.json`);
}
assert.match(en['deck.buylistBracketsHint'], /shop|tcgplayer/i, 'the brackets hint must name where brackets are wanted');
assert.match(en['deck.buylistParenthesesHint'], /arena/i, 'the parentheses hint must name where parentheses are wanted');

console.log('DeckBuilder PR 7A buylist-UX self-check passed');
