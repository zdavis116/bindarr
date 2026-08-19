// PR 7: the buylist — missing cards made shoppable.
//
// Every case drives the REAL HTTP routes against a REAL database, and asserts
// on the VALUES THE USER WOULD SEE (names, set codes, collector numbers,
// finishes, quantities) rather than on a status code. That is the standing
// lesson of PR 6E/6F: a green suite that only checks 200s hid two real bugs.
//
// Direct SQL appears only for FIXTURES (seeding card_cache, creating users).
// The thing under test is always reached through a route.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-pr7-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';

const db = require('../../src/db');
const deckRoutes = require('../../src/routes/decks');
const collectionRoutes = require('../../src/routes/collection');

let base;

async function api(token, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* empty body */ }
  return { status: response.status, body: payload };
}

async function createUser(username) {
  const inserted = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, 'member', ?)`,
    [username, db.hashPassword('test-only-password'), `share-${username}-${process.pid}`]
  );
  const token = `${username}-${process.pid}`;
  await db.run(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
    [token, inserted.lastID, new Date(Date.now() + 600_000).toISOString()]
  );
  return { id: inserted.lastID, token };
}

// --- Fixtures ---------------------------------------------------------------
//
// Two PRINTINGS of one Oracle card (Sol Ring) exist on purpose. The whole
// printing-exactness rule is only testable when the app has a wrong printing
// available to substitute in.
const CARDS = [
  {
    id: 'pr7-solring-c21', oracle_id: 'pr7-o-solring', name: 'Sol Ring',
    set_id: 'c21', set_name: 'Commander 2021', number: '263',
    type_line: 'Artifact', colour: [], finishes: ['nonfoil', 'foil']
  },
  {
    id: 'pr7-solring-cmm', oracle_id: 'pr7-o-solring', name: 'Sol Ring',
    set_id: 'cmm', set_name: 'Commander Masters', number: '410',
    type_line: 'Artifact', colour: [], finishes: ['nonfoil', 'foil', 'etched']
  },
  {
    id: 'pr7-bolt', oracle_id: 'pr7-o-bolt', name: 'Lightning Bolt',
    set_id: '2x2', set_name: 'Double Masters 2022', number: '117',
    type_line: 'Instant', colour: ['R'], finishes: ['nonfoil', 'foil']
  },
  {
    id: 'pr7-counterspell', oracle_id: 'pr7-o-counterspell', name: 'Counterspell',
    set_id: 'mh2', set_name: 'Modern Horizons 2', number: '267',
    type_line: 'Instant', colour: ['U'], finishes: ['nonfoil']
  },
  {
    id: 'pr7-brainstorm', oracle_id: 'pr7-o-brainstorm', name: 'Brainstorm',
    set_id: 'mh2', set_name: 'Modern Horizons 2', number: '272',
    type_line: 'Instant', colour: ['U'], finishes: ['nonfoil']
  },
  // The commander. Grixis-ish identity so every other fixture card is castable.
  {
    id: 'pr7-commander', oracle_id: 'pr7-o-commander', name: 'Test Commander',
    set_id: 'c21', set_name: 'Commander 2021', number: '1',
    type_line: 'Legendary Creature — Test', colour: ['U', 'R'],
    finishes: ['nonfoil']
  }
];

async function seedCards() {
  for (const card of CARDS) {
    await db.run(
      `INSERT OR REPLACE INTO card_cache
        (id, oracle_id, name, supertype, subtypes, types, rarity, set_id, set_name,
         number, image_url, type_line, cmc, color_identity, legalities, finishes, last_updated)
       VALUES (?, ?, ?, 'MTG', '[]', '[]', 'Rare', ?, ?, ?, '', ?, 1, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        card.id, card.oracle_id, card.name, card.set_id, card.set_name, card.number,
        card.type_line, JSON.stringify(card.colour),
        JSON.stringify({ commander: 'legal' }), JSON.stringify(card.finishes)
      ]
    );
  }
}

