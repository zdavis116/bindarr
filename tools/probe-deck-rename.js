// Does a Moxfield rename actually reach the Bindarr deck name?
//
// Zach: "when I updated a deck name in moxfield the deckname didnt update on
// bindarr I would like the deckname to update when I do that."
//
// The unit test asserts the SQL is right. This proves the statement actually
// updates a real row on the real schema -- a test that reads source text can
// be perfectly green while the column name is wrong, and this project has been
// bitten by that before.
//
// SAFE: it works on a COPY of the database, never his data.
const fs = require('node:fs');
const sqlite3 = require('/opt/bindarr-dev/backend/node_modules/sqlite3');

const SRC = '/var/lib/bindarr-dev/bindarr.db';
const TMP = '/tmp/rename-check.db';
fs.copyFileSync(SRC, TMP);

const db = new sqlite3.Database(TMP);
const all = (sql, p = []) => new Promise((res, rej) =>
  db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const run = (sql, p = []) => new Promise((res, rej) =>
  db.run(sql, p, function cb(e) { return e ? rej(e) : res(this); }));

(async () => {
  const deck = (await all(
    `SELECT id, user_id, name FROM decks WHERE moxfield_public_id IS NOT NULL LIMIT 1`))[0]
    || (await all(`SELECT id, user_id, name FROM decks LIMIT 1`))[0];
  if (!deck) { console.log('no decks to test against'); return; }
  console.log('deck before :', JSON.stringify(deck.name));

  // THE EXACT STATEMENT applySync now runs.
  const SQL = `UPDATE decks SET moxfield_synced_at = ?,
                                moxfield_updated_at = ?,
                                name = COALESCE(?, name)
                WHERE id = ? AND user_id = ?`;

  const r1 = await run(SQL, ['2026-09-21T00:00:00Z', '2026-09-21T00:00:00Z',
    'Renamed On Moxfield', deck.id, deck.user_id]);
  const after = (await all('SELECT name FROM decks WHERE id = ?', [deck.id]))[0];
  console.log('after rename:', JSON.stringify(after.name),
    '| changes:', r1.changes,
    after.name === 'Renamed On Moxfield' ? '-> RENAME LANDS' : '-> *** FAILED ***');

  // And the guard that matters: a payload with NO name must not blank it.
  await run(SQL, ['2026-09-21T00:00:00Z', '2026-09-21T00:00:00Z',
    null, deck.id, deck.user_id]);
  const after2 = (await all('SELECT name FROM decks WHERE id = ?', [deck.id]))[0];
  console.log('after null  :', JSON.stringify(after2.name),
    after2.name === 'Renamed On Moxfield'
      ? '-> NULL KEEPS THE NAME (correct)'
      : '*** a missing name blanked the title ***');

  db.close();
  fs.unlinkSync(TMP);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
