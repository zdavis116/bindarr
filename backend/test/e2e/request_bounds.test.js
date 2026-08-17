const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-request-bounds-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';
const db = require('../../src/db');
const collectionRoutes = require('../../src/routes/collection');
const storageRoutes = require('../../src/routes/storage');

async function request(base, token, route, body, method = 'POST') {
  return fetch(`${base}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
}

async function expectStatus(base, token, route, body, status, method = 'POST') {
  const response = await request(base, token, route, body, method);
  const payload = await response.json();
  assert.strictEqual(response.status, status, `${route} returned ${response.status}: ${JSON.stringify(payload)}`);
}

async function main() {
  await db.initDb();
  const user = await db.get(`SELECT id FROM users WHERE username = 'admin'`);
  const token = `request-bounds-${process.pid}`;
  await db.run(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
    [token, user.id, new Date(Date.now() + 60_000).toISOString()]
  );
  await db.run(
    `INSERT INTO card_cache (id, oracle_id, name) VALUES (?, ?, ?)`,
    ['bounded-card', 'bounded-oracle', 'Bounded Card']
  );

  const app = express();
  app.use(express.json());
  app.use('/api', collectionRoutes);
  app.use('/api', storageRoutes);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const initialCollection = (await db.get('SELECT COUNT(*) AS count FROM collection')).count;

    // F10-TC1: quantity is a bounded numeric integer; coercible strings,
    // fractions and oversized values are rejected before collection writes.
    await expectStatus(base, token, '/api/collection', { card_id: 'bounded-card', quantity: '2' }, 400);
    await expectStatus(base, token, '/api/collection', { card_id: 'bounded-card', quantity: 1.5 }, 400);
    await expectStatus(base, token, '/api/collection', { card_id: 'bounded-card', quantity: null }, 400);
    await expectStatus(base, token, '/api/collection', { card_id: 'bounded-card', quantity: 1001 }, 413);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM collection')).count, initialCollection);
    console.log('PASS: F10-TC1');

    // F10-TC2: bulk work is bounded by array size, uniqueness, quantity and the
    // expanded operation count, all before the per-card loop starts.
    await expectStatus(base, token, '/api/collection/bulk-add', { card_ids: 'bounded-card', quantity: 1 }, 400);
    await expectStatus(base, token, '/api/collection/bulk-add', { card_ids: ['bounded-card', 'bounded-card'], quantity: 1 }, 400);
    await expectStatus(base, token, '/api/collection/bulk-add', { card_ids: ['bounded-card'], quantity: null }, 400);
    await expectStatus(base, token, '/api/collection/bulk-add', { card_ids: Array.from({ length: 251 }, (_, i) => `card-${i}`), quantity: 1 }, 413);
    await expectStatus(base, token, '/api/collection/bulk-add', { card_ids: Array.from({ length: 5 }, (_, i) => `card-${i}`), quantity: 201 }, 413);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM collection')).count, initialCollection);
    console.log('PASS: F10-TC2');

    // F10-TC3: custom compartment plans accept only numeric integers in range,
    // before creating either the location or any compartments.
    const initialLocations = (await db.get('SELECT COUNT(*) AS count FROM locations')).count;
    await expectStatus(base, token, '/api/locations', { name: 'Bad count type', type: 'Box', compartmentPlan: { count: '2', capacity: 10 } }, 400);
    await expectStatus(base, token, '/api/locations', { name: 'Bad capacity fraction', type: 'Box', compartmentPlan: { count: 2, capacity: 1.5 } }, 400);
    await expectStatus(base, token, '/api/locations', { name: 'Too many rows', type: 'Box', compartmentPlan: { count: 1001, capacity: 10 } }, 413);
    await expectStatus(base, token, '/api/locations', { name: 'Too much capacity', type: 'Box', compartmentPlan: { count: 2, capacity: 1001 } }, 413);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM locations')).count, initialLocations);
    console.log('PASS: F10-TC3');

    // F10-TC4: editing quantity validates the exact numeric integer before the
    // lookup/update/auto-split path can amplify it into collection writes.
    const entry = await db.run(
      `INSERT INTO collection (card_id, user_id, quantity) VALUES (?, ?, 1)`,
      ['bounded-card', user.id]
    );
    await expectStatus(base, token, `/api/collection/${entry.lastID}`, { quantity: '2' }, 400, 'PUT');
    await expectStatus(base, token, `/api/collection/${entry.lastID}`, { quantity: 1.5 }, 400, 'PUT');
    await expectStatus(base, token, `/api/collection/${entry.lastID}`, { quantity: 1001 }, 413, 'PUT');
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM collection')).count, initialCollection + 1);
    console.log('PASS: F10-TC4');

    // F10-TC5: every entry-id batch endpoint accepts only unique positive
    // integer IDs, capped at 1000, and rejects before location/collection reads.
    const oversizedIds = Array.from({ length: 1001 }, (_, i) => i + 1);
    const malformedLists = ['1', ['1'], [1.5], [1, 1]];
    for (const entry_ids of malformedLists) {
      await expectStatus(base, token, '/api/collection/bulk', { entry_ids, action: 'delete' }, 400);
      await expectStatus(base, token, '/api/locations/999999/recommend-batch', { entry_ids }, 400);
      await expectStatus(base, token, '/api/locations/999999/apply-all', { entry_ids }, 400);
    }
    await expectStatus(base, token, '/api/collection/bulk', { entry_ids: oversizedIds, action: 'delete' }, 413);
    await expectStatus(base, token, '/api/locations/999999/recommend-batch', { entry_ids: oversizedIds }, 413);
    await expectStatus(base, token, '/api/locations/999999/apply-all', { entry_ids: oversizedIds }, 413);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM collection')).count, initialCollection + 1);
    console.log('PASS: F10-TC5');

    // Omitted quantities retain the public default of one for both add paths.
    await expectStatus(base, token, '/api/collection', { card_id: 'bounded-card' }, 200);
    await expectStatus(base, token, '/api/collection/bulk-add', { card_ids: ['bounded-card'] }, 200);
    const defaultedRows = await db.all(
      'SELECT quantity FROM collection WHERE card_id = ? ORDER BY id DESC LIMIT 2',
      ['bounded-card']
    );
    assert.deepStrictEqual(defaultedRows.map(row => row.quantity), [1, 1]);
    console.log('PASS: omitted quantity defaults');
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* already removed */ }
    }
  }
}

main().then(() => process.exit(0)).catch(error => {
  console.error('FAIL: F10-TC1 -', error.message);
  process.exit(1);
});
