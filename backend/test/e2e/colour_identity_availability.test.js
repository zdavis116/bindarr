// PR 6G: colour identity, commander swap, cross-deck availability, catalogue
// search, and commander-only search.
//
// Every case goes through the REAL HTTP routes and asserts on DATABASE ROWS or
// on the values the API actually returns -- never on a status code alone. That
// is the lesson PR 6E/6F paid for: two real bugs survived a green suite because
// the tests wrote rows with direct SQL against a freshly built schema.
//
// Direct SQL appears here only for FIXTURES (seeding card_cache, creating
// users). The thing under test is always reached through a route.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-pr6g-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';

const db = require('../../src/db');
const deckRoutes = require('../../src/routes/decks');
const collectionRoutes = require('../../src/routes/collection');
const commanderRules = require('../../src/utils/commanderRules');

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

// Own a copy through the REAL add route, not by inserting a row. The collection
// write path applies finish canonicalisation and a CHECK constraint a direct
// INSERT bypasses entirely.
async function ownCopy(token, cardId, finish = 'nonfoil') {
  const response = await api(token, '/api/collection', {
    method: 'POST',
    body: { card_id: cardId, finish }
  });
  assert.strictEqual(response.status, 200,
    `setup: owning ${cardId} (${finish}) must succeed: ${JSON.stringify(response.body)}`);
  return response.body.id;
}

// Read the deck's rows STRAIGHT FROM THE DATABASE. The API's own view is
// derived; the rows are what the user's binder has to agree with.
async function deckRows(deckId) {
  return db.all(
    `SELECT dc.id, dc.board, dc.quantity, dc.desired_card_id, dc.desired_finish, cc.name
     FROM deck_cards dc JOIN card_cache cc ON dc.desired_card_id = cc.id
     WHERE dc.deck_id = ? ORDER BY dc.id ASC`,
    [deckId]
  );
}

// Every allocation belonging to a deck, read straight from the database. A
// drop must free the copies it removes, and "free" is an allocation row that is
// gone -- not merely a number the API happens to report.
async function deckAllocations(deckId) {
  return db.all(
    `SELECT a.id, a.deck_card_id, a.collection_entry_id, a.quantity
     FROM deck_card_allocations a
     JOIN deck_cards dc ON a.deck_card_id = dc.id
     WHERE dc.deck_id = ? ORDER BY a.id ASC`,
    [deckId]
  );
}

// A complete, comparable fingerprint of a deck: its rows AND its allocations.
// "Nothing was written" has to mean both, because a drop that left the rows
// alone but released an allocation would still have changed what the user's
// binder says is free.
async function deckFingerprint(deckId) {
  const rows = await deckRows(deckId);
  const allocations = await deckAllocations(deckId);
  return {
    rows: rows.map(r => `${r.id}|${r.board}|${r.desired_card_id}|${r.desired_finish}|${r.quantity}`),
    allocations: allocations.map(a => `${a.id}|${a.deck_card_id}|${a.collection_entry_id}|${a.quantity}`)
  };
}

// THE RESULTING-STATE INVARIANT, asserted against the database rather than
// against the response. After ANY change to the command zone, every card the
// deck still holds must be castable under the commanders it still has.
//
// It is computed from the cache, not hardcoded per test, so it keeps holding if
// the fixtures change -- the point is the property, not the specific card list.
async function assertDeckWithinCommanderIdentity(deckId, context) {
  const rows = await db.all(
    `SELECT dc.board, cc.id AS card_id, cc.name, cc.color_identity
     FROM deck_cards dc JOIN card_cache cc ON dc.desired_card_id = cc.id
     WHERE dc.deck_id = ? ORDER BY dc.id ASC`,
    [deckId]
  );
  const parse = value => {
    if (value === null || value === undefined) return null; // never read: not a ruling
    try { return JSON.parse(value); } catch { return null; }
  };

  const commanders = rows.filter(r => r.board === 'commander');
  assert.ok(commanders.length > 0,
    `${context}: a Commander deck must never be left with an empty command zone`);

  const identity = new Set();
  for (const commander of commanders) {
    const colours = parse(commander.color_identity);
    assert.ok(colours !== null,
      `${context}: the surviving commander ${commander.name} has no readable identity`);
    for (const colour of colours) identity.add(colour);
  }

  // 'considering' is a shortlist, not deck contents, and is deliberately exempt
  // from the colour rule elsewhere in this suite -- so it is exempt here too.
  for (const row of rows.filter(r => r.board !== 'commander' && r.board !== 'considering')) {
    const colours = parse(row.color_identity) || [];
    const stranded = colours.filter(colour => !identity.has(colour));
    assert.deepStrictEqual(stranded, [],
      `${context}: INVARIANT BROKEN -- ${row.name} needs ${JSON.stringify(colours)} `
      + `but the command zone only allows ${JSON.stringify([...identity])}`);
  }
  return [...identity];
}

// Create a Commander deck with the given commander(s) through the real route.
async function createDeck(token, name, commanders, format = 'Commander / EDH') {
  const response = await api(token, '/api/decks', {
    method: 'POST',
    body: {
      name,
      format,
      commanders: commanders.map(id => ({ desired_card_id: id, desired_finish: 'nonfoil' }))
    }
  });
  assert.strictEqual(response.status, 201,
    `setup: creating deck ${name} must succeed: ${JSON.stringify(response.body)}`);
  return response.body.id;
}

const tests = [];
function test(id, name, fn) { tests.push({ id, name, fn }); }

// ---------------------------------------------------------------------------
// THE STUB SCRYFALL CLIENT. No network call, ever. Injected rather than
// monkey-patched so "was not called" is provable.
// ---------------------------------------------------------------------------
const scryfallStub = {
  calls: [],
  truth: {
    // A thin row whose REAL colour identity is green. Proves the colour rule
    // hydrates a thin row before refusing, exactly as PR 6F does -- an app that
    // never read the card must not confidently pass an off-identity card.
    'ci-thin-green': {
      id: 'ci-thin-green', oracle_id: 'o-ci-thin-green', name: 'Thin Green Test',
      supertype: 'MTG', subtypes: ['Creature'], set_id: 'tsg', set_name: 'Test Set G',
      number: '300', type_line: 'Creature — Test', oracle_text: 'Trample',
      keywords: ['Trample'], finishes: ['nonfoil'], color_identity: ['G']
    },
    // Genuinely BLUE: fits the Izzet test deck, so it proves the fail-hard
    // refusal is RECOVERABLE rather than a permanent dead end.
    'ci-thin-blue': {
      id: 'ci-thin-blue', oracle_id: 'o-ci-thin-blue', name: 'Thin Blue Test',
      supertype: 'MTG', subtypes: ['Creature'], set_id: 'tsg', set_name: 'Test Set G',
      number: '302', type_line: 'Creature — Test', oracle_text: 'Flying',
      keywords: ['Flying'], finishes: ['nonfoil'], color_identity: ['U']
    },
    // Genuinely GREEN: proves that when the app CAN verify, the refusal is the
    // real colour ruling and is never dressed up as an outage.
    'ci-thin-green2': {
      id: 'ci-thin-green2', oracle_id: 'o-ci-thin-green2', name: 'Thin Green Two Test',
      supertype: 'MTG', subtypes: ['Creature'], set_id: 'tsg', set_name: 'Test Set G',
      number: '303', type_line: 'Creature — Test', oracle_text: 'Reach',
      keywords: ['Reach'], finishes: ['nonfoil'], color_identity: ['G']
    },
    // A COMMANDER whose cache row goes thin mid-life (the nightly cache job
    // case). Scryfall knows it is RED, which is what makes the recovery leg of
    // F15-TC48 meaningful: the app refuses while it cannot read the commander,
    // then accepts the red card once it can -- proving the refusal was an
    // outage and not a ruling that the deck is colourless.
    'ci-cmd-thin': {
      id: 'ci-cmd-thin', oracle_id: 'o-ci-cmd-thin', name: 'Thin Cmdr Test',
      supertype: 'MTG', subtypes: ['Legendary', 'Creature'], set_id: 'tsg',
      set_name: 'Test Set G', number: '42',
      type_line: 'Legendary Creature — Test', oracle_text: 'Haste',
      keywords: ['Haste'], finishes: ['nonfoil'], color_identity: ['R']
    }
  },
  async getCardById(cardId) {
    scryfallStub.calls.push(cardId);
    if (scryfallStub.failWith) throw scryfallStub.failWith;
    return scryfallStub.truth[cardId] || null;
  },
  reset() { scryfallStub.calls = []; scryfallStub.failWith = null; }
};

// ===========================================================================
// ITEM 2 -- COLOUR IDENTITY IS A HARD FORMAT RULE
// ===========================================================================

test('F15-TC1', 'an off-identity card is REFUSED with a reason naming the colours',
  async ({ owner }) => {
    // A red/blue commander. Kodama (green) is the card Zach actually added and
    // saw accepted -- the bug this case exists to prevent regressing.
    const deckId = await createDeck(owner.token, 'PR6G Izzet', ['ci-cmd-ur']);
    const before = await deckRows(deckId);

    const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-kodama', desired_finish: 'nonfoil' }
    });

    assert.strictEqual(response.status, 409,
      `an off-identity card must be refused, got ${response.status}: ${JSON.stringify(response.body)}`);
    const text = JSON.stringify(response.body);
    // The refusal must NAME the offending colour and the commander's identity.
    // "Invalid card" would be a refusal the user cannot act on.
    assert.ok(/green/i.test(text), `refusal must name the offending colour: ${text}`);
    assert.ok(/red/i.test(text) && /blue/i.test(text),
      `refusal must state the commander's identity: ${text}`);
    assert.ok(/kodama/i.test(text), `refusal must name the card: ${text}`);

    // NOTHING WAS WRITTEN. A refusal that half-applied would be the silent
    // partial state the whole design exists to prevent.
    const after = await deckRows(deckId);
    assert.deepStrictEqual(after.map(r => r.id), before.map(r => r.id),
      'a refused colour-identity add must write nothing');
  });

test('F15-TC2', 'colour identity is NOT overridable', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'PR6G Izzet NoOverride', ['ci-cmd-ur']);

  // Colour identity is computed from card DATA, not parsed prose, so the app
  // cannot be wrong about it -- there is nothing for a user to override. This
  // is the same test PR 6F established for singleton.
  const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: {
      desired_card_id: 'ci-kodama',
      desired_finish: 'nonfoil',
      commander_override: { reason: 'I am sure this is fine' }
    }
  });

  assert.strictEqual(response.status, 409,
    'an override must NOT let an off-identity card in');
  const rows = await deckRows(deckId);
  assert.ok(!rows.some(r => r.desired_card_id === 'ci-kodama'),
    'the off-identity card must not be in the deck after an override attempt');
  // And the refusal must not advertise an override that does not exist.
  assert.notStrictEqual(response.body && response.body.overridable, true,
    'a colour-identity refusal must not claim to be overridable');
});

test('F15-TC3', 'an ON-identity card is accepted', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'PR6G Izzet OnId', ['ci-cmd-ur']);

  const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'ci-red-bolt', desired_finish: 'nonfoil' }
  });

  assert.strictEqual(response.status, 200,
    `a red card in a red/blue deck must be accepted: ${JSON.stringify(response.body)}`);
  const rows = await deckRows(deckId);
  assert.ok(rows.some(r => r.desired_card_id === 'ci-red-bolt' && r.board === 'mainboard'),
    'the on-identity card must actually be in the deck');
});

test('F15-TC4', 'a COLOURLESS card is accepted in any deck', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'PR6G Izzet Colourless', ['ci-cmd-ur']);

  const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'ci-solring', desired_finish: 'nonfoil' }
  });

  assert.strictEqual(response.status, 200,
    `a colourless artifact must be accepted anywhere: ${JSON.stringify(response.body)}`);
  const rows = await deckRows(deckId);
  assert.ok(rows.some(r => r.desired_card_id === 'ci-solring'),
    'the colourless card must be in the deck');
});

test('F15-TC5', 'a LAND producing off-identity mana is refused', async ({ owner }) => {
  // A land has no mana cost and no colours, but its rules text produces green
  // mana -- so its colour identity is green. This is precisely the case a
  // "check the card's colors field" implementation gets wrong, which is why the
  // rule reads Scryfall's color_identity rather than deriving it.
  const deckId = await createDeck(owner.token, 'PR6G Izzet Land', ['ci-cmd-ur']);

  const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'ci-green-land', desired_finish: 'nonfoil' }
  });

  assert.strictEqual(response.status, 409,
    `a land producing green mana must be refused in a red/blue deck: ${JSON.stringify(response.body)}`);
  assert.ok(/green/i.test(JSON.stringify(response.body)),
    'the refusal must name green');
});

test('F15-TC6', 'a BASIC land of an off-identity colour is refused', async ({ owner }) => {
  // Basic lands are exempt from SINGLETON, not from colour identity. Those are
  // different rules and conflating them would let a Forest into an Izzet deck.
  const deckId = await createDeck(owner.token, 'PR6G Izzet Basic', ['ci-cmd-ur']);

  const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'ci-forest', desired_finish: 'nonfoil' }
  });

  assert.strictEqual(response.status, 409,
    `a Forest must be refused in a red/blue deck: ${JSON.stringify(response.body)}`);
});

test('F15-TC7', 'NON-Commander formats are entirely unaffected', async ({ owner }) => {
  // The spec is explicit: Commander format only. A rule that leaks into Modern
  // is a bug even if the rule itself is correct.
  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: { name: 'PR6G Modern', format: 'Modern', target_size: 60 }
  });
  assert.strictEqual(response.status, 201, JSON.stringify(response.body));
  const deckId = response.body.id;

  // Every colour, four copies, no commander at all -- all fine in Modern.
  for (const cardId of ['ci-kodama', 'ci-forest', 'ci-green-land']) {
    const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: cardId, desired_finish: 'nonfoil', quantity: 4 }
    });
    assert.strictEqual(add.status, 200,
      `${cardId} must be accepted in a Modern deck: ${JSON.stringify(add.body)}`);
  }
  const rows = await deckRows(deckId);
  assert.strictEqual(rows.length, 3, 'all three cards must be in the Modern deck');
});

test('F15-TC8', 'the CONSIDERING board is not subject to colour identity',
  async ({ owner }) => {
    // Considering is a shortlist, not deck contents: it reserves nothing and
    // counts towards no legality rule anywhere else in the app. Refusing a
    // considering add would stop the user shortlisting a card they might build
    // a different deck around.
    const deckId = await createDeck(owner.token, 'PR6G Izzet Considering', ['ci-cmd-ur']);

    const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-kodama', desired_finish: 'nonfoil', board: 'considering' }
    });

    assert.strictEqual(response.status, 200,
      `considering must accept an off-identity card: ${JSON.stringify(response.body)}`);
  });

test('F15-TC9', 'the MULTI-SELECT bulk add refuses off-identity cards in its pre-flight',
  async ({ owner }) => {
    const deckId = await createDeck(owner.token, 'PR6G Izzet Bulk', ['ci-cmd-ur']);
    const bolt = await ownCopy(owner.token, 'ci-red-bolt');
    const kodama = await ownCopy(owner.token, 'ci-kodama');

    const response = await api(owner.token, '/api/collection/bulk', {
      method: 'POST',
      body: { entry_ids: [bolt, kodama], action: 'add_to_deck', value: String(deckId) }
    });

    // The pre-flight reports BEFORE writing anything -- the user sees the
    // problem before part of their selection has already landed.
    assert.strictEqual(response.status, 409,
      `bulk add must pre-flight the colour rule: ${JSON.stringify(response.body)}`);
    const text = JSON.stringify(response.body);
    assert.ok(/kodama/i.test(text), `the problem must name the card: ${text}`);
    assert.ok(/green/i.test(text), `the problem must name the colour: ${text}`);

    const rows = await deckRows(deckId);
    assert.ok(!rows.some(r => r.desired_card_id === 'ci-kodama'),
      'nothing may be written by a refused pre-flight');
  });

test('F15-TC10', 'IMPORT reports a colour-identity refusal in the PRE-FLIGHT, not after',
  async ({ owner }) => {
    const deckId = await createDeck(owner.token, 'PR6G Izzet Import', ['ci-cmd-ur']);

    const preview = await api(owner.token, `/api/decks/${deckId}/import`, {
      method: 'POST',
      body: {
        lines: [
          { name: 'Bolt Test', quantity: 1 },
          { name: 'Kodama Test', quantity: 1 }
        ],
        apply: false
      }
    });

    assert.strictEqual(preview.status, 200, JSON.stringify(preview.body));
    const refused = (preview.body.lines || []).filter(l => l.refused);
    assert.strictEqual(refused.length, 1,
      `exactly one line must be refused: ${JSON.stringify(preview.body.lines)}`);
    assert.ok(/kodama/i.test(refused[0].name), 'the refused line must be Kodama');
    assert.ok(/green/i.test(String(refused[0].refusal_reason)),
      `the refusal must name the colour: ${refused[0].refusal_reason}`);
  });

test('F15-TC11', 'a RE-PIN to an off-identity printing is refused', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'PR6G Izzet Repin', ['ci-cmd-ur']);
  const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'ci-red-bolt', desired_finish: 'nonfoil' }
  });
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));
  const rows = await deckRows(deckId);
  const boltRow = rows.find(r => r.desired_card_id === 'ci-red-bolt');

  const repin = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: {
      desired_card_id: 'ci-kodama',
      desired_finish: 'nonfoil',
      replacing_deck_card_id: boltRow.id
    }
  });

  assert.strictEqual(repin.status, 409,
    `re-pinning onto an off-identity card must be refused: ${JSON.stringify(repin.body)}`);
  // AND THE ORIGINAL ROW SURVIVES. A refusal that consumed the row it was
  // editing would destroy data on the way to saying no.
  const after = await deckRows(deckId);
  assert.ok(after.some(r => r.id === boltRow.id),
    'a refused re-pin must leave the original row intact');
});

