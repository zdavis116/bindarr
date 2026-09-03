const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// RECOVERABLE DELETES.
//
// Zach: "Delete should be undoable... a trash table and it stays alive in that
// table until we delete 3 batches. So on our 4th batch the 1st batch we
// deleted goes away."
//
// The design decision worth protecting: the row MOVES OUT of `collection`
// rather than gaining a deleted_at flag. Measured before choosing -- 79 places
// in the backend read that table. A flag would need every one of them to
// filter, and one miss leaves a deleted card still counting toward a deck's
// coverage, the collection value, or a storage location. That is a wrong
// record caused by the safety feature.

const trashSrc = fs.readFileSync(
  path.join(__dirname, '../src/utils/collectionTrash.js'), 'utf8');
const routeSrc = fs.readFileSync(
  path.join(__dirname, '../src/routes/collection.js'), 'utf8');
const schemaSrc = fs.readFileSync(
  path.join(__dirname, '../src/db.js'), 'utf8');

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

test('TRASH-TC1: deleting moves the row out, it does not flag it', () => {
  // If this ever becomes a deleted_at column, all 79 read sites need auditing.
  assert.match(trashSrc, /INSERT INTO collection_trash/,
    'the row is copied to the trash');
  assert.match(trashSrc, /DELETE FROM collection WHERE id IN/,
    'and removed from the collection');
  assert.doesNotMatch(stripComments(trashSrc), /deleted_at IS NULL/,
    'no query should have to remember to filter deleted rows');
  assert.doesNotMatch(stripComments(schemaSrc),
    /ALTER TABLE collection ADD COLUMN deleted_at/,
    'the collection table must not grow a soft-delete flag');
});

test('TRASH-TC2: three batches are kept, the fourth purges the first', () => {
  // Zach's exact rule.
  assert.match(trashSrc, /const KEEP_BATCHES = 3;/);
  assert.match(trashSrc, /batches\.slice\(KEEP_BATCHES\)/,
    'everything past the newest three is purged');
});

test('TRASH-TC3: batches are ordered by time, not by id string', () => {
  // batch_id begins with a timestamp so string order usually agrees -- but
  // sorting a generated string is a coincidence to rely on, not a rule. If the
  // id format ever changes, ordering by it silently purges the wrong batch.
  assert.match(trashSrc, /MAX\(deleted_at\) AS newest[\s\S]{0,120}ORDER BY newest DESC/,
    'purge order must come from the timestamps');
});

test('TRASH-TC4: a restore keeps the original entry id', () => {
  // collection_tags and deck_card_allocations both reference collection.id
  // with ON DELETE CASCADE. Restoring under a fresh id silently drops those
  // links, and nothing would report it.
  assert.match(trashSrc, /entry_id INTEGER PRIMARY KEY|INSERT OR IGNORE INTO collection\s*\n\s*\(id, user_id/,
    'the id must be preserved through the round trip');
  assert.match(schemaSrc, /entry_id INTEGER PRIMARY KEY/,
    'the trash keys on the original collection id');
});

test('TRASH-TC5: a restore never overwrites a live row', () => {
  // If something has taken that id since, the safe outcome is to leave the
  // live row alone. Verified against a real database: restored 0, skipped 1,
  // live row untouched.
  assert.match(trashSrc, /INSERT OR IGNORE INTO collection/,
    'OR IGNORE, so an occupied id is skipped rather than clobbered');
});

test('TRASH-TC6: every trash query is scoped to the user', () => {
  // The endpoints take ids and a batch id straight from the client. Verified
  // against a real database: asking to delete two rows owned by different
  // users moved exactly one.
  const fns = ['trashEntries', 'restoreBatch', 'purgeOldBatches', 'listTrash'];
  for (const fn of fns) {
    const start = trashSrc.indexOf(`async function ${fn}`);
    assert.ok(start > 0, `${fn} must exist`);
    const body = trashSrc.slice(start, trashSrc.indexOf('\n}', start));

    // EVERY statement in the function, not just one. My first version matched
    // a single user_id clause anywhere in the body -- so removing the guard
    // from restoreBatch's SELECT left it green, because the DELETE further
    // down still had one. A function with two queries needs both checked.
    const statements = body.match(/`[^`]*(?:SELECT|INSERT|UPDATE|DELETE)[^`]*`/gi) || [];
    assert.ok(statements.length > 0, `${fn} should contain SQL`);
    for (const sql of statements) {
      if (/^`\s*(BEGIN|COMMIT|ROLLBACK)\s*`$/i.test(sql)) continue;
      assert.match(sql, /user_id (=|IS) \?/,
        `every query in ${fn} must filter by user_id -- ids come from the `
        + `client, and one unguarded statement is the whole hole`);
    }
  }
});

test('TRASH-TC7: a half-restored batch is impossible', () => {
  // He cannot tell which half came back without counting cardboard.
  assert.match(trashSrc, /await db\.run\('BEGIN'\)/);
  assert.match(trashSrc, /await db\.run\('COMMIT'\)/);
  assert.match(trashSrc, /ROLLBACK/);
});

test('TRASH-TC8: the delete response carries the batch id', () => {
  // Without it the client cannot offer an undo, and an undo nobody can reach
  // is the same as no undo.
  assert.match(routeSrc, /batch_id: batchId/,
    'the bulk delete must return the batch id');
  assert.match(routeSrc, /router\.post\('\/collection\/trash\/:batchId\/restore'/,
    'and there must be a route to act on it');
  assert.match(routeSrc, /router\.get\('\/collection\/trash'/,
    'plus a way to see what is recoverable');
});

test('TRASH-TC9: restoring a batch that is gone says so', () => {
  // Silently succeeding would leave him wondering where the cards went.
  assert.match(routeSrc, /That batch is no longer in the trash/,
    'a missing batch is a 404 with a plain message');
});

test('TRASH-TC10: carried columns are named, not SELECT *', () => {
  // The INSERT and its SELECT are positional twins. A new collection column
  // would be silently dropped on restore -- the card comes back subtly wrong,
  // which is worse than not coming back at all.
  assert.match(trashSrc, /const CARRIED = \[/);
  assert.doesNotMatch(trashSrc, /INSERT INTO collection_trash[\s\S]{0,200}SELECT \*/,
    'a wildcard here loses new columns silently');
});
