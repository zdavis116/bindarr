// PR 6F: commanders, singleton-by-name, and import pre-flight validation.
//
// Every case here goes through the REAL HTTP routes and asserts on DATABASE
// ROWS or on values the API actually returns. That is deliberate and it is the
// lesson of the last two weeks: two real bugs (foil adds 500'd, a migration
// crashed existing databases) survived a green suite because the tests wrote
// collection rows with direct SQL and built fresh schemas. A rule can only be
// proven by the code path that actually enforces it.
//
// Direct SQL appears here only for FIXTURES (seeding card_cache, creating
// users) -- never for the thing under test.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-pr6f-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';

const db = require('../../src/db');
const deckRoutes = require('../../src/routes/decks');
const collectionRoutes = require('../../src/routes/collection');
// The recorded commander overrides are surfaced through the log endpoint the
// app ALREADY has, not a new screen -- so the harness mounts the real handler.
const { getAuditLogs } = require('../../src/utils/auditLogger');
const commanderRules = require('../../src/utils/commanderRules');
const { authenticateToken } = require('../../src/middleware/auth');

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

// Own a copy through the REAL add route, not by inserting a row.
//
// This matters more than it looks. The collection write path applies finish
// canonicalisation and a CHECK constraint that a direct INSERT bypasses
// entirely -- which is exactly how the foil-add 500 hid behind a green suite.
async function ownCopy(token, cardId, finish = 'nonfoil') {
  const response = await api(token, '/api/collection', {
    method: 'POST',
    body: { card_id: cardId, finish }
  });
  assert.strictEqual(response.status, 200, `setup: owning ${cardId} (${finish}) must succeed: ${JSON.stringify(response.body)}`);
  return response.body.id;
}

// Read the deck's rows STRAIGHT FROM THE DATABASE. The API's own view of a
// deck is derived; the rows are what the user's binder has to agree with.
async function deckRows(deckId) {
  return db.all(
    `SELECT dc.id, dc.board, dc.quantity, dc.desired_card_id, dc.desired_finish, cc.name
     FROM deck_cards dc JOIN card_cache cc ON dc.desired_card_id = cc.id
     WHERE dc.deck_id = ? ORDER BY dc.id ASC`,
    [deckId]
  );
}

const tests = [];
function test(id, name, fn) { tests.push({ id, name, fn }); }

// ---------------------------------------------------------------------------
// THE STUB SCRYFALL CLIENT.
//
// Injected, never monkey-patched onto the real module, and it makes NO network
// call. That is not just hygiene: the point of several cases below is to
// assert the client was NOT called, and a stub that could fall through to the
// real API would make "not called" unprovable.
//
// `calls` is the observable the happy-path case asserts on. If a legal
// commander with complete cached data ever costs a Scryfall round trip, this
// array is how we find out.
// ---------------------------------------------------------------------------
const scryfallStub = {
  calls: [],
  // What the app would learn if it actually asked. Keyed by card id, shaped
  // like normalizeCard's output because that is what the cache writer takes.
  truth: {
    'thin-legal': {
      id: 'thin-legal', oracle_id: 'o-thin-legal', name: 'Thin Legal Test',
      supertype: 'MTG', subtypes: ['Legendary', 'Creature', 'Test'],
      set_id: 'tsa', set_name: 'Test Set A', number: '200',
      type_line: 'Legendary Creature — Test', oracle_text: 'Flying, vigilance',
      keywords: ['Flying', 'Vigilance'], finishes: ['nonfoil', 'foil']
    },
    'thin-illegal': {
      id: 'thin-illegal', oracle_id: 'o-thin-illegal', name: 'Thin Illegal Test',
      supertype: 'MTG', subtypes: ['Artifact'],
      set_id: 'tsa', set_name: 'Test Set A', number: '201',
      type_line: 'Artifact', oracle_text: '{T}: Add {C}{C}.',
      keywords: [], finishes: ['nonfoil', 'foil']
    },
    'thin-partner-a': {
      id: 'thin-partner-a', oracle_id: 'o-thin-pa', name: 'Thin Partner A',
      supertype: 'MTG', subtypes: ['Legendary', 'Creature', 'Test'],
      set_id: 'tsa', set_name: 'Test Set A', number: '202',
      type_line: 'Legendary Creature — Test',
      oracle_text: 'Partner (You can have two commanders if both have partner.)',
      keywords: ['Partner'], finishes: ['nonfoil', 'foil']
    },
    'thin-partner-b': {
      id: 'thin-partner-b', oracle_id: 'o-thin-pb', name: 'Thin Partner B',
      supertype: 'MTG', subtypes: ['Legendary', 'Creature', 'Test'],
      set_id: 'tsa', set_name: 'Test Set A', number: '203',
      type_line: 'Legendary Creature — Test',
      oracle_text: 'Partner (You can have two commanders if both have partner.)',
      keywords: ['Partner'], finishes: ['nonfoil', 'foil']
    }
  },
  async getCardById(cardId) {
    scryfallStub.calls.push(cardId);
    if (scryfallStub.failWith) throw scryfallStub.failWith;
    return scryfallStub.truth[cardId] || null;
  },
  reset() { scryfallStub.calls = []; scryfallStub.failWith = null; }
};

// ---------------------------------------------------------------------------
// COMMANDER SELECTION
// ---------------------------------------------------------------------------

test('F13-TC1', 'a Commander deck cannot be created without a commander', async ({ owner }) => {
  const before = (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [owner.id])).n;

  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: { name: 'Commanderless', format: 'Commander / EDH' }
  });

  assert.strictEqual(response.status, 400, `must be refused, got ${response.status}`);
  assert.strictEqual(response.body.code, 'COMMANDER_REQUIRED');

  // THE ASSERTION THAT MATTERS: a refused create writes NOTHING. A 400 with a
  // deck row left behind would be worse than no validation at all -- the user
  // is told it failed and has an invisible empty deck.
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [owner.id])).n, before,
    'a refused create must leave no deck row behind'
  );
});

test('F13-TC2', 'a Commander deck is created with ONE commander, on the commander board', async ({ owner }) => {
  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Solo Commander',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });
  assert.strictEqual(response.status, 201, JSON.stringify(response.body));

  const rows = await deckRows(response.body.id);
  assert.strictEqual(rows.length, 1, 'exactly one entry');
  assert.strictEqual(rows[0].board, 'commander', 'the commander must sit on the commander board');
  assert.strictEqual(rows[0].name, 'Atraxa Test');
  assert.strictEqual(rows[0].desired_finish, 'nonfoil', 'the chosen finish is stored, not defaulted away');
  assert.strictEqual(rows[0].quantity, 1);
});

test('F13-TC3', 'a Commander deck is created with TWO commanders (a partner pair)', async ({ owner }) => {
  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Partner Pair',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-piper', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-thrasios', desired_finish: 'foil' }
      ]
    }
  });
  assert.strictEqual(response.status, 201, JSON.stringify(response.body));

  const rows = await deckRows(response.body.id);
  assert.strictEqual(rows.length, 2, 'both commanders must be written');
  assert.ok(rows.every(r => r.board === 'commander'));
  // The finishes are kept DISTINCT. A partner pair where one is foil is an
  // ordinary thing to own, and collapsing the finish would send the user to
  // the binder for the wrong physical card.
  const finishes = rows.map(r => r.desired_finish).sort();
  assert.deepStrictEqual(finishes, ['foil', 'nonfoil']);
});

test('F13-TC4', 'a third commander is refused, and the deck is not created', async ({ owner }) => {
  const before = (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [owner.id])).n;
  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Three Commanders',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-piper', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-thrasios', desired_finish: 'nonfoil' }
      ]
    }
  });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.body.code, 'COMMANDER_TOO_MANY');
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [owner.id])).n, before
  );
});

test('F13-TC5', 'a commander without a finish is refused -- the app never picks one', async ({ owner }) => {
  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Finishless Commander',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa' }]
    }
  });
  assert.strictEqual(response.status, 400, 'a bare card id is not a complete instruction');
  assert.strictEqual(response.body.code, 'COMMANDER_INVALID');
});

test('F13-TC6', 'a commander pointing at an unknown printing rolls the whole create back', async ({ owner }) => {
  const before = (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [owner.id])).n;
  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Ghost Commander',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'no-such-card', desired_finish: 'nonfoil' }]
    }
  });
  assert.strictEqual(response.status, 404, JSON.stringify(response.body));
  // The deck INSERT happens before the commander lookup, so this proves the
  // transaction actually rolls back rather than leaving an empty Commander
  // deck the user would have to notice and delete.
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [owner.id])).n, before,
    'a failed commander must roll the deck row back'
  );
});

// ---------------------------------------------------------------------------
// OTHER FORMATS ARE ENTIRELY UNAFFECTED
//
// The spec is explicit: no extra field, no extra validation, no visual change.
// These are the cases that would fail if commander logic leaked.
// ---------------------------------------------------------------------------

test('F13-TC7', 'a non-Commander deck is created with NO commander and no complaint', async ({ owner }) => {
  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: { name: 'Modern Burn', format: 'Modern', target_size: 60 }
  });
  assert.strictEqual(response.status, 201, JSON.stringify(response.body));
  assert.strictEqual((await deckRows(response.body.id)).length, 0, 'nothing is written for a non-Commander deck');
});

test('F13-TC8', 'a non-Commander deck accepts FOUR copies by name across printings', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST', body: { name: 'Modern Duplicates', format: 'Modern', target_size: 60 }
  });
  assert.strictEqual(deck.status, 201);

  // Two different printings of the same card name. Under Commander this is a
  // singleton violation; under Modern it is an ordinary four-of.
  const first = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', quantity: 2 }
  });
  assert.strictEqual(first.status, 200, JSON.stringify(first.body));

  const second = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-b', desired_finish: 'nonfoil', quantity: 2 }
  });
  assert.strictEqual(second.status, 200,
    `other formats must be untouched by singleton: ${JSON.stringify(second.body)}`);

  const rows = await deckRows(deck.body.id);
  assert.strictEqual(rows.reduce((s, r) => s + r.quantity, 0), 4,
    'all four copies must be in the deck');
});

// ---------------------------------------------------------------------------
// SINGLETON BY NAME -- REFUSED, NOT WARNED
// ---------------------------------------------------------------------------

test('F13-TC9', 'a same-name DIFFERENT-PRINTING card is refused with a reason', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Singleton Deck',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });
  assert.strictEqual(deck.status, 201);

  const first = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(first.status, 200, `the first copy is fine: ${JSON.stringify(first.body)}`);

  // A DIFFERENT printing AND a different finish -- a genuinely different
  // physical object -- but the same card NAME, which is what the rule is about.
  const second = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-b', desired_finish: 'foil', quantity: 1 }
  });

  assert.strictEqual(second.status, 409, `must be REFUSED, not warned: ${JSON.stringify(second.body)}`);
  assert.strictEqual(second.body.code, 'COMMANDER_SINGLETON');
  // The refusal has to SAY WHY. "Invalid" would leave the user with no idea
  // what to do, and the rule is not obvious from the two rows on screen.
  assert.ok(/already in this deck/i.test(second.body.error),
    `the refusal must explain itself, got: ${second.body.error}`);
  assert.ok(/Sol Ring Test/.test(second.body.error),
    `the refusal must name the card, got: ${second.body.error}`);

  // AND IT WROTE NOTHING. A refusal that still created the row would be the
  // worst of both worlds.
  const rows = await deckRows(deck.body.id);
  const solRings = rows.filter(r => r.name === 'Sol Ring Test');
  assert.strictEqual(solRings.length, 1, 'exactly one Sol Ring row may exist');
  assert.strictEqual(solRings[0].desired_card_id, 'dup-solring-a', 'the FIRST one is the one that stayed');
});

test('F13-TC10', 'asking for two copies of one printing is refused outright', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Singleton Quantity',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });
  const response = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', quantity: 2 }
  });
  assert.strictEqual(response.status, 409, JSON.stringify(response.body));
  assert.strictEqual(
    (await deckRows(deck.body.id)).filter(r => r.name === 'Sol Ring Test').length, 0,
    'nothing written'
  );
});

test('F13-TC11', 'BASIC LANDS are exempt from singleton', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Basic Lands Deck',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });

  // Many copies of one basic, and a second PRINTING of the same basic name.
  // Both must be allowed: a Commander deck is mostly basics.
  const many = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'basic-swamp-a', desired_finish: 'nonfoil', quantity: 12 }
  });
  assert.strictEqual(many.status, 200, `12 Swamps must be allowed: ${JSON.stringify(many.body)}`);

  const other = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'basic-swamp-b', desired_finish: 'nonfoil', quantity: 5 }
  });
  assert.strictEqual(other.status, 200, `a second Swamp printing must be allowed: ${JSON.stringify(other.body)}`);

  const swamps = (await deckRows(deck.body.id)).filter(r => r.name === 'Swamp');
  assert.strictEqual(swamps.reduce((s, r) => s + r.quantity, 0), 17);
});

test('F13-TC12', 'ANY-NUMBER cards are exempt from singleton', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Rats Deck',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });

  const rats = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'rats-a', desired_finish: 'nonfoil', quantity: 30 }
  });
  assert.strictEqual(rats.status, 200, `Relentless Rats allows any number: ${JSON.stringify(rats.body)}`);

  // The accented spelling must be exempt too. Nazgûl vs Nazgul is a difference
  // in the cache, not a difference in the card, and the user cannot see or
  // control which one is stored.
  const nazgul = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'nazgul-a', desired_finish: 'nonfoil', quantity: 9 }
  });
  assert.strictEqual(nazgul.status, 200, `Nazgûl allows any number: ${JSON.stringify(nazgul.body)}`);
});

