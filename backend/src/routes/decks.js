const express = require('express');
const db = require('../db');
const scryfallApi = require('../scryfallApi');
const { recordPrice } = require('../utils/priceHelpers');
const { compartmentLabel } = require('../utils/compartmentSort');
const { buildDeckWarnings } = require('../utils/deckRules');
const deckIdentity = require('../utils/deckIdentity');
const { DeckIdentityError } = deckIdentity;
const { RequestBoundsError, positiveInteger } = require('../utils/requestBounds');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.use(authenticateToken);

// A single deck requirement is one line on a decklist. Four copies of a card is
// one requirement with quantity 4, so the bound is about absurd input, not
// about legitimate deck sizes.
const MAX_REQUIREMENT_QUANTITY = 1000;

const DECK_STATUSES = ['active', 'considering'];

// One place that turns a thrown invariant into a response. Without this, each
// handler decides for itself whether a DeckIdentityError is a 400 or a 500, and
// they drift -- the same bad request answers differently depending on which
// route the client happened to call.
function sendError(res, error, fallbackMessage) {
  if (error instanceof DeckIdentityError || error instanceof RequestBoundsError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  console.error(error);
  return res.status(500).json({ error: fallbackMessage });
}

async function requireOwnedDeck(database, deckId, userId) {
  const numericId = Number(deckId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new DeckIdentityError(404, 'Deck not found', 'DECK_NOT_FOUND');
  }
  const deck = await (database || db).get(
    `SELECT * FROM decks WHERE id = ? AND user_id = ?`, [numericId, userId]
  );
  // Absent and foreign are deliberately indistinguishable: a different status
  // for "exists but is not yours" is an enumeration oracle.
  if (!deck) throw new DeckIdentityError(404, 'Deck not found', 'DECK_NOT_FOUND');
  return deck;
}

// Get User Decks
router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT
        d.id, d.name, d.description, d.format, d.category, d.accent_color,
        d.target_size, d.status, d.created_at, d.checked_out, d.checked_out_at,
        COUNT(dc.id) AS total_card_types,
        COALESCE(SUM(dc.quantity), 0) AS total_cards
      FROM decks d
      LEFT JOIN deck_cards dc ON d.id = dc.deck_id
      WHERE d.user_id = ?
      GROUP BY d.id
      ORDER BY d.created_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (error) {
    sendError(res, error, 'Failed to retrieve decks');
  }
});

// Create Deck.
//
// Note what is NOT here any more: the decklist_text importer. It resolved lines
// by NAME (`WHERE LOWER(name) = LOWER(?) LIMIT 1`) and took whichever printing
// SQLite happened to return first. Under exact-only identity that is precisely
// the forbidden operation -- it silently picks a printing and finish on the
// user's behalf, and the user then owns a requirement they never chose. Name-
// only import belongs in PR 7's import-review flow, where the user resolves
// each ambiguous line explicitly.
router.post('/', async (req, res) => {
  const {
    name,
    description = '',
    format = 'Commander / EDH',
    category = 'Competitive',
    accent_color = '#eab308',
    target_size = 100,
    status = 'active'
  } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Deck name is required' });
  }
  if (!DECK_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${DECK_STATUSES.join(', ')}` });
  }

  const targetSizeNum = parseInt(target_size, 10) || 100;

  try {
    const result = await db.run(
      `INSERT INTO decks (name, description, format, category, accent_color, target_size, status, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name.trim(), description, format, category, accent_color, targetSizeNum, status, req.user.id]
    );
    res.status(201).json({ message: 'Deck created successfully', id: result.lastID, status });
  } catch (error) {
    sendError(res, error, 'Failed to create deck');
  }
});

// Get Deck Details, with server-computed ownership and reservation.
//
// The server is the source of truth for every quantity here. The frontend used
// to recompute "owned" and "missing" from a raw card list, which meant the
// business rule existed twice and the two copies could disagree -- and the copy
// the user believes is the one on their screen.
router.get('/:id', async (req, res) => {
  try {
    const deck = await requireOwnedDeck(db, req.params.id, req.user.id);
    const { entries } = await deckIdentity.availabilityForDeck(db, deck.id, req.user.id);
    const warnings = await buildDeckWarnings(db, deck, entries);
    res.json({ ...deck, cards: entries, warnings });
  } catch (error) {
    sendError(res, error, 'Failed to retrieve deck details');
  }
});

