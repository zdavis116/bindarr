const assert = require('assert');
const { createFreshDatabase } = require('./helpers/freshDatabase');

async function main() {
  const fixtures = [];

  try {
    fixtures.push(await createFreshDatabase());
    fixtures.push(await createFreshDatabase());
    const [first, second] = fixtures;

    assert.notStrictEqual(first.directory, second.directory, 'fixtures must use separate temp directories');
    assert.notStrictEqual(first.dbPath, second.dbPath, 'fixtures must use separate database files');

    const schemaSql = `
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE sql IS NOT NULL
      ORDER BY type, name
    `;
    assert.deepStrictEqual(
      await first.all(schemaSql),
      await second.all(schemaSql),
      'fresh databases must initialize with the same schema'
    );

    const tableNames = (await first.all(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `)).map((row) => row.name);
    for (const requiredTable of ['card_cache', 'collection', 'decks', 'locations', 'notes', 'users']) {
      assert.ok(tableNames.includes(requiredTable), `fresh schema must include ${requiredTable}`);
    }

    for (const fixture of [first, second]) {
      for (const table of ['card_cache', 'collection', 'decks', 'notes']) {
        const row = await fixture.get(`SELECT COUNT(*) AS count FROM ${table}`);
        assert.strictEqual(row.count, 0, `${table} must start clean`);
      }
    }

    await first.run(
      `INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)`,
      [1, 'fixture marker', 'only in the first database']
    );
    assert.strictEqual((await first.get(`SELECT COUNT(*) AS count FROM notes`)).count, 1);
    assert.strictEqual(
      (await second.get(`SELECT COUNT(*) AS count FROM notes`)).count,
      0,
      'writes in one fixture must not leak into another'
    );

    console.log('fresh-database.test.js: deterministic, clean, and isolated');
  } finally {
    const cleanupResults = await Promise.allSettled(fixtures.map((fixture) => fixture.cleanup()));
    const cleanupFailure = cleanupResults.find((result) => result.status === 'rejected');
    if (cleanupFailure) throw cleanupFailure.reason;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
