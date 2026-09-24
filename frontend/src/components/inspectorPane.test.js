// THE DETAIL PANE: ONE COMPONENT, ONE BEHAVIOUR, EVERYWHERE.
//
// Zach, 2026-09-23, reviewing the pane on desktop:
//
//   1. "being able to close the right panel card description ... I would like
//      to be hide it"
//   2. "the flip toggle practically covers all the card art that shouldnt be
//      that way. Maybe the flip should be under the mythic - 1x owned"
//   3. "other printings should be a dropdown I can toggle ... It should default
//      closed"
//   4. "that is the only thing that should be scrollable"
//   5. "Edit Card should always be visible at the bottom no need to scroll"
//   6. "the buy on mana pool should be a little button next to edit card"
//   7. "this pane setup and functionally should be the same for every pane
//      including when in the deck view"
//
// (7) IS THE ONE THAT MATTERS STRUCTURALLY, and it is why these are one file.
// CardInspectorModal is shared by five call sites, so its internals fix
// everywhere at once -- but the WRAPPERS are per-screen, and that is exactly
// where they had drifted: the deck view passed `onClose={() => {}}`, a no-op,
// so its pane could not be closed at all while the collection's could.
//
// These cases assert REACHABILITY, not existence. This project's recurring
// failure is a control that is present in the source and never reaches the
// screen -- a `false &&` gate, a no-op handler, a dead className. A test that
// only greps for markup passes straight through all three.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = f => readFileSync(join(here, f), 'utf8');

const insp = read('CardInspectorModal.jsx');
const deck = read('DeckView.jsx');
const coll = read('CollectionList.jsx');
const css  = readFileSync(join(here, '../index.css'), 'utf8');

// Comments discuss all of this at length; the rules must be read from CODE.
const strip = src => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const inspCode = strip(insp);
const deckCode = strip(deck);
const collCode = strip(coll);

