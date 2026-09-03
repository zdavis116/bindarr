// A complete local copy of the MTG card catalogue.
//
// WHY THIS EXISTS
//
// card_cache used to be filled lazily: a row appeared only once some user
// action happened to touch that card. That meant the app was regularly asked
// to rule on a card it had never read — is this legal in Commander, what is
// its colour identity, does this printing exist — and it had to either guess,
// hit Scryfall mid-request, or refuse. PRs 6C-6G each patched one place where
// that hurt. This removes the cause: after a refresh, every English MTG
// printing is already local, so the "unknown card" branch stops being reached.
//
// The existing guards for unknown cards are deliberately left alone. They are
// still correct; they should simply stop firing.
//
// SOURCE
//
// Scryfall's `default_cards` bulk file, in its JSONL form. See REFRESH below
// for why default_cards and not oracle_cards.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { pipeline } = require('stream/promises');

const db = require('./db');
const { CARD_CACHE_COLUMNS } = require('./utils/cardCache');

const BULK_INDEX_URL = 'https://api.scryfall.com/bulk-data';

// Rows are staged here first and only copied into card_cache once the whole
// download has been read successfully. See applyStaged().
const STAGING_TABLE = 'card_cache_staging';

// How many staged rows to insert per statement. Same reasoning as the chunk in
// utils/cardCache.js: one round trip per card costs far more than the download,
// but the bound-parameter count has to stay inside SQLite's limit. 30 columns
// times 200 rows is 6000 parameters, comfortably under the 32766 default.
const INSERT_CHUNK = 200;

// Progress is logged every N accepted rows so a first run from empty — the slow
// case, tens of thousands of cards — looks like work rather than a hang.
const PROGRESS_EVERY = 10000;

function httpClient() {
  // Required lazily: scryfallApi pulls in the whole DB/query layer, and the
  // catalogue module is loaded by tests that do not want that cost.
  return require('axios');
}

// --- Row filtering -----------------------------------------------------------

// Which raw Scryfall objects belong in Bindarr's catalogue.
//
// The app is MTG-only and English-only (see utils/languages.js: card operations
// force English regardless of input), so anything else is not just unnecessary,
// it is actively wrong to store — a Japanese printing shares its collector
// number with the English one and would collide in search.
//
// Tokens, art series and memorabilia are excluded because they are not cards
// you can put in a deck, and they inflate the table with rows no deck or
// collection path can ever legitimately reference.
const EXCLUDED_LAYOUTS = new Set(['token', 'double_faced_token', 'art_series', 'emblem', 'scheme', 'planar', 'vanguard']);
const EXCLUDED_SET_TYPES = new Set(['memorabilia', 'token']);

function isWantedCard(raw) {
  if (!raw || raw.object !== 'card') return false;
  if (raw.lang !== 'en') return false;
  // normalizeCard() refuses a card with no oracle identity, by design. A
  // handful of Scryfall objects (reversible cards) carry oracle_id only on
  // their faces; skipping them here keeps that guard meaningful instead of
  // turning a whole refresh into an exception.
  if (!raw.oracle_id) return false;
  if (EXCLUDED_LAYOUTS.has(raw.layout)) return false;
  if (EXCLUDED_SET_TYPES.has(raw.set_type)) return false;
  return true;
}

// --- Bulk metadata -----------------------------------------------------------

// Pick the bulk file Bindarr needs and report when Scryfall last rebuilt it.
//
// default_cards, NOT oracle_cards: deck identity in this app is exact-only —
// a card is identified by its printing plus finish (see utils/deckIdentity.js),
// and collection rows point at a specific printing's Scryfall id. oracle_cards
// holds one arbitrary printing per Oracle id, so most of the ids the app
// actually stores would simply be absent. unique_artwork has the same problem
// for a different reason. default_cards is the only file that contains every
// printing, which is exactly what exact-only identity requires.
async function fetchBulkInfo() {
  const response = await httpClient().get(BULK_INDEX_URL, {
    timeout: 30000,
    headers: { 'User-Agent': 'Bindarr/1.0', Accept: 'application/json' },
  });
  const entries = (response.data && response.data.data) || [];
  const target = entries.find((entry) => entry.type === 'default_cards');
  if (!target) throw new Error('Scryfall bulk index has no default_cards entry');
  // The JSONL variant lets us read one card per line instead of parsing a
  // multi-hundred-megabyte JSON array into memory. This box shares an LXC with
  // production, so peak memory matters more than parser convenience.
  const url = target.jsonl_download_uri || target.download_uri;
  if (!url) throw new Error('Scryfall default_cards entry has no download URI');
  return { url, updatedAt: target.updated_at, compressedSize: target.compressed_size || null };
}

