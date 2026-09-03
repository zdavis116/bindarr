const db = require('../db');

// DELETING CARDS, RECOVERABLY.
//
// Zach: "Delete should be undoable... a trash table and it stays alive in that
// table until we delete 3 batches. So on our 4th batch the 1st batch we
// deleted goes away."
//
// The row MOVES to collection_trash rather than gaining a deleted_at flag. 79
// places in the backend read the collection table; a flag would need every one
// to filter, and one miss leaves a deleted card still counting toward a deck's
// coverage or the collection value. A row that has moved out cannot be counted
// by a query that forgot about it.

const KEEP_BATCHES = 3;

// The columns that survive a round trip. Named explicitly rather than SELECT *
// so a new collection column fails loudly here instead of being silently
// dropped on restore -- this file has a positional twin in the INSERT below,
// and cardCatalogue.js already carries a scar from exactly that pattern.
const CARRIED = [
  'card_id', 'quantity', 'condition', 'printing', 'finish', 'purchase_price',
  'location_id', 'compartment_id', 'position', 'favorite', 'is_trade',
  'list_type', 'notes', 'added_at'
];

function newBatchId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Move rows into the trash and purge anything beyond the last KEEP_BATCHES.
// Returns the batch id so the caller can offer an undo.
async function trashEntries(entryIds, userId) {
  const ids = (entryIds || []).map(Number).filter(Number.isInteger);
  if (ids.length === 0) return { batchId: null, moved: 0 };

  const placeholders = ids.map(() => '?').join(',');
  const batchId = newBatchId();

  // Copy, then delete. Scoped by user_id on BOTH statements: a client can post
  // any id, and the copy must not be able to read another user's row even if
  // the delete would have refused it.
  await db.run(
    `INSERT INTO collection_trash
       (entry_id, batch_id, user_id, ${CARRIED.join(', ')})
     SELECT id, ?, user_id, ${CARRIED.join(', ')}
       FROM collection
      WHERE id IN (${placeholders}) AND user_id = ?`,
    [batchId, ...ids, userId]
  );

  const del = await db.run(
    `DELETE FROM collection WHERE id IN (${placeholders}) AND user_id = ?`,
    [...ids, userId]
  );

  await purgeOldBatches(userId);
  return { batchId, moved: del.changes };
}

// Keep the most recent KEEP_BATCHES for this user; drop the rest.
//
// Ordered by the batch's OWN newest row, not by batch_id string order. The id
// starts with a timestamp so they usually agree, but sorting a generated
// string is a coincidence to rely on, not a rule.
async function purgeOldBatches(userId) {
  const batches = await db.all(
    `SELECT batch_id, MAX(deleted_at) AS newest
       FROM collection_trash
      WHERE user_id IS ?
      GROUP BY batch_id
      ORDER BY newest DESC, batch_id DESC`,
    [userId]
  );
  if (batches.length <= KEEP_BATCHES) return 0;

  const doomed = batches.slice(KEEP_BATCHES).map(b => b.batch_id);
  const ph = doomed.map(() => '?').join(',');
  const res = await db.run(
    `DELETE FROM collection_trash WHERE batch_id IN (${ph}) AND user_id IS ?`,
    [...doomed, userId]
  );
  return res.changes;
}

// Put a batch back, with its original ids.
//
// collection_tags and deck_card_allocations reference collection.id, so a
// restore under a fresh id would silently drop those links. INSERT OR IGNORE
// on the id: if something already occupies it, the safe outcome is to leave
// the live row alone rather than overwrite it.
async function restoreBatch(batchId, userId) {
  const rows = await db.all(
    `SELECT * FROM collection_trash WHERE batch_id = ? AND user_id IS ?`,
    [batchId, userId]
  );
  if (rows.length === 0) return { restored: 0, skipped: 0 };

  let restored = 0;
  let skipped = 0;
  await db.run('BEGIN');
  try {
    for (const r of rows) {
      // The row is written back under the REQUESTING user's id, not the one
      // stored in the trash. The SELECT above already filtered by user, so
      // these always agree today -- but stating it here means the insert is
      // scoped on its own terms rather than inheriting safety from a query
      // twenty lines up that someone might later change.
      const result = await db.run(
        `INSERT OR IGNORE INTO collection
           (id, user_id, ${CARRIED.join(', ')})
         SELECT ?, ?, ${CARRIED.map(() => '?').join(', ')}
          WHERE EXISTS (SELECT 1 FROM collection_trash
                         WHERE entry_id = ? AND user_id IS ?)`,
        [r.entry_id, userId, ...CARRIED.map(c => r[c]), r.entry_id, userId]
      );
      if (result.changes > 0) restored += 1; else skipped += 1;
    }
    await db.run(
      `DELETE FROM collection_trash WHERE batch_id = ? AND user_id IS ?`,
      [batchId, userId]
    );
    await db.run('COMMIT');
  } catch (err) {
    // All or nothing: a half-restored batch is worse than none, because he
    // cannot tell which half came back without counting cardboard.
    await db.run('ROLLBACK').catch(() => {});
    throw err;
  }
  return { restored, skipped };
}

// What is currently recoverable, newest batch first.
async function listTrash(userId) {
  const batches = await db.all(
    `SELECT t.batch_id,
            MAX(t.deleted_at)        AS deleted_at,
            COUNT(*)                 AS rows,
            SUM(t.quantity)          AS copies,
            ROUND(SUM(COALESCE(cc.price_trend, 0) * t.quantity), 2) AS value
       FROM collection_trash t
       LEFT JOIN card_cache cc ON cc.id = t.card_id
      WHERE t.user_id IS ?
      GROUP BY t.batch_id
      ORDER BY deleted_at DESC`,
    [userId]
  );
  return batches;
}

module.exports = {
  KEEP_BATCHES, CARRIED,
  trashEntries, restoreBatch, purgeOldBatches, listTrash
};
