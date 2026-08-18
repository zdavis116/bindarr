const express = require('express');
const db = require('../db');
const scryfallApi = require('../scryfallApi');
const scanMatch = require('../scanMatch');
const setIndex = require('../setIndex');

const { authenticateToken, searchLimiter } = require('../middleware/auth');
const { resolveCardPrice, parseCardRow, recordPrice } = require('../utils/priceHelpers');
const { parseSetList } = require('../utils/setQuery');
const { compartmentLabel, isBinderType, rebalanceCompartmentByScheme } = require('../utils/compartmentSort');
const { checkedOutAllocation, resolveCompartmentAndPosition, describePlacement } = require('../utils/collectionHelpers');
const { splitPrice } = require('../utils/splitPrice');
const commanderRules = require('../utils/commanderRules');
const { FinishError, finishColumnsFromBody } = require('../utils/finishes');
const {
  InvariantError,
  requireOwnedCompartment,
  requireOwnedLocation,
  assertCapacityFor
} = require('../utils/storageInvariants');
const {
  RequestBoundsError,
  positiveInteger,
  requireArray,
  uniqueIntegerIds,
  boundedProduct
} = require('../utils/requestBounds');

const router = express.Router();

router.use(authenticateToken);

// Stamp each result with how many copies the user already owns, so browsing a
// set shows what is already in the binder instead of inviting duplicate adds.
// A collection-scope search already reports owned_qty from its own join.
async function attachOwnedQty(cards, userId) {
  if (!Array.isArray(cards) || cards.length === 0 || !userId) return;
  const ids = cards.map(c => c.id).filter(Boolean);
  if (ids.length === 0) return;
  const rows = await db.all(
    `SELECT card_id, SUM(quantity) AS qty FROM collection
     WHERE user_id = ? AND list_type = 'collection' AND card_id IN (${ids.map(() => '?').join(',')})
     GROUP BY card_id`,
    [userId, ...ids]
  );
  const owned = new Map(rows.map(r => [r.card_id, r.qty]));
  for (const c of cards) c.owned_qty = owned.get(c.id) || 0;
}

