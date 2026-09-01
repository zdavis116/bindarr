const express = require('express');
const db = require('../db');
const scryfallApi = require('../scryfallApi');
const { recordPrice } = require('../utils/priceHelpers');
const { compartmentLabel } = require('../utils/compartmentSort');
const { buildDeckWarnings } = require('../utils/deckRules');
const commanderRules = require('../utils/commanderRules');
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
  // CommanderRuleError is listed alongside the others because singleton is
  // REFUSED rather than warned: the choke point throws it from inside a
  // transaction so the refusal rolls back with everything else, and it must
  // reach the user as its own 409 with its own message. Without this arm a
  // correct refusal would be reported as a generic 500 and the user would be
  // told the app broke rather than told which card was refused and why.
  if (error instanceof DeckIdentityError
    || error instanceof RequestBoundsError
    || error instanceof commanderRules.CommanderRuleError) {
    // `details` carries the commander refusal's extras -- whether an override
    // exists and which cards were refused. It is spread onto the body rather
    // than nested so the client reads `overridable` at the top level next to
    // `code`, and so a refusal WITHOUT details (singleton) simply has no
    // `overridable` key rather than an explicit false the UI might misread as
    // "there is an override, it is just off".
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.details || {})
    });
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

// Refuse a deck name that is already in use (PR 6I item 2).
//
// ONE FUNCTION, called by BOTH create and rename, because they are the same
// question asked at two moments. A rule implemented twice is a rule that will
// eventually disagree with itself — create would refuse "Ur-Dragon" while
// rename quietly allowed it, and the user would find two identically named
// decks anyway by a route the check forgot about.
//
// COMPARISON IS CASE- AND WHITESPACE-INSENSITIVE, per the spec. That is a
// judgement about what a human means by "the same deck", not about what SQLite
// means by string equality: "Ur-Dragon", "ur-dragon " and "Ur-Dragon" with a
// double space inside are one name to the person picking a deck off a shelf.
// Interior runs of whitespace are collapsed too, since a stray double space is
// invisible on screen and would otherwise create a deck the user cannot tell
// apart from the one they already have.
//
// PER USER. Two people may each own a deck called "Ur-Dragon"; that is not a
// collision, and scoping it any wider would leak the existence of other users'
// decks through a refusal message.
//
// REFUSED, NOT DEDUPLICATED. The app does not invent "Ur-Dragon (2)" — it says
// what is wrong and lets the user decide, which is the standing rule here for
// anything touching things the user tracks physically.
//
// `excludeDeckId` is what makes RENAME work: renaming a deck to the name it
// already has, or fixing only its capitalisation, must not be refused as a
// collision with ITSELF. Without it the check would make a deck permanently
// unrenameable.
function normalizeDeckName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function assertDeckNameAvailable(database, userId, name, { excludeDeckId = null } = {}) {
  const normalized = normalizeDeckName(name);
  // An empty name is refused by the caller's own required-field check, which
  // gives a better message than this one would. Nothing to do here.
  if (!normalized) return;
  // NORMALISED IN JS, NOT IN SQL, and on both sides.
  //
  // Both sides, because existing decks were created before this rule and may
  // already carry stray whitespace or odd casing — comparing a normalised new
  // name against raw stored names would miss exactly the duplicates the user
  // can actually see on screen.
  //
  // In JS because SQLite has no regex: collapsing interior whitespace there
  // means nested REPLACE() calls, and REPLACE('  ', ' ') only collapses a
  // doubled space ONCE, so three spaces survive it. That would be a second,
  // subtly weaker implementation of normalizeDeckName() sitting in a string —
  // the drift this file keeps warning about. One function decides what "the
  // same name" means, and every comparison goes through it.
  //
  // The scan is bounded by ONE USER'S deck count, which is tens of rows. If a
  // user ever holds enough decks for this to matter, a normalised column with
  // a unique index is the right answer — but adding one now would be storing a
  // derived value to solve a problem nobody has.
  const existing = await (database || db).all(
    `SELECT id, name FROM decks WHERE user_id = ?`, [userId]
  );
  const excluded = excludeDeckId == null ? null : Number(excludeDeckId);
  const clash = existing.find(deck =>
    deck.id !== excluded && normalizeDeckName(deck.name) === normalized
  );
  if (clash) {
    throw new DeckIdentityError(
      409,
      `You already have a deck called "${clash.name}". Deck names must be unique, so pick a different one.`,
      'DECK_NAME_IN_USE'
    );
  }
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
        COALESCE(SUM(CASE WHEN dc.board = 'considering' THEN dc.quantity ELSE 0 END), 0) AS considering_cards,

        -- OWNED copies, not listed ones. The completion ring reads this.
        --
        -- Zach: "it shows 97% complete with only 3 missing cards but actually I
        -- am missing 97 cards." The ring read total_cards, which counts what is
        -- LISTED. A freshly imported deck is fully listed and entirely unowned,
        -- so it showed 97% while 94 of its cards were not in the binder --
        -- a deck reported ready to play that cannot be.
        --
        -- Same rule as the deck view (utils/deckIdentity.js): exact printing
        -- AND finish, from the collection list only, minus copies already
        -- claimed by an earlier requirement, capped at what this deck needs.
        COALESCE(SUM(
          CASE WHEN dc.board != 'considering' THEN
            MIN(dc.quantity, MAX(0,
              (SELECT COALESCE(SUM(uc.quantity), 0)
                 FROM collection uc
                WHERE uc.user_id = d.user_id
                  AND uc.card_id = dc.desired_card_id
                  AND uc.finish = dc.desired_finish
                  AND uc.list_type = 'collection')
              -
              -- Claimed by a HIGHER-priority requirement. Priority is
              -- deck_cards.id ascending: assigned at insert, never changes.
              (SELECT COALESCE(SUM(o.quantity), 0)
                 FROM deck_cards o
                 JOIN decks od ON od.id = o.deck_id
                WHERE od.user_id = d.user_id
                  AND o.desired_card_id = dc.desired_card_id
                  AND o.desired_finish = dc.desired_finish
                  AND o.board != 'considering'
                  AND o.id < dc.id)
            ))
          ELSE 0 END
        ), 0) AS owned_cards,

        -- What the missing copies would cost at the cached Scryfall price.
        -- A card with no cached price contributes nothing rather than zeroing
        -- the total: an unknown price is not a free card, and the UI says so.
        COALESCE(SUM(
          CASE WHEN dc.board != 'considering' THEN
            MAX(0, dc.quantity - MAX(0,
              (SELECT COALESCE(SUM(uc.quantity), 0)
                 FROM collection uc
                WHERE uc.user_id = d.user_id
                  AND uc.card_id = dc.desired_card_id
                  AND uc.finish = dc.desired_finish
                  AND uc.list_type = 'collection')))
            * COALESCE((SELECT cc.price_trend FROM card_cache cc
                         WHERE cc.id = dc.desired_card_id), 0)
          ELSE 0 END
        ), 0) AS missing_cost,

        -- What the whole list is worth at cached prices, owned or not.
        COALESCE(SUM(
          CASE WHEN dc.board != 'considering' THEN
            dc.quantity * COALESCE((SELECT cc.price_trend FROM card_cache cc
                                     WHERE cc.id = dc.desired_card_id), 0)
          ELSE 0 END
        ), 0) AS deck_value
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
//
// COMMANDERS ARE THE ONE EXCEPTION, and only for the Commander format. A
// Commander deck without a commander is not an incomplete deck, it is not a
// deck -- the commander defines the colour identity every other card is legal
// against. So it is required AT CREATION rather than warned about afterwards,
// and the deck row and its commander entries are written in ONE transaction:
// a half-created Commander deck with no commander is exactly the state this
// requirement exists to prevent, and a failure after the deck row was inserted
// would leave one behind.
//
// One or two commanders are accepted. Two is not an exotic case to be added
// later: partner pairs and Background pairings are ordinary, and a
// partner-only commander (The Prismatic Piper) is never legal on its own, so
// a single slot would be wrong on the day it shipped.
//
// Every other format is untouched -- no field is read, nothing is validated,
// nothing is written.
const MAX_COMMANDERS = 2;

router.post('/', async (req, res) => {
  const {
    name,
    description = '',
    format = 'Commander / EDH',
    category = 'Competitive',
    accent_color = '#eab308',
    target_size = 100,
    commanders = [],
    // The EXPLICIT confirmation that overrides a commander refusal, shaped
    // { reason }. Its ABSENCE means refuse -- silence is not consent, and
    // there is deliberately no default value that would let a client opt in
    // by accident.
    commander_override = null
  } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Deck name is required' });
  }

  const targetSizeNum = parseInt(target_size, 10) || 100;
  const isCommander = commanderRules.isCommanderFormat(format);

  // Commanders are read ONLY for the Commander format. Sending them with a
  // Modern deck is ignored rather than rejected: the field does not exist for
  // that format, so there is nothing for the user to have got wrong.
  const requested = isCommander && Array.isArray(commanders) ? commanders : [];

  if (isCommander) {
    // ALLOWED, AND REPORTED. buildDeckWarnings already raises
    // COMMANDER_MISSING for this state, so the deck is created and says what
    // is wrong with it rather than refusing to exist. Zach builds decks
    // incrementally; demanding the commander first is the app deciding the
    // order he works in.
    // ALLOWED, AND REPORTED as COMMANDER_TOO_MANY.
    // A commander is an exact-identity entry like every other card, so the
    // client must state printing AND finish. Defaulting either would be the
    // app choosing a physical object on the user's behalf -- the single thing
    // exact-only identity exists to prevent -- and the commander is the card
    // they are most likely to want a specific printing of.
    for (const commander of requested) {
      if (!commander || !commander.desired_card_id) {
        return res.status(400).json({ error: 'Each commander needs a desired_card_id', code: 'COMMANDER_INVALID' });
      }
      if (!deckIdentity.isFinish(commander.desired_finish)) {
        return res.status(400).json({
          error: `Each commander needs a desired_finish of ${deckIdentity.FINISHES.join(', ')}`,
          code: 'COMMANDER_INVALID'
        });
      }
    }
    // Two commanders must be two different cards. A "partner pair" of one card
    // with itself is a singleton violation in the deck-defining slot, and it
    // would also be written as a single upserted row, silently collapsing to
    // one commander while the user believed they had chosen two.
    //
    // This is the IDENTITY check -- literally the same (printing, finish)
    // twice. It is NOT the singleton rule, and the difference is the whole of
    // Blocker 2: two DIFFERENT printings of Atraxa, or one printing in nonfoil
    // and foil, are two distinct identities and one card NAME. Both pass here.
    // The name rule is enforced by writeDeckCard below, where it applies to
    // every route rather than only to this one.
    const identities = requested.map(c => `${c.desired_card_id}|${c.desired_finish}`);
    if (new Set(identities).size !== identities.length) {
      // ALLOWED, AND REPORTED as COMMANDER_DUPLICATE below.
    }
  }

  try {
    // HYDRATE THIN COMMANDER ROWS BEFORE THE TRANSACTION OPENS.
    //
    // The commander rules read type_line/subtypes/oracle_text/keywords, and
    // every one of those fields biases toward REFUSE when missing -- so a row
    // the app cached without ever reading the card would confidently refuse a
    // legal commander. Rather than guessing in either direction, the app goes
    // and gets the data it is missing.
    //
    // OUTSIDE THE TRANSACTION, deliberately, and for the same reason the
    // deck-add route's Scryfall lookup is: a network call inside a transaction
    // holds SQLite's single write lock for the duration of an upstream
    // request, stalling every other writer behind a third party's latency.
    // PR 6C/6E established this and addCardToCollection already follows it.
    //
    // This costs NOTHING on the happy path -- a row that is already complete
    // is skipped without a request, so a legal commander stays instant.
    await commanderRules.hydrateThinCommanderCards(
      db,
      requested.map(c => c.desired_card_id),
      { hasOverride: !!commander_override }
    );

    const deckId = await db.withTransaction(async (tx) => {
      // INSIDE the transaction, not before it. withTransaction opens BEGIN
      // IMMEDIATE, so the check and the INSERT hold the write lock together and
      // two simultaneous creates of one name cannot both pass the check. Done
      // outside, this would be a check-then-act race that lets exactly the
      // duplicate it forbids through under concurrency.
      await assertDeckNameAvailable(tx, req.user.id, name);

      const result = await tx.run(
        `INSERT INTO decks (name, description, format, category, accent_color, target_size, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [name.trim(), description, format, category, accent_color, targetSizeNum, req.user.id]
      );
      const id = result.lastID;

      for (const commander of requested) {
        // oracleIdentityForCard throws a 404 for an unknown printing, which
        // rolls the whole transaction back -- so a bad commander id leaves no
        // deck behind rather than an empty Commander deck the user then has to
        // notice and delete.
        const identity = await deckIdentity.oracleIdentityForCard(
          tx, commander.desired_card_id, commander.desired_finish
        );
        // BLOCKER 2 FIX. Written through the choke point, so the create path
        // applies the SAME name rule every later write applies. Previously
        // this was a bare INSERT, and a deck could therefore be born already
        // holding two commanders of one name -- illegal from the moment it
        // existed, and refused by every route that touched it afterwards.
        //
        // A refusal throws, which rolls the deck row back with it: a refused
        // create leaves no deck behind at all, rather than a half-built one
        // the user has to notice and delete.
        await commanderRules.writeDeckCard(tx, { id, format }, {
          oracle_id: identity.oracle_id,
          desired_card_id: identity.desired_card_id,
          desired_finish: identity.desired_finish,
          board: 'commander',
          quantity: 1
        });
      }

      // THE COMMANDER-ZONE GATE, inside the same transaction.
      //
      // It runs AFTER the writes rather than before, because the question is
      // about the command zone AS A WHOLE -- "do these two cards pair" cannot
      // be answered one card at a time. Running it inside the transaction is
      // what makes the refusal safe: a throw here rolls the deck row and both
      // commander rows back together, so a refused create leaves NOTHING
      // behind rather than a half-built illegal deck the user has to notice.
      const accepted = await commanderRules.checkCommanderZone(tx, { id, format }, {
        override: commander_override
      });
      // An accepted override is RECORDED in the same transaction as the write
      // it permitted. If the record cannot be written the deck must not exist
      // either: an override we allowed but did not remember is precisely the
      // silent state this feature exists to prevent, and it would corrupt the
      // feedback loop the reason was collected for.
      if (accepted) {
        await commanderRules.recordCommanderOverride(tx, req.user.id, id, accepted);
      }
      return id;
    });

    // THE CREATE RESPONSE CARRIES THE DECK'S WARNINGS.
    //
    // Without this the user only discovers an illegal partner pairing when
    // they next open the deck, which is precisely the "told afterwards what
    // you could have been told beforehand" failure the pre-flight rules exist
    // to remove. Computed AFTER the commit, deliberately: the warning
    // describes the deck that now exists, and a warning is never a reason to
    // roll one back.
    let warnings = [];
    try {
      const { entries } = await deckIdentity.availabilityForDeck(db, deckId, req.user.id);
      const created = await db.get(`SELECT * FROM decks WHERE id = ?`, [deckId]);
      warnings = await buildDeckWarnings(db, created, entries);
    } catch (warningError) {
      // Advisory text failing must never turn a successful create into an
      // error the user has to interpret. The deck exists; the deck screen will
      // recompute the same warnings on open.
      console.error('deck created but warnings could not be built', warningError);
    }

    res.status(201).json({ message: 'Deck created successfully', id: deckId, warnings });
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

      // The SAME rule create applies, from the same function (PR 6I item 2).
      // Renaming was the half the spec calls out explicitly: without this a
      // user refused at create could simply create "temp" and rename it into
      // the collision, which would make the create-time refusal theatre.
      //
      // excludeDeckId is THIS deck, so re-saving a deck without touching its
      // name — or only fixing its capitalisation — is not refused as a clash
      // with itself. Only run when a name was actually supplied; a
      // description-only update must not be judged on a name it did not send.
      if (name !== undefined) {
        await assertDeckNameAvailable(tx, req.user.id, name, { excludeDeckId: deck.id });
      }

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
//
// `replacing_deck_card_id` MAKES AN EDIT AN EDIT. Without it the server cannot
// tell "put a second Sol Ring in this deck" from "change which Sol Ring this
// row means" -- the request body looks identical -- so it judged the second as
// the first and refused every re-pin, finish change and commander re-printing
// as a singleton violation. The client already knows which row the user is
// editing; it just had no way to say so.
//
// Naming the row also lets the replace happen in ONE transaction instead of the
// add-then-delete pair of requests the UI used to make. Two requests have a
// window between them in which the deck holds two copies of one name, and if
// the second never lands the deck holds them permanently.
router.post('/:id/cards', async (req, res) => {
  const {
    desired_card_id, desired_finish, board = 'mainboard', quantity = 1,
    // Same explicit confirmation the create route takes. Only ever consulted
    // for a write to the commander board; absence means refuse.
    commander_override = null,
    // The deck_cards.id of the row being edited, when this write is an edit.
    // Absent on an ordinary add, which is the common case.
    replacing_deck_card_id = null,
    // THE EXPLICIT CONFIRMATION for a commander swap that will remove cards.
    //
    // Like commander_override, its ABSENCE means "ask, do not do it". Silence
    // is not consent: the user must have seen the named list of cards and
    // actively agreed, so there is deliberately no default that would let a
    // client opt in by accident and quietly empty part of a deck.
    confirm_remove_off_identity = false,
    // DROPPING ONE HALF OF A PARTNER PAIR: a swap of the zone from TWO
    // commanders to ONE.
    //
    // Zach (2026-08-19) ruled that a commander is swapped, never deleted, and
    // that the rule covers a second commander too. But "I want to go back to a
    // single commander" is a legitimate thing to want, so refusing the delete
    // without providing this would leave a partner deck with no way to become a
    // mono-commander deck -- a rule with no way through, which is the failure
    // mode this whole design avoids.
    //
    // So it lives HERE, on the swap route, rather than on DELETE: it is a
    // mutation that arrives at a new command zone, and it must go through the
    // SAME plan-and-confirm path as any other swap. Narrowing [R,G] to [R] by
    // dropping the green partner strands exactly the cards that narrowing it by
    // replacement would, and the user must be asked in exactly the same way.
    //
    // It names the row being DROPPED and carries no incoming card, which is the
    // one shape `replacing_deck_card_id` cannot express (that one is a
    // replacement, and needs something to replace WITH).
    drop_commander_deck_card_id = null
  } = req.body;

  const confirmRemoveOffIdentity = confirm_remove_off_identity === true;

  let droppingId = null;
  if (drop_commander_deck_card_id !== null && drop_commander_deck_card_id !== undefined) {
    droppingId = Number(drop_commander_deck_card_id);
    if (!Number.isInteger(droppingId) || droppingId <= 0) {
      return res.status(400).json({ error: 'drop_commander_deck_card_id must be a deck entry id' });
    }
  }

  // THE DROP-A-PARTNER PATH, handled in full before the ordinary add path's
  // validation, because it has no incoming card and therefore no printing or
  // finish to validate.
  if (droppingId !== null) {
    try {
      const outcome = await db.withTransaction(async (tx) => {
        const deck = await requireOwnedDeck(tx, req.params.id, req.user.id);
        if (!commanderRules.isCommanderFormat(deck.format)) {
          throw new DeckIdentityError(400,
            'Only a Commander deck has a command zone.', 'NOT_COMMANDER_FORMAT');
        }

        const zone = await tx.all(
          `SELECT id, desired_card_id FROM deck_cards
           WHERE deck_id = ? AND board = 'commander' ORDER BY id ASC`,
          [deck.id]
        );
        const dropping = zone.find(row => row.id === droppingId);
        if (!dropping) {
          throw new DeckIdentityError(404,
            'That commander is not in this deck.', 'REQUIREMENT_NOT_FOUND');
        }

        // THE LAST COMMANDER IS NEVER DROPPABLE. This is the same rule the
        // DELETE route enforces, restated here because this is the other way to
        // shrink the zone: a Commander deck always has a commander, so the only
        // legal drop is the one that leaves at least one behind.
        if (zone.length <= 1) {
          throw new commanderRules.CommanderRuleError(409,
            `A Commander deck always has a commander, so the last one cannot be `
            + `removed -- only SWAPPED for another. Choose the replacement and `
            + `Bindarr will make the change in one step.`,
            'COMMANDER_DELETE_UNSUPPORTED',
            { requires: 'swap' });
        }

        // THE SAME PLANNER, against the zone this drop would produce. One
        // implementation, so a drop and a replacement that arrive at the same
        // zone cannot disagree about what they strand.
        const futureZone = zone
          .filter(row => row.id !== droppingId)
          .map(row => row.desired_card_id);
        const plan = await commanderRules.planCommanderSwapRemovals(tx, deck, futureZone);
        if (plan.removing.length > 0 && !confirmRemoveOffIdentity) {
          // A QUESTION, not an error. Nothing has been written, and the throw is
          // what guarantees that. Same code and same shape as every other swap
          // warning, so the client's existing handler covers this too.
          throw new commanderRules.CommanderRuleError(
            409,
            commanderRules.swapRemovalMessage(plan.removing, plan.deck_identity),
            commanderRules.SWAP_REMOVES_CODE,
            {
              removing: plan.removing,
              removing_count: plan.removing.length,
              deck_identity: plan.deck_identity,
              requires_confirmation: 'confirm_remove_off_identity'
            }
          );
        }

        // The drop and the removals land TOGETHER, in this one transaction.
        // Never a narrowed command zone beside a deck still holding cards it no
        // longer allows.
        await tx.run(`DELETE FROM deck_card_allocations WHERE deck_card_id = ?`, [dropping.id]);
        await tx.run(`DELETE FROM deck_cards WHERE id = ?`, [dropping.id]);
        if (plan.removing.length > 0) {
          await commanderRules.applyCommanderSwapRemovals(tx, plan.removing);
        }

        // THE ZONE IS RE-JUDGED AFTER THE MUTATION, like every other path that
        // changes it. Dropping from three to two can arrive at an illegal pair,
        // and that must be refused here rather than tolerated.
        const accepted = await commanderRules.checkCommanderZone(tx, deck, {
          override: commander_override
        });
        if (accepted) {
          await commanderRules.recordCommanderOverride(tx, req.user.id, deck.id, accepted);
        }

        const { entries } = await deckIdentity.availabilityForDeck(tx, deck.id, req.user.id);
        const warnings = await buildDeckWarnings(tx, deck, entries);
        return { entries, warnings };
      });

      return res.json({
        message: 'Commander removed from the command zone',
        cards: outcome.entries,
        warnings: outcome.warnings
      });
    } catch (error) {
      return sendError(res, error, 'Failed to change the command zone');
    }
  }

  // Validated as a shape here so a garbage id becomes a clear 400 rather than
  // a confusing 404 from the rule layer. Ownership and deck scoping are checked
  // inside the transaction, against the deck this request is actually for.
  let replacingId = null;
  if (replacing_deck_card_id !== null && replacing_deck_card_id !== undefined) {
    replacingId = Number(replacing_deck_card_id);
    if (!Number.isInteger(replacingId) || replacingId <= 0) {
      return res.status(400).json({ error: 'replacing_deck_card_id must be a deck entry id' });
    }
  }

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

    // HYDRATE THE COMMAND ZONE BEFORE THE TRANSACTION, for the same reason and
    // under the same constraint as the create path.
    //
    // The EXISTING commanders are hydrated too, not just the incoming card,
    // because the pairing rule judges the zone AS A WHOLE -- a thin row already
    // sitting in the command zone would refuse a legal partner just as surely
    // as a thin incoming one. That query is a plain read of the cards this
    // decision depends on; the network call still only happens for rows that
    // are actually thin, so a fully-cached command zone costs nothing.
    if (board === 'commander') {
      const zone = await db.all(
        `SELECT dc.desired_card_id AS id FROM deck_cards dc
         JOIN decks d ON dc.deck_id = d.id
         WHERE dc.deck_id = ? AND d.user_id = ? AND dc.board = 'commander'`,
        [req.params.id, req.user.id]
      );
      await commanderRules.hydrateThinCommanderCards(
        db,
        [desired_card_id, ...zone.map(r => r.id)],
        { hasOverride: !!commander_override }
      );
    } else {
      // PR 6G: HYDRATE FOR THE COLOUR-IDENTITY DECISION TOO.
      //
      // An ordinary deck add is now subject to a rule read off the cache row,
      // and a thin row biases that rule toward ACCEPT -- a NULL colour identity
      // reads as colourless and fits every deck. So the same principle applies
      // as for commander legality: when the app's knowledge is insufficient to
      // decide, GET BETTER KNOWLEDGE rather than guessing.
      //
      // Only for Commander decks, and only when the deck actually has a
      // commander to judge against: other formats must pay nothing at all for a
      // rule that does not apply to them. Outside the transaction, as always.
      const deckRow = await db.get(
        `SELECT id, format FROM decks WHERE id = ? AND user_id = ?`,
        [req.params.id, req.user.id]
      );
      if (deckRow && commanderRules.isCommanderFormat(deckRow.format)) {
        const zone = await commanderRules.deckColorIdentity(db, deckRow.id);
        // HYDRATE THE COMMANDER TOO, not just the incoming card.
        //
        // A commander row the app never read makes the DECK's identity
        // unknowable, and the choke point now answers that honestly with a 503
        // rather than pretending the deck is colourless. That is the right
        // answer, but a 503 the user can do nothing about is a dead end -- so
        // the route goes and gets the data first, exactly as the commander
        // legality path already does. Only the rows that are actually thin cost
        // a request, so a normal add still costs nothing.
        if (zone.status === commanderRules.ZONE_UNVERIFIED) {
          await commanderRules.hydrateThinColorIdentity(
            db, zone.unverified.map(c => c.id)
          );
        } else if (zone.status === commanderRules.ZONE_KNOWN) {
          await commanderRules.hydrateThinColorIdentity(db, [desired_card_id]);
        }
        // ZONE_EMPTY hydrates nothing: there is no commander to read, and the
        // incoming card is refused on the deck's state rather than its colour.
      }
    }

    const outcome = await db.withTransaction(async (tx) => {
      const deck = await requireOwnedDeck(tx, req.params.id, req.user.id);
      const identity = await deckIdentity.oracleIdentityForCard(tx, desired_card_id, desired_finish);

      // ===================================================================
      // THE CHOKE POINT FOR COMMAND-ZONE CHANGES.
      //
      // READ THIS BEFORE ADDING A VERB THAT TOUCHES A DECK.
      //
      // THE CLASS OF BUG THIS EXISTS TO CLOSE. Three merge-blocking defects in
      // a row shared one root error: the check was attached to a SPECIFIC
      // OPERATION rather than to the STATE CHANGE the operation produces.
      //
      //   PR 6F  -- pairing was checked only when the zone held exactly TWO
      //             rows. Grow to three (each write sees "not two") then delete
      //             one, and an illegal pair exists that creating directly is
      //             refused.
      //   PR 6G/1 -- DELETE never re-validated colour identity, so
      //             delete-the-commander / add-an-off-identity-card / re-add
      //             walked straight through.
      //   PR 6G/2 -- this gate read `board === 'commander'`, i.e. "is the
      //             DESTINATION the zone". Moving a commander OFF the zone has
      //             destination 'mainboard', so it looked like an ordinary add
      //             and skipped every commander check -- silently narrowing the
      //             deck's colour identity and stranding cards.
      //
      // Every time, ADD-shaped operations were scrutinised and deletes, moves
      // and re-pins slipped through, because they do not look like they
      // introduce anything. They do not have to: they change the RESULTING
      // STATE, and the rules are about the resulting state.
      //
      // THE RULE FOR ANY NEW VERB:
      //
      //   Ask "what does the command zone / the set of deck cards LOOK LIKE
      //   AFTER this write", never "what kind of request is this".
      //
      // THE ENUMERATION. Every verb that can change the command zone or the
      // set of deck cards, and where each is validated. Test F15-TC56 has one
      // case per line; add a line and a case together.
      //
      //   1. CREATE a deck with commanders      -> POST /decks. writeDeckCard
      //                                            per commander + checkCommanderZone.
      //   2. ADD a card                          -> here. writeDeckCard.
      //   3. RE-PIN / replace a row              -> here, via replacing_deck_card_id.
      //   4. BOARD MOVE, any direction           -> here, via replacing_deck_card_id.
      //      Including ONTO and OFF the command zone: `touchesCommandZone`
      //      below is true when EITHER side is the zone, which is the fix.
      //   5. COMMANDER ADD / SWAP                -> here, board 'commander'.
      //   6. COMMANDER DROP (half a pair)        -> here, drop_commander_deck_card_id,
      //                                            handled above this block.
      //   7. DELETE a row                        -> DELETE /decks/:id/cards/:deck_card_id.
      //      A commander delete is REFUSED there; an ordinary delete can never
      //      break the invariant, because removing a card cannot make a
      //      surviving card off-identity.
      //   8. IMPORT APPLY                        -> POST /decks/:id/import, through
      //                                            writeImportRequirement -> writeDeckCard,
      //                                            plus checkCommanderZone for a
      //                                            commander-board import.
      //   9. MULTI-SELECT BULK ADD               -> POST /collection/bulk (action
      //                                            add_to_deck), pre-flight then
      //                                            writeDeckCard.
      //  10. DELETE a whole deck                 -> POST /decks/:id DELETE. Removes
      //                                            everything, so no surviving row
      //                                            can be left illegal.
      //
      // VERBS THAT CANNOT BE ROUTED THROUGH HERE, stated explicitly rather
      // than special-cased silently:
      //
      //   - CHECKOUT and RETURN move ALLOCATIONS only. They never change the
      //     command zone or the set of deck cards, so there is no resulting
      //     state for these rules to judge. F15-TC56 asserts the invariant
      //     still holds across them rather than assuming it.
      //   - The nightly card-cache refresh (PR 6H) can change a card's
      //     colour_identity underneath a deck that was legal when built. That
      //     is a DATA change, not a deck verb, and no route-level gate can
      //     catch it; it is the reason buildDeckWarnings reports identity
      //     drift rather than the write path alone.
      // ===================================================================

      // THE ROW BEING REPLACED, read BEFORE anything is written. This one query
      // is what makes a move OFF the command zone recognisable: without it the
      // route only knows where the card is GOING.
      const replacingRow = replacingId
        ? await tx.get(
          `SELECT id, board, desired_card_id FROM deck_cards WHERE id = ? AND deck_id = ?`,
          [replacingId, deck.id]
        )
        : null;

      // TOUCHES THE COMMAND ZONE ON EITHER SIDE. Destination OR origin.
      const touchesCommandZone = commanderRules.isCommanderFormat(deck.format)
        && (board === 'commander' || (replacingRow && replacingRow.board === 'commander'));

      // ANY MUTATION THAT ARRIVES AT A NEW COMMAND ZONE.
      //
      // Zach: "You should allow the swap with a warning that it will remove any
      // cards from the deck that are no longer valid."
      //
      // PLANNED AGAINST THE ZONE THE WRITE WOULD PRODUCE, deliberately. Once
      // the commander rows have changed the old identity is gone and there is
      // nothing left to compare.
      //
      // The plan comes back EMPTY whenever the identity widens or does not
      // move, so adding a partner still costs nothing and never grows a
      // confirmation step.
      //
      // Without confirmation this THROWS, which rolls back before any write:
      // the user is shown exactly what would go and nothing has happened yet.
      // With confirmation the removals are applied in THIS SAME TRANSACTION as
      // the write, so the two cannot come apart.
      let swapRemovals = [];
      let futureZoneIdentity = null;
      if (touchesCommandZone) {
        const zone = await tx.all(
          `SELECT id, desired_card_id FROM deck_cards
           WHERE deck_id = ? AND board = 'commander'`,
          [deck.id]
        );
        // THE ZONE AS IT WOULD BE.
        //
        // The replaced row is DROPPED unconditionally -- it is leaving whatever
        // board it was on -- and the incoming card is added back ONLY when this
        // write's destination is the command zone. That asymmetry is the whole
        // fix: a move OFF the zone drops a commander and adds nothing, which is
        // exactly a shrink.
        const futureZone = zone
          .filter(row => row.id !== replacingId)
          .map(row => row.desired_card_id)
          .concat(board === 'commander' ? [desired_card_id] : []);

        // THE LAST COMMANDER IS NEVER REMOVABLE, whichever verb is spelling the
        // removal. A Commander deck always has a commander; the way to change
        // it is a SWAP, and the refusal says so.
        //
        // This is the SAME refusal the DELETE route and the drop path raise --
        // one rule, three spellings of the operation, so no spelling can reach
        // a state the others forbid. It is why COMMANDER_DELETE_UNSUPPORTED is
        // live logic, not an unreachable backstop: this route is a real way to
        // empty the zone and it is stopped HERE.
        if (futureZone.length === 0) {
          throw new commanderRules.CommanderRuleError(409,
            `A Commander deck always has a commander, so the last one cannot be `
            + `removed -- only SWAPPED for another. Choose the replacement and `
            + `Bindarr will make the change in one step.`,
            'COMMANDER_DELETE_UNSUPPORTED',
            { requires: 'swap' });
        }

        const plan = await commanderRules.planCommanderSwapRemovals(tx, deck, futureZone);
        futureZoneIdentity = { status: plan.zone_status, identity: plan.deck_identity };
        if (plan.removing.length > 0) {
          if (!confirmRemoveOffIdentity) {
            // NOT AN ERROR -- A QUESTION. Nothing has been written, and the
            // throw is what guarantees that. The user sends the same request
            // back with the confirmation to proceed.
            throw new commanderRules.CommanderRuleError(
              409,
              commanderRules.swapRemovalMessage(plan.removing, plan.deck_identity),
              commanderRules.SWAP_REMOVES_CODE,
              {
                // NAMED, WITH A COUNT. This is what the user is agreeing to,
                // so it must be specific enough to reconcile against a binder.
                removing: plan.removing,
                removing_count: plan.removing.length,
                deck_identity: plan.deck_identity,
                requires_confirmation: 'confirm_remove_off_identity'
              }
            );
          }
          swapRemovals = plan.removing;
        }
      }

      // REMOVALS FIRST, THEN THE SWAP.
      //
      // Ordering matters: writeDeckCard re-validates the deck it is writing
      // into, and the off-identity cards are exactly what would make that
      // validation awkward. Removing them first means the swap lands into a
      // deck that is already consistent with its new commander.
      //
      // Both are in this one transaction, so a failure anywhere takes the whole
      // thing back -- including a swap that turns out to be refused on
      // legality below, which must remove nothing.
      if (swapRemovals.length > 0) {
        await commanderRules.applyCommanderSwapRemovals(tx, swapRemovals);
      }

      // SINGLETON IS REFUSED HERE, NOT WARNED.
      //
      // The check itself now lives inside writeDeckCard, the choke point every
      // deck_cards write passes through -- so this route no longer carries its
      // own copy of the rule. It used to, and that was the shape of the
      // problem: the rule was correct here and absent from the three other
      // routes that wrote deck rows.
      //
      // Quantity is the ABSOLUTE new count for this exact variant on this
      // board, not a delta. A delta makes a retried request (dropped response,
      // impatient double-tap) silently double the requirement.
      //
      // The refusal throws from inside the transaction, so a refused add
      // writes nothing at all -- the same promise the finish-validation path
      // already makes.
      await commanderRules.writeDeckCard(tx, deck, {
        oracle_id: identity.oracle_id,
        desired_card_id: identity.desired_card_id,
        desired_finish: identity.desired_finish,
        board,
        quantity: quantityNum,
        // An EDIT names the row it is replacing, so the rule excludes that one
        // row rather than counting it as a duplicate of itself.
        replacingDeckCardId: replacingId,
        // JUDGED AGAINST THE ZONE THIS WRITE PRODUCES, when this write is what
        // changes the zone. Moving a green partner into the 99 narrows the deck
        // to [R], and the green card landing there is the moved card itself --
        // judged against the zone as FOUND it would pass, and the app would
        // produce a deck that breaks its own rule.
        futureZoneIdentity: touchesCommandZone ? futureZoneIdentity : null
      });

      // THE COMMANDER-ZONE GATE.
      //
      // Keyed on `touchesCommandZone`, NOT on the destination board. A write
      // that takes a commander OFF the zone changes the zone just as surely as
      // one that puts a card on it, and the zone that results must still be a
      // legal command zone -- one commander, or two that legally pair.
      //
      // Deck CONTENTS are still never refused by this: an ordinary add touches
      // neither side of the zone, so it does not reach here. That boundary is
      // the whole point -- contents warn, the command zone refuses.
      if (touchesCommandZone) {
        const accepted = await commanderRules.checkCommanderZone(tx, deck, {
          override: commander_override
        });
        if (accepted) {
          await commanderRules.recordCommanderOverride(tx, req.user.id, deck.id, accepted);
        }
      }

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
async function writeImportRequirement(tx, deck, board, allocations) {
  for (const allocation of allocations) {
    const identity = await deckIdentity.oracleIdentityForCard(
      tx, allocation.desired_card_id, allocation.desired_finish
    );
    const existing = await tx.get(
      `SELECT quantity FROM deck_cards
       WHERE deck_id = ? AND desired_card_id = ? AND desired_finish = ? AND board = ?`,
      [deck.id, identity.desired_card_id, identity.desired_finish, board]
    );
    const total = Math.min(
      MAX_REQUIREMENT_QUANTITY,
      (existing ? existing.quantity : 0) + allocation.quantity
    );
    // Through the choke point like every other write. Import already runs its
    // own singleton pre-flight (it has to, because it judges many lines
    // against one snapshot plus the lines it has already accepted), so this
    // should never refuse in practice -- and that is exactly why it is here.
    // If the pre-flight and the rule ever disagree, the deck must not be the
    // thing that absorbs the disagreement: the import throws, rolls back, and
    // the user retries, rather than quietly acquiring an unplayable deck.
    await commanderRules.writeDeckCard(tx, deck, {
      oracle_id: identity.oracle_id,
      desired_card_id: identity.desired_card_id,
      desired_finish: identity.desired_finish,
      board,
      quantity: total
    });
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
    // HYDRATE THE EXISTING COMMAND ZONE BEFORE THE TRANSACTION.
    //
    // Only for a commander-board import, and only the rows already there. The
    // incoming lines are resolved by NAME inside the transaction below against
    // the local cache -- import deliberately makes no per-line network call --
    // so the thing that can wrongly refuse here is a thin row ALREADY in the
    // command zone poisoning the pairing decision for a legal new partner.
    //
    // Outside the transaction, as everywhere else: a network call holding
    // SQLite's single write lock is the failure mode PR 6C/6E ruled out.
    //
    // hasOverride is TRUE here on purpose, and it is not a bypass of the
    // legality rule -- the rule below still runs in full. It only means a
    // Scryfall outage must not turn a paste into a 503: import already takes
    // no override (see the commander gate below), so the user would have no
    // way to proceed, and failing a whole decklist because an upstream service
    // blinked is not a trade worth making. The zone is judged on whatever data
    // the app has, exactly as it was before this refinement.
    if (board === 'commander') {
      const zone = await db.all(
        `SELECT dc.desired_card_id AS id FROM deck_cards dc
         JOIN decks d ON dc.deck_id = d.id
         WHERE dc.deck_id = ? AND d.user_id = ? AND dc.board = 'commander'`,
        [req.params.id, req.user.id]
      );
      await commanderRules.hydrateThinCommanderCards(
        db, zone.map(r => r.id), { hasOverride: true }
      );
    }

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

      // SINGLETON PRE-FLIGHT STATE.
      //
      // Import has to judge many lines against ONE snapshot of the deck plus
      // the lines it has already accepted in this same pass -- the database
      // does not know about those yet. This is the same shape of problem as
      // `claimedCopies` above and it is solved the same way: read the world
      // once, then keep the in-flight bookkeeping in a map beside it.
      //
      // Without this a paste containing "1 Sol Ring (C21) 263" and "1 Sol Ring
      // (CMM) 410" would have BOTH lines read a deck with no Sol Ring in it,
      // both would pass, and the import would create the exact illegal deck
      // this rule exists to prevent.
      const isCommanderDeck = commanderRules.isCommanderFormat(deck.format);
      const deckNameCounts = isCommanderDeck
        ? await commanderRules.nameCountsForDeck(tx, deck.id)
        : new Map();
      // The deck's colour identity, read ONCE for the whole paste. It cannot
      // change during an import -- import never writes the command zone and its
      // own contents -- so re-reading it per line would be a query per card for
      // an answer that does not move.
      const deckIdentityZone = isCommanderDeck
        ? await commanderRules.deckColorIdentity(tx, deck.id)
        : { status: commanderRules.ZONE_KNOWN, identity: null, unverified: [] };

      // AN IMPORT INTO A DECK WITH NO READABLE IDENTITY IS REFUSED WHOLE.
      //
      // Not line by line: an empty or unreadable command zone is a fact about
      // the DECK, and reporting it against each of a hundred pasted lines would
      // blame the user's list for the deck's state. Refused before any line is
      // resolved, so the paste is untouched and can be retried once a commander
      // exists or the cache row is read.
      if (isCommanderDeck && board !== 'commander' && board !== 'considering'
        && deckIdentityZone.status !== commanderRules.ZONE_KNOWN) {
        if (deckIdentityZone.status === commanderRules.ZONE_EMPTY) {
          throw new commanderRules.CommanderRuleError(409,
            `This Commander deck has no commander, so there is no colour identity `
            + `to judge an imported list against. Choose a commander first.`,
            commanderRules.ZONE_EMPTY_CODE, { requires: 'commander' });
        }
        throw commanderRules.commanderIdentityUnverified(deckIdentityZone.unverified);
      }
      const deckIdentityColors = deckIdentityZone.identity;

      // Decide whether a resolved line breaks singleton, and record it if not.
      //
      // Returns a refusal object (which the caller turns into a visible,
      // NAMED line on the preview) or null. Exempt cards are never counted,
      // so twenty Swamps and four Relentless Rats never accumulate towards a
      // refusal for each other.
      const singletonRefusal = (cardRow, requestedCopies) => {
        if (!isCommanderDeck) return null;
        if (board === 'considering') return null;

        // COLOUR IDENTITY IS CHECKED FIRST, AND BEFORE THE SINGLETON EXEMPTION.
        //
        // The spec requires import refusals to be reported IN THE PRE-FLIGHT,
        // not after -- and this function is the pre-flight, shared by preview
        // and apply, so a refusal raised here appears on the screen the user
        // reads before pressing Import.
        //
        // Ahead of isSingletonExempt deliberately: basic lands are exempt from
        // singleton but NOT from colour identity, so a Forest in an Izzet paste
        // must still be refused. Same ordering trap as preflightDeckAdds.
        // AN UNVERIFIED ROW IS REPORTED ON ITS LINE, NOT AT WRITE TIME.
        //
        // Import makes no per-line network call by design, so a row the app has
        // never read reaches the choke point unverified -- where it is now a
        // 503 that would fail the WHOLE paste over one unknown card. Reported
        // here instead, the line is named in the same pre-flight the user reads
        // before pressing Import and every other line still applies.
        //
        // Not a colour ruling: the card is not called illegal, only unchecked.
        // Gated on `deckIdentityColors !== null` for the same reason the colour
        // rule is: no commander means nothing to judge against, so an unread
        // row is not a problem and must not be reported as one.
        if (deckIdentityColors !== null && board !== 'commander'
          && commanderRules.isThinForColorIdentity(cardRow)) {
          return {
            code: commanderRules.VERIFY_UNAVAILABLE_CODE,
            message: `${cardRow.name}: Bindarr has never read this card's colour `
              + `identity, so it cannot verify the card fits this deck's commander. `
              + `This is not a ruling that the card is illegal -- add it on its own `
              + `and Bindarr will look it up.`
          };
        }

        const colorRefusal = commanderRules.checkColorIdentity(
          deckIdentityColors, cardRow, { board }
        );
        if (colorRefusal) {
          return { code: colorRefusal.code, message: colorRefusal.message };
        }

        if (commanderRules.isSingletonExempt(cardRow)) return null;

        const key = commanderRules.normalizeName(cardRow.name);
        const already = deckNameCounts.get(key) || 0;
        if (already > 0) {
          return {
            code: commanderRules.SINGLETON_CODE,
            message: commanderRules.singletonMessage(cardRow.name)
          };
        }
        if (requestedCopies > 1) {
          return {
            code: commanderRules.SINGLETON_CODE,
            message: `${cardRow.name}: Commander decks allow one copy by name, `
              + `so ${requestedCopies} copies cannot be imported.`
          };
        }
        // Accepted. Count it immediately so a LATER line naming the same card
        // by a different printing sees it, whether or not this is an apply.
        // Preview and apply must reach the same verdict, and a count that only
        // moved on apply would make the preview promise an import it refuses.
        deckNameCounts.set(key, already + requestedCopies);
        return null;
      };

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
          // supertype/subtypes/type_line are selected because the singleton
          // exemption is a property of the CARD -- is it a basic land? -- and
          // must be read from the cache rather than inferred from the name.
          // Without them every basic land in a pasted Commander decklist is
          // refused as a duplicate, which is the commonest paste there is.
          let sql = `SELECT id, oracle_id, name, set_id, set_name, number, finishes,
                            supertype, subtypes, type_line, color_identity
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
          // SINGLETON IS CHECKED BEFORE THE LINE IS ALLOCATED.
          //
          // Ordering matters: a refused line must not claim copies. If it
          // allocated first and were refused afterwards, its `claim()` would
          // have already told later lines those physical copies were spent,
          // and a legitimate later line would report a shortfall caused
          // entirely by a line that never imported.
          const explicitRefusal = singletonRefusal(explicitCard, quantity);
          if (explicitRefusal) {
            // A refused line is REPORTED, with its name and the reason, and
            // its copies are counted as visibly unresolved so the conservation
            // invariant still balances. Named and visible, never dropped.
            plan.push({
              name: explicitCard.name,
              oracle_id: explicitCard.oracle_id,
              requested: quantity,
              allocated: 0,
              shortfall: quantity,
              status: 'refused',
              refused: true,
              refusal_code: explicitRefusal.code,
              refusal_reason: explicitRefusal.message,
              explicit: true,
              needs_choice: false,
              allocations: []
            });
            continue;
          }

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
        //
        // supertype/subtypes/type_line are selected because the singleton
        // exemption is a property of the CARD (is it a basic land?) and must
        // be read from the cache rather than guessed from the name.
        const card = await tx.get(
          `SELECT id, oracle_id, name, set_name, number, supertype, subtypes, type_line,
                  color_identity
           FROM card_cache
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

        // Same rule and same ordering as Case A: refuse before allocating, so
        // a refused line never spends a physical copy a later line needs.
        const bareRefusal = singletonRefusal(card, quantity);
        if (bareRefusal) {
          plan.push({
            name: card.name,
            oracle_id: card.oracle_id,
            requested: quantity,
            allocated: 0,
            shortfall: quantity,
            status: 'refused',
            refused: true,
            refusal_code: bareRefusal.code,
            refusal_reason: bareRefusal.message,
            explicit: false,
            needs_choice: false,
            allocations: []
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
        await writeImportRequirement(tx, deck, board, pendingWrites);

        // THE COMMANDER-ZONE GATE applies to import too. `board` is
        // caller-supplied and `commander` is a valid board, so a decklist
        // pasted into the command zone is another way to reach it -- and a
        // rule enforced on three routes out of four is not enforced.
        //
        // Import deliberately takes NO override. The override is an explicit,
        // per-pairing confirmation with a typed reason, and a bulk paste is
        // not the place to collect one: the user is not looking at the pair
        // when they press Import. A refused import rolls back whole and tells
        // them why, and they set the commander from the picker where the
        // confirmation lives.
        if (board === 'commander') {
          await commanderRules.checkCommanderZone(tx, deck, { override: null });
        }
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
      // A REFUSED line counts here for the same reason a line awaiting a
      // printing choice does: its copies did not become deck rows, and the
      // user is told so by name and with a reason. Refused is a visible,
      // explained outcome -- which is precisely what the invariant is asking
      // for. Leaving it out would make the equation fail and roll back an
      // import whose only problem was that it correctly refused a duplicate.
      //
      // Throwing rolls the whole import back. That is the conservative choice
      // and the right one here: for software tracking physical objects, a
      // refused import the user can retry is recoverable, and a silently short
      // deck is not -- they would only discover it holding the cards.
      const requestedCopies = plan.reduce((s, l) => s + (Number(l.requested) || 0), 0);
      const refusedCopies = plan.reduce(
        (s, l) => (l.refused ? s + (Number(l.requested) || 0) : s), 0
      );
      const unresolvedCopies = plan.reduce((s, l) => {
        if (l.refused) return s + (Number(l.requested) || 0);
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
        // Refusals are broken out of the unresolved total rather than merged
        // into it, because they are a different KIND of problem and the user
        // acts on them differently: a line awaiting a printing is one click
        // from being fixed, a line refused for singleton is a card that cannot
        // go in this deck at all. Reporting one number for both would tell
        // them to go looking for a picker that is not there.
        refused_copies: refusedCopies,
        lines_refused: plan.filter(l => l.refused).length,
        refusals: plan
          .filter(l => l.refused)
          .map(l => ({ name: l.name, code: l.refusal_code, reason: l.refusal_reason })),
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
//
// HISTORY, kept because it explains why the rule below is shaped the way it is.
//
// This route used to re-validate the command zone after a delete, then grew a
// colour-aware plan-and-confirm path, then a special refusal for the LAST
// commander of a non-empty deck. Each was a correct answer to the case in front
// of it, and together they were still the wrong rule: they all accepted the
// premise that deleting a commander is an operation and only argued about when
// to allow it. Two reviewer repros lived in that premise --
//
//   Repro A -- delete the Izzet commander, and while the zone is empty the deck
//              had no identity, so a GREEN card was accepted. Put the commander
//              back and you have an [U,R] deck holding a green card.
//   Repro B -- delete the green half of a legal [R,G] pair and the identity
//              narrows to [R] with the green card still sitting there.
//
// Zach's ruling removes the premise instead of patching the cases. See below.
//
// THERE IS NO DELETE-COMMANDER OPERATION. Only a swap.
//
// Zach, 2026-08-19, verbatim: "You cant outright delete the commander only swap
// and when swapping you should get a warning if the swap is to a different
// color type."
//
// This SUPERSEDES the earlier rule here, which refused only the delete that
// would strand cards and allowed the zone to be emptied on a deck with nothing
// in it. That was the wrong shape of rule. PR 6F already refuses to CREATE a
// Commander deck without a commander; permitting deletion one request later was
// a hole in THAT SAME RULE, not a separate question about consequences. A
// Commander deck ALWAYS has a commander, at every instant of its life, and the
// only way to change who leads it is to swap.
//
// SO THE REFUSAL IS UNCONDITIONAL, and deliberately does not consult the deck's
// contents. "Refused only when it would hurt" is a rule the user cannot predict
// -- it works on an empty deck and fails on a full one, so they learn the wrong
// model and are surprised later. "A commander is swapped, never deleted" is one
// sentence they can hold in their head.
//
// IT APPLIES TO A SECOND COMMANDER TOO. Removing one half of a legal partner
// pair takes the zone from two commanders to one, which is a SWAP of the zone
// and must go through the plan-and-confirm path where the stranding warning
// lives -- not a bare delete that silently narrows the deck's colour identity
// under cards already in it.
//
// WHAT THIS MAKES UNREACHABLE. The reviewer's Repro A was: delete the
// commander, add an off-identity card while the zone is empty, put the
// commander back. Its first step no longer exists, so the empty-command-zone
// state cannot be ARRIVED AT through the API at all and the accept-anything
// window has nowhere to open. The choke point's empty-zone refusal stays as
// DEFENCE IN DEPTH and should now be unreachable in practice; it is kept
// because a rule that depends on no other route ever appearing is not enforced.
//
// NON-COMMANDER FORMATS ARE ENTIRELY UNAFFECTED, and so is an ordinary card in
// a Commander deck. This is scoped to the COMMANDER BOARD of a COMMANDER-format
// deck; removing a card from the 99 stays the single unconfirmed request it has
// always been.
router.delete('/:id/cards/:deck_card_id', async (req, res) => {
  try {
    const removed = await db.withTransaction(async (tx) => {
      const deck = await requireOwnedDeck(tx, req.params.id, req.user.id);
      const requirement = await tx.get(
        `SELECT id, board FROM deck_cards WHERE id = ? AND deck_id = ?`,
        [Number(req.params.deck_card_id), deck.id]
      );
      if (!requirement) {
        throw new DeckIdentityError(404, 'Requirement not found', 'REQUIREMENT_NOT_FOUND');
      }

      // THE REFUSAL. Thrown before anything is written, so a refused delete is
      // byte-for-byte inert.
      //
      // It NAMES THE WAY OUT, because a refusal the user cannot see past is the
      // failure mode this whole module is built to avoid. The operation they
      // want exists; it is just spelled differently, and the message says so.
      if (requirement.board === 'commander'
        && commanderRules.isCommanderFormat(deck.format)) {
        throw new commanderRules.CommanderRuleError(409,
          `A Commander deck always has a commander, so a commander cannot be `
          + `deleted -- only SWAPPED for another. Choose the replacement and `
          + `Bindarr will make the change in one step, naming any cards that no `
          + `longer fit its colour identity and removing them only with your `
          + `confirmation.`,
          'COMMANDER_DELETE_UNSUPPORTED',
          { requires: 'swap' });
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

// THE BUYLIST (PR 7). What this deck still needs the user to BUY.
//
// A separate route from GET /:id rather than a field on it, because it is a
// different output with different rules: the deck read describes what the deck
// IS (every planned card, owned or not — which is what export needs), while
// this describes only the gap. Folding them together would have meant one of
// the two silently losing its rule.
//
// The rules themselves live in deckIdentity.buylistForDeck, next to the
// availability arithmetic they depend on. This route only checks ownership and
// serialises — it must not acquire a second opinion about what "missing" means.
router.get('/:id/buylist', async (req, res) => {
  try {
    const deck = await requireOwnedDeck(db, req.params.id, req.user.id);
    const buylist = await deckIdentity.buylistForDeck(db, deck.id, req.user.id);
    res.json({
      deck_id: deck.id,
      deck_name: deck.name,
      items: buylist.items,
      considering: buylist.considering,
      summary: buylist.summary
    });
  } catch (error) {
    sendError(res, error, 'Failed to build buylist');
  }
});

// THE MULTI-DECK BUYLIST (PR 7). One shopping trip for the decks HE SELECTED.
//
// POST rather than GET because the selection is the input and a list of deck
// ids does not belong in a URL — but it is a READ: nothing is written, and no
// selection is saved. He asked for no presets, so a selection lives exactly as
// long as the screen he made it on.
//
// The arithmetic — SUM OF PER-DECK SHORTFALLS, keyed on exact printing +
// finish — lives in deckIdentity.buylistForDecks, next to the per-deck buylist
// it reuses. This route only validates the selection and serialises.
router.post('/buylist', async (req, res) => {
  try {
    const requested = req.body?.deck_ids;

    // AN EMPTY SELECTION IS REFUSED, NOT ANSWERED.
    //
    // Returning an empty list here would be the dangerous answer: an empty
    // shopping list reads as the good news that he needs nothing, when the
    // truth is that he was never asked about any deck. "Buy nothing" and "you
    // selected nothing" are different facts and must look different.
    if (!Array.isArray(requested) || requested.length === 0) {
      throw new DeckIdentityError(
        400,
        'Select at least one deck to build a buylist.',
        'NO_DECKS_SELECTED'
      );
    }

    // De-duplicated, because selecting a deck twice must not double its
    // shortfall — a UI bug would otherwise become a wrong number to spend
    // money against.
    const deckIds = [...new Set(requested.map(Number))];

    // Ownership is checked for EVERY id BEFORE any aggregation, and one
    // foreign id refuses the whole request rather than being quietly dropped.
    // A list silently missing a deck he asked for is a wrong list, and it
    // would look complete.
    const decks = [];
    for (const deckId of deckIds) decks.push(await requireOwnedDeck(db, deckId, req.user.id));

    // "ONLY ACTIVE DECKS SELECTABLE" — and in this model EVERY SAVED DECK IS
    // ACTIVE, so there is nothing extra to filter here.
    //
    // Worth stating explicitly because the requirement sounds like a missing
    // check. PR 6C gave decks an 'active'/'considering' status column; PR 6D
    // removed it as a modelling mistake (see db.js: "considering" describes ONE
    // CARD, via deck_cards.board, never a whole deck). A saved deck therefore
    // always reserves, and the deck-level labels the UI shows (Building, Ready,
    // In Play) are DERIVED at read time, not stored states.
    //
    // So a status filter here would be dead code guarding a column that does
    // not exist, and worse, it would re-imply a deck-level concept the schema
    // deliberately deleted. If a real inactive/archived state is ever added,
    // THIS is the place that must exclude it — an archived deck must not put
    // cards on a shopping list.

    const buylist = await deckIdentity.buylistForDecks(db, deckIds, req.user.id);
    res.json(buylist);
  } catch (error) {
    sendError(res, error, 'Failed to build combined buylist');
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