// --- Staging -----------------------------------------------------------------

// The staging table mirrors card_cache's columns but has NO foreign keys and no
// primary-key relationship to anything. It is scratch space: a failed refresh
// leaves rubbish here and nothing anywhere else.
async function createStagingTable() {
  await db.run(`DROP TABLE IF EXISTS ${STAGING_TABLE}`);
  const columnDefs = CARD_CACHE_COLUMNS.map((column) => `${column} TEXT`).join(', ');
  await db.run(`CREATE TABLE ${STAGING_TABLE} (${columnDefs})`);
}

async function dropStagingTable() {
  try {
    await db.run(`DROP TABLE IF EXISTS ${STAGING_TABLE}`);
  } catch (error) {
    // A failure to clean up scratch space must not mask the real error that
    // brought us here, and must not fail an otherwise successful refresh.
    console.warn('cardCatalogue: could not drop staging table:', error.message);
  }
}

const numeric = (value) => (value == null || value === '' || Number.isNaN(Number(value)) ? null : Number(value));

// Flatten a normalized card into the staging column order. Kept alongside the
// staging table rather than reusing cacheNormalizedCards(), because that helper
// writes to card_cache specifically and this must not.
function stagingParams(card) {
  return [
    card.id, card.name || '', card.supertype || '',
    JSON.stringify(card.subtypes || []), JSON.stringify(card.types || []),
    card.rarity || 'Common', card.set_id || '', card.set_name || '', card.number || '',
    card.image_url || '', numeric(card.price_trend), numeric(card.price_normal),
    numeric(card.price_holofoil), numeric(card.price_reverse_holofoil), numeric(card.price_avg1),
    numeric(card.price_avg7), numeric(card.price_avg30), numeric(card.cmc),
    JSON.stringify(card.color_identity || []),
    // LOCK-STEP WITH CARD_CACHE_COLUMNS. Second positional list of the same
    // columns -- cardCache.js has the other. Adding a column to the shared list
    // without adding its value HERE shifts every later field into the wrong
    // column. This is the fourth time in this project a change has landed in
    // one path and not its twin, so FFLV-TC6 now checks both.
    card.flavor_name || null,
    // SAME ORDER as CARD_CACHE_COLUMNS, immediately after flavor_name.
    card.display_name || null,
    card.back_image_url || null,
    card.back_name || null,
    card.back_type_line || null,
    card.oracle_id || null, card.oracle_name || '', card.mana_cost || '',
    card.oracle_text || '', card.type_line || '', JSON.stringify(card.keywords || []),
    JSON.stringify(card.legalities || {}), JSON.stringify(card.finishes || []),
    card.layout || '',
    card.tcgplayer_url || null, card.cardmarket_url || null,
  ];
}

async function insertStagedChunk(cards) {
  if (!cards.length) return;
  const placeholders = `(${CARD_CACHE_COLUMNS.map(() => '?').join(', ')})`;
  const params = [];
  for (const card of cards) params.push(...stagingParams(card));
  await db.run(
    `INSERT INTO ${STAGING_TABLE} (${CARD_CACHE_COLUMNS.join(', ')})
     VALUES ${cards.map(() => placeholders).join(', ')}`,
    params
  );
}

// --- Download + stage --------------------------------------------------------

