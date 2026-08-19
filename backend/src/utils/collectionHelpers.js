// Shared helpers for the collection/storage/import routes. Kept in one neutral
// module so the split route files (collection, storage, importExport) never have
// to import each other.
const db = require('../db');
const { recommendSlot, compartmentLabel, locationAcceptsCard } = require('./compartmentSort');
const { InvariantError } = require('./storageInvariants');

// Default compartment plan by container type — used when a caller doesn't
// specify one at creation time (see POST /locations).
function defaultCompartmentPlan(type) {
  if (type === 'Binder') return { count: 10, capacity: 9 };
  if (type === 'Toploader Binder') return { count: 8, capacity: 4 };
  if (type === 'Box') return { count: 2, capacity: 400 };
  if (type === 'Toploader Box') return { count: 1, capacity: 100 };
  if (type === 'Graded Slab Box') return { count: 1, capacity: 40 };
  if (type === 'Display Shelf / Stand') return { count: 1, capacity: 10 };
  if (type === 'Deck Box') return { count: 1, capacity: 60 };
  if (type === 'Tin / Case') return { count: 1, capacity: 200 };
  return { count: 1, capacity: 500 };
}

// Which collection rows are physically pulled for a checked-out deck.
//
// PR 6C changed this from DERIVED to STORED, and that is the whole point. It
// used to re-run a greedy allocation on every collection page load, which meant
// the "in a deck" badge could move from one copy to another because an
// unrelated card was added. Storage and the checkout wizard would then disagree
// about which physical card was in the deck box, and the user had no way to
// tell which one was lying.
//
// Now both read the same recorded rows, so they cannot disagree by
// construction.
async function checkedOutAllocation(userId, database) {
  const client = database || db;
  const rows = await client.all(`
    SELECT a.collection_entry_id AS entry_id, SUM(a.quantity) AS taken
    FROM deck_card_allocations a
    JOIN deck_cards dc ON a.deck_card_id = dc.id
    JOIN decks d ON dc.deck_id = d.id
    WHERE d.user_id = ? AND d.checked_out = 1
    GROUP BY a.collection_entry_id
  `, [userId]);
  return new Map(rows.map(r => [r.entry_id, r.taken]));
}