// Own copies through the REAL add route. The collection write path applies
// finish canonicalisation and a CHECK constraint a direct INSERT bypasses.
async function ownCopies(token, cardId, finish, quantity) {
  const response = await api(token, '/api/collection', {
    method: 'POST',
    body: { card_id: cardId, finish, quantity }
  });
  assert.strictEqual(response.status, 200,
    `setup: owning ${quantity}x ${cardId} (${finish}) must succeed: ${JSON.stringify(response.body)}`);
  return response.body.id;
}

// MODERN BY DEFAULT, Commander only where the command zone is the point.
//
// This is a fixture decision with a real reason: Commander is singleton BY
// NAME, so a Commander deck legitimately refuses "2x Lightning Bolt". Most
// buylist cases are about QUANTITY shortfalls, which need a format that allows
// playsets. Forcing them all into Commander would have meant testing the
// buylist only at quantity 1 — the case least likely to expose an arithmetic
// error.
async function createDeck(token, name, { format = 'Modern' } = {}) {
  const commander = /commander|edh/i.test(format);
  const response = await api(token, '/api/decks', {
    method: 'POST',
    body: {
      name,
      format,
      ...(commander
        ? { commanders: [{ desired_card_id: 'pr7-commander', desired_finish: 'nonfoil' }] }
        : {})
    }
  });
  assert.strictEqual(response.status, 201,
    `setup: creating deck ${name} must succeed: ${JSON.stringify(response.body)}`);
  return response.body.id;
}

async function addCard(token, deckId, cardId, finish, quantity, board = 'mainboard') {
  const response = await api(token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: { desired_card_id: cardId, desired_finish: finish, quantity, board }
  });
  assert.strictEqual(response.status, 200,
    `setup: adding ${quantity}x ${cardId} (${finish}, ${board}) must succeed: ${JSON.stringify(response.body)}`);
  return response.body;
}

// A stable, human-readable fingerprint of one buylist line. Deliberately
// includes SET and COLLECTOR NUMBER: the printing is the thing under test, so
// a line that identified only the card name would pass a weaker assertion
// while still being the exact defect this feature must not have.
function lineKey(item) {
  return `${item.quantity}x ${item.name} (${item.set_id}) ${item.number} ${item.finish}`;
}

const tests = [];
function test(id, name, fn) { tests.push({ id, name, fn }); }

// EVERY CASE GETS ITS OWN USER, with its own empty collection.
//
// Not a stylistic preference: these tests are about what a user OWNS versus
// what he has committed, so a copy bought in one case would silently satisfy a
// requirement in the next and the suite would report a shortfall as covered.
// That is precisely the failure mode the buylist exists to prevent, so the
// suite must not be able to produce it by accident. A fresh user per case also
// keeps deck_cards.id ordering — which drives reservation priority — a
// property of the case rather than of the order the cases happen to run in.
let userSeq = 0;
async function freshUser() {
  userSeq += 1;
  return createUser(`pr7user${userSeq}`);
}

// ---------------------------------------------------------------------------

// F7-TC1: the core promise. A shortfall of an EXACT printing and finish is
// what appears, at the quantity actually short.
test('F7-TC1', 'a buylist lists exact printing + finish shortages', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'TC1 Deck');
  // Owns 1 of the C21 Sol Ring; the deck wants 1 of the CMM one. Owning "a Sol
  // Ring" must NOT satisfy a requirement for a different printing.
  await ownCopies(owner.token, 'pr7-solring-c21', 'nonfoil', 1);
  await addCard(owner.token, deckId, 'pr7-solring-cmm', 'nonfoil', 1);
  await addCard(owner.token, deckId, 'pr7-bolt', 'foil', 4);
  await ownCopies(owner.token, 'pr7-bolt', 'foil', 1);

  const response = await api(owner.token, `/api/decks/${deckId}/buylist`);
  assert.strictEqual(response.status, 200, JSON.stringify(response.body));

  const keys = response.body.items.map(lineKey).sort();
  assert.deepStrictEqual(keys, [
    '1x Sol Ring (cmm) 410 nonfoil',
    '3x Lightning Bolt (2x2) 117 foil'
  ].sort(), 'the buylist names the exact printing and finish, short by the exact amount');
});

