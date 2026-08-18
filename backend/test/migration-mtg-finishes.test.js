// PR 6E: the UPGRADE path for the MTG finishes schema sweep.
//
// Why this file exists
// --------------------
// The Pokemon->MTG `printing` CHECK migration shipped green: 117 cases across
// 10 suites all passed. Every one of them built a FRESH database, and a fresh
// database gets the corrected CHECK straight from CREATE TABLE -- so not one
// test ever executed the migration. Run against a real database that still had
// the legacy schema, initDb() threw SQLITE_CONSTRAINT and the server, which
// awaits initDb() at startup, did not boot at all.
//
// A migration is code. Untested code that only runs on real user data is the
// worst possible combination, so this suite exercises the REAL startup path
// (db.initDb()) against a database built with the LEGACY schema, and asserts on
// database state afterwards -- never merely on the absence of an exception.
//
// Isolation note: db.js resolves its path from process.env.DB_PATH at REQUIRE
// time and holds one process-wide connection. Each case therefore runs the
// migration in a CHILD process with its own DB_PATH, which is also the only
// honest way to test "start the server a second time" idempotence.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const LEGACY_PRINTING_CHECK =
  "printing IN ('Normal', 'Holofoil', 'Reverse Holofoil', '1st Edition', 'Promo')";

// The collection table as it existed BEFORE the finish work: Pokemon-era CHECK,
// no `finish` column, no user_id/notes/etc. The later ALTER-based migrations in
// initDb() are expected to add those, so seeding them here would test a
// database that never existed.
const LEGACY_COLLECTION_SQL = `
  CREATE TABLE collection (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    condition TEXT CHECK(condition IN ('Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged')) DEFAULT 'Near Mint',
    printing TEXT CHECK(${LEGACY_PRINTING_CHECK}) DEFAULT 'Normal',
    purchase_price REAL,
    location_id INTEGER,
    compartment_id INTEGER,
    position REAL DEFAULT 0,
    favorite INTEGER DEFAULT 0,
    is_trade INTEGER DEFAULT 0,
    list_type TEXT DEFAULT 'collection',
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

// (printing, quantity). Includes a Holofoil row -- the value that must survive
// as 'Foil' -- several multi-copy Normal rows so a quantity total can be
// compared, and Pokemon-only values that an MTG card cannot physically have.
const SEED_ROWS = [
  ['Holofoil', 3],
  ['Normal', 4],
  ['Normal', 2],
  ['Reverse Holofoil', 5],
  ['1st Edition', 1],
  ['Promo', 2],
  [null, 6]
];
const SEED_ROW_COUNT = SEED_ROWS.length;
const SEED_QUANTITY_TOTAL = SEED_ROWS.reduce((sum, [, qty]) => sum + qty, 0);

function open(dbPath) {
  return new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(dbPath, (error) => error ? reject(error) : resolve(connection));
  });
}

function query(connection, method, sql, params = []) {
  return new Promise((resolve, reject) => {
    connection[method](sql, params, function callback(error, result) {
      if (error) reject(error);
      else if (method === 'run') resolve({ lastID: this.lastID, changes: this.changes });
      else resolve(result);
    });
  });
}

function close(connection) {
  return new Promise((resolve, reject) => {
    connection.close((error) => error ? reject(error) : resolve());
  });
}

// A database carrying the legacy schema and legacy data, ready for initDb().
async function seedLegacyDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-legacy-db-'));
  const dbPath = path.join(directory, 'bindarr.db');
  const connection = await open(dbPath);
  await query(connection, 'run', LEGACY_COLLECTION_SQL);
  for (const [printing, quantity] of SEED_ROWS) {
    await query(
      connection,
      'run',
      `INSERT INTO collection (card_id, printing, quantity) VALUES (?, ?, ?)`,
      [`card-${printing || 'null'}-${quantity}`, printing, quantity]
    );
  }
  await close(connection);
  return { directory, dbPath };
}

// Run the REAL startup path in a child process, exactly as server.js does.
// `corrupt` arms the gated test hook that makes the copy come out short, which
// is the only way to reach the verification-failure branch: SQLite raises on a
// bad INSERT..SELECT rather than silently dropping rows, so the mismatch the
// guard defends against has to be injected on purpose.
const DB_MODULE = JSON.stringify(path.join(__dirname, '..', 'src', 'db'));
const RUNNER = `
  const db = require(${DB_MODULE});
  if (process.env.CORRUPT_COPY === '1') db.testHooks.corruptNextCollectionMigrationCopy();
  db.initDb()
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch(async (error) => {
      console.error('INIT ERR: ' + (error && error.message));
      try { await db.close(); } catch {}
      process.exit(1);
    });
