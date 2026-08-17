const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createFreshDatabase } = require('./helpers/freshDatabase');

const BACKEND_ROOT = path.join(__dirname, '..');

function sourceFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(fullPath));
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

async function columnNames(db, table) {
  return (await db.all(`PRAGMA table_info(${table})`)).map((column) => column.name);
}

async function main() {
  const fixture = await createFreshDatabase();
  try {
    for (const table of ['sets', 'card_cache', 'collection']) {
      const columns = await columnNames(fixture, table);
      assert.ok(!columns.includes('game'), `${table}.game must not exist in the MTG-only schema`);
    }

    const removedCompatibilityColumns = {
      decks: ['game'],
      locations: ['game'],
      users: ['tcg_api_key'],
      collection: ['language'],
      card_cache: ['language', 'printed_name']
    };
    for (const [table, removedColumns] of Object.entries(removedCompatibilityColumns)) {
      const columns = await columnNames(fixture, table);
      for (const column of removedColumns) {
        assert.ok(!columns.includes(column), `${table}.${column} must not exist in the final MTG-only schema`);
      }
    }

    const settingsColumns = await columnNames(fixture, 'app_settings');
    assert.ok(settingsColumns.includes('mtg_prices_swept_at'));
    assert.ok(!settingsColumns.includes('pokemon_prices_swept_at'));
    assert.ok(!settingsColumns.includes('tcgdex_prices_swept_at'));

    assert.ok(!fs.existsSync(path.join(BACKEND_ROOT, 'src', 'tcgApi.js')));
    assert.ok(!fs.existsSync(path.join(BACKEND_ROOT, 'src', 'tcgdexApi.js')));

    const runtimeRoots = [path.join(BACKEND_ROOT, 'src'), path.join(BACKEND_ROOT, 'scripts')];
    const forbidden = [
      ['Pokémon TCG provider URL', /pokemontcg\.io/i],
      ['TCGdex runtime reference', /tcgdex/i],
      ['Pokémon provider API key', /POKEMON_TCG_API_KEY/i],
      ['Pokémon schema default', /DEFAULT\s+['"]?pokemon['"]?/i]
    ];

    for (const file of runtimeRoots.flatMap(sourceFiles)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const [description, pattern] of forbidden) {
        assert.ok(!pattern.test(source), `${description} remains in ${path.relative(BACKEND_ROOT, file)}`);
      }
    }

    assert.deepStrictEqual(await fixture.all('PRAGMA foreign_key_check'), []);
    assert.strictEqual((await fixture.get('PRAGMA quick_check')).quick_check, 'ok');

    console.log('mtg-only-boundary.test.js: backend runtime and fresh schema are MTG-only');
  } finally {
    await fixture.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