// F7-TC2: the money rule. The app must never substitute a printing the user
// happens to own for the printing they chose.
test('F7-TC2', 'an owned DIFFERENT printing never satisfies the requirement', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'TC2 Deck');
  await ownCopies(owner.token, 'pr7-solring-c21', 'nonfoil', 4);
  await addCard(owner.token, deckId, 'pr7-solring-cmm', 'nonfoil', 1);

  const response = await api(owner.token, `/api/decks/${deckId}/buylist`);
  const solRings = response.body.items.filter(i => i.name === 'Sol Ring');
  assert.strictEqual(solRings.length, 1, 'the chosen printing is still needed');
  assert.strictEqual(solRings[0].desired_card_id, 'pr7-solring-cmm',
    'the buylist names the printing the user CHOSE, never a cheaper/owned substitute');
  assert.strictEqual(solRings[0].set_id, 'cmm');
  assert.strictEqual(solRings[0].number, '410');
});

// F7-TC3: the same rule for FINISH. A nonfoil copy does not buy a foil slot.
test('F7-TC3', 'an owned copy in the wrong FINISH never satisfies the requirement', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'TC3 Deck');
  await ownCopies(owner.token, 'pr7-counterspell', 'nonfoil', 3);
  await addCard(owner.token, deckId, 'pr7-counterspell', 'nonfoil', 1);
  await addCard(owner.token, deckId, 'pr7-solring-cmm', 'foil', 2);

  const response = await api(owner.token, `/api/decks/${deckId}/buylist`);
  const keys = response.body.items.map(lineKey);
  assert.deepStrictEqual(keys, ['2x Sol Ring (cmm) 410 foil'],
    'the foil slot is still short; the satisfied nonfoil Counterspell is absent');
});

// F7-TC4: NEVER list owned surplus. Owning more than the deck needs must not
// produce a line, and must never produce a negative or zero quantity.
test('F7-TC4', 'owned surplus copies are never listed', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'TC4 Deck');
  await ownCopies(owner.token, 'pr7-brainstorm', 'nonfoil', 10);
  await addCard(owner.token, deckId, 'pr7-brainstorm', 'nonfoil', 2);

  const response = await api(owner.token, `/api/decks/${deckId}/buylist`);
  const brainstorms = response.body.items.filter(i => i.name === 'Brainstorm');
  assert.deepStrictEqual(brainstorms, [],
    'a card owned in surplus is not something to buy, so it must not appear at all');
  assert.ok(response.body.items.every(i => i.quantity > 0),
    'every buylist line is a positive number of cards to buy');
});

// F7-TC5: THE cross-deck case, and the reason the buylist cannot be computed
// from raw ownership. A card he OWNS but has fully committed to another saved
// deck IS something he still has to buy for this one.
test('F7-TC5', 'a card owned but fully committed to another deck IS listed', async ({ owner }) => {
  const firstDeck = await createDeck(owner.token, 'TC5 First Deck');
  const secondDeck = await createDeck(owner.token, 'TC5 Second Deck');
  await ownCopies(owner.token, 'pr7-bolt', 'nonfoil', 2);

  // The FIRST deck claims both copies (lower deck_cards.id = higher priority).
  await addCard(owner.token, firstDeck, 'pr7-bolt', 'nonfoil', 2);
  await addCard(owner.token, secondDeck, 'pr7-bolt', 'nonfoil', 2);

  const first = await api(owner.token, `/api/decks/${firstDeck}/buylist`);
  assert.deepStrictEqual(first.body.items.filter(i => i.name === 'Lightning Bolt'), [],
    'the deck that holds the copies needs nothing');

  const second = await api(owner.token, `/api/decks/${secondDeck}/buylist`);
  const bolts = second.body.items.filter(i => i.name === 'Lightning Bolt');
  assert.strictEqual(bolts.length, 1);
  assert.strictEqual(bolts[0].quantity, 2,
    'both copies are sleeved in another deck, so both must still be bought');
  assert.strictEqual(bolts[0].quantity_owned, 2,
    'and the line is honest that he DOES own two — they are just not free');
});

