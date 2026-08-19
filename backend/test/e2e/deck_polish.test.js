// PR 6I items 1, 2 and 3 — deck polish, found by Zach on the dev instance.
//
// Every case goes through the REAL HTTP routes and asserts on DATABASE ROWS or
// on the VALUES THE API ACTUALLY RETURNS — never on a status code alone. That
// is the standing rule in this project, paid for by PR 6E/6F where two real
// bugs survived a green suite because the tests wrote rows with direct SQL
// against a freshly built schema.
//
// Direct SQL appears here only for FIXTURES (seeding card_cache, creating
// users). The thing under test is always reached through a route.
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-pr6i-${process.pid}.db`);
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

async function seedCard(id, { name, oracleId, number, setId = 'p6i', setName = 'PR6I Set' }) {
  await db.run(
    `INSERT OR IGNORE INTO card_cache
       (id, oracle_id, name, set_id, set_name, number, finishes, supertype, subtypes,
        type_line, oracle_text, keywords, color_identity, types, legalities)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Creature', '["Creature"]',
             'Creature — Test', '', '[]', '["Green"]', '[]', '{"commander":"legal"}')`,
    [id, oracleId, name, setId, setName, number, JSON.stringify(['nonfoil', 'foil'])]
  );
}

const tests = [];
function test(id, name, fn) { tests.push({ id, name, fn }); }

// Find a card in a search response by its printing id, and report WHERE it sat.
// Position is the thing under test for item 3, so it is read explicitly rather
// than inferred from a truthy find().
function positionOf(results, cardId) {
  return results.findIndex(card => card.id === cardId);
}

// ===========================================================================
// ITEM 1 — the Browse Collection counts must be re-readable after a mutation.
//
// The bug is a CLIENT refresh gap: the server's numbers were already right.
// A backend test therefore cannot assert on what the panel displays. What it
// CAN — and must — establish is the property the client fix depends on: that
// re-issuing the very same request the panel made returns the UPDATED figures.
// If that were not true, refetching would fix nothing and the client work would
// be built on sand.
//
// The frontend half (that a delete actually triggers the refetch) is asserted
// separately in the frontend test file; the two together cover the item.
// ===========================================================================

test('F16-TC10', 'the panel\'s own request reports UPDATED availability after a deck-card delete', async ({ counts }) => {
  const token = counts.token;

  // Two copies owned, so "available" has somewhere to move to and from.
  await ownCopy(token, 'p6i-kodama-a');
  await ownCopy(token, 'p6i-kodama-a');

  const deck = await api(token, '/api/decks', {
    method: 'POST', body: { name: 'PR6I Counts Deck', format: 'Modern' }
  });
  assert.strictEqual(deck.status, 201, JSON.stringify(deck.body));

  const added = await api(token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'p6i-kodama-a', desired_finish: 'nonfoil', quantity: 2 }
  });
  assert.strictEqual(added.status, 200, JSON.stringify(added.body));

  // THE EXACT REQUEST THE BROWSE PANEL MAKES.
  const beforeDelete = await api(token, '/api/collection');
  assert.strictEqual(beforeDelete.status, 200);
  const committedRows = beforeDelete.body.filter(r => r.card_id === 'p6i-kodama-a');
  assert.strictEqual(committedRows.length, 2, 'both physical copies are listed');
  // Both copies are committed, so In Deck reads 2 and nothing is free.
  assert.ok(committedRows.every(r => r.in_deck_qty === 2),
    `In Deck must report the committed total, got ${JSON.stringify(committedRows.map(r => r.in_deck_qty))}`);

  // Find the deck_cards row and delete it through the real route.
  const deckRow = await db.get(
    `SELECT id FROM deck_cards WHERE deck_id = ? AND desired_card_id = ?`,
    [deck.body.id, 'p6i-kodama-a']
  );
  const removed = await api(token, `/api/decks/${deck.body.id}/cards/${deckRow.id}`, { method: 'DELETE' });
  assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));

  // RE-ISSUE THE SAME REQUEST. This is precisely what refreshResultsPanel()
  // does on the client, so this asserts the server half of the fix.
  const afterDelete = await api(token, '/api/collection');
  const freedRows = afterDelete.body.filter(r => r.card_id === 'p6i-kodama-a');
  assert.strictEqual(freedRows.length, 2, 'the copies are still owned — only the deck requirement went');
  assert.ok(freedRows.every(r => r.in_deck_qty === 0),
    `In Deck must fall to 0 once the requirement is deleted, got ${JSON.stringify(freedRows.map(r => r.in_deck_qty))}`);

  // And the allocations really are gone in the database, not merely reported as gone.
  const allocations = await db.all(
    `SELECT a.id FROM deck_card_allocations a
     JOIN deck_cards dc ON a.deck_card_id = dc.id WHERE dc.deck_id = ?`,
    [deck.body.id]
  );
  assert.deepStrictEqual(allocations, [], 'the delete must genuinely release the copies');
});

test('F16-TC11', 'the search route\'s availability figures also update after a delete', async ({ counts2 }) => {
  const token = counts2.token;
  await ownCopy(token, 'p6i-kodama-b');

  const deck = await api(token, '/api/decks', {
    method: 'POST', body: { name: 'PR6I Counts Deck Two', format: 'Modern' }
  });
  await api(token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'p6i-kodama-b', desired_finish: 'nonfoil', quantity: 1 }
  });

  const committed = await api(token, '/api/search?name=Kodama%20Bravo&scope=database');
  const committedRow = committed.body.find(c => c.id === 'p6i-kodama-b');
  assert.ok(committedRow, 'the printing must be findable');
  assert.strictEqual(committedRow.owned_qty, 1);
  assert.strictEqual(committedRow.available_qty, 0, 'a committed copy is not available');

  const deckRow = await db.get(
    `SELECT id FROM deck_cards WHERE deck_id = ? AND desired_card_id = ?`,
    [deck.body.id, 'p6i-kodama-b']
  );
  await api(token, `/api/decks/${deck.body.id}/cards/${deckRow.id}`, { method: 'DELETE' });

  const freed = await api(token, '/api/search?name=Kodama%20Bravo&scope=database');
  const freedRow = freed.body.find(c => c.id === 'p6i-kodama-b');
  assert.strictEqual(freedRow.available_qty, 1,
    'the same search must now report the copy as free — this is what the panel refetch relies on');
});

// ===========================================================================
// ITEM 2 — duplicate deck names are refused, on create AND on rename.
// ===========================================================================

test('F16-TC12', 'a duplicate deck name is REFUSED on create', async ({ names }) => {
  const first = await api(names.token, '/api/decks', {
    method: 'POST', body: { name: 'Ur-Dragon', format: 'Modern' }
  });
  assert.strictEqual(first.status, 201, JSON.stringify(first.body));

  const second = await api(names.token, '/api/decks', {
    method: 'POST', body: { name: 'Ur-Dragon', format: 'Modern' }
  });
  assert.strictEqual(second.status, 409, `a duplicate name must be refused: ${JSON.stringify(second.body)}`);
  assert.strictEqual(second.body.code, 'DECK_NAME_IN_USE');
  // The message must SAY SO CLEARLY, per the spec — a bare code is not enough
  // for a user to act on.
  assert.ok(/already have a deck called/i.test(second.body.error),
    `the refusal must name the problem clearly, got: ${second.body.error}`);

  // AND NO DECK WAS CREATED. A refusal that still leaves a deck behind is the
  // bug wearing a different hat.
  const decks = await db.all(
    `SELECT id FROM decks WHERE user_id = ? AND name = 'Ur-Dragon'`, [names.id]
  );
  assert.strictEqual(decks.length, 1, 'exactly one deck may exist after a refused duplicate create');
});

test('F16-TC13', 'the comparison is case- and whitespace-insensitive', async ({ names2 }) => {
  const first = await api(names2.token, '/api/decks', {
    method: 'POST', body: { name: 'Ur-Dragon', format: 'Modern' }
  });
  assert.strictEqual(first.status, 201);

  // The spec's own examples, plus interior whitespace, which is invisible on
  // screen and would otherwise create a deck the user cannot tell apart.
  for (const variant of ['ur-dragon ', '  UR-DRAGON', 'Ur-Dragon   ', 'ur-Dragon']) {
    const attempt = await api(names2.token, '/api/decks', {
      method: 'POST', body: { name: variant, format: 'Modern' }
    });
    assert.strictEqual(attempt.status, 409,
      `"${variant}" must be refused as a duplicate of "Ur-Dragon": ${JSON.stringify(attempt.body)}`);
  }

  const count = await db.get(`SELECT COUNT(*) AS n FROM decks WHERE user_id = ?`, [names2.id]);
  assert.strictEqual(count.n, 1, 'none of the variants may have created a deck');
});

test('F16-TC14', 'RENAMING onto an existing name is refused too', async ({ names3 }) => {
  const keeper = await api(names3.token, '/api/decks', {
    method: 'POST', body: { name: 'Atraxa', format: 'Modern' }
  });
  const other = await api(names3.token, '/api/decks', {
    method: 'POST', body: { name: 'Temporary', format: 'Modern' }
  });
  assert.strictEqual(keeper.status, 201);
  assert.strictEqual(other.status, 201);

  // Case- and whitespace-insensitive on the rename path as well: the rule is
  // the same rule, so it must behave the same way.
  const renamed = await api(names3.token, `/api/decks/${other.body.id}`, {
    method: 'PUT', body: { name: '  atraxa ' }
  });
  assert.strictEqual(renamed.status, 409,
    `renaming onto an existing name must be refused: ${JSON.stringify(renamed.body)}`);
  assert.strictEqual(renamed.body.code, 'DECK_NAME_IN_USE');

  // THE NAME IN THE DATABASE IS UNCHANGED. Asserting on the row, not the
  // response: a refusal that still wrote the name would be the worst outcome.
  const row = await db.get(`SELECT name FROM decks WHERE id = ?`, [other.body.id]);
  assert.strictEqual(row.name, 'Temporary', 'a refused rename must not change the stored name');
});

test('F16-TC15', 'a deck can still be renamed to a free name, and re-saved under its own', async ({ names4 }) => {
  const deck = await api(names4.token, '/api/decks', {
    method: 'POST', body: { name: 'Slivers', format: 'Modern' }
  });
  assert.strictEqual(deck.status, 201);

  // Renaming to something free must WORK — the guard must not make decks
  // unrenameable.
  const moved = await api(names4.token, `/api/decks/${deck.body.id}`, {
    method: 'PUT', body: { name: 'Sliver Overlord' }
  });
  assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
  let row = await db.get(`SELECT name FROM decks WHERE id = ?`, [deck.body.id]);
  assert.strictEqual(row.name, 'Sliver Overlord');

  // Re-saving a deck under ITS OWN name must not be refused as a clash with
  // itself. Without excludeDeckId this is exactly what would break.
  const resaved = await api(names4.token, `/api/decks/${deck.body.id}`, {
    method: 'PUT', body: { name: 'Sliver Overlord', description: 'now with a note' }
  });
  assert.strictEqual(resaved.status, 200,
    `re-saving under its own name must succeed: ${JSON.stringify(resaved.body)}`);

  // And a case-only correction of its own name is a legitimate edit.
  const recased = await api(names4.token, `/api/decks/${deck.body.id}`, {
    method: 'PUT', body: { name: 'SLIVER OVERLORD' }
  });
  assert.strictEqual(recased.status, 200, JSON.stringify(recased.body));
  row = await db.get(`SELECT name FROM decks WHERE id = ?`, [deck.body.id]);
  assert.strictEqual(row.name, 'SLIVER OVERLORD', 'a case-only rename of itself must apply');

  // A description-only update must not be judged on a name it did not send.
  const descOnly = await api(names4.token, `/api/decks/${deck.body.id}`, {
    method: 'PUT', body: { description: 'just the description' }
  });
  assert.strictEqual(descOnly.status, 200, JSON.stringify(descOnly.body));
});

test('F16-TC16', 'the uniqueness rule is PER USER', async ({ names5, names6 }) => {
  const mine = await api(names5.token, '/api/decks', {
    method: 'POST', body: { name: 'Shared Name Deck', format: 'Modern' }
  });
  assert.strictEqual(mine.status, 201);

  // A DIFFERENT user must be entirely unaffected. Scoping this any wider would
  // also leak the existence of another user's decks through the refusal.
  const theirs = await api(names6.token, '/api/decks', {
    method: 'POST', body: { name: 'Shared Name Deck', format: 'Modern' }
  });
  assert.strictEqual(theirs.status, 201,
    `another user must be free to use the same name: ${JSON.stringify(theirs.body)}`);
});

// ===========================================================================
// ITEM 3 — owned printings sort to the top of any all-cards search.
//
// The assertions are on POSITION, because position is the whole complaint:
// "the one I own was toward the bottom so I had to scroll a bit to find it."
// A test that merely checked the owned card was PRESENT would have passed
// before the fix.
// ===========================================================================

test('F16-TC17', 'an OWNED printing sorts above unowned printings of the same name', async ({ search }) => {
  // Five Kodama printings exist in the catalogue; he owns exactly one, and it
  // is deliberately seeded LAST so an unranked query would return it last.
  await ownCopy(search.token, 'p6i-kod-5');

  const response = await api(search.token, '/api/search?name=Kodama%20Search&scope=database');
  assert.strictEqual(response.status, 200);
  const results = response.body;
  assert.ok(results.length >= 5, `all five printings must be returned, got ${results.length}`);

  const ownedAt = positionOf(results, 'p6i-kod-5');
  assert.strictEqual(ownedAt, 0,
    `HIS printing must be first, but it sat at index ${ownedAt} of ${results.length}`);

  // Ownership is per EXACT PRINTING: the other Kodamas must NOT be hoisted
  // merely for sharing a name. That is the distinction the spec calls out.
  const others = results.filter(c => c.id !== 'p6i-kod-5');
  assert.ok(others.every(c => (c.owned_qty ?? 0) === 0),
    'only the owned printing may be marked owned — ownership is per printing, not per name');
});

test('F16-TC18', 'owned-but-COMMITTED sorts above unowned, and below owned-and-available', async ({ search2 }) => {
  // Two owned printings: one free, one entirely committed to a deck. Plus three
  // unowned. The spec's three bands, exercised in one search.
  await ownCopy(search2.token, 'p6i-band-free');
  await ownCopy(search2.token, 'p6i-band-committed');

  const deck = await api(search2.token, '/api/decks', {
    method: 'POST', body: { name: 'PR6I Band Deck', format: 'Modern' }
  });
  const committed = await api(search2.token, `/api/decks/${deck.body.id}/cards`, {
    method: 'POST',
    body: { desired_card_id: 'p6i-band-committed', desired_finish: 'nonfoil', quantity: 1 }
  });
  assert.strictEqual(committed.status, 200, JSON.stringify(committed.body));

  const response = await api(search2.token, '/api/search?name=Banded&scope=database');
  const results = response.body;

  const freeAt = positionOf(results, 'p6i-band-free');
  const committedAt = positionOf(results, 'p6i-band-committed');
  assert.ok(freeAt >= 0 && committedAt >= 0, 'both owned printings must be returned');

  // Band 0 above band 1.
  assert.ok(freeAt < committedAt,
    `an available copy must outrank a fully committed one (free=${freeAt}, committed=${committedAt})`);

  // Band 1 above band 2 — the case the spec names explicitly.
  const unownedPositions = results
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (c.owned_qty ?? 0) === 0)
    .map(({ i }) => i);
  assert.ok(unownedPositions.length >= 3, 'the unowned printings must still be returned, not filtered out');
  assert.ok(committedAt < Math.min(...unownedPositions),
    `an owned-but-committed printing must outrank every unowned one `
    + `(committed=${committedAt}, first unowned=${Math.min(...unownedPositions)})`);

  // The figures the row displays must agree with the band it was placed in,
  // or the user sees a card at the top labelled as unavailable for no reason.
  assert.strictEqual(results[committedAt].owned_qty, 1);
  assert.strictEqual(results[committedAt].available_qty, 0);
  assert.strictEqual(results[freeAt].available_qty, 1);
});

test('F16-TC19', 'the COMMANDER search ranks owned printings first too', async ({ search3 }) => {
  // The spec is explicit that this applies to EVERY search returning catalogue
  // results, not just the deck Add Cards box. The commander picker is a
  // separate screen using the same route with commanders=1, so it is asserted
  // separately rather than assumed.
  await ownCopy(search3.token, 'p6i-cmd-owned');

  const response = await api(search3.token, '/api/search?name=Commander%20Rank&scope=database&commanders=1');
  assert.strictEqual(response.status, 200);
  const results = response.body;
  assert.ok(results.length >= 2, `the commander filter must still return the legal commanders, got ${results.length}`);

  assert.strictEqual(positionOf(results, 'p6i-cmd-owned'), 0,
    'the owned legal commander must be first in the commander picker');
  // The filter must still be doing its job — ranking must not have widened it.
  assert.ok(results.every(c => /Legendary/.test(c.type_line || '')),
    'commander filtering must still exclude non-commanders');
});

test('F16-TC20', 'ranking does not drop, duplicate or filter any result', async ({ search4 }) => {
  // The guard against the obvious way to get this wrong: a sort that quietly
  // loses rows would "fix" the complaint while hiding cards.
  await ownCopy(search4.token, 'p6i-kod-2');

  const response = await api(search4.token, '/api/search?name=Kodama%20Search&scope=database');
  const results = response.body;
  const ids = results.map(c => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'ranking must not duplicate a result');
  for (const expected of ['p6i-kod-1', 'p6i-kod-2', 'p6i-kod-3', 'p6i-kod-4', 'p6i-kod-5']) {
    assert.ok(ids.includes(expected), `${expected} must still be returned after ranking`);
  }
  assert.strictEqual(positionOf(results, 'p6i-kod-2'), 0, 'and the owned one is first');
});

// ---------------------------------------------------------------------------

async function seed() {
  // Five printings of one name. Only ONE is ever owned by a given test user,
  // which is what makes "his printing, not merely any printing" testable.
  for (let i = 1; i <= 5; i++) {
    await seedCard(`p6i-kod-${i}`, {
      name: 'Kodama Search Fixture', oracleId: 'o-p6i-kod', number: String(i),
      setId: `k0${i}`, setName: `Kodama Set ${i}`
    });
  }
  // Item 1 fixtures.
  await seedCard('p6i-kodama-a', { name: 'Kodama Alpha', oracleId: 'o-p6i-kodama-a', number: '11' });
  await seedCard('p6i-kodama-b', { name: 'Kodama Bravo', oracleId: 'o-p6i-kodama-b', number: '12' });
  // Item 3 band fixtures.
  //
  // SEEDED IN DELIBERATELY WRONG ORDER: the three UNOWNED printings are
  // inserted first and the owned ones last, so an unranked query returns them
  // in exactly the order the fix must overturn. Seeding them in the order the
  // assertion wants would make these cases pass without the fix and prove
  // nothing — which is precisely how the original stale-count and false-report
  // bugs survived green suites.
  for (let i = 1; i <= 3; i++) {
    await seedCard(`p6i-band-unowned-${i}`, {
      name: `Banded Unowned ${i}`, oracleId: `o-p6i-band-unowned-${i}`, number: `3${i}`
    });
  }
  await seedCard('p6i-band-committed', { name: 'Banded Committed', oracleId: 'o-p6i-band-committed', number: '22' });
  await seedCard('p6i-band-free', { name: 'Banded Free', oracleId: 'o-p6i-band-free', number: '21' });
  // Commander fixtures: legal commanders, the OWNED one seeded LAST for the
  // same reason as above.
  for (const [id, number] of [['p6i-cmd-other', '42'], ['p6i-cmd-third', '43'], ['p6i-cmd-owned', '41']]) {
    await db.run(
      `INSERT OR IGNORE INTO card_cache
         (id, oracle_id, name, set_id, set_name, number, finishes, supertype, subtypes,
          type_line, oracle_text, keywords, color_identity, types, legalities)
       VALUES (?, ?, ?, 'p6c', 'PR6I Cmd Set', ?, ?, 'Creature',
               '["Legendary","Creature"]', 'Legendary Creature — Test', '', '[]',
               '["Green"]', '[]', '{"commander":"legal"}')`,
      [id, `o-${id}`, `Commander Rank ${number}`, number, JSON.stringify(['nonfoil'])]
    );
  }
}

async function main() {
  await db.initDb();

  const counts = await createUser('pr6i-counts');
  const counts2 = await createUser('pr6i-counts2');
  // Each name case needs its OWN user: the rule is per-user, so sharing one
  // would let an earlier case's deck decide a later case's outcome.
  const names = await createUser('pr6i-names');
  const names2 = await createUser('pr6i-names2');
  const names3 = await createUser('pr6i-names3');
  const names4 = await createUser('pr6i-names4');
  const names5 = await createUser('pr6i-names5');
  const names6 = await createUser('pr6i-names6');
  // Likewise each search case: ranking is computed from the whole collection,
  // so one case owning a card would silently change another's expected order.
  const search = await createUser('pr6i-search');
  const search2 = await createUser('pr6i-search2');
  const search3 = await createUser('pr6i-search3');
  const search4 = await createUser('pr6i-search4');
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
    counts, counts2, names, names2, names3, names4, names5, names6,
    search, search2, search3, search4
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
  if (failed > 0) throw new Error(`${failed} PR 6I test(s) failed`);
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error.message);
  process.exit(1);
});
