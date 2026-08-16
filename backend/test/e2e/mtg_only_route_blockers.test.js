const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

const tmpDb = path.join(os.tmpdir(), `bindarr-mtg-route-blockers-${process.pid}.db`);
const tmpSetsDir = fs.mkdtempSync(path.join(os.tmpdir(), `bindarr-mtg-route-indexes-${process.pid}-`));
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
    const token = 'mtg-only-route-blockers-token';
    await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATETIME('now', '+1 day'))`, [token, adminId]);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const request = (url, options = {}) => fetch(`${base}${url}`, { headers, ...options });

    await db.run(`INSERT INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend)
      VALUES ('mtg-route-card', 'Alpha Card', 'MTG', '[]', '["Artifact"]', 'Rare', 'lea', 'Alpha', '1', '', 12)`);
    const openLocation = await db.run(`INSERT INTO locations (name, type, rule_type, game, user_id) VALUES ('Open', 'Box', 'any', 'mtg', ?)`, [adminId]);
    await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 20)`, [openLocation.lastID]);

    await check(1, async () => {
      const response = await request(`/api/locations/${openLocation.lastID}/recommend`, {
        method: 'POST', body: JSON.stringify({ card_id: 'mtg-route-card', game: 'pokemon', language: 'Japanese' })
      });
      assert.strictEqual(response.status, 200, `fresh-schema recommendation returned ${response.status}`);
      const body = await response.json();
      assert.ok(body.compartment_id, 'single-card recommendation must return a compartment');
    });

    await check(2, async () => {
      const response = await request('/api/import', {
        method: 'POST', body: JSON.stringify({ format: 'json', data: [{ card_id: 'mtg-import-ja', name: 'Imported', language: 'Japanese', game: 'pokemon' }] })
      });
      assert.strictEqual(response.status, 501, `collection import should be disabled, got ${response.status}`);
      const body = await response.json();
      assert.match(body.error, /disabled|not supported|unavailable/i);
      const cached = await db.get(`SELECT id FROM card_cache WHERE id = 'mtg-import-ja'`);
      const collected = await db.get(`SELECT id FROM collection WHERE card_id = 'mtg-import-ja'`);
      assert.strictEqual(cached, undefined, 'disabled import must not create cache rows');
      assert.strictEqual(collected, undefined, 'disabled import must not create collection rows');
    });

    const englishRule = JSON.stringify({ rules: [{ field: 'language', operator: 'equals', value: 'English', action: 'include' }] });
    const ruledLocation = await db.run(`INSERT INTO locations (name, type, sort_order, rule_type, rule_config, game, user_id)
      VALUES ('English only', 'Box', '[{"by":"language","dir":"asc"}]', 'compound', ?, 'mtg', ?)`, [englishRule, adminId]);
    await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 20)`, [ruledLocation.lastID]);

    await check(3, async () => {
      const response = await request('/api/collection', {
        method: 'POST', body: JSON.stringify({ card_id: 'mtg-route-card', location_id: ruledLocation.lastID, language: 'Japanese', game: 'pokemon' })
      });
      assert.strictEqual(response.status, 200, await response.text());
      const row = await db.get(`SELECT id, language, location_id, compartment_id FROM collection WHERE card_id = 'mtg-route-card' ORDER BY id DESC LIMIT 1`);
      assert.strictEqual(row.language, 'English');
      assert.strictEqual(row.location_id, ruledLocation.lastID, 'add must canonicalize before placement rules');
      assert.ok(row.compartment_id, 'add must receive a compartment');
    });

    const moving = await db.run(`INSERT INTO collection (card_id, user_id, language) VALUES ('mtg-route-card', ?, 'Japanese')`, [adminId]);
    await check(4, async () => {
      const response = await request(`/api/collection/${moving.lastID}`, {
        method: 'PUT', body: JSON.stringify({ location_id: ruledLocation.lastID, language: 'Japanese', game: 'pokemon' })
      });
      assert.strictEqual(response.status, 200, await response.text());
      const row = await db.get(`SELECT language, location_id, compartment_id FROM collection WHERE id = ?`, [moving.lastID]);
      assert.strictEqual(row.language, 'English');
      assert.strictEqual(row.location_id, ruledLocation.lastID, 'move must canonicalize before placement rules');
      assert.ok(row.compartment_id, 'move must receive a compartment');
    });

    await check(5, async () => {
      const response = await request(`/api/locations/${ruledLocation.lastID}/recommend`, {
        method: 'POST', body: JSON.stringify({ card_id: 'mtg-route-card', language: 'Japanese', game: 'pokemon' })
      });
      assert.strictEqual(response.status, 200, `recommend returned ${response.status}`);
      const body = await response.json();
      assert.ok(!body.rejected, 'recommend must canonicalize language before rules');
      assert.ok(body.compartment_id, 'recommend must return a compartment');
    });

    await check(6, async () => {
      const response = await request('/api/stats');
      assert.strictEqual(response.status, 200, `stats returned ${response.status}`);
      const body = await response.json();
      assert.ok(body.topValuable.length > 0 && body.recentAdditions.length > 0, 'stats fixtures must produce card rows');
      assert.ok(body.topValuable.every(card => card.game === 'mtg'), 'topValuable cards must synthesize game=mtg');
      assert.ok(body.recentAdditions.every(card => card.game === 'mtg'), 'recentAdditions cards must synthesize game=mtg');
    });

    await check(7, async () => {
      const response = await request('/api/admin/seed-cards', { method: 'POST', body: '{}' });
      assert.strictEqual(response.status, 200, `${response.status}: ${await response.text()}`);
      const nonEnglish = await db.get(`SELECT COUNT(*) AS count FROM collection WHERE user_id = ? AND language <> 'English'`, [adminId]);
      assert.strictEqual(nonEnglish.count, 0, 'admin seed must never persist Japanese');
    });

    const legacyBatchEntry = await db.run(
      `INSERT INTO collection (card_id, user_id, language) VALUES ('mtg-route-card', ?, 'Japanese')`,
      [adminId]
    );
    await check(8, async () => {
      const response = await request(`/api/locations/${ruledLocation.lastID}/recommend-batch`, {
        method: 'POST', body: JSON.stringify({ entry_ids: [legacyBatchEntry.lastID] })
      });
      assert.strictEqual(response.status, 200, `batch recommendation returned ${response.status}`);
      const body = await response.json();
      assert.strictEqual(body[0].entry.language, 'English');
      assert.ok(body[0].recommended?.compartment_id, 'batch recommendation must canonicalize legacy language before rules/sort');
    });

    const legacyBulkMoveEntry = await db.run(
      `INSERT INTO collection (card_id, user_id, language) VALUES ('mtg-route-card', ?, 'Japanese')`,
      [adminId]
    );
    await check(9, async () => {
      const response = await request('/api/collection/bulk', {
        method: 'POST', body: JSON.stringify({ entry_ids: [legacyBulkMoveEntry.lastID], action: 'move', value: ruledLocation.lastID })
      });
      assert.strictEqual(response.status, 200, `bulk move returned ${response.status}`);
      const row = await db.get(`SELECT language, location_id, compartment_id FROM collection WHERE id = ?`, [legacyBulkMoveEntry.lastID]);
      assert.strictEqual(row.language, 'English');
      assert.strictEqual(row.location_id, ruledLocation.lastID, 'bulk move must canonicalize before placement rules');
      assert.ok(row.compartment_id, 'bulk move must receive a compartment');
    });

    await check(10, async () => {
      const response = await request('/api/collection', {
        method: 'POST', body: JSON.stringify({ card_id: 'mtg-jp123', language: 'English' })
      });
      assert.strictEqual(response.status, 400, `foreign printing should be rejected, got ${response.status}`);
      const cached = await db.get(`SELECT id FROM card_cache WHERE id = 'mtg-jp123'`);
      const collected = await db.get(`SELECT id FROM collection WHERE card_id = 'mtg-jp123'`);
      assert.strictEqual(cached, undefined, 'foreign printing must not be cached as English');
      assert.strictEqual(collected, undefined, 'foreign printing must not be collected as English');
    });

    await db.run(`INSERT INTO sets (id, name, release_date) VALUES ('mtg-lea', 'Limited Edition Alpha', '1993-08-05')`);
    await check(11, async () => {
      const response = await request('/api/admin/sets-browse?game=pokemon&lang=ja');
      assert.strictEqual(response.status, 200);
      const body = await response.json();
      const alpha = body.find(set => set.name === 'Limited Edition Alpha');
      assert.strictEqual(alpha.id, 'lea', 'legacy Pokémon modal needs a bare MTG code to submit');
      assert.strictEqual(alpha.game, 'mtg');
    });

    for (const suffix of ['desc.bin', 'kp.bin']) {
      fs.writeFileSync(path.join(tmpSetsDir, `mtg-lea-orb-${suffix}`), '');
    }
    fs.writeFileSync(path.join(tmpSetsDir, 'mtg-lea-orb-meta.json'), JSON.stringify({ set: 'lea', lang: 'en', cards: [] }));
    await check(12, async () => {
      const response = await request('/api/admin/set-indexes');
      assert.strictEqual(response.status, 200);
      const body = await response.json();
      assert.ok(body.builds.some(build => build.key === 'mtg|lea|en' && build.game === 'mtg'), 'canonical build must remain visible');
      assert.ok(body.builds.some(build => build.key === 'pokemon|lea|en' && build.game === '__compat'), 'hidden legacy alias must let the unchanged modal converge');
    });

    if (failures.length) throw new Error(`Expected blocker failures:\n${failures.join('\n')}`);
  } finally {
    try { server.kill('SIGKILL'); } catch {}
    try { await new Promise(resolve => db.dbConnection.close(() => resolve())); } catch {}
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch {} }
    try { fs.rmSync(tmpSetsDir, { recursive: true, force: true }); } catch {}
  }
}

runTests().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
