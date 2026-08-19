// PR 6I items 7 and 8 — the catalogue refresh tells the truth about its own
// state, and two refreshes cannot overlap.
//
// WHY THIS SUITE EXISTS, stated plainly because it is the point of the whole
// PR: on 2026-08-19 a refresh on the dev instance printed
//
//   "refresh FAILED (SQLITE_BUSY: database is locked). The existing cache of
//    174 cards is unchanged — no partial catalogue was written."
//
// and the database then held 104,406 complete rows. The import had SUCCEEDED.
// The error handler reported a rollback that never happened, because it
// inferred "error path, therefore nothing committed" instead of checking.
//
// PR 6H's own suite could not have caught this: every failure it exercises
// happens BEFORE the swap, so "unchanged" was true in each case by accident of
// where the failure was injected. The missing case is a failure AFTER a
// successful commit, and that is what F6I-TC1 injects.
//
// Everything drives the REAL refreshCatalogue() against a REAL SQLite database.
// Only the network is stubbed. Assertions are on the ACTUAL ROW COUNT and on
// the WORDS the app printed — never on the fact that a promise rejected, since
// a rejection was never the bug. The bug was what it said while rejecting.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const tmpDb = path.join(os.tmpdir(), `bindarr-pr6i-catalogue-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const axios = require('axios');
const db = require('../src/db');

// --- Network stub -------------------------------------------------------------

const BULK_INDEX_URL = 'https://api.scryfall.com/bulk-data';
const BULK_FILE_URL = 'https://data.scryfall.io/default-cards/pr6i-fixture.jsonl.gz';

let publishedBuild = '2026-08-19T00:00:00.000+00:00';
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
  return zlib.gzipSync(Buffer.from(cards.map(c => JSON.stringify(c)).join('\n'), 'utf8'));
}

axios.get = function stubbedGet(url, config) {
  if (url === BULK_INDEX_URL) {
    return Promise.resolve({
      data: {
        data: [{
          type: 'default_cards',
          updated_at: publishedBuild,
          jsonl_download_uri: BULK_FILE_URL,
          compressed_size: 1234,
        }],
      },
    });
  }
  if (url === BULK_FILE_URL) {
    return Promise.resolve({ data: Readable.from([gzippedJsonl(fixtureCards)]) });
  }
  return originalGet.call(this, url, config);
};

const { refreshCatalogue, readLock, RefreshInProgressError } = require('../src/cardCatalogue');

// --- Helpers ------------------------------------------------------------------

function captureLog() {
  const lines = [];
  const record = (...args) => lines.push(args.join(' '));
  return { log: record, warn: record, error: record, lines };
}

// The ACTUAL number of rows in card_cache. Every claim this suite checks is
// checked against this, not against what the app said about it.
async function cardCount() {
  return (await db.get(`SELECT COUNT(*) AS count FROM card_cache`)).count;
}

function saidSomethingLike(log, pattern) {
  return log.lines.some(line => pattern.test(line));
}

async function cleanup() {
  await db.close().catch(() => {});
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* best effort */ }
  }
}

const CARD_A = card({ id: '00000000-0000-4000-8000-0000000000a1', oracle_id: '10000000-0000-4000-8000-0000000000a1', name: 'Alpha PR6I', collector_number: '1' });
const CARD_B = card({ id: '00000000-0000-4000-8000-0000000000b2', oracle_id: '10000000-0000-4000-8000-0000000000b2', name: 'Beta PR6I', collector_number: '2' });
const CARD_C = card({ id: '00000000-0000-4000-8000-0000000000c3', oracle_id: '10000000-0000-4000-8000-0000000000c3', name: 'Gamma PR6I', collector_number: '3' });

let passed = 0;
function pass(id, message) {
  passed++;
  console.log(`PASS: ${id} — ${message}`);
}

// --- Tests --------------------------------------------------------------------

