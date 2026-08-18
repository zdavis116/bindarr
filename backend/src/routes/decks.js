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

// An upper bound on one pasted decklist. A Commander list is 100 lines and a
// cube is a few hundred; this is generous for real use and stops a pasted novel
// from holding the write lock while it resolves a million names.
const MAX_IMPORT_LINES = 2000;

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

// Get User Decks.
//
// total_cards counts only cards that are actually IN the deck. Considering
// entries are excluded: they are cards the user is thinking about, not cards in
// the list, and counting them would make a finished 100-card Commander deck
// report 107 and show as over its target on the vault screen. The CASE lives in
// SQL rather than in the client so every screen gets the same number.
router.get('/', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT
        d.id, d.name, d.description, d.format, d.category, d.accent_color,
        d.target_size, d.created_at, d.checked_out, d.checked_out_at,
        COUNT(CASE WHEN dc.board != 'considering' THEN dc.id END) AS total_card_types,
        COALESCE(SUM(CASE WHEN dc.board != 'considering' THEN dc.quantity ELSE 0 END), 0) AS total_cards,
        COALESCE(SUM(CASE WHEN dc.board = 'considering' THEN dc.quantity ELSE 0 END), 0) AS considering_cards
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
// Deck creation takes no decklist text. Importing lines is POST /:id/import,
// which needs a deck to import INTO and is a separate, retryable step: a paste
// that half-resolves must not also decide whether the deck exists.
router.post('/', async (req, res) => {
  const {
    name,
    description = '',
    format = 'Commander / EDH',
    category = 'Competitive',
    accent_color = '#eab308',
    target_size = 100
  } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Deck name is required' });
  }

  const targetSizeNum = parseInt(target_size, 10) || 100;

  try {
    const result = await db.run(
      `INSERT INTO decks (name, description, format, category, accent_color, target_size, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name.trim(), description, format, category, accent_color, targetSizeNum, req.user.id]
    );
    res.status(201).json({ message: 'Deck created successfully', id: result.lastID });
  } catch (error) {
    sendError(res, error, 'Failed to create deck');
  }
});

// Every EXACT variant of one card name that the user actually owns.
//
// This exists because of what exact-only identity did to the "add a card"
// gesture. The old deck builder searched by name and added whatever came back
// first; under exact-only that is precisely the forbidden move, since it picks
// a printing and a finish on the user's behalf and they end up owning a
// requirement they never chose.
//
// So the picker needs a list to choose FROM, and this is it: one row per
// (printing, finish) pair, with how many copies of that pair are in the
// collection AND how many are free right now. Scoped to the collection
// deliberately -- the deck UI's Add Cards flow is "put something I have into a
// deck", and offering printings the user does not own would make the commonest
// case (pick the one I own) require hunting through a hundred irrelevant
// reprints.
//
// `available_qty` is the number that matters when the user REPINS an existing
// entry to a specific printing: owning four Bolts means nothing if three are
// sleeved in another deck, and the picker must say so before they choose,
// rather than letting them pick a printing and then discover a "Missing 3 of 4"
// badge they did not expect. `owned_qty` stays alongside it because the two
// answer different questions and a printing with copies committed elsewhere
// must still read as owned, not vanish.
//
// oracle_id is the grouping key rather than the name, because that is what
// actually means "the same card": it is stable across renames and it will not
// collide two genuinely different cards that share a name.
router.get('/printings/:oracle_id', async (req, res) => {
  try {
    const rows = await deckIdentity.ownedVariantsForOracle(db, req.user.id, req.params.oracle_id);
    res.json(rows);
  } catch (error) {
    sendError(res, error, 'Failed to retrieve printings');
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

// Update Deck Metadata.
//
// There is no status field to update. PR 6C had one ('active' /
// 'considering'); PR 6D removes it because a DECK is never in a considering
// state -- only an individual CARD is, via its board. Moving a card to or from
// the considering board is an edit to that card's requirement, handled by the
// card routes below, and it is the only way "considering" can be expressed.
router.put('/:id', async (req, res) => {
  const { name, description } = req.body;

  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'Deck name is required' });
  }

  try {
    const result = await db.withTransaction(async (tx) => {
      const deck = await requireOwnedDeck(tx, req.params.id, req.user.id);

      await tx.run(
        `UPDATE decks SET name = ?, description = ? WHERE id = ? AND user_id = ?`,
        [
          name !== undefined ? name.trim() : deck.name,
          description !== undefined ? description : deck.description,
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

// Write one import line's allocations as deck requirements.
//
// Extracted because BOTH the explicit-printing path (Case A) and the
// owned-allocation path (Case B) write through it, and having each spell out
// its own upsert is how two paths that must agree start disagreeing.
//
// Quantity is ABSOLUTE in the upsert, so the new total is computed here against
// whatever the row already holds. Importing the same list twice therefore adds
// twice -- which is what "import these cards into my deck" means -- while a
// retried single request cannot double it.
async function writeImportRequirement(tx, deckId, board, allocations) {
  for (const allocation of allocations) {
    const identity = await deckIdentity.oracleIdentityForCard(
      tx, allocation.desired_card_id, allocation.desired_finish
    );
    const existing = await tx.get(
      `SELECT quantity FROM deck_cards
       WHERE deck_id = ? AND desired_card_id = ? AND desired_finish = ? AND board = ?`,
      [deckId, identity.desired_card_id, identity.desired_finish, board]
    );
    const total = Math.min(
      MAX_REQUIREMENT_QUANTITY,
      (existing ? existing.quantity : 0) + allocation.quantity
    );
    await tx.run(`
      INSERT INTO deck_cards (deck_id, oracle_id, desired_card_id, desired_finish, board, quantity)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(deck_id, oracle_id, desired_card_id, desired_finish, board)
      DO UPDATE SET quantity = excluded.quantity
    `, [deckId, identity.oracle_id, identity.desired_card_id, identity.desired_finish, board, total]);
  }
}

// Text import: turn decklist lines into EXACT requirements.
//
// THE UNIFYING PRINCIPLE, stated once and enforced below:
//
//   ASK ONLY WHEN THE APP HAS NO BASIS AT ALL TO CHOOSE A PRINTING.
//
// Two things count as a basis, and either one is enough:
//
//   - The LINE names a printing (set code and/or collector number). The user
//     already answered the question in the text.
//   - The user OWNS at least one free copy. Owning a copy IS an answer to
//     "which physical card did you mean": it is the one in the binder.
//
// Only a bare line where he owns ZERO available copies has neither, and that
// is the SINGLE case that asks. The app still never silently invents a
// printing -- but extending a printing he demonstrably owns is not inventing
// one, it is finishing the sentence he started.
//
// That resolves into three cases, and every line takes exactly one of them:
//
//   CASE A -- THE LINE NAMES A PRINTING. "1 Sol Ring (C21) 263", with or
//     without a *F* finish marker. The user has already answered "which
//     physical card", so there is nothing to ask and nothing to choose. The
//     stated printing is used WHETHER OR NOT they own it: if they own a free
//     copy it is allocated normally, and if they do not, the requirement is
//     created against that exact printing and simply behaves like any other
//     card they have not got -- the existing "Missing N of M" treatment. This
//     is not the app inventing a printing; it is the app obeying one.
//
//   CASE B -- BARE LINE, AT LEAST ONE COPY OWNED AND FREE. "4 Lightning Bolt"
//     with two free Bolts in the binder. Allocate the copies that exist from
//     owned, available printings, grouping one printing before mixing
//     (ordering lives in allocateFromOwnedVariants). If that falls short, the
//     REMAINDER IS NOT ASKED ABOUT: it is created as unowned requirements
//     against a printing he already owns, so the deck comes out of import
//     holding the full requested count. Asking here would be asking a question
//     the collection has already answered.
//
//   CASE C -- BARE LINE, ZERO AVAILABLE COPIES OWNED. The line names a card,
//     not a card object, and there is no ownership to infer one from. The app
//     has NO BASIS to choose, so it does not: the line comes back with
//     `needs_choice` and the user picks, using the same printing picker already
//     used elsewhere in the deck screen. The line is never dropped, and never
//     pinned to a catalogue printing behind the user's back.
//
// Copies another deck has reserved are not available in any case -- they are
// physically spoken for, and pretending otherwise would send the user to a
// binder slot holding a card that is already in another sleeve.
//
// PREVIEW AND APPLY ARE THE SAME CODE PATH, switched by `apply`. They were
// nearly-identical separate implementations in the client before, which meant
// the preview could promise one thing and the import do another; the user
// believes the preview, because that is the screen they read.
//
// Lines arrive already split into { name, quantity, set?, number?, finish? } by
// the client, because parsing MTGA/plain decklist text is a text-format concern
// and lives in frontend/src/utils/deckText.js. Whether a line is Case A is
// therefore decided by whether the TEXT carried a printing; what the line MEANS
// in terms of physical cards is decided here.
router.post('/:id/import', async (req, res) => {
  const { lines, board = 'mainboard', apply = false } = req.body || {};

  if (!Array.isArray(lines)) {
    return res.status(400).json({ error: 'lines must be an array' });
  }
  if (lines.length > MAX_IMPORT_LINES) {
    return res.status(400).json({ error: `A decklist may not exceed ${MAX_IMPORT_LINES} lines` });
  }
  if (!deckIdentity.isBoard(board)) {
    return res.status(400).json({ error: `board must be one of ${deckIdentity.BOARDS.join(', ')}` });
  }

  try {
    const result = await db.withTransaction(async (tx) => {
      const deck = await requireOwnedDeck(tx, req.params.id, req.user.id);
      const plan = [];

      // COPIES CLAIMED EARLIER IN THIS SAME PASS.
      //
      // Keyed `desired_card_id|finish` -- the exact variant, because that is
      // the only thing a physical copy can satisfy.
      //
      // This map is the fix for the silent-loss defect. Availability is read
      // from the database, and the database does not know about the copies
      // earlier lines in THIS paste have already spoken for. Without this map
      // two lines for one card each read the same free copies and each claim
      // them: a binder holding two Bolts answers "2 free" to both lines, and
      // the preview promises four.
      //
      // Merging (below) only fixes this for lines that are IDENTICAL. Two
      // lines that name the same card differently -- one bare and one with a
      // set code, one foil and one not, two printings of one card -- get
      // different merge keys on purpose, so they stay separate and both hit
      // the collection. Those are exactly the lines this map keeps honest.
      const claimedCopies = new Map();
      const claimKey = (cardId, finish) => `${cardId}|${finish}`;
      const alreadyClaimed = (cardId, finish) => claimedCopies.get(claimKey(cardId, finish)) || 0;
      const claim = (cardId, finish, copies) => {
        if (copies <= 0) return;
        const key = claimKey(cardId, finish);
        claimedCopies.set(key, (claimedCopies.get(key) || 0) + copies);
      };

      // WRITES ARE DEFERRED TO THE END OF THE PASS.
      //
      // Previously each line wrote as it was resolved, which made APPLY read a
      // different world than PREVIEW: the first line's write moved availability,
      // so the second line saw fewer free copies in apply than the preview had
      // shown it, and silently resolved differently. Preview and apply are
      // meant to be the same code path precisely so they cannot disagree, and a
      // write in the middle of the pass broke that.
      //
      // Planning against a stable snapshot plus `claimedCopies`, then writing
      // once at the end, makes the two modes identical BY CONSTRUCTION rather
      // than by both happening to be correct.
      const pendingWrites = [];

      // Merge lines that request THE SAME THING before allocating.
      //
      // Decklist exports legitimately split one card across several lines
      // (mainboard sections, MTGA's grouping). Allocating each line separately
      // would let both see the same free copies: in APPLY mode the second line
      // reads availability after the first line's write and self-corrects, but
      // in PREVIEW mode nothing is written, so the two would double-count and
      // the preview would promise copies the import cannot deliver. Merging
      // first makes preview and apply agree by construction, which is the
      // whole reason they share this code path.
      //
      // The key includes the EXPLICIT printing, not just the name. "2 Sol Ring
      // (C21) 263" and "1 Sol Ring" are two different requests -- the first
      // names a physical card and the second does not -- and merging them would
      // silently apply one line's stated printing to the other line's copies.
      const merged = [];
      const byKey = new Map();
      for (const rawLine of lines) {
        const name = typeof rawLine?.name === 'string' ? rawLine.name.trim().toLowerCase() : '';
        const key = name
          ? `${name}|${rawLine.set || ''}|${rawLine.number || ''}|${rawLine.finish || ''}`
          : '';
        const existingLine = key ? byKey.get(key) : null;
        if (existingLine && Number.isFinite(Number(rawLine.quantity))
          && Number.isFinite(Number(existingLine.quantity))) {
          existingLine.quantity = Number(existingLine.quantity) + Number(rawLine.quantity);
          continue;
        }
        const copy = {
          name: rawLine?.name,
          quantity: rawLine?.quantity,
          set: rawLine?.set,
          number: rawLine?.number,
          finish: rawLine?.finish
        };
        merged.push(copy);
        if (key && !existingLine) byKey.set(key, copy);
      }

      for (const rawLine of merged) {
        const name = typeof rawLine?.name === 'string' ? rawLine.name.trim() : '';
        if (!name) continue;

        let quantity;
        try {
          quantity = positiveInteger(Number(rawLine.quantity), {
            name: 'quantity', max: MAX_REQUIREMENT_QUANTITY
          });
        } catch {
          // A garbled quantity is reported on its own line rather than
          // aborting the whole paste. One bad line must not cost the user the
          // other ninety-nine.
          plan.push({ name, requested: rawLine?.quantity, status: 'unresolved', allocations: [], shortfall: 0 });
          continue;
        }

        // CASE A -- the line stated a printing. Resolve it to an exact
        // card_cache row BEFORE looking at ownership, because ownership is
        // irrelevant to whether we honour it. A set code alone is ambiguous
        // when the name appears twice in one set, so the collector number
        // narrows it when the line gave one; without one we take the lowest
        // number deterministically rather than an arbitrary row.
        //
        // If the stated printing is not in the local cache we do NOT fall back
        // to a different printing of the same card -- that would be the app
        // substituting a physical object the user did not ask for. The line is
        // reported unresolved instead, which is honest and visible.
        let explicitCard = null;
        const statedSet = typeof rawLine.set === 'string' ? rawLine.set.trim() : '';
        const statedNumber = typeof rawLine.number === 'string' ? rawLine.number.trim() : '';
        if (statedSet) {
          const params = [name, statedSet];
          let sql = `SELECT id, oracle_id, name, set_id, set_name, number, finishes
                     FROM card_cache
                     WHERE LOWER(name) = LOWER(?) AND LOWER(set_id) = LOWER(?)
                       AND oracle_id IS NOT NULL`;
          if (statedNumber) {
            sql += ` AND LOWER(number) = LOWER(?)`;
            params.push(statedNumber);
          }
          sql += ` ORDER BY CAST(number AS INTEGER) ASC, number ASC, id ASC LIMIT 1`;
          explicitCard = await tx.get(sql, params);

          if (!explicitCard) {
            plan.push({
              name, requested: quantity, status: 'unresolved',
              allocations: [], shortfall: quantity, needs_choice: false
            });
            continue;
          }
        }

        if (explicitCard) {
          // The finish comes from the line's own marker when it gave one. When
          // it did not, we use the printing's own finish list -- its only
          // finish if it has exactly one, otherwise 'nonfoil' as that
          // printing's ordinary default. We never invent a finish the printing
          // does not offer: a *F* marker on a nonfoil-only printing means the
          // line and the catalogue disagree, and the catalogue is the one that
          // describes real cards.
          const finishes = (() => {
            try {
              const parsed = JSON.parse(explicitCard.finishes || '[]');
              return Array.isArray(parsed) ? parsed.filter(f => deckIdentity.isFinish(f)) : [];
            } catch { return []; }
          })();
          const stated = typeof rawLine.finish === 'string' ? rawLine.finish : null;
          const finish = (stated && (finishes.length === 0 || finishes.includes(stated)))
            ? stated
            : (finishes.length === 1 ? finishes[0] : (finishes.includes('nonfoil') ? 'nonfoil' : (finishes[0] || 'nonfoil')));

          // Ownership still decides what is ALLOCATED versus what is merely
          // required. The printing is fixed either way, so this is only the
          // "do I need to buy it" question -- exactly the same question every
          // other card in the deck answers.
          const identity = { desired_card_id: explicitCard.id, desired_finish: finish };
          const owned = await deckIdentity.ownedQuantity(tx, req.user.id, identity);
          const reserved = await deckIdentity.reservedByHigherPriority(tx, req.user.id, identity, null);
          // Copies an EARLIER line in this same paste already spoke for are not
          // free for this one. Without this term two lines naming the same card
          // differently would each be told the same physical copies are
          // available, and the preview would promise both of them.
          const availableNow = Math.max(
            0,
            owned - reserved - alreadyClaimed(explicitCard.id, finish)
          );
          const allocated = Math.min(availableNow, quantity);
          const shortfall = quantity - allocated;
          claim(explicitCard.id, finish, allocated);

          const allocations = [{
            desired_card_id: explicitCard.id,
            desired_finish: finish,
            set_name: explicitCard.set_name,
            number: explicitCard.number,
            quantity,
            owned: allocated > 0
          }];

          if (apply) pendingWrites.push(...allocations);

          plan.push({
            name: explicitCard.name,
            oracle_id: explicitCard.oracle_id,
            requested: quantity,
            allocated,
            shortfall,
            // A Case A line is never 'missing' in the sense that needs a
            // decision -- the decision was in the text. It is 'full' when the
            // copies exist and 'partial' when they do not, and the row's
            // ordinary Missing badge carries the rest.
            status: shortfall === 0 ? 'full' : 'partial',
            explicit: true,
            needs_choice: false,
            allocations
          });
          continue;
        }

        // CASE B/C -- bare line. Resolve the NAME to an Oracle card. Local
        // cache only: import must not make a network call per line, and a card
        // the user has never seen is one they certainly do not own.
        const card = await tx.get(
          `SELECT id, oracle_id, name, set_name, number FROM card_cache
           WHERE LOWER(name) = LOWER(?) AND oracle_id IS NOT NULL
           ORDER BY id ASC LIMIT 1`,
          [name]
        );
        if (!card) {
          // Unknown card name. Reported, never silently dropped, and never
          // guessed at -- there is nothing to guess from.
          plan.push({
            name, requested: quantity, status: 'unresolved',
            allocations: [], shortfall: quantity, needs_choice: false
          });
          continue;
        }

        const variants = await deckIdentity.ownedVariantsForOracle(tx, req.user.id, card.oracle_id);
        // Discount copies earlier lines in this paste already claimed, for the
        // same reason as Case A: the database's idea of "free" predates this
        // request, and two lines for one card must not both spend one copy.
        const netVariants = variants.map(variant => ({
          ...variant,
          available_qty: Math.max(
            0,
            variant.available_qty - alreadyClaimed(variant.desired_card_id, variant.finish)
          )
        }));
        const { picks, shortfall } = deckIdentity.allocateFromOwnedVariants(netVariants, quantity);

        const allocations = [];
        for (const pick of picks) {
          claim(pick.desired_card_id, pick.desired_finish, pick.take);
          allocations.push({
            desired_card_id: pick.desired_card_id,
            desired_finish: pick.desired_finish,
            set_name: pick.set_name,
            number: pick.number,
            quantity: pick.take,
            owned: true
          });
        }

        // THE SHORTFALL, when he owns SOMETHING (Case B).
        //
        // He asked for 4 and owns 2. The app is not short of information here:
        // it knows exactly which physical Basalt Pulse he means, because two of
        // them are in his binder. Asking "which printing for the other two?"
        // makes him answer a question his own collection already answered, and
        // the honest answer is always "the same one". So the remaining copies
        // become UNOWNED requirements against a printing he already owns, and
        // the deck comes out of import holding the full requested count. They
        // read exactly like any other card he has not bought yet -- the
        // ordinary "Missing N of M" treatment.
        //
        // TIE-BREAK, when the allocation spanned SEVERAL owned printings:
        // extend the one we allocated the MOST copies from. Two reasons, both
        // about the user rather than the code:
        //   - it keeps the deck as uniform as possible, so he pulls a stack of
        //     matching cards rather than a mixed pile with a stray on the end;
        //   - it is deterministic. `picks` comes back in a fixed order from
        //     allocateFromOwnedVariants (deepest free stack first, then
        //     desired_card_id, then finish), so ties inside this reduce resolve
        //     to the earliest pick in that already-deterministic order. The
        //     same collection therefore produces the same deck on every run.
        if (shortfall > 0 && picks.length > 0) {
          const mostUsed = picks.reduce((best, pick) => (pick.take > best.take ? pick : best), picks[0]);
          // Same card_id and finish as an existing allocation, deliberately.
          // writeImportRequirement sums by (deck, printing, finish, board), so
          // these collapse into ONE deck_cards row of the full requested
          // quantity -- one entry saying "4 needed, 2 owned", which is what the
          // deck screen already knows how to render, rather than two rows of
          // the same card sitting next to each other.
          allocations.push({
            desired_card_id: mostUsed.desired_card_id,
            desired_finish: mostUsed.desired_finish,
            set_name: mostUsed.set_name,
            number: mostUsed.number,
            quantity: shortfall,
            owned: false
          });
        }

        // CASE C -- he owns NOTHING free of this card and the line named no
        // printing. Now there genuinely is no basis: no text to obey and no
        // binder to point at. The app must not pick, so it does not. The line
        // comes back with needs_choice and the choices to offer, nothing is
        // written -- not even in apply mode -- and the client reuses the
        // printing picker it already has. The line is never dropped: it is
        // sitting on the preview waiting for an answer.
        const needsChoice = shortfall > 0 && picks.length === 0;

        let choices = [];
        if (needsChoice) {
          choices = await deckIdentity.printingChoicesForOracle(tx, req.user.id, card.oracle_id);
        }

        if (apply && allocations.length > 0) {
          pendingWrites.push(...allocations);
        }

        const allocated = picks.reduce((s, p) => s + p.take, 0);

        plan.push({
          name: card.name,
          oracle_id: card.oracle_id,
          requested: quantity,
          allocated,
          shortfall,
          // 'full'    -- every requested copy came from an owned, free printing
          // 'partial' -- some did; the rest became unowned requirements against
          //              the same printing, and are cards to buy, not questions
          // 'missing' -- none did; the whole line is awaiting a choice
          status: shortfall === 0 ? 'full' : (picks.length > 0 ? 'partial' : 'missing'),
          explicit: false,
          needs_choice: needsChoice,
          choice_quantity: needsChoice ? shortfall : 0,
          choices,
          allocations
        });
      }

      if (apply && pendingWrites.length > 0) {
        await writeImportRequirement(tx, deck.id, board, pendingWrites);
      }

      // THE COPY-CONSERVATION INVARIANT, checked before the transaction commits.
      //
      //   requested == written + visibly-unresolved
      //
      // Every copy the decklist asked for must either be a deck requirement or
      // be reported to the user as one the app could not place. The failure
      // this guards against is not a crash -- it is a paste that reports
      // success and leaves the deck one card short, which the user has no way
      // to detect because every screen agreed it worked.
      //
      // "Visibly unresolved" is deliberately narrow: only lines the user can
      // SEE as unfinished count. A shortfall that quietly became nothing is
      // exactly the bug, so it must not be allowed to satisfy the equation.
      //
      // Throwing rolls the whole import back. That is the conservative choice
      // and the right one here: for software tracking physical objects, a
      // refused import the user can retry is recoverable, and a silently short
      // deck is not -- they would only discover it holding the cards.
      const requestedCopies = plan.reduce((s, l) => s + (Number(l.requested) || 0), 0);
      const unresolvedCopies = plan.reduce((s, l) => {
        if (l.status === 'unresolved') return s + (Number(l.shortfall) || 0);
        if (l.needs_choice) return s + (Number(l.choice_quantity) || 0);
        return s;
      }, 0);
      const plannedCopies = plan.reduce((s, l) => (
        s + (l.allocations || []).reduce((t, a) => t + (Number(a.quantity) || 0), 0)
      ), 0);

      if (plannedCopies + unresolvedCopies !== requestedCopies) {
        throw new deckIdentity.DeckIdentityError(
          500,
          'Import could not account for every requested copy and was cancelled',
          'IMPORT_COPIES_UNACCOUNTED'
        );
      }

      const { entries } = await deckIdentity.availabilityForDeck(tx, deck.id, req.user.id);
      const warnings = await buildDeckWarnings(tx, deck, entries);

      // The numbers the completion toast is built from, stated ONCE by the
      // server. Letting the client re-derive "how many cards did I just
      // import" from the line list is how the toast and the deck drifted apart
      // in the first place: the client counted LINES that were not 'unresolved'
      // and called them imported, which counts a line awaiting a printing
      // choice as a success.
      const summary = {
        requested_copies: requestedCopies,
        written_copies: apply ? plannedCopies : 0,
        planned_copies: plannedCopies,
        unresolved_copies: unresolvedCopies,
        lines_needing_choice: plan.filter(l => l.needs_choice).length,
        lines_unresolved: plan.filter(l => l.status === 'unresolved').length
      };

      return { plan, entries, warnings, summary };
    });

    res.json({
      applied: !!apply,
      lines: result.plan,
      cards: result.entries,
      warnings: result.warnings,
      summary: result.summary
    });
  } catch (error) {
    sendError(res, error, 'Failed to import decklist');
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