// Stream the gzipped JSONL bulk file straight into the staging table.
//
// Nothing is buffered whole: gunzip and line splitting are both streaming, so
// peak memory is one chunk plus one insert batch regardless of file size.
async function downloadIntoStaging(url, { onProgress } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-catalogue-'));
  const archivePath = path.join(tempDir, 'default-cards.jsonl.gz');
  const { normalizeCard } = require('./scryfallApi');

  let accepted = 0;
  let skipped = 0;
  let compressedBytes = 0;

  try {
    const response = await httpClient().get(url, {
      responseType: 'stream',
      timeout: 300000,
      headers: { 'User-Agent': 'Bindarr/1.0' },
    });
    // Land the archive on disk first. Parsing directly off the socket means a
    // mid-download network drop shows up as a truncated final line, which is
    // indistinguishable from a genuinely malformed row; writing then reading
    // makes an incomplete transfer a hard error before any parsing starts.
    await pipeline(response.data, fs.createWriteStream(archivePath));
    compressedBytes = fs.statSync(archivePath).size;

    const lines = readline.createInterface({
      input: fs.createReadStream(archivePath).pipe(zlib.createGunzip()),
      crlfDelay: Infinity,
    });

    let batch = [];
    for await (const line of lines) {
      const trimmed = line.trim();
      // The JSONL file has one object per line, but the array-shaped file the
      // download URI may serve instead brackets the whole thing; tolerate both
      // rather than depending on which variant Scryfall handed us.
      if (!trimmed || trimmed === '[' || trimmed === ']') continue;
      const withoutComma = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;

      let raw;
      try {
        raw = JSON.parse(withoutComma);
      } catch (error) {
        // A row we cannot parse is a row we cannot vouch for. Failing the whole
        // refresh is the right call: the standing rule is to error out rather
        // than produce a partial catalogue, and partial rows are precisely what
        // brings the thin-data rulings back to life.
        throw new Error(`Malformed card data in bulk file: ${error.message}`);
      }

      if (!isWantedCard(raw)) { skipped++; continue; }
      batch.push(normalizeCard(raw));
      if (batch.length >= INSERT_CHUNK) {
        await insertStagedChunk(batch);
        accepted += batch.length;
        batch = [];
        if (accepted % PROGRESS_EVERY < INSERT_CHUNK && onProgress) {
          onProgress({ accepted, skipped });
        }
      }
    }
    if (batch.length) {
      await insertStagedChunk(batch);
      accepted += batch.length;
    }

    if (accepted === 0) {
      // An empty result is never legitimate for this file. Treating it as
      // success would replace a working catalogue with nothing.
      throw new Error('Bulk file yielded no usable cards');
    }
    return { accepted, skipped, compressedBytes };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* scratch only */ }
  }
}

// --- Colour-identity reporting ----------------------------------------------

// Colour identity cannot change on a printed card. If a refresh reports a
// different colour identity for a card already used in a deck, that is Scryfall
// correcting its own earlier data error — the app finally learning the truth,
// not the card drifting.
//
// So this reports and does not police: no deck re-validation, no warning code,
// no auto-removal. The user should be able to see that a card they built around
// was recorded wrong, and that is all this does.
async function findColourIdentityCorrections() {
  return db.all(`
    SELECT cc.id, cc.name, cc.color_identity AS previous_identity, s.color_identity AS new_identity
    FROM card_cache cc
    JOIN ${STAGING_TABLE} s ON s.id = cc.id
    WHERE cc.color_identity IS NOT s.color_identity
      AND cc.id IN (SELECT desired_card_id FROM deck_cards)
  `);
}

// --- Apply -------------------------------------------------------------------

