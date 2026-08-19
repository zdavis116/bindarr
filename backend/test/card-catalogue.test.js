// Behaviour tests for the nightly card catalogue refresh (PR 6H).
//
// These drive the REAL refreshCatalogue() against a REAL SQLite database and
// assert on real rows. Only the network is stubbed: axios is intercepted so the
// bulk index and the bulk file itself are served from local fixtures. Nothing
// here downloads hundreds of megabytes or touches api.scryfall.com.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const tmpDb = path.join(os.tmpdir(), `bindarr-catalogue-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const axios = require('axios');
const db = require('../src/db');

// --- Network stub -------------------------------------------------------------

const BULK_INDEX_URL = 'https://api.scryfall.com/bulk-data';
const BULK_FILE_URL = 'https://data.scryfall.io/default-cards/test-fixture.jsonl.gz';

// What the stub should do on the next bulk-file request. Tests flip this to
// exercise the failure paths.
let downloadBehaviour = 'ok';
let publishedBuild = '2026-08-18T21:05:55.920+00:00';
let fixtureCards = [];

const originalGet = axios.get;

function card(overrides = {}) {
  return {
    object: 'card',
    id: overrides.id || '00000000-0000-4000-8000-00000000aaaa',
    oracle_id: overrides.oracle_id || '10000000-0000-4000-8000-00000000aaaa',
    lang: 'en',
    name: 'Fixture Card',
    layout: 'normal',
    set: 'tst',
    set_name: 'Test Set',
    set_type: 'expansion',
    collector_number: '1',
    rarity: 'rare',
    cmc: 2,
    colors: ['G'],
    color_identity: ['G'],
    type_line: 'Creature — Fixture',
    oracle_text: 'Fixture text.',
    mana_cost: '{1}{G}',
    keywords: [],
    legalities: { commander: 'legal' },
    finishes: ['nonfoil'],
    image_uris: { normal: 'https://example.invalid/card.jpg' },
    prices: { usd: '1.50', usd_foil: '3.00' },
    purchase_uris: {},
    ...overrides,
  };
}

function gzippedJsonl(cards) {
  return zlib.gzipSync(Buffer.from(cards.map((c) => JSON.stringify(c)).join('\n'), 'utf8'));
}

axios.get = async function stubbedGet(url, config) {
  if (url === BULK_INDEX_URL) {
    return {
      data: {
        object: 'list',
        data: [
          { object: 'bulk_data', type: 'oracle_cards', updated_at: publishedBuild, jsonl_download_uri: 'https://example.invalid/oracle.jsonl.gz' },
          {
            object: 'bulk_data',
            type: 'default_cards',
            updated_at: publishedBuild,
            jsonl_download_uri: BULK_FILE_URL,
            compressed_size: 1234,
          },
        ],
      },
    };
  }

  if (url === BULK_FILE_URL) {
    if (downloadBehaviour === 'network_error') {
      throw new Error('socket hang up');
    }
    if (downloadBehaviour === 'truncated') {
      // A transfer that dies partway: one complete row, then a half-written one.
      //
      // The complete row is deliberately a card NOT already in the cache. If it
      // were an existing card, an implementation that wrote rows as it read them
      // would still leave card_cache looking unchanged, and the test would pass
      // while proving nothing.
      const good = JSON.stringify(TRUNCATED_LEAD_CARD);
      const body = zlib.gzipSync(Buffer.from(`${good}\n{"object":"card","id":"broke`, 'utf8'));
      return { data: Readable.from([body]) };
    }
    if (downloadBehaviour === 'empty') {
      return { data: Readable.from([zlib.gzipSync(Buffer.from('', 'utf8'))]) };
    }
    return { data: Readable.from([gzippedJsonl(fixtureCards)]) };
  }

  return originalGet.call(this, url, config);
};

// scryfallApi is required by cardCatalogue; it must not reach the network
// during these tests. It only does so via the stubbed axios above.
const { refreshCatalogue, isWantedCard, STAGING_TABLE } = require('../src/cardCatalogue');

// --- Helpers ------------------------------------------------------------------

// Silence the module's progress logging while still capturing it, so the tests
// can assert that a failure actually SAYS the cache is intact.
function captureLog() {
  const lines = [];
  const record = (...args) => lines.push(args.join(' '));
  return { log: record, warn: record, error: record, lines };
}

