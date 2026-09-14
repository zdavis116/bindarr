// THE DECK LIST CARRIES ITS COMMANDER'S ART.
//
// The desktop deck list is a shelf you recognise by picture, so the tile needs
// commander_image_url and commander_name on GET /api/decks. They were added as
// two scalar subqueries on the EXISTING statement rather than a per-deck fetch
// -- db.js chains every query onto one global queue, so N decks would have
// meant N serial waits.
//
// Everything here goes through the REAL HTTP route and the real db.initDb()
// startup path. The lesson recorded in commander_singleton.test.js applies
// exactly: a test that seeds rows with direct SQL and reads them back with
// direct SQL proves its own fixtures, not the route.
//
// Direct SQL appears only for FIXTURES (card_cache, users) -- never for the
// thing under test.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-deckart-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';

const db = require('../../src/db');
const deckRoutes = require('../../src/routes/decks');

let base;

async function api(token, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* empty body */ }
  return { status: response.status, body: payload };
}

async function createUser(username) {
  const inserted = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, 'member', ?)`,
    [username, db.hashPassword('test-only-password'), `share-${username}-${process.pid}`],
  );
  const token = `${username}-${process.pid}`;
  await db.run(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
    [token, inserted.lastID, new Date(Date.now() + 600_000).toISOString()],
  );
  return { id: inserted.lastID, token };
}

// FIXTURE ONLY: the shared catalogue rows the deck requirements point at.
async function seedCard(id, name, typeLine, imageUrl) {
  await db.run(
    `INSERT INTO card_cache (id, name, oracle_id, type_line, set_id, set_name,
                             number, image_url, rarity, cmc, mana_cost)
     VALUES (?, ?, ?, ?, 'tst', 'Test Set', '1', ?, 'rare', 3, '{1}{G}{G}')`,
    [id, name, `o-${id}`, typeLine, imageUrl],
  );
}

async function addCard(token, deckId, cardId, board) {
  const body = { desired_card_id: cardId, desired_finish: 'nonfoil', quantity: 1 };
  if (board) body.board = board;
  const response = await api(token, `/api/decks/${deckId}/cards`, { method: 'POST', body });
  assert.ok(response.status >= 200 && response.status < 300,
    `setup: adding ${cardId} must succeed: ${JSON.stringify(response.body)}`);
  return response;
}

async function createDeck(token, name, format) {
  const deck = await api(token, '/api/decks', { method: 'POST', body: { name, format } });
  assert.strictEqual(deck.status, 201, JSON.stringify(deck.body));
  return deck.body.id;
}

async function listRow(token, deckId) {
  const list = await api(token, '/api/decks');
  assert.strictEqual(list.status, 200, JSON.stringify(list.body));
  const row = list.body.find(d => d.id === deckId);
  assert.ok(row, `deck ${deckId} must appear in the list`);
  return row;
}

const tests = [];
function test(id, name, fn) { tests.push({ id, name, fn }); }

// ---------------------------------------------------------------------------

test('DECK-ART-1', 'a Commander deck reports its commander art and name', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'Art Deck One', 'Commander');
  await addCard(owner.token, deckId, 'art-cmdr', 'commander');

  const row = await listRow(owner.token, deckId);
  // THE ASSERTION THAT MATTERS: the exact URL the tile renders, from the route.
  assert.strictEqual(row.commander_image_url, 'https://img.test/cmdr.jpg',
    'the list must carry the commander image URL the tile renders');
  assert.strictEqual(row.commander_name, 'Test Commander');
});

test('DECK-ART-2', 'a deck with no commander reports null, not another card', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'Art Deck Two', 'Modern');
  // A mainboard card, deliberately one WITH an image: if the subquery lost its
  // `board = 'commander'` filter it would happily return this one, and a
  // 60-card deck's tile would show a random creature as its face.
  await addCard(owner.token, deckId, 'art-main', null);

  const row = await listRow(owner.token, deckId);
  assert.strictEqual(row.commander_image_url, null,
    'a deck with no commander must report null so the client draws its placeholder');
  assert.strictEqual(row.commander_name, null);
});

test('DECK-ART-3', 'a partner pair reports the FIRST commander, as the deck view does', async ({ owner }) => {
  const deckId = await createDeck(owner.token, 'Art Deck Three', 'Commander');
  // Two commanders in a known order. The subquery orders by dc.id ASC, which is
  // how routes/decks.js reads the commander everywhere else -- if the orders
  // disagreed, the tile and the deck view would name different commanders for
  // the same deck.
  await addCard(owner.token, deckId, 'art-partner-a', 'commander');
  await addCard(owner.token, deckId, 'art-partner-b', 'commander');

  const row = await listRow(owner.token, deckId);
  assert.strictEqual(row.commander_name, 'Partner A',
    'the tile must show the same commander the deck view reads (ORDER BY dc.id ASC)');
  assert.strictEqual(row.commander_image_url, 'https://img.test/partner-a.jpg');
});

test('DECK-ART-4', 'the new columns did not widen the ownership boundary', async ({ owner, other }) => {
  // The columns were added inside a query whose WHERE clause is the only thing
  // scoping decks to a user. A subquery that failed to stay inside that scope
  // would leak across accounts, so this is asserted WITH the new columns
  // present rather than assumed to be untouched.
  //
  // HONEST LIMIT, measured: when the deck_id scope was deleted from the
  // subquery as a mutation, this case still PASSED -- DECK-ART-2 and -3 caught
  // it instead. The leak surfaced as the wrong commander on a deck, not as
  // another user's deck appearing in the list, because the route's outer WHERE
  // still scopes which rows come back. So this case guards the list boundary;
  // the subquery's own scope is guarded by -2 and -3. Do not delete those two
  // believing this one covers them.
  const mine = await listRow(owner.token, await (async () => {
    const id = await createDeck(owner.token, 'Art Deck Four', 'Commander');
    await addCard(owner.token, id, 'art-cmdr', 'commander');
    return id;
  })());
  assert.strictEqual(mine.commander_name, 'Test Commander');

  const theirs = await api(other.token, '/api/decks');
  assert.strictEqual(theirs.status, 200);
  const names = theirs.body.map(d => d.name);
  assert.ok(!names.includes('Art Deck Four'),
    `another user's decks must not appear: ${JSON.stringify(names)}`);
});