test('PANE-TC1: the close button renders in the INLINE pane, not just the modal', () => {
  // It was `{!inline && (` -- the button existed, and was unreachable on every
  // desktop pane. The gate must admit the inline case.
  assert.doesNotMatch(inspCode, /\{!inline && \(\s*\n\s*<div style=\{\{\s*\n\s*order: -1/,
    'the close row must no longer be modal-only');
  assert.match(inspCode, /\{\(!inline \|\| onClose\) && \(/,
    'the close row must render inline whenever a close handler was supplied');
});

test('PANE-TC2: the deck view actually closes -- no more no-op handler', () => {
  // THE BUG BEHIND REQUIREMENT 7. `onClose={() => {}}` satisfies every "is
  // there a close handler" check ever written while doing nothing at all.
  assert.doesNotMatch(deckCode, /onClose=\{\(\) => \{\}\}/,
    'the deck pane must not pass a no-op close handler');
  assert.match(deckCode, /onClose=\{\(\) => \{ setSelectedCardId\(null\); setDetailDismissed\(true\); \}\}/,
    'closing must clear the selection AND mark the pane dismissed');
});

test('PANE-TC3: dismissal survives the commander fallback', () => {
  // The subtle half. detailCard falls back to the commander when nothing is
  // selected, so clearing the selection alone would close the pane and
  // instantly reopen it on the commander -- a close button that visibly does
  // nothing. Dismissal has to be its own state, consulted BEFORE the fallback.
  assert.match(deckCode, /const \[detailDismissed, setDetailDismissed\] = useState\(false\)/,
    'dismissal must be its own state');
  const memo = deckCode.slice(deckCode.indexOf('const detailCard = useMemo'),
                              deckCode.indexOf('}, [isDesktop'));
  assert.match(memo, /if \(detailDismissed\) return null;/,
    'the memo must return null when dismissed');
  const fallbackAt = memo.indexOf('board === \'commander\'');
  const dismissAt = memo.indexOf('detailDismissed');
  assert.ok(dismissAt < fallbackAt,
    'the dismissal check must come BEFORE the commander fallback, or the '
    + 'fallback reopens the pane the user just closed');
  assert.match(deckCode, /\}, \[isDesktop, selectedCardId, cards, detailDismissed\]\)/,
    'and the memo must recompute when it changes');
});

test('PANE-TC4: tapping the open card closes it, on BOTH screens', () => {
  // Zach chose "Both -- X button and click-again". Each screen owns its own
  // selection state, so this is two implementations by necessity -- but each
  // must be a single named function, not inlined at each tap site, or the
  // grid and the list drift.
  assert.match(deckCode, /const selectDeckCard = \(id\) => \{/,
    'the deck view needs one named selection function');
  assert.match(collCode, /const openInspector = \(card\) => \{/,
    'the collection needs one named selection function');

  // AND EVERY TAP SITE MUST GO THROUGH IT. A second call site still calling
  // the raw setter is how one list toggles and the other does not.
  const deckTaps = deckCode.match(/setSelectedCardId\(/g) || [];
  assert.equal(deckTaps.length, 2,
    'setSelectedCardId may only appear in useState and inside selectDeckCard/onClose');

  // ASSERT THE RULE, NOT A HEADCOUNT.
  //
  // Two earlier versions of this were wrong in opposite directions. The first
  // pattern-matched the handler (`onClick=\{[^}]*setInspectorCard`) and could
  // never fail, because the handler contains `}` before reaching the call. The
  // second counted call sites and was brittle: the number depends on how many
  // uses survive comment-stripping, so it broke without any behaviour changing.
  //
  // What actually matters is narrow: the raw setter must not appear inside a
  // TAP HANDLER. Slice each tap site out and assert on that, which is the
  // thing the rule is about.
  const tapSites = [...collCode.matchAll(/onClick=\{\(e\) => \{([\s\S]*?)\n\s{14}\}\}/g)]
    .map(m => m[1]);
  assert.ok(tapSites.length >= 2,
    `expected both tap handlers (grid tile and list row), found ${tapSites.length}`);
  for (const [i, body] of tapSites.entries()) {
    assert.match(body, /openInspector\(card\)/,
      `tap site ${i + 1} must open through the shared toggle`);
    assert.doesNotMatch(body, /setInspectorCard\(/,
      `tap site ${i + 1} must not call the raw setter -- that is how the grid `
      + 'and the list end up toggling differently');
  }
});

test('PANE-TC5: the flip toggle is off the artwork', () => {
  // It was absolutely positioned inside .ci-image-wrap, and its label is the
  // other face's full name ("The Sensational She-Hulk") -- so the control for
  // looking at the card covered the card.
  const imageCol = inspCode.slice(inspCode.indexOf('ci-image-wrap'),
                                  inspCode.indexOf('ci-info-col'));
  assert.doesNotMatch(imageCol, /setShowBack/,
    'the flip control must not live inside the image column');
  // And it must still EXIST, below the identity line, or this "fix" just
  // deleted the ability to see the back of a card.
  const head = inspCode.slice(inspCode.indexOf('ci-head'), inspCode.indexOf('ci-tabs'));
  assert.match(head, /onClick=\{\(\) => setShowBack\(v => !v\)\}/,
    'the flip control must render in the header, under the identity line');
  assert.match(head, /view\.back_image_url && \(/,
    'and only when there IS a second face');
});

test('PANE-TC6: other printings is a disclosure, closed by default', () => {
  assert.match(inspCode, /<details className="ci-printings">/,
    'must be a <details> element');
  // `open` is what would make it default-open. Its ABSENCE is the requirement,
  // so assert it rather than trusting the element's default.
  assert.doesNotMatch(inspCode, /<details className="ci-printings" open/,
    'it must default CLOSED');
  assert.match(inspCode, /className="ci-printings-list"/,
    'the list needs its own class so only it can be made scrollable');
});

test('PANE-TC7: the panel has exactly ONE scroller', () => {
  // Zach: "there is a double scroll which isnt right. Also the gray pane is
  // going past the end of the screen."
  //
  // Four attempts to CAP the printings list all failed, each differently:
  // max-height:28vh overhung by 117px; flex:1 1 auto expanded the body to
  // 459px; flex:1 1 0 collapsed the list to 2px; max-height:100% was ignored
  // against an auto-height ancestor.
  //
  // One cause underneath: a <details> element does not contain its children's
  // height. Measured -- DETAILS height 58, scrollHeight 374, its child laid
  // out OUTSIDE it. Every height below that point resolved against a box that
  // bounded nothing.
  //
  // So the list does not scroll at all. .ci-scroll is the single scroller, it
  // is bounded by the panel, and the sticky footer keeps Edit Card reachable
  // regardless of length. Verified: scrollersInPanel === ["ci-scroll"].
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

  const at = cssCode.indexOf('\n.ci-printings-list {');
  assert.ok(at > 0, 'the printings list must still have a rule');
  const block = cssCode.slice(at, cssCode.indexOf('}', at));

  // A SECOND SCROLLER IS THE BUG. Either property re-creates it.
  assert.doesNotMatch(block, /overflow-y:\s*(auto|scroll)/,
    'the printings list must NOT scroll -- .ci-scroll is the only scroller, '
    + 'and a second one is the double scrollbar he reported');
  assert.doesNotMatch(block, /max-height/,
    'and must NOT be capped: every cap either overhung the panel or collapsed '
    + 'the list, because <details> does not bound its children');

  // The body wrapper must not clip either: the list is longer than the panel
  // BY DESIGN and scrolls with the body. Clipping it here hides rows the body
  // can no longer reach.
  const bodyAt = cssCode.indexOf('\n.ci-printings-body {');
  assert.ok(bodyAt > 0, 'the body wrapper must exist');
  const bodyBlock = cssCode.slice(bodyAt, cssCode.indexOf('}', bodyAt));
  assert.doesNotMatch(bodyBlock, /overflow:\s*hidden/,
    'clipping the body makes printings unreachable');

  // AND NO INLINE overflow ON THE ELEMENT. An inline style cannot be
  // overridden by a stylesheet: `overflow: 'hidden'` in the style prop beat
  // the rule outright and the list could never be sized at all.
  const listTag = inspCode.slice(inspCode.indexOf('className="ci-printings-list"'),
                                 inspCode.indexOf('className="ci-printings-list"') + 260);
  assert.doesNotMatch(listTag, /overflow:/,
    'the list must not set overflow inline -- it silently beats the stylesheet');
});

test('PANE-TC8: Edit Card and Buy are anchored, not scrolled to', () => {
  // ANCHORED ON BOTH SURFACES, which is the whole point.
  //
  // This used to assert `.card-inspector-inline .ci-footer-acts` -- the
  // DESKTOP-scoped rule -- and passed while the phone modal had no anchoring
  // at all. Zach reported it from his phone: "Edit card doesn't anchor to the
  // bottom when I expand printings".
  //
  // Width-scoping a shared rule with nothing on the other side is this
  // codebase's most frequent layout bug, and a test that only checks the side
  // that works is how it survives. So this asserts the rule is UNSCOPED.
  // STRIP COMMENTS BEFORE ASSERTING ABSENCE.
  //
  // My first version searched the raw stylesheet and matched the phrase inside
  // the comment that EXPLAINS why the rule was un-scoped -- the "matched a word
  // in a comment instead of the code" failure this project has hit before. An
  // absence assertion has to look at code only.
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(cssCode.indexOf('.card-inspector-inline .ci-footer-acts'), -1,
    'the footer rule must NOT be scoped to the desktop pane -- the phone '
    + 'modal renders the same markup and needs the same anchoring');

  const at = cssCode.indexOf('\n.ci-footer-acts {');
  assert.ok(at > 0, 'there must be an unscoped .ci-footer-acts rule');
  const block = cssCode.slice(at, cssCode.indexOf('}', at));
  assert.match(block, /position: sticky/, 'the footer must be sticky');
  assert.match(block, /bottom: 0/, 'pinned to the bottom of its scroll box');
  // Content scrolls UNDER it; a see-through destructive button with rules text
  // sliding behind it is how you misread which card you are deleting.
  assert.match(block, /background:/, 'and must be opaque');

  // IT MUST BE INSIDE THE SCROLLER TO STICK. position:sticky against an
  // ancestor that does not scroll simply does nothing -- silently.
  // Sliced from the SAME comment-stripped source; mixing the two gave an
  // offset from one string and content from the other.
  const scrollAt = cssCode.indexOf('.card-inspector .ci-scroll {');
  assert.ok(scrollAt > 0, 'the modal must have a scrolling body');
  assert.match(cssCode.slice(scrollAt, cssCode.indexOf('}', scrollAt)),
    /overflow-y: auto/,
    'the modal body must be the scroll container the footer sticks within');

  const actions = inspCode.slice(inspCode.indexOf("t('inspector.editCard')") - 2000,
                                 inspCode.indexOf("t('inspector.editCard')") + 200);
  assert.match(actions, /className="ci-footer-acts"/,
    'Edit Card must live inside the anchored footer');
});

test('PANE-TC8b: the Value row is the price, the condition, and a shop BADGE', () => {
  // Zach, first: "why is 152 in stock floating at the bottom and the item
  // price no shipping is awkwardly floating there as well". I attached both to
  // the Value row -- which fixed the floating, and produced "$22.75 · Mana
  // Pool LP · 10 in stock · item price, before shipping": four facts in a
  // run-on string that wrapped to two lines at 390px.
  //
  // Then: "the value section is to long winded. I think just saying the price
  // and quality is good enough. You could maybe put a badge on it like mana
  // pool or card kingdom."
  //
  // So the row is now PRICE + CONDITION, with the shop as a badge. Stock and
  // the shipping caveat are gone entirely: stock is visible where you buy, and
  // "before shipping" is true of every price Bindarr shows, so repeating it on
  // every row taught nothing.
  assert.doesNotMatch(inspCode, /marginTop: '-0\.5rem', marginBottom: '0\.85rem'/,
    'the floating item-price caption must be gone, not merely moved');

  const valueRow = inspCode.slice(inspCode.indexOf("[t('inspector.value')"),
                                  inspCode.indexOf("t('inspector.availableToUse')"));

  // The two facts that stay, checked independently -- an earlier version
  // asserted a pair and one masked the other when only one broke.
  assert.match(valueRow, /price_condition/,
    'the condition must render with the price: it decides whether the number '
    + 'is worth acting on at his LP floor');
  assert.match(valueRow, /borderRadius: 999/,
    'the shop must render as a pill badge, not another word in the sentence');
  assert.match(valueRow, /price_source_label/,
    'and the badge must name the shop the price came from');

  // The two that must NOT come back on this row.
  assert.doesNotMatch(valueRow, /inspector\.inStock/,
    'stock must not be on the Value row -- it is visible where you buy');
  assert.doesNotMatch(valueRow, /inspector\.itemPrice/,
    'the shipping caveat must not be on the Value row -- it is true of every '
    + 'price shown, so stating it per-row is noise');
});

test('PANE-TC9: Buy on Mana Pool sits beside Edit Card, not full-width mid-scroll', () => {
  // It was a full-width <a> with marginBottom, rendered mid-body.
  assert.doesNotMatch(inspCode, /gap: '0\.4rem', width: '100%', marginBottom: '0\.85rem'/,
    'the old full-width buy button must be gone, not merely moved');
  const footer = inspCode.slice(inspCode.indexOf('className="ci-footer-acts"'));
  assert.match(footer.slice(0, 3000), /href=\{thisPrinting\.price_url\}/,
    'the buy link must render inside the anchored footer');
  // A dead buy button is worse than none: the URL must come from the
  // marketplace, never be constructed from set code and number.
  assert.match(inspCode, /\{thisPrinting\?\.price_url && \(/,
    'and only when the marketplace actually returned a URL');
});

test('PANE-TC10: both panes pass the same close contract', () => {
  // Requirement 7 in one assertion: whatever else differs between the two
  // wrappers, closing must work identically. Both must pass a handler that
  // really clears their own selection state.
  assert.match(collCode, /onClose=\{\(\) => setInspectorCard\(null\)\}/,
    'the collection pane closes by clearing its selection');
  assert.match(deckCode, /setDetailDismissed\(true\)/,
    'the deck pane closes by clearing its selection and dismissing');
});