test('F15-TC12', 'a BOARD MOVE into a reserving board is refused for an off-identity card',
  async ({ owner }) => {
    const deckId = await createDeck(owner.token, 'PR6G Izzet Move', ['ci-cmd-ur']);
    // Legally parked on considering, which the rule does not police.
    const park = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-kodama', desired_finish: 'nonfoil', board: 'considering' }
    });
    assert.strictEqual(park.status, 200, JSON.stringify(park.body));
    const parked = (await deckRows(deckId)).find(r => r.desired_card_id === 'ci-kodama');

    // Moving it to the mainboard makes it deck contents, so the rule applies.
    const move = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        desired_card_id: 'ci-kodama',
        desired_finish: 'nonfoil',
        board: 'mainboard',
        replacing_deck_card_id: parked.id
      }
    });

    assert.strictEqual(move.status, 409,
      `moving an off-identity card onto the mainboard must be refused: ${JSON.stringify(move.body)}`);
    const after = await deckRows(deckId);
    assert.ok(after.some(r => r.id === parked.id && r.board === 'considering'),
      'a refused move must leave the card where it was');
  });

test('F15-TC13', 'a THIN cache row is hydrated before the colour rule decides',
  async ({ owner }) => {
    // The app must not confidently pass an off-identity card just because it
    // never read the card. Same principle PR 6F established for commander
    // legality: when knowledge is insufficient, GET BETTER KNOWLEDGE.
    scryfallStub.reset();
    const deckId = await createDeck(owner.token, 'PR6G Izzet Thin', ['ci-cmd-ur']);

    const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-thin-green', desired_finish: 'nonfoil' }
    });

    assert.ok(scryfallStub.calls.includes('ci-thin-green'),
      'a thin row must be refetched before the colour rule decides');
    assert.strictEqual(response.status, 409,
      `the hydrated card is green and must be refused: ${JSON.stringify(response.body)}`);
    assert.ok(/green/i.test(JSON.stringify(response.body)),
      'the refusal must name the colour learned from the refetch');
  });

// ---------------------------------------------------------------------------
// COLOUR HYDRATION FAILS HARD (Zach, 2026-08-18).
//
// The earlier implementation failed SOFT: if Scryfall could not be reached, the
// colour rule was evaluated on whatever the app happened to hold, on the
// reasoning that colour identity has no override so a hard failure is a dead
// end. Zach ruled the other way, and the reasoning is his standing principle:
//
//   An app tracking PHYSICAL OBJECTS must not accept a card it could not
//   verify. "Could not verify this card right now, try again" is RECOVERABLE.
//   A wrongly-accepted off-identity card is NOT, because he would never know
//   to go looking for it.
//
// The lockout risk is narrow: isThinForColorIdentity only fires when
// color_identity is entirely NULL, and any card he has searched, owned or added
// before is already cached.
//
// The rule cut both ways: an upstream outage must never become a legality
// ruling in EITHER direction -- not a silent accept, and not a silent refuse.
// ---------------------------------------------------------------------------

test('F15-TC33', 'a thin row whose refetch FAILS is refused, and nothing is written',
  async ({ owner }) => {
    scryfallStub.reset();
    const deckId = await createDeck(owner.token, 'PR6G Hydration Down', ['ci-cmd-ur']);
    const before = await deckRows(deckId);

    // Scryfall is unreachable. The app has learned NOTHING about this card.
    scryfallStub.failWith = new Error('UPSTREAM_UNAVAILABLE');

    const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-thin-fail', desired_finish: 'nonfoil' }
    });

    assert.ok(scryfallStub.calls.includes('ci-thin-fail'),
      'a thin row must be refetched before the colour rule decides');

    // AN HONEST COULD-NOT-VERIFY, the same shape as the commander 503.
    assert.strictEqual(response.status, 503,
      `an unverifiable card must be refused, not accepted: ${JSON.stringify(response.body)}`);
    const body = response.body || {};
    assert.strictEqual(body.code, 'COMMANDER_VERIFY_UNAVAILABLE',
      `the refusal must be the could-not-verify code: ${JSON.stringify(body)}`);
    assert.ok(/could not verify/i.test(String(body.error)),
      `the message must say it could not verify: ${body.error}`);
    // NOT A LEGALITY RULING. The user must not be told their card is illegal.
    assert.ok(!/colour identity includes/i.test(String(body.error)),
      `an outage must not be dressed up as a colour ruling: ${body.error}`);
    // AND NOT OVERRIDABLE: colour identity has no override, so the refusal must
    // not advertise one that does not exist.
    assert.notStrictEqual(body.overridable, true,
      'a colour hydration failure must not claim an override exists');

    // NOTHING WAS WRITTEN.
    const after = await deckRows(deckId);
    assert.deepStrictEqual(after.map(r => r.id), before.map(r => r.id),
      'an unverifiable add must write nothing at all');
  });

test('F15-TC34', 'the SAME card succeeds once hydration succeeds',
  async ({ owner }) => {
    // The refusal above is recoverable, which is the whole justification for
    // failing hard. Once Scryfall answers, the identical request goes through.
    scryfallStub.reset();
    const deckId = await createDeck(owner.token, 'PR6G Hydration Back', ['ci-cmd-ur']);

    scryfallStub.failWith = new Error('UPSTREAM_UNAVAILABLE');
    const down = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-thin-blue', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(down.status, 503, JSON.stringify(down.body));

    // Upstream recovers. The card is genuinely blue, so it fits the Izzet deck.
    scryfallStub.reset();
    const up = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-thin-blue', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(up.status, 200,
      `once verifiable, the same add must succeed: ${JSON.stringify(up.body)}`);

    const rows = await deckRows(deckId);
    assert.ok(rows.some(r => r.desired_card_id === 'ci-thin-blue' && r.board === 'mainboard'),
      'the verified card must actually be in the deck');
  });

test('F15-TC35', 'a hydrated OFF-identity card is refused as a COLOUR ruling, not an outage',
  async ({ owner }) => {
    // The mirror of TC33: when the app CAN verify, the refusal must be the real
    // colour refusal naming the colour -- never converted into a 503.
    scryfallStub.reset();
    const deckId = await createDeck(owner.token, 'PR6G Hydration Green', ['ci-cmd-ur']);

    const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-thin-green2', desired_finish: 'nonfoil' }
    });

    assert.strictEqual(response.status, 409,
      `a verified green card must get the colour refusal: ${JSON.stringify(response.body)}`);
    assert.strictEqual(response.body.code, 'COMMANDER_COLOR_IDENTITY',
      `the refusal must be the colour rule, not an outage: ${JSON.stringify(response.body)}`);
    assert.ok(/green/i.test(JSON.stringify(response.body)),
      'the refusal must name the colour learned from the refetch');
  });

test('F15-TC36', 'a CACHED colour identity is decided with NO network call at all',
  async ({ owner }) => {
    // The lockout risk is bounded precisely because this is the common case:
    // any card already searched, owned or added is cached, and a cached row
    // never touches the network -- so an outage cannot lock the user out of
    // cards they have handled before.
    scryfallStub.reset();
    const deckId = await createDeck(owner.token, 'PR6G Cached NoNet', ['ci-cmd-ur']);
    scryfallStub.reset();
    // Even with upstream DOWN, a cached card must be decidable.
    scryfallStub.failWith = new Error('UPSTREAM_UNAVAILABLE');

    const accepted = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-blue-counter', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(accepted.status, 200,
      `a cached on-identity card must be accepted while upstream is down: ${JSON.stringify(accepted.body)}`);

    const refused = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-kodama', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(refused.status, 409,
      `a cached off-identity card must still be refused on colour: ${JSON.stringify(refused.body)}`);
    assert.strictEqual(refused.body.code, 'COMMANDER_COLOR_IDENTITY',
      'a cached decision must not degrade into an outage error');

    assert.deepStrictEqual(scryfallStub.calls, [],
      `a cached colour identity must cost no network call: ${JSON.stringify(scryfallStub.calls)}`);
    scryfallStub.reset();
  });

test('F15-TC14', 'a fully-cached ON-identity card costs NO Scryfall call',
  async ({ owner }) => {
    // The happy path must stay instant. A rule that refetches every card would
    // be an unbounded stream of network calls that never changes an answer.
    scryfallStub.reset();
    const deckId = await createDeck(owner.token, 'PR6G Izzet NoFetch', ['ci-cmd-ur']);
    scryfallStub.reset();

    const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-red-bolt', desired_finish: 'nonfoil' }
    });

    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    assert.deepStrictEqual(scryfallStub.calls, [],
      'a complete cache row must not cost a Scryfall round trip');
  });

// ===========================================================================
// ITEM 3 -- CHANGING THE COMMANDER
// ===========================================================================

test('F15-TC15', 'a commander swap WARNS and NAMES the cards it will remove',
  async ({ owner }) => {
    // Zach, verbatim: "You should allow the swap with a warning that it will
    // remove any cards from the deck that are no longer valid."
    const deckId = await createDeck(owner.token, 'PR6G Swap Warn', ['ci-cmd-ur']);
    for (const cardId of ['ci-red-bolt', 'ci-blue-counter', 'ci-solring']) {
      const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil' }
      });
      assert.strictEqual(add.status, 200, `${cardId}: ${JSON.stringify(add.body)}`);
    }
    const commanderRow = (await deckRows(deckId)).find(r => r.board === 'commander');

    // Swap to a MONO-RED commander. The blue card is no longer legal; the red
    // and colourless ones still are.
    const preview = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        desired_card_id: 'ci-cmd-r',
        desired_finish: 'nonfoil',
        board: 'commander',
        replacing_deck_card_id: commanderRow.id
      }
    });

    assert.strictEqual(preview.status, 409,
      `an unconfirmed swap that removes cards must warn first: ${JSON.stringify(preview.body)}`);
    const body = preview.body || {};
    assert.strictEqual(body.code, 'COMMANDER_SWAP_REMOVES_CARDS',
      `the warning must be identifiable: ${JSON.stringify(body)}`);
    // NAMED, WITH A COUNT. "Some cards will be removed" is not consent.
    // sendError spreads a CommanderRuleError's details onto the body, which is
    // the shape every other refusal in this app already uses.
    const removing = body.removing;
    assert.ok(Array.isArray(removing), `the warning must list the cards: ${JSON.stringify(body)}`);
    assert.strictEqual(removing.length, 1, `exactly one card is off-identity: ${JSON.stringify(removing)}`);
    assert.ok(/counter/i.test(removing[0].name), `the blue card must be named: ${JSON.stringify(removing)}`);
    assert.strictEqual(body.removing_count, 1, 'the warning must carry a count');

    // NOTHING HAS HAPPENED YET.
    const rows = await deckRows(deckId);
    assert.ok(rows.some(r => r.desired_card_id === 'ci-blue-counter'),
      'the warning must not have removed anything');
    assert.ok(rows.some(r => r.id === commanderRow.id),
      'the commander must not have been swapped by an unconfirmed request');
  });

test('F15-TC16', 'CANCELLING the swap changes nothing', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'PR6G Swap Cancel', ['ci-cmd-ur']);
  const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST', body: { desired_card_id: 'ci-blue-counter', desired_finish: 'nonfoil' }
  });
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));
  const before = await deckRows(deckId);
  const commanderRow = before.find(r => r.board === 'commander');

  // Ask, get warned, and never confirm. That IS the cancel: the user simply
  // does not send the confirming request.
  const warn = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: {
      desired_card_id: 'ci-cmd-r', desired_finish: 'nonfoil',
      board: 'commander', replacing_deck_card_id: commanderRow.id
    }
  });
  assert.strictEqual(warn.status, 409, JSON.stringify(warn.body));

  const after = await deckRows(deckId);
  assert.deepStrictEqual(
    after.map(r => `${r.id}|${r.board}|${r.desired_card_id}|${r.quantity}`),
    before.map(r => `${r.id}|${r.board}|${r.desired_card_id}|${r.quantity}`),
    'a cancelled swap must leave the deck byte-for-byte as it was'
  );
});

test('F15-TC17', 'a CONFIRMED swap applies the swap and the removals ATOMICALLY',
  async ({ owner }) => {
    const deckId = await createDeck(owner.token, 'PR6G Swap Apply', ['ci-cmd-ur']);
    for (const cardId of ['ci-red-bolt', 'ci-blue-counter', 'ci-solring']) {
      const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil' }
      });
      assert.strictEqual(add.status, 200, `${cardId}: ${JSON.stringify(add.body)}`);
    }
    const commanderRow = (await deckRows(deckId)).find(r => r.board === 'commander');

    const applied = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        desired_card_id: 'ci-cmd-r',
        desired_finish: 'nonfoil',
        board: 'commander',
        replacing_deck_card_id: commanderRow.id,
        // The user has SEEN the named list and explicitly agreed. Silence is
        // not consent, so this flag has no default.
        confirm_remove_off_identity: true
      }
    });

    assert.strictEqual(applied.status, 200,
      `a confirmed swap must apply: ${JSON.stringify(applied.body)}`);

    const rows = await deckRows(deckId);
    // BOTH halves landed: the new commander is in, the off-identity card is out.
    assert.ok(rows.some(r => r.board === 'commander' && r.desired_card_id === 'ci-cmd-r'),
      'the new commander must be in the command zone');
    assert.ok(!rows.some(r => r.desired_card_id === 'ci-cmd-ur'),
      'the old commander must be gone');
    assert.ok(!rows.some(r => r.desired_card_id === 'ci-blue-counter'),
      'the off-identity card must have been removed');
    // AND EXACTLY THOSE. A swap that over-removed would destroy legal cards.
    assert.ok(rows.some(r => r.desired_card_id === 'ci-red-bolt'),
      'the still-legal red card must survive');
    assert.ok(rows.some(r => r.desired_card_id === 'ci-solring'),
      'the colourless card must survive');
  });

test('F15-TC18', 'a removed entry releases its ALLOCATION but not the physical card',
  async ({ owner }) => {
    // Removing a deck entry frees the copy for other decks; it must not touch
    // the collection row, which represents a physical object in a binder.
    const deckId = await createDeck(owner.token, 'PR6G Swap Alloc', ['ci-cmd-ur']);
    const collectionId = await ownCopy(owner.token, 'ci-blue-counter');
    const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST', body: { desired_card_id: 'ci-blue-counter', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));
    const commanderRow = (await deckRows(deckId)).find(r => r.board === 'commander');

    const applied = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        desired_card_id: 'ci-cmd-r', desired_finish: 'nonfoil', board: 'commander',
        replacing_deck_card_id: commanderRow.id, confirm_remove_off_identity: true
      }
    });
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));

    // The physical card is still in the binder.
    const stillOwned = await db.get(
      `SELECT id, quantity FROM collection WHERE id = ?`, [collectionId]
    );
    assert.ok(stillOwned, 'the physical collection row must survive the removal');

    // No allocation dangles pointing at a deck entry that no longer exists.
    const orphans = await db.all(
      `SELECT a.id FROM deck_card_allocations a
       LEFT JOIN deck_cards dc ON a.deck_card_id = dc.id
       WHERE dc.id IS NULL`
    );
    assert.deepStrictEqual(orphans, [], 'no allocation may outlive its deck entry');
  });

test('F15-TC19', 'a swap refused for ANOTHER reason removes nothing', async ({ owner }) => {
  // "If the swap is refused for any other reason (illegal commander, illegal
  // pair, same name), nothing is removed."
  const deckId = await createDeck(owner.token, 'PR6G Swap Illegal', ['ci-cmd-ur']);
  const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST', body: { desired_card_id: 'ci-blue-counter', desired_finish: 'nonfoil' }
  });
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));
  const before = await deckRows(deckId);
  const commanderRow = before.find(r => r.board === 'commander');

  // ci-solring is a colourless artifact: not a legal commander at all. Even
  // with the confirmation flag set, the swap fails on legality FIRST.
  const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: {
      desired_card_id: 'ci-solring', desired_finish: 'nonfoil', board: 'commander',
      replacing_deck_card_id: commanderRow.id, confirm_remove_off_identity: true
    }
  });

  assert.strictEqual(response.status, 409,
    `an illegal commander must be refused: ${JSON.stringify(response.body)}`);
  const after = await deckRows(deckId);
  assert.deepStrictEqual(
    after.map(r => `${r.id}|${r.board}|${r.desired_card_id}`),
    before.map(r => `${r.id}|${r.board}|${r.desired_card_id}`),
    'a swap refused on legality must remove nothing'
  );
});

test('F15-TC20', 'a swap that removes NOTHING needs no confirmation', async ({ owner }) => {
  // The warning exists to report removals. With none to report, the swap is an
  // ordinary edit and must not grow a pointless confirmation step.
  const deckId = await createDeck(owner.token, 'PR6G Swap Clean', ['ci-cmd-ur']);
  const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST', body: { desired_card_id: 'ci-red-bolt', desired_finish: 'nonfoil' }
  });
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));
  const commanderRow = (await deckRows(deckId)).find(r => r.board === 'commander');

  // Swapping UR -> UR (a different Izzet commander) invalidates nothing.
  const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: {
      desired_card_id: 'ci-cmd-ur-b', desired_finish: 'nonfoil', board: 'commander',
      replacing_deck_card_id: commanderRow.id
    }
  });

  assert.strictEqual(response.status, 200,
    `a swap removing nothing must just apply: ${JSON.stringify(response.body)}`);
  const rows = await deckRows(deckId);
  assert.ok(rows.some(r => r.board === 'commander' && r.desired_card_id === 'ci-cmd-ur-b'),
    'the new commander must be in place');
  assert.ok(rows.some(r => r.desired_card_id === 'ci-red-bolt'),
    'the still-legal card must survive');
});