// Copy staged rows into card_cache inside one transaction.
//
// UPSERT, NOT FULL REPLACE. This is forced by the schema, not a preference:
// collection.card_id and deck_cards.desired_card_id both have real foreign keys
// into card_cache, and foreign keys are enforced (db.js turns the pragma ON).
// A truncate-and-reload would have to DELETE rows that those tables reference,
// and SQLite refuses that outright with a FOREIGN KEY constraint failure. Even
// if it were allowed it would be the wrong shape: it would momentarily empty
// the catalogue underneath a serving app.
//
// INSERT OR REPLACE per row is safe here in a way a bulk DELETE is not —
// replacing a row keeps the same primary key, so referencing rows stay valid.
//
// Rows that Scryfall no longer publishes are deliberately left in place. They
// are what someone's collection or deck points at; removing them would be a
// silent state change against physical cards the user still owns.
async function applyStaged() {
  const corrections = await findColourIdentityCorrections();

  await db.withTransaction(async (tx) => {
    await tx.run(`
      INSERT OR REPLACE INTO card_cache (${CARD_CACHE_COLUMNS.join(', ')}, last_updated)
      SELECT ${CARD_CACHE_COLUMNS.join(', ')}, CURRENT_TIMESTAMP FROM ${STAGING_TABLE}
    `);
  }, { timeoutMs: 30 * 60 * 1000 });

  return corrections;
}

// --- The in-flight lock (PR 6I item 8) --------------------------------------

// How stale a heartbeat must be before a later run is allowed to conclude the
// holder is dead and take the lock. Deliberately far longer than any gap a live
// import produces: the heartbeat is written on every progress callback, so a
// healthy refresh touches it every few thousand rows. Twenty minutes of total
// silence is not a slow import, it is a process that is gone.
const LOCK_STALE_AFTER_MS = 20 * 60 * 1000;

// A refresh is already running elsewhere. A distinct class so callers can tell
// "someone else is doing this" from "this failed" — they are different events
// and deserve different words to the operator.
class RefreshInProgressError extends Error {
  constructor(holder) {
    super(
      `A catalogue refresh is already running (started by ${holder.owner || 'an unknown process'} ` +
      `at ${holder.startedAt}). Refusing to start a second one.`
    );
    this.code = 'CATALOGUE_REFRESH_IN_PROGRESS';
    this.holder = holder;
  }
}

function lockOwnerLabel(label) {
  return `${label || 'unknown'} pid ${process.pid} on ${os.hostname()}`;
}

// Read who currently holds the lock, or null when it is free.
async function readLock() {
  const row = await db.get(
    `SELECT card_catalogue_refresh_started_at AS startedAt,
            card_catalogue_refresh_heartbeat_at AS heartbeatAt,
            card_catalogue_refresh_owner AS owner
     FROM app_settings WHERE id = 1`
  ).catch(() => null);
  if (!row || !row.startedAt) return null;
  return row;
}

// Claim the lock, or refuse.
//
// The read and the write happen INSIDE ONE withTransaction() — that is what
// makes this a lock rather than a check. withTransaction opens BEGIN IMMEDIATE,
// which takes SQLite's write lock for the whole body, so two processes cannot
// both read "free" and then both write "mine". Doing the read outside and the
// write inside would leave exactly that window open.
async function acquireLock(label, { now = () => new Date().toISOString() } = {}) {
  const owner = lockOwnerLabel(label);
  return db.withTransaction(async (tx) => {
    const row = await tx.get(
      `SELECT card_catalogue_refresh_started_at AS startedAt,
              card_catalogue_refresh_heartbeat_at AS heartbeatAt,
              card_catalogue_refresh_owner AS owner
       FROM app_settings WHERE id = 1`
    );
    const holder = row && row.startedAt ? row : null;
    if (holder) {
      const beat = Date.parse(holder.heartbeatAt || holder.startedAt);
      const age = Number.isNaN(beat) ? Infinity : Date.now() - beat;
      // A live holder wins outright. Note this is the ONLY place a refusal is
      // decided, so both the server job and the manual script get the same
      // answer from the same rule.
      if (age < LOCK_STALE_AFTER_MS) throw new RefreshInProgressError(holder);
      // A dead holder is taken over, LOUDLY. Never silently: an operator who
      // sees a takeover in the log knows a previous run died, which is a real
      // fact about the system they would otherwise never learn.
      console.warn(
        `cardCatalogue: taking over a catalogue refresh lock last touched ` +
        `${Math.round(age / 1000)}s ago by ${holder.owner || 'an unknown process'}; ` +
        `treating that run as dead.`
      );
    }
    const stamp = now();
    await tx.run(
      `UPDATE app_settings
       SET card_catalogue_refresh_started_at = ?,
           card_catalogue_refresh_heartbeat_at = ?,
           card_catalogue_refresh_owner = ?
       WHERE id = 1`,
      [stamp, stamp, owner]
    );
    return { owner, startedAt: stamp };
  });
}

