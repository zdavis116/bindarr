const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `bindarr-oracle-cache-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const { normalizeCard } = require('../src/scryfallApi');
const { cacheNormalizedCards } = require('../src/utils/cardCache');
const { parseCardRow } = require('../src/utils/priceHelpers');

async function cleanup() {
  await new Promise((resolve) => db.dbConnection.close(() => resolve()));
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch {}
  }
}

async function run() {
  try {
    await db.initDb();

    const columnInfo = await db.all(`PRAGMA table_info(card_cache)`);
    const columns = columnInfo.map((column) => column.name);
    for (const required of [
      'oracle_id', 'oracle_name', 'mana_cost', 'oracle_text', 'type_line',
      'keywords', 'legalities', 'finishes', 'layout'
    ]) {
      assert.ok(columns.includes(required), `card_cache must include ${required}`);
    }
    assert.strictEqual(
      columnInfo.find((column) => column.name === 'oracle_id').notnull,
      1,
      'card_cache.oracle_id must be required'
    );

    const indexes = await db.all(`PRAGMA index_list(card_cache)`);
    assert.ok(indexes.some((index) => index.name === 'idx_card_cache_oracle'),
      'card_cache must index oracle_id');

    console.log('PASS: fresh card_cache is Oracle-aware');

    assert.throws(
      () => normalizeCard({ id: 'printing-without-oracle-id', name: 'Nameless Card' }),
      /Oracle identity.*required/i,
      'normalization must explicitly reject cards without an Oracle identity'
    );

    console.log('PASS: normalization rejects missing Oracle identity explicitly');

    const raw = {
      id: 'f7d5b2a1-4f25-4d7b-9c84-30eced9829a5',
      oracle_id: 'c1d2f6fb-73d4-4c74-97e6-5ca63d44a529',
      name: 'Sol Ring',
      mana_cost: '{1}',
      oracle_text: '{T}: Add {C}{C}.',
      type_line: 'Artifact',
      keywords: ['Mana Ability'],
      legalities: { commander: 'legal', standard: 'not_legal' },
      finishes: ['nonfoil', 'foil'],
      layout: 'normal',
      color_identity: [],
      rarity: 'uncommon',
      set: 'cmm',
      set_name: 'Commander Masters',
      collector_number: '396',
      image_uris: { normal: 'https://example.test/sol-ring.jpg' },
      prices: { usd: '1.25', usd_foil: '2.50' }
    };
    const normalized = normalizeCard(raw);

    assert.strictEqual(normalized.id, raw.id, 'card IDs must be raw Scryfall UUIDs');
    assert.strictEqual(normalized.oracle_id, raw.oracle_id);
    assert.strictEqual(normalized.oracle_name, 'Sol Ring');
    assert.strictEqual(normalized.mana_cost, '{1}');
    assert.strictEqual(normalized.oracle_text, '{T}: Add {C}{C}.');
    assert.strictEqual(normalized.type_line, 'Artifact');
    assert.deepStrictEqual(normalized.keywords, ['Mana Ability']);
    assert.deepStrictEqual(normalized.legalities, raw.legalities);
    assert.deepStrictEqual(normalized.finishes, ['nonfoil', 'foil']);
    assert.strictEqual(normalized.layout, 'normal');

    console.log('PASS: Scryfall normalization preserves Oracle metadata and raw UUIDs');

    await cacheNormalizedCards([normalized]);
    const cached = parseCardRow(await db.get(`SELECT * FROM card_cache WHERE id = ?`, [raw.id]));

    assert.strictEqual(cached.oracle_id, raw.oracle_id);
    assert.strictEqual(cached.oracle_name, 'Sol Ring');
    assert.strictEqual(cached.mana_cost, '{1}');
    assert.strictEqual(cached.oracle_text, '{T}: Add {C}{C}.');
    assert.strictEqual(cached.type_line, 'Artifact');
    assert.deepStrictEqual(cached.keywords, ['Mana Ability']);
    assert.deepStrictEqual(cached.legalities, raw.legalities);
    assert.deepStrictEqual(cached.finishes, ['nonfoil', 'foil']);
    assert.strictEqual(cached.layout, 'normal');

    console.log('PASS: Oracle metadata round-trips through card_cache');

    const transformRaw = {
      id: 'a1111111-1111-4111-8111-111111111111',
      oracle_id: 'b2222222-2222-4222-8222-222222222222',
      name: 'Delver of Secrets // Insectile Aberration',
      layout: 'transform',
      keywords: ['Transform'],
      legalities: { commander: 'legal' },
      finishes: ['nonfoil', 'foil'],
      color_identity: ['U'],
      rarity: 'common',
      set: 'isd',
      set_name: 'Innistrad',
      collector_number: '51',
      card_faces: [{
        name: 'Delver of Secrets',
        mana_cost: '{U}',
        oracle_text: 'At the beginning of your upkeep, look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform Delver of Secrets.',
        type_line: 'Creature — Human Wizard',
        image_uris: { normal: 'https://example.test/delver.jpg' }
      }, {
        name: 'Insectile Aberration',
        mana_cost: '',
        oracle_text: 'Flying',
        type_line: 'Creature — Human Insect',
        image_uris: { normal: 'https://example.test/aberration.jpg' }
      }],
      prices: {}
    };
    const transform = normalizeCard(transformRaw);
    const expectedFaceText = [
      '=== Delver of Secrets ===',
      transformRaw.card_faces[0].oracle_text,
      '',
      '=== Insectile Aberration ===',
      transformRaw.card_faces[1].oracle_text
    ].join('\n');

    assert.strictEqual(transform.name, 'Delver of Secrets');
    assert.strictEqual(transform.oracle_name, transformRaw.name);
    assert.strictEqual(transform.mana_cost, '{U} // ');
    assert.strictEqual(transform.oracle_text, expectedFaceText);
    assert.strictEqual(
      transform.type_line,
      'Creature — Human Wizard // Creature — Human Insect'
    );

    await cacheNormalizedCards([transform]);
    const cachedTransform = parseCardRow(await db.get(
      `SELECT * FROM card_cache WHERE id = ?`,
      [transformRaw.id]
    ));
    assert.strictEqual(cachedTransform.name, 'Delver of Secrets');
    assert.strictEqual(cachedTransform.oracle_name, transformRaw.name);
    assert.strictEqual(cachedTransform.mana_cost, '{U} // ');
    assert.strictEqual(cachedTransform.oracle_text, expectedFaceText);
    assert.strictEqual(
      cachedTransform.type_line,
      'Creature — Human Wizard // Creature — Human Insect'
    );

    console.log('PASS: both faces preserve Oracle metadata through card_cache');
  } finally {
    await cleanup();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});