// F7-TC6: considering is excluded by default and reported separately. It never
// reserves and is not part of the deck, so it is not something to buy today.
test('F7-TC6', 'considering entries are excluded from the buylist and shown separately', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'TC6 Deck');
  await addCard(owner.token, deckId, 'pr7-counterspell', 'nonfoil', 1, 'mainboard');
  await addCard(owner.token, deckId, 'pr7-brainstorm', 'nonfoil', 3, 'considering');

  const response = await api(owner.token, `/api/decks/${deckId}/buylist`);
  const buyNames = response.body.items.map(i => i.name);
  assert.ok(buyNames.includes('Counterspell'), 'the real mainboard shortfall is on the buylist');
  assert.ok(!buyNames.includes('Brainstorm'),
    'a card he is merely CONSIDERING is not something the buylist tells him to buy');

  const considering = response.body.considering;
  assert.strictEqual(considering.length, 1, 'but it is still reported, in its own section');
  assert.strictEqual(considering[0].name, 'Brainstorm');
  assert.strictEqual(considering[0].quantity, 3,
    'with the number he would need if he decided to include it');
});

// F7-TC7: commander and sideboard shortfalls are actionable and included by
// default — they are real cards in a real deck.
test('F7-TC7', 'commander and sideboard shortfalls are included by default', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'TC7 Deck', { format: 'Commander / EDH' });
  await addCard(owner.token, deckId, 'pr7-counterspell', 'nonfoil', 1, 'sideboard');

  const response = await api(owner.token, `/api/decks/${deckId}/buylist`);
  const boards = response.body.items.map(i => `${i.board}:${i.name}`);
  assert.ok(boards.includes('commander:Test Commander'),
    'an unowned commander is the most actionable card in the deck');
  assert.ok(boards.includes('sideboard:Counterspell'),
    'sideboard cards are real cards he has to own');
});

// F7-TC8: EXPORT is a different output with different rules. It must still
// contain every planned card, including the ones he does not own — an export
// that silently dropped missing cards would hand a shop or a friend an
// incomplete decklist and look complete doing it.
test('F7-TC8', 'deck export still includes all planned cards including missing ones', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'TC8 Deck');
  await ownCopies(owner.token, 'pr7-brainstorm', 'nonfoil', 4);
  await addCard(owner.token, deckId, 'pr7-brainstorm', 'nonfoil', 4);
  await addCard(owner.token, deckId, 'pr7-counterspell', 'nonfoil', 2); // owns none

  const deck = await api(owner.token, `/api/decks/${deckId}`);
  const names = deck.body.cards.filter(c => c.board !== 'considering').map(c => c.name);
  assert.ok(names.includes('Brainstorm'), 'an owned card is in the deck');
  assert.ok(names.includes('Counterspell'),
    'and so is a MISSING one — export lists what the deck IS, not what he holds');

  const buylist = await api(owner.token, `/api/decks/${deckId}/buylist`);
  const buyNames = buylist.body.items.map(i => i.name);
  assert.ok(!buyNames.includes('Brainstorm'), 'while the buylist holds only the shortfall');
  assert.ok(buyNames.includes('Counterspell'));
});

