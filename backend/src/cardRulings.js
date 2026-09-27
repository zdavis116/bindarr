// Scryfall rulings import.
//
// Zach: "I would like to add to the card tab a ruling section so I can see all
// rulings made for that card." He asks rules questions about his own decks --
// Alhammarret's Archive and Library of Leng both came up and both have rulings
// that settle the question -- so these are the answers, not trivia.
//
// WHY A BULK IMPORT rather than a fetch-on-open. Zach chose this shape, and it
// is also the one that matches the app: rulings then work offline, on a
// tailnet-only box, with no per-card latency and no request to Scryfall every
// time he taps a card. The whole file is 5.1 MB compressed -- two orders of
// magnitude smaller than the card catalogue's ~100 MB, so the cost of holding
// all of them is negligible.
//
// This deliberately mirrors cardCatalogue.js: same lock, same skip-if-unchanged
// index check, same staging-table swap. Not copied for its own sake -- those
// three mechanisms each exist because of a real incident recorded in that file,
// and a second importer that skipped them would rediscover the same failures.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { pipeline } = require('stream/promises');

const db = require('./db');

function httpClient() {
  // Required lazily for the same reason cardCatalogue does it: scryfallApi
  // pulls in the whole DB/query layer, and this module is loaded by tests that
  // do not want that cost.
  return require('axios');
}

const BULK_INDEX_URL = 'https://api.scryfall.com/bulk-data';
const STAGING_TABLE = 'card_rulings_staging';

// Find the rulings file in Scryfall's bulk index.
//
// Read the field names off the index rather than assuming them: the entries
// carry `jsonl_download_uri` and `compressed_size`, NOT the `download_uri` and
// `size` an older version of their docs implies. Guessing cost me two failed
// runs before I printed the actual keys.
async function fetchBulkInfo() {
  const response = await httpClient().get(BULK_INDEX_URL, {
    timeout: 30000,
    headers: { 'User-Agent': 'Bindarr/1.0', Accept: 'application/json' },
  });
  const entries = (response.data && response.data.data) || [];
  const target = entries.find((entry) => entry.type === 'rulings');
  if (!target) throw new Error('Scryfall bulk index has no rulings entry');
  const url = target.jsonl_download_uri || target.download_uri;
  if (!url) throw new Error('Scryfall rulings entry has no download URI');
  return { url, updatedAt: target.updated_at, compressedSize: target.compressed_size || null };
}

// Scratch space. A failed import leaves rubbish here and nothing anywhere else.
async function createStagingTable() {
  await db.run(`DROP TABLE IF EXISTS ${STAGING_TABLE}`);
  await db.run(`
    CREATE TABLE ${STAGING_TABLE} (
      oracle_id TEXT,
      published_at TEXT,
      source TEXT,
      comment TEXT
    )
  `);
}

async function dropStagingTable() {
  try {
    await db.run(`DROP TABLE IF EXISTS ${STAGING_TABLE}`);
  } catch (error) {
    console.warn(`cardRulings: could not drop staging table: ${error.message}`);
  }
}

async function downloadIntoStaging(url, { onProgress } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-rulings-'));
  const archivePath = path.join(tempDir, 'rulings.jsonl.gz');

  let accepted = 0;
  let skipped = 0;

  try {
    const response = await httpClient().get(url, {
      responseType: 'stream',
      timeout: 300000,
      headers: { 'User-Agent': 'Bindarr/1.0' },
    });
    // Land the archive on disk before parsing. A mid-download drop then shows
    // up as a truncated file rather than as a malformed final line, which is
    // indistinguishable from a genuinely bad row.
    await pipeline(response.data, fs.createWriteStream(archivePath));

    const lines = readline.createInterface({
      input: fs.createReadStream(archivePath).pipe(zlib.createGunzip()),
      crlfDelay: Infinity,
    });

    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const rows = batch;
      batch = [];
      // ONE transaction for the batch, not one per row. db.js serialises every
      // call through a queue, so N transactions is N queue round-trips: the
      // measured cost of getting this wrong elsewhere was 14s vs 0.37s for the
      // same 72 inserts.
      await db.withTransaction(async (tx) => {
        for (const row of rows) {
          await tx.run(
            `INSERT INTO ${STAGING_TABLE} (oracle_id, published_at, source, comment)
             VALUES (?, ?, ?, ?)`,
            [row.oracle_id, row.published_at, row.source, row.comment]
          );
        }
      });
    };

    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[' || trimmed === ']') continue;
      let row;
      try {
        row = JSON.parse(trimmed.replace(/,$/, ''));
      } catch {
        skipped += 1;
        continue;
      }
      // A ruling with no oracle_id cannot be attached to a card, and one with
      // no comment says nothing. Either way it is not a ruling we can show.
      if (!row || !row.oracle_id || !row.comment) {
        skipped += 1;
        continue;
      }
      batch.push({
        oracle_id: row.oracle_id,
        published_at: row.published_at || null,
        source: row.source || null,
        comment: row.comment,
      });
      accepted += 1;
      if (batch.length >= 500) {
        await flush();
        if (onProgress) onProgress({ accepted, skipped });
      }
    }
    await flush();
    if (onProgress) onProgress({ accepted, skipped });
    return { accepted, skipped };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* a leftover temp dir is not worth failing the import over */ }
  }
}