test('F13-TC13', 'CONSIDERING is never refused -- it is a shortlist, not the deck', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Considering Deck',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });

  const inDeck = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(inDeck.status, 200);

  // Shortlisting the OTHER printing of a card already in the deck is exactly
  // what considering is for -- "should I run the nicer one instead?".
  const shortlisted = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-b', desired_finish: 'nonfoil', board: 'considering', quantity: 1 }
  });
  assert.strictEqual(shortlisted.status, 200,
    `considering must never be refused for singleton: ${JSON.stringify(shortlisted.body)}`);

  const considering = (await deckRows(deck.body.id)).filter(r => r.board === 'considering');
  assert.strictEqual(considering.length, 1, 'the considering entry must actually exist');
});

test('F13-TC14', 're-saving the SAME entry is allowed -- it is not a second copy', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Resave Deck',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });

  const first = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(first.status, 200);

  // The upsert is keyed on (deck, printing, finish, board) and quantity is
  // ABSOLUTE, so this replaces the row rather than adding to it. If the
  // singleton check counted the row it is about to overwrite, the app would
  // refuse to save a card that is already legitimately in the deck.
  const again = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(again.status, 200,
    `re-saving the same entry must not refuse itself: ${JSON.stringify(again.body)}`);

  const solRings = (await deckRows(deck.body.id)).filter(r => r.name === 'Sol Ring Test');
  assert.strictEqual(solRings.length, 1);
  assert.strictEqual(solRings[0].quantity, 1, 'quantity is absolute, so it stays at one');
});

// ---------------------------------------------------------------------------
// IMPORT PRE-FLIGHT VALIDATION
// ---------------------------------------------------------------------------

test('F13-TC15', 'import REPORTS a singleton refusal on preview, before committing', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Import Preflight',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });

  // Two lines naming the SAME card by two different printings. Neither is in
  // the deck yet, so both would pass a naive check that only reads the
  // database -- the second must see the first.
  const lines = [
    { name: 'Sol Ring Test', quantity: 1, set: 'tsa', number: '11' },
    { name: 'Sol Ring Test', quantity: 1, set: 'tsb', number: '22' }
  ];

  const preview = await api(owner.token, `/api/decks/${deck.body.id}/import`, {
    method: 'POST', body: { lines, apply: false }
  });
  assert.strictEqual(preview.status, 200, JSON.stringify(preview.body));

  assert.strictEqual(preview.body.summary.lines_refused, 1, 'exactly the second line is refused');
  assert.strictEqual(preview.body.summary.refused_copies, 1);

  // THE REFUSAL IS NAMED AND EXPLAINED, on the preview, before anything is
  // written. That is the whole point of pre-flight: the user sees what will
  // happen before it happens.
  const refusal = preview.body.summary.refusals[0];
  assert.strictEqual(refusal.name, 'Sol Ring Test', 'refused lines are NAMED');
  assert.strictEqual(refusal.code, 'COMMANDER_SINGLETON');
  assert.ok(/already in this deck/i.test(refusal.reason), `must state why: ${refusal.reason}`);

  // A preview writes nothing at all.
  assert.strictEqual((await deckRows(deck.body.id)).filter(r => r.name === 'Sol Ring Test').length, 0);
});

test('F13-TC16', 'import APPLIES the good line and refuses the duplicate, conserving every copy', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Import Apply',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });

  const lines = [
    { name: 'Sol Ring Test', quantity: 1, set: 'tsa', number: '11' },
    { name: 'Sol Ring Test', quantity: 1, set: 'tsb', number: '22' }
  ];

  const applied = await api(owner.token, `/api/decks/${deck.body.id}/import`, {
    method: 'POST', body: { lines, apply: true }
  });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));

  // Exactly ONE Sol Ring row -- the first line -- exists in the database.
  const solRings = (await deckRows(deck.body.id)).filter(r => r.name === 'Sol Ring Test');
  assert.strictEqual(solRings.length, 1, 'only the accepted line became a row');
  assert.strictEqual(solRings[0].desired_card_id, 'sol-a');

  // THE CONSERVATION INVARIANT (PR 6D) still balances: copies requested equals
  // copies written plus copies explicitly reported. A refusal is an explicitly
  // reported copy, not a silently dropped one.
  const s = applied.body.summary;
  assert.strictEqual(
    s.written_copies + s.unresolved_copies, s.requested_copies,
    `conservation broken: ${JSON.stringify(s)}`
  );
  assert.strictEqual(s.written_copies, 1);
  assert.strictEqual(s.refused_copies, 1);
});

test('F13-TC17', 'import refuses a line duplicating a card ALREADY in the deck', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Import Existing Dupe',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });

  const added = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'sol-a', desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(added.status, 200, JSON.stringify(added.body));

  const result = await api(owner.token, `/api/decks/${deck.body.id}/import`, {
    method: 'POST',
    body: { lines: [{ name: 'Sol Ring Test', quantity: 1, set: 'tsb', number: '22' }], apply: true }
  });
  assert.strictEqual(result.status, 200, JSON.stringify(result.body));
  assert.strictEqual(result.body.summary.lines_refused, 1);
  assert.strictEqual(result.body.summary.written_copies, 0, 'nothing was imported');

  const solRings = (await deckRows(deck.body.id)).filter(r => r.name === 'Sol Ring Test');
  assert.strictEqual(solRings.length, 1, 'the existing entry is untouched');
  assert.strictEqual(solRings[0].desired_card_id, 'sol-a');
});

test('F13-TC18', 'import into a NON-Commander deck refuses nothing', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST', body: { name: 'Modern Import', format: 'Modern', target_size: 60 }
  });

  const result = await api(owner.token, `/api/decks/${deck.body.id}/import`, {
    method: 'POST',
    body: {
      lines: [
        { name: 'Sol Ring Test', quantity: 1, set: 'tsa', number: '11' },
        { name: 'Sol Ring Test', quantity: 1, set: 'tsb', number: '22' }
      ],
      apply: true
    }
  });
  assert.strictEqual(result.status, 200, JSON.stringify(result.body));
  assert.strictEqual(result.body.summary.lines_refused, 0,
    'singleton must not leak into other formats');
  assert.strictEqual(result.body.summary.written_copies, 2);
  assert.strictEqual((await deckRows(deck.body.id)).filter(r => r.name === 'Sol Ring Test').length, 2);
});

test('F13-TC19', 'import lets many basic lands through', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Import Basics',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });

  const result = await api(owner.token, `/api/decks/${deck.body.id}/import`, {
    method: 'POST',
    body: {
      lines: [
        { name: 'Swamp', quantity: 10, set: 'tsa', number: '33' },
        { name: 'Swamp', quantity: 5, set: 'tsb', number: '44' }
      ],
      apply: true
    }
  });
  assert.strictEqual(result.status, 200, JSON.stringify(result.body));
  assert.strictEqual(result.body.summary.lines_refused, 0, 'basics are exempt');
  assert.strictEqual(result.body.summary.written_copies, 15);
});

test('F13-TC20', 'a line needing a printing choice still asks, and is not confused with a refusal', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Import Ambiguous',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });

  // A BARE line for a card the user owns no free copies of. The app has no
  // basis at all to choose a printing, so it must ask -- and asking is a
  // completely different outcome from refusing.
  const preview = await api(owner.token, `/api/decks/${deck.body.id}/import`, {
    method: 'POST', body: { lines: [{ name: 'Ambiguous Test', quantity: 1 }], apply: false }
  });
  assert.strictEqual(preview.status, 200, JSON.stringify(preview.body));

  const line = preview.body.lines[0];
  assert.strictEqual(line.needs_choice, true, 'the picker must still appear where it is genuinely needed');
  assert.ok(!line.refused, 'needing a choice is not a refusal');
  assert.ok(line.choices.length >= 2, 'the printings to choose from must be offered');
  assert.strictEqual(preview.body.summary.lines_refused, 0);
  assert.strictEqual(preview.body.summary.lines_needing_choice, 1);
});

// ---------------------------------------------------------------------------
// THE BROWSE-COLLECTION CONTRACT
//
// The "no redundant picker" fix is a frontend change, but it rests entirely on
// a promise the API has to keep: GET /api/collection must report the FINISH of
// every row. Without it the client cannot separate rows per printing+finish,
// cannot render the FOIL badge, and has nothing exact to add.
// ---------------------------------------------------------------------------

test('F13-TC21', 'the collection read reports finish, so a foil row is distinguishable', async ({ browser }) => {
  const nonfoilId = await ownCopy(browser.token, 'browse-card', 'nonfoil');
  const foilId = await ownCopy(browser.token, 'browse-card', 'foil');

  const list = await api(browser.token, '/api/collection');
  assert.strictEqual(list.status, 200);

  const nonfoil = list.body.find(i => i.entry_id === nonfoilId);
  const foil = list.body.find(i => i.entry_id === foilId);
  assert.ok(nonfoil && foil, 'both copies must be readable');

  // Same printing, same name, same collector number -- ONLY the finish tells
  // them apart. If the API did not report it the two rows would be literally
  // indistinguishable on screen, which is the bug requirement 2 is about.
  assert.strictEqual(nonfoil.card_id, foil.card_id, 'same printing, deliberately');
  assert.strictEqual(nonfoil.finish, 'nonfoil');
  assert.strictEqual(foil.finish, 'foil', 'the read path must report the foil finish');
});

test('F13-TC22', 'adding the exact variant a browse row names needs no further question', async ({ browser }) => {
  // What the client does when + is clicked on a per-printing row: it sends the
  // row's own (printing, finish) straight through. No picker, no lookup, no
  // second choice. This is that request, and it must simply work.
  const deck = await api(browser.token, '/api/decks', {
    method: 'POST', body: { name: 'Browse Add', format: 'Modern', target_size: 60 }
  });

  const added = await api(browser.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'browse-card', desired_finish: 'foil', quantity: 1 }
  });
  assert.strictEqual(added.status, 200, JSON.stringify(added.body));

  const rows = await deckRows(deck.body.id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].desired_card_id, 'browse-card');
  assert.strictEqual(rows[0].desired_finish, 'foil',
    'the exact finish the row named is what lands in the deck');
});

test('F13-TC23', 'singleton still applies to a NON-exempt card with an accented name', async ({ owner }) => {
  // The bug this guards: normalizeName strips diacritics to make the exemption
  // list spelling-proof, but SQLite's LOWER() is ASCII-only. A SQL-side
  // LOWER(name) = <stripped key> comparison silently never matches, so every
  // accented card name would become exempt from singleton by accident -- and
  // nothing on screen would say the rule had stopped applying.
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Accented Singleton',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });

  const first = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'accent-a', desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(first.status, 200, JSON.stringify(first.body));

  // A different printing of the same accented name.
  const second = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'accent-b', desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(second.status, 409,
    `an accented name must not slip past singleton: ${JSON.stringify(second.body)}`);

  assert.strictEqual(
    (await deckRows(deck.body.id)).filter(r => /Jur/.test(r.name)).length, 1
  );
});

// ---------------------------------------------------------------------------
// THE SINGLETON INVARIANT, ACROSS EVERY WRITE PATH
//
// The rule these cases exist to hold:
//
//   A Commander-format deck must NEVER contain two entries with the same card
//   name, no matter which route put them there -- creation, add, import,
//   repin, commander assignment or swap. Basic lands and the any-number list
//   in commanderRules.js are the only exemptions.
//
// The two cases below are the routes that USED to be able to break it. Both
// assert on database rows rather than on status codes, because the thing that
// must be true is about the deck the user opens, not about an HTTP response.
// ---------------------------------------------------------------------------

test('F13-TC24', 'the collection bulk add-to-deck route cannot smuggle a duplicate name in', async ({ owner }) => {
  // BLOCKER 1. The deck's own add route refuses a second Sol Ring by name.
  // The collection screen's "add selected to deck" bulk action wrote
  // deck_cards directly, never consulting the rule -- so selecting a second
  // printing in the collection and pushing it to the deck produced exactly
  // the illegal deck the add route refuses to produce.
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Bulk Bypass',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });
  assert.strictEqual(deck.status, 201, JSON.stringify(deck.body));

  const first = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(first.status, 200, JSON.stringify(first.body));

  // A DIFFERENT printing of the same card name, owned in the collection.
  const entryId = await ownCopy(owner.token, 'dup-solring-b', 'nonfoil');

  const bulk = await api(owner.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: [entryId], action: 'add_to_deck', value: deck.body.id }
  });

  // The rows are the assertion. Whatever the route chooses to report, the
  // deck must not be holding two cards of one name.
  //
  // UPDATED for Zach's 2026-08-18 ruling: this no longer reports-and-skips.
  // The whole selection is validated FIRST, so an unconfirmed selection
  // containing a refusal writes nothing at all. The bypass being closed is
  // still exactly what is proven here -- only the reporting shape moved.
  const rows = await deckRows(deck.body.id);
  const solRings = rows.filter(r => r.name === 'Sol Ring Test');
  assert.strictEqual(solRings.length, 1,
    `bulk add-to-deck must not create a second Sol Ring Test by name: ${JSON.stringify(rows)}`);
  assert.strictEqual(solRings[0].desired_card_id, 'dup-solring-a',
    'the entry that was already legitimately in the deck must survive untouched');
  assert.strictEqual(bulk.status, 409,
    `the problem must be reported before anything is applied: ${JSON.stringify(bulk.body)}`);
  assert.strictEqual(bulk.body.code, 'BULK_ADD_PREFLIGHT');
  assert.strictEqual((bulk.body.problems || []).length, 1,
    'the refusal must be reported to the user, not silently swallowed');
  assert.ok(/Sol Ring Test/.test(JSON.stringify(bulk.body)),
    'the refusal must NAME the card so the user knows what was refused');
});

