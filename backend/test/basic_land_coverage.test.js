// BASIC LANDS POOL ON THE CARD-DETAIL SCREEN TOO.
//
// Zach, with the Island sheet open: "I have islands in all 4 of my decks and
// only one is showing owned which isn't right?"
//
// Measured on his dev data at the time: 73 Islands across 25 printings, four
// decks wanting 24 Islands in total -- every one of them coverable. The screen
// said three decks were "Not owned" and reported "Reserved by decks: 4".
//
// THE CAUSE WAS TWO IMPLEMENTATIONS OF ONE QUESTION. deckIdentity pooled
// basics by name; GET /card/:cardId/decks had its own per-printing coverage
// loop and never called it. His decks want MSH #289, TRK #319 and J25 #86, and
// he happened to hold 4 of MSH #289 -- so exactly the one deck whose exact
// printing he owned read "Covered".
//
// The damning detail is that the AVAILABILITY panel on the same screen, fed by
// the oracle-wide total, said 69 free. One screen, two numbers, no way for the
// user to tell which was lying. That is the failure this file guards against.
//
// These cases test the ARITHMETIC as a pure function of the same shapes the
// route builds, so they can state the real numbers rather than assert on
// source text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../src/routes/collection.js'), 'utf8');

// The route's rule, as a function. Mirrors the shipped shape closely enough to
// state the numbers; COV-TC5 below pins the route to the shared predicate so
// this mirror cannot quietly diverge on the part that actually broke.
function coverage({ typeLine, name, owned, wants }) {
  const isBasic = String(typeLine || '').startsWith('Basic Land');
  const key = (cardId, finish) => isBasic ? `basic|${name}` : `${cardId}|${finish}`;

  const pool = new Map();
  for (const o of owned) {
    const k = key(o.card_id, o.finish);
    pool.set(k, (pool.get(k) || 0) + o.n);
  }

  const out = wants.map(w => {
    const k = key(w.desired_card_id, w.desired_finish);
    const have = pool.get(k) || 0;
    const covered = have >= w.quantity;
    if (covered) pool.set(k, have - w.quantity);
    return { deck: w.deck, covered };
  });

  const totalOwned = owned.reduce((n, o) => n + o.n, 0);
  const totalWanted = wants.reduce((n, w) => n + w.quantity, 0);
  const reserved = isBasic
    ? Math.min(totalOwned, totalWanted)
    : owned.reduce((n, o) => {
        const claimed = wants
          .filter(w => w.desired_card_id === o.card_id && w.desired_finish === o.finish)
          .reduce((m, w) => m + w.quantity, 0);
        return n + Math.min(o.n, claimed);
      }, 0);

  return { rows: out, reserved, free: totalOwned - reserved };
}

// HIS ACTUAL DATA, read off the dev database on 2026-09-23. Real numbers, so a
// regression reproduces the exact screen he photographed rather than a
// plausible-looking toy case.
const ISLANDS = {
  typeLine: 'Basic Land — Island',
  name: 'Island',
  owned: [
    { card_id: 'tmt-254', finish: 'nonfoil', n: 13 },
    { card_id: 'lci-395', finish: 'nonfoil', n: 7 },
    { card_id: 'msh-290', finish: 'nonfoil', n: 6 },
    { card_id: 'lci-396', finish: 'nonfoil', n: 6 },
    { card_id: 'dft-282', finish: 'nonfoil', n: 5 },
    { card_id: 'hob-190', finish: 'nonfoil', n: 5 },
    { card_id: 'msh-289', finish: 'nonfoil', n: 4 },
    { card_id: 'dft-281', finish: 'nonfoil', n: 4 },
    { card_id: 'kld-254', finish: 'nonfoil', n: 3 },
    { card_id: 'msh-280', finish: 'nonfoil', n: 3 },
    { card_id: 'hob-195', finish: 'nonfoil', n: 2 },
    { card_id: 'tmt-192', finish: 'nonfoil', n: 2 },
    { card_id: 'hob-195', finish: 'foil',    n: 1 },
    { card_id: 'hob-190', finish: 'foil',    n: 1 },
    // the remaining singles, collapsed -- 11 more printings at 1 each
    ...Array.from({ length: 11 }, (_, i) => ({ card_id: `x-${i}`, finish: 'nonfoil', n: 1 })),
  ],
  wants: [
    { deck: 'I Am Iron Man', desired_card_id: 'msh-289', desired_finish: 'nonfoil', quantity: 10 },
    { deck: 'Ur-Dragon',     desired_card_id: 'msh-289', desired_finish: 'nonfoil', quantity: 3 },
    { deck: 'Sokka',         desired_card_id: 'trk-319', desired_finish: 'nonfoil', quantity: 7 },
    { deck: 'Doctor Doom',   desired_card_id: 'j25-86',  desired_finish: 'nonfoil', quantity: 4 },
  ],
};