// Resolves where a card should actually land. Supports both object destructuring signature
// and positional (database, locationId, cardId, userId) signature for backwards compatibility.
async function resolveCompartmentAndPosition(arg1, locationId, cardId, userId) {
  let dbClient = db;
  let opts = {};
  if (typeof arg1 === 'object' && arg1 !== null && !(arg1.all || arg1.get || arg1.run)) {
    opts = arg1;
    // The object form is what every transactional route uses. Without a way to
    // hand it the active handle, all of its reads -- ownership, occupancy,
    // planner projection -- ran on the module-level `db` and therefore observed
    // a snapshot the caller's transaction never took. The route then reserved
    // capacity inside the transaction against a slot chosen outside it.
    if (opts.dbClient && (opts.dbClient.all || opts.dbClient.get || opts.dbClient.run)) {
      dbClient = opts.dbClient;
    }
  } else {
    if (arg1 && (arg1.all || arg1.get || arg1.run)) dbClient = arg1;
    opts = { locationId, cardId, userId };
  }

  const {
    locationId: locId,
    compartmentId,
    position,
    userId: uId,
    cardId: cId,
    printing,
    excludeEntryId
  } = opts;

  if (compartmentId !== undefined && compartmentId !== null) {
    // Read through the caller's handle. When this runs inside
    // db.withTransaction(tx => ...) the module-level `db` would read a snapshot
    // the transaction never took, so the placement decision would be made
    // against state the surrounding write was not serialized with.
    const compartment = await dbClient.get(`
      SELECT c.id, c.idx, c.label, c.capacity, l.id as loc_id, l.type as loc_type, l.name as loc_name FROM compartments c JOIN locations l ON c.location_id = l.id
      WHERE c.id = ? AND l.user_id = ?
    `, [compartmentId, uId]);
    if (!compartment) return { compartment_id: null, position: position !== undefined ? position : 0 };

    // Occupancy is SUM(quantity), not COUNT(*) -- the same definition
    // storageInvariants.compartmentOccupancy uses. COUNT(*) treats a stacked
    // row (import/legacy data) as a single card, so this planner would report
    // room that does not physically exist and hand out a slot the capacity
    // guard then has to refuse. Two disagreeing definitions of "how full" is
    // precisely the split this PR exists to close.
    let countQuery = `SELECT COALESCE(SUM(quantity), 0) as cnt FROM collection WHERE compartment_id = ? AND user_id = ?`;
    let countParams = [compartmentId, uId];
    if (excludeEntryId) {
      countQuery += ` AND id != ?`;
      countParams.push(excludeEntryId);
    }
    const countRow = await dbClient.get(countQuery, countParams);
    if (countRow.cnt >= compartment.capacity) {
      // Typed at the boundary where the condition is detected. This used to be a
      // bare `new Error('COMPARTMENT_FULL')`, which forced four route handlers to
      // compare `error.message` against a string literal to tell a legitimate
      // refusal from a genuine 500. A message is a human-facing field: rewording
      // it to something friendlier would silently turn every one of those
      // refusals into a 500. The code is the contract; the message is not.
      throw new InvariantError(400, 'COMPARTMENT_FULL', 'COMPARTMENT_FULL');
    }

    const label = `${compartmentLabel(compartment, compartment.loc_type)} (in ${compartment.loc_name})`;
    if (position !== undefined) return { compartment_id: compartmentId, position, label, location_id: compartment.loc_id };
    return { compartment_id: compartmentId, position: ((countRow?.cnt || 0) + 1) * 1000, label, location_id: compartment.loc_id };
  }
  if (!locId) {
    return { compartment_id: null, position: position !== undefined ? position : 0 };
  }

  // Also through the caller's handle, for the same reason as the compartment
  // read above: this is the ownership check that authorizes the destination.
  const location = await dbClient.get(`SELECT id, name, type, sort_order, foil_sorting, rule_type, rule_config, user_id FROM locations WHERE id = ? AND user_id = ?`, [locId, uId]);
  if (!location) return { compartment_id: null, position: 0 };

  let cardMetadata = await dbClient.get(`SELECT name, set_name, number, types, subtypes, price_trend, price_normal, price_holofoil, price_reverse_holofoil, supertype, rarity, cmc, color_identity FROM card_cache WHERE id = ?`, [cId]);
  if (!cardMetadata) cardMetadata = { name: cId || '', types: [] };
  cardMetadata.printing = printing || 'Normal';

  try { cardMetadata.types = JSON.parse(cardMetadata.types || '[]'); } catch { cardMetadata.types = []; }

  if (!locationAcceptsCard(location, cardMetadata)) {
    return { compartment_id: null, position: 0, rejected: true };
  }

  const recommended = await recommendSlot(dbClient, location, cardMetadata);
  if (!recommended) return null;
  return { compartment_id: recommended.compartment_id, position: recommended.position, location_id: recommended.location_id, label: recommended.label };
}

async function describePlacement(database, entryId, userId) {
  let dbClient = db;
  let eId = entryId;
  let uId = userId;

  if (typeof database === 'number') {
    eId = database;
    uId = entryId;
  } else if (database && (database.get || database.all)) {
    dbClient = database;
  }

  const row = await dbClient.get(`
    SELECT c.compartment_id, c.position, c.location_id,
           cp.idx, cp.label, l.type as loc_type, l.name as loc_name
    FROM collection c
    JOIN compartments cp ON c.compartment_id = cp.id
    JOIN locations l ON cp.location_id = l.id
    WHERE c.id = ? AND c.user_id = ?
  `, [eId, uId]);
  if (!row) return null;
  const seq = Math.max(1, Math.round((row.position || 0) / 1000));
  const label = `${compartmentLabel(row, row.loc_type)}, Pos ${seq} (in ${row.loc_name})`;
  return { location_id: row.location_id, compartment_id: row.compartment_id, position: row.position, label };
}

function normalizeRuleConfig(rule_config) {
  if (rule_config === undefined || rule_config === null || rule_config === '') return null;
  if (typeof rule_config === 'string') { JSON.parse(rule_config); return rule_config; }
  return JSON.stringify(rule_config);
}