test('F13-TC25', 'bulk add-to-deck still allows exempt cards and untouched formats', async ({ owner }) => {
  // The other half of TC24: closing the bypass must not start refusing legal
  // adds. Basic lands are exempt, and a non-Commander deck is not subject to
  // the rule at all.
  const edh = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Bulk Exempt',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-piper', desired_finish: 'nonfoil' }]
    }
  });
  await api(owner.token, `/api/decks/${edh.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'basic-swamp-a', desired_finish: 'nonfoil', quantity: 1 }
  });
  const swampEntry = await ownCopy(owner.token, 'basic-swamp-b', 'nonfoil');
  const swampBulk = await api(owner.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: [swampEntry], action: 'add_to_deck', value: edh.body.id }
  });
  assert.strictEqual(swampBulk.status, 200, JSON.stringify(swampBulk.body));
  assert.strictEqual(
    (await deckRows(edh.body.id)).filter(r => r.name === 'Swamp').length, 2,
    'basic lands are exempt: a second Swamp printing must still go in'
  );

  const modern = await api(owner.token, '/api/decks', {
    method: 'POST', body: { name: 'Bulk Modern', format: 'Modern', target_size: 60 }
  });
  await api(owner.token, `/api/decks/${modern.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', quantity: 1 }
  });
  const modernEntry = await ownCopy(owner.token, 'sol-b', 'nonfoil');
  const modernBulk = await api(owner.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: [modernEntry], action: 'add_to_deck', value: modern.body.id }
  });
  assert.strictEqual(modernBulk.status, 200, JSON.stringify(modernBulk.body));
  assert.strictEqual(
    (await deckRows(modern.body.id)).filter(r => r.name === 'Sol Ring Test').length, 2,
    'a Modern deck is untouched by the Commander singleton rule'
  );
});

test('F13-TC26', 'a deck cannot be CREATED holding two commanders of the same name', async ({ owner }) => {
  // BLOCKER 2. The create path checked that the two commanders were different
  // (printing, finish) IDENTITIES, which is not the same question as the
  // format rule. Two printings of Atraxa are two different physical objects
  // and one card name -- legal as inventory, illegal as a partner pair.
  const before = (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [owner.id])).n;

  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Twin Atraxa',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-atraxa-b', desired_finish: 'nonfoil' }
      ]
    }
  });

  assert.strictEqual(response.status, 409,
    `two commanders of one name must be refused: ${JSON.stringify(response.body)}`);
  assert.ok(/Atraxa Test/.test(String(response.body && response.body.error)),
    'the refusal must name the card and say why');

  // Nothing at all may be left behind. A refused create that still wrote a
  // deck row would leave the user an illegal deck they never asked for.
  const after = (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [owner.id])).n;
  assert.strictEqual(after, before, 'a refused create must write no deck');
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE name = 'Twin Atraxa'`)).n, 0
  );
});

test('F13-TC27', 'a deck cannot be CREATED with one commander in two finishes', async ({ owner }) => {
  // The sibling of TC26. Same printing, different finish, is a distinct
  // identity and a distinct physical card -- and still one card name.
  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Foil Twin Atraxa',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-atraxa', desired_finish: 'foil' }
      ]
    }
  });

  assert.strictEqual(response.status, 409,
    `one card name in two finishes is still one card name: ${JSON.stringify(response.body)}`);
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE name = 'Foil Twin Atraxa'`)).n, 0,
    'a refused create must write no deck'
  );
});

test('F13-TC28', 'a legitimate partner pair of two different cards is still created', async ({ owner }) => {
  // The proving negative for TC26/TC27: the create-path name check must refuse
  // duplicates WITHOUT refusing the legal partner pair it sits next to.
  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Real Partners',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-thrasios', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-piper', desired_finish: 'nonfoil' }
      ]
    }
  });
  assert.strictEqual(response.status, 201, JSON.stringify(response.body));

  const rows = await deckRows(response.body.id);
  assert.strictEqual(rows.length, 2, 'both commanders must be written');
  assert.deepStrictEqual(
    rows.map(r => r.name).sort(), ['Piper Test', 'Thrasios Test']
  );
  assert.ok(rows.every(r => r.board === 'commander'));
});

// ---------------------------------------------------------------------------
// MULTI-SELECT ADD VALIDATES THE WHOLE SELECTION BEFORE IT WRITES ANYTHING
//
// Zach, 2026-08-18: "if its taking in a list it should verify the list before
// adding and giving you errors if the list has issues like duplicates or
// something."
//
// This SUPERSEDES the report-and-skip behaviour TC24 originally asserted. The
// concern is not partial success in the abstract -- it is that the user should
// see the problems BEFORE anything is written, exactly as the import pre-flight
// already does. So the bulk route now behaves like import: judge the entire
// selection against one snapshot, report everything that will not apply, and
// write nothing until the user confirms.
// ---------------------------------------------------------------------------

test('F13-TC29', 'a multi-select containing a duplicate reports the problem and writes NOTHING', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Preflight Refusal',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });
  assert.strictEqual(deck.status, 201, JSON.stringify(deck.body));

  // One card already legitimately in the deck.
  const seeded = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(seeded.status, 200, JSON.stringify(seeded.body));

  const before = await deckRows(deck.body.id);

  // A selection of THREE cards: two that would apply cleanly, and one that is
  // a second printing of a name already in the deck.
  const goodA = await ownCopy(owner.token, 'pf-good-a', 'nonfoil');
  const goodB = await ownCopy(owner.token, 'pf-good-b', 'nonfoil');
  const bad = await ownCopy(owner.token, 'dup-solring-b', 'nonfoil');

  const bulk = await api(owner.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: [goodA, goodB, bad], action: 'add_to_deck', value: deck.body.id }
  });

  // THE ASSERTION THAT MATTERS: nothing at all was written. Not the two good
  // cards, not the bad one. The user is told first.
  const after = await deckRows(deck.body.id);
  assert.deepStrictEqual(
    after.map(r => `${r.desired_card_id}|${r.desired_finish}|${r.quantity}`),
    before.map(r => `${r.desired_card_id}|${r.desired_finish}|${r.quantity}`),
    `a selection with a problem must write NOTHING until confirmed: ${JSON.stringify(after)}`
  );

  assert.strictEqual(bulk.status, 409,
    `the selection must be reported back, not applied: ${JSON.stringify(bulk.body)}`);
  assert.strictEqual(bulk.body.code, 'BULK_ADD_PREFLIGHT');
  assert.ok(Array.isArray(bulk.body.problems) && bulk.body.problems.length === 1,
    `exactly the one bad card must be reported: ${JSON.stringify(bulk.body)}`);
  assert.ok(/Sol Ring Test/.test(bulk.body.problems[0].message),
    'the report must NAME the card and say why');
  assert.strictEqual(bulk.body.applicable, 2,
    'the report must say how many of the selection WOULD apply');
});

test('F13-TC30', 'a valid multi-select still applies fully, in one go', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Preflight Clean',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-thrasios', desired_finish: 'nonfoil' }]
    }
  });
  assert.strictEqual(deck.status, 201, JSON.stringify(deck.body));

  const a = await ownCopy(owner.token, 'pf-clean-a', 'nonfoil');
  const b = await ownCopy(owner.token, 'pf-clean-b', 'nonfoil');

  const bulk = await api(owner.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: [a, b], action: 'add_to_deck', value: deck.body.id }
  });

  assert.strictEqual(bulk.status, 200,
    `a clean selection must apply without a confirmation round-trip: ${JSON.stringify(bulk.body)}`);
  assert.strictEqual(bulk.body.affected, 2);

  const rows = await deckRows(deck.body.id);
  const names = rows.filter(r => r.board === 'mainboard').map(r => r.desired_card_id).sort();
  assert.deepStrictEqual(names, ['pf-clean-a', 'pf-clean-b'],
    `both selected cards must be in the deck: ${JSON.stringify(rows)}`);
});

test('F13-TC31', 'a confirmed multi-select applies the good cards and still names the refused one', async ({ owner }) => {
  // The second half of the import pre-flight shape: having SEEN the problem,
  // the user may proceed, and then the refused card is still named rather than
  // silently dropped.
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Preflight Confirmed',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-piper', desired_finish: 'nonfoil' }]
    }
  });
  await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', quantity: 1 }
  });

  const good = await ownCopy(owner.token, 'pf-conf-a', 'nonfoil');
  const bad = await ownCopy(owner.token, 'dup-solring-b', 'nonfoil');

  const bulk = await api(owner.token, '/api/collection/bulk', {
    method: 'POST',
    body: {
      entry_ids: [good, bad], action: 'add_to_deck', value: deck.body.id, confirm: true
    }
  });

  assert.strictEqual(bulk.status, 200, JSON.stringify(bulk.body));
  assert.strictEqual(bulk.body.affected, 1);
  assert.strictEqual(bulk.body.rejected, 1);
  assert.ok(/Sol Ring Test/.test(JSON.stringify(bulk.body)),
    'the refused card must still be named after a confirm');

  const rows = await deckRows(deck.body.id);
  assert.strictEqual(rows.filter(r => r.name === 'Sol Ring Test').length, 1,
    'the deck must still hold exactly one Sol Ring Test');
  assert.strictEqual(rows.filter(r => r.desired_card_id === 'pf-conf-a').length, 1,
    'the good card must have been applied');
});

