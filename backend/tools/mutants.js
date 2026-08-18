// PR 6B mutant catalogue.
//
// Each entry deletes or neuters exactly ONE guard. The rule for writing a good
// mutant: it must change BEHAVIOR, not just syntax. Deleting a line that no
// request path can reach produces a mutant nothing can kill, and that is a
// defect in the mutant, not evidence about the test suite.
//
// `find` anchors must be unique within the file; the harness refuses ambiguous
// anchors rather than silently mutating the wrong call site.
const COLLECTION = 'src/routes/collection.js';
const STORAGE = 'src/routes/storage.js';
const INVARIANTS = 'src/utils/storageInvariants.js';

module.exports = [
  // -- collection.js -------------------------------------------------------
  {
    id: 'M1',
    desc: 'PUT /collection/:id drops ownership check on target compartment (body compartment_id)',
    edits: [{
      file: COLLECTION,
      find: `          targetCompartment = await requireOwnedCompartment(tx, compartment_id, req.user.id);
          finalCompartmentId = targetCompartment.id;
          finalLocationId = targetCompartment.location_id;`,
      replace: `          targetCompartment = await tx.get(\`SELECT cp.*, cp.location_id AS loc_id, l.type AS loc_type FROM compartments cp JOIN locations l ON cp.location_id = l.id WHERE cp.id = ?\`, [compartment_id]);
          if (!targetCompartment) throw new InvariantError(400, 'Invalid compartment', 'COMPARTMENT_NOT_FOUND');
          finalCompartmentId = targetCompartment.id;
          finalLocationId = targetCompartment.location_id;`
    }]
  },
  {
    id: 'M2',
    desc: 'PUT /collection/:id drops ownership check on destination LOCATION when moving',
    edits: [{
      file: COLLECTION,
      find: `          await requireOwnedLocation(tx, location_id, req.user.id);`,
      replace: `          /* mutant M2: location ownership check removed */`
    }]
  },
  {
    id: 'M3',
    desc: 'PUT /collection/:id drops the capacity reservation entirely',
    edits: [{
      file: COLLECTION,
      find: `        await assertCapacityFor(tx, targetCompartment, requestedQty, { excludeEntryId: entry.id });`,
      replace: `        /* mutant M3: capacity reservation removed */`
    }]
  },
  {
    id: 'M4',
    desc: 'PUT /collection/:id reserves 1 instead of the requested quantity',
    edits: [{
      file: COLLECTION,
      find: `        await assertCapacityFor(tx, targetCompartment, requestedQty, { excludeEntryId: entry.id });`,
      replace: `        await assertCapacityFor(tx, targetCompartment, 1, { excludeEntryId: entry.id });`
    }]
  },
  // M5-M7 and M17 were absent from this catalogue for four review rounds. The
  // gap was not deliberate: they are the POST /api/collection guards, and the
  // spec reviewer's finding was exactly that "mutation coverage stopped at the
  // routes that failed round 3 and never reached POST /api/collection". A
  // catalogue with unexplained holes cannot be trusted, so the numbers are
  // restored here rather than renumbered away -- renumbering would have erased
  // the evidence that anything was ever missing.
  {
    id: 'M5',
    desc: 'POST /collection drops ownership check on the destination location',
    edits: [{
      file: COLLECTION,
      find: `    if (location_id) {
      await requireOwnedLocation(tx, location_id, req.user.id);
    }`,
      replace: `    /* mutant M5: add-path location ownership removed */`
    }]
  },
  {
    // UNREACHABLE-BY-HTTP mutant. Expected to survive; the guard is retained
    // deliberately as defence in depth. Same class as M25/M28.
    //
    // This mutant replaces `requireOwnedCompartment` with an unscoped read, so
    // it only changes behavior if `resolveCompartmentAndPosition` can ever hand
    // back a compartment the caller does not own. On this route it cannot, and
    // the chain was traced rather than assumed:
    //
    //   1. The route calls the helper with `locationId: location_id` only after
    //      `requireOwnedLocation(tx, location_id, req.user.id)` has passed, so
    //      `location.user_id` IS the caller.
    //   2. The helper's own location read is `WHERE id = ? AND user_id = ?`, so
    //      a foreign location resolves to null and returns compartment_id null.
    //   3. `recommendSlot` derives every candidate from that location:
    //      `loadCompartments(dbClient, location.id, location.user_id)` for the
    //      primary path, and for the overflow path a location query scoped
    //      `WHERE user_id = ? AND id != ?` (compartmentSort.js:323) followed by
    //      `loadCompartments(..., location.user_id)`.
    //
    // There is therefore no HTTP request that makes the planner name a foreign
    // compartment on the add path, and no behavior test can distinguish this
    // mutant from the original. Killing it would require stubbing
    // `recommendSlot`, which tests the mock rather than the system.
    //
    // KNOWN LATENT RISK, recorded so it is not rediscovered: `loadCompartments`
    // accepts a `userId` argument and does not use it -- its query filters on
    // location_id alone. The scoping above therefore rests entirely on every
    // caller passing a location it has already authorized. That is true today.
    // This re-check is exactly what CONTAINS that assumption the day it stops
    // being true, which is why the guard stays.
    id: 'M6',
    unreachable: true,
    desc: 'UNREACHABLE: add-path ownership re-check on planner-recommended compartment',
    edits: [{
      file: COLLECTION,
      find: `      const compartment = await requireOwnedCompartment(tx, resolved.compartment_id, req.user.id);
      // \`count\` slots either way: a stackable row of N occupies N physical
      // slots, and N unstacked rows occupy N.
      await assertCapacityFor(tx, compartment, count);`,
      replace: `      const compartment = await tx.get(\`SELECT cp.*, cp.location_id AS loc_id FROM compartments cp WHERE cp.id = ?\`, [resolved.compartment_id]);
      await assertCapacityFor(tx, compartment, count);`
    }]
  },
  {
    id: 'M7',
    desc: 'POST /collection drops the capacity reservation entirely',
    edits: [{
      file: COLLECTION,
      find: `      await assertCapacityFor(tx, compartment, count);`,
      replace: `      /* mutant M7: add-path reservation removed */`
    }]
  },
  {
    id: 'M17',
    desc: 'POST /collection reserves a flat 1 instead of the requested copy count',
    edits: [{
      file: COLLECTION,
      find: `      await assertCapacityFor(tx, compartment, count);`,
      replace: `      await assertCapacityFor(tx, compartment, 1);`
    }]
  },
  {
    id: 'M42',
    desc: 'POST /collection loses its transaction wrapper',
    edits: [{
      file: COLLECTION,
      find: `  const result = await db.withTransaction(async (tx) => {
    if (location_id) {`,
      replace: `  const result = await (async (tx) => {
    if (location_id) {`
    }, {
      file: COLLECTION,
      find: `      rule_rejected: !!resolved.rejected
    };
  });`,
      replace: `      rule_rejected: !!resolved.rejected
    };
  })(db);`
    }]
  },
  {
    id: 'M43',
    desc: 'POST /collection drops the quantity upper bound (unbounded insert loop)',
    edits: [{
      file: COLLECTION,
      find: `    body.quantity = positiveInteger(body.quantity === undefined ? 1 : body.quantity, { name: 'quantity', max: 1000 });`,
      replace: `    body.quantity = body.quantity === undefined ? 1 : body.quantity;`
    }]
  },
  {
    // EQUIVALENT-TODAY mutant. Expected to survive; the explicit handle stays.
    //
    // PR 6A routes module-level `db.get/all/run` onto the active transaction
    // via AsyncLocalStorage (`ownedOrQueued`, src/db.js:152-171), so a helper
    // that reads through `db` from inside `db.withTransaction(tx => ...)` does
    // in fact participate in that transaction. Passing `dbClient: tx` and
    // omitting it are therefore observationally identical right now, and no
    // behavior test can separate them.
    //
    // The explicit handle is still the correct fix, for the reason already
    // written at collection.js:348: relying on ALS means the correctness of
    // these reads depends on an invisible ambient context rather than on what
    // the code says. Any future refactor that moves this off the ALS-tracked
    // call path -- a queue hop, a worker, a `.then` boundary, a `setImmediate`
    // -- silently turns the placement decision into an out-of-transaction read,
    // and the failure is a capacity race that appears only under concurrency.
    //
    // Recorded as PRESENT, not PROVEN. The reviewer-visible finding it fixes
    // (collectionHelpers.js lines 76/88/107 using module `db` instead of the
    // passed handle) is real; what is NOT claimable is that a test defends it.
    id: 'M44',
    equivalent: true,
    desc: 'EQUIVALENT: add-path explicit tx handle (ALS already routes module db onto the transaction)',
    edits: [{
      file: COLLECTION,
      find: `    const resolved = (await resolveCompartmentAndPosition({
      dbClient: tx,`,
      replace: `    const resolved = (await resolveCompartmentAndPosition({`
    }]
  },
  {
    id: 'M8',
    desc: 'POST /collection/:id/place drops ownership check on the target compartment',
    edits: [{
      file: COLLECTION,
      find: `      const comp = await requireOwnedCompartment(tx, compartment_id, req.user.id);`,
      replace: `      const comp = await tx.get(\`SELECT cp.*, cp.location_id AS loc_id, l.type AS loc_type, l.sort_order FROM compartments cp JOIN locations l ON cp.location_id = l.id WHERE cp.id = ?\`, [compartment_id]);
      if (!comp) throw new InvariantError(400, 'Invalid compartment', 'COMPARTMENT_NOT_FOUND');`
    }]
  },
  {
    id: 'M9',
    desc: 'POST /collection/:id/place drops the capacity reservation (BUG 1 site)',
    edits: [{
      file: COLLECTION,
      find: `        await assertCapacityFor(tx, comp, entry.quantity || 1, { excludeEntryId: entry.id });`,
      replace: `        /* mutant M9: reservation removed */`
    }]
  },
  {
    id: 'M10',
    desc: 'BUG 1 REGRESSION: place reserves a flat 1 instead of the row quantity',
    edits: [{
      file: COLLECTION,
      find: `        await assertCapacityFor(tx, comp, entry.quantity || 1, { excludeEntryId: entry.id });`,
      replace: `        await assertCapacityFor(tx, comp, 1, { excludeEntryId: entry.id });`
    }]
  },
  {
    id: 'M11',
    desc: 'POST /collection/:id/place drops ownership check on the swap target compartment',
    edits: [{
      file: COLLECTION,
      find: `          await requireOwnedCompartment(tx, other.compartment_id, req.user.id);`,
      replace: `          /* mutant M11: swap-target ownership check removed */`
    }]
  },
  {
    id: 'M12',
    desc: 'bulk move drops ownership check on the destination location',
    edits: [{
      file: COLLECTION,
      find: `        await requireOwnedLocation(tx, locationId, req.user.id);`,
      replace: `        /* mutant M12: bulk destination location ownership removed */`
    }]
  },
  {
    id: 'M13',
    desc: 'bulk move drops the per-entry capacity reservation',
    edits: [{
      file: COLLECTION,
      find: `          await assertCapacityFor(tx, compartment, entry.quantity || 1, { excludeEntryId: entry.id });`,
      replace: `          /* mutant M13: bulk reservation removed */`
    }]
  },
  {
    id: 'M14',
    desc: 'bulk move: unplaceable entry is skipped instead of aborting the batch',
    edits: [{
      file: COLLECTION,
      find: `          throw new InvariantError(400, 'COMPARTMENT_FULL', 'COMPARTMENT_FULL');
        }`,
      replace: `          continue;
        }`
    }]
  },
  {
    id: 'M15',
    desc: 'bulk move loses its transaction wrapper (partial writes commit)',
    edits: [{
      file: COLLECTION,
      find: `    const moved = await db.withTransaction(async (tx) => {
      if (locationId) {`,
      replace: `    const moved = await (async (tx) => {
      if (locationId) {`
    }, {
      file: COLLECTION,
      find: `      return count;
    });
    return res.json({ message: \`Moved \${moved} card(s)\`, affected: moved });`,
      replace: `      return count;
    })(db);
    return res.json({ message: \`Moved \${moved} card(s)\`, affected: moved });`
    }]
  },
  {
    id: 'M16',
    desc: 'PUT /collection/:id loses its transaction wrapper',
    edits: [{
      file: COLLECTION,
      find: `    const outcome = await db.withTransaction(async (tx) => {
      const entry = await tx.get(\`SELECT * FROM collection WHERE id = ? AND user_id = ?\`, [id, req.user.id]);`,
      replace: `    const outcome = await (async (tx) => {
      const entry = await tx.get(\`SELECT * FROM collection WHERE id = ? AND user_id = ?\`, [id, req.user.id]);`
    }, {
      file: COLLECTION,
      find: `      return { placement: finalPlacement, container_full: resolvedFull, rule_rejected: resolvedRejected };
    });`,
      replace: `      return { placement: finalPlacement, container_full: resolvedFull, rule_rejected: resolvedRejected };
    })(db);`
    }]
  },

  // -- storage.js ----------------------------------------------------------
  {
    id: 'M18',
    desc: 'nested compartment PUT drops the parent-child pair check',
    edits: [{
      file: STORAGE,
      find: `    const { location: loc, compartment } = await requireOwnedCompartmentInLocation(
      null, id, comp_id, req.user.id
    );

    let ruleConfigJson;`,
      replace: `    const loc = await requireOwnedLocation(null, id, req.user.id);
    const compartment = await requireOwnedCompartment(null, comp_id, req.user.id);

    let ruleConfigJson;`
    }]
  },
  {
    id: 'M19',
    desc: 'nested compartment PUT drops the capacity-shrink guard',
    edits: [{
      file: STORAGE,
      find: `        await assertCapacityShrinkAllowed(tx, compartment, nextCapacity);`,
      replace: `        /* mutant M19: shrink guard removed */`
    }]
  },
  {
    id: 'M20',
    desc: 'nested compartment DELETE drops the parent-child pair check',
    edits: [{
      file: STORAGE,
      find: `    const { location: loc, compartment } = await requireOwnedCompartmentInLocation(
      null, id, comp_id, req.user.id
    );

    const totalComps`,
      replace: `    const loc = await requireOwnedLocation(null, id, req.user.id);
    const compartment = await requireOwnedCompartment(null, comp_id, req.user.id);

    const totalComps`
    }]
  },
  {
    id: 'M21',
    desc: 'flat PATCH /compartments/:id drops the shrink guard (incl. updateAll fan-out)',
    edits: [{
      file: STORAGE,
      find: `        for (const target of targets) {
          await assertCapacityShrinkAllowed(tx, target, cap);
        }`,
      replace: `        /* mutant M21: shrink guard removed */`
    }]
  },
  {
    id: 'M22',
    desc: 'resort drops its capacity reservation entirely (headline round-2 fix)',
    edits: [{
      file: STORAGE,
      find: `        await assertCapacityFor(tx, target, entry.quantity || 1, { excludeEntryId: entry.entry_id });`,
      replace: `        /* mutant M22: resort reservation removed */`
    }]
  },
  {
    id: 'M23',
    desc: 'DELETE /locations/:id loses its transaction wrapper',
    edits: [{
      file: STORAGE,
      find: `    await db.withTransaction(async (tx) => {
      await tx.run(\`UPDATE collection SET location_id = NULL, compartment_id = NULL WHERE location_id = ? AND user_id = ?\`, [loc.id, req.user.id]);
      await tx.run(\`DELETE FROM locations WHERE id = ? AND user_id = ?\`, [loc.id, req.user.id]);
    });`,
      replace: `    await (async (tx) => {
      await tx.run(\`UPDATE collection SET location_id = NULL, compartment_id = NULL WHERE location_id = ? AND user_id = ?\`, [loc.id, req.user.id]);
      await tx.run(\`DELETE FROM locations WHERE id = ? AND user_id = ?\`, [loc.id, req.user.id]);
    })(db);`
    }]
  },
  {
    id: 'M24',
    desc: 'DELETE /locations/:id drops the ownership check on the location',
    edits: [{
      file: STORAGE,
      find: `    const loc = await requireOwnedLocation(null, id, req.user.id);

    // Unfiling the cards and dropping the location must happen together.`,
      replace: `    const loc = { id: Number(id) };

    // Unfiling the cards and dropping the location must happen together.`
    }]
  },
  {
    // UNREACHABLE-BY-HTTP mutant. Expected to survive; the guard is retained
    // deliberately as defence in depth.
    //
    // Analysis: this mutant only changes behavior if `recommendSlot` can ever
    // return a compartment the caller does not own, because the injected
    // fallback fires only when findOwnedCompartment returns null. Every
    // compartment the planner can reach is derived from `location.user_id`:
    // the primary `loadCompartments(dbClient, location.id, location.user_id)`,
    // the overflow location query (`WHERE user_id = ? AND id != ?`), and the
    // overflow `loadCompartments(..., location.user_id)`. `location` itself
    // arrives from requireOwnedLocation. There is therefore no HTTP request
    // that makes the planner name a foreign compartment, and no behavior test
    // can distinguish this mutant from the original.
    //
    // The check stays because it is cheap and it is what CONTAINS a future
    // planner bug: the day someone adds a code path that widens the planner's
    // scope, this re-resolution turns a cross-tenant write into a 400. Killing
    // it would require a unit-level test that stubs recommendSlot, which tests
    // the mock rather than the system. Documented rather than faked.
    id: 'M25',
    unreachable: true,
    desc: 'UNREACHABLE: resort ownership re-check on planner-recommended compartment',
    edits: [{
      file: STORAGE,
      find: `        const target = await requireOwnedCompartment(tx, recommended.compartment_id, req.user.id);`,
      replace: `        const target = await findOwnedCompartment(tx, recommended.compartment_id, req.user.id) || { id: recommended.compartment_id, capacity: Number.MAX_SAFE_INTEGER };`
    }]
  },
  {
    id: 'M26',
    desc: 'resort loses its transaction wrapper (unfile-then-refile no longer atomic)',
    edits: [{
      file: STORAGE,
      find: `    const results = await db.withTransaction(async (tx) => {
      const cards = await tx.all(\``,
      replace: `    const results = await (async (tx) => {
      const cards = await tx.all(\``
    }, {
      file: STORAGE,
      find: `      return out;
    });

    res.json(results);`,
      replace: `      return out;
    })(db);

    res.json(results);`
    }]
  },
  {
    id: 'M27',
    desc: 'apply-all drops its capacity reservation',
    edits: [{
      file: STORAGE,
      find: `        await assertCapacityFor(tx, compartment, entry.quantity || 1, { excludeEntryId: entry.id });`,
      replace: `        /* mutant M27: apply-all reservation removed */`
    }]
  },
  {
    // UNREACHABLE-BY-HTTP mutant. Expected to survive. Same analysis as M25 --
    // the planner cannot name a foreign compartment, so the re-check is
    // defence in depth against a future planner change rather than a guard any
    // current request can defeat. Retained and documented, not faked.
    id: 'M28',
    unreachable: true,
    desc: 'UNREACHABLE: apply-all ownership re-check on planner-recommended compartment',
    edits: [{
      file: STORAGE,
      find: `        const compartment = await requireOwnedCompartment(tx, recommended.compartment_id, req.user.id);`,
      replace: `        const compartment = await findOwnedCompartment(tx, recommended.compartment_id, req.user.id) || { id: recommended.compartment_id, loc_id: location.id, capacity: Number.MAX_SAFE_INTEGER };`
    }]
  },
  {
    id: 'M29',
    desc: 'flat compartment DELETE loses its transaction wrapper',
    edits: [{
      file: STORAGE,
      find: `    await db.withTransaction(async (tx) => {
      await tx.run(\`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE compartment_id = ? AND user_id = ?\`, [comp.id, req.user.id]);
      await tx.run(\`DELETE FROM compartments WHERE id = ?\`, [comp.id]);
    });`,
      replace: `    await (async (tx) => {
      await tx.run(\`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE compartment_id = ? AND user_id = ?\`, [comp.id, req.user.id]);
      await tx.run(\`DELETE FROM compartments WHERE id = ?\`, [comp.id]);
    })(db);`
    }]
  },
  {
    id: 'M30',
    desc: 'PUT /compartments/:id/filters loses its transaction wrapper',
    edits: [{
      file: STORAGE,
      find: `    await db.withTransaction(async (tx) => {
      await tx.run(\`DELETE FROM compartment_assignments WHERE compartment_id = ?\`, [comp.id]);`,
      replace: `    await (async (tx) => {
      await tx.run(\`DELETE FROM compartment_assignments WHERE compartment_id = ?\`, [comp.id]);`
    }, {
      file: STORAGE,
      find: `        if (filterVal) await tx.run(\`INSERT OR IGNORE INTO compartment_assignments (compartment_id, filter_value) VALUES (?, ?)\`, [comp.id, filterVal]);
      }
    });`,
      replace: `        if (filterVal) await tx.run(\`INSERT OR IGNORE INTO compartment_assignments (compartment_id, filter_value) VALUES (?, ?)\`, [comp.id, filterVal]);
      }
    })(db);`
    }]
  },
  {
    id: 'M31',
    desc: 'PUT /locations/:id loses its transaction wrapper (rule-change eviction)',
    edits: [{
      file: STORAGE,
      find: `    const evicted = await db.withTransaction(async (tx) => {`,
      replace: `    const evicted = await (async (tx) => {`
    }, {
      file: STORAGE,
      find: `      return count;
    });
    res.json({ message: 'Location updated', evicted });`,
      replace: `      return count;
    })(db);
    res.json({ message: 'Location updated', evicted });`
    }]
  },
  {
    id: 'M32',
    desc: 'POST /locations/:id/compartments drops location ownership check (BUG 2 site)',
    edits: [{
      file: STORAGE,
      find: `    const loc = await requireOwnedLocation(null, id, req.user.id);

    // Read-then-insert is a single logical operation`,
      replace: `    const loc = (await db.get(\`SELECT id, type FROM locations WHERE id = ?\`, [id])) || { id: Number(id), type: 'Box' };

    // Read-then-insert is a single logical operation`
    }]
  },
  {
    id: 'M41',
    desc: 'POST /locations/:id/compartments loses its transaction wrapper (read-then-insert race)',
    edits: [{
      file: STORAGE,
      find: `    const created = await db.withTransaction(async (tx) => {
      // The previous read was`,
      replace: `    const created = await (async (tx) => {
      // The previous read was`
    }, {
      file: STORAGE,
      find: `      return tx.get(\`SELECT * FROM compartments WHERE id = ?\`, [result.lastID]);
    });`,
      replace: `      return tx.get(\`SELECT * FROM compartments WHERE id = ?\`, [result.lastID]);
    })(db);`
    }]
  },
  {
    // EQUIVALENT MUTANT -- retained deliberately, and expected to survive.
    //
    // I initially believed the old `SELECT MAX(idx) AS maxIdx, capacity ...`
    // read an arbitrary row's capacity. That is the ANSI-SQL expectation, and
    // it is what a tie-based experiment on a table WITHOUT a unique constraint
    // appears to show. It is wrong here, for two compounding reasons:
    //
    //   1. SQLite documents a special case: when a query contains exactly one
    //      MIN() or MAX() aggregate and no GROUP BY, bare columns are taken
    //      from the row that produced that extreme value. So `capacity` really
    //      does come from the highest-idx row.
    //   2. `compartments` carries UNIQUE(location_id, idx), so ties on idx --
    //      the only case where the choice could be ambiguous -- cannot exist.
    //
    // The rewrite is therefore a READABILITY and portability fix, not a
    // behavior fix: it stops depending on a SQLite-specific extension and on a
    // dead ORDER BY clause. Since behavior is unchanged, no test can kill this
    // mutant, and writing one that appeared to would mean writing a test that
    // asserts something false. Kept in the catalogue so the next reviewer sees
    // the analysis instead of re-deriving it.
    id: 'M33',
    equivalent: true,
    desc: 'EQUIVALENT: compartment create aggregate read (SQLite bare-column special case)',
    edits: [{
      file: STORAGE,
      find: `      const template = await tx.get(
        \`SELECT capacity FROM compartments WHERE location_id = ? ORDER BY idx DESC, id DESC LIMIT 1\`,
        [loc.id]
      );`,
      replace: `      const template = await tx.get(
        \`SELECT MAX(idx) AS maxIdx, capacity FROM compartments WHERE location_id = ? ORDER BY idx DESC LIMIT 1\`,
        [loc.id]
      );`
    }]
  },

  // -- previously UNCATALOGUED cross-tenant guards -------------------------
  //
  // These are the five the security reviewer reproduced working attacks
  // against. Every one is a bare `AND user_id = ?` on a DELETE or UPDATE. They
  // survived four rounds not because anyone judged them safe but because no
  // mutant named them: the catalogue only grew to cover routes that had
  // already failed a previous round. That is the whack-a-mole loop itself.
  {
    id: 'M45',
    desc: 'DELETE /collection/:id drops the user_id scope (delete any user card)',
    edits: [{
      file: COLLECTION,
      find: `    const result = await db.run(\`DELETE FROM collection WHERE id = ? AND user_id = ?\`, [id, req.user.id]);`,
      replace: `    const result = await db.run(\`DELETE FROM collection WHERE id = ?\`, [id]);`
    }]
  },
  {
    id: 'M46',
    desc: 'bulk delete drops the user_id scope (mass cross-tenant delete)',
    edits: [{
      file: COLLECTION,
      find: `      const result = await db.run(\`DELETE FROM collection WHERE id IN (\${placeholders}) AND user_id = ?\`, [...ids, req.user.id]);`,
      replace: `      const result = await db.run(\`DELETE FROM collection WHERE id IN (\${placeholders})\`, [...ids]);`
    }]
  },
  {
    id: 'M47',
    desc: 'bulk trade/untrade drops the user_id scope (mutate foreign rows)',
    edits: [{
      file: COLLECTION,
      find: `      const result = await db.run(\`UPDATE collection SET is_trade = ? WHERE id IN (\${placeholders}) AND user_id = ?\`, [action === 'trade' ? 1 : 0, ...ids, req.user.id]);`,
      replace: `      const result = await db.run(\`UPDATE collection SET is_trade = ? WHERE id IN (\${placeholders})\`, [action === 'trade' ? 1 : 0, ...ids]);`
    }]
  },
  {
    id: 'M48',
    desc: 'bulk list_type drops the user_id scope (move foreign cards to wishlist)',
    edits: [{
      file: COLLECTION,
      find: `      const result = await db.run(\`UPDATE collection SET list_type = ? WHERE id IN (\${placeholders}) AND user_id = ?\`, [value, ...ids, req.user.id]);`,
      replace: `      const result = await db.run(\`UPDATE collection SET list_type = ? WHERE id IN (\${placeholders})\`, [value, ...ids]);`
    }]
  },
  {
    id: 'M49',
    desc: 'bulk condition/printing drops the user_id scope (rewrite foreign card data)',
    edits: [{
      file: COLLECTION,
      find: `      const result = await db.run(\`UPDATE collection SET \${action} = ? WHERE id IN (\${placeholders}) AND user_id = ?\`, [value, ...ids, req.user.id]);`,
      replace: `      const result = await db.run(\`UPDATE collection SET \${action} = ? WHERE id IN (\${placeholders})\`, [value, ...ids]);`
    }]
  },
  {
    id: 'M50',
    desc: 'DELETE /collection/filters/presets/:id drops the user_id scope',
    edits: [{
      file: COLLECTION,
      find: `    const result = await db.run(\`DELETE FROM saved_filter_presets WHERE id = ? AND user_id = ?\`, [id, req.user.id]);`,
      replace: `    const result = await db.run(\`DELETE FROM saved_filter_presets WHERE id = ?\`, [id]);`
    }]
  },
  {
    id: 'M51',
    desc: 'bulk purchase_split drops the user_id scope on the row selection',
    edits: [{
      file: COLLECTION,
      find: `         WHERE c.id IN (\${placeholders}) AND c.user_id = ?\`,
        [...ids, req.user.id]`,
      replace: `         WHERE c.id IN (\${placeholders})\`,
        [...ids]`
    }]
  },
  {
    id: 'M52',
    desc: 'bulk add_to_deck drops the user_id scope on the source rows',
    edits: [{
      file: COLLECTION,
      find: `        \`SELECT card_id, SUM(quantity) as total_qty FROM collection WHERE id IN (\${placeholders}) AND user_id = ? GROUP BY card_id\`,
        [...ids, req.user.id]`,
      replace: `        \`SELECT card_id, SUM(quantity) as total_qty FROM collection WHERE id IN (\${placeholders}) GROUP BY card_id\`,
        [...ids]`
    }]
  },
  {
    id: 'M53',
    desc: 'bulk add_to_deck drops the deck ownership check',
    edits: [{
      file: COLLECTION,
      find: `      const deck = await db.get(\`SELECT id FROM decks WHERE id = ? AND user_id = ?\`, [deckId, req.user.id]);`,
      replace: `      const deck = await db.get(\`SELECT id FROM decks WHERE id = ?\`, [deckId]);`
    }]
  },
  {
    // REDUNDANT-BY-CONSTRUCTION mutant. Expected to survive; guard retained.
    //
    // The loop above this statement reads
    //   `SELECT * FROM collection WHERE id = ? AND user_id = ?`
    // and does `if (!entry) continue;`. A foreign id therefore never reaches
    // the UPDATE at all, so removing the UPDATE's own `AND user_id = ?` cannot
    // change behavior: the id has already been proven to belong to the caller.
    //
    // This is the "call site pre-sanitizes" category the round-4 reviewer
    // identified. The clause is correctly harmless and stays -- it keeps the
    // statement safe if the guarding read above it is ever refactored -- but it
    // is PRESENT, not PROVEN, and must not be cited as a tested guard. T43
    // covers the actual protection here, which is the ownership-checked read.
    id: 'M54',
    unreachable: true,
    desc: 'REDUNDANT: bulk unfile UPDATE scope (call site pre-filters by owner)',
    edits: [{
      file: COLLECTION,
      find: `          await tx.run(\`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE id = ? AND user_id = ?\`, [id, req.user.id]);
          count++;`,
      replace: `          await tx.run(\`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE id = ?\`, [id]);
          count++;`
    }]
  },
  {
    id: 'M55',
    desc: 'PUT /collection/:id drops the user_id scope on the entry lookup',
    edits: [{
      file: COLLECTION,
      find: `      const entry = await tx.get(\`SELECT * FROM collection WHERE id = ? AND user_id = ?\`, [id, req.user.id]);
      if (!entry) throw new InvariantError(404, 'Collection entry not found', 'ENTRY_NOT_FOUND');

      const isMoving`,
      replace: `      const entry = await tx.get(\`SELECT * FROM collection WHERE id = ?\`, [id]);
      if (!entry) throw new InvariantError(404, 'Collection entry not found', 'ENTRY_NOT_FOUND');

      const isMoving`
    }, {
      file: COLLECTION,
      find: `        await tx.run(\`UPDATE collection SET \${updates.join(', ')} WHERE id = ? AND user_id = ?\`, params);`,
      replace: `        params.pop();
        await tx.run(\`UPDATE collection SET \${updates.join(', ')} WHERE id = ?\`, params);`
    }]
  },
  {
    id: 'M56',
    desc: 'place drops the user_id scope on the entry lookup (place any user card)',
    edits: [{
      file: COLLECTION,
      find: `      const entry = await tx.get(\`SELECT * FROM collection WHERE id = ? AND user_id = ?\`, [id, req.user.id]);
      if (!entry) throw new InvariantError(404, 'Collection entry not found', 'ENTRY_NOT_FOUND');

      const comp`,
      replace: `      const entry = await tx.get(\`SELECT * FROM collection WHERE id = ?\`, [id]);
      if (!entry) throw new InvariantError(404, 'Collection entry not found', 'ENTRY_NOT_FOUND');

      const comp`
    }, {
      file: COLLECTION,
      find: `        await tx.run(\`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?\`,
          [comp.id, comp.loc_id, slot * 1000, id, req.user.id]);`,
      replace: `        await tx.run(\`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ?\`,
          [comp.id, comp.loc_id, slot * 1000, id]);`
    }]
  },
  {
    id: 'M57',
    desc: 'place drops the user_id scope on the swap partner lookup',
    edits: [{
      file: COLLECTION,
      find: `        const other = await tx.get(\`SELECT * FROM collection WHERE id = ? AND user_id = ?\`, [swap_with, req.user.id]);`,
      replace: `        const other = await tx.get(\`SELECT * FROM collection WHERE id = ?\`, [swap_with]);`
    }]
  },
  {
    id: 'M58',
    desc: 'place drops the slot lower-bound check (negative/zero slot)',
    edits: [{
      file: COLLECTION,
      find: `      if (!Number.isInteger(slot) || slot < 1) {
        throw new InvariantError(400, 'Invalid slot', 'INVALID_SLOT');
      }`,
      replace: `      /* mutant M58: slot bounds check removed */`
    }]
  },
  {
    id: 'M59',
    desc: 'bulk action whitelist removed (arbitrary column write via action name)',
    edits: [{
      file: COLLECTION,
      find: `  if (!BULK_ACTIONS.includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }`,
      replace: `  /* mutant M59: action whitelist removed */`
    }]
  },
  {
    id: 'M60',
    desc: 'bulk condition/printing value whitelist removed (violates CHECK constraint)',
    edits: [{
      file: COLLECTION,
      find: `      if (!allowed.includes(value)) return res.status(400).json({ error: \`Invalid \${action}\` });`,
      replace: `      /* mutant M60: value whitelist removed */`
    }]
  },
  {
    id: 'M61',
    desc: 'bulk-add drops the batch size / expanded-operation bound',
    edits: [{
      file: COLLECTION,
      find: `    boundedProduct([card_ids.length, shared.quantity], { name: 'expanded operations', max: 1000 });`,
      replace: `    /* mutant M61: expansion bound removed */`
    }]
  },
  {
    id: 'M62',
    desc: 'bulk entry_ids bound/sanitisation removed',
    edits: [{
      file: COLLECTION,
      find: `    ids = uniqueIntegerIds(entry_ids, { name: 'entry_ids', maxLength: 1000 });`,
      replace: `    ids = entry_ids;`
    }]
  },

  // -- storage.js: previously uncatalogued guards --------------------------
  {
    id: 'M63',
    desc: 'PUT /locations/:id drops the ownership check on the location',
    edits: [{
      file: STORAGE,
      find: `    const loc = await db.get(\`SELECT id, sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?\`, [id, req.user.id]);
    if (!loc) {
      return res.status(404).json({ error: 'Location not found' });
    }`,
      replace: `    const loc = await db.get(\`SELECT id, sort_order, foil_sorting FROM locations WHERE id = ?\`, [id]);
    if (!loc) {
      return res.status(404).json({ error: 'Location not found' });
    }`
    }, {
      file: STORAGE,
      find: `        WHERE id = ? AND user_id = ?
      \`, [name, type, sort_order, foil_sorting, rule_type, ruleConfigJson, locked === undefined ? null : (locked ? 1 : 0), id, req.user.id]);`,
      replace: `        WHERE id = ?
      \`, [name, type, sort_order, foil_sorting, rule_type, ruleConfigJson, locked === undefined ? null : (locked ? 1 : 0), id]);`
    }]
  },
  {
    id: 'M64',
    desc: 'PATCH /compartments/:id drops the ownership check (flat route)',
    edits: [{
      file: STORAGE,
      find: `    const comp = await getOwnedCompartment(id, req.user.id);
    if (!comp) return res.status(404).json({ error: 'Compartment not found' });

    let ruleConfigJson;`,
      replace: `    const comp = await db.get(\`SELECT cp.*, cp.location_id AS loc_id FROM compartments cp WHERE cp.id = ?\`, [id]);
    if (!comp) return res.status(404).json({ error: 'Compartment not found' });

    let ruleConfigJson;`
    }]
  },
  {
    id: 'M65',
    desc: 'DELETE /compartments/:id drops the ownership check (flat route)',
    edits: [{
      file: STORAGE,
      find: `    const comp = await getOwnedCompartment(id, req.user.id);
    if (!comp) return res.status(404).json({ error: 'Compartment not found' });
    const total = await db.get(`,
      replace: `    const comp = await db.get(\`SELECT cp.*, cp.location_id AS loc_id FROM compartments cp WHERE cp.id = ?\`, [id]);
    if (!comp) return res.status(404).json({ error: 'Compartment not found' });
    const total = await db.get(`
    }]
  },
  {
    id: 'M66',
    desc: 'PUT /compartments/:id/filters drops the ownership check (flat route)',
    edits: [{
      file: STORAGE,
      find: `    const comp = await getOwnedCompartment(id, req.user.id);
    if (!comp) return res.status(404).json({ error: 'Compartment not found' });
    // Replacing the filter set`,
      replace: `    const comp = await db.get(\`SELECT cp.*, cp.location_id AS loc_id FROM compartments cp WHERE cp.id = ?\`, [id]);
    if (!comp) return res.status(404).json({ error: 'Compartment not found' });
    // Replacing the filter set`
    }]
  },
  {
    id: 'M67',
    desc: 'DELETE /compartments/:id drops the last-compartment guard (flat route)',
    edits: [{
      file: STORAGE,
      find: `    if (total.count <= 1) return res.status(400).json({ error: 'Cannot delete the last compartment of a location' });`,
      replace: `    /* mutant M67: last-compartment guard removed */`
    }]
  },
  {
    id: 'M68',
    desc: 'nested DELETE drops the last-compartment guard',
    edits: [{
      file: STORAGE,
      find: `    if (totalComps.count <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last compartment of a location' });
    }`,
      replace: `    /* mutant M68: last-compartment guard removed */`
    }]
  },
  {
    id: 'M69',
    desc: 'POST /locations/:id/apply-all drops the location ownership check',
    edits: [{
      file: STORAGE,
      find: `    const location = await requireOwnedLocation(null, id, req.user.id);

    // Filing a batch is one logical operation.`,
      replace: `    const location = await db.get(\`SELECT * FROM locations WHERE id = ?\`, [id]);

    // Filing a batch is one logical operation.`
    }]
  },
  {
    id: 'M70',
    desc: 'POST /locations/:id/resort drops the location ownership check',
    edits: [{
      file: STORAGE,
      find: `    const location = await requireOwnedLocation(null, id, req.user.id);

    // The most destructive write path`,
      replace: `    const location = await db.get(\`SELECT * FROM locations WHERE id = ?\`, [id]);

    // The most destructive write path`
    }]
  },
  {
    id: 'M71',
    desc: 'POST /locations drops the compartmentPlan bounds (unbounded compartment insert)',
    edits: [{
      file: STORAGE,
      find: `    plan.count = positiveInteger(plan.count, { name: 'compartmentPlan.count', max: 1000 });
    plan.capacity = positiveInteger(plan.capacity, { name: 'compartmentPlan.capacity', max: 1000 });`,
      replace: `    /* mutant M71: compartmentPlan bounds removed */`
    }]
  },
  {
    id: 'M72',
    desc: 'POST /locations loses its transaction wrapper (location without compartments)',
    edits: [{
      file: STORAGE,
      find: `    const newId = await db.withTransaction(async (tx) => {`,
      replace: `    const newId = await (async (tx) => {`
    }, {
      file: STORAGE,
      find: `      return result.lastID;
    });

    res.status(200).json({ message: 'Location created', id: newId });`,
      replace: `      return result.lastID;
    })(db);

    res.status(200).json({ message: 'Location created', id: newId });`
    }]
  },
  {
    id: 'M73',
    desc: 'PATCH /compartments/:id loses its transaction wrapper (refused shrink leaks label write)',
    edits: [{
      file: STORAGE,
      find: `    let evicted = 0;
    await db.withTransaction(async (tx) => {
      if (capacity !== undefined) {`,
      replace: `    let evicted = 0;
    await (async (tx) => {
      if (capacity !== undefined) {`
    }, {
      file: STORAGE,
      find: `      }
    });

    res.json({ message: 'Compartment updated', evicted });`,
      replace: `      }
    })(db);

    res.json({ message: 'Compartment updated', evicted });`
    }]
  },
  {
    id: 'M74',
    desc: 'nested compartment PUT loses its transaction wrapper',
    edits: [{
      file: STORAGE,
      find: `    await db.withTransaction(async (tx) => {
      // The capacity guard reads occupancy inside this transaction`,
      replace: `    await (async (tx) => {
      // The capacity guard reads occupancy inside this transaction`
    }, {
      file: STORAGE,
      find: `        }
      }
    });

    res.json({ message: 'Compartment updated successfully' });`,
      replace: `        }
      }
    })(db);

    res.json({ message: 'Compartment updated successfully' });`
    }]
  },
  {
    id: 'M75',
    desc: 'nested compartment DELETE unfiles by bare compartment_id (drops user_id scope)',
    edits: [{
      file: STORAGE,
      find: `        \`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE compartment_id = ? AND user_id = ?\`,
        [compartment.id, req.user.id]`,
      replace: `        \`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE compartment_id = ?\`,
        [compartment.id]`
    }]
  },
  {
    // REDUNDANT-BY-CONSTRUCTION mutant. Expected to survive; guard retained.
    //
    // `requireOwnedCompartmentInLocation` has already proven the pair is
    // consistent before this statement runs, so on every request that reaches
    // the write, compartment.location_id === loc.id and the extra predicate
    // cannot change which row matches.
    //
    // The obvious way to force a divergence -- reparent the compartment
    // mid-statement with a BEFORE trigger -- does not work either: SQLite
    // evaluates the outer statement's WHERE before firing the trigger, so the
    // write lands regardless. Verified by reproduction, not assumed. See the
    // note in T48.
    //
    // PRESENT, not PROVEN. It stays because it keeps the statement safe if the
    // pair check is ever weakened or reordered, which is the exact bug this
    // route shipped once already.
    id: 'M76',
    unreachable: true,
    desc: 'REDUNDANT: nested DELETE parent scope (pair check pre-validates)',
    edits: [{
      file: STORAGE,
      find: `      await tx.run(\`DELETE FROM compartments WHERE id = ? AND location_id = ?\`, [compartment.id, loc.id]);`,
      replace: `      await tx.run(\`DELETE FROM compartments WHERE id = ?\`, [compartment.id]);`
    }]
  },
  {
    // REDUNDANT-BY-CONSTRUCTION mutant. Same analysis as M76: the pair check
    // upstream guarantees compartment.location_id === loc.id on every request
    // that reaches this UPDATE, and the trigger-based divergence attempt fails
    // for the SQLite evaluation-order reason documented there.
    // PRESENT, not PROVEN. Retained as defence against a future reordering.
    id: 'M77',
    unreachable: true,
    desc: 'REDUNDANT: nested PUT parent scope (pair check pre-validates)',
    edits: [{
      file: STORAGE,
      find: `          \`UPDATE compartments SET \${updates.join(', ')} WHERE id = ? AND location_id = ?\`,
          [...params, compartment.id, loc.id]`,
      replace: `          \`UPDATE compartments SET \${updates.join(', ')} WHERE id = ?\`,
          [...params, compartment.id]`
    }]
  },
  {
    id: 'M78',
    desc: 'POST /locations/:id/recommend-batch drops the entry_ids bound',
    edits: [{
      file: STORAGE,
      find: `    uniqueIntegerIds(entry_ids, { name: 'entry_ids', maxLength: 1000 });
  } catch (error) {
    if (error instanceof RequestBoundsError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
  try {
    const location = await db.get(\`SELECT * FROM locations WHERE id = ? AND user_id = ?\`, [id, req.user.id]);
    if (!location) return res.status(404).json({ error: 'Location not found' });

    let workingCompartments`,
      replace: `    /* mutant M78: entry_ids bound removed */
  } catch (error) {
    if (error instanceof RequestBoundsError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
  try {
    const location = await db.get(\`SELECT * FROM locations WHERE id = ? AND user_id = ?\`, [id, req.user.id]);
    if (!location) return res.status(404).json({ error: 'Location not found' });

    let workingCompartments`
    }]
  },
  {
    id: 'M79',
    desc: 'apply-all drops the entry_ids bound',
    edits: [{
      file: STORAGE,
      find: `    uniqueIntegerIds(entry_ids, { name: 'entry_ids', maxLength: 1000 });
  } catch (error) {
    if (error instanceof RequestBoundsError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
  try {
    const location = await requireOwnedLocation(null, id, req.user.id);`,
      replace: `    /* mutant M79: entry_ids bound removed */
  } catch (error) {
    if (error instanceof RequestBoundsError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
  try {
    const location = await requireOwnedLocation(null, id, req.user.id);`
    }]
  },
  {
    id: 'M80',
    desc: 'apply-all drops the user_id scope on the entry lookup',
    edits: [{
      file: STORAGE,
      find: `          WHERE c.id = ? AND c.user_id = ?
        \`, [entryId, req.user.id]);
        if (!entry) continue;`,
      replace: `          WHERE c.id = ?
        \`, [entryId]);
        if (!entry) continue;`
    }]
  },
  {
    // EQUIVALENT MUTANT -- expected to survive, established by reproduction.
    //
    // I expected this to be killable and it is not. The reasoning that turned
    // out to be wrong was "an unscoped read puts a foreign card into the sort
    // plan, so the caller's own cards get displaced". Three things prevent any
    // observable difference:
    //
    //   1. The refile UPDATE is separately scoped `WHERE id = ? AND user_id = ?`,
    //      so a foreign row that enters the plan is never actually written.
    //   2. Position is not assigned from the plan's index. Each iteration calls
    //      `recommendSlot(tx, location, entry, workingCompartments, [])`, which
    //      recomputes placement from its OWN read -- and that read is scoped
    //      `WHERE c.user_id = ? AND c.location_id = ?` using `location.user_id`
    //      (compartmentSort.js:295). The planner therefore never sees the
    //      foreign row regardless of what the outer read selected.
    //   3. The unfile statement is likewise `AND c.user_id = ?`.
    //
    // Reproduced both ways with a foreign row sharing the caller's compartment:
    // pristine and mutant produce byte-identical rows (own position 1000,
    // foreign untouched at 1000). No behavior test can separate them.
    //
    // The clause STAYS: it keeps this handler's own reads consistent with its
    // writes, and it is what contains the bug if `recommendSlot`'s internal
    // scoping is ever relaxed. PRESENT, not PROVEN. T47 covers the observable
    // contract (foreign rows unmoved, own card refiled to the first slot).
    id: 'M81',
    equivalent: true,
    desc: 'EQUIVALENT: resort card-read scope (planner re-reads user-scoped; writes separately scoped)',
    edits: [{
      file: STORAGE,
      find: `        WHERE c.location_id = ? AND c.user_id = ?
      \`, [location.id, req.user.id]);
      cards.forEach`,
      replace: `        WHERE c.location_id = ?
      \`, [location.id]);
      cards.forEach`
    }]
  },
  {
    // EQUIVALENT MUTANT -- expected to survive, verified empirically.
    //
    // The statement clears location_id and compartment_id. BOTH columns are
    // also cleared by the schema's foreign keys the moment the DELETE lands:
    //   FOREIGN KEY(location_id)    REFERENCES locations(id)    ON DELETE SET NULL
    //   FOREIGN KEY(compartment_id) REFERENCES compartments(id) ON DELETE SET NULL
    // and `PRAGMA foreign_keys = ON` is set at connection time (src/db.js:23).
    //
    // Reproduced rather than reasoned about: a row belonging to user B sitting
    // in user A's location has both columns nulled by the cascade after A
    // deletes the location, with or without the user_id clause. The two
    // versions are therefore observationally identical and no behavior test can
    // separate them.
    //
    // The clause STAYS. It states the handler's intent locally instead of
    // depending on a schema declaration in another file, and it is what
    // contains the bug the day someone changes that FK to RESTRICT or NO
    // ACTION. See T49, which pins the observable contract instead.
    id: 'M82',
    equivalent: true,
    desc: 'EQUIVALENT: location DELETE unfile scope (shadowed by ON DELETE SET NULL cascade)',
    edits: [{
      file: STORAGE,
      find: `      await tx.run(\`UPDATE collection SET location_id = NULL, compartment_id = NULL WHERE location_id = ? AND user_id = ?\`, [loc.id, req.user.id]);`,
      replace: `      await tx.run(\`UPDATE collection SET location_id = NULL, compartment_id = NULL WHERE location_id = ?\`, [loc.id]);`
    }]
  },
  {
    id: 'M83',
    desc: 'POST /locations drops the duplicate-name guard',
    edits: [{
      file: STORAGE,
      find: `    const existing = await db.get(\`SELECT id FROM locations WHERE name = ? AND user_id = ?\`, [name, req.user.id]);
    if (existing) {
      return res.status(400).json({ error: 'A location with this name already exists' });
    }`,
      replace: `    /* mutant M83: duplicate-name guard removed */`
    }]
  },
  {
    id: 'M84',
    desc: 'PATCH /compartments/:id updateAll fan-out escapes the owning location',
    edits: [{
      file: STORAGE,
      find: `        if (updateAll) await tx.run(\`UPDATE compartments SET capacity = ? WHERE location_id = ?\`, [cap, comp.loc_id]);`,
      replace: `        if (updateAll) await tx.run(\`UPDATE compartments SET capacity = ? WHERE location_id IS NOT NULL\`, [cap]);`
    }]
  },

  // -- storageInvariants.js ------------------------------------------------
  {
    id: 'M34',
    desc: 'occupancy reverts to COUNT(*) instead of SUM(quantity)',
    edits: [{
      file: INVARIANTS,
      find: `  let sql = \`SELECT COALESCE(SUM(quantity), 0) AS occupied FROM collection WHERE compartment_id = ?\`;`,
      replace: `  let sql = \`SELECT COUNT(*) AS occupied FROM collection WHERE compartment_id = ?\`;`
    }]
  },
  {
    id: 'M35',
    desc: 'assertParentChild no longer compares the pair',
    edits: [{
      file: INVARIANTS,
      find: `  if (Number(compartment.location_id) !== Number(location.id)) {
    throw new InvariantError(400, 'Compartment does not belong to the specified location', 'PARENT_CHILD_MISMATCH');
  }`,
      replace: `  /* mutant M35: pair comparison removed */`
    }]
  },
  {
    id: 'M36',
    desc: 'findOwnedCompartment drops the user_id scope (cross-tenant read)',
    edits: [{
      file: INVARIANTS,
      find: `     WHERE cp.id = ? AND l.user_id = ?\`,
    [numericId, userId]`,
      replace: `     WHERE cp.id = ? AND (? IS NOT NULL)\`,
    [numericId, userId]`
    }]
  },
  {
    id: 'M37',
    desc: 'findOwnedLocation drops the user_id scope (cross-tenant read)',
    edits: [{
      file: INVARIANTS,
      find: `    \`SELECT * FROM locations WHERE id = ? AND user_id = ?\`,
    [numericId, userId]`,
      replace: `    \`SELECT * FROM locations WHERE id = ? AND (? IS NOT NULL)\`,
    [numericId, userId]`
    }]
  },
  {
    id: 'M38',
    desc: 'assertCapacityFor stops enforcing the limit',
    edits: [{
      file: INVARIANTS,
      find: `  if (occupied + wanted > capacity) {
    throw new InvariantError(400, 'COMPARTMENT_FULL', 'COMPARTMENT_FULL');
  }`,
      replace: `  /* mutant M38: capacity limit no longer enforced */`
    }]
  },
  {
    id: 'M39',
    desc: 'assertCapacityShrinkAllowed stops refusing an over-committing shrink',
    edits: [{
      file: INVARIANTS,
      find: `  if (occupied > capacity) {
    throw new InvariantError(
      400,
      \`Cannot reduce capacity to \${capacity}: this compartment currently holds \${occupied} card(s). Move cards out first.\`,
      'CAPACITY_BELOW_OCCUPANCY'
    );
  }`,
      replace: `  /* mutant M39: shrink refusal removed */`
    }]
  },
  {
    id: 'M40',
    desc: 'assertCapacityFor ignores excludeEntryId (double-counts the moving row)',
    edits: [{
      file: INVARIANTS,
      find: `  const occupied = await compartmentOccupancy(database, compartment.id, { excludeEntryId });
  const capacity = Number(compartment.capacity);`,
      replace: `  const occupied = await compartmentOccupancy(database, compartment.id, {});
  const capacity = Number(compartment.capacity);`
    }]
  }
];