// ===========================================================================
// ITEM 4 -- "IN DECK" MUST COUNT ALL DECKS
// ===========================================================================

test('F15-TC21', 'In Deck counts copies across ALL decks, not just the open one',
  async ({ availability }) => {
    // Zach's worked example: own 6 Breena, 1 copy in each of 4 decks ->
    // "Owned: 6 | In Deck: 4".
    const user = availability;
    for (let i = 0; i < 6; i++) await ownCopy(user.token, 'ci-breena');

    const deckIds = [];
    for (let i = 1; i <= 4; i++) {
      const deckId = await createDeck(user.token, `PR6G Breena ${i}`, ['ci-cmd-wb']);
      const add = await api(user.token, `/api/decks/${deckId}/cards`, {
        method: 'POST',
        body: { desired_card_id: 'ci-breena', desired_finish: 'nonfoil', quantity: 1 }
      });
      assert.strictEqual(add.status, 200, `deck ${i}: ${JSON.stringify(add.body)}`);
      deckIds.push(deckId);
    }

    // Ask the SEARCH route the question Browse Collection asks. The figure must
    // be independent of which deck is open, so it is asserted without any deck
    // context at all.
    const search = await api(user.token, '/api/search?name=Breena&scope=collection');
    assert.strictEqual(search.status, 200, JSON.stringify(search.body));
    const row = (search.body || []).find(c => /breena/i.test(c.name));
    assert.ok(row, `Breena must be in the collection search results: ${JSON.stringify(search.body)}`);

    assert.strictEqual(row.owned_qty, 6, `Owned must be 6, got ${row.owned_qty}`);
    assert.strictEqual(row.in_deck_qty, 4,
      `In Deck must count all four decks, got ${row.in_deck_qty}`);
    // The availability figure the user actually reasons about.
    assert.strictEqual(row.owned_qty - row.in_deck_qty, 2,
      'Owned minus In Deck must equal the copies genuinely free');
  });

test('F15-TC22', 'In Deck counts COPIES, not decks', async ({ availability2 }) => {
  // Zach's other worked example: 2 copies in one deck and 1 in another ->
  // "In Deck: 3". A count of DECKS would say 2 and overstate availability.
  const user = availability2;
  for (let i = 0; i < 6; i++) await ownCopy(user.token, 'ci-tut');

  // A non-Commander deck, so a quantity of 2 is legal.
  const first = await api(user.token, '/api/decks', {
    method: 'POST', body: { name: 'PR6G Copies A', format: 'Modern', target_size: 60 }
  });
  assert.strictEqual(first.status, 201, JSON.stringify(first.body));
  const addA = await api(user.token, `/api/decks/${first.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'ci-tut', desired_finish: 'nonfoil', quantity: 2 }
  });
  assert.strictEqual(addA.status, 200, JSON.stringify(addA.body));

  const second = await api(user.token, '/api/decks', {
    method: 'POST', body: { name: 'PR6G Copies B', format: 'Modern', target_size: 60 }
  });
  assert.strictEqual(second.status, 201, JSON.stringify(second.body));
  const addB = await api(user.token, `/api/decks/${second.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'ci-tut', desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(addB.status, 200, JSON.stringify(addB.body));

  const search = await api(user.token, '/api/search?name=Tutor&scope=collection');
  assert.strictEqual(search.status, 200, JSON.stringify(search.body));
  const row = (search.body || []).find(c => /tutor/i.test(c.name));
  assert.ok(row, JSON.stringify(search.body));

  assert.strictEqual(row.in_deck_qty, 3,
    `In Deck must be 3 copies, not 2 decks; got ${row.in_deck_qty}`);
  assert.strictEqual(row.owned_qty - row.in_deck_qty, 3,
    'three copies must read as genuinely free');
});

test('F15-TC23', 'the CONSIDERING board does not count towards In Deck',
  async ({ availability3 }) => {
    // Considering reserves nothing, so counting it would understate
    // availability -- the mirror image of the bug being fixed, and just as
    // false.
    const user = availability3;
    await ownCopy(user.token, 'ci-shock');

    const deckId = await createDeck(user.token, 'PR6G Considering Avail', ['ci-cmd-r']);
    const add = await api(user.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-shock', desired_finish: 'nonfoil', board: 'considering' }
    });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));

    const search = await api(user.token, '/api/search?name=Shock&scope=collection');
    const row = (search.body || []).find(c => /shock/i.test(c.name));
    assert.ok(row, JSON.stringify(search.body));
    assert.strictEqual(row.in_deck_qty, 0,
      `a considering entry reserves nothing and must not count; got ${row.in_deck_qty}`);
  });

test('F15-TC24', 'the BROWSE COLLECTION listing carries the same cross-deck figure',
  async ({ availability4 }) => {
    // Browse Collection is the screen the bug was reported on. It reads
    // /api/collection, so that route must carry the figure too -- otherwise the
    // fix would be invisible exactly where it was asked for.
    const user = availability4;
    await ownCopy(user.token, 'ci-blue-counter');
    await ownCopy(user.token, 'ci-blue-counter');

    const deckId = await createDeck(user.token, 'PR6G Browse Avail', ['ci-cmd-ur']);
    const add = await api(user.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-blue-counter', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));

    const listing = await api(user.token, '/api/collection');
    assert.strictEqual(listing.status, 200, JSON.stringify(listing.body));
    const rows = (listing.body || []).filter(r => r.card_id === 'ci-blue-counter');
    assert.ok(rows.length > 0, 'the owned card must appear in the collection listing');
    for (const row of rows) {
      assert.strictEqual(row.in_deck_qty, 1,
        `each row must report the cross-deck total; got ${row.in_deck_qty}`);
    }
  });

// ===========================================================================
// ITEM 1 -- COMMANDER SEARCH OFFERS ONLY LEGAL COMMANDERS
// ===========================================================================

test('F15-TC25', 'commander search returns ONLY legal commanders', async ({ owner }) => {
  // The filter must REUSE isLegalCommanderCard so the user cannot pick
  // something that will then be refused. One rule, one implementation.
  const response = await api(owner.token, '/api/search?name=Test&commanders=1');
  assert.strictEqual(response.status, 200, JSON.stringify(response.body));
  const cards = response.body || [];
  assert.ok(cards.length > 0, 'the commander search must return something');

  for (const card of cards) {
    assert.ok(commanderRules.isLegalCommanderCard(card),
      `${card.name} is not a legal commander and must not be offered: ${JSON.stringify(card)}`);
  }
});

test('F15-TC26', 'commander search EXCLUDES a card the create route would refuse',
  async ({ owner }) => {
    // The specific failure: the picker offers a Sol Ring, the user chooses it,
    // and deck creation refuses. The filter and the refusal must agree.
    const response = await api(owner.token, '/api/search?name=Sol Ring Test&commanders=1');
    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    assert.ok(!(response.body || []).some(c => c.id === 'ci-solring'),
      'an artifact must never be offered as a commander');

    // Proof the two agree: creating with it is genuinely refused.
    const create = await api(owner.token, '/api/decks', {
      method: 'POST',
      body: {
        name: 'PR6G Should Refuse',
        format: 'Commander / EDH',
        commanders: [{ desired_card_id: 'ci-solring', desired_finish: 'nonfoil' }]
      }
    });
    assert.strictEqual(create.status, 409,
      'the card excluded from the picker must also be refused by create');
  });

test('F15-TC27', 'commander search still INCLUDES a "can be your commander" card',
  async ({ owner }) => {
    // A type-line-only filter would wrongly drop planeswalker commanders. The
    // rule reads the card's text as well, and the filter must use that rule
    // rather than a simpler divergent one.
    const response = await api(owner.token, '/api/search?name=Planeswalker Cmdr&commanders=1');
    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    assert.ok((response.body || []).some(c => c.id === 'ci-pw-cmd'),
      `a "can be your commander" planeswalker must be offered: ${JSON.stringify(response.body)}`);
  });

test('F15-TC28', 'the ordinary card search is UNFILTERED', async ({ owner }) => {
  // The filter must be opt-in. Applying it to the Add Cards search would make
  // most of the collection unaddable.
  const response = await api(owner.token, '/api/search?name=Sol Ring Test');
  assert.strictEqual(response.status, 200, JSON.stringify(response.body));
  assert.ok((response.body || []).some(c => c.id === 'ci-solring'),
    'the ordinary search must still return non-commander cards');
});

// ===========================================================================
// ITEM 5 -- CARD SEARCH MUST REACH THE FULL CATALOGUE
// ===========================================================================

test('F15-TC29', 'catalogue search returns a card the user does NOT own',
  async ({ owner }) => {
    // The reported bug: searching for an unowned card returns nothing, so it
    // cannot be added as a requirement and a commander cannot be chosen before
    // it is acquired.
    const response = await api(owner.token, '/api/search?name=Unowned Test');
    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    const row = (response.body || []).find(c => c.id === 'ci-unowned');
    assert.ok(row,
      `an unowned catalogue card must be findable: ${JSON.stringify(response.body)}`);
  });

test('F15-TC30', 'owned and unowned results are DISTINGUISHABLE', async ({ owner }) => {
  await ownCopy(owner.token, 'ci-owned-marker');

  const response = await api(owner.token, '/api/search?name=Marker Test');
  assert.strictEqual(response.status, 200, JSON.stringify(response.body));
  const owned = (response.body || []).find(c => c.id === 'ci-owned-marker');
  const unowned = (response.body || []).find(c => c.id === 'ci-unowned-marker');

  assert.ok(owned, 'the owned card must be in the results');
  assert.ok(unowned, 'the unowned card must be in the results');
  assert.ok(owned.owned_qty > 0, `the owned card must report ownership: ${JSON.stringify(owned)}`);
  assert.strictEqual(unowned.owned_qty, 0,
    `the unowned card must report zero, not undefined: ${JSON.stringify(unowned)}`);
});

test('F15-TC31', 'the DECK search reaches the catalogue, not only the collection',
  async ({ owner }) => {
    // scope=database is the default and is what the deck Add Cards search must
    // use. A collection-scoped search is why unowned cards were invisible.
    const response = await api(owner.token, '/api/search?name=Unowned Test&scope=database');
    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    assert.ok((response.body || []).some(c => c.id === 'ci-unowned'),
      'scope=database must reach the catalogue');
  });

test('F15-TC32', 'an unowned card found by search can be ADDED as a requirement',
  async ({ owner }) => {
    // The end-to-end point of item 5: finding the card is only useful if it can
    // then be used. The requirement is created and simply reads as missing.
    const deckId = await createDeck(owner.token, 'PR6G Unowned Req', ['ci-cmd-ur']);

    const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-unowned', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(add.status, 200,
      `an unowned card must be addable as a requirement: ${JSON.stringify(add.body)}`);

    const entry = (add.body.cards || []).find(c => c.desired_card_id === 'ci-unowned');
    assert.ok(entry, 'the requirement must come back in the deck view');
    assert.strictEqual(entry.quantity_owned, 0, 'it must report zero owned');
    assert.strictEqual(entry.quantity_missing, 1, 'it must report as missing, not as an error');
  });

// ---------------------------------------------------------------------------
// ITEM 3 (Zach, 2026-08-18) -- DECK SEARCH SHOWS THE AVAILABLE COUNT INLINE.
//
// Zach: "searching when inside the deck would allow you to search on cards you
// own/dont own and that is where show available count becomes nice in that
// because you can see if you even have it and then even farther it marks it as
// missing".
//
// So the SEARCH ITSELF answers "do I even have this, and is it free?" without a
// second lookup. AVAILABLE means GENUINELY FREE -- owned minus committed across
// ALL decks, consistent with the In Deck fix in this PR. Not owned-minus-this-
// deck, which is the false-availability bug in a different costume.
// ---------------------------------------------------------------------------

test('F15-TC37', 'a deck search result carries an AVAILABLE count',
  async ({ availability5 }) => {
    const user = availability5;
    for (let i = 0; i < 3; i++) await ownCopy(user.token, 'ci-shock');

    const search = await api(user.token, '/api/search?name=Shock Test&scope=database');
    assert.strictEqual(search.status, 200, JSON.stringify(search.body));
    const row = (search.body || []).find(c => c.id === 'ci-shock');
    assert.ok(row, `the card must be findable: ${JSON.stringify(search.body)}`);

    assert.strictEqual(row.owned_qty, 3, `owned must be 3, got ${row.owned_qty}`);
    assert.strictEqual(row.available_qty, 3,
      `nothing is committed, so all three are free; got ${row.available_qty}`);
  });

