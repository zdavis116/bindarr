// The deck-view footer: Remove from deck, and Buy only when he is short.
//
// Zach: "Remove from deck should be like the edit button and buy on mana pool
// should only show for cards that are missing when in deck view because why
// would I want to buy a card I already own for a deck."
//
// NOTE ON VERIFICATION. The "missing card" path cannot be exercised against
// dev data: Zach owns every card in all four of his decks, so every deck row
// is covered. These assertions therefore test the RULE in the source, and the
// covered path was confirmed on the live deck view (Doctor Doom, Yours tab:
// one "Remove from deck" button, no Buy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const insp = strip(readFileSync(
  join(repo, 'frontend/src/components/CardInspectorModal.jsx'), 'utf8'));

test('DVF-TC1: buy is hidden for a deck card he already has', () => {
  // The gate must consider BOTH facts: that we are in a deck (onRemoveFromDeck
  // is only passed from the deck view) and that the slot is filled.
  assert.match(insp, /!\(onRemoveFromDeck && deckCovered\)/,
    'buy must be hidden when a deck slot is already covered');

  // AND STILL REQUIRE A REAL URL. A dead buy button is worse than none; the
  // new condition must be added to that check, not replace it.
  assert.match(insp, /thisPrinting\?\.price_url &&[^)]*onRemoveFromDeck && deckCovered/,
    'the URL requirement must survive alongside the covered check');
});

test('DVF-TC2: "covered" is read from the deck list, not recomputed', () => {
  // The same question answered in two places is this codebase's most repeated
  // bug -- four Curve-tab bugs traced to exactly that. The Decks tab renders
  // `d.covered`; the buy button must read the SAME field for the SAME deck,
  // or the button and the row above it can disagree about whether he is short.
  const decl = insp.slice(insp.indexOf('const deckCovered'));
  assert.match(decl.slice(0, 300), /deckUse\?\.decks \|\| \[\]/,
    'deckCovered must come from the deck list the Decks tab renders');
  assert.match(decl.slice(0, 300), /d\.deck_name === deckName/,
    'and must match THIS deck by name, not any deck');
  assert.match(decl.slice(0, 300), /d\.covered/,
    'reusing the covered flag rather than recomputing ownership');

  // No second ownership calculation anywhere near it.
  assert.doesNotMatch(decl.slice(0, 300), /ownedCopies|quantity_available/,
    'deckCovered must not recompute ownership from quantities');
});

test('DVF-TC3: an unknown deck shows the buy button rather than hiding it', () => {
  // Boolean() with a deckName guard: when the deck is not in the list the
  // result is false, so buy SHOWS. Hiding an action wrongly removes it
  // silently; showing it wrongly costs a glance. The safer default is the one
  // that keeps the action reachable.
  const decl = insp.slice(insp.indexOf('const deckCovered'), 
                          insp.indexOf('const deckCovered') + 300);
  assert.match(decl, /Boolean\(\s*\n?\s*deckName/,
    'deckCovered must be false without a deck name, so buy stays visible');
});

test('DVF-TC4: remove-from-deck renders ONCE in the footer, not as a second bar', () => {
  // It used to render twice as a FULL-WIDTH BAR: once in the footer action row
  // and once as a separate danger bar below it -- two stacked footers
  // competing for the same job, which is what Zach photographed.
  //
  // COUNTING HANDLERS IS TOO BLUNT. There is a legitimate second caller: the
  // small trash icon on the matching row of the Decks tab, which removes the
  // card from the deck it names. That is a different affordance in a different
  // place, not a duplicate footer, and a raw count of
  // `onClick={handleRemoveFromDeck}` condemns it. Call-site counts are brittle
  // and blind to substitutions -- assert the SHAPE instead.
  const footerAt = insp.indexOf('className="ci-footer-acts"');
  assert.ok(footerAt > 0, 'there must be an anchored footer row');

  // Exactly one FULL-WIDTH remove button may exist, and it must not be one.
  const fullWidthRemoves = [...insp.matchAll(
    /width: '100%'[\s\S]{0,200}?onClick=\{handleRemoveFromDeck\}/g)];
  assert.equal(fullWidthRemoves.length, 0,
    'the standalone full-width remove bar must be gone, not merely moved');

  // The footer's remove button FLEXES like Edit Card. Zach: "Remove from deck
  // should be like the edit button." In the deck view readOnly hides Edit, so
  // this is the primary action and absorbs the spare width, with buy small
  // beside it.
  const footer = insp.slice(footerAt, footerAt + 2500);
  assert.match(footer, /onClick=\{handleRemoveFromDeck\}/,
    'remove-from-deck must live inside the anchored footer row');
  const btnStart = footer.lastIndexOf('<button', footer.indexOf('handleRemoveFromDeck'));
  assert.match(footer.slice(btnStart, footer.indexOf('handleRemoveFromDeck')), /flex: 1/,
    'and must flex like Edit Card, not be a fixed-width chip');
});