// 1. Search English MTG cards through Scryfall.
router.get('/search', searchLimiter, async (req, res) => {
  const { name, number, set, scope = 'database', prints } = req.query;
  // 1-based page over `limit`-sized pages.
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(250, Math.max(1, parseInt(req.query.limit, 10) || 60));
  try {
    const { cards, total } = await scryfallApi.searchCards(name, number, set, scope, req.user.id, 'en', prints === '1', page, limit);
    await attachOwnedQty(cards, req.user.id);
    // Header, not the body: every existing caller expects a bare array here.
    if (total != null) {
      res.set('X-Total-Count', String(total));
      res.set('Access-Control-Expose-Headers', 'X-Total-Count');
    }
    res.json(cards);
  } catch (error) {
    console.error(error);
    if (error.message === 'INVALID_API_KEY') {
      return res.status(403).json({ error: 'Invalid API Key' });
    }
    if (error.message === 'RATE_LIMIT_EXCEEDED') {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    if (error.message === 'UPSTREAM_UNAVAILABLE') {
      return res.status(503).json({ error: 'Card API is having trouble. Try again in a moment.' });
    }
    res.status(500).json({ error: 'Search failed' });
  }
});

// 1b. Identify a scanned card image by CLIP embedding similarity.
router.post('/scan-match', searchLimiter, async (req, res) => {
  try {
    const { image, set = '', recallK, orb } = req.body || {};
    const game = 'mtg';
    const lang = 'en';
    if (!image || typeof image !== 'string') return res.status(400).json({ error: 'Missing image' });
    const base64 = image.includes(',') ? image.slice(image.indexOf(',') + 1) : image;
    const buf = Buffer.from(base64, 'base64');
    if (buf.length < 100) return res.status(400).json({ error: 'Invalid image data' });
    const result = await scanMatch.match(buf, game, 8, set, { recallK, orb, lang });
    if (result.candidates && result.candidates.length > 0) {
      const hydrated = await Promise.all(result.candidates.map(async (cand) => {
        let row = null;
        if (cand.set && cand.number) {
          row = await db.get(
            `SELECT * FROM card_cache WHERE (set_id = ? OR LOWER(set_name) = LOWER(?)) AND number = ? LIMIT 1`,
            [cand.set, cand.set, cand.number]
          );
        }
        if (!row && cand.name) {
          row = await db.get(
            `SELECT * FROM card_cache WHERE LOWER(name) = LOWER(?) LIMIT 1`,
            [cand.name]
          );
        }
        return row ? { ...cand, card: parseCardRow(row) } : cand;
      }));
      result.candidates = hydrated;
    }
    res.json(result);
  } catch (error) {
    console.error('scan-match failed:', error.message);
    res.status(500).json({ error: 'Scan match failed' });
  }
});

// Build/verify a per-set ORB index
router.post('/prepare-set', searchLimiter, async (req, res) => {
  try {
    const { set } = req.body || {};
    const game = 'mtg';
    const lang = 'en';
    const supported = true;
    const sets = parseSetList(set);
    if (!supported || !sets.length) return res.json({ ready: false, supported });
    const pending = sets.filter(s => !setIndex.isReady(game, s, lang));
    if (pending.length === 0) return res.json({ ready: true });

    // A set that cannot be built (no such set for this language, or the provider
    // has no card data for it) has to be reported, not polled forever. Without
    // this the client sat on "fetching card list" indefinitely while every poll
    // kicked off another doomed build.
    const failures = pending
      .map(s => ({ set: s, error: setIndex.buildFailed(game, s, lang) }))
      .filter(f => f.error);
    const buildable = pending.filter(s => !setIndex.buildFailed(game, s, lang));
    if (buildable.length === 0) {
      return res.json({ ready: false, building: false, failed: true, failures, error: failures[0].error });
    }

    buildable.forEach(s => setIndex.ensureSet(game, s, lang).catch(() => {}));
    // Report the first still-building set's progress for the UI bar, plus any
    // sets in the list that already failed (a multi-set scan can be part ready).
    res.json({ ready: false, building: true, progress: setIndex.setProgress(game, buildable[0], lang), pending: buildable, failures });
  } catch (error) {
    console.error('prepare-set failed:', error.message);
    res.status(500).json({ error: 'Prepare set failed' });
  }
});

// 2. Get User's Collection
router.get('/collection', async (req, res) => {
  try {
    const listType = req.query.list_type || 'collection';
    const isTrade = req.query.is_trade;
    const compId = req.query.compartment_id;

    let filterSql = `WHERE c.user_id = ? AND c.list_type = ?`;
    let filterParams = [req.user.id, listType];

    if (isTrade !== undefined) {
      filterSql += ` AND c.is_trade = ?`;
      filterParams.push(isTrade === 'true' || isTrade === '1' ? 1 : 0);
    }
    if (compId !== undefined) {
      filterSql += ` AND c.compartment_id = ?`;
      filterParams.push(compId);
    }

    const query = `
      SELECT
        c.id as entry_id,
        c.card_id,
        c.quantity,
        c.condition,
        c.printing,
        c.finish,
        c.purchase_price,
        c.compartment_id,
        c.position,
        c.added_at,
        c.is_trade,
        c.favorite,
        c.list_type,
        c.notes,
        cc.name,
        cc.oracle_id,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.type_line,
        cc.cmc,
        cc.color_identity,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil,
        cc.price_reverse_holofoil,
        cc.tcgplayer_url,
        cc.cardmarket_url,
        l.id as location_id,
        l.name as location_name,
        l.type as location_type,
        cp.idx as compartment_idx,
        cp.label as compartment_label,
        cp.capacity as compartment_capacity
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN compartments cp ON c.compartment_id = cp.id
      ${filterSql}
      ORDER BY c.added_at DESC
    `;
    const rows = await db.all(query, filterParams);

    const alloc = await checkedOutAllocation(req.user.id);

    const formatted = rows.map(row => ({
      ...parseCardRow(row),
      price_trend: resolveCardPrice(row),
      checked_out_qty: alloc.get(row.entry_id) || 0,
      compartment_display_label: row.compartment_id
        ? compartmentLabel({ idx: row.compartment_idx, label: row.compartment_label }, row.location_type)
        : null,
      sub_location: row.compartment_id
        ? `${row.location_type === 'Binder' ? 'Page' : 'Row'} ${row.compartment_idx}`
        : ''
    }));

    res.json(formatted);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch collection' });
  }
});

// Shared by the single add below and the bulk add after it, so one card and two
// hundred cards travel exactly the same path (cache lookup, compartment
// resolution, rebalance, price history). Throws AddCardError for caller-visible
// failures; anything else is a genuine 500.
class AddCardError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function addCardToCollection(user, body) {
  const {
    card_id,
    quantity = 1,
    condition = 'Near Mint',
    purchase_price = 0,
    location_id = null,
    list_type = 'collection',
    is_trade = 0,
    stackable = false
  } = body;
  const req = { user, body };

  // Resolve the finish ONCE, at the boundary, into the two columns to write.
  //
  // `finish` is authoritative (deck identity matches on it); `printing` is its
  // display mirror. Deriving both here rather than at each INSERT is what keeps
  // them from drifting -- and writing `finish` at all is what was missing:
  // every add previously left it on the column default, so a foil that DID get
  // stored still claimed to be nonfoil. An unrecognised value throws rather
  // than defaulting, so a finish the app cannot represent is refused instead of
  // silently recorded as something the card is not.
  const { finish, printing } = finishColumnsFromBody(body);

  if (!card_id) {
    throw new AddCardError(400, 'card_id is required');
  }

  // The card_cache lookup and any Scryfall fallback happen BEFORE the
  // transaction. A network call inside a transaction would hold SQLite's write
  // lock for the duration of an upstream request, stalling every other writer
  // behind an external dependency's latency.
  let card = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [card_id]);
  if (!card) {
    try {
      card = await scryfallApi.getCardById(card_id);
    } catch (error) {
      if (error.code === 'NON_ENGLISH_PRINTING') {
        throw new AddCardError(400, 'Only English card printings are supported.');
      }
      throw error;
    }
    if (!card) {
      throw new AddCardError(404, `Card ID ${card_id} not found.`);
    }
  }

  const count = quantity;

  // Placement resolution, the capacity reservation and every insert run in one
  // transaction. Resolving a slot outside the transaction and inserting inside
  // it is the race T5 covers: two callers resolve the same free slot before
  // either writes.
  const result = await db.withTransaction(async (tx) => {
    if (location_id) {
      await requireOwnedLocation(tx, location_id, req.user.id);
    }

    // Normalize the helper's "nowhere to put this" signal. It returns null when
    // every compartment (including overflow locations) is full, but an object
    // with a null compartment_id in other no-placement cases. Collapsing both
    // into one shape here keeps the rest of this function free of null guards.
    const resolved = (await resolveCompartmentAndPosition({
      dbClient: tx,
      locationId: location_id,
      userId: req.user.id,
      cardId: card_id,
      printing
    })) || { compartment_id: null, position: 0, full: true };

    const targetLocationId = resolved.compartment_id ? (resolved.location_id ?? location_id) : null;

    // Reserve all `count` copies against the destination before writing any of
    // them, so a partially-fitting add is refused outright instead of filing
    // some copies and overflowing on the rest.
    if (resolved.compartment_id) {
      const compartment = await requireOwnedCompartment(tx, resolved.compartment_id, req.user.id);
      // `count` slots either way: a stackable row of N occupies N physical
      // slots, and N unstacked rows occupy N.
      await assertCapacityFor(tx, compartment, count);
    }

    let lastInsertedId = null;

    if (stackable) {
      const inserted = await tx.run(`
        INSERT INTO collection (
          card_id, user_id, quantity, condition, printing, finish, purchase_price,
          location_id, compartment_id, position, is_trade, list_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        card_id, req.user.id, count, condition, printing, finish, purchase_price || 0,
        targetLocationId, resolved.compartment_id, resolved.position, is_trade ? 1 : 0, list_type
      ]);
      lastInsertedId = inserted.lastID;
    } else {
      for (let i = 0; i < count; i++) {
        const inserted = await tx.run(`
          INSERT INTO collection (
            card_id, user_id, quantity, condition, printing, finish, purchase_price,
            location_id, compartment_id, position, is_trade, list_type
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          card_id, req.user.id, condition, printing, finish, purchase_price || 0,
          targetLocationId, resolved.compartment_id, resolved.position + (i * 0.001), is_trade ? 1 : 0, list_type
        ]);
        lastInsertedId = inserted.lastID;
      }
    }

    if (resolved.compartment_id && targetLocationId) {
      const loc = await tx.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [targetLocationId, req.user.id]);
      if (loc) {
        // Pass `tx`, not the module-level `db`. Both happen to work today --
        // `db.run` inside a transaction is routed onto the active transaction
        // via AsyncLocalStorage -- but relying on that ambient behavior means
        // the correctness of this call depends on an invisible context rather
        // than on what the code says. Any future refactor that moves this off
        // the ALS-tracked call path (a queue hop, a worker, a .then boundary)
        // would silently turn it into an out-of-transaction write.
        await rebalanceCompartmentByScheme(tx, resolved.compartment_id, loc.sort_order, loc.foil_sorting);
      }
    }

    return {
      message: 'Card added to collection',
      id: lastInsertedId,
      placement: resolved.compartment_id
        ? await describePlacement(tx, lastInsertedId, req.user.id)
        : null,
      container_full: !!resolved.full,
      rule_rejected: !!resolved.rejected
    };
  });

  // Price history is deliberately outside the transaction: it is derived
  // telemetry, not part of the collection invariant, and a price-write failure
  // must not roll back a legitimate add.
  await recordPrice(card_id, card.price_trend);

  return result;
}