// Update Deck Metadata, including active/considering status.
//
// Status is a reservation-visible field: flipping a deck to 'considering'
// releases every copy its REAL entries were holding, and flipping it back
// re-claims them at their ORIGINAL priority, because priority is deck_cards.id
// and those ids do not change. That is the desired behavior -- parking a deck
// for a week should not cost it its cards when you unpark it.
//
// Considering ENTRIES are unaffected by this either way: they never reserved,
// so there is nothing for a status flip to release or reclaim.
router.put('/:id', async (req, res) => {
  const { name, description, status } = req.body;

  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'Deck name is required' });
  }
  if (status !== undefined && !DECK_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${DECK_STATUSES.join(', ')}` });
  }

  try {
    const result = await db.withTransaction(async (tx) => {
      const deck = await requireOwnedDeck(tx, req.params.id, req.user.id);

      // Status is a reservation-visible field, but it is NOT a physical one. The
      // cards a checked-out deck is holding are protected by its rows in
      // deck_card_allocations, which this edit does not touch, so parking a
      // checked-out deck is a plain metadata change: the deck stops competing
      // for inventory while the sleeves stay exactly where they are.
      await tx.run(
        `UPDATE decks SET name = ?, description = ?, status = ? WHERE id = ? AND user_id = ?`,
        [
          name !== undefined ? name.trim() : deck.name,
          description !== undefined ? description : deck.description,
          status !== undefined ? status : deck.status,
          deck.id,
          req.user.id
        ]
      );
      return deck.id;
    });

    const { entries } = await deckIdentity.availabilityForDeck(db, result, req.user.id);
    res.json({ message: 'Deck updated successfully', cards: entries });
  } catch (error) {
    sendError(res, error, 'Failed to update deck');
  }
});

// Delete Deck.
//
// One transaction covering allocations, requirements and the deck row. Deleting
// a deck is a multi-step mutation, and a partial delete leaves orphaned
// allocations pointing at collection rows -- copies the user's storage view
// would keep showing as "in a deck" that no longer exists.
router.delete('/:id', async (req, res) => {
  try {
    await db.withTransaction(async (tx) => {
      const deck = await requireOwnedDeck(tx, req.params.id, req.user.id);
      await tx.run(
        `DELETE FROM deck_card_allocations
         WHERE deck_card_id IN (SELECT id FROM deck_cards WHERE deck_id = ?)`,
        [deck.id]
      );
      await tx.run(`DELETE FROM deck_cards WHERE deck_id = ?`, [deck.id]);
      await tx.run(`DELETE FROM decks WHERE id = ? AND user_id = ?`, [deck.id, req.user.id]);
    });
    res.json({ message: 'Deck deleted successfully' });
  } catch (error) {
    sendError(res, error, 'Failed to delete deck');
  }
});

// Add or update an EXACT requirement.
//
// Both desired_card_id and desired_finish are mandatory with no default. A
// default finish would be the system silently choosing a physical object on the
// user's behalf -- they would be told they own the card, walk to the binder,
// and find the wrong version. Making the client state its choice is the whole
// point of exact-only identity.
router.post('/:id/cards', async (req, res) => {
  const { desired_card_id, desired_finish, board = 'mainboard', quantity = 1 } = req.body;

  if (!desired_card_id) {
    return res.status(400).json({ error: 'desired_card_id is required' });
  }
  if (!desired_finish) {
    return res.status(400).json({ error: 'desired_finish is required' });
  }
  if (!deckIdentity.isFinish(desired_finish)) {
    return res.status(400).json({ error: `desired_finish must be one of ${deckIdentity.FINISHES.join(', ')}` });
  }
  if (!deckIdentity.isBoard(board)) {
    return res.status(400).json({ error: `board must be one of ${deckIdentity.BOARDS.join(', ')}` });
  }

  let quantityNum;
  try {
    quantityNum = positiveInteger(Number(quantity), {
      name: 'quantity', max: MAX_REQUIREMENT_QUANTITY
    });
  } catch (error) {
    return sendError(res, error, 'Invalid quantity');
  }

  try {
    // The Scryfall fetch happens BEFORE the transaction, deliberately. A
    // network call inside a transaction holds SQLite's single write lock for
    // the duration of an upstream request, stalling every other writer behind
    // a third party's latency. Same rule PR 6A established in collection.js.
    const cached = await db.get(`SELECT id FROM card_cache WHERE id = ?`, [desired_card_id]);
    if (!cached) {
      const apiCard = await scryfallApi.getCardById(desired_card_id);
      if (!apiCard) {
        return res.status(404).json({ error: 'Card not found on Scryfall.' });
      }
    }

    const outcome = await db.withTransaction(async (tx) => {
      const deck = await requireOwnedDeck(tx, req.params.id, req.user.id);
      const identity = await deckIdentity.oracleIdentityForCard(tx, desired_card_id, desired_finish);

      // Quantity is the ABSOLUTE new count for this exact variant on this
      // board, not a delta. A delta makes a retried request (dropped response,
      // impatient double-tap) silently double the requirement.
      await tx.run(`
        INSERT INTO deck_cards (deck_id, oracle_id, desired_card_id, desired_finish, board, quantity)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(deck_id, oracle_id, desired_card_id, desired_finish, board)
        DO UPDATE SET quantity = excluded.quantity
      `, [deck.id, identity.oracle_id, identity.desired_card_id, identity.desired_finish, board, quantityNum]);

      const { entries } = await deckIdentity.availabilityForDeck(tx, deck.id, req.user.id);
      const warnings = await buildDeckWarnings(tx, deck, entries);
      return { entries, warnings };
    });

    // Price history is best-effort telemetry, so it runs AFTER the transaction
    // commits and its failure never rolls back the user's deck edit.
    const cacheCard = await db.get(`SELECT price_trend FROM card_cache WHERE id = ?`, [desired_card_id]);
    if (cacheCard) await recordPrice(desired_card_id, cacheCard.price_trend).catch(() => {});

    res.json({
      message: 'Requirement saved',
      cards: outcome.entries,
      warnings: outcome.warnings
    });
  } catch (error) {
    sendError(res, error, 'Failed to add card to deck');
  }
});

// Remove a requirement by its deck_cards.id.
//
// Addressed by requirement id rather than by card_id, because card_id is no
// longer unique within a deck: the same printing can legitimately appear on the
// mainboard and the sideboard, and in nonfoil and foil. Deleting "by card" would
// have to guess which of those the user meant.
router.delete('/:id/cards/:deck_card_id', async (req, res) => {
  try {
    const removed = await db.withTransaction(async (tx) => {
      const deck = await requireOwnedDeck(tx, req.params.id, req.user.id);
      const requirement = await tx.get(
        `SELECT id FROM deck_cards WHERE id = ? AND deck_id = ?`,
        [Number(req.params.deck_card_id), deck.id]
      );
      if (!requirement) {
        throw new DeckIdentityError(404, 'Requirement not found', 'REQUIREMENT_NOT_FOUND');
      }
      // Allocations first: the FK is ON DELETE CASCADE, but doing it explicitly
      // keeps the intent visible and does not depend on PRAGMA foreign_keys
      // being on for correctness of this path.
      await tx.run(`DELETE FROM deck_card_allocations WHERE deck_card_id = ?`, [requirement.id]);
      await tx.run(`DELETE FROM deck_cards WHERE id = ?`, [requirement.id]);
      return deck.id;
    });

    const { entries } = await deckIdentity.availabilityForDeck(db, removed, req.user.id);
    res.json({ message: 'Requirement removed', cards: entries });
  } catch (error) {
    sendError(res, error, 'Failed to remove card from deck');
  }
});

// Where to physically find the cards for this deck.
//
// Reads through the STORED allocation when the deck is checked out, and the
// proposed selection otherwise. That split is requirement 6: a checked-out deck
// must keep naming the same sleeve it named when the user pulled it.
router.get('/:id/locations', async (req, res) => {
  try {
    const deck = await requireOwnedDeck(db, req.params.id, req.user.id);
    const { entries } = await deckIdentity.availabilityForDeck(db, deck.id, req.user.id);

    const results = [];
    // Copies proposed to an earlier requirement in THIS same deck, counted per
    // collection row. A Map of copies rather than a list of row ids, because a
    // row is a stack: proposing one Swamp out of a stack of three must leave
    // two, not strike the whole stack off the list.
    const claimedCopies = new Map();
    for (const entry of entries) {
      let picks;
      if (deck.checked_out) {
        const stored = await db.all(`
          SELECT a.collection_entry_id AS entry_id, a.quantity AS take,
                 c.location_id, c.compartment_id, c.position
          FROM deck_card_allocations a
          JOIN collection c ON a.collection_entry_id = c.id
          WHERE a.deck_card_id = ?
          ORDER BY a.id ASC
        `, [entry.id]);
        picks = stored;
      } else {
        // Cards already proposed to an earlier requirement in this same deck
        // must not be proposed again, or a deck needing two copies would be
        // told to pull the same physical card twice. Copies already pulled by
        // any checked-out deck are excluded by selectPhysicalCopies itself.
        const selection = await deckIdentity.selectPhysicalCopies(
          db, req.user.id, entry, { claimedCopies }
        );
        picks = selection.picks;
        picks.forEach(p => claimedCopies.set(p.entry_id, (claimedCopies.get(p.entry_id) || 0) + p.take));
      }

      const locations = [];
      for (const pick of picks) {
        const detail = await db.get(`
          SELECT c.position, l.name AS location_name, l.type AS location_type,
                 cp.label AS compartment_label, cp.idx AS compartment_idx
          FROM collection c
          LEFT JOIN locations l ON c.location_id = l.id
          LEFT JOIN compartments cp ON c.compartment_id = cp.id
          WHERE c.id = ?
        `, [pick.entry_id]);
        locations.push({
          take: pick.take,
          entry_id: pick.entry_id,
          card_name: entry.name,
          set_name: entry.set_name,
          number: entry.number,
          finish: entry.desired_finish,
          location_name: detail?.location_name || 'Unassigned Pile',
          location_type: detail?.location_type || null,
          compartment_display: detail?.compartment_idx !== null && detail?.compartment_idx !== undefined
            ? compartmentLabel(
              { label: detail.compartment_label, idx: detail.compartment_idx },
              detail.location_type
            )
            : detail?.compartment_label || null,
          position: detail?.location_name ? detail.position : null
        });
      }

      const found = locations.reduce((sum, l) => sum + l.take, 0);
      results.push({
        deck_card_id: entry.id,
        desired_card_id: entry.desired_card_id,
        desired_finish: entry.desired_finish,
        board: entry.board,
        required: entry.quantity,
        found,
        missing: Math.max(0, entry.quantity - found),
        locations
      });
    }

    res.json(results);
  } catch (error) {
    sendError(res, error, 'Failed to retrieve card locations');
  }
});

// Checkout: bind requirements to SPECIFIC physical copies and record it.
//
// Availability is enforced here and only here. Editing a deck never requires
// ownership (requirement 5), but taking cards out of a binder does -- you
// cannot pull a card you do not have.
//
// The allocation is WRITTEN, not derived, so that the answer to "which copy is
// in this deck" survives every later change to the collection. That is
// requirement 6, and it is the difference between a deck box the app can still
// describe next month and one it can only guess about.
router.put('/:id/checkout', async (req, res) => {
  try {
    const outcome = await db.withTransaction(async (tx) => {
      const deck = await requireOwnedDeck(tx, req.params.id, req.user.id);

      if (deck.status !== 'active') {
        throw new DeckIdentityError(
          400, 'Only active decks can be checked out.', 'DECK_NOT_ACTIVE'
        );
      }
      if (deck.checked_out) {
        // Idempotent refusal rather than re-allocating. Re-running allocation
        // on an already-checked-out deck is exactly the silent-move failure
        // requirement 6 forbids.
        throw new DeckIdentityError(400, 'Deck is already checked out.', 'DECK_ALREADY_CHECKED_OUT');
      }

      const { entries } = await deckIdentity.availabilityForDeck(tx, deck.id, req.user.id);
      const reserving = entries.filter(e => e.reserves);

      // Validate the WHOLE deck before writing any allocation. A per-card
      // check-then-write would leave a half-allocated deck behind on the first
      // shortfall: some cards marked as pulled, the deck not checked out, and
      // no screen in the app that explains why those copies look busy.
      const shortfalls = [];
      for (const entry of reserving) {
        if (entry.quantity_missing > 0) {
          shortfalls.push(
            `Missing ${entry.quantity_missing}x ${entry.name} (${entry.set_name} #${entry.number}, ${entry.desired_finish})`
          );
        }
      }
      if (shortfalls.length > 0) {
        throw new DeckIdentityError(
          400, 'Not enough cards available to check out this deck.', 'INSUFFICIENT_COPIES'
        );
      }

      // Copies already physically pulled by ANOTHER checked-out deck are off
      // the table entirely -- they are in a deck box across the room. That
      // subtraction now lives inside selectPhysicalCopies, which reads
      // deck_card_allocations per collection row, so it cannot be forgotten by
      // a call site and cannot disagree with the locator's version of it.
      //
      // What stays here is the in-flight bookkeeping: copies this pass has
      // already promised to an earlier requirement of THIS deck, which are not
      // in the database yet. Counted per collection row, because one row can
      // hold several copies and taking one must leave the rest available.
      const claimedCopies = new Map();

      for (const entry of reserving) {
        const { picks, shortfall } = await deckIdentity.selectPhysicalCopies(
          tx, req.user.id, entry, { claimedCopies }
        );
        if (shortfall > 0) {
          // Reachable when another checked-out deck holds the copies that the
          // availability view counted as this deck's reservation. Throwing
          // rolls back every allocation written so far in this transaction.
          throw new DeckIdentityError(
            400,
            `Not enough physical copies of ${entry.name} are free to pull.`,
            'INSUFFICIENT_COPIES'
          );
        }
        for (const pick of picks) {
          await tx.run(
            `INSERT INTO deck_card_allocations (deck_card_id, collection_entry_id, quantity)
             VALUES (?, ?, ?)`,
            [entry.id, pick.entry_id, pick.take]
          );
          claimedCopies.set(pick.entry_id, (claimedCopies.get(pick.entry_id) || 0) + pick.take);
        }
        await tx.run(`UPDATE deck_cards SET checked_out = 1 WHERE id = ?`, [entry.id]);
      }

      await tx.run(
        `UPDATE decks SET checked_out = 1, checked_out_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`,
        [deck.id, req.user.id]
      );
      return { deckId: deck.id, allocated: reserving.length };
    });

    res.json({ message: 'Deck checked out successfully', ...outcome });
  } catch (error) {
    if (error instanceof DeckIdentityError && error.code === 'INSUFFICIENT_COPIES') {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    sendError(res, error, 'Failed to checkout deck');
  }
});

// Return: release the physical allocation.
//
// The deck's RESERVATION survives this. Returning a deck to storage means the
// cards are back in the binder, not that the deck stopped wanting them -- an
// active deck reserves whether or not it is currently assembled.
router.put('/:id/return', async (req, res) => {
  try {
    await db.withTransaction(async (tx) => {
      const deck = await requireOwnedDeck(tx, req.params.id, req.user.id);
      await tx.run(
        `DELETE FROM deck_card_allocations
         WHERE deck_card_id IN (SELECT id FROM deck_cards WHERE deck_id = ?)`,
        [deck.id]
      );
      await tx.run(`UPDATE deck_cards SET checked_out = 0 WHERE deck_id = ?`, [deck.id]);
      await tx.run(
        `UPDATE decks SET checked_out = 0, checked_out_at = NULL WHERE id = ? AND user_id = ?`,
        [deck.id, req.user.id]
      );
    });
    res.json({ message: 'Deck returned to storage successfully' });
  } catch (error) {
    sendError(res, error, 'Failed to return deck');
  }
});

module.exports = router;
