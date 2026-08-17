const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

const tmpDb = path.join(os.tmpdir(), `bindarr-final-schema-routes-${process.pid}.db`);
const tmpSetsDir = fs.mkdtempSync(path.join(os.tmpdir(), `bindarr-final-schema-indexes-${process.pid}-`));
process.env.DB_PATH = tmpDb;
const port = '3017';
const projectRoot = path.join(__dirname, '../../../');
const db = require('../../src/db');

async function waitForServer(base) {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start in time');
}

async function waitForAdmin() {
  for (let i = 0; i < 150; i++) {
    try {
      const admin = await db.get(`SELECT id FROM users WHERE username = 'admin'`);
      if (admin) return admin.id;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Fresh database did not initialize in time');
}

const assertNoCompatibilityFields = (value, label) => {
  for (const field of ['game', 'language', 'printed_name', 'tcg_api_key']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(value, field), `${label} must not expose ${field}`);
  }
};

async function runTests() {
  const base = `http://localhost:${port}`;
  const server = spawn('node', ['-r', path.join(__dirname, 'scryfall-mock.js'), path.join(projectRoot, 'backend/src/server.js')], {
    env: { ...process.env, PORT: port, DB_PATH: tmpDb, SETS_DIR: tmpSetsDir, SCAN_WORKERS: '0', BACKUP_INTERVAL_HOURS: '0' }
  });
  const failures = [];
  const check = async (id, fn) => {
    try { await fn(); console.log(`PASS: F10-TC${id}`); }
    catch (error) { failures.push(`F10-TC${id}: ${error.message}`); console.error(`FAIL: F10-TC${id} - ${error.message}`); }
  };

  try {
    await waitForServer(base);
    const adminId = await waitForAdmin();
    const token = 'final-schema-route-token';
    await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATETIME('now', '+1 day'))`, [token, adminId]);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const request = (url, options = {}) => fetch(`${base}${url}`, { headers, ...options });

    await db.run(`INSERT INTO card_cache (id, oracle_id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend)
      VALUES ('mtg-route-card', 'oracle-route-card', 'Alpha Card', 'MTG', '[]', '["Artifact"]', 'Rare', 'lea', 'Alpha', '1', '', 12)`);
    const openLocation = await db.run(`INSERT INTO locations (name, type, rule_type, user_id) VALUES ('Open', 'Box', 'any', ?)`, [adminId]);
    await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 20)`, [openLocation.lastID]);

    await check(1, async () => {
      const response = await request(`/api/locations/${openLocation.lastID}/recommend`, {
        method: 'POST', body: JSON.stringify({ card_id: 'mtg-route-card' })
      });
      assert.strictEqual(response.status, 200, `fresh-schema recommendation returned ${response.status}`);
      assert.ok((await response.json()).compartment_id, 'single-card recommendation must return a compartment');
    });

    await check(2, async () => {
      const response = await request('/api/collection', {
        method: 'POST', body: JSON.stringify({ card_id: 'mtg-route-card', location_id: openLocation.lastID })
      });
      assert.strictEqual(response.status, 200, await response.text());
      const row = await db.get(`SELECT * FROM collection WHERE card_id = 'mtg-route-card' ORDER BY id DESC LIMIT 1`);
      assertNoCompatibilityFields(row, 'stored collection row');
      assert.strictEqual(row.location_id, openLocation.lastID);
      assert.ok(row.compartment_id, 'add must retain MTG location placement');
    });

    await check(3, async () => {
      const response = await request('/api/collection');
      assert.strictEqual(response.status, 200);
      const body = await response.json();
      assert.ok(body.length > 0);
      body.forEach(card => assertNoCompatibilityFields(card, 'collection response'));
    });

    await check(4, async () => {
      const response = await request('/api/locations', {
        method: 'POST', body: JSON.stringify({ name: 'Second Box', type: 'Box' })
      });
      assert.strictEqual(response.status, 200, await response.text());
      const locations = await (await request('/api/locations')).json();
      locations.forEach(location => assertNoCompatibilityFields(location, 'location response'));
    });

    await check(5, async () => {
      const created = await request('/api/decks', {
        method: 'POST', body: JSON.stringify({ name: 'Schema Deck', format: 'Commander / EDH' })
      });
      assert.strictEqual(created.status, 201, await created.text());
      const decks = await (await request('/api/decks')).json();
      assert.ok(decks.some(deck => deck.name === 'Schema Deck'));
      decks.forEach(deck => assertNoCompatibilityFields(deck, 'deck response'));
    });

    await check(6, async () => {
      const response = await request('/api/auth/me');
      assert.strictEqual(response.status, 200);
      assertNoCompatibilityFields((await response.json()).user, 'auth response');
    });

    await check(7, async () => {
      const response = await request('/api/search?name=Alpha');
      assert.strictEqual(response.status, 200);
      const cards = await response.json();
      assert.ok(cards.length > 0);
      cards.forEach(card => assertNoCompatibilityFields(card, 'search response'));
    });

    await check(8, async () => {
      const response = await request('/api/stats');
      assert.strictEqual(response.status, 200);
      const stats = await response.json();
      stats.topValuable.forEach(card => assertNoCompatibilityFields(card, 'stats response'));
      stats.recentAdditions.forEach(card => assertNoCompatibilityFields(card, 'stats response'));
    });

    await check(9, async () => {
      const response = await request('/api/import', { method: 'POST', body: '{}' });
      assert.strictEqual(response.status, 501);
    });

    await check(10, async () => {
      const response = await request('/api/collection', {
        method: 'POST', body: JSON.stringify({ card_id: '00000000-0000-4000-8000-000000000003' })
      });
      assert.strictEqual(response.status, 400, 'foreign printing must remain rejected at the English-only boundary');
    });

    await db.run(`INSERT INTO sets (id, name, release_date) VALUES ('mtg-lea', 'Limited Edition Alpha', '1993-08-05')`);
    await check(11, async () => {
      const response = await request('/api/sets');
      assert.strictEqual(response.status, 200);
      const sets = await response.json();
      assert.ok(sets.length > 0);
      sets.forEach(set => assertNoCompatibilityFields(set, 'sets response'));
    });

    await check(12, async () => {
      const response = await request('/api/admin/set-indexes/preview?game=mtg&set=lea&lang=en');
      assert.strictEqual(response.status, 200);
      const preview = await response.json();
      assert.strictEqual(preview.game, 'mtg', 'scan-index routing keeps its legitimate game identifier');
      assert.strictEqual(preview.lang, 'en', 'scan-index routing keeps its legitimate language identifier');
    });

    await check(13, async () => {
      const canonicalResponse = await request('/api/admin/sets-browse');
      const legacyQueryResponse = await request('/api/admin/sets-browse?game=pokemon');
      assert.strictEqual(canonicalResponse.status, 200);
      assert.strictEqual(legacyQueryResponse.status, 200);
      const canonicalSets = await canonicalResponse.json();
      const legacyQuerySets = await legacyQueryResponse.json();
      assert.deepStrictEqual(legacyQuerySets, canonicalSets, 'sets-browse must ignore the removed Pokémon alias');
      assert.strictEqual(canonicalSets[0].id, 'mtg-lea', 'sets-browse must return canonical MTG set IDs');
      canonicalSets.forEach(set => assertNoCompatibilityFields(set, 'sets-browse response'));
    });

    if (failures.length) throw new Error(`Final-schema route failures:\n${failures.join('\n')}`);
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    try { await new Promise(resolve => db.dbConnection.close(() => resolve())); } catch {}
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
    try { fs.rmSync(tmpSetsDir, { recursive: true, force: true }); } catch {}
  }
}

runTests().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