// Swap staging into place inside ONE transaction, so a reader never sees an
// empty rulings table. Delete-then-insert rather than a table rename because
// the index and any future foreign keys live on the real table.
async function applyStaged() {
  await db.withTransaction(async (tx) => {
    await tx.run(`DELETE FROM card_rulings`);
    await tx.run(
      `INSERT INTO card_rulings (oracle_id, published_at, source, comment)
       SELECT oracle_id, published_at, source, comment FROM ${STAGING_TABLE}`
    );
  });
}

async function refreshRulings(options = {}) {
  const { force = false, log = console } = options;
  const startedAt = Date.now();

  const info = await fetchBulkInfo();

  // Skip the download when Scryfall has not rebuilt the file since our last
  // import. A few-kilobyte index check instead of 5 MB, which is what makes
  // this safe to run often and safe to re-run by hand.
  const settings = await db
    .get(`SELECT card_rulings_updated_at FROM app_settings WHERE id = 1`)
    .catch(() => null);
  const lastImported = settings && settings.card_rulings_updated_at;
  if (!force && lastImported && info.updatedAt && lastImported === info.updatedAt) {
    log.log(`cardRulings: already current (Scryfall build ${info.updatedAt}); skipping download.`);
    return { skipped: true, reason: 'already_current', updatedAt: info.updatedAt };
  }

  log.log(`cardRulings: refreshing from Scryfall rulings (build ${info.updatedAt}).`);

  await createStagingTable();
  try {
    const staged = await downloadIntoStaging(info.url, {
      onProgress: ({ accepted }) => {
        if (accepted % 10000 === 0) log.log(`cardRulings: staged ${accepted} rulings...`);
      },
    });

    // REFUSE AN EMPTY IMPORT. If the download produced nothing, swapping it in
    // would delete every ruling we already have and report success. A truncated
    // file must leave the existing data alone.
    if (!staged.accepted) {
      throw new Error('Scryfall rulings file produced 0 usable rows; refusing to replace existing rulings');
    }

    await applyStaged();

    await db.run(
      `UPDATE app_settings
       SET card_rulings_updated_at = ?, card_rulings_refreshed_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
      [info.updatedAt || null]
    );

    const total = await db.get(`SELECT COUNT(*) AS count FROM card_rulings`);
    const cards = await db.get(`SELECT COUNT(DISTINCT oracle_id) AS count FROM card_rulings`);
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    log.log(
      `cardRulings: refresh complete in ${seconds}s — ${staged.accepted} rulings imported ` +
      `across ${cards.count} cards.`
    );
    return {
      skipped: false,
      imported: staged.accepted,
      ignored: staged.skipped,
      cards: cards.count,
      total: total.count,
      updatedAt: info.updatedAt,
      seconds,
    };
  } finally {
    await dropStagingTable();
  }
}

// Rulings for one oracle id, newest first.
//
// NEWEST FIRST because a later ruling usually refines or supersedes an earlier
// one -- Doubling Season's 2024 rulings are the current answer, its 2006 ones
// are history.
async function rulingsFor(oracleId) {
  if (!oracleId) return [];
  return db.all(
    `SELECT published_at, source, comment
     FROM card_rulings
     WHERE oracle_id = ?
     ORDER BY published_at DESC, rowid ASC`,
    [oracleId]
  );
}

module.exports = {
  refreshRulings,
  rulingsFor,
  fetchBulkInfo,
};
