const express = require('express');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const {
  recommendSlot,
  compartmentLabel,
  loadCompartments,
  locationAcceptsCard,
  compartmentAcceptsCard,
  sortCards,
  rebalanceCompartmentByScheme
} = require('../utils/compartmentSort');
const { defaultCompartmentPlan, normalizeRuleConfig } = require('../utils/collectionHelpers');
const { RequestBoundsError, positiveInteger, uniqueIntegerIds } = require('../utils/requestBounds');
const {
  InvariantError,
  requireOwnedLocation,
  requireOwnedCompartment,
  findOwnedCompartment,
  requireOwnedCompartmentInLocation,
  assertCapacityFor,
  assertCapacityShrinkAllowed
} = require('../utils/storageInvariants');

// Map an invariant violation onto its HTTP response. Kept in one place so every
// route reports authorization failures identically -- a route that formats these
// by hand eventually formats one of them differently, and inconsistent error
// shapes are how enumeration oracles get introduced.
function sendInvariantError(res, error) {
  if (error instanceof InvariantError || error instanceof RequestBoundsError) {
    res.status(error.status).json({ error: error.message });
    return true;
  }
  return false;
}

const router = express.Router();

router.use(authenticateToken);

// 1. Get Storage Locations with Compartment Summaries
router.get('/locations', async (req, res) => {
  try {
    // Subqueries, not a joined SUM: joining compartments to collection fans each
    // compartment row out once per card, which inflated total_capacity by the
    // card count. Correlated aggregates keep each sum independent.
    const locations = await db.all(`
      SELECT l.*,
             (SELECT COUNT(*) FROM compartments WHERE location_id = l.id) as compartment_count,
             (SELECT COALESCE(SUM(capacity), 0) FROM compartments WHERE location_id = l.id) as total_capacity,
             (SELECT COALESCE(SUM(quantity), 0) FROM collection
                WHERE user_id = l.user_id
                  AND compartment_id IN (SELECT id FROM compartments WHERE location_id = l.id)) as total_cards
      FROM locations l
      WHERE l.user_id = ?
    `, [req.user.id]);
    res.json(locations);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve locations' });
  }
});

const RULE_TYPES = ['any', 'alphabetical_range', 'specific_sets', 'compound'];

router.post('/locations', async (req, res) => {
  const { name, type, sort_order = 'name-asc', foil_sorting = 'normals_first', rule_type = 'any', rule_config, compartmentPlan } = req.body;

  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }
  if (!RULE_TYPES.includes(rule_type)) {
    return res.status(400).json({ error: 'Invalid rule_type' });
  }

  const plan = compartmentPlan ?? defaultCompartmentPlan(type);
  try {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
      throw new RequestBoundsError(400, 'compartmentPlan must be an object');
    }
    plan.count = positiveInteger(plan.count, { name: 'compartmentPlan.count', max: 1000 });
    plan.capacity = positiveInteger(plan.capacity, { name: 'compartmentPlan.capacity', max: 1000 });
  } catch (error) {
    if (error instanceof RequestBoundsError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }

  let ruleConfigJson;
  try {
    ruleConfigJson = normalizeRuleConfig(rule_config);
  } catch {
    return res.status(400).json({ error: 'rule_config must be valid JSON' });
  }
  try {
    const existing = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ?`, [name, req.user.id]);
    if (existing) {
      return res.status(400).json({ error: 'A location with this name already exists' });
    }

    // Creating a location and its compartments is one operation: a location
    // with zero compartments is a broken object the UI cannot file into or
    // repair, which is exactly what a mid-way failure used to produce.
    const newId = await db.withTransaction(async (tx) => {
      const result = await tx.run(`
        INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, rule_config, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [name, type, sort_order, foil_sorting || 'normals_first', rule_type, ruleConfigJson, req.user.id]);

      for (let i = 1; i <= plan.count; i++) {
        await tx.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [result.lastID, i, plan.capacity]);
      }
      return result.lastID;
    });

    res.status(200).json({ message: 'Location created', id: newId });
  } catch (error) {
    if (sendInvariantError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Failed to create location' });
  }
});