// Release the lock, but ONLY if we still hold it. The guard matters: if our
// lock was taken over as stale while we were still running, clearing it here
// would delete the NEW holder's claim and let a third refresh start alongside
// them. Better to leave a lock we no longer own alone.
async function releaseLock(claim) {
  if (!claim) return;
  try {
    await db.run(
      `UPDATE app_settings
       SET card_catalogue_refresh_started_at = NULL,
           card_catalogue_refresh_heartbeat_at = NULL,
           card_catalogue_refresh_owner = NULL
       WHERE id = 1 AND card_catalogue_refresh_owner = ?`,
      [claim.owner]
    );
  } catch (error) {
    // Never mask the outcome of the refresh itself with a bookkeeping failure.
    // A lock left behind is recoverable (it goes stale); a lost error is not.
    console.warn('cardCatalogue: could not release the refresh lock:', error.message);
  }
}

async function beatHeartbeat(claim) {
  if (!claim) return;
  try {
    await db.run(
      `UPDATE app_settings SET card_catalogue_refresh_heartbeat_at = ?
       WHERE id = 1 AND card_catalogue_refresh_owner = ?`,
      [new Date().toISOString(), claim.owner]
    );
  } catch { /* a missed beat only costs us a shorter stale window */ }
}

// --- Public entry point ------------------------------------------------------