test('DECK-ART-5', 'the existing deck-list figures still come back alongside the art', async ({ owner }) => {
  // The art columns were appended to the SELECT that also computes completion
  // and cost. A malformed addition there would break the whole deck list, and
  // the tile would be the least of it -- so the neighbours are asserted too.
  const deckId = await createDeck(owner.token, 'Art Deck Five', 'Commander');
  await addCard(owner.token, deckId, 'art-cmdr', 'commander');
  await addCard(owner.token, deckId, 'art-main', null);

  const row = await listRow(owner.token, deckId);
  assert.strictEqual(row.total_cards, 2, 'the card count must still be computed');
  assert.strictEqual(row.owned_cards, 0, 'nothing is owned in this fixture');
  assert.ok(typeof row.missing_cost === 'number', 'missing_cost must still be a number');
  assert.ok(typeof row.deck_value === 'number', 'deck_value must still be a number');
});

// ---------------------------------------------------------------------------

async function main() {
  await db.initDb();

  await seedCard('art-cmdr', 'Test Commander', 'Legendary Creature — Dragon',
    'https://img.test/cmdr.jpg');
  await seedCard('art-main', 'Test Mainboard Creature', 'Creature — Elf',
    'https://img.test/main.jpg');
  await seedCard('art-partner-a', 'Partner A', 'Legendary Creature — Human',
    'https://img.test/partner-a.jpg');
  await seedCard('art-partner-b', 'Partner B', 'Legendary Creature — Human',
    'https://img.test/partner-b.jpg');

  const owner = await createUser('deckart-owner');
  const other = await createUser('deckart-other');

  const app = express();
  app.use(express.json());
  // Mount point must match src/server.js exactly.
  app.use('/api/decks', deckRoutes);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const context = { owner, other };
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
  if (failed > 0) throw new Error(`${failed} deck-art test(s) failed`);
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error.message);
  process.exit(1);
});