// F7-TC9: aggregation across several entries of ONE variant must not
// double-count. Two mainboard lines for the same printing+finish are one thing
// to buy.
test('F7-TC9', 'several entries of one variant aggregate into a single honest line', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'TC9 Deck');
  await ownCopies(owner.token, 'pr7-solring-c21', 'foil', 1);
  await addCard(owner.token, deckId, 'pr7-solring-c21', 'foil', 2, 'mainboard');
  await addCard(owner.token, deckId, 'pr7-solring-c21', 'foil', 2, 'sideboard');

  const response = await api(owner.token, `/api/decks/${deckId}/buylist`);
  const solRings = response.body.items.filter(i => i.name === 'Sol Ring' && i.finish === 'foil');
  assert.strictEqual(solRings.length, 1, 'one variant is one line to buy');
  assert.strictEqual(solRings[0].quantity, 3,
    'wants 4 across two boards, owns 1 free copy, so needs exactly 3 — not 1+2 counted twice');
});

// F7-TC10: a deck with nothing missing produces an EMPTY buylist, not a
// buylist of zeroes. A shopping list of things you already own is worse than
// no list.
test('F7-TC10', 'a fully owned deck produces an empty buylist', async ({ owner }) => {
  // Commander format so the command zone is populated: "fully owned" has to
  // include the commander, or the emptiness of the list proves nothing.
  const deckId = await createDeck(owner.token, 'TC10 Deck', { format: 'Commander / EDH' });
  await ownCopies(owner.token, 'pr7-commander', 'nonfoil', 1);
  await ownCopies(owner.token, 'pr7-brainstorm', 'nonfoil', 1);
  await addCard(owner.token, deckId, 'pr7-brainstorm', 'nonfoil', 1);

  const response = await api(owner.token, `/api/decks/${deckId}/buylist`);
  assert.deepStrictEqual(response.body.items, [],
    'nothing is missing, so there is nothing to buy');
  assert.strictEqual(response.body.summary.total_cards, 0);
});

// F7-TC11: another user's deck is not readable. The buylist is a new route and
// gets the same ownership boundary every other deck route has.
test('F7-TC11', 'a buylist for a deck you do not own is refused', async ({ owner, stranger }) => {
  const deckId = await createDeck(owner.token, 'TC11 Private Deck');
  await addCard(owner.token, deckId, 'pr7-counterspell', 'nonfoil', 1);

  const response = await api(stranger.token, `/api/decks/${deckId}/buylist`);
  assert.strictEqual(response.status, 404,
    'a stranger must not be able to read what someone else still needs to buy');
});

// ---------------------------------------------------------------------------
// THE MULTI-DECK BUYLIST (PR 7). He selects the decks; we add up SHORTFALLS.
//
// Zach: "I want a per deck buylist but it would cool to be able to do one as an
// aggregate of all decks in case Im trying to buy for multiple decks at once.
// Actually let me revise that I dont want a per collection per say I want to be
// able to select all the decks I want to make a buy list for."
//
// And the rule that defines the arithmetic: "it should be an aggregate of what
// is MISSING." NOT "what these decks want minus what he owns" — that
// double-counts a single copy wanted by two decks. Each deck already knows its
// own shortfall after reservations, so the aggregate is the SUM OF SHORTFALLS.