`;

function runInitDb(dbPath, { corrupt = false } = {}) {
  const result = spawnSync(process.execPath, ['-e', RUNNER], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      DEFAULT_ADMIN_PASSWORD: 'fixture-admin-password',
      BINDARR_DB_TEST_HOOKS: '1',
      CORRUPT_COPY: corrupt ? '1' : '0'
    }
  });
  return {
    ok: !result.error && !result.signal && result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

// Snapshot enough of the collection to prove nothing moved.
async function snapshotCollection(dbPath) {
  const connection = await open(dbPath);
  try {
    const schema = await query(
      connection,
      'get',
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'collection'`
    );
    const rows = await query(
      connection,
      'all',
      `SELECT id, card_id, printing, quantity FROM collection ORDER BY id`
    );
    const totals = await query(
      connection,
      'get',
      `SELECT COUNT(*) AS rows, COALESCE(SUM(quantity), 0) AS quantity FROM collection`
    );
    const leftovers = await query(
      connection,
      'all',
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('collection_new', 'collection_legacy_printing')`
    );
    return { schemaSql: schema && schema.sql, rows, totals, leftovers };
  } finally {
    await close(connection);
  }
}

function cleanup(fixture) {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

const tests = [];
function test(id, name, fn) { tests.push({ id, name, fn }); }

// ---------------------------------------------------------------------------
// M1: the bug itself. initDb() against a legacy database must COMPLETE, and the
// data must come out translated rather than merely un-crashed.
test('M1', 'legacy database migrates: Holofoil -> Foil/foil, others -> Normal/nonfoil', async () => {
  const fixture = await seedLegacyDatabase();
  try {
    const before = await snapshotCollection(fixture.dbPath);
    assert.ok(
      before.schemaSql.includes("'Holofoil'"),
      'fixture must start on the legacy Pokemon CHECK, otherwise this test proves nothing'
    );

    const run = runInitDb(fixture.dbPath);
    assert.ok(run.ok, `initDb() must succeed against a legacy database.\n${run.stderr}`);

    const after = await snapshotCollection(fixture.dbPath);

    // The constraint is now the MTG vocabulary.
    assert.ok(
      after.schemaSql.includes("printing IN ('Normal', 'Foil', 'Etched')"),
      `printing CHECK must be the MTG vocabulary, got: ${after.schemaSql}`
    );
    assert.ok(!after.schemaSql.includes("'Holofoil'"), 'no Pokemon value may remain in the CHECK');

    // Nothing gained, nothing lost -- rows AND copies.
    assert.strictEqual(after.totals.rows, SEED_ROW_COUNT, 'row count must be unchanged');
    assert.strictEqual(after.totals.quantity, SEED_QUANTITY_TOTAL, 'total copies must be unchanged');

    // The scratch table must not survive the migration.
    assert.deepStrictEqual(after.leftovers, [], 'migration must not leave a legacy table behind');

    // Rebuilding a table is where foreign keys get silently repointed: SQLite
    // rewrites REFERENCES clauses in OTHER tables to follow a rename. Both
    // tables that point at collection must still point at `collection`, not at
    // a scratch name that no longer exists.
    const referrers = await (async () => {
      const connection = await open(fixture.dbPath);
      try {
        return await query(connection, 'all',
          `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('collection_tags', 'deck_card_allocations')`);
      } finally { await close(connection); }
    })();
    assert.strictEqual(referrers.length, 2, 'both collection-referencing tables must exist after the rebuild');
    for (const table of referrers) {
      assert.ok(
        !/REFERENCES\s+"?collection_(new|legacy_printing)"?/i.test(table.sql),
        `${table.name} must still reference collection, not a scratch table: ${table.sql}`
      );
      assert.ok(
        /REFERENCES\s+"?collection"?\s*\(/i.test(table.sql),
        `${table.name} must reference collection: ${table.sql}`
      );
    }

    const detailed = await (async () => {
      const connection = await open(fixture.dbPath);
      try {
        return await query(connection, 'all', `SELECT card_id, printing, finish, quantity FROM collection ORDER BY id`);
      } finally { await close(connection); }
    })();

    const holo = detailed.find(r => r.card_id === 'card-Holofoil-3');
    assert.ok(holo, 'the Holofoil row must still exist');
    assert.strictEqual(holo.printing, 'Foil', 'Holofoil was this fork\'s only foil value; it must become Foil');
    assert.strictEqual(holo.finish, 'foil', 'canonical finish must be derived from the migrated display value');
    assert.strictEqual(holo.quantity, 3, 'quantity must not be disturbed by the finish translation');

    for (const cardId of ['card-Normal-4', 'card-Normal-2']) {
      const row = detailed.find(r => r.card_id === cardId);
      assert.ok(row, `${cardId} must still exist`);
      assert.strictEqual(row.printing, 'Normal', `${cardId} must stay Normal`);
      assert.strictEqual(row.finish, 'nonfoil', `${cardId} must be canonically nonfoil`);
    }

    // Pokemon-only concepts an MTG card cannot have collapse to Normal/nonfoil.
    for (const cardId of ['card-Reverse Holofoil-5', 'card-1st Edition-1', 'card-Promo-2', 'card-null-6']) {
      const row = detailed.find(r => r.card_id === cardId);
      assert.ok(row, `${cardId} must still exist`);
      assert.strictEqual(row.printing, 'Normal', `${cardId} has no MTG meaning and must become Normal`);
      assert.strictEqual(row.finish, 'nonfoil', `${cardId} must be canonically nonfoil`);
    }

    // Identity preserved: same ids, same quantities, same cards.
    assert.deepStrictEqual(
      after.rows.map(r => [r.id, r.card_id, r.quantity]),
      before.rows.map(r => [r.id, r.card_id, r.quantity]),
      'row identity and quantities must survive the rebuild'
    );

    // And the migrated table must actually ACCEPT a foil write -- the original
    // symptom was a 500 on every foil add.
    const connection = await open(fixture.dbPath);
    try {
      await query(connection, 'run',
        `INSERT INTO collection (card_id, printing, finish, quantity) VALUES ('post-migration-foil', 'Foil', 'foil', 1)`);
    } finally { await close(connection); }
  } finally {
    cleanup(fixture);
  }
});

// ---------------------------------------------------------------------------
// M2: idempotence. Restarting the server must not re-run the rebuild, and must
// certainly not error. A migration that only survives its first run turns every
// restart into a coin flip.
test('M2', 'running initDb() again against a migrated database is a no-op', async () => {
  const fixture = await seedLegacyDatabase();
  try {
    assert.ok(runInitDb(fixture.dbPath).ok, 'first initDb() must migrate successfully');
    const afterFirst = await snapshotCollection(fixture.dbPath);

    const second = runInitDb(fixture.dbPath);
    assert.ok(second.ok, `second initDb() must succeed.\n${second.stderr}`);
    assert.ok(
      !second.stdout.includes('Migrating collection.printing'),
      'the migration must not run a second time'
    );

    const afterSecond = await snapshotCollection(fixture.dbPath);
    assert.deepStrictEqual(afterSecond, afterFirst, 'a second startup must change nothing');
  } finally {
    cleanup(fixture);
  }
});

// ---------------------------------------------------------------------------
// M3: failure leaves the database exactly as it was.
//
// The verification step exists to refuse a partial migration. A guard that has
// never been seen failing is only a guess, so this arms the gated test hook
// that makes the copy come out one row short. Everything downstream is the REAL
// code: the real comparison detects it, the real ROLLBACK recovers, and the
// assertions below read the actual file afterwards.
test('M3', 'a copy that loses rows rolls back and leaves the database untouched', async () => {
  const fixture = await seedLegacyDatabase();
  try {
    const before = await snapshotCollection(fixture.dbPath);

    const run = runInitDb(fixture.dbPath, { corrupt: true });
    assert.ok(!run.ok, 'a migration that loses a row must FAIL rather than commit a short collection');
    assert.ok(
      /lost rows|lost copies/.test(run.stderr),
      `failure must name the verification that caught it, got: ${run.stderr}`
    );

    const after = await snapshotCollection(fixture.dbPath);
    assert.strictEqual(after.totals.rows, SEED_ROW_COUNT, 'no row may be lost by a failed migration');
    assert.strictEqual(after.totals.quantity, SEED_QUANTITY_TOTAL, 'no copy may be lost by a failed migration');
    assert.ok(after.schemaSql.includes("'Holofoil'"), 'the original legacy table must still be in place');
    assert.deepStrictEqual(after.rows, before.rows, 'every row must be identical after a rollback');
    assert.deepStrictEqual(after.leftovers, [], 'a rolled-back migration must not leave a scratch table behind');

    // And the failure must be recoverable: with the fault removed, a normal
    // restart migrates cleanly. A rollback that wedges the database forever
    // would be no better than the corruption it prevented.
    assert.ok(runInitDb(fixture.dbPath).ok, 'a retry after a rolled-back migration must succeed');
    const recovered = await snapshotCollection(fixture.dbPath);
    assert.strictEqual(recovered.totals.rows, SEED_ROW_COUNT);
    assert.strictEqual(recovered.totals.quantity, SEED_QUANTITY_TOTAL);
    assert.ok(recovered.schemaSql.includes("printing IN ('Normal', 'Foil', 'Etched')"));
  } finally {
    cleanup(fixture);
  }
});

async function main() {
  let failed = 0;
  for (const { id, name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS: F6E-TC${id.slice(1)} ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL: F6E-TC${id.slice(1)} ${name}`);
      console.error(error);
    }
  }
  console.log(`migration-mtg-finishes.test.js: ${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