test('COV-TC1: the reported screen - all four Island decks are covered', () => {
  const { rows } = coverage(ISLANDS);
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.equal(r.covered, true, `${r.deck} must be covered: he owns 73 Islands`);
  }
});

test('COV-TC2: reserved counts every claimed Island, not just matching printings', () => {
  // The screen said 4 -- the count of MSH #289 he happens to hold. The true
  // figure is every Island his decks have claimed.
  const { reserved, free } = coverage(ISLANDS);
  assert.equal(reserved, 24, 'four decks claim 24 Islands between them');
  assert.equal(free, 49, '73 owned minus 24 reserved');
});

test('COV-TC3: a basic can still be SHORT, and the pool is what decides', () => {
  // Pooling must not degrade into "basics are always covered", which would
  // hide a genuine shortfall -- the opposite failure, and the more expensive
  // one because it sends him to a game with a deck he cannot build.
  const short = {
    typeLine: 'Basic Land — Mountain', name: 'Mountain',
    owned: [{ card_id: 'mh2-250', finish: 'nonfoil', n: 5 }],
    wants: [
      { deck: 'A', desired_card_id: 'mh2-250', desired_finish: 'nonfoil', quantity: 4 },
      { deck: 'B', desired_card_id: 'lci-290', desired_finish: 'nonfoil', quantity: 4 },
    ],
  };
  const { rows, reserved } = coverage(short);
  assert.equal(rows[0].covered, true,  'the first claim takes from the pool');
  assert.equal(rows[1].covered, false, 'only 1 left, so the second deck is short');
  assert.equal(reserved, 5, 'he cannot reserve more Mountains than he owns');
});

test('COV-TC4: a FOIL basic still fills the slot', () => {
  // A foil Island taps for blue. Keeping finish in the key would leave a deck
  // short while a card that fills it sits in the binder.
  const foils = {
    typeLine: 'Basic Land — Island', name: 'Island',
    owned: [{ card_id: 'hob-195', finish: 'foil', n: 4 }],
    wants: [{ deck: 'A', desired_card_id: 'msh-289', desired_finish: 'nonfoil', quantity: 4 }],
  };
  assert.equal(coverage(foils).rows[0].covered, true);
});

test('COV-TC5: a NON-basic still needs its exact printing', () => {
  // The rule this endpoint was originally built for, and it must survive.
  // Zach: "I own this card in 2XM #58 but it doesn't show here". A BRC #87
  // requirement is NOT covered by an owned 2XM #58 -- different objects at
  // very different prices.
  const solRing = {
    typeLine: 'Artifact', name: 'Sol Ring',
    owned: [{ card_id: '2xm-58', finish: 'nonfoil', n: 1 }],
    wants: [{ deck: 'A', desired_card_id: 'brc-87', desired_finish: 'nonfoil', quantity: 1 }],
  };
  const { rows, reserved } = coverage(solRing);
  assert.equal(rows[0].covered, false, 'a different printing does not cover it');
  assert.equal(reserved, 0, 'and nothing is reserved against a card he does not hold');
});

test('COV-TC6: the route imports the SHARED rule instead of re-deciding', () => {
  // THE ACTUAL CAUSE. The arithmetic above is only right while the route and
  // deckIdentity agree on what a basic IS. They disagreed by having two
  // definitions; a third copy here would rebuild the same bug.
  assert.match(src, /const \{ isBasicLandTypeLine \} = require\('\.\.\/utils\/deckIdentity'\)/,
    'the route must import the basic-land rule from deckIdentity');
  assert.match(src, /const isBasic = isBasicLandTypeLine\(card\.type_line\)/,
    'and decide with it, from the CATALOGUE type line');
  // The name is the weaker test the shared rule exists to prevent: "Mountain"
  // is also a creature type, and Snow-Covered Mountain contains the word.
  assert.doesNotMatch(src, /const isBasic = .*card\.name/,
    'never from the card name');
});

test('COV-TC7: the coverage key and the reserved total use the SAME rule', () => {
  // The screen's contradiction was per-deck rows and the availability panel
  // computed two different ways. Whatever the key does, the total must follow.
  assert.match(src, /variantKey\(r\.desired_card_id, r\.desired_finish, card\.name\)/,
    'the per-deck rows must go through variantKey');
  assert.match(src, /const reservedOwned = isBasic/,
    'and the reserved total must branch on the same isBasic');
});