// F7-TCA1: HIS WORKED EXAMPLE, exactly as he stated it. Deck 1 has card A,
// deck 2 also wants card A, he owns 1 copy. Deck 1 holds the reservation so its
// shortfall is 0; deck 2 cannot have it so its shortfall is 1. Aggregate = 1,
// NOT 2. Getting this wrong sends him to a shop to buy a card he owns.
test('F7-TCA1', "Zach's worked example: shortfalls add to 1, never to 2", async ({ owner }) => {
  const deck1 = await createDeck(owner.token, 'TCA1 Deck One');
  const deck2 = await createDeck(owner.token, 'TCA1 Deck Two');
  await ownCopies(owner.token, 'pr7-bolt', 'nonfoil', 1);
  await addCard(owner.token, deck1, 'pr7-bolt', 'nonfoil', 1);
  await addCard(owner.token, deck2, 'pr7-bolt', 'nonfoil', 1);

  // Sanity: the two per-deck buylists say 0 and 1. The aggregate must equal
  // their sum, not a fresh calculation from ownership.
  const one = await api(owner.token, `/api/decks/${deck1}/buylist`);
  assert.deepStrictEqual(one.body.items.filter(i => i.name === 'Lightning Bolt'), [],
    'deck 1 holds the reservation, so it needs nothing');
  const two = await api(owner.token, `/api/decks/${deck2}/buylist`);
  assert.strictEqual(two.body.items.find(i => i.name === 'Lightning Bolt').quantity, 1,
    'deck 2 cannot have the copy, so it is short exactly one');

  const response = await api(owner.token, '/api/decks/buylist', {
    method: 'POST', body: { deck_ids: [deck1, deck2] }
  });
  assert.strictEqual(response.status, 200, JSON.stringify(response.body));
  const bolts = response.body.items.filter(i => i.name === 'Lightning Bolt');
  assert.strictEqual(bolts.length, 1, 'one printing+finish is one line');
  assert.strictEqual(bolts[0].quantity, 1,
    'THE defining rule: 0 + 1 = 1. Two decks wanting one owned copy is ONE purchase, not two');
});

// F7-TCA2: it scales the same way. Three decks want it, he owns two, two hold
// reservations: shortfalls 0 + 0 + 1, so buy 1.
test('F7-TCA2', 'the same rule at scale: 0 + 0 + 1 = 1', async ({ owner }) => {
  const decks = [];
  for (const name of ['TCA2 A', 'TCA2 B', 'TCA2 C']) decks.push(await createDeck(owner.token, name));
  await ownCopies(owner.token, 'pr7-bolt', 'nonfoil', 2);
  for (const deckId of decks) await addCard(owner.token, deckId, 'pr7-bolt', 'nonfoil', 1);

  const response = await api(owner.token, '/api/decks/buylist', {
    method: 'POST', body: { deck_ids: decks }
  });
  const bolts = response.body.items.filter(i => i.name === 'Lightning Bolt');
  assert.strictEqual(bolts[0].quantity, 1,
    'owning two of the three needed copies means buying exactly one');
});

// F7-TCA3: selecting ONE deck must equal that deck's own buylist. If the two
// surfaces ever disagree he has no way to know which to trust at the shop —
// which is why the aggregate REUSES buylistForDeck rather than reimplementing.
test('F7-TCA3', 'selecting one deck equals that deck\'s own buylist', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'TCA3 Deck');
  await ownCopies(owner.token, 'pr7-solring-c21', 'foil', 1);
  await addCard(owner.token, deckId, 'pr7-solring-c21', 'foil', 3);
  await addCard(owner.token, deckId, 'pr7-counterspell', 'nonfoil', 2);

  const single = await api(owner.token, `/api/decks/${deckId}/buylist`);
  const multi = await api(owner.token, '/api/decks/buylist', {
    method: 'POST', body: { deck_ids: [deckId] }
  });
  assert.deepStrictEqual(
    multi.body.items.map(lineKey).sort(),
    single.body.items.map(lineKey).sort(),
    'one selected deck is the same shopping trip as that deck alone'
  );
});