// Refresh the local catalogue.
//
// FAILURE CONTRACT (rewritten for PR 6I item 7).
//
// The old contract read: "if anything goes wrong at any point before
// applyStaged() succeeds, card_cache is untouched". That sentence was true. The
// error handler's message was not, because it made a WIDER claim than the
// sentence supports — it said the cache was unchanged for ANY error, including
// errors thrown AFTER applyStaged() had already committed.
//
// That is exactly what bit Zach on 2026-08-19: the import committed 104,406
// rows, the app_settings bookkeeping UPDATE afterwards hit SQLITE_BUSY, and the
// handler printed "The existing cache of 174 cards is unchanged — no partial
// catalogue was written." The catalogue had in fact been completely replaced.
// The app stated a rollback that never happened.
//
// So the handler no longer INFERS state from the fact that it is on the error
// path. It tracks whether the swap actually committed, and it RE-READS the row
// count from the database before saying anything about it. The rule this
// encodes: never describe your own state from control flow when you can go and
// look.
async function refreshCatalogue(options = {}) {
  const { force = false, log = console, lockLabel = 'server' } = options;
  const startedAt = Date.now();

  // The lock is taken BEFORE the bulk index fetch, not after. The point is to
  // stop two imports overlapping, and the download is the long part — claiming
  // afterwards would leave both processes free to spend minutes downloading
  // before one discovers it should not have started.
  const claim = await acquireLock(lockLabel);

  try {
    const info = await fetchBulkInfo();

    // Skip the download when Scryfall has not rebuilt the file since our last
    // successful import. This is what stops the dev and production instances from
    // both pulling hundreds of megabytes: each checks a few-kilobyte index first,
    // and neither downloads a file it already has. It also makes the job safe to
    // run more often than nightly, and safe to re-run by hand.
    const settings = await db.get(`SELECT card_catalogue_updated_at FROM app_settings WHERE id = 1`).catch(() => null);
    const lastImported = settings && settings.card_catalogue_updated_at;
    if (!force && lastImported && info.updatedAt && lastImported === info.updatedAt) {
      log.log(`cardCatalogue: already current (Scryfall build ${info.updatedAt}); skipping download.`);
      return { skipped: true, reason: 'already_current', updatedAt: info.updatedAt };
    }

    const existing = await db.get(`SELECT COUNT(*) AS count FROM card_cache`);
    log.log(
      `cardCatalogue: refreshing from Scryfall default_cards (build ${info.updatedAt}); ` +
      `${existing.count} cards currently cached. This takes several minutes on a first run.`
    );

    // THE FACT the error handler needs, recorded rather than guessed. It flips
    // only once applyStaged() has RETURNED — i.e. once its transaction has
    // committed — so it can never claim a commit that did not happen, and can
    // never deny one that did.
    let swapCommitted = false;

    await createStagingTable();
    try {
      const staged = await downloadIntoStaging(info.url, {
        onProgress: ({ accepted, skipped }) => {
          log.log(`cardCatalogue: staged ${accepted} cards (${skipped} non-English/non-card rows skipped)...`);
          // Piggy-backed on progress rather than a timer: no interval to leak
          // if this function throws, and it beats often enough to be useful.
          beatHeartbeat(claim);
        },
      });

      const corrections = await applyStaged();
      swapCommitted = true;

      for (const correction of corrections) {
        log.warn(
          `cardCatalogue: Scryfall corrected the colour identity of "${correction.name}" ` +
          `(${correction.id}), which is used in a deck: ${correction.previous_identity} -> ${correction.new_identity}. ` +
          `Nothing was removed from the deck.`
        );
      }

      await db.run(
        `UPDATE app_settings SET card_catalogue_updated_at = ?, card_catalogue_refreshed_at = CURRENT_TIMESTAMP WHERE id = 1`,
        [info.updatedAt || null]
      );

      const total = await db.get(`SELECT COUNT(*) AS count FROM card_cache`);
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      log.log(
        `cardCatalogue: refresh complete in ${seconds}s — ${staged.accepted} cards imported, ` +
        `${total.count} now cached.`
      );

      return {
        skipped: false,
        imported: staged.accepted,
        ignored: staged.skipped,
        cached: total.count,
        corrections,
        updatedAt: info.updatedAt,
        seconds,
      };
    } catch (error) {
      // REPORT WHAT IS ACTUALLY THERE, not what the code path implies.
      //
      // Re-reading the count is the whole fix. It is cheap, it cannot be wrong,
      // and it is the only way to distinguish the two genuinely different
      // situations that both arrive here.
      let cachedNow = null;
      try {
        const row = await db.get(`SELECT COUNT(*) AS count FROM card_cache`);
        cachedNow = row ? row.count : null;
      } catch (countError) {
        // If we cannot even count, we say we cannot — we do not fall back to a
        // confident claim. An unverified assertion about the user's data is the
        // defect being fixed; repeating it in the recovery path would be absurd.
        log.error(
          `cardCatalogue: refresh FAILED (${error.message}), and the resulting state could NOT be ` +
          `verified (${countError.message}). Check the catalogue by hand before relying on it.`
        );
        error.catalogueState = 'unverified';
        throw error;
      }

      if (swapCommitted) {
        // The import landed and something after it failed. Saying "unchanged"
        // here is the false statement PR 6I item 7 exists to remove.
        log.error(
          `cardCatalogue: the catalogue import COMMITTED, but the refresh then failed ` +
          `(${error.message}). The cache now holds ${cachedNow} cards — it HAS been replaced, ` +
          `and no rollback occurred. What did not complete is the bookkeeping that records ` +
          `which Scryfall build is loaded, so the next run will import this build again.`
        );
        error.catalogueState = 'committed';
      } else {
        // Nothing was copied into card_cache: everything up to here writes only
        // to the staging table. This claim is now BACKED by the count, so it is
        // an observation rather than an assumption.
        log.error(
          `cardCatalogue: refresh FAILED (${error.message}) before any card was written. ` +
          `The existing cache of ${cachedNow} cards is unchanged — no partial catalogue was written.`
        );
        error.catalogueState = 'unchanged';
      }
      error.catalogueCached = cachedNow;
      throw error;
    } finally {
      await dropStagingTable();
    }
  } finally {
    await releaseLock(claim);
  }
}

module.exports = {
  refreshCatalogue,
  // Exported for tests and for the manual trigger script.
  fetchBulkInfo,
  isWantedCard,
  readLock,
  RefreshInProgressError,
  LOCK_STALE_AFTER_MS,
  STAGING_TABLE,
};