async function run() {
  await db.initDb();

  // === F6I-TC1: THE REPORTED BUG =============================================
  //
  // A failure AFTER the swap has committed. This is Zach's SQLITE_BUSY,
  // reproduced at the exact point it actually occurred: the bookkeeping UPDATE
  // that runs once the catalogue is already in place.
  //
  // The old code printed "The existing cache of N cards is unchanged — no
  // partial catalogue was written" here, which was FALSE. The assertions below
  // are deliberately on the STATE FIRST and the words second, because the
  // failing property is the disagreement between them.
  fixtureCards = [CARD_A, CARD_B];
  let result = await refreshCatalogue({ log: captureLog() });
  assert.strictEqual(await cardCount(), 2, 'setup: the baseline import must land');

  // Make the post-commit bookkeeping UPDATE fail, and nothing else.
  publishedBuild = '2026-08-20T00:00:00.000+00:00';
  fixtureCards = [CARD_A, CARD_B, CARD_C];
  const realRun = db.run;
  let injected = false;
  db.run = function guardedRun(sql, params) {
    if (!injected && /UPDATE app_settings SET card_catalogue_updated_at/.test(sql)) {
      injected = true;
      return Promise.reject(new Error('SQLITE_BUSY: database is locked'));
    }
    return realRun.call(this, sql, params);
  };

  const busyLog = captureLog();
  let thrown = null;
  try {
    await refreshCatalogue({ log: busyLog });
  } catch (error) {
    thrown = error;
  } finally {
    db.run = realRun;
  }

  assert.ok(thrown, 'the refresh must still fail loudly — this is not about swallowing the error');
  assert.ok(injected, 'the test must actually have injected the post-commit failure');

  // THE STATE. Three cards are present, so the swap plainly committed.
  const afterBusy = await cardCount();
  assert.strictEqual(afterBusy, 3,
    'the import DID commit before the failure — this is the situation being reported on');
  const gamma = await db.get(`SELECT name FROM card_cache WHERE id = ?`, [CARD_C.id]);
  assert.ok(gamma, 'the newly imported card is really in card_cache');

  // THE WORDS. They must match the state above.
  assert.ok(!saidSomethingLike(busyLog, /is unchanged/),
    'REGRESSION: the app claimed the cache was unchanged when it had been replaced');
  assert.ok(!saidSomethingLike(busyLog, /no partial catalogue was written/),
    'REGRESSION: the app denied a write that had happened');
  assert.ok(saidSomethingLike(busyLog, /COMMITTED/),
    'the app must say the import committed');
  assert.ok(saidSomethingLike(busyLog, new RegExp(`${afterBusy} cards`)),
    'the app must report the REAL current row count, read back from the database');
  assert.ok(saidSomethingLike(busyLog, /no rollback occurred/),
    'the app must state plainly that nothing was rolled back');
  assert.strictEqual(thrown.catalogueState, 'committed',
    'callers must be able to tell this case apart programmatically');
  assert.strictEqual(thrown.catalogueCached, afterBusy,
    'the reported count must be the verified one');
  pass('F6I-TC1', 'a failure AFTER the swap reports the catalogue as REPLACED, not rolled back');

  // === F6I-TC2: the genuine pre-commit failure still reports intactness ======
  //
  // The other half of the contract. Fixing TC1 must not turn every failure into
  // a scary "it committed" message: a refresh that genuinely fails before
  // writing anything must still say the cache is intact — and now that claim is
  // VERIFIED by a re-read rather than assumed.
  const countBefore = await cardCount();
  publishedBuild = '2026-08-21T00:00:00.000+00:00';
  fixtureCards = [CARD_A];
  const failingGet = axios.get;
  axios.get = function brokenGet(url, config) {
    if (url === BULK_FILE_URL) return Promise.reject(new Error('socket hang up'));
    return failingGet.call(this, url, config);
  };
  const intactLog = captureLog();
  let intactError = null;
  try {
    await refreshCatalogue({ log: intactLog });
  } catch (error) {
    intactError = error;
  } finally {
    axios.get = failingGet;
  }

  assert.ok(intactError, 'a download failure must still fail');
  assert.strictEqual(await cardCount(), countBefore,
    'nothing may be written when the download never completed');
  assert.ok(saidSomethingLike(intactLog, /is unchanged/),
    'a genuine pre-commit failure must still report the cache as unchanged');
  assert.ok(saidSomethingLike(intactLog, new RegExp(`${countBefore} cards is unchanged`)),
    'and the count it reports must be the real one');
  assert.strictEqual(intactError.catalogueState, 'unchanged');
  pass('F6I-TC2', 'a refresh that genuinely fails reports failure AND the cache is genuinely unchanged');

  // === F6I-TC3: a successful refresh reports success =========================
  publishedBuild = '2026-08-22T00:00:00.000+00:00';
  fixtureCards = [CARD_A, CARD_B, CARD_C];
  const okLog = captureLog();
  result = await refreshCatalogue({ log: okLog });
  assert.strictEqual(result.skipped, false);
  assert.strictEqual(result.imported, 3, 'all three cards import');
  assert.strictEqual(result.cached, await cardCount(),
    'the reported cached count must equal the real row count');
  assert.ok(saidSomethingLike(okLog, /refresh complete/), 'success must be reported as success');
  assert.ok(!saidSomethingLike(okLog, /FAILED/), 'a successful refresh must not mention failure');
  pass('F6I-TC3', 'a refresh that succeeds reports success, with a count matching the database');

  // === F6I-TC4: the lock is released after every outcome ====================
  //
  // Asserted before the overlap cases, because a lock leaked by TC1-TC3 would
  // make the overlap tests below pass for entirely the wrong reason.
  assert.strictEqual(await readLock(), null,
    'no refresh is running, so the lock must be free after success AND after both failures');
  pass('F6I-TC4', 'the in-flight lock is released after success and after failure');

  // === F6I-TC5: two overlapping refreshes cannot both proceed ===============
  //
  // Started together and awaited together, so they genuinely overlap rather
  // than running one after the other. Exactly one must win; the other must be
  // refused with the dedicated code rather than colliding — the collision is
  // what produced the SQLITE_BUSY in the first place.
  publishedBuild = '2026-08-23T00:00:00.000+00:00';
  fixtureCards = [CARD_A, CARD_B, CARD_C];
  const settled = await Promise.allSettled([
    refreshCatalogue({ log: captureLog(), lockLabel: 'first' }),
    refreshCatalogue({ log: captureLog(), lockLabel: 'second' }),
  ]);

  const fulfilled = settled.filter(s => s.status === 'fulfilled');
  const rejected = settled.filter(s => s.status === 'rejected');
  assert.strictEqual(fulfilled.length, 1,
    `exactly one refresh may proceed, got ${fulfilled.length}`);
  assert.strictEqual(rejected.length, 1, 'the other must be refused');
  assert.strictEqual(rejected[0].reason.code, 'CATALOGUE_REFRESH_IN_PROGRESS',
    'the refusal must be the dedicated in-progress refusal, not an incidental error');
  assert.ok(rejected[0].reason instanceof RefreshInProgressError,
    'and it must carry the type callers branch on');
  assert.ok(/already running/.test(rejected[0].reason.message),
    'the refusal must say plainly that a refresh is already running');
  // The winner still did its job: this is a guard, not a general blocker.
  assert.strictEqual(fulfilled[0].value.imported, 3,
    'the refresh that won the lock must complete normally');
  assert.strictEqual(await readLock(), null, 'and the lock must be free again afterwards');
  pass('F6I-TC5', 'two overlapping refreshes cannot both proceed — one wins, one is refused');

  // === F6I-TC6: a refused refresh changes nothing ===========================
  //
  // The refusal must be a genuine no-op, not a partial run that stopped early.
  // A guard that leaves debris is worse than no guard.
  const beforeRefusal = await cardCount();
  await db.run(
    `UPDATE app_settings SET card_catalogue_refresh_started_at = ?,
       card_catalogue_refresh_heartbeat_at = ?, card_catalogue_refresh_owner = 'someone-else'
     WHERE id = 1`,
    [new Date().toISOString(), new Date().toISOString()]
  );
  publishedBuild = '2026-08-24T00:00:00.000+00:00';
  fixtureCards = [CARD_A, CARD_B, CARD_C, card({
    id: '00000000-0000-4000-8000-0000000000d4',
    oracle_id: '10000000-0000-4000-8000-0000000000d4',
    name: 'Must Never Land',
    collector_number: '4',
  })];
  await assert.rejects(
    () => refreshCatalogue({ log: captureLog(), lockLabel: 'blocked' }),
    /already running/,
    'a refresh must be refused while another holds the lock'
  );
  assert.strictEqual(await cardCount(), beforeRefusal,
    'a refused refresh must write nothing at all');
  const neverLanded = await db.get(`SELECT id FROM card_cache WHERE name = 'Must Never Land'`);
  assert.strictEqual(neverLanded, undefined,
    'not one row from the refused run may reach the catalogue');
  // The refusal must not clear someone else's lock on its way out, or a third
  // refresh could then start alongside the live one.
  const stillHeld = await readLock();
  assert.ok(stillHeld && stillHeld.owner === 'someone-else',
    'a refused refresh must leave the real holder\'s lock alone');
  pass('F6I-TC6', 'a refused refresh writes nothing and does not steal the holder\'s lock');

  // === F6I-TC7: a dead holder does not block refreshes forever ==============
  //
  // The risk introduced by the guard itself: a process killed mid-import can
  // never release its lock. If that were permanent, the guard would have turned
  // a transient collision into a catalogue that can never be refreshed again —
  // a worse bug than the one it fixes.
  const ancient = new Date(Date.now() - (60 * 60 * 1000)).toISOString(); // an hour ago
  await db.run(
    `UPDATE app_settings SET card_catalogue_refresh_started_at = ?,
       card_catalogue_refresh_heartbeat_at = ?, card_catalogue_refresh_owner = 'dead-process'
     WHERE id = 1`,
    [ancient, ancient]
  );
  publishedBuild = '2026-08-25T00:00:00.000+00:00';
  fixtureCards = [CARD_A, CARD_B, CARD_C];
  const takeoverResult = await refreshCatalogue({ log: captureLog(), lockLabel: 'recovery' });
  assert.strictEqual(takeoverResult.skipped, false,
    'a lock whose holder is long dead must not block a refresh forever');
  assert.strictEqual(await readLock(), null, 'and the recovered lock is released normally');
  pass('F6I-TC7', 'a stale lock from a dead process is taken over rather than blocking forever');

  // === F6I-TC8 (plan requirement H1): AN OWNED CARD SURVIVES A REFRESH ======
  //
  // The plan required: "Preserve user-owned/deck-referenced cache rows if an
  // upstream object disappears." The PR 6H review observed zero orphans but
  // could not say whether that was DESIGN or luck, because nothing exercised
  // the case. This exercises it.
  //
  // Why it matters more than most cache concerns: card_cache is not merely a
  // cache here. collection.card_id and deck_cards.desired_card_id point INTO
  // it, so a row that vanishes takes with it the app's only record of what a
  // physical card in Zach's binder actually IS. Scryfall dropping an object —
  // a card merged, re-ided, or withheld by a partial bulk build — must never
  // be able to delete his ownership record. That is data loss about physical
  // objects he still has in a box, and he would have no way to reconcile it.
  //
  // The refresh below publishes a bulk file that OMITS the card entirely.
  const survivor = card({
    id: '00000000-0000-4000-8000-0000000000e5',
    oracle_id: '10000000-0000-4000-8000-0000000000e5',
    name: 'Vanishing Upstream Card',
    collector_number: '5',
  });
  publishedBuild = '2026-08-26T00:00:00.000+00:00';
  fixtureCards = [CARD_A, CARD_B, CARD_C, survivor];
  await refreshCatalogue({ log: captureLog(), lockLabel: 'h1-seed' });
  assert.ok(await db.get(`SELECT id FROM card_cache WHERE id = ?`, [survivor.id]),
    'setup: the card must be in the catalogue before it disappears upstream');

  // He OWNS one and has it in a deck. Both foreign keys into card_cache are
  // exercised, because either one going dangling is the same disaster.
  const h1User = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, 'member', ?)`,
    ['h1owner', db.hashPassword('test-only-password'), `share-h1-${process.pid}`]
  );
  await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, condition, printing, finish, list_type)
     VALUES (?, ?, 2, 'Near Mint', 'Normal', 'nonfoil', 'collection')`,
    [survivor.id, h1User.lastID]
  );
  const h1Deck = await db.run(
    `INSERT INTO decks (name, format, user_id) VALUES ('H1 Deck', 'Modern', ?)`,
    [h1User.lastID]
  );
  await db.run(
    `INSERT INTO deck_cards (deck_id, oracle_id, desired_card_id, desired_finish, board, quantity)
     VALUES (?, ?, ?, 'nonfoil', 'mainboard', 2)`,
    [h1Deck.lastID, survivor.oracle_id, survivor.id]
  );

  // THE REFRESH THAT DROPS IT. A complete, successful, legitimate refresh —
  // the bulk file simply no longer contains this object.
  publishedBuild = '2026-08-27T00:00:00.000+00:00';
  fixtureCards = [CARD_A, CARD_B, CARD_C];
  const h1Result = await refreshCatalogue({ log: captureLog(), lockLabel: 'h1-drop' });
  assert.strictEqual(h1Result.skipped, false, 'the dropping refresh must really have run');

  // THE ROW SURVIVES, with its identifying data intact. Asserting on the NAME
  // and set as well as existence: a row reduced to a bare id would technically
  // satisfy the foreign key while still leaving the user unable to tell what
  // card is in his binder.
  const survived = await db.get(
    `SELECT id, name, set_id, number FROM card_cache WHERE id = ?`, [survivor.id]
  );
  assert.ok(survived,
    'DATA LOSS: a card the user OWNS was deleted because Scryfall stopped publishing it');
  assert.strictEqual(survived.name, 'Vanishing Upstream Card',
    'and it keeps the data that says WHICH physical card this is');

  // NOTHING IS ORPHANED. Checked as a property over the whole table rather
  // than for this one row, so the assertion still means something if the
  // fixtures change.
  const orphanedCollection = await db.all(
    `SELECT c.id FROM collection c
     LEFT JOIN card_cache cc ON c.card_id = cc.id WHERE cc.id IS NULL`
  );
  assert.deepStrictEqual(orphanedCollection, [],
    'no collection row may be left pointing at a card that no longer exists');
  const orphanedDeckCards = await db.all(
    `SELECT dc.id FROM deck_cards dc
     LEFT JOIN card_cache cc ON dc.desired_card_id = cc.id WHERE cc.id IS NULL`
  );
  assert.deepStrictEqual(orphanedDeckCards, [],
    'no deck requirement may be left pointing at a card that no longer exists');

  // And the quantities are untouched: surviving as a row is not enough if the
  // count of physical cards changed.
  const ownedAfter = await db.get(
    `SELECT SUM(quantity) AS qty FROM collection WHERE card_id = ?`, [survivor.id]
  );
  assert.strictEqual(ownedAfter.qty, 2, 'he still owns exactly the two copies he owns');
  pass('F6I-TC8', 'a card the user owns and decks SURVIVES a refresh that drops it upstream (plan H1)');

  console.log(`\nAll ${passed} PR 6I catalogue behaviour tests passed.`);
}

run()
  .then(cleanup)
  .catch(async (error) => {
    console.error('FAIL: PR 6I catalogue behaviour tests —', error.message);
    console.error(error.stack);
    await cleanup();
    process.exit(1);
  });
