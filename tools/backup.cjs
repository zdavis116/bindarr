#!/usr/bin/env node
// Checkpoint, back up and verify the dev database using the app's OWN sqlite3
// module. The sqlite3 CLI is not installed on this container, and installing
// packages onto a production-adjacent host to run a backup is the wrong trade:
// the module the service already loads is the one whose behaviour matters.
//
// Prints machine-readable lines the shell wrapper checks.
const path = process.argv[2];
const dest = process.argv[3];
if (!path || !dest) { console.error('usage: backup.cjs <src.db> <dest.db>'); process.exit(2); }

const sqlite3 = require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const db = new sqlite3.Database(path, sqlite3.OPEN_READWRITE, (err) => {
  if (err) { console.error('OPEN_FAILED ' + err.message); process.exit(1); }
});

const run = (sql) => new Promise((res, rej) =>
  db.run(sql, (e) => e ? rej(e) : res()));
const get = (sql) => new Promise((res, rej) =>
  db.get(sql, (e, r) => e ? rej(e) : res(r)));

(async () => {
  try {
    // Fold the WAL into the database. 178M of committed writes live there;
    // copying the .db alone would silently miss every one of them.
    await run('PRAGMA wal_checkpoint(TRUNCATE)');
    console.log('CHECKPOINT_OK');

    // The online backup API. A plain cp of a database being written to can
    // produce a torn file that opens fine and is subtly wrong.
    await new Promise((res, rej) => {
      const b = db.backup(dest, (err) => {
        if (err) return rej(err);
        b.step(-1, (e) => {
          if (e) return rej(e);
          b.finish((e2) => e2 ? rej(e2) : res());
        });
      });
    });
    console.log('BACKUP_OK');

    // Verify the COPY -- that is the artifact a rollback would depend on.
    const copy = new sqlite3.Database(dest, sqlite3.OPEN_READONLY);
    const chk = await new Promise((res, rej) =>
      copy.get('PRAGMA integrity_check', (e, r) => e ? rej(e) : res(r)));
    const val = chk && (chk.integrity_check || Object.values(chk)[0]);
    console.log('INTEGRITY ' + val);
    if (val !== 'ok') process.exit(1);

    // Row counts, so a restore can be checked against something real rather
    // than "the file exists".
    const counts = await new Promise((res, rej) =>
      copy.get(`SELECT (SELECT COUNT(*) FROM collection)  AS collection,
                       (SELECT COUNT(*) FROM decks)       AS decks,
                       (SELECT COUNT(*) FROM deck_cards)  AS deck_cards,
                       (SELECT COUNT(*) FROM card_cache)  AS cards`,
        (e, r) => e ? rej(e) : res(r)));
    console.log('COUNTS ' + JSON.stringify(counts));
    copy.close();
    db.close();
  } catch (e) {
    console.error('FAILED ' + e.message);
    process.exit(1);
  }
})();