test('F13-TC32', 'a non-Commander deck is entirely unaffected by the pre-flight', async ({ owner }) => {
  const modern = await api(owner.token, '/api/decks', {
    method: 'POST', body: { name: 'Preflight Modern', format: 'Modern', target_size: 60 }
  });
  await api(owner.token, `/api/decks/${modern.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', quantity: 1 }
  });
  const entry = await ownCopy(owner.token, 'sol-a', 'nonfoil');

  const bulk = await api(owner.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: [entry], action: 'add_to_deck', value: modern.body.id }
  });

  assert.strictEqual(bulk.status, 200,
    `a Modern deck must never see a singleton pre-flight: ${JSON.stringify(bulk.body)}`);
  assert.strictEqual(
    (await deckRows(modern.body.id)).filter(r => r.name === 'Sol Ring Test').length, 2,
    'a second printing is an ordinary, legal add in Modern'
  );
});

// ---------------------------------------------------------------------------
// COMMANDER PAIRING
//
// Two distinct rules that must not be conflated:
//   SAME NAME  -> REFUSED. It is the singleton rule applied to the command
//                 zone, and singleton is the one hard refusal in this app.
//   ILLEGAL PAIR -> WARNED. Whether two cards may legally partner is a
//                 LEGALITY question, and legality is warning-only per the
//                 settled rules.
// ---------------------------------------------------------------------------

test('F13-TC33', 'two commanders of one name are refused on SWAP, not only on creation', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Swap Twin',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });
  assert.strictEqual(deck.status, 201, JSON.stringify(deck.body));

  // A DIFFERENT printing of the same commander name, added to the command
  // zone after the fact. This is the route a user takes when they "add a
  // second commander" from the deck screen rather than at creation.
  const swap = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'cmd-atraxa-b', desired_finish: 'nonfoil', board: 'commander', quantity: 1 }
  });

  assert.strictEqual(swap.status, 409,
    `the swap path must refuse a second commander of the same name: ${JSON.stringify(swap.body)}`);
  assert.ok(/Atraxa Test/.test(String(swap.body && swap.body.error)),
    'the refusal must name the card');

  const rows = await deckRows(deck.body.id);
  assert.strictEqual(rows.filter(r => r.board === 'commander').length, 1,
    `a refused swap must leave exactly one commander: ${JSON.stringify(rows)}`);
});

test('F13-TC34', 'a legal partner pair creates with no pairing warning', async ({ owner }) => {
  // Thrasios and The Prismatic Piper both carry the Partner keyword, so this
  // pair is legal and must produce no complaint at all.
  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Legal Partners',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-thrasios', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-piper', desired_finish: 'nonfoil' }
      ]
    }
  });
  assert.strictEqual(response.status, 201, JSON.stringify(response.body));
  assert.ok(Array.isArray(response.body.warnings),
    'create must report the deck it just made, warnings included');
  assert.strictEqual(
    response.body.warnings.filter(w => w.code === 'COMMANDER_PAIR_ILLEGAL').length, 0,
    `a real partner pair must not be flagged: ${JSON.stringify(response.body.warnings)}`
  );

  // And the deck view must agree with what create said.
  const detail = await api(owner.token, `/api/decks/${response.body.id}`);
  assert.strictEqual(
    detail.body.warnings.filter(w => w.code === 'COMMANDER_PAIR_ILLEGAL').length, 0
  );
});

test('F13-TC35', 'an illegal pair of two arbitrary legendaries is REFUSED, not warned', async ({ owner }) => {
  // SUPERSEDES the original warning-only assertion (Zach, 2026-08-18). An
  // illegal commander pairing is a foundation the user cannot fix by
  // continuing to work -- every other card in the deck is validated against
  // the colour identity it defines -- so it is refused at the point it is
  // introduced rather than reported afterwards.
  const before = (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [owner.id])).n;

  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Arbitrary Pair',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-krenko', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-gishath', desired_finish: 'nonfoil' }
      ]
    }
  });

  assert.strictEqual(response.status, 409,
    `an illegal pairing must be refused: ${JSON.stringify(response.body)}`);
  assert.strictEqual(response.body.code, 'COMMANDER_PAIR_ILLEGAL');
  assert.ok(/Krenko Test/.test(String(response.body.error))
    && /Gishath Test/.test(String(response.body.error)),
    `the refusal must name both cards: ${response.body.error}`);

  // The refusal must say an override exists, otherwise a user holding a card
  // the parser does not yet understand has no way forward and no way to know
  // there is one.
  assert.strictEqual(response.body.overridable, true,
    `a pairing refusal must advertise that it can be overridden: ${JSON.stringify(response.body)}`);

  // THE ASSERTION THAT MATTERS: a refused create leaves NOTHING behind.
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [owner.id])).n, before,
    'a refused create must roll the deck row back with it'
  );
});

test('F13-TC39', 'a pairing refusal is overridable WITH a reason, and the override is recorded', async ({ owner }) => {
  // THE FEEDBACK LOOP. Pairing legality is read out of oracle text, and
  // Wizards prints new pairing mechanics most sets -- so the app can be wrong
  // in a way the singleton rule never can. The override is how a user with a
  // genuinely legal pair gets past a parser that has not learned the mechanic
  // yet, and the recorded reason is the bug report that makes the parser
  // better.
  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Overridden Pair',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-krenko', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-gishath', desired_finish: 'nonfoil' }
      ],
      commander_override: { reason: 'Both have Backup Partner from the new set' }
    }
  });

  assert.strictEqual(response.status, 201,
    `an explicit override with a reason must be honoured: ${JSON.stringify(response.body)}`);

  const rows = await deckRows(response.body.id);
  assert.strictEqual(rows.filter(r => r.board === 'commander').length, 2,
    'an overridden pair must actually be written');

  // RECORDED: both card ids AND names, the reason, and a timestamp.
  const logged = await db.get(
    `SELECT * FROM audit_logs
     WHERE user_id = ? AND action_type = 'COMMANDER_PAIR_OVERRIDE'
     ORDER BY id DESC LIMIT 1`,
    [owner.id]
  );
  assert.ok(logged, 'the override must be recorded, not merely allowed');
  assert.ok(logged.created_at, 'the record must carry a timestamp');

  const detail = JSON.parse(logged.after_state);
  assert.strictEqual(detail.reason, 'Both have Backup Partner from the new set',
    `the reason the user gave must be stored verbatim: ${logged.after_state}`);
  const ids = detail.cards.map(c => c.id).sort();
  const names = detail.cards.map(c => c.name).sort();
  assert.deepStrictEqual(ids, ['cmd-gishath', 'cmd-krenko'],
    `both card IDs must be recorded: ${logged.after_state}`);
  assert.deepStrictEqual(names, ['Gishath Test', 'Krenko Test'],
    `both card NAMES must be recorded -- an id alone is not a worked example`);

  // ...and it must be RETRIEVABLE through the surface that already exists.
  const logs = await api(owner.token, '/api/audit-logs');
  assert.strictEqual(logs.status, 200, JSON.stringify(logs.body));
  assert.ok((logs.body.logs || []).some(l => l.action_type === 'COMMANDER_PAIR_OVERRIDE'),
    'recorded overrides must be reviewable, or they are not a feedback loop');
});

test('F13-TC40', 'an override WITHOUT a reason is rejected', async ({ owner }) => {
  // Silence is not consent, and neither is a bare flag. The reason IS the
  // point of the override: without it the record is an audit formality rather
  // than a report that detection failed on a real mechanic.
  const before = (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [owner.id])).n;

  for (const override of [{}, { reason: '' }, { reason: '   ' }, true,
    // Shapes that would PASS a coercing check while recording something no
    // human can act on. The reason exists to be read later; "123" and
    // "[object Object]" are not reports, so they must be refused too.
    { reason: 123 }, { reason: {} }, { reason: null }, ['a reason'], 'a reason']) {
    const response = await api(owner.token, '/api/decks', {
      method: 'POST',
      body: {
        name: `Reasonless ${JSON.stringify(override)}`,
        format: 'Commander / EDH',
        commanders: [
          { desired_card_id: 'cmd-krenko', desired_finish: 'nonfoil' },
          { desired_card_id: 'cmd-gishath', desired_finish: 'nonfoil' }
        ],
        commander_override: override
      }
    });
    assert.strictEqual(response.status, 409,
      `a reasonless override must not pass: ${JSON.stringify(override)} -> ${JSON.stringify(response.body)}`);
    assert.strictEqual(response.body.code, 'COMMANDER_OVERRIDE_REASON_REQUIRED',
      `and it must say WHY it did not pass: ${JSON.stringify(response.body)}`);
  }

  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [owner.id])).n, before,
    'no reasonless override may leave a deck behind'
  );
  const stray = await db.get(
    `SELECT COUNT(*) AS n FROM audit_logs
     WHERE user_id = ? AND action_type = 'COMMANDER_PAIR_OVERRIDE'
       AND after_state LIKE '%Reasonless%'`,
    [owner.id]
  );
  assert.strictEqual(stray.n, 0, 'a rejected override must record nothing');
});

test('F13-TC41', 'a card that is not a legal commander in its own right is REFUSED', async ({ owner }) => {
  // Rule 3. A Sol Ring is not a commander, and a deck built on one is not a
  // deck. Like pairing, this is read off the card's type line and text, so it
  // is refused-but-overridable for the same reason.
  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Artifact Commander',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'sol-a', desired_finish: 'nonfoil' }]
    }
  });

  assert.strictEqual(response.status, 409,
    `a non-legendary non-commander must be refused: ${JSON.stringify(response.body)}`);
  assert.strictEqual(response.body.code, 'COMMANDER_NOT_LEGAL');
  assert.ok(/Sol Ring Test/.test(String(response.body.error)),
    `the refusal must name the card: ${response.body.error}`);

  // A card whose TEXT says it can be your commander is legal even though it is
  // not a legendary creature -- the rule is about what the card says, not
  // about its type line alone.
  const planeswalker = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Text Says So',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-can-be', desired_finish: 'nonfoil' }]
    }
  });
  assert.strictEqual(planeswalker.status, 201,
    `"can be your commander" must be honoured: ${JSON.stringify(planeswalker.body)}`);
});

test('F13-TC42', 'two commanders sharing a NAME stay refused and are NOT overridable', async ({ owner }) => {
  // The fixed rule. Singleton has no override because the app cannot be wrong
  // about it: two cards named Atraxa Test is always illegal, no printing and
  // no future set changes that. Offering an override here would let a user
  // talk themselves into an unplayable deck.
  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Same Name Override Attempt',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-atraxa-b', desired_finish: 'nonfoil' }
      ],
      commander_override: { reason: 'I am certain this is fine' }
    }
  });

  assert.strictEqual(response.status, 409,
    `singleton must refuse even with an override: ${JSON.stringify(response.body)}`);
  assert.strictEqual(response.body.code, 'COMMANDER_SINGLETON',
    'the singleton refusal must survive an override attempt unchanged');
  assert.notStrictEqual(response.body.overridable, true,
    'singleton must NOT advertise itself as overridable');

  const logged = await db.get(
    `SELECT COUNT(*) AS n FROM audit_logs
     WHERE user_id = ? AND action_type = 'COMMANDER_PAIR_OVERRIDE'
       AND after_state LIKE '%Atraxa%'`,
    [owner.id]
  );
  assert.strictEqual(logged.n, 0, 'a refused singleton must record no override');
});

test('F13-TC43', 'the SWAP path enforces pairing too, and honours the same override', async ({ owner }) => {
  // The rule lives at the write choke point, so a route that was not written
  // with pairing in mind still cannot produce an illegal command zone.
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Swap Pairing',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-krenko', desired_finish: 'nonfoil' }]
    }
  });
  assert.strictEqual(deck.status, 201, JSON.stringify(deck.body));

  const refused = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'cmd-gishath', desired_finish: 'nonfoil', board: 'commander', quantity: 1 }
  });
  assert.strictEqual(refused.status, 409,
    `adding a second illegal commander must be refused: ${JSON.stringify(refused.body)}`);
  assert.strictEqual(refused.body.code, 'COMMANDER_PAIR_ILLEGAL');

  assert.strictEqual((await deckRows(deck.body.id)).filter(r => r.board === 'commander').length, 1,
    'a refused swap must leave the command zone exactly as it was');

  const overridden = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: {
      desired_card_id: 'cmd-gishath', desired_finish: 'nonfoil', board: 'commander', quantity: 1,
      commander_override: { reason: 'Judge confirmed at the LGS' }
    }
  });
  assert.strictEqual(overridden.status, 200,
    `the same override must work on the swap path: ${JSON.stringify(overridden.body)}`);
  assert.strictEqual((await deckRows(deck.body.id)).filter(r => r.board === 'commander').length, 2,
    'an overridden swap must actually write the second commander');
});

test('F13-TC44', 'deck CONTENTS legality still only WARNS -- the refusal is scoped to the command zone', async ({ owner }) => {
  // The boundary Zach drew, asserted so it cannot be widened by accident.
  // An unfinished deck is a normal state the user fixes by continuing to
  // work, so it warns. An illegal commander is a foundation that can never
  // become legal, so it refuses.
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Contents Still Warn',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-krenko', desired_finish: 'nonfoil' }]
    }
  });
  assert.strictEqual(deck.status, 201, JSON.stringify(deck.body));

  // A card the user does not own, added to the 99. This is a CONTENTS
  // problem: it must be accepted and warned about, never refused.
  const added = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'sol-a', desired_finish: 'nonfoil', board: 'mainboard', quantity: 1 }
  });
  assert.strictEqual(added.status, 200,
    `deck contents must never be refused on legality grounds: ${JSON.stringify(added.body)}`);

  const rows = await deckRows(deck.body.id);
  assert.strictEqual(rows.filter(r => r.board === 'mainboard').length, 1,
    'the card must actually be in the deck -- a warning does not block');

  const detail = await api(owner.token, `/api/decks/${deck.body.id}`);
  assert.ok(Array.isArray(detail.body.warnings),
    'contents problems are still reported, as warnings');
  assert.strictEqual(
    detail.body.warnings.filter(w => w.code === 'COMMANDER_PAIR_ILLEGAL').length, 0,
    'a legal single commander produces no pairing complaint'
  );
});

test('F13-TC45', 'non-Commander formats are entirely unaffected by the pairing refusal', async ({ owner }) => {
  // Two arbitrary legendaries on the commander board of a MODERN deck is not
  // the pairing rule's business. A rule that leaks into another format is a
  // bug even when the rule itself is right.
  const modern = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: { name: 'Modern Unaffected', format: 'Modern', target_size: 60 }
  });
  assert.strictEqual(modern.status, 201, JSON.stringify(modern.body));

  for (const id of ['cmd-krenko', 'cmd-gishath']) {
    const added = await api(owner.token, `/api/decks/${modern.body.id}/cards`, {
      method: 'POST',
      body: { desired_card_id: id, desired_finish: 'nonfoil', board: 'commander', quantity: 1 }
    });
    assert.strictEqual(added.status, 200,
      `Modern must not see the commander rules: ${JSON.stringify(added.body)}`);
  }
  assert.strictEqual((await deckRows(modern.body.id)).length, 2,
    'both entries must be written for a non-Commander deck');
});

test('F13-TC36', 'a single commander is never flagged as a bad pairing', async ({ owner }) => {
  // Krenko alone is a perfectly ordinary Commander deck. The pairing rule must
  // not fire when there is nothing to pair.
  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Solo Krenko',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-krenko', desired_finish: 'nonfoil' }]
    }
  });
  assert.strictEqual(response.status, 201, JSON.stringify(response.body));
  assert.strictEqual(
    (response.body.warnings || []).filter(w => w.code === 'COMMANDER_PAIR_ILLEGAL').length, 0,
    'one commander is not a pairing'
  );

  const modern = await api(owner.token, '/api/decks', {
    method: 'POST', body: { name: 'Pairing Modern', format: 'Modern', target_size: 60 }
  });
  assert.strictEqual(modern.status, 201, JSON.stringify(modern.body));
  const detail = await api(owner.token, `/api/decks/${modern.body.id}`);
  assert.strictEqual(
    detail.body.warnings.filter(w => w.code === 'COMMANDER_PAIR_ILLEGAL').length, 0,
    'non-Commander formats never see the pairing rule'
  );
});

test('F13-TC37', 'a Background pairing and a Partner-with pairing are both recognised as legal', async ({ owner }) => {
  // The mechanic is read from the card TEXT, not from a hardcoded list of
  // names -- a list would go stale with every set. These two shapes exercise
  // the two non-plain-Partner forms.
  const background = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Background Pair',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-chooser', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-background', desired_finish: 'nonfoil' }
      ]
    }
  });
  assert.strictEqual(background.status, 201, JSON.stringify(background.body));
  assert.strictEqual(
    (background.body.warnings || []).filter(w => w.code === 'COMMANDER_PAIR_ILLEGAL').length, 0,
    `Choose a Background + a Background is a legal pair: ${JSON.stringify(background.body.warnings)}`
  );

  const partnerWith = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Partner With Pair',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-pw-left', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-pw-right', desired_finish: 'nonfoil' }
      ]
    }
  });
  assert.strictEqual(partnerWith.status, 201, JSON.stringify(partnerWith.body));
  assert.strictEqual(
    (partnerWith.body.warnings || []).filter(w => w.code === 'COMMANDER_PAIR_ILLEGAL').length, 0,
    `Partner with names its own partner: ${JSON.stringify(partnerWith.body.warnings)}`
  );

  // ...and a Partner-with card paired with someone ELSE is REFUSED. "Partner
  // with X" names one specific card; pairing it with anyone else is illegal
  // even though the card carries the word Partner.
  const mismatched = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Wrong Partner With',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-pw-left', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-krenko', desired_finish: 'nonfoil' }
      ]
    }
  });
  assert.strictEqual(mismatched.status, 409,
    `Partner with X does not let you pair with Y: ${JSON.stringify(mismatched.body)}`);
  assert.strictEqual(mismatched.body.code, 'COMMANDER_PAIR_ILLEGAL');
  assert.ok(/Pw Right Test/.test(String(mismatched.body.error)),
    `the refusal must name the partner the card actually demands: ${mismatched.body.error}`);

  // A Background pairing is accepted ONLY when the sides match: a
  // "Choose a Background" card with another ordinary legend is not a pair.
  const badBackground = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Chooser Without Background',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-chooser', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-krenko', desired_finish: 'nonfoil' }
      ]
    }
  });
  assert.strictEqual(badBackground.status, 409,
    `Choose a Background needs an actual Background: ${JSON.stringify(badBackground.body)}`);
  assert.strictEqual(badBackground.body.code, 'COMMANDER_PAIR_ILLEGAL');

  // ...and a Background paired with a legend that does NOT say
  // "Choose a Background" is equally not a pair.
  const orphanBackground = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Background Without Chooser',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-background', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-krenko', desired_finish: 'nonfoil' }
      ]
    }
  });
  assert.strictEqual(orphanBackground.status, 409,
    `a Background needs a card that chooses one: ${JSON.stringify(orphanBackground.body)}`);
});

test('F13-TC38', 'a selection containing TWO PRINTINGS of one card is caught within the selection itself', async ({ owner }) => {
  // The duplicate is not against the deck -- the deck has neither card. It is
  // WITHIN THE LIST the user selected, which is literally the case Zach named:
  // "if the list has issues like duplicates or something". A pre-flight that
  // only compared each candidate against the stored deck would pass both and
  // then have the second one refused at write time.
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Selection Internal Dup',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-krenko', desired_finish: 'nonfoil' }]
    }
  });
  assert.strictEqual(deck.status, 201, JSON.stringify(deck.body));

  const a = await ownCopy(owner.token, 'sol-a', 'nonfoil');
  const b = await ownCopy(owner.token, 'sol-b', 'nonfoil');

  const bulk = await api(owner.token, '/api/collection/bulk', {
    method: 'POST',
    body: { entry_ids: [a, b], action: 'add_to_deck', value: deck.body.id }
  });

  assert.strictEqual(bulk.status, 409,
    `two printings of one name in one selection must be reported: ${JSON.stringify(bulk.body)}`);
  assert.strictEqual(bulk.body.code, 'BULK_ADD_PREFLIGHT');
  assert.strictEqual(bulk.body.applicable, 1,
    'exactly one of the two may apply');
  assert.strictEqual((bulk.body.problems || []).length, 1);
  assert.ok(/Sol Ring Test/.test(bulk.body.problems[0].message));

  // And nothing was written.
  const rows = await deckRows(deck.body.id);
  assert.strictEqual(rows.filter(r => r.name === 'Sol Ring Test').length, 0,
    `nothing may be written before the user confirms: ${JSON.stringify(rows)}`);
});

// ---------------------------------------------------------------------------
// THIN-CACHE HYDRATION (PR 6F refinement).
//
// THE PROBLEM. isLegalCommanderCard and checkCommanderPairing read type_line,
// subtypes, oracle_text and keywords. Every one of those fields, when MISSING,
// pushes the answer toward REFUSE -- no type line means not legendary, no
// oracle text means no partner mechanic. So a row the app cached without ever
// reading the card's text does not produce an uncertain answer, it produces a
// CONFIDENT WRONG ONE, and the user is blocked from a commander that is
// perfectly legal with no way to tell why.
//
// THE TWO ALTERNATIVES BOTH ACCEPT BEING WRONG. Refusing strictly wrongly
// blocks legal commanders. Softening the rule lets genuinely illegal ones
// through. Neither addresses the actual defect, which is that the app's DATA
// was incomplete -- not that its RULE was miscalibrated.
//
// THE FIX. When knowledge is insufficient to decide, get better knowledge
// rather than guessing in either direction: refetch the card and re-evaluate.
// It also self-heals -- the refetch updates card_cache, so the same card is
// correct from then on and never pays the round trip twice.
// ---------------------------------------------------------------------------

test('F13-TC46', 'a thin-cached commander that IS legal is ACCEPTED after a refetch, and the cache is healed', async ({ owner }) => {
  scryfallStub.reset();

  // Precondition: the row really is thin. If a future change starts seeding
  // this fixture fully, the case would pass for the wrong reason.
  const before = await db.get(`SELECT type_line, oracle_text, keywords FROM card_cache WHERE id = 'thin-legal'`);
  assert.strictEqual(before.type_line, null, 'fixture must start thin');
  assert.strictEqual(before.oracle_text, null, 'fixture must start thin');

  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Thin But Legal',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'thin-legal', desired_finish: 'nonfoil' }]
    }
  });

  assert.strictEqual(response.status, 201,
    `a legal commander must not be refused for a thin cache: ${JSON.stringify(response.body)}`);

  // The refetch actually happened -- this is the mechanism, not a coincidence.
  assert.ok(scryfallStub.calls.includes('thin-legal'),
    `the thin row must have been refetched: ${JSON.stringify(scryfallStub.calls)}`);

  // SELF-HEALING. The point of writing the fresh data back is that the NEXT
  // decision about this card is instant and correct. A refetch that decided
  // correctly but threw the answer away would re-pay the round trip forever.
  const after = await db.get(`SELECT type_line, oracle_text FROM card_cache WHERE id = 'thin-legal'`);
  assert.ok(/Legendary Creature/.test(String(after.type_line)),
    `card_cache must be updated with the fresh type_line, got ${JSON.stringify(after)}`);

  // And the commander is genuinely in the deck, not just un-refused.
  const rows = await deckRows(response.body.id);
  assert.strictEqual(rows.filter(r => r.board === 'commander').length, 1,
    'the accepted commander must actually be written');
});

test('F13-TC47', 'a genuinely illegal commander is STILL REFUSED once the refetch confirms it', async ({ owner }) => {
  // The refetch must not become a way to talk the app out of a correct
  // refusal. Better knowledge is not the same thing as a more permissive
  // answer -- on complete data this card is an artifact, and an artifact is
  // not a commander.
  scryfallStub.reset();
  const before = (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [owner.id])).n;

  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Thin And Illegal',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'thin-illegal', desired_finish: 'nonfoil' }]
    }
  });

  assert.strictEqual(response.status, 409,
    `complete data must still refuse a non-commander: ${JSON.stringify(response.body)}`);
  assert.strictEqual(response.body.code, 'COMMANDER_NOT_LEGAL');
  assert.ok(scryfallStub.calls.includes('thin-illegal'),
    'the refusal must have been checked against fresh data, not asserted from the thin row');
  assert.strictEqual(response.body.overridable, true,
    'a confirmed refusal still offers the override');

  // A refused create leaves NOTHING behind, refetch or not.
  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [owner.id])).n, before,
    'a refused create must roll back whole even when a refetch happened'
  );
});

test('F13-TC48', 'a commander with SUFFICIENT cached data is decided with NO refetch at all', async ({ owner }) => {
  // THE HAPPY PATH MUST STAY INSTANT. This is the constraint that stops the
  // refinement from quietly turning every commander selection into a
  // dependency on Scryfall being up. cmd-krenko is fully cached, so the rule
  // can already answer, and asking anyway would be a network call bought for
  // nothing.
  scryfallStub.reset();

  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Complete Data No Refetch',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-krenko', desired_finish: 'nonfoil' }]
    }
  });
  assert.strictEqual(response.status, 201, JSON.stringify(response.body));

  assert.deepStrictEqual(scryfallStub.calls, [],
    `sufficient cached data must cost ZERO Scryfall calls, got ${JSON.stringify(scryfallStub.calls)}`);
});

test('F13-TC49', 'a FAILED refetch is reported honestly -- never a silent pass, never a silent refuse', async ({ owner }) => {
  // A failed verification is NOT evidence of illegality. The app could not
  // check; it must say so, in those terms, rather than pretending it reached
  // either conclusion. Both silent outcomes are unacceptable: a silent pass
  // writes a possibly-illegal deck, and a silent refuse blames the user for
  // the app's outage.
  scryfallStub.reset();
  const rateLimit = new Error('Request failed with status code 429');
  rateLimit.response = { status: 429 };
  scryfallStub.failWith = rateLimit;

  // Its OWN thin fixture, not one another case uses. The hydration SELF-HEALS
  // the cache, so a fixture shared with TC46 would already be complete by the
  // time this case ran and there would be nothing left to fail on -- the case
  // would pass by accident and stop testing anything.
  const before = (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [owner.id])).n;

  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Refetch Fails',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'thin-unfetchable', desired_finish: 'nonfoil' }]
    }
  });

  assert.strictEqual(response.status, 503,
    `an unavailable verification is a 503, not a legality verdict: ${JSON.stringify(response.body)}`);
  assert.strictEqual(response.body.code, 'COMMANDER_VERIFY_UNAVAILABLE');
  assert.notStrictEqual(response.body.code, 'COMMANDER_NOT_LEGAL',
    'the app must not report an outage as an illegality finding');
  assert.ok(/could not|unable|verify/i.test(String(response.body.error)),
    `the message must say the app could not verify, got: ${response.body.error}`);

  // THE OVERRIDE REMAINS AVAILABLE. The user is not stranded by an upstream
  // outage -- that would reintroduce the exact dead end the override exists
  // to prevent.
  assert.strictEqual(response.body.overridable, true,
    'the existing override path must remain open when verification is unavailable');

  assert.strictEqual(
    (await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [owner.id])).n, before,
    'a failed verification must write nothing'
  );

  // And the thin row must NOT have been half-written from a failed fetch.
  const row = await db.get(`SELECT type_line FROM card_cache WHERE id = 'thin-unfetchable'`);
  assert.ok(row, 'the cache row must still exist after a failed refetch');
  assert.strictEqual(row.type_line, null,
    'a failed refetch must not leave partially-written data behind');

  scryfallStub.reset();
});

test('F13-TC50', 'PAIRING legality gets the same hydration, not just single-commander legality', async ({ owner }) => {
  // The refinement is about the RULE'S INPUTS, and pairing reads the same
  // fields Rule 3 does -- more of them, in fact, since it leans on oracle_text
  // and keywords. Two thin rows that are really a legal Partner pair must be
  // accepted, or the fix would only cover half the refusal surface it was
  // written for.
  scryfallStub.reset();

  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Thin Partner Pair',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'thin-partner-a', desired_finish: 'nonfoil' },
        { desired_card_id: 'thin-partner-b', desired_finish: 'nonfoil' }
      ]
    }
  });

  assert.strictEqual(response.status, 201,
    `a legal Partner pair must not be refused for a thin cache: ${JSON.stringify(response.body)}`);
  assert.ok(scryfallStub.calls.includes('thin-partner-a')
    || scryfallStub.calls.includes('thin-partner-b'),
    `the pairing decision must have hydrated the thin rows: ${JSON.stringify(scryfallStub.calls)}`);

  const rows = await deckRows(response.body.id);
  assert.strictEqual(rows.filter(r => r.board === 'commander').length, 2,
    'both commanders of an accepted pair must be written');

  // No override was supplied, so this must have been accepted on the MERITS,
  // not waved through. Nothing may have been recorded as an override.
  const logs = await api(owner.token, '/api/audit-logs');
  const overrides = (logs.body.logs || logs.body || [])
    .filter(l => l.action_type === 'COMMANDER_PAIR_OVERRIDE'
      && /Thin Partner/.test(JSON.stringify(l.after_state || '')));
  assert.strictEqual(overrides.length, 0,
    'a pair accepted on fresh data is not an override and must not be recorded as one');
});

test('F13-TC51', 'the override path still works unchanged on a card the refetch confirms is illegal', async ({ owner }) => {
  // The override is the escape hatch for when the app is out of date about a
  // MECHANIC. Hydration removes one CAUSE of wrong refusals; it does not
  // replace the override, and the recorded-reason behaviour must be exactly
  // as it was built.
  scryfallStub.reset();

  const response = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Thin Illegal Overridden',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'thin-illegal', desired_finish: 'nonfoil' }],
      commander_override: { reason: 'Verified with a judge; the app is out of date on this card.' }
    }
  });

  assert.strictEqual(response.status, 201,
    `the override must still be honoured after hydration: ${JSON.stringify(response.body)}`);

  const rows = await deckRows(response.body.id);
  assert.strictEqual(rows.filter(r => r.board === 'commander').length, 1,
    'an overridden commander must actually be written');

  // The REASON is recorded, on the log surface the app already has.
  const logs = await api(owner.token, '/api/audit-logs');
  const entries = (logs.body.logs || logs.body || [])
    .filter(l => l.action_type === 'COMMANDER_PAIR_OVERRIDE');
  assert.ok(entries.some(l => /Verified with a judge/.test(JSON.stringify(l.after_state || ''))),
    'the override reason must still be recorded verbatim');

  // An override with NO reason is still refused -- unchanged.
  const noReason = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Thin Illegal Bare Override',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'thin-illegal', desired_finish: 'nonfoil' }],
      commander_override: true
    }
  });
  assert.strictEqual(noReason.status, 409,
    'a bare override is still not an override');
  assert.strictEqual(noReason.body.code, 'COMMANDER_OVERRIDE_REASON_REQUIRED');
});

test('F13-TC52', 'the SWAP path hydrates a thin row ALREADY IN the command zone, not just the incoming card', async ({ owner }) => {
  // A DISTINCT CODE PATH, and the reason it exists is easy to miss.
  //
  // Pairing is judged on the command zone AS A WHOLE. So a thin row that is
  // already sitting in the zone poisons the decision for a legal partner being
  // added beside it, exactly as surely as a thin incoming card would -- and
  // hydrating only the incoming card would leave half the defect in place on
  // the one route where two commanders actually meet one at a time.
  scryfallStub.reset();

  // Seed a fresh thin pair so this case cannot ride on TC50's healed cache.
  await seedThinCard('thin-swap-a', { name: 'Thin Swap A', oracleId: 'o-thin-sa', number: '210' });
  await seedThinCard('thin-swap-b', { name: 'Thin Swap B', oracleId: 'o-thin-sb', number: '211' });
  scryfallStub.truth['thin-swap-a'] = {
    id: 'thin-swap-a', oracle_id: 'o-thin-sa', name: 'Thin Swap A', supertype: 'MTG',
    subtypes: ['Legendary', 'Creature', 'Test'], set_id: 'tsa', set_name: 'Test Set A',
    number: '210', type_line: 'Legendary Creature — Test',
    oracle_text: 'Partner (You can have two commanders if both have partner.)',
    keywords: ['Partner'], finishes: ['nonfoil', 'foil']
  };
  scryfallStub.truth['thin-swap-b'] = {
    id: 'thin-swap-b', oracle_id: 'o-thin-sb', name: 'Thin Swap B', supertype: 'MTG',
    subtypes: ['Legendary', 'Creature', 'Test'], set_id: 'tsa', set_name: 'Test Set A',
    number: '211', type_line: 'Legendary Creature — Test',
    oracle_text: 'Partner (You can have two commanders if both have partner.)',
    keywords: ['Partner'], finishes: ['nonfoil', 'foil']
  };

  // Create with ONE thin commander. This hydrates 'thin-swap-a' on the way in.
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Thin Swap Zone',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'thin-swap-a', desired_finish: 'nonfoil' }]
    }
  });
  assert.strictEqual(deck.status, 201, JSON.stringify(deck.body));

  // Now RE-THIN the row already in the zone, simulating a cache row that went
  // stale/partial after the deck was built. The incoming card is the only one
  // the naive implementation would look at.
  await db.run(
    `UPDATE card_cache SET oracle_text = NULL, keywords = NULL WHERE id = 'thin-swap-a'`
  );
  scryfallStub.reset();

  const added = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'thin-swap-b', desired_finish: 'nonfoil', board: 'commander', quantity: 1 }
  });

  assert.strictEqual(added.status, 200,
    `a legal partner must not be refused because the SITTING commander was thin: ${JSON.stringify(added.body)}`);
  assert.ok(scryfallStub.calls.includes('thin-swap-a'),
    `the row already in the command zone must be hydrated too: ${JSON.stringify(scryfallStub.calls)}`);

  const rows = await deckRows(deck.body.id);
  assert.strictEqual(rows.filter(r => r.board === 'commander').length, 2,
    'both commanders of the accepted pair must be written');
});

// ---------------------------------------------------------------------------
// THE COMMAND ZONE IS VALIDATED AS A WHOLE, AFTER EVERY MUTATION (Blocker 1)
//
// THE INVARIANT: after ANY mutation, a Commander deck's command zone must be a
// legal command zone -- one legal commander, or two that legally pair. Never
// three or more, never two sharing a name.
//
// The defect these cases were written against: pairing legality was only ever
// evaluated when the zone happened to hold EXACTLY two rows, and DELETE never
// re-checked the zone at all. So an illegal pair was reachable by a sequence of
// individually-legal-looking steps -- grow the zone to three (each write sees
// "not two", so pairing never runs), then delete one. The deck ends up holding
// a pair that creating directly is correctly refused, with no warning and no
// recorded override. A rule that only applies at one arity is not a rule about
// the zone; it is a rule about a coincidence.
// ---------------------------------------------------------------------------

test('F13-TC53', 'a THIRD commander is refused on the add path, closing the back door to an illegal pair', async ({ owner }) => {
  // Step 1 of the reviewer's repro: a genuinely legal pair.
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Back Door Zone',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-thrasios', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-piper', desired_finish: 'nonfoil' }
      ]
    }
  });
  assert.strictEqual(deck.status, 201, JSON.stringify(deck.body));

  // Step 2: a third commander. A zone of three is ILLEGAL IN ITSELF -- there
  // is no arrangement of three commanders that is a legal Commander deck -- so
  // it must be refused here rather than tolerated as an intermediate state.
  // Tolerating it is what made step 3 reachable.
  const third = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'cmd-krenko', desired_finish: 'nonfoil', board: 'commander', quantity: 1 }
  });

  assert.strictEqual(third.status, 409,
    `a third commander must be REFUSED, not accepted as a transient state: ${JSON.stringify(third.body)}`);
  assert.strictEqual(third.body.code, 'COMMANDER_TOO_MANY',
    `the refusal must name the actual rule: ${JSON.stringify(third.body)}`);
  // A fixed rule the app cannot be wrong about gets NO override -- exactly
  // like singleton. Three commanders is illegal in every set, forever.
  assert.notStrictEqual(third.body.overridable, true,
    'a zone of three is a fixed rule and must not be overridable');

  // AND IT WROTE NOTHING.
  const rows = await deckRows(deck.body.id);
  assert.strictEqual(rows.filter(r => r.board === 'commander').length, 2,
    `a refused third commander must leave the zone at two: ${JSON.stringify(rows)}`);
});

test('F13-TC54', 'an illegal pair CANNOT be reached by deleting a commander', async ({ owner }) => {
  // ORIGINAL INTENT, PRESERVED: a zone of three must not be reducible by
  // deletion to an illegal pair that creating directly is refused.
  //
  // UPDATED FOR ZACH'S RULING (2026-08-19): "You cant outright delete the
  // commander only swap". The delete is now refused as an UNSUPPORTED
  // OPERATION before the zone is even judged, which is a STRONGER guarantee
  // than the old revalidate-after-delete: the illegal pair is not merely
  // caught, it is unreachable by this route at all. The assertion moves from
  // "the pairing rule refuses it" to "the operation does not exist", and the
  // load-bearing part -- the zone is untouched -- is unchanged.
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Delete Revalidates',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-thrasios', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-piper', desired_finish: 'nonfoil' }
      ]
    }
  });
  assert.strictEqual(deck.status, 201, JSON.stringify(deck.body));

  // A third commander row planted DIRECTLY, bypassing the route. This is a
  // fixture, not the thing under test: it stands in for a zone that got to
  // three some other way -- data written before the rule existed, a restored
  // backup, a future route that forgets.
  const identity = await db.get(`SELECT oracle_id FROM card_cache WHERE id = 'cmd-krenko'`);
  await db.run(
    `INSERT INTO deck_cards (deck_id, oracle_id, desired_card_id, desired_finish, board, quantity)
     VALUES (?, ?, 'cmd-krenko', 'nonfoil', 'commander', 1)`,
    [deck.body.id, identity.oracle_id]
  );

  const before = await deckRows(deck.body.id);
  assert.strictEqual(before.filter(r => r.board === 'commander').length, 3, 'fixture: the zone holds three');

  // Deleting Thrasios would leave Piper + Krenko, an ILLEGAL pair. The delete
  // never gets far enough to be judged on pairing: a commander is swapped,
  // never deleted.
  const thrasios = before.find(r => r.desired_card_id === 'cmd-thrasios');
  const removed = await api(owner.token, `/api/decks/${deck.body.id}/cards/${thrasios.id}`, {
    method: 'DELETE'
  });

  assert.strictEqual(removed.status, 409,
    `a commander delete must be refused: ${JSON.stringify(removed.body)}`);
  assert.strictEqual(removed.body.code, 'COMMANDER_DELETE_UNSUPPORTED',
    `the refusal must name the unsupported operation: ${JSON.stringify(removed.body)}`);
  assert.ok(/swap/i.test(String(removed.body.error)),
    `the refusal must point the user at the swap, got: ${removed.body.error}`);

  // AND THE ROW IS STILL THERE. A refused delete that deleted anyway would be
  // the silent partial state the app exists to prevent. Unchanged assertion.
  const after = await deckRows(deck.body.id);
  assert.strictEqual(after.filter(r => r.board === 'commander').length, 3,
    `a refused delete must roll back completely: ${JSON.stringify(after)}`);
  assert.ok(after.some(r => r.desired_card_id === 'cmd-thrasios'),
    'the row the user tried to delete must survive a refused delete');

  // THE PAIRING RULE IS STILL ENFORCED, just at the operation that can actually
  // produce the zone. Swapping Thrasios for Krenko would leave Piper + Krenko
  // -- the same illegal pair -- and THAT is refused on pairing grounds, with
  // the override the rule has always carried. The guarantee did not move, only
  // the door it is enforced at.
  const swap = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: {
      desired_card_id: 'cmd-krenko', desired_finish: 'nonfoil', board: 'commander',
      replacing_deck_card_id: thrasios.id
    }
  });
  assert.strictEqual(swap.status, 409,
    `a swap producing an illegal pair must still be refused: ${JSON.stringify(swap.body)}`);
});

test('F13-TC55', 'dropping to ONE commander is still possible -- through the SWAP', async ({ owner }) => {
  // ORIGINAL INTENT, PRESERVED: the guard must not become a trap. A user with a
  // partner pair must still be able to end up with a single commander.
  //
  // UPDATED FOR ZACH'S RULING: that is a SWAP of the zone from two commanders
  // to one, not a delete. The delete is refused; the swap is the way, and it
  // works. A rule with no way through is the failure mode this design avoids,
  // so this case proves the way through exists.
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Delete Legal',
      format: 'Commander / EDH',
      commanders: [
        { desired_card_id: 'cmd-thrasios', desired_finish: 'nonfoil' },
        { desired_card_id: 'cmd-piper', desired_finish: 'nonfoil' }
      ]
    }
  });
  assert.strictEqual(deck.status, 201, JSON.stringify(deck.body));

  const rows = await deckRows(deck.body.id);
  const piper = rows.find(r => r.desired_card_id === 'cmd-piper');

  // The bare delete is refused, even though the zone it would leave is legal.
  // The rule is about the operation, not about the consequences.
  const removed = await api(owner.token, `/api/decks/${deck.body.id}/cards/${piper.id}`, {
    method: 'DELETE'
  });
  assert.strictEqual(removed.status, 409,
    `a commander delete is refused even when the resulting zone is legal: `
    + `${JSON.stringify(removed.body)}`);
  assert.strictEqual(removed.body.code, 'COMMANDER_DELETE_UNSUPPORTED',
    JSON.stringify(removed.body));
  assert.strictEqual((await deckRows(deck.body.id)).filter(r => r.board === 'commander').length, 2,
    'a refused delete must leave the zone as it was');

  // THE WAY THROUGH: drop Piper from the zone. That is a swap of the zone from
  // two commanders to one, expressed on the swap route, and it leaves a legal
  // single-commander zone.
  const dropped = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { drop_commander_deck_card_id: piper.id }
  });
  assert.strictEqual(dropped.status, 200,
    `dropping to one commander must be possible through the swap route: `
    + `${JSON.stringify(dropped.body)}`);

  const after = await deckRows(deck.body.id);
  assert.strictEqual(after.filter(r => r.board === 'commander').length, 1,
    `the zone must end at one commander: ${JSON.stringify(after)}`);
  assert.strictEqual(after.filter(r => r.board === 'commander')[0].desired_card_id, 'cmd-thrasios',
    'the surviving commander must be the one the user kept');
});

test('F13-TC55b', 'the LAST commander cannot be dropped either', async ({ owner }) => {
  // The drop path is the other way to shrink the zone, so it carries the same
  // rule as DELETE: a Commander deck always has a commander. Without this, the
  // affordance added for TC55 would be a second door to the empty zone.
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Drop Last',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });
  assert.strictEqual(deck.status, 201, JSON.stringify(deck.body));

  const only = (await deckRows(deck.body.id)).find(r => r.board === 'commander');
  const dropped = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { drop_commander_deck_card_id: only.id }
  });
  assert.strictEqual(dropped.status, 409,
    `the last commander must not be droppable: ${JSON.stringify(dropped.body)}`);
  assert.strictEqual(dropped.body.code, 'COMMANDER_DELETE_UNSUPPORTED',
    JSON.stringify(dropped.body));
  assert.strictEqual((await deckRows(deck.body.id)).filter(r => r.board === 'commander').length, 1,
    'the commander must survive');
});

test('F13-TC56', 'deleting an ordinary deck card never consults the command zone', async ({ owner }) => {
  // The zone gate must be scoped to the zone. Removing a Sol Ring from the 99
  // cannot make the commanders illegal, and a delete of deck CONTENTS must not
  // start failing because of a rule about the command zone.
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Contents Delete',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });
  const added = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(added.status, 200, JSON.stringify(added.body));

  const solRing = (await deckRows(deck.body.id)).find(r => r.name === 'Sol Ring Test');
  const removed = await api(owner.token, `/api/decks/${deck.body.id}/cards/${solRing.id}`, {
    method: 'DELETE'
  });
  assert.strictEqual(removed.status, 200,
    `removing a card from the 99 must be unaffected: ${JSON.stringify(removed.body)}`);
  assert.strictEqual((await deckRows(deck.body.id)).filter(r => r.name === 'Sol Ring Test').length, 0);
});

test('F13-TC57', 'a non-Commander deck can delete anything, including from the commander board', async ({ owner }) => {
  // Other formats are entirely unaffected -- no extra validation, as the spec
  // requires.
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST', body: { name: 'Modern Delete', format: 'Modern', target_size: 60 }
  });
  assert.strictEqual(deck.status, 201);
  for (const id of ['cmd-krenko', 'cmd-gishath', 'cmd-atraxa']) {
    const added = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
      method: 'POST',
      body: { desired_card_id: id, desired_finish: 'nonfoil', board: 'commander', quantity: 1 }
    });
    assert.strictEqual(added.status, 200,
      `a non-Commander deck must not be policed: ${JSON.stringify(added.body)}`);
  }
  const rows = await deckRows(deck.body.id);
  const removed = await api(owner.token, `/api/decks/${deck.body.id}/cards/${rows[0].id}`, {
    method: 'DELETE'
  });
  assert.strictEqual(removed.status, 200,
    `a non-Commander delete must never be refused: ${JSON.stringify(removed.body)}`);
});

// ---------------------------------------------------------------------------
// EDITING AN ENTRY IS NOT DUPLICATING IT (Blocker 2)
//
// THE INVARIANT: singleton counts DISTINCT ENTRIES OTHER THAN THE ONE BEING
// WRITTEN. An edit must never see itself as its own duplicate.
//
// The defect these cases were written against: the self-exclusion was looked up
// by the NEW (card, finish, board) tuple. On an edit that tuple does not exist
// yet -- that is what makes it an edit -- so nothing was excluded, and the OLD
// row was counted as a second copy of the card by name. The result was that
// changing a printing or a finish in a Commander deck was refused as a
// singleton violation, and singleton has no override BY DESIGN, so the feature
// was not merely awkward but impossible. A rule that fires on the operation it
// is supposed to permit is worse than no rule.
//
// The edit is expressed as `replacing_deck_card_id`: the client names the ROW
// it is editing. That is also why the replace is ATOMIC server-side rather than
// the old add-then-delete pair of requests -- two requests can only ever be two
// requests, and the window between them is a deck holding two copies by name.
// ---------------------------------------------------------------------------

test('F13-TC58', 'RE-PINNING an entry to a different PRINTING succeeds and replaces the row', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Repin Printing',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });
  const added = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(added.status, 200, JSON.stringify(added.body));
  const original = (await deckRows(deck.body.id)).find(r => r.name === 'Sol Ring Test');

  // The user picks the other printing of the card they already run. This is
  // Zach's stated workflow, and it is an EDIT of that row -- not a request for
  // a second Sol Ring.
  const repinned = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: {
      desired_card_id: 'dup-solring-b',
      desired_finish: 'nonfoil',
      quantity: 1,
      replacing_deck_card_id: original.id
    }
  });
  assert.strictEqual(repinned.status, 200,
    `re-pinning a printing must NOT be refused as a duplicate: ${JSON.stringify(repinned.body)}`);

  // EXACTLY ONE Sol Ring row, and it is the NEW printing. Both halves matter:
  // still one row proves singleton was not simply switched off, and the new id
  // proves the edit actually took effect rather than silently no-opping.
  const solRings = (await deckRows(deck.body.id)).filter(r => r.name === 'Sol Ring Test');
  assert.strictEqual(solRings.length, 1,
    `the edit must REPLACE, leaving one row: ${JSON.stringify(solRings)}`);
  assert.strictEqual(solRings[0].desired_card_id, 'dup-solring-b',
    'the row must now point at the newly chosen printing');
  assert.strictEqual(solRings[0].quantity, 1);
});

test('F13-TC59', 'changing an entry from NONFOIL to FOIL succeeds', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Repin Finish',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });
  const added = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(added.status, 200, JSON.stringify(added.body));
  const original = (await deckRows(deck.body.id)).find(r => r.name === 'Sol Ring Test');

  // Same printing, different finish. A distinct physical object and the same
  // card name -- which is precisely the pair of facts the code has to hold at
  // once, and precisely where it was getting them confused.
  const refinished = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: {
      desired_card_id: 'dup-solring-a',
      desired_finish: 'foil',
      quantity: 1,
      replacing_deck_card_id: original.id
    }
  });
  assert.strictEqual(refinished.status, 200,
    `changing finish must NOT be refused as a duplicate: ${JSON.stringify(refinished.body)}`);

  const solRings = (await deckRows(deck.body.id)).filter(r => r.name === 'Sol Ring Test');
  assert.strictEqual(solRings.length, 1, `one row: ${JSON.stringify(solRings)}`);
  assert.strictEqual(solRings[0].desired_finish, 'foil', 'the finish must actually have changed');
});

test('F13-TC60', 'SWAPPING a commander to a different PRINTING OF THE SAME CARD succeeds', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Commander Repin',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });
  assert.strictEqual(deck.status, 201, JSON.stringify(deck.body));
  const original = (await deckRows(deck.body.id)).find(r => r.board === 'commander');

  // "I want the nicer Atraxa." Same commander, different printing. TC33 proves
  // ADDING that printing as a SECOND commander is still refused; this proves
  // REPLACING the existing one with it is allowed. The difference between those
  // two is the whole of Blocker 2, and it is carried entirely by whether the
  // client named the row it is editing.
  const swapped = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: {
      desired_card_id: 'cmd-atraxa-b',
      desired_finish: 'nonfoil',
      board: 'commander',
      quantity: 1,
      replacing_deck_card_id: original.id
    }
  });
  assert.strictEqual(swapped.status, 200,
    `re-printing a commander must NOT be refused as a duplicate: ${JSON.stringify(swapped.body)}`);

  const zone = (await deckRows(deck.body.id)).filter(r => r.board === 'commander');
  assert.strictEqual(zone.length, 1, `the zone must still hold ONE commander: ${JSON.stringify(zone)}`);
  assert.strictEqual(zone[0].desired_card_id, 'cmd-atraxa-b',
    'the command zone must now hold the newly chosen printing');
});

test('F13-TC61', 'a GENUINE second copy is still refused, even with an edit id supplied', async ({ owner }) => {
  // The exclusion must be exactly one row wide. If naming a row let a write
  // skip singleton wholesale, the fix for Blocker 2 would have opened a bypass
  // worse than the bug -- so this points the edit id at an UNRELATED row and
  // requires the duplicate to still be caught.
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Genuine Duplicate',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });
  const solRing = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(solRing.status, 200, JSON.stringify(solRing.body));
  const other = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'pf-good-a', desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(other.status, 200, JSON.stringify(other.body));

  const unrelated = (await deckRows(deck.body.id)).find(r => r.name === 'Preflight Good A');

  // Editing the "Preflight Good A" row into a second Sol Ring. The Sol Ring
  // already in the deck is NOT the row being edited, so it is a real duplicate.
  const refused = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: {
      desired_card_id: 'dup-solring-b',
      desired_finish: 'foil',
      quantity: 1,
      replacing_deck_card_id: unrelated.id
    }
  });
  assert.strictEqual(refused.status, 409,
    `a genuine duplicate must still be refused: ${JSON.stringify(refused.body)}`);
  assert.strictEqual(refused.body.code, 'COMMANDER_SINGLETON');

  // Nothing changed: the duplicate is absent AND the row it tried to edit is
  // still intact. A refused edit must not consume the row it was editing.
  const rows = await deckRows(deck.body.id);
  assert.strictEqual(rows.filter(r => r.name === 'Sol Ring Test').length, 1);
  assert.ok(rows.some(r => r.id === unrelated.id),
    'a refused edit must leave the edited row untouched');
});

test('F13-TC62', 'an edit id belonging to ANOTHER deck is refused, not honoured', async ({ owner }) => {
  // The edit id comes from the client, so it is not trusted. A row id from a
  // different deck must not be usable to excuse a duplicate -- or to delete
  // someone else's row.
  const deckA = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Edit Scope A',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });
  const deckB = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Edit Scope B',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-krenko', desired_finish: 'nonfoil' }]
    }
  });
  const foreign = (await deckRows(deckB.body.id))[0];

  const response = await api(owner.token, `/api/decks/${deckA.body.id}/cards`, {
    method: 'POST',
    body: {
      desired_card_id: 'dup-solring-a',
      desired_finish: 'nonfoil',
      quantity: 1,
      replacing_deck_card_id: foreign.id
    }
  });
  assert.strictEqual(response.status, 404,
    `an edit id from another deck must not be accepted: ${JSON.stringify(response.body)}`);

  // And deck B is intact -- the foreign id must never have been deleted.
  assert.ok((await deckRows(deckB.body.id)).some(r => r.id === foreign.id),
    'a rejected edit must not touch another deck');
});

test('F13-TC63', 'EXEMPT cards are still exempt on the edit path', async ({ owner }) => {
  // Basics and any-number cards have no singleton rule to be confused about,
  // and editing one must stay as ordinary as adding one.
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Exempt Edit',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });
  const swamps = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'basic-swamp-a', desired_finish: 'nonfoil', quantity: 10 }
  });
  assert.strictEqual(swamps.status, 200, JSON.stringify(swamps.body));
  const row = (await deckRows(deck.body.id)).find(r => r.name === 'Swamp');

  const repinned = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: {
      desired_card_id: 'basic-swamp-b',
      desired_finish: 'nonfoil',
      quantity: 10,
      replacing_deck_card_id: row.id
    }
  });
  assert.strictEqual(repinned.status, 200,
    `re-pinning a basic land must be allowed: ${JSON.stringify(repinned.body)}`);

  const after = (await deckRows(deck.body.id)).filter(r => r.name === 'Swamp');
  assert.strictEqual(after.length, 1, `the edit replaced the row: ${JSON.stringify(after)}`);
  assert.strictEqual(after[0].desired_card_id, 'basic-swamp-b');
  assert.strictEqual(after[0].quantity, 10, 'the quantity the user asked for is preserved');
});

test('F13-TC64', 'a NON-Commander deck can re-pin freely, and keeps its other copies', async ({ owner }) => {
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST', body: { name: 'Modern Repin', format: 'Modern', target_size: 60 }
  });
  const a = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', quantity: 2 }
  });
  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  const row = (await deckRows(deck.body.id)).find(r => r.desired_card_id === 'dup-solring-a');

  const repinned = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: {
      desired_card_id: 'dup-solring-b',
      desired_finish: 'nonfoil',
      quantity: 2,
      replacing_deck_card_id: row.id
    }
  });
  assert.strictEqual(repinned.status, 200, JSON.stringify(repinned.body));

  const rows = await deckRows(deck.body.id);
  assert.strictEqual(rows.length, 1, `the replace applies in every format: ${JSON.stringify(rows)}`);
  assert.strictEqual(rows[0].desired_card_id, 'dup-solring-b');
  assert.strictEqual(rows[0].quantity, 2);
});

test('F13-TC65', 'MOVING an entry between boards is one atomic replace, not an add plus a delete', async ({ owner }) => {
  // The sibling path found while fixing Blocker 2. Toggling a card in and out
  // of "considering" is also a rewrite of an existing entry in place, and it
  // was written the same way the re-pin was: write the new row, then delete the
  // old one, as two separate requests.
  //
  // It does NOT hit the singleton false-refusal, because considering rows are
  // excluded from the count by design -- but it has the same window. Between
  // the two requests the card exists on BOTH boards, and if the delete never
  // lands it stays on both: the deck's own arithmetic then counts a card the
  // user only has one of, twice. Same defect class, same fix, so it goes
  // through the same choke point.
  const deck = await api(owner.token, '/api/decks', {
    method: 'POST',
    body: {
      name: 'Board Move',
      format: 'Commander / EDH',
      commanders: [{ desired_card_id: 'cmd-atraxa', desired_finish: 'nonfoil' }]
    }
  });
  const added = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'dup-solring-a', desired_finish: 'nonfoil', board: 'considering', quantity: 1 }
  });
  assert.strictEqual(added.status, 200, JSON.stringify(added.body));
  const shortlisted = (await deckRows(deck.body.id)).find(r => r.board === 'considering');

  const moved = await api(owner.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: {
      desired_card_id: 'dup-solring-a',
      desired_finish: 'nonfoil',
      board: 'mainboard',
      quantity: 1,
      replacing_deck_card_id: shortlisted.id
    }
  });
  assert.strictEqual(moved.status, 200, `moving boards must succeed: ${JSON.stringify(moved.body)}`);

  // ONE row, on the new board. The card must not exist on both at once.
  const solRings = (await deckRows(deck.body.id)).filter(r => r.name === 'Sol Ring Test');
  assert.strictEqual(solRings.length, 1,
    `the move must leave the card on exactly one board: ${JSON.stringify(solRings)}`);
  assert.strictEqual(solRings[0].board, 'mainboard');
});

// THIN-CACHE FIXTURES.
//
// A row cached before the app read oracle_text/keywords -- an early scan, a
// price-only sweep, a partial import. These rows are the whole reason the
// refetch exists: EVERY missing field biases the commander rules toward
// REFUSAL, so a thin row silently turns a legal commander into a blocked one.
//
// NULL, not '' -- that is the honest signal. cacheNormalizedCards always
// writes '' and '[]' for a card it actually read, so NULL means "this row
// never went through the normalizer", which is exactly the question the
// hydration gate asks.
async function seedThinCard(id, { name, oracleId, number, typeLine = null }) {
  await db.run(
    `INSERT OR REPLACE INTO card_cache
       (id, oracle_id, name, set_id, set_name, number, finishes, supertype,
        subtypes, type_line, oracle_text, keywords)
     VALUES (?, ?, ?, 'tsa', 'Test Set A', ?, ?, 'Creature', NULL, ?, NULL, NULL)`,
    [id, oracleId, name, number, JSON.stringify(['nonfoil', 'foil']), typeLine]
  );
}

async function seed() {
  const cards = [
    // Commanders.
    // A SECOND printing of the same commander name. The create-path fixture:
    // a distinct identity, a distinct physical card, and one card name.
    // Two printings of ONE card name -- the singleton fixture.
    { id: 'dup-solring-a', oracle: 'o-solring', name: 'Sol Ring Test', setId: 'tsa', set: 'Test Set A', num: '10' },
    { id: 'dup-solring-b', oracle: 'o-solring', name: 'Sol Ring Test', setId: 'tsb', set: 'Test Set B', num: '20' },
    // The same pair again under import-friendly ids/numbers, so the import
    // cases can name a printing by set code without colliding with the ids the
    // direct-add cases use.
    { id: 'sol-a', oracle: 'o-solring', name: 'Sol Ring Test', setId: 'tsa', set: 'Test Set A', num: '11' },
    { id: 'sol-b', oracle: 'o-solring', name: 'Sol Ring Test', setId: 'tsb', set: 'Test Set B', num: '22' },
    // A card owned nowhere with two printings: the genuinely ambiguous import
    // line that must still open the picker.
    { id: 'amb-a', oracle: 'o-amb', name: 'Ambiguous Test', setId: 'tsa', set: 'Test Set A', num: '50' },
    { id: 'amb-b', oracle: 'o-amb', name: 'Ambiguous Test', setId: 'tsb', set: 'Test Set B', num: '51' },
    // A printing used by the browse/foil cases only.
    { id: 'browse-card', oracle: 'o-browse', name: 'Browse Test', setId: 'tsa', set: 'Test Set A', num: '60' },
    // Two printings of a NON-exempt card whose name carries a diacritic. This
    // is the fixture for the ASCII-LOWER() trap: the name must still be
    // recognised as the same card across printings.
    { id: 'accent-a', oracle: 'o-accent', name: 'Jurön Test', setId: 'tsa', set: 'Test Set A', num: '80' },
    { id: 'accent-b', oracle: 'o-accent', name: 'Jurön Test', setId: 'tsb', set: 'Test Set B', num: '81' },
    // Ordinary, legal cards for the multi-select pre-flight cases. They share
    // nothing with any other fixture, so a selection containing them is clean
    // and the only problem in it is the one the case deliberately introduces.
    { id: 'pf-good-a', oracle: 'o-pf-good-a', name: 'Preflight Good A', setId: 'tsa', set: 'Test Set A', num: '90' },
    { id: 'pf-good-b', oracle: 'o-pf-good-b', name: 'Preflight Good B', setId: 'tsa', set: 'Test Set A', num: '91' },
    { id: 'pf-clean-a', oracle: 'o-pf-clean-a', name: 'Preflight Clean A', setId: 'tsa', set: 'Test Set A', num: '92' },
    { id: 'pf-clean-b', oracle: 'o-pf-clean-b', name: 'Preflight Clean B', setId: 'tsa', set: 'Test Set A', num: '93' },
    { id: 'pf-conf-a', oracle: 'o-pf-conf-a', name: 'Preflight Confirm A', setId: 'tsa', set: 'Test Set A', num: '94' }
  ];
  for (const c of cards) {
    // oracle_text '' and keywords '[]' -- NOT NULL. This mirrors what
    // cacheNormalizedCards actually writes for a card the app has READ: a
    // vanilla artifact legitimately has no text, and '' records that we looked
    // and there was nothing there. NULL would mean "never read", which is the
    // thin-cache condition that triggers a refetch -- so leaving these NULL
    // would make ordinary fixtures reach for Scryfall and test a path they are
    // not about.
    await db.run(
      `INSERT OR IGNORE INTO card_cache (id, oracle_id, name, set_id, set_name, number, finishes, supertype, subtypes, type_line, oracle_text, keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Artifact', '[]', 'Artifact', '', '[]')`,
      [c.id, c.oracle, c.name, c.setId, c.set, c.num, JSON.stringify(['nonfoil', 'foil'])]
    );
  }

  // COMMANDER PAIRING FIXTURES.
  //
  // The pairing rule is read from the card's own ORACLE TEXT and KEYWORDS,
  // deliberately -- the set of partner-like mechanics grows every year and a
  // hardcoded name list would be wrong within months. So these fixtures carry
  // the real wording rather than a flag, and the detector is exercised on the
  // same data shape Scryfall actually caches.
  const commanderCards = [
    {
      id: 'cmd-thrasios', oracle: 'o-thrasios', name: 'Thrasios Test', num: '3',
      keywords: ['Partner'],
      text: '{4}: Scry 1, then draw a card.\nPartner (You can have two commanders if both have partner.)'
    },
    {
      id: 'cmd-piper', oracle: 'o-piper', name: 'Piper Test', num: '2',
      keywords: ['Partner'],
      text: 'Partner (You can have two commanders if both have partner.)'
    },
    // Two arbitrary legendary creatures with NO pairing mechanic at all. This
    // is the illegal-pair fixture, and the point is that nothing in their text
    // permits a second commander.
    {
      id: 'cmd-krenko', oracle: 'o-krenko', name: 'Krenko Test', num: '100',
      keywords: [], text: '{T}: Create X 1/1 red Goblin creature tokens.'
    },
    {
      id: 'cmd-gishath', oracle: 'o-gishath', name: 'Gishath Test', num: '101',
      keywords: [], text: 'Vigilance, trample, haste'
    },
    // Choose a Background, and a Background to be chosen.
    {
      id: 'cmd-chooser', oracle: 'o-chooser', name: 'Chooser Test', num: '102',
      keywords: ['Choose a Background'],
      text: 'Choose a Background (You can have a Background as a second commander.)'
    },
    // Partner with, both named halves.
    {
      id: 'cmd-pw-left', oracle: 'o-pw-left', name: 'Pw Left Test', num: '103',
      keywords: ['Partner'],
      text: 'Partner with Pw Right Test (When this creature enters, target opponent may put Pw Right Test into their hand from their library.)'
    },
    {
      id: 'cmd-pw-right', oracle: 'o-pw-right', name: 'Pw Right Test', num: '104',
      keywords: ['Partner'],
      text: 'Partner with Pw Left Test (When this creature enters, target opponent may put Pw Left Test into their hand from their library.)'
    }
  ];
  for (const c of commanderCards) {
    await db.run(
      `INSERT OR IGNORE INTO card_cache
         (id, oracle_id, name, set_id, set_name, number, finishes, supertype, subtypes, type_line, oracle_text, keywords)
       VALUES (?, ?, ?, 'tsa', 'Test Set A', ?, ?, 'Creature', ?, 'Legendary Creature — Test', ?, ?)`,
      [c.id, c.oracle, c.name, c.num, JSON.stringify(['nonfoil', 'foil']),
        JSON.stringify(['Legendary', 'Creature']), c.text, JSON.stringify(c.keywords)]
    );
  }
  // A second printing of the Atraxa commander name, and the first -- both are
  // plain legendaries with no pairing mechanic, which is why TC26/TC33 refuse
  // them on NAME rather than on legality.
  for (const a of [
    { id: 'cmd-atraxa', setId: 'tsa', set: 'Test Set A', num: '1' },
    { id: 'cmd-atraxa-b', setId: 'tsb', set: 'Test Set B', num: '5' }
  ]) {
    await db.run(
      `INSERT OR IGNORE INTO card_cache
         (id, oracle_id, name, set_id, set_name, number, finishes, supertype, subtypes, type_line, oracle_text, keywords)
       VALUES (?, 'o-atraxa', 'Atraxa Test', ?, ?, ?, ?, 'Creature', ?, 'Legendary Creature — Test', 'Flying, vigilance', '[]')`,
      [a.id, a.setId, a.set, a.num, JSON.stringify(['nonfoil', 'foil']),
        JSON.stringify(['Legendary', 'Creature'])]
    );
  }
  // A Background: an enchantment subtype that may be a second commander.
  await db.run(
    `INSERT OR IGNORE INTO card_cache
       (id, oracle_id, name, set_id, set_name, number, finishes, supertype, subtypes, type_line, oracle_text, keywords)
     VALUES ('cmd-background', 'o-background', 'Background Test', 'tsa', 'Test Set A', '105', ?, 'Enchantment', ?, 'Legendary Enchantment — Background', 'Commander creatures you own have "Whatever."', '[]')`,
    [JSON.stringify(['nonfoil', 'foil']), JSON.stringify(['Legendary', 'Enchantment', 'Background'])]
  );

  // A card that is NOT a legendary creature but whose TEXT says it may be your
  // commander -- the planeswalker-commander shape. Rule 3 is about what the
  // card says, not about its type line alone, so this must be ACCEPTED while
  // an ordinary artifact is refused.
  await db.run(
    `INSERT OR IGNORE INTO card_cache
       (id, oracle_id, name, set_id, set_name, number, finishes, supertype, subtypes, type_line, oracle_text, keywords)
     VALUES ('cmd-can-be', 'o-can-be', 'Can Be Test', 'tsa', 'Test Set A', '106', ?, 'Planeswalker', ?, 'Legendary Planeswalker — Test', 'Can Be Test can be your commander.', '[]')`,
    [JSON.stringify(['nonfoil', 'foil']), JSON.stringify(['Legendary', 'Planeswalker'])]
  );

  // Basic lands, in two printings of the same name.
  for (const b of [
    { id: 'basic-swamp-a', setId: 'tsa', set: 'Test Set A', num: '30' },
    { id: 'basic-swamp-b', setId: 'tsb', set: 'Test Set B', num: '40' },
    { id: 'swamp-imp-a', setId: 'tsa', set: 'Test Set A', num: '33' },
    { id: 'swamp-imp-b', setId: 'tsb', set: 'Test Set B', num: '44' }
  ]) {
    await db.run(
      `INSERT OR IGNORE INTO card_cache (id, oracle_id, name, set_id, set_name, number, finishes, supertype, subtypes, type_line, oracle_text, keywords)
       VALUES (?, 'o-swamp', 'Swamp', ?, ?, ?, ?, 'Land', ?, 'Basic Land — Swamp', '', '[]')`,
      [b.id, b.setId, b.set, b.num, JSON.stringify(['nonfoil']), JSON.stringify(['Basic', 'Land', 'Swamp'])]
    );
  }

  // Any-number cards, including the accented spelling.
  await db.run(
    `INSERT OR IGNORE INTO card_cache (id, oracle_id, name, set_id, set_name, number, finishes, supertype, subtypes, type_line, oracle_text, keywords)
     VALUES ('rats-a', 'o-rats', 'Relentless Rats', 'tsa', 'Test Set A', '70', ?, 'Creature', '[]', 'Creature — Rat', '', '[]')`,
    [JSON.stringify(['nonfoil'])]
  );
  await db.run(
    `INSERT OR IGNORE INTO card_cache (id, oracle_id, name, set_id, set_name, number, finishes, supertype, subtypes, type_line, oracle_text, keywords)
     VALUES ('nazgul-a', 'o-nazgul', 'Nazgûl', 'tsa', 'Test Set A', '71', ?, 'Creature', '[]', 'Creature — Wraith', '', '[]')`,
    [JSON.stringify(['nonfoil'])]
  );

  // THIN ROWS. Each is a card the app HOLDS but has not fully READ.
  //
  // 'thin-legal'    -- really a legendary creature. Refusing it is the false
  //                    positive the whole refinement exists to remove.
  // 'thin-illegal'  -- really a Sol Ring. Refetching must confirm the refusal,
  //                    not soften it: better knowledge is not the same as a
  //                    more permissive answer.
  // 'thin-partner-a/b' -- really a legal Partner pair. Proves the hydration
  //                    applies to PAIRING legality too, not only to Rule 3.
  // 'thin-unfetchable' -- Scryfall cannot answer for it. Proves a failed
  //                    verification is reported honestly rather than being
  //                    silently converted into a pass or a refusal.
  await seedThinCard('thin-legal', { name: 'Thin Legal Test', oracleId: 'o-thin-legal', number: '200' });
  await seedThinCard('thin-illegal', { name: 'Thin Illegal Test', oracleId: 'o-thin-illegal', number: '201' });
  await seedThinCard('thin-partner-a', { name: 'Thin Partner A', oracleId: 'o-thin-pa', number: '202' });
  await seedThinCard('thin-partner-b', { name: 'Thin Partner B', oracleId: 'o-thin-pb', number: '203' });
  await seedThinCard('thin-unfetchable', { name: 'Thin Unfetchable Test', oracleId: 'o-thin-unf', number: '204' });

  // MATCH THE REAL CACHE WRITER'S GUARANTEE ABOUT color_identity.
  //
  // These fixtures insert card_cache rows with direct SQL and never named
  // color_identity, so it defaulted to NULL. cacheNormalizedCards -- the ONLY
  // thing in the app that writes this table -- always writes '[]' for a card it
  // actually read, and the column is in the base schema with no migration that
  // could leave it NULL. So a NULL colour identity is a state PRODUCTION CANNOT
  // PRODUCE, and these rows were describing a card that cannot exist.
  //
  // That mattered from PR 6G on: NULL is precisely the app's signal for "never
  // read this card", which now blocks a Commander add until it can verify. The
  // fixtures were quietly asserting the opposite of the real invariant.
  //
  // Deliberately NOT applied to the thin rows above: their thinness is the
  // thing under test, and it is expressed through type_line/oracle_text/
  // keywords -- different fields, a different question. Colour identity is
  // filled in for them too, so they are thin for the COMMANDER decision only,
  // which is exactly what those cases mean.
  await db.run(`UPDATE card_cache SET color_identity = '[]' WHERE color_identity IS NULL`);
}

async function main() {
  await db.initDb();
  // Inject the stub Scryfall client. The commander rules refetch thin cache
  // rows before refusing, and this suite must PROVE both that the refetch
  // happens and that it does NOT happen on the happy path -- neither is
  // provable against a client that could reach the network.
  commanderRules.setCardFetcher(scryfallStub);
  const owner = await createUser('pr6f-owner');
  const browser = await createUser('pr6f-browser');
  await seed();

  const app = express();
  app.use(express.json());
  // Mount points must match src/server.js exactly. The collection router
  // declares full paths internally and mounts bare; the decks router mounts
  // under /api/decks.
  app.use('/api', collectionRoutes);
  app.use('/api/decks', deckRoutes);
  // Mounted exactly as src/server.js does. The recorded commander overrides
  // are surfaced through this EXISTING log endpoint rather than a new one, so
  // the test has to exercise the same route the app serves -- asserting on the
  // audit_logs table alone would prove the row exists without proving the user
  // can ever see it.
  app.get('/api/audit-logs', authenticateToken, getAuditLogs);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const context = { owner, browser };
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
  if (failed > 0) throw new Error(`${failed} PR 6F test(s) failed`);
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error.message);
  process.exit(1);
});