// F7-TCA4: TWO PRINTINGS ARE TWO PURCHASES. Deck A wanting the C21 Sol Ring
// and deck B the CMM one are different cards at different prices. Collapsing
// them into "2x Sol Ring" would spend his money on a printing he did not pick.
test('F7-TCA4', 'two decks wanting DIFFERENT printings give TWO lines', async ({ owner }) => {
  const deckA = await createDeck(owner.token, 'TCA4 Deck A');
  const deckB = await createDeck(owner.token, 'TCA4 Deck B');
  await addCard(owner.token, deckA, 'pr7-solring-c21', 'nonfoil', 1);
  await addCard(owner.token, deckB, 'pr7-solring-cmm', 'nonfoil', 1);

  const response = await api(owner.token, '/api/decks/buylist', {
    method: 'POST', body: { deck_ids: [deckA, deckB] }
  });
  const solRings = response.body.items.filter(i => i.name === 'Sol Ring');
  assert.strictEqual(solRings.length, 2,
    'aggregation is by exact printing + finish, NEVER by card name');
  assert.deepStrictEqual(solRings.map(lineKey).sort(), [
    '1x Sol Ring (c21) 263 nonfoil',
    '1x Sol Ring (cmm) 410 nonfoil'
  ].sort());
});

// F7-TCA5: the same rule for FINISH. A foil and a nonfoil of one printing are
// two purchases.
test('F7-TCA5', 'the same printing in two FINISHES gives two lines', async ({ owner }) => {
  const deckA = await createDeck(owner.token, 'TCA5 Deck A');
  const deckB = await createDeck(owner.token, 'TCA5 Deck B');
  await addCard(owner.token, deckA, 'pr7-solring-c21', 'nonfoil', 1);
  await addCard(owner.token, deckB, 'pr7-solring-c21', 'foil', 1);

  const response = await api(owner.token, '/api/decks/buylist', {
    method: 'POST', body: { deck_ids: [deckA, deckB] }
  });
  assert.strictEqual(response.body.items.filter(i => i.name === 'Sol Ring').length, 2);
});

// F7-TCA6: EACH LINE NAMES THE DECKS THAT WANT IT, so he can tell whether
// dropping a deck from the selection changes the line.
test('F7-TCA6', 'each line names the selected decks that want it', async ({ owner }) => {
  const deckA = await createDeck(owner.token, 'TCA6 Aggro');
  const deckB = await createDeck(owner.token, 'TCA6 Control');
  await addCard(owner.token, deckA, 'pr7-bolt', 'nonfoil', 2);
  await addCard(owner.token, deckB, 'pr7-bolt', 'nonfoil', 1);
  await addCard(owner.token, deckB, 'pr7-counterspell', 'nonfoil', 1);

  const response = await api(owner.token, '/api/decks/buylist', {
    method: 'POST', body: { deck_ids: [deckA, deckB] }
  });
  const bolt = response.body.items.find(i => i.name === 'Lightning Bolt');
  assert.strictEqual(bolt.quantity, 3, 'shortfalls of 2 and 1 add to 3');
  assert.deepStrictEqual(
    bolt.decks.map(d => d.name).sort(), ['TCA6 Aggro', 'TCA6 Control'],
    'a line wanted by both decks names both'
  );
  assert.deepStrictEqual(
    bolt.decks.map(d => d.quantity).sort(), [1, 2],
    'and says how much each deck contributed, so dropping one has a visible effect'
  );

  const counter = response.body.items.find(i => i.name === 'Counterspell');
  assert.deepStrictEqual(counter.decks.map(d => d.name), ['TCA6 Control'],
    'a line only one deck wants names only that deck');
});

// F7-TCA7: a fully-owned, genuinely available card is not a purchase and must
// not appear at all.
test('F7-TCA7', 'a fully-owned available card does not appear', async ({ owner }) => {
  const deckA = await createDeck(owner.token, 'TCA7 Deck A');
  const deckB = await createDeck(owner.token, 'TCA7 Deck B');
  await ownCopies(owner.token, 'pr7-brainstorm', 'nonfoil', 4);
  await addCard(owner.token, deckA, 'pr7-brainstorm', 'nonfoil', 2);
  await addCard(owner.token, deckB, 'pr7-brainstorm', 'nonfoil', 2);

  const response = await api(owner.token, '/api/decks/buylist', {
    method: 'POST', body: { deck_ids: [deckA, deckB] }
  });
  assert.deepStrictEqual(response.body.items.filter(i => i.name === 'Brainstorm'), [],
    'he owns enough for both decks, so there is nothing to buy');
  assert.ok(response.body.items.every(i => i.quantity > 0));
});