test('F15-TC38', 'the available count reflects commitments across ALL decks',
  async ({ availability6 }) => {
    // The point of the figure. Two copies committed in a deck the user is NOT
    // looking at must still reduce what the search reports as free -- otherwise
    // the search invites them to sleeve a card that is already spoken for.
    const user = availability6;
    for (let i = 0; i < 3; i++) await ownCopy(user.token, 'ci-tut');

    const other = await api(user.token, '/api/decks', {
      method: 'POST', body: { name: 'PR6G Avail Other', format: 'Modern', target_size: 60 }
    });
    assert.strictEqual(other.status, 201, JSON.stringify(other.body));
    const add = await api(user.token, `/api/decks/${other.body.id}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-tut', desired_finish: 'nonfoil', quantity: 2 }
    });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));

    // Searched WITHOUT any deck context: the figure is a fact about the whole
    // collection, so it must not depend on which deck happens to be open.
    const search = await api(user.token, '/api/search?name=Tutor Test&scope=database');
    const row = (search.body || []).find(c => c.id === 'ci-tut');
    assert.ok(row, JSON.stringify(search.body));

    assert.strictEqual(row.owned_qty, 3, `owned must be 3, got ${row.owned_qty}`);
    assert.strictEqual(row.in_deck_qty, 2, `two are committed, got ${row.in_deck_qty}`);
    assert.strictEqual(row.available_qty, 1,
      `only one copy is genuinely free; got ${row.available_qty}`);
  });

test('F15-TC39', 'a card with ZERO available is still addable, and reads as MISSING',
  async ({ availability7 }) => {
    // Zach: "and then even farther it marks it as missing". Zero available is
    // not a refusal -- planning a deck you have not finished buying is normal.
    // The requirement is created and simply reports the shortfall.
    const user = availability7;
    await ownCopy(user.token, 'ci-shock');

    const hoarder = await api(user.token, '/api/decks', {
      method: 'POST', body: { name: 'PR6G Zero Avail Other', format: 'Modern', target_size: 60 }
    });
    assert.strictEqual(hoarder.status, 201, JSON.stringify(hoarder.body));
    const claim = await api(user.token, `/api/decks/${hoarder.body.id}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-shock', desired_finish: 'nonfoil', quantity: 1 }
    });
    assert.strictEqual(claim.status, 200, JSON.stringify(claim.body));

    // The search reports the truth: owned, but none free.
    const search = await api(user.token, '/api/search?name=Shock Test&scope=database');
    const row = (search.body || []).find(c => c.id === 'ci-shock');
    assert.ok(row, JSON.stringify(search.body));
    assert.strictEqual(row.owned_qty, 1, `owned must be 1, got ${row.owned_qty}`);
    assert.strictEqual(row.available_qty, 0,
      `the only copy is committed elsewhere; got ${row.available_qty}`);

    // ADDABLE ANYWAY, into a second deck, and marked missing there.
    const second = await api(user.token, '/api/decks', {
      method: 'POST', body: { name: 'PR6G Zero Avail Target', format: 'Modern', target_size: 60 }
    });
    assert.strictEqual(second.status, 201, JSON.stringify(second.body));
    const add = await api(user.token, `/api/decks/${second.body.id}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-shock', desired_finish: 'nonfoil', quantity: 1 }
    });
    assert.strictEqual(add.status, 200,
      `a card with none free must still be addable as a requirement: ${JSON.stringify(add.body)}`);

    const entry = (add.body.cards || []).find(
      c => c.desired_card_id === 'ci-shock' && c.board === 'mainboard'
    );
    assert.ok(entry, `the requirement must come back in the deck view: ${JSON.stringify(add.body)}`);
    assert.strictEqual(entry.quantity_missing, 1,
      `the entry must read as missing, got ${JSON.stringify(entry)}`);

    // And the row actually exists in the database, not just in the response.
    const rows = await deckRows(second.body.id);
    assert.ok(rows.some(r => r.desired_card_id === 'ci-shock'),
      'the requirement must be a real row');
  });

test('F15-TC40', 'an UNOWNED search result reports zero available, not undefined',
  async ({ availability8 }) => {
    // "do I even have this" must have an answer for a card the user has never
    // owned. Undefined would render as blank and read as "unknown", which is
    // the second lookup the inline count exists to remove.
    const search = await api(availability8.token, '/api/search?name=Unowned Test&scope=database');
    const row = (search.body || []).find(c => c.id === 'ci-unowned');
    assert.ok(row, JSON.stringify(search.body));
    assert.strictEqual(row.owned_qty, 0, `owned must be 0, got ${row.owned_qty}`);
    assert.strictEqual(row.available_qty, 0,
      `available must be an explicit 0, got ${JSON.stringify(row.available_qty)}`);
  });

test('F15-TC41', 'the BULK ADD pre-flight names an unverified card without failing the batch',
  async ({ owner }) => {
    // The batch paths make no per-card network call by design, so an unverified
    // row would otherwise hit the choke point's 503 and fail the WHOLE
    // selection over one card the app has never read. It is named in the
    // pre-flight instead, and it is NOT called illegal.
    const deckId = await createDeck(owner.token, 'PR6G Bulk Unverified', ['ci-cmd-ur']);
    const goodEntry = await ownCopy(owner.token, 'ci-red-bolt');
    const thinEntry = await ownCopy(owner.token, 'ci-thin-batch');

    const response = await api(owner.token, '/api/collection/bulk', {
      method: 'POST',
      body: { entry_ids: [goodEntry, thinEntry], action: 'add_to_deck', value: String(deckId) }
    });

    assert.strictEqual(response.status, 409,
      `the pre-flight must report before writing: ${JSON.stringify(response.body)}`);
    const problems = (response.body || {}).problems || [];
    const problem = problems.find(p => p.code === 'COMMANDER_VERIFY_UNAVAILABLE');
    assert.ok(problem, `the unverified card must be named: ${JSON.stringify(problems)}`);
    assert.ok(/thin batch/i.test(String(problem.message)),
      `the problem must name the card: ${problem.message}`);
    // NOT a colour ruling. Anchored on the affirmative claim the colour refusal
    // makes ("its colour identity includes X"), not on the word "illegal" --
    // the honest message uses that word to DENY the claim, so a naive match
    // fires on the very sentence that proves the behaviour is right.
    assert.ok(!/colour identity includes/i.test(String(problem.message)),
      `an unverified card must not be given a colour ruling: ${problem.message}`);
    assert.ok(/could not|has never read|cannot verify/i.test(String(problem.message)),
      `the message must say the app could not check: ${problem.message}`);
    // The legal card is still applicable -- one unknown must not sink the rest.
    assert.strictEqual(response.body.applicable, 1,
      `the verified card must still be applicable: ${JSON.stringify(response.body)}`);

    // NOTHING WAS WRITTEN.
    const rows = await deckRows(deckId);
    assert.ok(!rows.some(r => r.desired_card_id === 'ci-thin-batch'),
      'an unverified card must not be written');
  });

test('F15-TC42', 'IMPORT reports an unverified line in the pre-flight, not as a 503',
  async ({ owner }) => {
    // Same reasoning on the paste path: one unreadable line must not fail a
    // whole decklist, and must not be reported as a colour ruling either.
    const deckId = await createDeck(owner.token, 'PR6G Import Unverified', ['ci-cmd-ur']);

    const response = await api(owner.token, `/api/decks/${deckId}/import`, {
      method: 'POST',
      body: {
        lines: [
          { name: 'Thin Import Test', quantity: 1 },
          { name: 'Bolt Test', quantity: 1 }
        ],
        apply: false
      }
    });

    assert.strictEqual(response.status, 200,
      `an unverified line must not turn the paste into an error: ${JSON.stringify(response.body)}`);
    const refused = (response.body.lines || []).filter(l => l.refused);
    assert.ok(refused.some(line => /thin import/i.test(line.name)),
      `the unverified line must be refused by name: ${JSON.stringify(response.body.lines)}`);
    const line = refused.find(l => /thin import/i.test(l.name));
    // Same anchoring as TC41: the affirmative colour claim, not the word
    // "illegal" which the honest message uses to deny it.
    assert.ok(!/colour identity includes/i.test(String(line.refusal_reason)),
      `an unverified line must not be given a colour ruling: ${line.refusal_reason}`);
    assert.ok(/could not|has never read|cannot verify/i.test(String(line.refusal_reason)),
      `the reason must say the app could not check: ${line.refusal_reason}`);
    // And the legal line beside it is untouched -- one unreadable card must not
    // sink the whole paste.
    assert.ok(!refused.some(l => /bolt/i.test(l.name)),
      `the verified line must still be importable: ${JSON.stringify(response.body.lines)}`);
  });

// ===========================================================================
// ITEM 4 -- THE INVARIANT: AFTER ANY MUTATION, EVERY CARD IN A COMMANDER DECK
// IS WITHIN THE CURRENT COMMANDER(S) COLOUR IDENTITY.
//
// The PR 6G review found the PR 6F shape again: validation judged the INCOMING
// change rather than the RESULTING STATE, so a DELETE slipped through. Removing
// a commander narrows (or empties) the deck's identity under cards already in
// it, and nothing re-judged the deck it left behind.
//
// These cases are written as SEQUENCES, because the defect is not reachable by
// any single request -- every individual step looked legal. The assertion is
// always about the deck's ROWS at the end, never about a status code alone.
// ===========================================================================

// ===========================================================================
// ZACH'S RULING (2026-08-19), VERBATIM:
//
//   "You cant outright delete the commander only swap and when swapping you
//    should get a warning if the swap is to a different color type."
//
// This SUPERSEDES the earlier TC47 refusal, and it changes the shape of the
// feature rather than just its wording. Two halves:
//
//   1. THERE IS NO DELETE-COMMANDER OPERATION AT ALL. Not "refused when it
//      would strand cards" -- refused always, on any Commander deck, empty or
//      not. PR 6F already refuses to CREATE a Commander deck without a
//      commander; permitting deletion afterwards was a hole in that same rule,
//      reachable one request later. A Commander deck ALWAYS has a commander.
//      Removing one half of a partner pair is not exempt: going from two
//      commanders to one is a SWAP OF THE ZONE, so it goes through the same
//      plan-and-confirm path as any other swap.
//
//   2. THE WARNING IS NOT UNCONDITIONAL. It fires only when the swap ACTUALLY
//      STRANDS CARDS. Same identity, or a broader one, removes nothing and must
//      apply cleanly -- no warning, no confirmation. A dialog that always
//      appears is a dialog the user learns to click through without reading,
//      which destroys the value of the one that matters.
//
// Repro A is now STRUCTURALLY UNREACHABLE rather than merely guarded: the
// empty-command-zone state can no longer be arrived at through the API, so the
// accept-anything window has no way to exist. The empty-zone-admits-nothing
// semantics stay as defence in depth (TC46).
// ===========================================================================

test('F15-TC43', 'REPRO A is UNREACHABLE: the command zone cannot be emptied at all',
  async ({ owner }) => {
    // The reviewer's sequence began with DELETE of the commander row. Under the
    // ruling that first step no longer exists, so the rest of the sequence has
    // nothing to stand on. Asserted as the ROWS at the end, as always.
    const deckId = await createDeck(owner.token, 'PR6G Repro A', ['ci-cmd-ur']);
    const commanderRow = (await deckRows(deckId)).find(r => r.board === 'commander');

    // Step 1 is REFUSED outright -- and on an EMPTY deck, where nothing would be
    // stranded. The rule is about the deck always having a commander, not about
    // consequences.
    const deleted = await api(owner.token, `/api/decks/${deckId}/cards/${commanderRow.id}`, {
      method: 'DELETE'
    });
    assert.strictEqual(deleted.status, 409,
      `a commander may never be deleted, only swapped: ${JSON.stringify(deleted.body)}`);
    assert.strictEqual(deleted.body && deleted.body.code, 'COMMANDER_DELETE_UNSUPPORTED',
      `the refusal must name the unsupported operation: ${JSON.stringify(deleted.body)}`);
    assert.ok(/swap/i.test(JSON.stringify(deleted.body)),
      `the refusal must point the user at the swap: ${JSON.stringify(deleted.body)}`);

    // The zone is INTACT, so the window Repro A walked through never opens.
    assert.ok((await deckRows(deckId)).some(r => r.board === 'commander'),
      'the commander must still be in the command zone after a refused delete');

    // Step 2 therefore meets a deck that still has its [U,R] identity, and the
    // green card is refused on ordinary colour grounds.
    const green = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-kodama', desired_finish: 'nonfoil' }
    });
    assert.notStrictEqual(green.status, 200,
      `a green card must never enter an Izzet deck: ${JSON.stringify(green.body)}`);

    const rows = await deckRows(deckId);
    assert.ok(!rows.some(r => r.desired_card_id === 'ci-kodama'),
      `INVARIANT BROKEN: deck holds a green card: ${JSON.stringify(rows)}`);
  });

test('F15-TC44', 'removing one half of a PARTNER PAIR goes through the SWAP path, not a bare delete',
  async ({ owner }) => {
    // Zach's ruling applies to a SECOND commander too. Dropping one half of a
    // legal pair is a swap of the zone from two commanders to one -- so it is
    // refused as a delete and must be done through the swap, which is where the
    // stranding warning lives.
    const deckId = await createDeck(owner.token, 'PR6G Repro B',
      ['ci-partner-r', 'ci-partner-g']);

    const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST', body: { desired_card_id: 'ci-kodama', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(add.status, 200,
      `a green card is legal under an [R,G] pair: ${JSON.stringify(add.body)}`);

    const before = await deckRows(deckId);
    const greenPartner = before.find(r => r.desired_card_id === 'ci-partner-g');

    // A BARE DELETE OF A COMMANDER ROW IS UNSUPPORTED -- even with the removal
    // confirmation, which is not the missing ingredient. There is no delete.
    const removed = await api(owner.token, `/api/decks/${deckId}/cards/${greenPartner.id}`, {
      method: 'DELETE',
      body: { confirm_remove_off_identity: true }
    });
    assert.strictEqual(removed.status, 409,
      `deleting one half of a pair must be refused as a delete: `
      + `${JSON.stringify(removed.body)}`);
    assert.strictEqual(removed.body && removed.body.code, 'COMMANDER_DELETE_UNSUPPORTED',
      `it is the same unsupported-operation refusal: ${JSON.stringify(removed.body)}`);
    assert.ok(/swap/i.test(JSON.stringify(removed.body)),
      `the refusal must point at the swap: ${JSON.stringify(removed.body)}`);

    // NOTHING HAS HAPPENED. A refused delete is byte-for-byte inert.
    const after = await deckRows(deckId);
    assert.deepStrictEqual(
      after.map(r => `${r.id}|${r.board}|${r.desired_card_id}|${r.quantity}`),
      before.map(r => `${r.id}|${r.board}|${r.desired_card_id}|${r.quantity}`),
      'a refused commander delete must leave the deck byte-for-byte as it was'
    );

    // AND THE SWAP PATH IS THE WAY THROUGH, carrying the warning. Replacing the
    // GREEN partner with a second RED one narrows [R,G] to [R] and strands the
    // green card, so the user is asked and the card is NAMED.
    const swap = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        desired_card_id: 'ci-partner-r2', desired_finish: 'nonfoil', board: 'commander',
        replacing_deck_card_id: greenPartner.id
      }
    });
    assert.strictEqual(swap.status, 409,
      `the narrowing swap must ask first: ${JSON.stringify(swap.body)}`);
    assert.strictEqual(swap.body && swap.body.code, 'COMMANDER_SWAP_REMOVES_CARDS',
      `the warning must carry the code the client already handles: `
      + `${JSON.stringify(swap.body)}`);
    assert.ok(Array.isArray(swap.body.removing) && swap.body.removing.length === 1,
      `the warning must name exactly the stranded card: ${JSON.stringify(swap.body)}`);
    assert.ok(/kodama/i.test(swap.body.removing[0].name),
      `the stranded green card must be named: ${JSON.stringify(swap.body.removing)}`);
    assert.strictEqual(swap.body.removing_count, 1, 'the warning must carry a count');
  });

test('F15-TC45', 'a CONFIRMED narrowing swap applies the swap and the removals ATOMICALLY',
  async ({ owner }) => {
    const deckId = await createDeck(owner.token, 'PR6G Partner Swap Apply',
      ['ci-partner-r', 'ci-partner-g']);
    for (const cardId of ['ci-kodama', 'ci-red-bolt', 'ci-solring']) {
      const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil' }
      });
      assert.strictEqual(add.status, 200, `${cardId}: ${JSON.stringify(add.body)}`);
    }
    const greenPartner = (await deckRows(deckId)).find(r => r.desired_card_id === 'ci-partner-g');

    // Swap the green partner out for a second red partner, confirming the
    // removals. A legal pair whose union narrows [R,G] to [R].
    const applied = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        desired_card_id: 'ci-partner-r2', desired_finish: 'nonfoil', board: 'commander',
        replacing_deck_card_id: greenPartner.id,
        confirm_remove_off_identity: true
      }
    });
    assert.strictEqual(applied.status, 200,
      `a confirmed swap must apply: ${JSON.stringify(applied.body)}`);

    const rows = await deckRows(deckId);
    // BOTH halves landed, and EXACTLY those.
    assert.ok(!rows.some(r => r.desired_card_id === 'ci-partner-g'),
      'the swapped-out partner must be gone');
    assert.ok(rows.some(r => r.board === 'commander' && r.desired_card_id === 'ci-partner-r2'),
      'the incoming commander must be in the command zone');
    assert.ok(!rows.some(r => r.desired_card_id === 'ci-kodama'),
      'the stranded green card must have been removed with it');
    assert.ok(rows.some(r => r.desired_card_id === 'ci-red-bolt'),
      'the still-legal red card must survive');
    assert.ok(rows.some(r => r.desired_card_id === 'ci-solring'),
      'the colourless card must survive');
    // THE ZONE IS NEVER EMPTY along the way: a deck that always has a commander
    // is the whole point of the ruling.
    assert.ok(rows.some(r => r.board === 'commander'),
      'the command zone must never be left empty by a swap');
  });

test('F15-TC46', 'an EMPTY command zone is UNREACHABLE through the API', async ({ owner }) => {
  // Under the ruling this state can no longer be ARRIVED AT: there is no delete
  // and no swap that empties the zone. The choke point's empty-zone refusal
  // stays as defence in depth and is exercised directly below, but the API
  // itself must offer no route to the state at all -- including on a deck with
  // NO cards, where the old code allowed it because nothing would be stranded.
  const deckId = await createDeck(owner.token, 'PR6G Empty Zone', ['ci-cmd-ur']);
  const commanderRow = (await deckRows(deckId)).find(r => r.board === 'commander');

  const deleted = await api(owner.token, `/api/decks/${deckId}/cards/${commanderRow.id}`, {
    method: 'DELETE'
  });
  assert.strictEqual(deleted.status, 409,
    `emptying the zone must be refused even when nothing would be stranded: `
    + `${JSON.stringify(deleted.body)}`);
  assert.strictEqual(deleted.body && deleted.body.code, 'COMMANDER_DELETE_UNSUPPORTED',
    `the refusal must name the unsupported operation: ${JSON.stringify(deleted.body)}`);
  assert.strictEqual((await deckRows(deckId)).length, 1,
    'the commander row must survive the refused delete');

  // THE DEFENCE IN DEPTH, exercised at the rule layer since the API can no
  // longer produce the state. An empty zone admits NOTHING -- not a green card,
  // and not even a colourless one, which is a subset of every identity but not
  // of "no identity at all".
  const emptyZone = commanderRules.colorIdentityOfZone([]);
  assert.strictEqual(emptyZone.status, commanderRules.ZONE_EMPTY,
    'a zone with no rows must report itself EMPTY, never colourless');
  assert.strictEqual(emptyZone.identity, null,
    'an empty zone has NO identity, which is not the same as an empty identity');

  // The ordinary path still works: an on-identity card goes in.
  const nowLegal = await api(owner.token, `/api/decks/${deckId}/cards`, {
    method: 'POST', body: { desired_card_id: 'ci-red-bolt', desired_finish: 'nonfoil' }
  });
  assert.strictEqual(nowLegal.status, 200,
    `an on-identity card must be addable: ${JSON.stringify(nowLegal.body)}`);
});

test('F15-TC47', 'a SAME-IDENTITY swap applies with NO warning and NO confirmation',
  async ({ owner }) => {
    // SUPERSEDES the old TC47, which asserted the delete-the-last-commander
    // refusal. Zach: the warning is for a swap "to a different color type", so a
    // swap that changes nothing about what the deck admits must be silent.
    // A confirmation dialog that always appears is one the user stops reading.
    const deckId = await createDeck(owner.token, 'PR6G Same Identity Swap', ['ci-cmd-ur']);
    for (const cardId of ['ci-red-bolt', 'ci-blue-counter', 'ci-solring']) {
      const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil' }
      });
      assert.strictEqual(add.status, 200, `${cardId}: ${JSON.stringify(add.body)}`);
    }
    const commanderRow = (await deckRows(deckId)).find(r => r.board === 'commander');

    // Izzet -> a DIFFERENT Izzet commander. Same [U,R], so nothing is stranded.
    // NOTE the absence of confirm_remove_off_identity: this must succeed on the
    // FIRST request, with no round trip through a question.
    const swap = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        desired_card_id: 'ci-cmd-ur-b', desired_finish: 'nonfoil', board: 'commander',
        replacing_deck_card_id: commanderRow.id
      }
    });
    assert.strictEqual(swap.status, 200,
      `a same-identity swap must apply cleanly on the first request, with no `
      + `confirmation step: ${JSON.stringify(swap.body)}`);
    assert.ok(!(swap.body && swap.body.code === 'COMMANDER_SWAP_REMOVES_CARDS'),
      `a swap that strands nothing must not warn: ${JSON.stringify(swap.body)}`);

    const rows = await deckRows(deckId);
    assert.ok(rows.some(r => r.board === 'commander' && r.desired_card_id === 'ci-cmd-ur-b'),
      'the new commander must be in the command zone');
    assert.ok(!rows.some(r => r.desired_card_id === 'ci-cmd-ur'),
      'the old commander must be gone');
    // NOTHING ELSE MOVED. A swap that removes nothing must remove nothing.
    for (const cardId of ['ci-red-bolt', 'ci-blue-counter', 'ci-solring']) {
      assert.ok(rows.some(r => r.desired_card_id === cardId),
        `${cardId} must survive a swap that strands nothing: ${JSON.stringify(rows)}`);
    }
  });

test('F15-TC47b', 'a BROADER-identity swap applies with NO warning either',
  async ({ owner }) => {
    // Izzet [U,R] -> Temur [U,R,G]. The identity CHANGES, but it only WIDENS:
    // every card that fitted before still fits, so nothing is stranded and
    // there is nothing to ask about. The rule is "does this strand cards", not
    // "is the colour string different" -- that distinction is the whole of
    // part 2 of the ruling.
    const deckId = await createDeck(owner.token, 'PR6G Broader Swap', ['ci-cmd-ur']);
    for (const cardId of ['ci-red-bolt', 'ci-blue-counter', 'ci-solring']) {
      const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil' }
      });
      assert.strictEqual(add.status, 200, `${cardId}: ${JSON.stringify(add.body)}`);
    }
    const commanderRow = (await deckRows(deckId)).find(r => r.board === 'commander');
    const before = await deckRows(deckId);

    const swap = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        desired_card_id: 'ci-cmd-urg', desired_finish: 'nonfoil', board: 'commander',
        replacing_deck_card_id: commanderRow.id
      }
    });
    assert.strictEqual(swap.status, 200,
      `a widening swap strands nothing and must apply cleanly: `
      + `${JSON.stringify(swap.body)}`);
    assert.ok(!(swap.body && swap.body.code === 'COMMANDER_SWAP_REMOVES_CARDS'),
      `a widening swap must not warn: ${JSON.stringify(swap.body)}`);

    const rows = await deckRows(deckId);
    assert.ok(rows.some(r => r.board === 'commander' && r.desired_card_id === 'ci-cmd-urg'),
      'the broader commander must be in the command zone');
    // EXACTLY the contents that were there before, unchanged.
    assert.deepStrictEqual(
      rows.filter(r => r.board !== 'commander').map(r => r.desired_card_id).sort(),
      before.filter(r => r.board !== 'commander').map(r => r.desired_card_id).sort(),
      'a widening swap must remove nothing at all'
    );

    // ...and the deck now genuinely admits green, proving the widening landed.
    const green = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST', body: { desired_card_id: 'ci-kodama', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(green.status, 200,
      `the widened identity must actually admit green: ${JSON.stringify(green.body)}`);
  });

test('F15-TC47c', 'CANCELLING a narrowing swap changes NOTHING',
  async ({ owner }) => {
    // The unconfirmed warning is a QUESTION. "Cancel" in the UI is simply never
    // sending the confirmed request, so the assertion is that the warned-about
    // request left the database byte-for-byte identical.
    const deckId = await createDeck(owner.token, 'PR6G Cancel Swap', ['ci-cmd-urg']);
    for (const cardId of ['ci-kodama', 'ci-red-bolt', 'ci-blue-counter']) {
      const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil' }
      });
      assert.strictEqual(add.status, 200, `${cardId}: ${JSON.stringify(add.body)}`);
    }
    const commanderRow = (await deckRows(deckId)).find(r => r.board === 'commander');
    const before = await deckRows(deckId);

    // Temur [U,R,G] -> Izzet [U,R] strands the green card.
    const warned = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        desired_card_id: 'ci-cmd-ur', desired_finish: 'nonfoil', board: 'commander',
        replacing_deck_card_id: commanderRow.id
      }
    });
    assert.strictEqual(warned.status, 409,
      `a narrowing swap must ask: ${JSON.stringify(warned.body)}`);
    assert.strictEqual(warned.body && warned.body.code, 'COMMANDER_SWAP_REMOVES_CARDS',
      `${JSON.stringify(warned.body)}`);
    assert.ok(/kodama/i.test(JSON.stringify(warned.body.removing)),
      `the stranded card must be named: ${JSON.stringify(warned.body.removing)}`);

    // The user cancels: the confirmed request is never sent. NOTHING moved.
    const after = await deckRows(deckId);
    assert.deepStrictEqual(
      after.map(r => `${r.id}|${r.board}|${r.desired_card_id}|${r.quantity}`),
      before.map(r => `${r.id}|${r.board}|${r.desired_card_id}|${r.quantity}`),
      'a cancelled swap must leave the deck byte-for-byte as it was'
    );
  });

test('F15-TC47d', 'NON-COMMANDER formats are entirely unaffected by the delete rule',
  async ({ owner }) => {
    // The ruling is a Commander-format rule. A Modern deck has no command zone,
    // pays for none of this, and its cards delete exactly as they always have.
    // A rule that leaks into another format is a bug even when the rule is
    // right, and this is the case that catches it.
    const deckId = await createDeck(owner.token, 'PR6G Modern Unaffected', [], 'Modern');
    for (const cardId of ['ci-kodama', 'ci-red-bolt']) {
      const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil' }
      });
      assert.strictEqual(add.status, 200,
        `a Modern deck takes any colours: ${JSON.stringify(add.body)}`);
    }
    const rows = await deckRows(deckId);
    const target = rows.find(r => r.desired_card_id === 'ci-kodama');

    const removed = await api(owner.token, `/api/decks/${deckId}/cards/${target.id}`, {
      method: 'DELETE'
    });
    assert.strictEqual(removed.status, 200,
      `an ordinary delete in a non-Commander deck must still work: `
      + `${JSON.stringify(removed.body)}`);

    const after = await deckRows(deckId);
    assert.ok(!after.some(r => r.desired_card_id === 'ci-kodama'), 'the card must be gone');
    assert.ok(after.some(r => r.desired_card_id === 'ci-red-bolt'), 'the other card must survive');
  });

test('F15-TC47e', 'an ordinary card delete in a COMMANDER deck is unaffected',
  async ({ owner }) => {
    // The refusal is scoped to the COMMANDER BOARD. Removing a card from the 99
    // is an everyday operation and must stay a single unconfirmed request --
    // otherwise the rule has quietly made the common case harder.
    const deckId = await createDeck(owner.token, 'PR6G Ordinary Delete', ['ci-cmd-ur']);
    const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST', body: { desired_card_id: 'ci-red-bolt', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));

    const target = (await deckRows(deckId)).find(r => r.desired_card_id === 'ci-red-bolt');
    const removed = await api(owner.token, `/api/decks/${deckId}/cards/${target.id}`, {
      method: 'DELETE'
    });
    assert.strictEqual(removed.status, 200,
      `removing a card from the 99 must stay one request: ${JSON.stringify(removed.body)}`);

    const after = await deckRows(deckId);
    assert.ok(!after.some(r => r.desired_card_id === 'ci-red-bolt'), 'the card must be gone');
    assert.ok(after.some(r => r.board === 'commander'), 'the commander must be untouched');
  });

test('F15-TC47f', 'DROPPING a partner that strands cards warns, names them, and applies atomically',
  async ({ owner }) => {
    // The other way to arrive at a narrower zone: drop one half of a pair
    // rather than replace it. Zach's ruling says that is a swap of the zone, so
    // it must behave EXACTLY like one -- same warning, same naming, same
    // confirmation, same atomicity. Two ways to reach one zone must not
    // disagree about what it strands.
    const deckId = await createDeck(owner.token, 'PR6G Drop Partner',
      ['ci-partner-r', 'ci-partner-g']);
    for (const cardId of ['ci-kodama', 'ci-red-bolt', 'ci-solring']) {
      const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil' }
      });
      assert.strictEqual(add.status, 200, `${cardId}: ${JSON.stringify(add.body)}`);
    }
    const before = await deckRows(deckId);
    const greenPartner = before.find(r => r.desired_card_id === 'ci-partner-g');

    // UNCONFIRMED: a question, and nothing moves.
    const warned = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { drop_commander_deck_card_id: greenPartner.id }
    });
    assert.strictEqual(warned.status, 409,
      `dropping a partner that strands cards must ask first: ${JSON.stringify(warned.body)}`);
    assert.strictEqual(warned.body && warned.body.code, 'COMMANDER_SWAP_REMOVES_CARDS',
      `it must be the SAME warning a replacement swap gives: ${JSON.stringify(warned.body)}`);
    assert.ok(Array.isArray(warned.body.removing) && warned.body.removing.length === 1,
      `the stranded card must be named: ${JSON.stringify(warned.body)}`);
    assert.ok(/kodama/i.test(warned.body.removing[0].name),
      `${JSON.stringify(warned.body.removing)}`);
    assert.strictEqual(warned.body.removing_count, 1, 'the warning must carry a count');

    assert.deepStrictEqual(
      (await deckRows(deckId)).map(r => `${r.id}|${r.board}|${r.desired_card_id}`),
      before.map(r => `${r.id}|${r.board}|${r.desired_card_id}`),
      'an unconfirmed drop must leave the deck byte-for-byte as it was'
    );

    // CONFIRMED: the drop and the removal land together.
    const applied = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        drop_commander_deck_card_id: greenPartner.id,
        confirm_remove_off_identity: true
      }
    });
    assert.strictEqual(applied.status, 200,
      `a confirmed drop must apply: ${JSON.stringify(applied.body)}`);

    const rows = await deckRows(deckId);
    assert.ok(!rows.some(r => r.desired_card_id === 'ci-partner-g'),
      'the dropped partner must be gone');
    assert.ok(!rows.some(r => r.desired_card_id === 'ci-kodama'),
      'the stranded green card must have gone with it');
    assert.ok(rows.some(r => r.desired_card_id === 'ci-red-bolt'),
      'the still-legal red card must survive');
    assert.ok(rows.some(r => r.desired_card_id === 'ci-solring'),
      'the colourless card must survive');
    assert.strictEqual(rows.filter(r => r.board === 'commander').length, 1,
      'the zone must end at exactly one commander');
  });

// ---------------------------------------------------------------------------
// DROPPING A PARTNER: the highest-risk zone change.
//
// F15-TC47f covers the happy warn-then-apply path. The cases below exist
// because dropping a partner can ONLY narrow the deck's identity or leave it
// unchanged -- it can never broaden it -- so it is the one zone change that
// always risks stranding cards. This path was also added after the round-1
// review, so it is the least-witnessed code in the PR.
//
// Every case asserts on DATABASE ROWS and on the RESULTING STATE, not on a
// status code or on the response alone: the question is what the user's deck
// actually contains afterwards.
// ---------------------------------------------------------------------------

test('F15-TC47g', 'an UNCONFIRMED drop reports the exact cards and count, and writes NOTHING',
  async ({ owner }) => {
    // The warning is the user's only chance to say no, so it has to be
    // ACCURATE: the right count and the right names. A warning that said "1
    // card" while three were about to go would be worse than no warning,
    // because the user would have consented to something that did not happen.
    const deckId = await createDeck(owner.token, 'PR6G Drop Names',
      ['ci-partner-r', 'ci-partner-g']);
    // Three green cards strand; a red one and a colourless one do not. That
    // asymmetry is what makes an over- or under-count visible.
    for (const cardId of ['ci-kodama', 'ci-green-land', 'ci-forest',
      'ci-red-bolt', 'ci-solring']) {
      const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil' }
      });
      assert.strictEqual(add.status, 200, `${cardId}: ${JSON.stringify(add.body)}`);
    }
    const before = await deckFingerprint(deckId);
    const greenPartner = (await deckRows(deckId)).find(r => r.desired_card_id === 'ci-partner-g');

    const warned = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { drop_commander_deck_card_id: greenPartner.id }
    });

    assert.strictEqual(warned.status, 409,
      `a stranding drop must ask first: ${JSON.stringify(warned.body)}`);
    assert.strictEqual(warned.body && warned.body.code, 'COMMANDER_SWAP_REMOVES_CARDS',
      `it must reuse the swap warning the client already handles: `
      + `${JSON.stringify(warned.body)}`);
    // THE CLIENT IS TOLD HOW TO PROCEED. Without this the warning is a dead
    // end, which is the failure mode the whole confirm design exists to avoid.
    assert.strictEqual(warned.body.requires_confirmation, 'confirm_remove_off_identity',
      `the warning must name the confirmation that unblocks it: `
      + `${JSON.stringify(warned.body)}`);

    // EXACTLY the three green cards, named. Compared as a sorted set so the
    // assertion is about WHICH cards, not about the planner's ordering.
    const named = (warned.body.removing || []).map(c => c.name).sort();
    assert.deepStrictEqual(named, ['Forest', 'Green Land Test', 'Kodama Test'],
      `the warning must name exactly the stranded cards: `
      + `${JSON.stringify(warned.body.removing)}`);
    assert.strictEqual(warned.body.removing_count, 3,
      `the count must match the named list, got ${warned.body.removing_count}`);
    // The count and the list are two renderings of one fact and must not drift.
    assert.strictEqual(warned.body.removing_count, (warned.body.removing || []).length,
      `removing_count must equal the length of removing: ${JSON.stringify(warned.body)}`);

    // The still-legal cards are NOT threatened. An over-broad warning would
    // scare the user into cancelling a change that was safe.
    assert.ok(!named.some(name => /Bolt|Sol Ring/i.test(name)),
      `on-identity cards must not be listed for removal: ${JSON.stringify(named)}`);

    // AND NOTHING WAS WRITTEN -- rows and allocations both.
    assert.deepStrictEqual(await deckFingerprint(deckId), before,
      'an unconfirmed drop must leave the deck byte-for-byte as it was');
  });

test('F15-TC47h', 'a CONFIRMED drop removes EXACTLY the stranded cards, atomically',
  async ({ owner }) => {
    // The other half of TC47g: having consented to a NAMED list, the user must
    // get precisely that list removed. Over-removal destroys legal cards;
    // under-removal leaves the deck holding cards it cannot cast. Both are
    // silent, and both are only visible by checking the surviving rows exactly.
    const deckId = await createDeck(owner.token, 'PR6G Drop Exact',
      ['ci-partner-r', 'ci-partner-g']);
    for (const cardId of ['ci-kodama', 'ci-green-land', 'ci-forest',
      'ci-red-bolt', 'ci-solring']) {
      const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil' }
      });
      assert.strictEqual(add.status, 200, `${cardId}: ${JSON.stringify(add.body)}`);
    }
    const before = await deckRows(deckId);
    const greenPartner = before.find(r => r.desired_card_id === 'ci-partner-g');
    const redPartnerId = before.find(r => r.desired_card_id === 'ci-partner-r').id;

    const applied = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        drop_commander_deck_card_id: greenPartner.id,
        confirm_remove_off_identity: true
      }
    });
    assert.strictEqual(applied.status, 200,
      `a confirmed drop must apply: ${JSON.stringify(applied.body)}`);

    // THE SURVIVORS ARE ASSERTED AS A COMPLETE SET, not spot-checked. A
    // whitelist of "these are gone" would pass even if the drop had also
    // deleted something it was never asked to touch.
    const after = await deckRows(deckId);
    assert.deepStrictEqual(
      after.map(r => r.desired_card_id).sort(),
      ['ci-partner-r', 'ci-red-bolt', 'ci-solring'],
      `exactly the on-identity cards must survive: ${JSON.stringify(after)}`
    );
    // The dropped COMMANDER ROW ITSELF is gone -- by id, so a row that was
    // recreated rather than removed would still fail here.
    assert.ok(!after.some(r => r.id === greenPartner.id),
      `the dropped commander row must be gone: ${JSON.stringify(after)}`);
    // And the surviving commander is the SAME ROW, untouched -- not deleted and
    // re-added, which would silently reset anything hanging off its id.
    const commanders = after.filter(r => r.board === 'commander');
    assert.strictEqual(commanders.length, 1,
      `the zone must end at exactly one commander: ${JSON.stringify(commanders)}`);
    assert.strictEqual(commanders[0].id, redPartnerId,
      'the surviving commander must be the untouched original row');

    // No allocation may outlive the deck entry it pointed at.
    const orphans = await db.all(
      `SELECT a.id FROM deck_card_allocations a
       LEFT JOIN deck_cards dc ON a.deck_card_id = dc.id
       WHERE dc.id IS NULL`
    );
    assert.deepStrictEqual(orphans, [], 'no allocation may outlive its deck entry');

    // THE RESULTING STATE, judged on its own terms.
    await assertDeckWithinCommanderIdentity(deckId, 'after a confirmed drop');
  });

test('F15-TC47i', 'a drop the user never confirms leaves the deck completely unchanged',
  async ({ owner }) => {
    // The cancel path. TC47g proves the warning does not write; this proves the
    // deck is still fully intact and USABLE afterwards -- the user backed out,
    // so their deck must be exactly the deck they had, including the commander
    // zone they were about to change.
    const deckId = await createDeck(owner.token, 'PR6G Drop Cancel',
      ['ci-partner-r', 'ci-partner-g']);
    for (const cardId of ['ci-kodama', 'ci-red-bolt', 'ci-solring']) {
      const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil' }
      });
      assert.strictEqual(add.status, 200, `${cardId}: ${JSON.stringify(add.body)}`);
    }
    const before = await deckFingerprint(deckId);

    const greenPartner = (await deckRows(deckId)).find(r => r.desired_card_id === 'ci-partner-g');
    const warned = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { drop_commander_deck_card_id: greenPartner.id }
    });
    assert.strictEqual(warned.status, 409, JSON.stringify(warned.body));

    // THE USER CANCELS: the confirmed request is simply never sent. Silence is
    // not consent, so the absence of a second request must be the end of it.
    assert.deepStrictEqual(await deckFingerprint(deckId), before,
      'a cancelled drop must leave the deck byte-for-byte as it was');

    // BOTH commanders are still in the zone, so the deck is unchanged in the
    // way the user actually cares about.
    const after = await deckRows(deckId);
    assert.deepStrictEqual(
      after.filter(r => r.board === 'commander').map(r => r.desired_card_id).sort(),
      ['ci-partner-g', 'ci-partner-r'],
      `the command zone must still hold both partners: ${JSON.stringify(after)}`
    );
    assert.strictEqual(after.length, before.rows.length,
      'the deck must still hold the same number of rows');
    // The green card is still legal, because the zone that made it legal is
    // still there.
    await assertDeckWithinCommanderIdentity(deckId, 'after a cancelled drop');
  });

test('F15-TC47j', 'dropping a partner that strands NOTHING applies with no confirmation',
  async ({ owner }) => {
    // A pair of [R] and [] is a RED deck. Dropping the colourless half leaves
    // [R]: identical, nothing stranded. The warning exists to report removals,
    // so with none to report the drop must be a single ordinary request.
    //
    // Prompting here would be worse than noise: it trains the user to click
    // through a confirmation that is usually harmless, which is exactly how the
    // one that DOES remove three cards gets waved past.
    const deckId = await createDeck(owner.token, 'PR6G Drop Subset',
      ['ci-partner-r', 'ci-partner-c']);
    for (const cardId of ['ci-red-bolt', 'ci-solring']) {
      const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil' }
      });
      assert.strictEqual(add.status, 200, `${cardId}: ${JSON.stringify(add.body)}`);
    }
    const before = await deckRows(deckId);
    const colourless = before.find(r => r.desired_card_id === 'ci-partner-c');

    // NO confirmation flag is sent, deliberately. If the route asks anyway,
    // this is a 409 and the case fails -- which is the point.
    const applied = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { drop_commander_deck_card_id: colourless.id }
    });
    assert.strictEqual(applied.status, 200,
      `a drop that strands nothing must not ask: ${JSON.stringify(applied.body)}`);

    const after = await deckRows(deckId);
    // The dropped commander is gone and NOTHING ELSE IS. Asserted as a complete
    // set, so a stray removal cannot hide.
    assert.deepStrictEqual(
      after.map(r => r.desired_card_id).sort(),
      ['ci-partner-r', 'ci-red-bolt', 'ci-solring'],
      `only the dropped commander may go: ${JSON.stringify(after)}`
    );
    assert.strictEqual(after.length, before.length - 1,
      `exactly one row may disappear: ${before.length} -> ${after.length}`);
    assert.deepStrictEqual(
      after.filter(r => r.board === 'commander').map(r => r.desired_card_id),
      ['ci-partner-r'], 'the surviving commander must be the one the user kept');

    await assertDeckWithinCommanderIdentity(deckId, 'after a no-op-narrowing drop');
  });

test('F15-TC47k', 'a confirmed drop RELEASES the removed cards but never touches the binder',
  async ({ dropAvailability }) => {
    // The rule Zach set for this whole app: software that tracks PHYSICAL
    // objects must never silently change what the user owns. Removing a card
    // from a deck frees the copy for other decks -- it does not make the
    // cardboard vanish from the binder.
    //
    // Its own user, because the availability figures under test are
    // whole-collection totals that another case's decks would perturb.
    const user = dropAvailability;
    const kodamaCollectionId = await ownCopy(user.token, 'ci-kodama');
    const boltCollectionId = await ownCopy(user.token, 'ci-red-bolt');

    const collectionBefore = await db.all(
      `SELECT id, card_id, finish, quantity FROM collection WHERE user_id = ? ORDER BY id ASC`,
      [user.id]
    );
    assert.strictEqual(collectionBefore.length, 2, 'setup: two physical cards owned');

    const deckId = await createDeck(user.token, 'PR6G Drop Release',
      ['ci-partner-r', 'ci-partner-g']);
    for (const cardId of ['ci-kodama', 'ci-red-bolt']) {
      const add = await api(user.token, `/api/decks/${deckId}/cards`, {
        method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil' }
      });
      assert.strictEqual(add.status, 200, `${cardId}: ${JSON.stringify(add.body)}`);
    }

    // BOTH copies are spoken for while they are in the deck. Establishing this
    // first is what makes the release afterwards meaningful rather than a
    // figure that was always zero.
    const committed = await api(user.token, '/api/search?name=Kodama Test&scope=database');
    const committedRow = (committed.body || []).find(c => c.id === 'ci-kodama');
    assert.ok(committedRow, JSON.stringify(committed.body));
    assert.strictEqual(committedRow.available_qty, 0,
      `setup: the green copy must be committed to the deck, got ${committedRow.available_qty}`);

    const greenPartner = (await deckRows(deckId)).find(r => r.desired_card_id === 'ci-partner-g');
    const applied = await api(user.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        drop_commander_deck_card_id: greenPartner.id,
        confirm_remove_off_identity: true
      }
    });
    assert.strictEqual(applied.status, 200,
      `a confirmed drop must apply: ${JSON.stringify(applied.body)}`);

    // THE ALLOCATION IS RELEASED: the green copy is free again.
    const freed = await api(user.token, '/api/search?name=Kodama Test&scope=database');
    const freedRow = (freed.body || []).find(c => c.id === 'ci-kodama');
    assert.ok(freedRow, JSON.stringify(freed.body));
    assert.strictEqual(freedRow.owned_qty, 1,
      `the user still owns the card, got ${freedRow.owned_qty}`);
    assert.strictEqual(freedRow.in_deck_qty, 0,
      `the removed card must no longer be committed, got ${freedRow.in_deck_qty}`);
    assert.strictEqual(freedRow.available_qty, 1,
      `the freed copy must read as available, got ${freedRow.available_qty}`);

    // The card that SURVIVED is still committed. A release that freed
    // everything would look identical on the card above and be badly wrong.
    const stillIn = await api(user.token, '/api/search?name=Bolt Test&scope=database');
    const stillInRow = (stillIn.body || []).find(c => c.id === 'ci-red-bolt');
    assert.ok(stillInRow, JSON.stringify(stillIn.body));
    assert.strictEqual(stillInRow.available_qty, 0,
      `the surviving card must stay committed, got ${stillInRow.available_qty}`);

    // AND THE BINDER IS UNTOUCHED. Compared row for row, including quantities:
    // the physical cards are exactly as they were.
    const collectionAfter = await db.all(
      `SELECT id, card_id, finish, quantity FROM collection WHERE user_id = ? ORDER BY id ASC`,
      [user.id]
    );
    assert.deepStrictEqual(collectionAfter, collectionBefore,
      `a deck change must NEVER alter the physical collection: `
      + `${JSON.stringify(collectionAfter)}`);
    assert.ok(collectionAfter.some(r => r.id === kodamaCollectionId),
      'the removed card is still in the binder');
    assert.ok(collectionAfter.some(r => r.id === boltCollectionId),
      'the surviving card is still in the binder');

    await assertDeckWithinCommanderIdentity(deckId, 'after a drop that released a copy');
  });

test('F15-TC47l', 'the LAST commander is never droppable, and the refusal points at the swap',
  async ({ owner }) => {
    // The empty command zone must be UNREACHABLE. The drop route is the second
    // door to it, so it carries the same rule as DELETE -- and, because a rule
    // with no way through is the failure mode this design avoids, the refusal
    // has to tell the user what to do instead.
    const deckId = await createDeck(owner.token, 'PR6G Drop Only Commander', ['ci-cmd-ur']);
    const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST', body: { desired_card_id: 'ci-red-bolt', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));
    const before = await deckFingerprint(deckId);
    const only = (await deckRows(deckId)).find(r => r.board === 'commander');

    // Even WITH the removal confirmation: consent to removing cards is not
    // consent to an empty command zone, and must not be mistaken for it.
    const refused = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        drop_commander_deck_card_id: only.id,
        confirm_remove_off_identity: true
      }
    });
    assert.strictEqual(refused.status, 409,
      `the last commander must never be droppable: ${JSON.stringify(refused.body)}`);
    assert.strictEqual(refused.body && refused.body.code, 'COMMANDER_DELETE_UNSUPPORTED',
      `it must be the same unsupported-operation refusal: ${JSON.stringify(refused.body)}`);
    assert.ok(/swap/i.test(JSON.stringify(refused.body)),
      `the refusal must point the user at the swap: ${JSON.stringify(refused.body)}`);

    // A REFUSAL IS INERT.
    assert.deepStrictEqual(await deckFingerprint(deckId), before,
      'a refused drop must leave the deck byte-for-byte as it was');
    await assertDeckWithinCommanderIdentity(deckId, 'after a refused last-commander drop');
  });

test('F15-TC48', 'a THIN commander is COULD-NOT-VERIFY, never colourless',
  async ({ owner }) => {
    // A card_cache row with a NULL colour identity means the app NEVER READ the
    // card, not that the card is colourless. Read as colourless it makes the
    // deck's identity [] and the commander refuses every coloured card with no
    // way through -- a confident wrong answer from data the app never had.
    const deckId = await createDeck(owner.token, 'PR6G Thin Commander', ['ci-cmd-thin']);

    // The row goes thin AFTER the deck exists: this models the planned nightly
    // cache job replacing a row, which is when this becomes live.
    await db.run(`UPDATE card_cache SET color_identity = NULL WHERE id = ?`, ['ci-cmd-thin']);

    // Hydration cannot rescue it, so the app must say so HONESTLY rather than
    // ruling on colour.
    scryfallStub.reset();
    scryfallStub.failWith = new Error('scryfall unreachable');
    const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST', body: { desired_card_id: 'ci-red-bolt', desired_finish: 'nonfoil' }
    });
    scryfallStub.reset();

    assert.strictEqual(response.status, 503,
      `an unreadable commander must be reported as could-not-verify, not ruled on: `
      + `${JSON.stringify(response.body)}`);
    assert.strictEqual(response.body && response.body.code, 'COMMANDER_VERIFY_UNAVAILABLE',
      `the code must say the app could not check: ${JSON.stringify(response.body)}`);
    // NOT dressed up as a colour ruling. "colourless" here would be a lie.
    assert.ok(!/identity is colourless/i.test(JSON.stringify(response.body)),
      `a could-not-verify must never claim the deck is colourless: `
      + `${JSON.stringify(response.body)}`);

    assert.ok(!(await deckRows(deckId)).some(r => r.desired_card_id === 'ci-red-bolt'),
      'a card the app could not judge must not be written');

    // AND IT IS RECOVERABLE. When Scryfall answers, the REAL identity is used
    // and the red card goes in -- proving this was an outage, not a ruling.
    scryfallStub.reset();
    const retry = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST', body: { desired_card_id: 'ci-red-bolt', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(retry.status, 200,
      `once the commander can be read, the on-identity card must go in: `
      + `${JSON.stringify(retry.body)}`);
    assert.deepStrictEqual(scryfallStub.calls, ['ci-cmd-thin'],
      `hydration must have been attempted on the COMMANDER row: `
      + `${JSON.stringify(scryfallStub.calls)}`);
    scryfallStub.reset();
  });

test('F15-TC49', 'NO deletions are ever proposed from unread colour data',
  async ({ owner }) => {
    // planCommanderSwapRemovals decides which of the user's cards to DELETE. If
    // it reads a NULL colour identity as colourless it will propose deleting
    // every coloured card in the deck on the strength of data the app never
    // read. Deleting real cards from a decklist is the last place to guess.
    const deckId = await createDeck(owner.token, 'PR6G Unread Plan', ['ci-cmd-ur']);
    for (const cardId of ['ci-red-bolt', 'ci-blue-counter']) {
      const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil' }
      });
      assert.strictEqual(add.status, 200, `${cardId}: ${JSON.stringify(add.body)}`);
    }
    const commanderRow = (await deckRows(deckId)).find(r => r.board === 'commander');
    const before = await deckRows(deckId);

    // The INCOMING commander is the unreadable one, and Scryfall is down.
    await db.run(`UPDATE card_cache SET color_identity = NULL WHERE id = ?`, ['ci-cmd-thin2']);
    scryfallStub.reset();
    scryfallStub.failWith = new Error('scryfall unreachable');
    const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        desired_card_id: 'ci-cmd-thin2', desired_finish: 'nonfoil', board: 'commander',
        replacing_deck_card_id: commanderRow.id
      }
    });
    scryfallStub.reset();

    // It must NOT come back with a list of cards to delete. That list would be
    // fabricated from an identity the app never read.
    const body = response.body || {};
    assert.notStrictEqual(body.code, 'COMMANDER_SWAP_REMOVES_CARDS',
      `no removal plan may be built on unread colour data: ${JSON.stringify(body)}`);
    assert.ok(!Array.isArray(body.removing) || body.removing.length === 0,
      `no card may be proposed for deletion from unread data: ${JSON.stringify(body)}`);
    assert.strictEqual(response.status, 503,
      `the honest answer is could-not-verify: ${JSON.stringify(body)}`);

    const after = await deckRows(deckId);
    assert.deepStrictEqual(
      after.map(r => `${r.id}|${r.board}|${r.desired_card_id}`),
      before.map(r => `${r.id}|${r.board}|${r.desired_card_id}`),
      'nothing may be written or deleted when the app could not verify'
    );
  });

test('F15-TC50', 'NON-Commander formats are entirely unaffected', async ({ owner }) => {
  // Every rule above is a Commander format rule. A Modern deck has no command
  // zone, no colour identity and no partner pairs, and must pay nothing at all
  // -- not a refusal, not a confirmation step, not a Scryfall call.
  const response = await api(owner.token, '/api/decks', {
    method: 'POST', body: { name: 'PR6G Modern', format: 'Modern' }
  });
  assert.strictEqual(response.status, 201, JSON.stringify(response.body));
  const deckId = response.body.id;

  scryfallStub.reset();
  // Cards of three different, mutually off-identity colours, four copies each.
  for (const cardId of ['ci-kodama', 'ci-red-bolt', 'ci-blue-counter', 'ci-solring']) {
    const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil', quantity: 4 }
    });
    assert.strictEqual(add.status, 200,
      `${cardId} must be addable to a Modern deck: ${JSON.stringify(add.body)}`);
  }
  assert.deepStrictEqual(scryfallStub.calls, [],
    `a non-Commander deck must not pay for colour hydration: `
    + `${JSON.stringify(scryfallStub.calls)}`);

  const rows = await deckRows(deckId);
  assert.strictEqual(rows.length, 4, `all four cards must be present: ${JSON.stringify(rows)}`);

  // And a plain delete stays a plain delete -- no warning, no confirmation.
  const target = rows.find(r => r.desired_card_id === 'ci-kodama');
  const removed = await api(owner.token, `/api/decks/${deckId}/cards/${target.id}`, {
    method: 'DELETE'
  });
  assert.strictEqual(removed.status, 200,
    `a Modern delete must not grow a confirmation step: ${JSON.stringify(removed.body)}`);
  assert.strictEqual((await deckRows(deckId)).length, 3, 'the card must be gone');
});

test('F15-TC51', 'deleting an ORDINARY card from a Commander deck is untouched',
  async ({ owner }) => {
    // The invariant is about the RESULTING state, and removing a card from the
    // 99 can never break it. This delete must stay a one-request operation --
    // a rule that made every deletion ask a question would be unusable.
    const deckId = await createDeck(owner.token, 'PR6G Plain Delete', ['ci-cmd-ur']);
    const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST', body: { desired_card_id: 'ci-red-bolt', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));
    const target = (await deckRows(deckId)).find(r => r.desired_card_id === 'ci-red-bolt');

    const removed = await api(owner.token, `/api/decks/${deckId}/cards/${target.id}`, {
      method: 'DELETE'
    });
    assert.strictEqual(removed.status, 200,
      `an ordinary delete must not ask anything: ${JSON.stringify(removed.body)}`);
    assert.ok(!(await deckRows(deckId)).some(r => r.desired_card_id === 'ci-red-bolt'),
      'the card must be gone');
  });

test('F15-TC52', 'adding a SECOND commander to a pair still needs no confirmation',
  async ({ owner }) => {
    // Widening the identity can never invalidate anything, so the removal
    // machinery must produce an empty plan and the write must go straight
    // through. This is the case the `replacingId !== null` gate got right by
    // accident and that the new whole-zone gate must keep right on purpose.
    const deckId = await createDeck(owner.token, 'PR6G Widen', ['ci-partner-r']);
    const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST', body: { desired_card_id: 'ci-red-bolt', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));

    const widened = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-partner-g', desired_finish: 'nonfoil', board: 'commander' }
    });
    assert.strictEqual(widened.status, 200,
      `adding a partner widens the identity and must not ask: ${JSON.stringify(widened.body)}`);

    // ...and the widened identity now admits a green card.
    const green = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST', body: { desired_card_id: 'ci-kodama', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(green.status, 200,
      `the widened [R,G] identity must admit a green card: ${JSON.stringify(green.body)}`);
  });

// ===========================================================================
// ITEM 6 -- THE COMMAND ZONE CHANGES ON *EITHER* SIDE OF A WRITE
//
// The class of defect these cases exist to close, stated once:
//
//   A rule attached to a SPECIFIC OPERATION can always be walked around by
//   performing a DIFFERENT operation that arrives at the same state.
//
// It has now produced three blockers in a row. PR 6F checked pairing only when
// the zone held exactly two rows, so growing to three and deleting one bypassed
// it. PR 6G round 1 never re-validated colour identity on DELETE, so
// delete-then-re-add bypassed it. PR 6G round 2 keyed the commander gates on
// the DESTINATION board, so MOVING A COMMANDER OFF the zone -- a write whose
// destination is the mainboard -- bypassed every commander check.
//
// Each case below names a VERB that can change the command zone or the set of
// deck cards, and asserts on the RESULTING STATE rather than on the shape of
// the request.
// ===========================================================================

test('F15-TC53', 'MOVING a commander OFF the zone is a command-zone change, not a plain add',
  async ({ owner }) => {
    // THE EXACT REVIEWER REPRO. A legal [R,G] partner pair holding a green
    // card, then the green partner is MOVED to the mainboard by naming it as
    // `replacing_deck_card_id` with board 'mainboard'.
    //
    // The request looks like an ordinary add -- destination board 'mainboard'
    // -- which is precisely why a gate keyed on the destination missed it. Its
    // EFFECT is a narrowing of the command zone from [R,G] to [R], and it must
    // be treated as one.
    const deckId = await createDeck(owner.token, 'PR6G Move Off Zone',
      ['ci-partner-r', 'ci-partner-g']);

    const green = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST', body: { desired_card_id: 'ci-kodama', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(green.status, 200,
      `the [R,G] zone must admit a green card: ${JSON.stringify(green.body)}`);

    const before = await deckFingerprint(deckId);
    const greenPartner = (await deckRows(deckId)).find(r => r.desired_card_id === 'ci-partner-g');

    // NO CONFIRMATION SENT. Narrowing [R,G] to [R] strands the green card, so
    // this must be a question, not a silent success.
    const moved = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        desired_card_id: 'ci-partner-g', desired_finish: 'nonfoil', board: 'mainboard',
        replacing_deck_card_id: greenPartner.id
      }
    });

    assert.notStrictEqual(moved.status, 200,
      `moving a commander off the zone must not silently succeed: `
      + `${moved.status} ${JSON.stringify(moved.body)}`);
    assert.strictEqual(moved.status, 409,
      `it must be refused or routed through confirmation: ${JSON.stringify(moved.body)}`);

    // The refusal must NAME the stranded card, exactly as the drop path does --
    // the user has to reconcile this against a physical binder.
    const body = moved.body || {};
    const text = JSON.stringify(body);
    assert.ok(/kodama/i.test(text),
      `the question must name the card that would be stranded: ${text}`);

    // NOTHING WAS WRITTEN. Not the move, not the removal.
    assert.deepStrictEqual(await deckFingerprint(deckId), before,
      'an unconfirmed command-zone narrowing must write nothing at all');

    // And the deck is still coherent: the zone still holds both partners, so
    // the green card it holds is still legal.
    const after = await deckRows(deckId);
    assert.deepStrictEqual(
      after.filter(r => r.board === 'commander').map(r => r.desired_card_id).sort(),
      ['ci-partner-g', 'ci-partner-r'],
      `the command zone must be untouched: ${JSON.stringify(after)}`
    );
    await assertDeckWithinCommanderIdentity(deckId, 'after a refused move off the zone');
  });

test('F15-TC53b', 'a move off the zone that would strand the MOVED CARD ITSELF is refused',
  async ({ owner }) => {
    // THE CASE THE REVIEWER'S SUGGESTED PATCH DOES NOT COVER, and the reason
    // the fix judges the incoming card against the FUTURE zone.
    //
    // Moving the green partner into the 99 narrows the deck to [R]. Planning
    // removals for the OTHER cards is not enough: the moved card is green and
    // it is landing in a red deck. Judged against the zone as FOUND -- which
    // still holds the green partner at that instant -- it passes, and the app
    // produces a deck that breaks its own rule.
    //
    // So this operation can NEVER be valid, and per the standing principle it
    // is REFUSED rather than half-applied. The user's actual intent is "drop
    // this partner", which is a different verb that deletes the row.
    const deckId = await createDeck(owner.token, 'PR6G Move Off Self Strand',
      ['ci-partner-r', 'ci-partner-g']);
    for (const cardId of ['ci-red-bolt', 'ci-solring']) {
      const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil' }
      });
      assert.strictEqual(add.status, 200, `${cardId}: ${JSON.stringify(add.body)}`);
    }
    const before = await deckFingerprint(deckId);
    const greenPartner = (await deckRows(deckId)).find(r => r.desired_card_id === 'ci-partner-g');

    // Confirmation IS sent: the user has agreed to lose stranded cards. It
    // still must not go through, because the problem is not what it removes --
    // it is that the resulting deck would be illegal.
    const moved = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        desired_card_id: 'ci-partner-g', desired_finish: 'nonfoil', board: 'mainboard',
        replacing_deck_card_id: greenPartner.id,
        confirm_remove_off_identity: true
      }
    });

    assert.strictEqual(moved.status, 409,
      `a move that strands the moved card itself must be refused: ${JSON.stringify(moved.body)}`);
    assert.strictEqual(moved.body && moved.body.code, 'COMMANDER_COLOR_IDENTITY',
      `it must be the colour rule, naming the real reason: ${JSON.stringify(moved.body)}`);

    assert.deepStrictEqual(await deckFingerprint(deckId), before,
      'a refused move must write nothing -- not the move, not the removals');
    await assertDeckWithinCommanderIdentity(deckId, 'after a self-stranding move is refused');
  });

test('F15-TC53c', 'a move off the zone that strands NOTHING applies as one ordinary request',
  async ({ owner }) => {
    // THE WAY THROUGH, so the rule is not a dead end. A [R] + colourless pair
    // is a RED deck; moving the colourless partner into the 99 leaves the
    // identity at [R], strands nothing, and the moved card is colourless so it
    // is legal where it lands.
    //
    // NO confirmation is sent, deliberately. A question with nothing to report
    // is one the user learns to click through, which is how the question that
    // DOES remove three cards gets waved past.
    const deckId = await createDeck(owner.token, 'PR6G Move Off Clean',
      ['ci-partner-r', 'ci-partner-c']);
    for (const cardId of ['ci-red-bolt', 'ci-solring']) {
      const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST', body: { desired_card_id: cardId, desired_finish: 'nonfoil' }
      });
      assert.strictEqual(add.status, 200, `${cardId}: ${JSON.stringify(add.body)}`);
    }
    const colourless = (await deckRows(deckId)).find(r => r.desired_card_id === 'ci-partner-c');

    const moved = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        desired_card_id: 'ci-partner-c', desired_finish: 'nonfoil', board: 'mainboard',
        replacing_deck_card_id: colourless.id
      }
    });
    assert.strictEqual(moved.status, 200,
      `a move that strands nothing must not ask: ${JSON.stringify(moved.body)}`);

    const after = await deckRows(deckId);
    // The zone narrowed to one commander...
    assert.deepStrictEqual(
      after.filter(r => r.board === 'commander').map(r => r.desired_card_id),
      ['ci-partner-r'],
      `the zone must hold only the red partner: ${JSON.stringify(after)}`
    );
    // ...the moved card is now an ordinary deck card, on ONE board only...
    const movedRows = after.filter(r => r.desired_card_id === 'ci-partner-c');
    assert.strictEqual(movedRows.length, 1,
      `the moved card must exist exactly once: ${JSON.stringify(movedRows)}`);
    assert.strictEqual(movedRows[0].board, 'mainboard',
      `the moved card must be on the mainboard: ${JSON.stringify(movedRows)}`);
    // ...and nothing else was touched.
    assert.deepStrictEqual(
      after.map(r => r.desired_card_id).sort(),
      ['ci-partner-c', 'ci-partner-r', 'ci-red-bolt', 'ci-solring'],
      `no other row may change: ${JSON.stringify(after)}`
    );
    await assertDeckWithinCommanderIdentity(deckId, 'after a clean move off the zone');
  });

test('F15-TC54', 'moving the ONLY commander off the zone hits the LAST-COMMANDER refusal',
  async ({ owner }) => {
    // THE ZONE-EMPTYING SHAPE. A single-commander deck, and the commander is
    // moved to 'considering' -- which reserves nothing and is not deck contents,
    // so the zone would simply be left empty.
    //
    // COMMANDER_DELETE_UNSUPPORTED is claimed to be structurally unreachable.
    // This is the case that decides whether that claim is true: if this write
    // succeeds, the empty command zone is reachable through the API and the
    // choke point's empty-zone refusal is load-bearing live logic rather than
    // the defence in depth it is documented as.
    const deckId = await createDeck(owner.token, 'PR6G Move Last Off', ['ci-cmd-ur']);
    const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST', body: { desired_card_id: 'ci-red-bolt', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));
    const before = await deckFingerprint(deckId);
    const commander = (await deckRows(deckId)).find(r => r.board === 'commander');

    for (const board of ['considering', 'mainboard']) {
      const moved = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST',
        body: {
          desired_card_id: 'ci-cmd-ur', desired_finish: 'nonfoil', board,
          replacing_deck_card_id: commander.id,
          // Sent deliberately: even a user who agrees to lose cards may not
          // empty the command zone. The last commander is SWAPPED, never
          // removed, and there is nothing here to confirm.
          confirm_remove_off_identity: true
        }
      });

      assert.strictEqual(moved.status, 409,
        `moving the last commander to '${board}' must be refused: `
        + `${moved.status} ${JSON.stringify(moved.body)}`);
      assert.strictEqual(moved.body && moved.body.code, 'COMMANDER_DELETE_UNSUPPORTED',
        `it must be the last-commander refusal, not an incidental error: `
        + `${JSON.stringify(moved.body)}`);
      // The refusal has to NAME THE WAY OUT, like every other refusal here.
      assert.ok(/swap/i.test(JSON.stringify(moved.body)),
        `the refusal must point at the swap: ${JSON.stringify(moved.body)}`);
    }

    // THE COMMAND ZONE IS STILL OCCUPIED, read from the database rather than
    // from any response.
    const commanders = await db.all(
      `SELECT id FROM deck_cards WHERE deck_id = ? AND board = 'commander'`, [deckId]
    );
    assert.strictEqual(commanders.length, 1,
      `the command zone must never be emptied: ${JSON.stringify(commanders)}`);
    assert.deepStrictEqual(await deckFingerprint(deckId), before,
      'a refused move must write nothing');
  });

test('F15-TC55', 'moving a card ONTO the commander board is validated as a zone change',
  async ({ owner }) => {
    // The other direction of the same verb. A card already in the 99 is
    // re-pinned onto the commander board, so the write's destination IS the
    // zone -- this direction was always gated correctly, and the case exists so
    // that a future refactor of the gate cannot lose it.
    //
    // Sol Ring is not a legal commander, so the resulting zone is illegal and
    // the write must be refused with the commander-validity rule.
    const deckId = await createDeck(owner.token, 'PR6G Move Onto Zone', ['ci-cmd-ur']);
    const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST', body: { desired_card_id: 'ci-solring', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(add.status, 200, JSON.stringify(add.body));
    const solRing = (await deckRows(deckId)).find(r => r.desired_card_id === 'ci-solring');
    const before = await deckFingerprint(deckId);

    const moved = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        desired_card_id: 'ci-solring', desired_finish: 'nonfoil', board: 'commander',
        replacing_deck_card_id: solRing.id
      }
    });

    assert.strictEqual(moved.status, 409,
      `an artifact must not become a commander: ${JSON.stringify(moved.body)}`);
    assert.strictEqual(moved.body && moved.body.code, 'COMMANDER_NOT_LEGAL',
      `it must be the commander-validity rule: ${JSON.stringify(moved.body)}`);

    // NOTHING WAS WRITTEN -- including the DELETE of the row being moved. A
    // refusal that consumed the source row would be the silent partial state
    // the design forbids.
    assert.deepStrictEqual(await deckFingerprint(deckId), before,
      'a refused move onto the zone must leave the source row intact');
    await assertDeckWithinCommanderIdentity(deckId, 'after a refused move onto the zone');
  });

test('F15-TC56', 'EVERY verb that changes the deck ends in a state that satisfies the rules',
  async ({ owner }) => {
    // THE VERB MATRIX. One exercise per verb in the enumeration written at the
    // choke point in routes/decks.js, each asserting the RESULTING STATE rather
    // than the request's shape. A verb added later that skips validation will
    // fail here even if it looks nothing like an add.
    const deckId = await createDeck(owner.token, 'PR6G Verb Matrix',
      ['ci-partner-r', 'ci-partner-g']);
    const post = (body) => api(owner.token, `/api/decks/${deckId}/cards`,
      { method: 'POST', body });

    // VERB 1 -- CREATE (already exercised above: the deck exists and is legal).
    await assertDeckWithinCommanderIdentity(deckId, 'verb: create');

    // VERB 2 -- ADD. An off-identity card is refused; an on-identity one lands.
    const offIdentity = await post({
      desired_card_id: 'ci-blue-counter', desired_finish: 'nonfoil'
    });
    assert.strictEqual(offIdentity.status, 409,
      `verb add: a blue card must be refused by an [R,G] zone: ${JSON.stringify(offIdentity.body)}`);
    for (const cardId of ['ci-kodama', 'ci-red-bolt', 'ci-solring']) {
      const add = await post({ desired_card_id: cardId, desired_finish: 'nonfoil' });
      assert.strictEqual(add.status, 200, `verb add ${cardId}: ${JSON.stringify(add.body)}`);
    }
    await assertDeckWithinCommanderIdentity(deckId, 'verb: add');

    // VERB 3 -- BOARD MOVE of an ordinary card, both directions. Moving to
    // 'considering' and back is not a zone change, so it must stay a single
    // unconfirmed request -- and the deck must still be legal afterwards.
    const bolt = (await deckRows(deckId)).find(r => r.desired_card_id === 'ci-red-bolt');
    const toConsidering = await post({
      desired_card_id: 'ci-red-bolt', desired_finish: 'nonfoil', board: 'considering',
      replacing_deck_card_id: bolt.id
    });
    assert.strictEqual(toConsidering.status, 200,
      `verb board-move: an ordinary card must move freely: ${JSON.stringify(toConsidering.body)}`);
    const consideringBolt = (await deckRows(deckId))
      .find(r => r.desired_card_id === 'ci-red-bolt' && r.board === 'considering');
    assert.ok(consideringBolt, 'the card must actually be on the considering board');
    const backToMain = await post({
      desired_card_id: 'ci-red-bolt', desired_finish: 'nonfoil', board: 'mainboard',
      replacing_deck_card_id: consideringBolt.id
    });
    assert.strictEqual(backToMain.status, 200,
      `verb board-move back: ${JSON.stringify(backToMain.body)}`);
    await assertDeckWithinCommanderIdentity(deckId, 'verb: board move');

    // VERB 4 -- RE-PIN / REPLACE. Re-pinning to an off-identity printing is
    // refused; the deck is unchanged.
    const kodama = (await deckRows(deckId)).find(r => r.desired_card_id === 'ci-kodama');
    const repin = await post({
      desired_card_id: 'ci-blue-counter', desired_finish: 'nonfoil', board: 'mainboard',
      replacing_deck_card_id: kodama.id
    });
    assert.strictEqual(repin.status, 409,
      `verb re-pin: an off-identity re-pin must be refused: ${JSON.stringify(repin.body)}`);
    await assertDeckWithinCommanderIdentity(deckId, 'verb: re-pin');

    // VERB 5 -- COMMANDER ADD (widening). Not applicable at two commanders --
    // a third is refused outright, which is itself the resulting-state rule.
    const third = await post({
      desired_card_id: 'ci-partner-c', desired_finish: 'nonfoil', board: 'commander'
    });
    assert.strictEqual(third.status, 409,
      `verb commander-add: a third commander must be refused: ${JSON.stringify(third.body)}`);
    assert.strictEqual(third.body && third.body.code, 'COMMANDER_TOO_MANY',
      `it must be the zone-size rule: ${JSON.stringify(third.body)}`);
    await assertDeckWithinCommanderIdentity(deckId, 'verb: commander add');

    // VERB 6 -- COMMANDER SWAP. Swapping the green partner for a second RED
    // partner narrows [R,G] to [R] and must ask before stranding the green card.
    const greenPartner = (await deckRows(deckId)).find(r => r.desired_card_id === 'ci-partner-g');
    const swapAsk = await post({
      desired_card_id: 'ci-partner-r2', desired_finish: 'nonfoil', board: 'commander',
      replacing_deck_card_id: greenPartner.id
    });
    assert.strictEqual(swapAsk.status, 409,
      `verb swap: a narrowing swap must ask: ${JSON.stringify(swapAsk.body)}`);
    assert.strictEqual(swapAsk.body && swapAsk.body.code, 'COMMANDER_SWAP_REMOVES_CARDS',
      `it must be the stranding question: ${JSON.stringify(swapAsk.body)}`);
    await assertDeckWithinCommanderIdentity(deckId, 'verb: swap (asked)');

    // VERB 7 -- COMMANDER MOVE OFF THE ZONE. The verb this whole item exists
    // for. Same narrowing, spelled as a board move, and it must ask in exactly
    // the same way.
    const moveOff = await post({
      desired_card_id: 'ci-partner-g', desired_finish: 'nonfoil', board: 'mainboard',
      replacing_deck_card_id: greenPartner.id
    });
    assert.strictEqual(moveOff.status, 409,
      `verb move-off: it must ask, exactly like the swap: ${JSON.stringify(moveOff.body)}`);
    await assertDeckWithinCommanderIdentity(deckId, 'verb: move off the zone');

    // VERB 8 -- DROP A PARTNER. The explicit spelling of the same narrowing.
    const drop = await post({ drop_commander_deck_card_id: greenPartner.id });
    assert.strictEqual(drop.status, 409,
      `verb drop: it must ask: ${JSON.stringify(drop.body)}`);
    await assertDeckWithinCommanderIdentity(deckId, 'verb: drop');

    // VERB 9 -- DELETE. An ordinary card deletes freely; a commander cannot.
    const solRing = (await deckRows(deckId)).find(r => r.desired_card_id === 'ci-solring');
    const deleted = await api(owner.token, `/api/decks/${deckId}/cards/${solRing.id}`,
      { method: 'DELETE' });
    assert.strictEqual(deleted.status, 200,
      `verb delete: an ordinary delete must stay one request: ${JSON.stringify(deleted.body)}`);
    const deleteCommander = await api(owner.token,
      `/api/decks/${deckId}/cards/${greenPartner.id}`, { method: 'DELETE' });
    assert.strictEqual(deleteCommander.status, 409,
      `verb delete: a commander delete must be refused: ${JSON.stringify(deleteCommander.body)}`);
    await assertDeckWithinCommanderIdentity(deckId, 'verb: delete');

    // VERB 10 -- IMPORT APPLY. An off-identity line must be reported, not
    // written.
    const imported = await api(owner.token, `/api/decks/${deckId}/import`, {
      method: 'POST',
      body: { lines: [{ name: 'Counter Test', quantity: 1 }], apply: true }
    });
    assert.notStrictEqual(imported.status, 500,
      `verb import: ${JSON.stringify(imported.body)}`);
    const importedRows = await deckRows(deckId);
    assert.ok(!importedRows.some(
      r => r.desired_card_id === 'ci-blue-counter' && r.board !== 'considering'),
      `verb import: an off-identity line must not become a deck row: `
      + `${JSON.stringify(importedRows)}`);
    await assertDeckWithinCommanderIdentity(deckId, 'verb: import apply');

    // VERB 11 -- MULTI-SELECT BULK ADD from the collection screen.
    const entryId = await ownCopy(owner.token, 'ci-blue-counter');
    const bulk = await api(owner.token, '/api/collection/bulk', {
      method: 'POST',
      body: { entry_ids: [entryId], action: 'add_to_deck', value: deckId }
    });
    assert.strictEqual(bulk.status, 409,
      `verb bulk add: an off-identity selection must be reported first: `
      + `${JSON.stringify(bulk.body)}`);
    await assertDeckWithinCommanderIdentity(deckId, 'verb: bulk add');

    // VERB 12 -- CHECKOUT / RETURN. These move ALLOCATIONS, never the set of
    // deck cards or the command zone, so they cannot break the invariant --
    // asserted rather than assumed.
    const checkedOut = await api(owner.token, `/api/decks/${deckId}/checkout`,
      { method: 'PUT' });
    assert.ok([200, 400].includes(checkedOut.status),
      `verb checkout: ${JSON.stringify(checkedOut.body)}`);
    await api(owner.token, `/api/decks/${deckId}/return`, { method: 'PUT' });
    await assertDeckWithinCommanderIdentity(deckId, 'verb: checkout/return');
  });

// ===========================================================================
// FIXTURES
// ===========================================================================

// A fully-read cache row. `colorIdentity` uses the app's stored form -- colour
// NAMES, as scryfallApi.normalizeCard writes them -- because the rule has to
// read what the cache actually holds, not what Scryfall sends.
async function seedCard(id, {
  name, oracleId, number, typeLine, subtypes, colorIdentity = [],
  oracleText = '', keywords = [], supertype = 'Creature', finishes = ['nonfoil', 'foil']
}) {
  await db.run(
    `INSERT OR IGNORE INTO card_cache
       (id, oracle_id, name, set_id, set_name, number, finishes, supertype, subtypes,
        type_line, oracle_text, keywords, color_identity, types, legalities)
     VALUES (?, ?, ?, 'tsg', 'Test Set G', ?, ?, ?, ?, ?, ?, ?, ?, '[]', '{}')`,
    [id, oracleId, name, number, JSON.stringify(finishes), supertype,
      JSON.stringify(subtypes), typeLine, oracleText, JSON.stringify(keywords),
      JSON.stringify(colorIdentity)]
  );
}

// A THIN row: the app holds it but never read it. NULL is the signal -- it
// means "we never looked", as distinct from '' which means "we looked and there
// was nothing there".
async function seedThinCard(id, { name, oracleId, number }) {
  await db.run(
    `INSERT OR IGNORE INTO card_cache
       (id, oracle_id, name, set_id, set_name, number, finishes,
        supertype, subtypes, type_line, oracle_text, keywords, color_identity)
     VALUES (?, ?, ?, 'tsg', 'Test Set G', ?, ?, 'MTG', NULL, NULL, NULL, NULL, NULL)`,
    [id, oracleId, name, number, JSON.stringify(['nonfoil'])]
  );
}

async function seed() {
  // --- COMMANDERS, by colour identity ---
  await seedCard('ci-cmd-ur', {
    name: 'Izzet Cmdr Test', oracleId: 'o-ci-cmd-ur', number: '1',
    typeLine: 'Legendary Creature — Test', subtypes: ['Legendary', 'Creature'],
    colorIdentity: ['Blue', 'Red'], oracleText: 'Flying'
  });
  await seedCard('ci-cmd-ur-b', {
    name: 'Izzet Cmdr Two Test', oracleId: 'o-ci-cmd-ur-b', number: '2',
    typeLine: 'Legendary Creature — Test', subtypes: ['Legendary', 'Creature'],
    colorIdentity: ['Blue', 'Red'], oracleText: 'Haste'
  });
  await seedCard('ci-cmd-r', {
    name: 'Mono Red Cmdr Test', oracleId: 'o-ci-cmd-r', number: '3',
    typeLine: 'Legendary Creature — Test', subtypes: ['Legendary', 'Creature'],
    colorIdentity: ['Red'], oracleText: 'First strike'
  });
  await seedCard('ci-cmd-wb', {
    name: 'Orzhov Cmdr Test', oracleId: 'o-ci-cmd-wb', number: '4',
    typeLine: 'Legendary Creature — Test', subtypes: ['Legendary', 'Creature'],
    colorIdentity: ['White', 'Black'], oracleText: 'Lifelink'
  });
  // A STRICTLY BROADER identity than [U,R]: swapping an Izzet deck to this
  // strands nothing, because every card that fit [U,R] still fits [U,R,G].
  // The case that must apply with NO warning and NO confirmation step.
  await seedCard('ci-cmd-urg', {
    name: 'Temur Cmdr Test', oracleId: 'o-ci-cmd-urg', number: '6',
    typeLine: 'Legendary Creature — Test', subtypes: ['Legendary', 'Creature'],
    colorIdentity: ['Blue', 'Red', 'Green'], oracleText: 'Reach'
  });
  // A planeswalker whose TEXT says it can be your commander. Rule 3 is about
  // what the card says, not its type line alone.
  await seedCard('ci-pw-cmd', {
    name: 'Planeswalker Cmdr Test', oracleId: 'o-ci-pw-cmd', number: '5',
    typeLine: 'Legendary Planeswalker — Test', subtypes: ['Legendary', 'Planeswalker'],
    colorIdentity: ['Red'], supertype: 'Planeswalker',
    oracleText: 'Planeswalker Cmdr Test can be your commander.'
  });

  // --- DECK CONTENTS, by colour identity ---
  await seedCard('ci-kodama', {
    name: 'Kodama Test', oracleId: 'o-ci-kodama', number: '10',
    typeLine: 'Legendary Creature — Spirit', subtypes: ['Legendary', 'Creature'],
    colorIdentity: ['Green'], oracleText: 'Trample'
  });
  await seedCard('ci-red-bolt', {
    name: 'Bolt Test', oracleId: 'o-ci-red-bolt', number: '11',
    typeLine: 'Instant', subtypes: ['Instant'], supertype: 'Instant',
    colorIdentity: ['Red'], oracleText: 'Deal 3 damage to any target.'
  });
  await seedCard('ci-blue-counter', {
    name: 'Counter Test', oracleId: 'o-ci-blue-counter', number: '12',
    typeLine: 'Instant', subtypes: ['Instant'], supertype: 'Instant',
    colorIdentity: ['Blue'], oracleText: 'Counter target spell.'
  });
  // Colourless: legal in EVERY Commander deck.
  await seedCard('ci-solring', {
    name: 'Sol Ring Test', oracleId: 'o-ci-solring', number: '13',
    typeLine: 'Artifact', subtypes: ['Artifact'], supertype: 'Artifact',
    colorIdentity: [], oracleText: '{T}: Add {C}{C}.'
  });
  // A LAND with no colours and no mana cost, whose colour identity is green
  // because its rules text produces green mana. The case a "check the colors
  // field" implementation gets wrong.
  await seedCard('ci-green-land', {
    name: 'Green Land Test', oracleId: 'o-ci-green-land', number: '14',
    typeLine: 'Land', subtypes: ['Land'], supertype: 'Land',
    colorIdentity: ['Green'], oracleText: '{T}: Add {G}.', finishes: ['nonfoil']
  });
  // A basic land: exempt from SINGLETON, not from colour identity.
  await seedCard('ci-forest', {
    name: 'Forest', oracleId: 'o-ci-forest', number: '15',
    typeLine: 'Basic Land — Forest', subtypes: ['Basic', 'Land', 'Forest'],
    supertype: 'Land', colorIdentity: ['Green'], oracleText: '', finishes: ['nonfoil']
  });

  // --- AVAILABILITY FIXTURES ---
  await seedCard('ci-breena', {
    name: 'Breena Test', oracleId: 'o-ci-breena', number: '20',
    typeLine: 'Legendary Creature — Test', subtypes: ['Legendary', 'Creature'],
    colorIdentity: ['White', 'Black'], oracleText: 'Flying'
  });
  await seedCard('ci-tut', {
    name: 'Tutor Test', oracleId: 'o-ci-tut', number: '21',
    typeLine: 'Sorcery', subtypes: ['Sorcery'], supertype: 'Sorcery',
    colorIdentity: ['Black'], oracleText: 'Search your library for a card.'
  });
  await seedCard('ci-shock', {
    name: 'Shock Test', oracleId: 'o-ci-shock', number: '22',
    typeLine: 'Instant', subtypes: ['Instant'], supertype: 'Instant',
    colorIdentity: ['Red'], oracleText: 'Deal 2 damage to any target.'
  });

  // --- CATALOGUE SEARCH FIXTURES ---
  // Cached but never owned: the exact shape of the card the user is trying to
  // find before buying it.
  await seedCard('ci-unowned', {
    name: 'Unowned Test', oracleId: 'o-ci-unowned', number: '30',
    typeLine: 'Legendary Creature — Test', subtypes: ['Legendary', 'Creature'],
    colorIdentity: ['Blue'], oracleText: 'Flying'
  });
  await seedCard('ci-owned-marker', {
    name: 'Owned Marker Test', oracleId: 'o-ci-owned-marker', number: '31',
    typeLine: 'Instant', subtypes: ['Instant'], supertype: 'Instant',
    colorIdentity: ['Blue'], oracleText: 'Draw a card.'
  });
  await seedCard('ci-unowned-marker', {
    name: 'Unowned Marker Test', oracleId: 'o-ci-unowned-marker', number: '32',
    typeLine: 'Instant', subtypes: ['Instant'], supertype: 'Instant',
    colorIdentity: ['Blue'], oracleText: 'Draw two cards.'
  });

  // --- PARTNER PAIR, ONE RED ONE GREEN (Repro B) ---
  // A LEGAL pair, so the zone rule accepts it and the test is about COLOUR
  // rather than about pairing. Their union is [R,G]; deleting either half
  // NARROWS the deck's identity under cards already in it.
  await seedCard('ci-partner-r', {
    name: 'Red Partner Test', oracleId: 'o-ci-partner-r', number: '40',
    typeLine: 'Legendary Creature — Test', subtypes: ['Legendary', 'Creature'],
    colorIdentity: ['Red'], keywords: ['Partner'],
    oracleText: 'Partner (You can have two commanders if both have partner.)'
  });
  await seedCard('ci-partner-g', {
    name: 'Green Partner Test', oracleId: 'o-ci-partner-g', number: '41',
    typeLine: 'Legendary Creature — Test', subtypes: ['Legendary', 'Creature'],
    colorIdentity: ['Green'], keywords: ['Partner'],
    oracleText: 'Partner (You can have two commanders if both have partner.)'
  });
  // A SECOND red partner. Swapping the green half of the pair for this one is a
  // LEGAL pair whose union NARROWS [R,G] to [R] -- so the test exercises the
  // COLOUR rule rather than tripping over the pairing rule on the way in.
  await seedCard('ci-partner-r2', {
    name: 'Red Partner Two Test', oracleId: 'o-ci-partner-r2', number: '44',
    typeLine: 'Legendary Creature — Test', subtypes: ['Legendary', 'Creature'],
    colorIdentity: ['Red'], keywords: ['Partner'],
    oracleText: 'Partner (You can have two commanders if both have partner.)'
  });

  // A COLOURLESS partner. Its identity [] is a strict SUBSET of the red
  // partner's [R], so a pair of the two is a [R] deck and dropping the
  // colourless half NARROWS NOTHING -- the case that must apply silently, with
  // no confirmation step, because there is nothing to warn about.
  await seedCard('ci-partner-c', {
    name: 'Colourless Partner Test', oracleId: 'o-ci-partner-c', number: '45',
    typeLine: 'Legendary Creature — Test', subtypes: ['Legendary', 'Creature'],
    colorIdentity: [], keywords: ['Partner'],
    oracleText: 'Partner (You can have two commanders if both have partner.)'
  });

  // --- COMMANDERS THAT GO THIN LATER ---
  // Seeded COMPLETE so the deck can legitimately be created, then their
  // color_identity is set to NULL inside the test. That models the planned
  // nightly cache job rewriting a row the app had already read, which is the
  // only way a live deck ends up with an unreadable commander.
  await seedCard('ci-cmd-thin', {
    name: 'Thin Cmdr Test', oracleId: 'o-ci-cmd-thin', number: '42',
    typeLine: 'Legendary Creature — Test', subtypes: ['Legendary', 'Creature'],
    colorIdentity: ['Red'], oracleText: 'Haste'
  });
  await seedCard('ci-cmd-thin2', {
    name: 'Thin Cmdr Two Test', oracleId: 'o-ci-cmd-thin2', number: '43',
    typeLine: 'Legendary Creature — Test', subtypes: ['Legendary', 'Creature'],
    colorIdentity: ['Red'], oracleText: 'Vigilance'
  });

  // --- THIN ROWS ---
  await seedThinCard('ci-thin-green', {
    name: 'Thin Green Test', oracleId: 'o-ci-thin-green', number: '300'
  });
  // Thin rows for the FAIL-HARD cases. Each is used by exactly one test so a
  // successful hydration in one case cannot silently satisfy another.
  await seedThinCard('ci-thin-fail', {
    name: 'Thin Unverifiable Test', oracleId: 'o-ci-thin-fail', number: '301'
  });
  await seedThinCard('ci-thin-blue', {
    name: 'Thin Blue Test', oracleId: 'o-ci-thin-blue', number: '302'
  });
  await seedThinCard('ci-thin-green2', {
    name: 'Thin Green Two Test', oracleId: 'o-ci-thin-green2', number: '303'
  });
  // For the BATCH paths, which never hydrate. These must stay thin throughout
  // the run, so they are never used by a case that would hydrate them.
  await seedThinCard('ci-thin-batch', {
    name: 'Thin Batch Test', oracleId: 'o-ci-thin-batch', number: '304'
  });
  await seedThinCard('ci-thin-import', {
    name: 'Thin Import Test', oracleId: 'o-ci-thin-import', number: '305'
  });
}

async function main() {
  await db.initDb();
  // Inject the stub Scryfall client. Several cases assert the client was NOT
  // called, which is unprovable against a client that could reach the network.
  commanderRules.setCardFetcher(scryfallStub);

  const owner = await createUser('pr6g-owner');
  const availability = await createUser('pr6g-avail');
  const availability2 = await createUser('pr6g-avail2');
  const availability3 = await createUser('pr6g-avail3');
  const availability4 = await createUser('pr6g-avail4');
  // Each availability case needs its OWN user: the figures under test are
  // whole-collection totals, so sharing a user would let one case's decks
  // silently change another case's expected counts.
  const availability5 = await createUser('pr6g-avail5');
  const availability6 = await createUser('pr6g-avail6');
  const availability7 = await createUser('pr6g-avail7');
  const availability8 = await createUser('pr6g-avail8');
  // The drop-release case reads whole-collection availability figures, so it
  // needs a user whose collection no other case can perturb.
  const dropAvailability = await createUser('pr6g-drop-avail');
  await seed();

  const app = express();
  app.use(express.json());
  // Mount points must match src/server.js exactly.
  app.use('/api', collectionRoutes);
  app.use('/api/decks', deckRoutes);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const context = {
    owner, availability, availability2, availability3, availability4,
    availability5, availability6, availability7, availability8,
    dropAvailability
  };
  let failed = 0;
  try {
    for (const { id, name, fn } of tests) {
      try {
        await fn(context);
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
  if (failed > 0) throw new Error(`${failed} PR 6G test(s) failed`);
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error.message);
  process.exit(1);
});