// 3. Add Card to Collection
router.post('/collection', async (req, res) => {
  try {
    const body = { ...req.body };
    body.quantity = positiveInteger(body.quantity === undefined ? 1 : body.quantity, { name: 'quantity', max: 1000 });
    res.status(200).json(await addCardToCollection(req.user, body));
  } catch (error) {
    if (error instanceof AddCardError || error instanceof RequestBoundsError || error instanceof InvariantError || error instanceof FinishError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Failed to add card' });
  }
});

// 3b. Bulk add: one shared condition/printing/quantity across many cards, so a
// set browse can be added in one action instead of one drawer per card.
const BULK_ADD_MAX = 250;
router.post('/collection/bulk-add', async (req, res) => {
  const { card_ids, ...shared } = req.body;
  try {
    requireArray(card_ids, { name: 'card_ids', minLength: 1, maxLength: BULK_ADD_MAX });
    if (card_ids.some(id => typeof id !== 'string' || !id) || new Set(card_ids).size !== card_ids.length) {
      throw new RequestBoundsError(400, 'card_ids must contain unique non-empty card IDs');
    }
    shared.quantity = positiveInteger(shared.quantity === undefined ? 1 : shared.quantity, { name: 'quantity', max: 1000 });
    boundedProduct([card_ids.length, shared.quantity], { name: 'expanded operations', max: 1000 });
  } catch (error) {
    if (error instanceof RequestBoundsError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
  // Sequential on purpose: placement resolves against the rows already inserted,
  // so adds must not race each other for the same compartment slot.
  const added = [];
  const failed = [];
  for (const card_id of card_ids) {
    try {
      const result = await addCardToCollection(req.user, { ...shared, card_id });
      added.push({ card_id, id: result.id });
    } catch (error) {
      if (!(error instanceof AddCardError) && !(error instanceof FinishError)) console.error(error);
      failed.push({
        card_id,
        error: (error instanceof AddCardError || error instanceof FinishError)
          ? error.message
          : 'Failed to add card'
      });
    }
  }
  const qty = shared.quantity;
  res.status(failed.length && !added.length ? 500 : 200).json({
    message: failed.length
      ? `Added ${added.length} of ${card_ids.length} cards; ${failed.length} failed.`
      : `Added ${added.length} card${added.length === 1 ? '' : 's'}${qty > 1 ? ` (x${qty} each)` : ''} to collection.`,
    added: added.length,
    failed
  });
});

// 4. Update Collection Entry
router.put('/collection/:id', async (req, res) => {
  const { id } = req.params;
  const {
    quantity, condition, printing, purchase_price,
    location_id, compartment_id, list_type, is_trade, favorite, notes
  } = req.body;

  try {
    const requestedQty = quantity !== undefined
      ? positiveInteger(quantity, { name: 'quantity', max: 1000 })
      : 1;

    // The whole edit is one transaction. Placement resolution, the column
    // update, both rebalances and the auto-split inserts are steps of a single
    // logical mutation; running them as independent statements meant a failure
    // in any later step left the earlier ones committed. Capacity is also read
    // inside the transaction, which is what makes the check-then-write pair
    // atomic against a concurrent request (PR 6A uses BEGIN IMMEDIATE, so
    // transactions serialize and the loser observes the winner's rows).
    const outcome = await db.withTransaction(async (tx) => {
      const entry = await tx.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      if (!entry) throw new InvariantError(404, 'Collection entry not found', 'ENTRY_NOT_FOUND');

      const isMoving = location_id !== undefined && location_id !== entry.location_id;
      let finalCompartmentId = entry.compartment_id;
      let finalLocationId = entry.location_id;
      let finalPosition = entry.position;
      let resolvedFull = false;
      let resolvedRejected = false;
      let targetCompartment = null;

      if (isMoving) {
        if (location_id === null || location_id === '') {
          finalLocationId = null;
          finalCompartmentId = null;
          finalPosition = 0;
        } else {
          // Authorize the destination before asking the placement engine to
          // find a slot in it.
          await requireOwnedLocation(tx, location_id, req.user.id);
          const resolved = (await resolveCompartmentAndPosition({
            dbClient: tx,
            locationId: location_id,
            userId: req.user.id,
            cardId: entry.card_id,
            printing: printing !== undefined ? printing : entry.printing
          })) || { compartment_id: null, position: 0, full: true };
          finalCompartmentId = resolved.compartment_id;
          finalLocationId = resolved.compartment_id ? (resolved.location_id ?? location_id) : null;
          finalPosition = resolved.position;
          resolvedFull = !!resolved.full;
          resolvedRejected = !!resolved.rejected;
          if (finalCompartmentId) {
            targetCompartment = await requireOwnedCompartment(tx, finalCompartmentId, req.user.id);
          }
        }
      } else if (compartment_id !== undefined) {
        // A bare compartment_id from the body is attacker-controlled. Resolve it
        // through the ownership check and adopt its true parent location rather
        // than trusting the pair the client sent.
        if (compartment_id === null || compartment_id === '') {
          finalCompartmentId = null;
          finalLocationId = null;
          finalPosition = 0;
        } else {
          targetCompartment = await requireOwnedCompartment(tx, compartment_id, req.user.id);
          finalCompartmentId = targetCompartment.id;
          finalLocationId = targetCompartment.location_id;
        }
      } else if (finalCompartmentId) {
        targetCompartment = await requireOwnedCompartment(tx, finalCompartmentId, req.user.id);
      }

      // Reserve every slot this request will consume, up front, before any
      // write. `requestedQty` copies land in the destination; the edited row
      // itself is excluded from the occupancy count when it already sits there,
      // otherwise moving a card into its own compartment would count it twice.
      if (targetCompartment) {
        await assertCapacityFor(tx, targetCompartment, requestedQty, { excludeEntryId: entry.id });
      }

      const updates = [];
      const params = [];

      // One physical card = one row. The edited entry always stays quantity 1;
      // a quantity > 1 in the payload means "make this many copies" and is
      // fulfilled below by inserting extra single-card rows (auto-split).
      if (quantity !== undefined) { updates.push('quantity = ?'); params.push(1); }
      if (condition !== undefined) { updates.push('condition = ?'); params.push(condition); }
      // Both finish columns move together or neither does. Writing only the
      // display mirror here would leave `finish` -- the value deck identity
      // matches on -- describing the card the user just said it is not.
      if (printing !== undefined || req.body.finish !== undefined) {
        const columns = finishColumnsFromBody({ printing, finish: req.body.finish });
        updates.push('printing = ?', 'finish = ?');
        params.push(columns.printing, columns.finish);
      }

      if (purchase_price !== undefined) { updates.push('purchase_price = ?'); params.push(purchase_price); }
      if (isMoving || compartment_id !== undefined) {
        updates.push('location_id = ?', 'compartment_id = ?', 'position = ?');
        params.push(finalLocationId, finalCompartmentId, finalPosition);
      }
      if (list_type !== undefined) { updates.push('list_type = ?'); params.push(list_type); }
      if (is_trade !== undefined) { updates.push('is_trade = ?'); params.push(is_trade ? 1 : 0); }
      if (favorite !== undefined) { updates.push('favorite = ?'); params.push(favorite ? 1 : 0); }
      if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }

      if (updates.length > 0) {
        params.push(id, req.user.id);
        await tx.run(`UPDATE collection SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
      }

      if (isMoving && finalCompartmentId && finalLocationId) {
        const loc = await tx.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [finalLocationId, req.user.id]);
        if (loc) await rebalanceCompartmentByScheme(tx, finalCompartmentId, loc.sort_order, loc.foil_sorting);
      }
      if (isMoving && entry.compartment_id && entry.compartment_id !== finalCompartmentId) {
        const oldLoc = await tx.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [entry.location_id, req.user.id]);
        if (oldLoc) await rebalanceCompartmentByScheme(tx, entry.compartment_id, oldLoc.sort_order, oldLoc.foil_sorting);
      }

      // Auto-split: create the extra copies as their own single-card rows, mirroring
      // the edited entry's final placement so each copy occupies its own slot.
      if (requestedQty > 1) {
        const row = await tx.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        if (row) {
          for (let i = 1; i < requestedQty; i++) {
            await tx.run(`
              INSERT INTO collection (
                card_id, user_id, quantity, condition, printing, finish, purchase_price,
                location_id, compartment_id, position, is_trade, favorite, list_type
              ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
              row.card_id, req.user.id, row.condition, row.printing, row.finish, row.purchase_price,
              row.location_id, row.compartment_id, (row.position || 0) + i * 0.001, row.is_trade, row.favorite, row.list_type
            ]);
          }
          if (row.compartment_id && row.location_id) {
            const loc = await tx.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [row.location_id, req.user.id]);
            if (loc) await rebalanceCompartmentByScheme(tx, row.compartment_id, loc.sort_order, loc.foil_sorting);
          }
        }
      }

      const finalPlacement = isMoving && finalCompartmentId ? await describePlacement(tx, id, req.user.id) : null;
      return { placement: finalPlacement, container_full: resolvedFull, rule_rejected: resolvedRejected };
    });

    res.json({ message: 'Collection entry updated successfully', ...outcome });
  } catch (error) {
    if (error instanceof RequestBoundsError || error instanceof InvariantError || error instanceof FinishError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// 4b. Manual tap-to-place (Custom order)
router.post('/collection/:id/place', async (req, res) => {
  const { id } = req.params;
  const { compartment_id, slot, swap_with } = req.body;
  try {
    // Manual placement moves one or two physical cards between slots. Both the
    // swap and the single-place branch are multi-statement, so the whole handler
    // runs in one transaction: a swap that updated one card and then failed left
    // two cards occupying the same slot.
    const result = await db.withTransaction(async (tx) => {
      const entry = await tx.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      if (!entry) throw new InvariantError(404, 'Collection entry not found', 'ENTRY_NOT_FOUND');

      const comp = await requireOwnedCompartment(tx, compartment_id, req.user.id);
      if (comp.sort_order !== 'custom') {
        throw new InvariantError(400, 'Manual placement is only available in Custom order', 'NOT_CUSTOM_ORDER');
      }

      const isBinder = isBinderType(comp.loc_type);

      if (swap_with) {
        const other = await tx.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [swap_with, req.user.id]);
        if (!other) throw new InvariantError(400, 'Swap target not found', 'SWAP_TARGET_NOT_FOUND');
        // A swap exchanges two existing placements, so it is capacity-neutral
        // and needs no reservation -- but the target's compartment must still
        // belong to the caller, or a swap becomes a way to write an arbitrary
        // compartment_id onto one's own row.
        if (other.compartment_id) {
          await requireOwnedCompartment(tx, other.compartment_id, req.user.id);
        }
        await tx.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
          [other.compartment_id, other.location_id, other.position, id, req.user.id]);
        await tx.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
          [entry.compartment_id, entry.location_id, entry.position, swap_with, req.user.id]);
        return { message: 'Cards swapped', placement: await describePlacement(tx, id, req.user.id) };
      }

      if (!Number.isInteger(slot) || slot < 1) {
        throw new InvariantError(400, 'Invalid slot', 'INVALID_SLOT');
      }

      // Only an incoming card consumes a slot; repositioning within the same
      // compartment does not. Capacity is read inside the transaction so a
      // concurrent add cannot claim the same last slot.
      //
      // Reserve the row's ACTUAL quantity, not a hardcoded 1. Occupancy is
      // defined as SUM(quantity) (see compartmentOccupancy), but this call site
      // reserved a single slot regardless of how many copies the row carried.
      // The UPDATE below moves the WHOLE row, so a stacked entry of quantity 3
      // consumed three slots while reserving one -- the compartment ends up
      // holding more cards than its capacity permits, and every later guard
      // then compares against a capacity the database has already violated.
      // Bindarr's normal path keeps one card per row, which is exactly why no
      // test caught this: stacked rows arrive from legacy data and imports, so
      // the defect is invisible until it hits precisely the data it corrupts.
      if (entry.compartment_id !== comp.id) {
        await assertCapacityFor(tx, comp, entry.quantity || 1, { excludeEntryId: entry.id });
      }

      const sourceComp = entry.compartment_id;
      if (isBinder) {
        await tx.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
          [comp.id, comp.loc_id, slot * 1000, id, req.user.id]);
      } else {
        await tx.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
          [comp.id, comp.loc_id, slot * 1000 - 500, id, req.user.id]);
        await rebalanceCompartmentByScheme(tx, comp.id, 'custom', null);
      }

      if (sourceComp && sourceComp !== comp.id) {
        const src = await tx.get(`SELECT l.type AS loc_type FROM compartments c JOIN locations l ON c.location_id = l.id WHERE c.id = ?`, [sourceComp]);
        if (src && !isBinderType(src.loc_type)) {
          await rebalanceCompartmentByScheme(tx, sourceComp, 'custom', null);
        }
      }

      return { message: 'Card placed', placement: await describePlacement(tx, id, req.user.id) };
    });

    res.json(result);
  } catch (error) {
    if (error instanceof RequestBoundsError || error instanceof InvariantError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Failed to place card' });
  }
});