router.get('/locations/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    res.json(loc);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve location' });
  }
});

router.put('/locations/:id', async (req, res) => {
  const { id } = req.params;
  const { name, type, sort_order, foil_sorting, rule_type, rule_config, locked } = req.body;
  if (rule_type !== undefined && !RULE_TYPES.includes(rule_type)) {
    return res.status(400).json({ error: 'Invalid rule_type' });
  }

  let ruleConfigJson;
  try {
    ruleConfigJson = rule_config !== undefined ? normalizeRuleConfig(rule_config) : undefined;
  } catch {
    return res.status(400).json({ error: 'rule_config must be valid JSON' });
  }
  try {
    const loc = await db.get(`SELECT id, sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) {
      return res.status(404).json({ error: 'Location not found' });
    }

    if (name) {
      const dup = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ? AND id != ?`, [name, req.user.id, id]);
      if (dup) {
        return res.status(400).json({ error: 'A location with this name already exists' });
      }
    }

    // The rebalance, the UPDATE, and the rule-change eviction are one logical
    // edit and must commit together. Previously they ran as independent
    // statements, so a failure inside the eviction loop committed the new rule
    // plus an arbitrary prefix of evictions: the container then advertised a
    // rule its own contents violated, and the user had no way to learn which
    // cards had been dropped. The flat PATCH twin of this path was already
    // wrapped; this one was missed.
    const evicted = await db.withTransaction(async (tx) => {
      // Switching to Custom: bake the outgoing scheme into stored positions so the
      // manual order starts from the currently-sorted layout instead of stale
      // positions (which would render jumbled). Must run before the UPDATE, while
      // loc.sort_order still holds the old scheme.
      if (sort_order === 'custom' && loc.sort_order && loc.sort_order !== 'custom') {
        const comps = await tx.all(`SELECT id FROM compartments WHERE location_id = ?`, [id]);
        for (const c of comps) {
          await rebalanceCompartmentByScheme(tx, c.id, loc.sort_order, foil_sorting || loc.foil_sorting);
        }
      }

      await tx.run(`
        UPDATE locations
        SET
          name = COALESCE(?, name),
          type = COALESCE(?, type),
          sort_order = COALESCE(?, sort_order),
          foil_sorting = COALESCE(?, foil_sorting),
          rule_type = COALESCE(?, rule_type),
          rule_config = COALESCE(?, rule_config),
          locked = COALESCE(?, locked)
        WHERE id = ? AND user_id = ?
      `, [name, type, sort_order, foil_sorting, rule_type, ruleConfigJson, locked === undefined ? null : (locked ? 1 : 0), id, req.user.id]);

      let count = 0;
      if (rule_type !== undefined || rule_config !== undefined) {
        const updated = await tx.get(`SELECT id, rule_type, rule_config FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        const stored = await tx.all(`
          SELECT c.id as entry_id, c.printing, c.finish, c.favorite, c.is_trade, c.list_type,
                 cc.name, cc.set_name, cc.number, cc.types, cc.subtypes, cc.rarity, cc.supertype,
                 cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.cmc, cc.color_identity
          FROM collection c
          JOIN card_cache cc ON c.card_id = cc.id
          WHERE c.location_id = ? AND c.user_id = ?
        `, [id, req.user.id]);
        for (const entry of stored) {
          entry.printing = entry.printing || 'Normal';

          try { entry.types = JSON.parse(entry.types || '[]'); } catch { entry.types = []; }
          if (!locationAcceptsCard(updated, entry)) {
            await tx.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE id = ? AND user_id = ?`, [entry.entry_id, req.user.id]);
            count++;
          }
        }
      }
      return count;
    });
    res.json({ message: 'Location updated', evicted });
  } catch (error) {
    if (sendInvariantError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

router.delete('/locations/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await requireOwnedLocation(null, id, req.user.id);

    // Unfiling the cards and dropping the location must happen together. If the
    // DELETE succeeded after the UPDATE failed, rows would point at a location
    // that no longer exists.
    await db.withTransaction(async (tx) => {
      await tx.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL WHERE location_id = ? AND user_id = ?`, [loc.id, req.user.id]);
      await tx.run(`DELETE FROM locations WHERE id = ? AND user_id = ?`, [loc.id, req.user.id]);
    });

    res.json({ message: 'Location deleted successfully (any stored cards moved to Unsorted)' });
  } catch (error) {
    if (sendInvariantError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Failed to delete location' });
  }
});

// 6b. Manage Compartments
router.get('/locations/:id/compartments', async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    const compartments = await loadCompartments(db, id, req.user.id);
    res.json(compartments.map(c => ({ ...c, display_label: compartmentLabel(c, loc.type) })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve compartments' });
  }
});

router.post('/locations/:id/compartments', async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await requireOwnedLocation(null, id, req.user.id);

    // Read-then-insert is a single logical operation and must hold the
    // transaction. `compartments` carries UNIQUE(location_id, idx), so two
    // concurrent "add a page" clicks both read the same MAX(idx), both compute
    // the same nextIdx, and the loser crashes on a constraint violation the
    // user sees as a 500. Serializing under BEGIN IMMEDIATE makes the second
    // request observe the first one's row and pick the next index up.
    const created = await db.withTransaction(async (tx) => {
      // The previous read was `SELECT MAX(idx) AS maxIdx, capacity ... ORDER BY
      // idx DESC LIMIT 1`. That form happens to be CORRECT on SQLite -- with a
      // single MAX() and no GROUP BY, SQLite takes bare columns from the row
      // that produced the maximum, and UNIQUE(location_id, idx) rules out ties.
      // It is rewritten here because it is correct by accident rather than by
      // construction: it leans on a SQLite-specific extension that is undefined
      // behavior in standard SQL, and it carries an ORDER BY/LIMIT that is dead
      // code (the aggregate has already collapsed the result to one row), which
      // reads as though it does the ordering work the aggregate is really doing.
      //
      // Two reads, each doing one job, is the honest shape: an aggregate for the
      // next index, an ordered single-row read for the capacity template.
      // Behavior is unchanged; what changes is that the next person can verify
      // it without knowing an SQLite quirk.
      const bounds = await tx.get(
        `SELECT COALESCE(MAX(idx), 0) AS maxIdx FROM compartments WHERE location_id = ?`,
        [loc.id]
      );
      const template = await tx.get(
        `SELECT capacity FROM compartments WHERE location_id = ? ORDER BY idx DESC, id DESC LIMIT 1`,
        [loc.id]
      );

      const nextIdx = bounds.maxIdx + 1;
      const capacity = (template && template.capacity)
        ? template.capacity
        : (loc.type === 'Binder' ? 9 : 400);

      const result = await tx.run(
        `INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`,
        [loc.id, nextIdx, capacity]
      );
      return tx.get(`SELECT * FROM compartments WHERE id = ?`, [result.lastID]);
    });

    res.status(201).json({ ...created, display_label: compartmentLabel(created, loc.type) });
  } catch (error) {
    if (sendInvariantError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Failed to add compartment' });
  }
});

router.put('/locations/:id/compartments/:comp_id', async (req, res) => {
  const { id, comp_id } = req.params;
  const { label, capacity, rule_config, assignedFilters, locked } = req.body;
  try {
    // Both IDs are caller-supplied. Authorizing them independently is not enough:
    // the pair itself must be consistent, or a valid location can be used as a
    // ticket to mutate a compartment that lives somewhere else entirely. The
    // helper performs all three obligations so this route cannot drop one.
    const { location: loc, compartment } = await requireOwnedCompartmentInLocation(
      null, id, comp_id, req.user.id
    );

    let ruleConfigJson;
    if (rule_config !== undefined) {
      try {
        ruleConfigJson = normalizeRuleConfig(rule_config);
      } catch {
        return res.status(400).json({ error: 'rule_config must be valid JSON' });
      }
    }

    const updates = [];
    const params = [];
    let nextCapacity;
    if (label !== undefined) { updates.push('label = ?'); params.push(label || null); }
    if (capacity !== undefined) {
      nextCapacity = Math.max(1, parseInt(capacity, 10) || 1);
      updates.push('capacity = ?');
      params.push(nextCapacity);
    }
    if (rule_config !== undefined) { updates.push('rule_config = ?'); params.push(ruleConfigJson); }
    if (locked !== undefined) { updates.push('locked = ?'); params.push(locked ? 1 : 0); }

    // Column updates and the filter rewrite are one logical edit. Run them in a
    // single transaction so a failure partway through the filter loop cannot
    // leave the compartment with a new capacity and half its old rules.
    await db.withTransaction(async (tx) => {
      // The capacity guard reads occupancy inside this transaction and throws
      // before any write, so a refused shrink rolls back with zero partial
      // effect -- including the assignedFilters rewrite below.
      if (nextCapacity !== undefined) {
        await assertCapacityShrinkAllowed(tx, compartment, nextCapacity);
      }

      if (updates.length > 0) {
        await tx.run(
          `UPDATE compartments SET ${updates.join(', ')} WHERE id = ? AND location_id = ?`,
          [...params, compartment.id, loc.id]
        );
      }

      if (Array.isArray(assignedFilters)) {
        await tx.run(`DELETE FROM compartment_assignments WHERE compartment_id = ?`, [compartment.id]);
        for (const filterVal of assignedFilters) {
          if (filterVal) {
            await tx.run(
              `INSERT OR IGNORE INTO compartment_assignments (compartment_id, filter_value) VALUES (?, ?)`,
              [compartment.id, filterVal]
            );
          }
        }
      }
    });

    res.json({ message: 'Compartment updated successfully' });
  } catch (error) {
    if (sendInvariantError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Failed to update compartment' });
  }
});

router.delete('/locations/:id/compartments/:comp_id', async (req, res) => {
  const { id, comp_id } = req.params;
  try {
    // Both IDs are caller-supplied, so authorizing them independently is not
    // enough -- the pair must be consistent. Without assertParentChild this
    // route authorized the location from the URL and then unfiled cards by bare
    // compartment_id: passing location A with a compartment from location B
    // returned 200, emptied B, and left the compartment standing, because only
    // the DELETE half was scoped to the parent. The destructive statement
    // landed, the visible one did not, and the response reported success. The
    // sibling PUT on this exact URL shape already enforces this pair.
    const { location: loc, compartment } = await requireOwnedCompartmentInLocation(
      null, id, comp_id, req.user.id
    );

    const totalComps = await db.get(`SELECT COUNT(*) as count FROM compartments WHERE location_id = ?`, [loc.id]);
    if (totalComps.count <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last compartment of a location' });
    }

    // Unfiling the cards and dropping the compartment are one logical edit. As
    // two independent statements, a failure in between left the cards homeless
    // while their container still existed -- the user sees an error and an empty
    // box, with nothing to indicate placement was lost.
    await db.withTransaction(async (tx) => {
      await tx.run(
        `UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE compartment_id = ? AND user_id = ?`,
        [compartment.id, req.user.id]
      );
      await tx.run(`DELETE FROM compartments WHERE id = ? AND location_id = ?`, [compartment.id, loc.id]);
    });

    res.json({ message: 'Compartment deleted successfully (cards inside moved to Unsorted)' });
  } catch (error) {
    if (sendInvariantError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Failed to delete compartment' });
  }
});

// Flat compartment routes (compartment id is globally unique). The storage UI
// edits rows/pages by bare compartment id; resolve the owning location for auth.
// Delegates to the shared invariant helper so this and the nested routes cannot
// drift apart on what "owned" means.
async function getOwnedCompartment(compId, userId) {
  return findOwnedCompartment(null, compId, userId);
}

router.patch('/compartments/:id', async (req, res) => {
  const { id } = req.params;
  const updateAll = req.query.updateAll === 'true';
  const { label, capacity, rule_config, locked } = req.body;
  try {
    const comp = await getOwnedCompartment(id, req.user.id);
    if (!comp) return res.status(404).json({ error: 'Compartment not found' });

    let ruleConfigJson;
    if (rule_config !== undefined) {
      try { ruleConfigJson = normalizeRuleConfig(rule_config); }
      catch { return res.status(400).json({ error: 'rule_config must be valid JSON' }); }
    }

    // Every write in this handler runs in one transaction. Besides making the
    // capacity guard atomic against a concurrent add, it means a refused shrink
    // cannot leave a label or rule_config change committed behind it.
    let evicted = 0;
    await db.withTransaction(async (tx) => {
      if (capacity !== undefined) {
        const cap = Math.max(1, parseInt(capacity, 10) || 1);
        // updateAll lowers capacity across the whole location, so EVERY affected
        // compartment must be checked before any of them is written. Checking
        // per-compartment inside the update loop would let the fan-out lower
        // capacity on the compartments it reached before hitting the one that
        // refuses -- a partial write of a rejected request.
        const targets = updateAll
          ? await tx.all(`SELECT id, capacity FROM compartments WHERE location_id = ?`, [comp.loc_id])
          : [comp];
        for (const target of targets) {
          await assertCapacityShrinkAllowed(tx, target, cap);
        }
        if (updateAll) await tx.run(`UPDATE compartments SET capacity = ? WHERE location_id = ?`, [cap, comp.loc_id]);
        else await tx.run(`UPDATE compartments SET capacity = ? WHERE id = ?`, [cap, comp.id]);
      }
      if (label !== undefined) await tx.run(`UPDATE compartments SET label = ? WHERE id = ?`, [label || null, comp.id]);
      if (locked !== undefined) await tx.run(`UPDATE compartments SET locked = ? WHERE id = ?`, [locked ? 1 : 0, comp.id]);
      if (rule_config !== undefined) await tx.run(`UPDATE compartments SET rule_config = ? WHERE id = ?`, [ruleConfigJson, comp.id]);

      // Evict cards this row/page no longer accepts after a rule change.
      if (rule_config !== undefined) {
        const cfg = ruleConfigJson ? JSON.parse(ruleConfigJson) : null;
        const compForCheck = { ruleConfig: cfg };
        const stored = await tx.all(`
          SELECT c.id AS entry_id, c.printing, c.finish,
                 cc.name, cc.set_name, cc.number, cc.types, cc.subtypes, cc.rarity, cc.supertype,
                 cc.price_trend, cc.cmc, cc.color_identity
          FROM collection c JOIN card_cache cc ON c.card_id = cc.id
          WHERE c.compartment_id = ? AND c.user_id = ?`, [comp.id, req.user.id]);
        for (const entry of stored) {
          try { entry.types = JSON.parse(entry.types || '[]'); } catch { entry.types = []; }
          if (!compartmentAcceptsCard(compForCheck, entry)) {
            await tx.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE id = ? AND user_id = ?`, [entry.entry_id, req.user.id]);
            evicted++;
          }
        }
      }
    });

    res.json({ message: 'Compartment updated', evicted });
  } catch (error) {
    if (sendInvariantError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Failed to update compartment' });
  }
});

router.delete('/compartments/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const comp = await getOwnedCompartment(id, req.user.id);
    if (!comp) return res.status(404).json({ error: 'Compartment not found' });
    const total = await db.get(`SELECT COUNT(*) AS count FROM compartments WHERE location_id = ?`, [comp.loc_id]);
    if (total.count <= 1) return res.status(400).json({ error: 'Cannot delete the last compartment of a location' });
    // Same two-statement hazard as the nested route: unfiling the cards and
    // dropping their container must commit together or not at all, otherwise a
    // failure between them orphans every card that was inside.
    await db.withTransaction(async (tx) => {
      await tx.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE compartment_id = ? AND user_id = ?`, [comp.id, req.user.id]);
      await tx.run(`DELETE FROM compartments WHERE id = ?`, [comp.id]);
    });
    res.json({ message: 'Compartment deleted (cards inside moved to Unsorted)' });
  } catch (error) {
    if (sendInvariantError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Failed to delete compartment' });
  }
});

router.put('/compartments/:id/filters', async (req, res) => {
  const { id } = req.params;
  const { filters } = req.body;
  try {
    const comp = await getOwnedCompartment(id, req.user.id);
    if (!comp) return res.status(404).json({ error: 'Compartment not found' });
    // Replacing the filter set is delete-then-reinsert. A failure between the
    // two commits the delete alone, silently turning a filtered page into one
    // that accepts anything -- which then mis-files every future card.
    await db.withTransaction(async (tx) => {
      await tx.run(`DELETE FROM compartment_assignments WHERE compartment_id = ?`, [comp.id]);
      for (const filterVal of (Array.isArray(filters) ? filters : [])) {
        if (filterVal) await tx.run(`INSERT OR IGNORE INTO compartment_assignments (compartment_id, filter_value) VALUES (?, ?)`, [comp.id, filterVal]);
      }
    });
    res.json({ message: 'Filters updated' });
  } catch (error) {
    if (sendInvariantError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Failed to update filters' });
  }
});

// Recommendation endpoints
router.post('/locations/:id/recommend', async (req, res) => {
  const { id } = req.params;
  const { card_id, printing = 'Normal' } = req.body;
  try {
    const location = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!location) return res.status(404).json({ error: 'Location not found' });

    const cardMetadata = await db.get(`SELECT name, set_name, number, types, subtypes, price_trend, price_normal, price_holofoil, price_reverse_holofoil, supertype, rarity, cmc, color_identity FROM card_cache WHERE id = ?`, [card_id]);
    if (!cardMetadata) return res.status(404).json({ error: 'Card not found in cache' });
    cardMetadata.printing = printing;

    try { cardMetadata.types = JSON.parse(cardMetadata.types || '[]'); } catch { cardMetadata.types = []; }

    if (!locationAcceptsCard(location, cardMetadata)) {
      return res.json({ rejected: true });
    }

    const recommendation = await recommendSlot(db, location, cardMetadata);
    if (!recommendation) return res.json({ full: true });
    res.json(recommendation);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to compute recommendation' });
  }
});

router.post('/locations/:id/recommend-batch', async (req, res) => {
  const { id } = req.params;
  const { entry_ids = [] } = req.body;
  try {
    uniqueIntegerIds(entry_ids, { name: 'entry_ids', maxLength: 1000 });
  } catch (error) {
    if (error instanceof RequestBoundsError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
  try {
    const location = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!location) return res.status(404).json({ error: 'Location not found' });

    let workingCompartments = await loadCompartments(db, id, req.user.id);
    const mockCards = [];
    const recommendations = [];

    for (const entryId of entry_ids) {
      const entry = await db.get(`
        SELECT c.id as entry_id, c.card_id, c.printing, c.finish, c.favorite, c.is_trade, c.list_type, cc.name, cc.set_name, cc.number, cc.types, cc.subtypes, cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.supertype, cc.rarity, cc.image_url, cc.cmc, cc.color_identity
        FROM collection c
        JOIN card_cache cc ON c.card_id = cc.id
        WHERE c.id = ? AND c.user_id = ?
      `, [entryId, req.user.id]);
      if (!entry) continue;

      try { entry.types = JSON.parse(entry.types || '[]'); } catch { entry.types = []; }

      if (!locationAcceptsCard(location, entry)) {
        recommendations.push({ entry, recommended: null, rejected: true });
        continue;
      }

      const recommended = await recommendSlot(db, location, entry, workingCompartments, mockCards);
      if (!recommended) {
        recommendations.push({ entry, recommended: null, full: true });
        continue;
      }

      recommendations.push({ entry, recommended });

      workingCompartments = workingCompartments.map(c =>
        c.id === recommended.compartment_id ? { ...c, count: c.count + 1, free: c.free - 1 } : c
      );

      mockCards.push({
        entry_id: entry.entry_id,
        compartment_id: recommended.compartment_id,
        image_url: entry.image_url,
        printing: entry.printing,

        name: entry.name,
        supertype: entry.supertype,
        types: JSON.stringify(entry.types),
        rarity: entry.rarity,
        set_name: entry.set_name,
        number: entry.number,
        cmc: entry.cmc,
        color_identity: entry.color_identity,
        price_trend: entry.price_trend,
        price_normal: entry.price_normal,
        price_holofoil: entry.price_holofoil,
        price_reverse_holofoil: entry.price_reverse_holofoil
      });
    }

    res.json(recommendations);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to compute batch recommendations' });
  }
});

router.post('/locations/:id/apply-all', async (req, res) => {
  const { id } = req.params;
  const { entry_ids = [] } = req.body;
  try {
    uniqueIntegerIds(entry_ids, { name: 'entry_ids', maxLength: 1000 });
  } catch (error) {
    if (error instanceof RequestBoundsError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
  try {
    const location = await requireOwnedLocation(null, id, req.user.id);

    // Filing a batch is one logical operation. Previously each entry was
    // updated independently, so an error midway through left an arbitrary
    // prefix of the selection filed and the rest untouched, with no way for the
    // client to tell which was which.
    const filed = await db.withTransaction(async (tx) => {
      let workingCompartments = await loadCompartments(tx, id, req.user.id);
      let count = 0;

      for (const entryId of entry_ids) {
        const entry = await tx.get(`
          SELECT c.id, c.card_id, c.printing, c.finish, c.quantity, c.favorite, c.is_trade, c.list_type, cc.name, cc.set_name, cc.number, cc.types, cc.subtypes, cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.supertype, cc.rarity, cc.cmc, cc.color_identity
          FROM collection c
          JOIN card_cache cc ON c.card_id = cc.id
          WHERE c.id = ? AND c.user_id = ?
        `, [entryId, req.user.id]);
        if (!entry) continue;
        try { entry.types = JSON.parse(entry.types || '[]'); } catch { entry.types = []; }

        const recommended = await recommendSlot(db, location, entry, workingCompartments);
        // No slot for this card: skip it rather than abort. Unlike a bulk move,
        // "file what fits" is this endpoint's documented contract, and the
        // response already reports filed-vs-total so the client can see the
        // remainder. The atomicity guarantee here is that the rows it DID write
        // are all committed together.
        if (!recommended) continue;

        // Authorize and reserve against live state inside the transaction; the
        // in-memory workingCompartments projection alone cannot see writes made
        // by a concurrent request.
        const compartment = await requireOwnedCompartment(tx, recommended.compartment_id, req.user.id);
        // Reserve the row's real quantity: the UPDATE relocates the whole row.
        await assertCapacityFor(tx, compartment, entry.quantity || 1, { excludeEntryId: entry.id });

        await tx.run(`UPDATE collection SET location_id = ?, compartment_id = ?, position = ? WHERE id = ? AND user_id = ?`, [
          compartment.loc_id, recommended.compartment_id, recommended.position, entryId, req.user.id
        ]);

        // Advance the projection by the row's real quantity, not by one row.
        // `count`/`free` mirror occupancy, and occupancy is SUM(quantity): a
        // stacked row that consumes 3 slots while the projection debits 1
        // makes the engine believe space exists that does not, and it then
        // recommends slots past capacity for the rest of the batch.
        const consumed = entry.quantity || 1;
        workingCompartments = workingCompartments.map(c =>
          c.id === recommended.compartment_id
            ? { ...c, count: c.count + consumed, free: c.free - consumed }
            : c
        );
        count++;
      }
      return count;
    });

    res.json({ message: `Filed ${filed} of ${entry_ids.length} card(s).`, filed, total: entry_ids.length });
  } catch (error) {
    if (sendInvariantError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Failed to apply batch' });
  }
});

router.post('/locations/:id/resort', async (req, res) => {
  const { id } = req.params;
  try {
    const location = await requireOwnedLocation(null, id, req.user.id);

    // The most destructive write path in this file. Its first act is to NULL
    // compartment_id for EVERY card in the location, and it then refiles them
    // one row at a time. Outside a transaction any failure after that first
    // statement left the entire container unfiled, with no rollback and no
    // error the user could act on -- in a collection tracker, cards silently
    // losing their physical location is indistinguishable from losing the
    // cards. A concurrent reader could also observe the box fully empty
    // mid-flight. Wrapping the whole handler makes the unfile-then-refile pair
    // atomic, so a mid-loop failure restores every original placement.
    const results = await db.withTransaction(async (tx) => {
      const cards = await tx.all(`
        SELECT c.id as entry_id, c.card_id, c.printing, c.finish, c.quantity, c.favorite, c.is_trade, c.list_type,
               cc.name, cc.set_name, cc.number, cc.types, cc.rarity, cc.supertype, cc.image_url,
               cc.price_trend, cc.price_normal, cc.price_holofoil, cc.price_reverse_holofoil, cc.cmc, cc.color_identity
        FROM collection c
        JOIN card_cache cc ON c.card_id = cc.id
        WHERE c.location_id = ? AND c.user_id = ?
      `, [location.id, req.user.id]);
      cards.forEach(c => { try { c.types = JSON.parse(c.types || '[]'); } catch { c.types = []; } });

      if (cards.length === 0) return [];

      await tx.run(`UPDATE collection SET compartment_id = NULL, position = 0 WHERE location_id = ? AND user_id = ?`, [location.id, req.user.id]);

      const ordered = sortCards(cards, location.sort_order, location.foil_sorting);

      // Read the compartment projection through the transaction handle. Reading
      // it through the module-level db would compute the plan from a snapshot
      // this transaction has not taken, so the refile would commit against
      // state it never actually verified.
      let workingCompartments = await loadCompartments(tx, location.id, req.user.id);
      const out = [];

      for (const entry of ordered) {
        const recommended = await recommendSlot(tx, location, entry, workingCompartments, []);
        if (!recommended) { out.push({ entry, recommended: null }); continue; }

        const finalLoc = recommended.location_id || location.id;

        // Authorize and reserve against live state inside the transaction. The
        // in-memory projection alone cannot see writes from a concurrent
        // request, so capacity has to be re-checked at the choke point.
        const target = await requireOwnedCompartment(tx, recommended.compartment_id, req.user.id);
        // Reserve the row's real quantity: the UPDATE relocates the whole row.
        await assertCapacityFor(tx, target, entry.quantity || 1, { excludeEntryId: entry.entry_id });

        await tx.run(`UPDATE collection SET location_id = ?, compartment_id = ?, position = ? WHERE id = ? AND user_id = ?`, [
          finalLoc, recommended.compartment_id, recommended.position, entry.entry_id, req.user.id
        ]);
        out.push({ entry, recommended });

        if (finalLoc === location.id) {
          // Advance by the row's real quantity: the projection mirrors
          // occupancy, which is SUM(quantity), not a row count.
          const consumed = entry.quantity || 1;
          workingCompartments = workingCompartments.map(c =>
            c.id === recommended.compartment_id
              ? { ...c, count: c.count + consumed, free: c.free - consumed }
              : c
          );
        }
      }
      return out;
    });

    res.json(results);
  } catch (error) {
    if (sendInvariantError(res, error)) return;
    console.error(error);
    res.status(500).json({ error: 'Failed to re-sort container' });
  }
});

module.exports = router;