async function getCompartmentOccupancy(database, compartmentId) {
  const dbClient = database || db;
  const row = await dbClient.get(
    `SELECT COALESCE(SUM(quantity), 0) AS total_cards FROM collection WHERE compartment_id = ?`,
    [compartmentId]
  );
  return row ? row.total_cards : 0;
}

// One physical card = one row. Split any legacy stacked entry (quantity > 1)
// into that many single-card rows so every copy takes its own storage slot,
// gets its own popup, and can be added to a deck individually. Idempotent:
// once run there are no quantity>1 rows, so a re-run is a no-op.
// ponytail: split copies keep the original's compartment with fractional
// position offsets (same as the add path). A page that overflows its capacity
// shows extra pockets; a manual re-sort redistributes if desired.
async function splitStackedEntries(database) {
  const dbClient = database || db;
  const stacked = await dbClient.all(`SELECT * FROM collection WHERE quantity > 1`);
  if (stacked.length === 0) return 0;
  let created = 0;
  for (const e of stacked) {
    const copies = e.quantity;
    await dbClient.run(`UPDATE collection SET quantity = 1 WHERE id = ?`, [e.id]);
    for (let i = 1; i < copies; i++) {
      await dbClient.run(`
        INSERT INTO collection (
          card_id, user_id, quantity, condition, printing, finish, purchase_price,
          location_id, compartment_id, position, is_trade, favorite, list_type
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        e.card_id, e.user_id, e.condition, e.printing, e.finish, e.purchase_price,
        e.location_id, e.compartment_id, (e.position || 0) + (i * 0.001), e.is_trade, e.favorite, e.list_type
      ]);
      created++;
    }
  }
  return created;
}

// HOW MANY COPIES OF EACH VARIANT ARE COMMITTED TO DECKS -- ACROSS ALL DECKS.
//
// THE BUG THIS FIXES. Browse Collection showed "In Deck: 1" while viewing the
// deck that held the card and "In Deck: 0" while viewing any other deck. Zach:
// "that in deck should reflect if it's in any deck otherwise it gives you a
// false idea if it's available or not."
//
// The old figure was computed CLIENT-SIDE from the open deck's own card list,
// so it could only ever describe one deck. That is not a display quirk -- it is
// the app asserting something FALSE about the user's physical collection:
// "Owned 6, In Deck 0" invites them to sleeve a card that is already in another
// deck box, and they discover it only when they go looking for it.
//
// So the figure moves to the SERVER, where the question can actually be
// answered, and it is computed the same way for every screen that shows it.
//
// IT COUNTS COPIES, NOT DECKS. Two copies in one deck and one in another is 3,
// not 2. A count of decks would understate the commitment and reintroduce the
// same false availability in a subtler form.
//
// KEYED ON (card_id, finish), which is the app's deck identity: a foil and a
// nonfoil of one printing are different physical objects that do not substitute
// for each other, so committing the foil must not make the nonfoil read as
// spoken for.
//
// RESERVING BOARDS ONLY. The 'considering' board is a shortlist -- it reserves
// nothing and competes with nobody -- so counting it would OVERSTATE the
// commitment and understate availability. That is the mirror image of the bug
// being fixed and just as false.
async function inDeckQuantities(userId, database) {
  const client = database || db;
  const rows = await client.all(`
    SELECT dc.desired_card_id AS card_id, dc.desired_finish AS finish,
           SUM(dc.quantity) AS qty
    FROM deck_cards dc
    JOIN decks d ON dc.deck_id = d.id
    WHERE d.user_id = ? AND dc.board IN ('commander', 'mainboard', 'sideboard')
    GROUP BY dc.desired_card_id, dc.desired_finish
  `, [userId]);
  return new Map(rows.map(r => [`${r.card_id}|${r.finish}`, r.qty]));
}

module.exports = {
  getCompartmentOccupancy,
  defaultCompartmentPlan,
  checkedOutAllocation,
  inDeckQuantities,
  resolveCompartmentAndPosition,
  describePlacement,
  normalizeRuleConfig,
  splitStackedEntries,
};