// 5. Delete Card from Collection
router.delete('/collection/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Collection entry not found' });
    }
    res.json({ message: 'Card removed from collection' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to remove card' });
  }
});

// 5b. Bulk actions
const BULK_ACTIONS = ['delete', 'move', 'trade', 'untrade', 'list_type', 'condition', 'printing', 'purchase_split', 'add_to_deck'];
// Allowed field values mirror the collection table CHECK constraints in db.js.
// Finish values are NOT listed here: utils/finishes.js owns that vocabulary, so
// there is one place to change when Magic gains a finish rather than a list per
// route that silently goes stale.
const BULK_CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
router.post('/collection/bulk', async (req, res) => {
  // `confirm` applies ONLY to add_to_deck: it is the user having seen the
  // pre-flight report and chosen to proceed with the applicable part of their
  // selection. Every other bulk action ignores it.
  const { entry_ids = [], action, value, confirm = false } = req.body;
  let ids;
  try {
    ids = uniqueIntegerIds(entry_ids, { name: 'entry_ids', maxLength: 1000 });
  } catch (error) {
    if (error instanceof RequestBoundsError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
  if (!BULK_ACTIONS.includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  const placeholders = ids.map(() => '?').join(',');

  try {
    if (action === 'add_to_deck') {
      const deckId = parseInt(value, 10);
      if (!deckId) return res.status(400).json({ error: 'Invalid deck_id' });
      // The deck's FORMAT is read, not just its existence. This route writes
      // deck requirements, so it is subject to the Commander singleton rule
      // like every other write path, and the rule is gated on format.
      const deck = await db.get(`SELECT id, format FROM decks WHERE id = ? AND user_id = ?`, [deckId, req.user.id]);
      if (!deck) return res.status(404).json({ error: 'Deck not found' });

      // Group by the EXACT variant, not by card_id.
      //
      // This path is "add these cards I am looking at to a deck", and under
      // exact-only identity the selected collection rows already state their
      // own printing and finish -- so the requirement can be created without
      // ever guessing. Grouping by card_id alone would merge a nonfoil and a
      // foil copy into one requirement and silently drop one of the two
      // finishes the user actually selected.
      const rows = await db.all(
        `SELECT c.card_id, c.finish, cc.oracle_id, SUM(c.quantity) AS total_qty
         FROM collection c
         JOIN card_cache cc ON c.card_id = cc.id
         WHERE c.id IN (${placeholders}) AND c.user_id = ?
         GROUP BY c.card_id, c.finish, cc.oracle_id`,
        [...ids, req.user.id]
      );

      let added = 0;
      const skipped = [];

      // VALIDATE THE WHOLE SELECTION BEFORE WRITING ANY OF IT.
      //
      // Zach, 2026-08-18: "if its taking in a list it should verify the list
      // before adding and giving you errors if the list has issues like
      // duplicates or something."
      //
      // This replaces an earlier report-and-skip: the batch applied what it
      // could and named the refusals afterwards. That was not wrong about the
      // deck -- the rows always came out legal -- but it was wrong about the
      // USER, who discovered the problem only once part of their selection had
      // already been written, and could not tell which part.
      //
      // So this behaves like the import pre-flight, and it does so by CALLING
      // it rather than by growing a second copy: commanderRules.preflightDeckAdds
      // is the one implementation of "judge these many candidates against one
      // snapshot". One rule, one implementation, no drift.
      //
      // `confirm` is the user having SEEN the report and chosen to proceed --
      // the same shape as the import compare screen's apply step. Refused
      // cards are still named in that case, never silently dropped.
      const candidates = rows
        .filter(row => row.oracle_id)
        .map(row => ({ card_id: row.card_id, finish: row.finish, quantity: row.total_qty }));
      for (const row of rows) {
        if (!row.oracle_id) skipped.push(`${row.card_id} is missing Oracle identity`);
      }

      const preflight = await commanderRules.preflightDeckAdds(db, deck, candidates);
      const problems = [
        ...skipped.map(message => ({ code: 'CARD_UNKNOWN', message })),
        ...preflight.problems
      ];

      if (problems.length > 0 && !confirm) {
        // NOTHING HAS BEEN WRITTEN. This is a report, not a failure: the user
        // is being shown what will happen before it happens, and may send the
        // same request back with confirm:true to apply the rest.
        return res.status(409).json({
          error: problems[0].message,
          code: 'BULK_ADD_PREFLIGHT',
          problems,
          applicable: preflight.applicable,
          message: `${preflight.applicable} card(s) can be added; `
            + `${problems.length} cannot. Nothing has been added yet.`
        });
      }

      // One transaction for the whole batch: a partial add leaves the deck in a
      // state the user never asked for and cannot tell apart from success.
      await db.withTransaction(async (tx) => {
        for (const candidate of preflight.accepted) {
          const source = rows.find(
            r => r.card_id === candidate.card_id && r.finish === candidate.finish
          );
          const existing = await tx.get(
            `SELECT quantity FROM deck_cards
             WHERE deck_id = ? AND desired_card_id = ? AND desired_finish = ? AND board = 'mainboard'`,
            [deckId, candidate.card_id, candidate.finish]
          );
          const newQty = (existing ? existing.quantity : 0) + candidate.quantity;
          // Still written through commanderRules.writeDeckCard, the single
          // choke point every deck_cards write passes through. The pre-flight
          // above should mean this never refuses -- and that is exactly why it
          // stays. If the two ever disagree, the write throws and the whole
          // batch rolls back, rather than the deck quietly absorbing the
          // disagreement.
          await commanderRules.writeDeckCard(tx, deck, {
            oracle_id: source.oracle_id,
            desired_card_id: candidate.card_id,
            desired_finish: candidate.finish,
            board: 'mainboard',
            quantity: newQty
          });
          added += candidate.quantity;
        }
      });

      // Ownership is no longer a gate here (PR 6C requirement 5): adding a card
      // to a deck is a planning action and never fails on inventory. Shortfalls
      // surface as warnings on the deck view, and checkout is where physical
      // availability is actually enforced.
      const msg = problems.length
        ? `Added ${added} card(s). ${problems[0].message}`
        : `Added ${added} card(s) to deck`;
      return res.json({
        message: msg, affected: added, rejected: problems.length, problems
      });

    }

    if (action === 'delete') {
      const result = await db.run(`DELETE FROM collection WHERE id IN (${placeholders}) AND user_id = ?`, [...ids, req.user.id]);
      return res.json({ message: `Deleted ${result.changes} card(s)`, affected: result.changes });
    }

    if (action === 'trade' || action === 'untrade') {
      const result = await db.run(`UPDATE collection SET is_trade = ? WHERE id IN (${placeholders}) AND user_id = ?`, [action === 'trade' ? 1 : 0, ...ids, req.user.id]);
      return res.json({ message: `Updated ${result.changes} card(s)`, affected: result.changes });
    }

    if (action === 'list_type') {
      if (!['collection', 'wishlist'].includes(value)) return res.status(400).json({ error: 'Invalid list_type' });
      const result = await db.run(`UPDATE collection SET list_type = ? WHERE id IN (${placeholders}) AND user_id = ?`, [value, ...ids, req.user.id]);
      return res.json({ message: `Moved ${result.changes} card(s) to ${value}`, affected: result.changes });
    }

    if (action === 'condition' || action === 'printing') {
      if (action === 'condition') {
        if (!BULK_CONDITIONS.includes(value)) return res.status(400).json({ error: 'Invalid condition' });
        const result = await db.run(
          `UPDATE collection SET condition = ? WHERE id IN (${placeholders}) AND user_id = ?`,
          [value, ...ids, req.user.id]
        );
        return res.json({ message: `Set condition on ${result.changes} card(s)`, affected: result.changes });
      }

      // Changing the finish in bulk must move BOTH columns together.
      //
      // This previously wrote only `printing`, the display mirror, leaving
      // `finish` untouched. Since deck identity matches on `finish`, a user who
      // bulk-marked a stack as Foil would see foil badges in the collection
      // while every deck still treated those cards as nonfoil -- two screens,
      // two answers, and no error anywhere. The whitelist is gone with it: the
      // finish module is the one place that decides what a finish may be.
      let finish;
      let printing;
      try {
        ({ finish, printing } = finishColumnsFromBody({ printing: value }));
      } catch (error) {
        if (error instanceof FinishError) return res.status(400).json({ error: error.message });
        throw error;
      }
      const result = await db.run(
        `UPDATE collection SET printing = ?, finish = ? WHERE id IN (${placeholders}) AND user_id = ?`,
        [printing, finish, ...ids, req.user.id]
      );
      return res.json({ message: `Set printing on ${result.changes} card(s)`, affected: result.changes });
    }

    // Distribute a total price paid (a pack/deck) across the selected entries,
    // writing each entry's per-card purchase_price. method 'weighted' splits
    // proportional to market value (price_trend); 'equal' splits evenly. Weighted
    // falls back to equal when no selected card has a market price.
    if (action === 'purchase_split') {
      const total = parseFloat(value && value.total);
      const method = value && value.method === 'equal' ? 'equal' : 'weighted';
      if (!(total >= 0)) return res.status(400).json({ error: 'total must be a non-negative number' });
      const rows = await db.all(
        `SELECT c.id, COALESCE(cc.price_trend, 0) AS price FROM collection c
         LEFT JOIN card_cache cc ON cc.id = c.card_id
         WHERE c.id IN (${placeholders}) AND c.user_id = ?`,
        [...ids, req.user.id]
      );
      if (rows.length === 0) return res.status(400).json({ error: 'No valid entries' });
      const sum = rows.reduce((s, r) => s + (r.price || 0), 0);
      const weighted = method === 'weighted' && sum > 0;
      const shares = splitPrice(rows.map(r => r.price || 0), total, method);
      for (let i = 0; i < rows.length; i++) {
        await db.run(`UPDATE collection SET purchase_price = ? WHERE id = ? AND user_id = ?`, [shares[i], rows[i].id, req.user.id]);
      }
      return res.json({ message: `Split $${total.toFixed(2)} across ${rows.length} card(s) (${weighted ? 'by value' : 'evenly'})`, affected: rows.length });
    }

    const locationId = value ? parseInt(value, 10) : null;
    // The whole batch is one transaction: a bulk move either relocates every
    // selected entry or none of them. The previous per-entry loop could report
    // "Moved 3 card(s)" after failing on the fourth, leaving the user with a
    // split selection they could not identify or undo.
    const moved = await db.withTransaction(async (tx) => {
      if (locationId) {
        await requireOwnedLocation(tx, locationId, req.user.id);
      }
      let count = 0;
      const touched = new Map();
      for (const id of ids) {
        const entry = await tx.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        if (!entry) continue;
        if (!locationId) {
          await tx.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE id = ? AND user_id = ?`, [id, req.user.id]);
          count++;
          continue;
        }
        const resolved = (await resolveCompartmentAndPosition({
          dbClient: tx, locationId, userId: req.user.id, cardId: entry.card_id, printing: entry.printing
        })) || { compartment_id: null, position: 0, full: true };
        const finalLoc = resolved.compartment_id ? (resolved.location_id ?? locationId) : null;
        // Each entry claims its slot against the state produced by the earlier
        // entries in this same batch, because the reads run inside the
        // transaction. Exceeding capacity aborts the whole batch.
        if (resolved.compartment_id) {
          const compartment = await requireOwnedCompartment(tx, resolved.compartment_id, req.user.id);
          // Reserve the row's real quantity: the UPDATE below relocates the
          // whole row, so a stacked entry consumes that many slots.
          await assertCapacityFor(tx, compartment, entry.quantity || 1, { excludeEntryId: entry.id });
        } else {
          // No slot could be found for this entry. Refusing here is what makes
          // the operation all-or-nothing rather than silently partial.
          throw new InvariantError(400, 'COMPARTMENT_FULL', 'COMPARTMENT_FULL');
        }
        await tx.run(`UPDATE collection SET location_id = ?, compartment_id = ?, position = ? WHERE id = ? AND user_id = ?`, [finalLoc, resolved.compartment_id, resolved.position, id, req.user.id]);
        touched.set(resolved.compartment_id, finalLoc);
        count++;
      }
      for (const [compId, locId] of touched) {
        const rbLoc = await tx.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [locId, req.user.id]);
        if (rbLoc) await rebalanceCompartmentByScheme(tx, compId, rbLoc.sort_order, rbLoc.foil_sorting);
      }
      return count;
    });
    return res.json({ message: `Moved ${moved} card(s)`, affected: moved });
  } catch (error) {
    if (error instanceof RequestBoundsError || error instanceof InvariantError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Bulk action failed' });
  }
});

// Saved Filter Presets
router.get('/collection/filters/presets', async (req, res) => {
  try {
    const presets = await db.all(
      `SELECT * FROM saved_filter_presets WHERE user_id = ? ORDER BY name ASC`,
      [req.user.id]
    );
    res.json({ presets });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch filter presets', message: error.message });
  }
});

router.post('/collection/filters/presets', async (req, res) => {
  const { name, filter_config, sort_config, is_default = 0 } = req.body;
  if (!name || !filter_config) {
    return res.status(400).json({ error: 'Preset name and filter_config are required' });
  }

  try {
    const result = await db.run(
      `INSERT INTO saved_filter_presets (user_id, name, filter_config, sort_config, is_default)
       VALUES (?, ?, ?, ?, ?)`,
      [
        req.user.id,
        name.trim(),
        typeof filter_config === 'string' ? filter_config : JSON.stringify(filter_config),
        typeof sort_config === 'string' ? sort_config : JSON.stringify(sort_config || []),
        is_default ? 1 : 0
      ]
    );
    res.status(201).json({ success: true, id: result.lastID });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save filter preset', message: error.message });
  }
});

router.delete('/collection/filters/presets/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`DELETE FROM saved_filter_presets WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Filter preset not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete filter preset', message: error.message });
  }
});

module.exports = router;