// F7-TCA8: considering is excluded by default and reported separately, exactly
// as on the per-deck buylist. Same rule, same reason: it never reserves.
test('F7-TCA8', 'considering is excluded from the aggregate and shown separately', async ({ owner }) => {
  const deckA = await createDeck(owner.token, 'TCA8 Deck A');
  const deckB = await createDeck(owner.token, 'TCA8 Deck B');
  await addCard(owner.token, deckA, 'pr7-counterspell', 'nonfoil', 1, 'mainboard');
  await addCard(owner.token, deckB, 'pr7-brainstorm', 'nonfoil', 2, 'considering');

  const response = await api(owner.token, '/api/decks/buylist', {
    method: 'POST', body: { deck_ids: [deckA, deckB] }
  });
  assert.ok(!response.body.items.map(i => i.name).includes('Brainstorm'),
    'a card he is merely considering is not on the shopping list');
  const considering = response.body.considering.find(i => i.name === 'Brainstorm');
  assert.ok(considering, 'but it is still reported, in its own section');
  assert.deepStrictEqual(considering.decks.map(d => d.name), ['TCA8 Deck B'],
    'and it names its deck too');
});

// F7-TCA9: AN EMPTY SELECTION IS REFUSED, not answered with an empty list.
//
// "Buy nothing" and "you selected nothing" are different facts, and a silently
// empty shopping list is the dangerous one: it looks like the good news that
// he needs nothing. Refuse and say why.
test('F7-TCA9', 'an empty selection is REFUSED, not answered with an empty list', async ({ owner }) => {
  for (const body of [{ deck_ids: [] }, {}]) {
    const response = await api(owner.token, '/api/decks/buylist', { method: 'POST', body });
    assert.strictEqual(response.status, 400,
      `an empty selection must be refused, not silently answered: ${JSON.stringify(body)}`);
    assert.ok(!Array.isArray(response.body.items),
      'and it must NOT return a list at all — an empty list reads as "nothing to buy"');
  }
});

// F7-TCA10: he cannot aggregate a deck he does not own. One foreign id
// poisons the whole request rather than being quietly dropped — a shopping
// list silently missing a deck he asked for is a wrong list.
test('F7-TCA10', 'a deck he does not own cannot be included', async ({ owner, stranger }) => {
  const mine = await createDeck(owner.token, 'TCA10 Mine');
  await addCard(owner.token, mine, 'pr7-counterspell', 'nonfoil', 1);
  const theirs = await createDeck(stranger.token, `TCA10 Theirs ${userSeq}`);

  const response = await api(owner.token, '/api/decks/buylist', {
    method: 'POST', body: { deck_ids: [mine, theirs] }
  });
  assert.strictEqual(response.status, 404,
    'a deck he does not own is refused outright, not silently dropped from the total');
});

// ---------------------------------------------------------------------------

async function main() {
  await db.initDb();
  await seedCards();

  const stranger = await createUser('pr7stranger');

  const app = express();
  app.use(express.json());
  // Mount points must match src/server.js exactly.
  app.use('/api', collectionRoutes);
  app.use('/api/decks', deckRoutes);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  let failed = 0;
  try {
    for (const { id, name, fn } of tests) {
      try {
        // A fresh owner per case. See freshUser() for why isolation here is a
        // correctness requirement, not tidiness.
        await fn({ owner: await freshUser(), stranger });
        console.log(`PASS: ${id} ${name}`);
      } catch (error) {
        failed++;
        console.error(`FAIL: ${id} ${name} - ${error.message}`);
      }
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await db.close().catch(() => {});
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* already removed */ }
    }
  }
  if (failed > 0) throw new Error(`${failed} PR 7 buylist test(s) failed`);
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error.message);
  process.exit(1);
});