async function cardCount() {
  return (await db.get(`SELECT COUNT(*) AS count FROM card_cache`)).count;
}

async function tableExists(name) {
  const row = await db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]);
  return Boolean(row);
}

async function cleanup() {
  await db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* best effort */ }
  }
}

const CARD_A = card({ id: '00000000-0000-4000-8000-0000000000a1', oracle_id: '10000000-0000-4000-8000-0000000000a1', name: 'Alpha Fixture', collector_number: '1' });
const CARD_B = card({ id: '00000000-0000-4000-8000-0000000000b2', oracle_id: '10000000-0000-4000-8000-0000000000b2', name: 'Beta Fixture', collector_number: '2' });

// The one complete row inside the truncated download. Never present in the
// cache beforehand, so if any part of a failed refresh reached card_cache this
// row would show up and the intactness assertion would fail.
const TRUNCATED_LEAD_CARD = card({
  id: '00000000-0000-4000-8000-0000000000f6',
  oracle_id: '10000000-0000-4000-8000-0000000000f6',
  name: 'Never Committed Fixture',
  collector_number: '99',
});

let passed = 0;
function pass(id, message) {
  passed++;
  console.log(`PASS: ${id} — ${message}`);
}

// --- Tests --------------------------------------------------------------------

async function run() {
  await db.initDb();

  // --- TC1: a successful refresh populates card_cache -------------------------
  fixtureCards = [CARD_A, CARD_B];
  downloadBehaviour = 'ok';
  let result = await refreshCatalogue({ log: captureLog() });

  assert.strictEqual(result.skipped, false, 'first refresh must not be skipped');
  assert.strictEqual(result.imported, 2, 'both fixture cards must be imported');
  assert.strictEqual(await cardCount(), 2, 'card_cache must hold both cards');

  const alpha = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [CARD_A.id]);
  assert.strictEqual(alpha.name, 'Alpha Fixture', 'imported row must carry real card data');
  assert.strictEqual(alpha.set_id, 'tst', 'imported row must carry its set');
  assert.strictEqual(JSON.parse(alpha.color_identity).join(''), 'Green', 'colour identity must be normalized and stored');
  assert.ok(alpha.oracle_id, 'imported row must carry an oracle identity');
  pass('F6H-TC1', 'a successful refresh populates card_cache from the bulk file');

  // --- TC2: running it twice is idempotent -----------------------------------
  // Forced, so it genuinely re-imports rather than taking the skip path.
  result = await refreshCatalogue({ force: true, log: captureLog() });
  assert.strictEqual(result.imported, 2, 'second refresh imports the same cards');
  assert.strictEqual(await cardCount(), 2, 'a second refresh must not duplicate rows');
  pass('F6H-TC2', 'refreshing twice is idempotent — no duplicate rows');

  // --- TC3: an unchanged published build skips the download ------------------
  const skipLog = captureLog();
  result = await refreshCatalogue({ log: skipLog });
  assert.strictEqual(result.skipped, true, 'an unchanged build must skip');
  assert.strictEqual(result.reason, 'already_current');
  assert.strictEqual(await cardCount(), 2, 'skipping must leave the cache alone');
  pass('F6H-TC3', 'an already-current catalogue skips the download (dev and prod do not both pull)');

  // --- TC4: foreign keys from collection and deck_cards survive a refresh ----
  // Build real referencing rows through the real schema, then refresh over them.
  await db.run(`INSERT OR IGNORE INTO users (id, username, password_hash, role, share_token) VALUES (1, 'fixture', 'x', 'admin', 'fixture-token')`);
  await db.run(
    `INSERT INTO collection (card_id, quantity, user_id, list_type) VALUES (?, 1, 1, 'collection')`,
    [CARD_A.id]
  );
  const deck = await db.run(
    `INSERT INTO decks (name, user_id) VALUES ('Fixture Deck', 1)`
  );
  await db.run(
    `INSERT INTO deck_cards (deck_id, oracle_id, desired_card_id, desired_finish, quantity)
     VALUES (?, ?, ?, 'nonfoil', 1)`,
    [deck.lastID, CARD_A.oracle_id, CARD_A.id]
  );

  // Foreign keys are enforced, so this only succeeds if the rows are valid.
  const fkBefore = await db.all(`PRAGMA foreign_key_check`);
  assert.strictEqual(fkBefore.length, 0, 'fixture rows must start with valid foreign keys');

  publishedBuild = '2026-08-19T21:05:55.920+00:00'; // a new build, so it downloads
  await refreshCatalogue({ log: captureLog() });

  const fkAfter = await db.all(`PRAGMA foreign_key_check`);
  assert.strictEqual(fkAfter.length, 0, 'no foreign key may be broken by a refresh');
  const collectionRow = await db.get(`SELECT * FROM collection WHERE card_id = ?`, [CARD_A.id]);
  assert.ok(collectionRow, 'the collection row must still reference its card');
  const deckRow = await db.get(`SELECT * FROM deck_cards WHERE desired_card_id = ?`, [CARD_A.id]);
  assert.ok(deckRow, 'the deck row must still reference its card');
  pass('F6H-TC4', 'foreign keys from collection and deck_cards survive a refresh');

  // --- TC5: a refresh that fails partway leaves the cache completely intact --
  const beforeFailure = await db.all(`SELECT * FROM card_cache ORDER BY id`);
  publishedBuild = '2026-08-20T00:00:00.000+00:00';
  downloadBehaviour = 'truncated';
  const failLog = captureLog();

  await assert.rejects(
    () => refreshCatalogue({ log: failLog }),
    /Malformed card data/,
    'a truncated download must fail loudly, not import what it managed to read'
  );

  const afterFailure = await db.all(`SELECT * FROM card_cache ORDER BY id`);
  assert.deepStrictEqual(afterFailure, beforeFailure, 'a failed refresh must leave card_cache byte-identical');
  assert.ok(
    failLog.lines.some((line) => /unchanged/i.test(line) && /FAILED/i.test(line)),
    'the failure must SAY the existing cache is unchanged'
  );
  assert.strictEqual(await tableExists(STAGING_TABLE), false, 'staging scratch must be cleaned up after a failure');

  // The failed build must NOT be recorded, or the next run would skip it.
  const settings = await db.get(`SELECT card_catalogue_updated_at FROM app_settings WHERE id = 1`);
  assert.notStrictEqual(settings.card_catalogue_updated_at, publishedBuild,
    'a failed refresh must not record its build as imported');
  pass('F6H-TC5', 'a refresh that fails partway leaves the previous cache completely intact and reports it');

  // --- TC6: a network failure before any data is read is equally safe -------
  downloadBehaviour = 'network_error';
  await assert.rejects(() => refreshCatalogue({ log: captureLog() }), /socket hang up/);
  assert.deepStrictEqual(
    await db.all(`SELECT * FROM card_cache ORDER BY id`), beforeFailure,
    'a network failure must leave card_cache untouched'
  );

  // An empty bulk file is never legitimate and must not blank the catalogue.
  downloadBehaviour = 'empty';
  await assert.rejects(() => refreshCatalogue({ log: captureLog() }), /no usable cards/);
  assert.strictEqual(await cardCount(), beforeFailure.length,
    'an empty bulk file must not empty the catalogue');
  pass('F6H-TC6', 'network failure and an empty bulk file both leave the catalogue intact');

  // --- TC7: a colour-identity correction on a deck card is logged, not silent -
  downloadBehaviour = 'ok';
  publishedBuild = '2026-08-21T00:00:00.000+00:00';
  // CARD_A is in a deck (TC4). Scryfall now reports it as white, not green —
  // i.e. it is correcting its own earlier data error.
  fixtureCards = [
    { ...CARD_A, colors: ['W'], color_identity: ['W'] },
    CARD_B,
  ];
  const correctionLog = captureLog();
  result = await refreshCatalogue({ log: correctionLog });

  assert.strictEqual(result.corrections.length, 1, 'the changed colour identity must be reported');
  assert.strictEqual(result.corrections[0].id, CARD_A.id);
  assert.ok(
    correctionLog.lines.some((line) => /colour identity/i.test(line) && /Alpha Fixture/.test(line)),
    'the correction must be logged by name'
  );
  assert.ok(
    correctionLog.lines.some((line) => /Nothing was removed/i.test(line)),
    'the log must state that nothing was removed from the deck'
  );

  // The card is still in the deck. Never auto-removed.
  const deckStillThere = await db.get(`SELECT * FROM deck_cards WHERE desired_card_id = ?`, [CARD_A.id]);
  assert.ok(deckStillThere, 'a colour-identity correction must never remove a card from a deck');
  pass('F6H-TC7', 'a colour-identity correction on a deck card is logged and the card is left in place');

  // --- TC8: the refresh is safe to run while the app is serving requests ----
  // Interleave ordinary reads and writes with a refresh, the way a live server
  // would. All of them must succeed: the refresh must not lock anyone out or
  // leave the catalogue visibly empty at any point.
  publishedBuild = '2026-08-22T00:00:00.000+00:00';
  fixtureCards = [CARD_A, CARD_B, card({
    id: '00000000-0000-4000-8000-0000000000c3',
    oracle_id: '10000000-0000-4000-8000-0000000000c3',
    name: 'Gamma Fixture',
    collector_number: '3',
  })];

  const observedCounts = [];
  const concurrentReads = (async () => {
    for (let i = 0; i < 25; i++) {
      const row = await db.get(`SELECT COUNT(*) AS count FROM card_cache`);
      observedCounts.push(row.count);
      // A real request also reads a specific card and its collection join.
      await db.get(
        `SELECT cc.name FROM collection c JOIN card_cache cc ON c.card_id = cc.id WHERE c.card_id = ?`,
        [CARD_A.id]
      );
    }
  })();

  const [refreshResult] = await Promise.all([
    refreshCatalogue({ log: captureLog() }),
    concurrentReads,
  ]);

  assert.strictEqual(refreshResult.imported, 3, 'the refresh must complete alongside live traffic');
  assert.ok(observedCounts.length > 0, 'concurrent reads must have run');
  assert.ok(
    observedCounts.every((count) => count >= 2),
    `card_cache must never be observed empty or shrunken during a refresh (saw ${observedCounts.join(',')})`
  );
  assert.strictEqual(await cardCount(), 3, 'the new card must be present afterwards');
  pass('F6H-TC8', 'the refresh is safe to run while the app is serving requests');

  // --- TC9: scope filtering keeps the catalogue MTG-only and English-only ---
  assert.strictEqual(isWantedCard(card()), true, 'an ordinary English card is wanted');
  assert.strictEqual(isWantedCard(card({ lang: 'ja' })), false, 'non-English printings are excluded');
  assert.strictEqual(isWantedCard(card({ layout: 'token' })), false, 'tokens are excluded');
  assert.strictEqual(isWantedCard(card({ layout: 'art_series' })), false, 'art series are excluded');
  assert.strictEqual(isWantedCard(card({ set_type: 'memorabilia' })), false, 'memorabilia are excluded');
  assert.strictEqual(isWantedCard(card({ oracle_id: undefined })), false, 'cards without an oracle identity are excluded');

  // And the filter is actually applied by the real import path.
  publishedBuild = '2026-08-23T00:00:00.000+00:00';
  fixtureCards = [
    CARD_A,
    { ...CARD_B, lang: 'ja', id: '00000000-0000-4000-8000-0000000000d4' },
    card({ id: '00000000-0000-4000-8000-0000000000e5', oracle_id: '10000000-0000-4000-8000-0000000000e5', layout: 'token' }),
  ];
  result = await refreshCatalogue({ log: captureLog() });
  assert.strictEqual(result.imported, 1, 'only the English non-token card may be imported');
  assert.strictEqual(result.ignored, 2, 'the excluded rows must be counted as ignored');
  const japanese = await db.get(`SELECT id FROM card_cache WHERE id = ?`, ['00000000-0000-4000-8000-0000000000d4']);
  assert.strictEqual(japanese, undefined, 'a Japanese printing must never enter the catalogue');
  pass('F6H-TC9', 'the catalogue stays MTG-only and English-only');

  console.log(`\nAll ${passed} card catalogue behaviour tests passed.`);
}

run()
  .then(cleanup)
  .catch(async (error) => {
    console.error('FAIL: card catalogue behaviour tests —', error.message);
    console.error(error.stack);
    await cleanup();
    process.exit(1);
  });
