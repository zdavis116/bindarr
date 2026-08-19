// The Commander format's hard rules, stated once.
//
// Everything else in this codebase that checks a deck is ADVISORY: not owning a
// card you plan to buy is a normal state of a deck under construction, so
// deckRules.js warns and never blocks. This module is the deliberate exception,
// and the distinction is worth stating plainly because it will otherwise get
// "tidied" back into a warning by a future reader:
//
//   Ownership and suggestions are WARNINGS -- they describe the user's
//   progress towards a deck.
//   Singleton is a FORMAT RULE -- it describes whether the thing they are
//   building is a deck at all. A Commander list with two Sol Rings cannot be
//   played, and a builder that lets it happen quietly has produced a wrong
//   artifact rather than an incomplete one.
//
// Per Zach (2026-08-18): singleton is REFUSED, not warned, in the picker and in
// import, and the refusal says why.
const db = require('../db');
const { logAuditEvent } = require('./auditLogger');

class CommanderRuleError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details || null;
  }
}

function client(database) {
  return database || db;
}

// Is this deck played under the Commander format?
//
// Matched on the deck's own format string rather than a boolean column: the
// format is free text chosen from a list in the UI ('Commander / EDH'), and
// adding a column would create a second place the same fact lives. The regex
// accepts both spellings players actually use.
//
// EVERY caller of every rule in this file must gate on this. The spec is
// explicit that other formats are entirely unaffected -- no extra field, no
// extra validation, no visual change -- so a rule that leaks into Modern is a
// bug even if the rule itself is correct.
function isCommanderFormat(format) {
  return /commander|edh/i.test(String(format || ''));
}

// Cards whose own text says a deck may contain any number of them.
//
// This is a closed list rather than a parse of the Oracle text, and that is a
// deliberate trade. Parsing "A deck can have any number of cards named ..."
// out of oracle_text would be more general, but it would also be a silent
// dependency on Scryfall's exact wording: a rewording upstream would start
// refusing a legal deck, and the user would have no way to tell why. A short
// list of names is auditable, and the failure mode when a new any-number card
// is printed is that the user gets a refusal they can report -- visible and
// recoverable -- rather than a wrong answer.
//
// Lowercased for comparison; accented names (Nazgûl) are normalised below.
const ANY_NUMBER_CARDS = new Set([
  'relentless rats',
  'shadowborn apostle',
  "dragon's approach",
  'persistent petitioners',
  'nazgul',
  'seven dwarves',
  'rat colony',
  'templar knight'
]);

// Strip diacritics so 'Nazgûl' and 'Nazgul' are the same name. The exemption
// list would otherwise depend on which of the two spellings the card cache
// happens to hold, which is not something the user can see or control.
function normalizeName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function isAnyNumberCard(name) {
  return ANY_NUMBER_CARDS.has(normalizeName(name));
}

function parseSubtypes(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) { try { return JSON.parse(raw); } catch { return []; } }
  return [];
}

// Basic lands are exempt from singleton.
//
// Duplicated in shape from deckRules.isBasicEnergyOrLand rather than imported,
// because the two answer different questions and are allowed to diverge:
// deckRules asks "is this exempt from the 4-copy Constructed limit", this asks
// "is this exempt from Commander singleton". They agree today. Importing one
// into the other would couple two format rules that have no reason to move
// together.
function isBasicLand(card) {
  if (!card) return false;
  const subs = parseSubtypes(card.subtypes);
  const basicTypes = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'];
  const isLand = subs.includes('Land') || card.supertype === 'Land'
    || /\bLand\b/i.test(String(card.type_line || ''));
  if (!isLand) return false;
  // A Basic supertype is the authoritative signal; the name check catches
  // cache rows with a thin type_line but a recognisable basic name.
  const isBasic = subs.includes('Basic')
    || /\bBasic\b/i.test(String(card.type_line || ''))
    || basicTypes.includes(String(card.name || ''));
  return isBasic;
}

// A card is exempt from singleton if it is a basic land or its text allows any
// number. Snow-covered basics are covered by the type check above.
function isSingletonExempt(card) {
  if (!card) return false;
  return isBasicLand(card) || isAnyNumberCard(card.name);
}

const SINGLETON_CODE = 'COMMANDER_SINGLETON';

// The refusal message, written once so the picker and the import say the same
// sentence. The user reads this and has to understand, without opening the
// docs, both WHAT was refused and WHY -- so it names the card and states the
// rule rather than saying "invalid".
function singletonMessage(name) {
  return `${name} is already in this deck; Commander decks allow one copy by name.`;
}

// THE SINGLETON CHECK.
//
// Counted BY NAME across every printing, every finish and every reserving
// board. That is the whole point: exact-only identity means Sol Ring (C21 #263)
// and Sol Ring (CMM #410) are two different physical objects, and for
// availability and checkout they must stay different. For singleton they are
// the same CARD, because the format rule is written about names. Both facts are
// true at once and the code has to hold both.
//
// The 'considering' board is excluded. A considering entry is a note that the
// user is thinking about a card; it is not in the deck, does not reserve
// inventory, and does not count towards legality anywhere else in the app.
// Refusing a considering add on singleton grounds would stop the user from
// even shortlisting an alternative printing of a card they already run.
//
// `excludeDeckCardId` lets an EDIT of an existing row through: raising the
// quantity of the row that already holds the card must be judged against the
// other rows, not against itself. (The quantity rule below still applies.)
//
// Returns null when the add is allowed, or a refusal object naming the card.
async function checkSingleton(database, deck, {
  name,
  quantity = 1,
  board = 'mainboard',
  desiredCardId = null,
  excludeDeckCardId = null,
  card = null
} = {}) {
  if (!isCommanderFormat(deck && deck.format)) return null;
  if (board === 'considering') return null;

  // The exemption is a property of the CARD, so it is read from the cache row
  // rather than trusted from the caller. A caller-supplied "this is a basic"
  // would let a client opt out of the rule by lying.
  let cardRow = card;
  if (!cardRow && desiredCardId) {
    cardRow = await client(database).get(
      `SELECT id, name, supertype, subtypes, type_line FROM card_cache WHERE id = ?`,
      [desiredCardId]
    );
  }
  if (isSingletonExempt(cardRow)) return null;

  const cardName = cardRow ? cardRow.name : name;
  if (!cardName) return null;

  // Asking for more than one copy of a non-exempt card breaks singleton on its
  // own, before any existing row is consulted.
  if (Number(quantity) > 1) {
    return {
      code: SINGLETON_CODE,
      name: cardName,
      message: `${cardName}: Commander decks allow one copy by name, so ${quantity} copies cannot be added.`
    };
  }

  // Every non-considering row in this deck, with its card name.
  //
  // The NAME COMPARISON IS DONE IN JS, NOT IN SQL, and that is deliberate.
  // SQLite's LOWER() is ASCII-only: it lowercases 'Nazgûl' to 'nazgûl' and
  // leaves the accent, so a SQL-side `LOWER(cc.name) = ?` against a
  // diacritic-stripped key silently never matches. Every accented card name
  // would then be exempt from singleton by accident -- a rule that quietly
  // stops applying is worse than one that is not there, because nothing on
  // screen says so. normalizeName is the single definition of "the same card
  // name" and it is applied to both sides here.
  //
  // The row being REPLACED is excluded in SQL, where an id comparison is
  // exact and cheap.
  const params = [deck.id];
  let sql = `
    SELECT dc.id, dc.quantity, cc.name
    FROM deck_cards dc
    JOIN card_cache cc ON dc.desired_card_id = cc.id
    WHERE dc.deck_id = ?
      AND dc.board != 'considering'
  `;
  if (excludeDeckCardId !== null && excludeDeckCardId !== undefined) {
    sql += ` AND dc.id != ?`;
    params.push(excludeDeckCardId);
  }
  const rows = await client(database).all(sql, params);

  const key = normalizeName(cardName);
  // An existing row for the SAME exact variant is not a second copy -- it is
  // the row the caller is about to overwrite, because the deck_cards upsert is
  // keyed on (deck, printing, finish, board) and quantity is absolute. Without
  // this, re-saving a card already in the deck at quantity 1 would refuse
  // itself.
  const total = rows
    .filter(row => normalizeName(row.name) === key)
    .reduce((sum, row) => sum + row.quantity, 0);
  if (total === 0) return null;

  return { code: SINGLETON_CODE, name: cardName, message: singletonMessage(cardName) };
}

// The card names on a deck's reserving boards, lowercased, with their copy
// counts. Used by import, which has to judge many lines against one snapshot
// plus the lines it has already accepted in the same pass -- the database does
// not know about those yet, exactly like the claimedCopies map in decks.js.
async function nameCountsForDeck(database, deckId) {
  const rows = await client(database).all(
    `SELECT cc.name, dc.quantity
     FROM deck_cards dc
     JOIN card_cache cc ON dc.desired_card_id = cc.id
     WHERE dc.deck_id = ? AND dc.board != 'considering'`,
    [deckId]
  );
  const counts = new Map();
  for (const row of rows) {
    const key = normalizeName(row.name);
    counts.set(key, (counts.get(key) || 0) + row.quantity);
  }
  return counts;
}

// THE CHOKE POINT. Every write of a deck_cards row goes through here.
//
// Why this exists rather than a checkSingleton() call at each caller: the rule
// was originally enforced in the deck ADD route only, and three other routes
// wrote deck_cards with their own hand-rolled INSERT -- deck CREATE (writing
// commanders), the import apply path, and the collection screen's bulk
// "add selected to deck" action. The bulk action was a live bypass: selecting
// a second printing of a card already in a Commander deck put a second row in
// by name, producing exactly the unplayable deck the add route refuses to
// produce. A rule enforced at three of four call sites is not enforced.
//
// So the enforcement moves to the only thing all four have in common: the act
// of writing the row. A future fifth route physically cannot forget the rule,
// because there is no other way to create a deck entry.
//
// THE INVARIANT, stated once and enforced here:
//
//   A Commander-format deck NEVER contains two entries with the same card
//   name, regardless of which route put them there -- creation, add, import,
//   repin, commander assignment or swap. Basic lands and ANY_NUMBER_CARDS are
//   the only exemptions. Non-Commander formats are entirely unaffected.
//
// Refusal is a THROW, not a return value. It has to roll back with whatever
// else the caller's transaction was doing: a refused write that left half a
// deck behind would be the silent partial state Bindarr exists to avoid. A
// caller that legitimately wants to report-and-continue (the bulk route, the
// import preview) catches CommanderRuleError and names the card; it does not
// get to skip the check.
//
// `quantity` is ABSOLUTE, matching the upsert semantics every caller already
// uses -- it is the new total for this exact variant on this board, not a
// delta.
//
// `replacingDeckCardId` NAMES THE ROW BEING EDITED, and it is the whole of the
// second invariant:
//
//   SINGLETON COUNTS DISTINCT ENTRIES OTHER THAN THE ONE BEING WRITTEN.
//
// This used to be inferred from the NEW (card, finish, board) tuple, and that
// was the bug. An EDIT changes the tuple -- that is what makes it an edit -- so
// the new tuple does not exist yet, nothing got excluded, and the row being
// edited was counted as a second copy of ITSELF by name. Re-pinning a printing,
// flipping nonfoil to foil, or swapping a commander to a nicer printing of the
// same card were all refused as singleton violations. Singleton has no override
// BY DESIGN, so those operations were not awkward, they were impossible.
//
// Identity, not shape, is what makes a row "the same row". A tuple describes
// what a row currently holds and therefore changes under exactly the operation
// we need to recognise; deck_cards.id does not. So the caller states which row
// it is editing and the rule excludes that one row -- exactly one, so a genuine
// second copy of a DIFFERENT row is still refused.
//
// The REPLACE IS ATOMIC HERE rather than an add-then-delete pair of requests.
// Two requests can only ever be two requests: between them the deck holds two
// copies of one name, and if the second never lands (dropped connection, server
// restart) it holds them permanently -- a deck that is illegal by the app's own
// rule, produced by the app itself. One transaction has no such window, and a
// refusal rolls the whole edit back rather than consuming the row it was
// editing.
// `futureZoneIdentity` JUDGES THE INCOMING CARD AGAINST THE ZONE THE WRITE
// PRODUCES, not the one it found. It is the PR 6G round-2 fix, and it exists
// because of a case the reviewer's suggested patch does not cover.
//
// Moving a green Partner OFF the command zone and into the 99 narrows the deck
// from [R,G] to [R]. Planning removals for the OTHER cards is not enough: the
// moved card is itself green, and it lands in the mainboard of a deck that no
// longer allows green. It STRANDS ITSELF. Judged against the zone as found --
// which still contains the green partner at the moment the check runs -- it
// passes, and the app produces an illegal deck by its own rule.
//
// So a caller performing a command-zone change states the identity the zone
// WILL have, and the incoming card is judged against that. Callers that are not
// changing the zone pass nothing and the live zone is read as before.
//
// Shaped as `{ status, identity }` -- the same shape deckColorIdentity returns
// -- so the branch below is identical for both and the two cannot drift.
async function writeDeckCard(database, deck, {
  oracle_id,
  desired_card_id,
  desired_finish,
  board = 'mainboard',
  quantity = 1,
  replacingDeckCardId = null,
  futureZoneIdentity = null
} = {}) {
  const tx = client(database);

  // THE ROW THIS WRITE IS NOT IN COMPETITION WITH. Two ways a write can be
  // about a row that already exists, and both must be excluded:
  //
  //   1. The caller NAMED the row it is editing (a re-pin, a finish change, a
  //      commander swap). The tuple is changing, so only the id identifies it.
  //   2. The caller is re-saving the SAME tuple. The upsert is keyed on
  //      (deck, printing, finish, board) and quantity is absolute, so this
  //      overwrites in place; without excluding it, re-saving a card already
  //      legitimately in the deck would refuse itself.
  //
  // Case 1 is looked up scoped to THIS DECK. The id arrives from the client, so
  // an id belonging to another deck must not be usable either to excuse a
  // duplicate or to delete a row the request has no business touching.
  let replacing = null;
  if (replacingDeckCardId !== null && replacingDeckCardId !== undefined) {
    replacing = await tx.get(
      `SELECT id, desired_card_id, desired_finish, board FROM deck_cards
       WHERE id = ? AND deck_id = ?`,
      [replacingDeckCardId, deck.id]
    );
    if (!replacing) {
      throw new CommanderRuleError(404,
        'The deck entry being edited no longer exists.', 'REQUIREMENT_NOT_FOUND');
    }
  }

  const existing = await tx.get(
    `SELECT id FROM deck_cards
     WHERE deck_id = ? AND desired_card_id = ? AND desired_finish = ? AND board = ?`,
    [deck.id, desired_card_id, desired_finish, board]
  );

  const excludeDeckCardId = replacing ? replacing.id : (existing ? existing.id : null);

  const refusal = await checkSingleton(tx, deck, {
    quantity,
    board,
    desiredCardId: desired_card_id,
    excludeDeckCardId
  });
  if (refusal) {
    throw new CommanderRuleError(409, refusal.message, refusal.code, { name: refusal.name });
  }

  // COLOUR IDENTITY, AT THE SAME CHOKE POINT AND FOR THE SAME REASON.
  //
  // Enforced here rather than at each route because the spec lists five write
  // paths (browse add, multi-select add, import, re-pin, board moves) and a
  // rule enforced at four of five is not enforced. There is no other way to
  // create a deck entry, so a future sixth route physically cannot forget it.
  //
  // JUDGED ON THE ZONE'S STATE, NOT ON A NULL. This is the PR 6G blocker fix:
  // deckColorIdentity used to return null both for "no commander" and for a
  // deck it could not read, and this code treated null as "nothing to judge".
  // That is the accept-anything window the delete-then-re-add sequence walked
  // through. Each state now gets the answer it actually deserves.
  //
  // Other formats are entirely unaffected, which the spec requires explicitly.
  if (isCommanderFormat(deck && deck.format)) {
    // THE ZONE THIS WRITE ARRIVES AT. A caller mid-way through a command-zone
    // change hands it in, because the live rows still describe the zone as it
    // WAS -- and a card judged against the old zone is judged against a state
    // that will not exist by the time the transaction commits.
    const zone = futureZoneIdentity || await deckColorIdentity(tx, deck.id);
    // The commander board DEFINES the identity and a considering entry is not
    // in the deck, so neither is judged on colour. Checked first, before the
    // zone's state matters at all -- otherwise an empty zone could never be
    // refilled, and the refusal would have no way out.
    const judged = board !== 'commander' && board !== 'considering';
    if (judged) {
      const card = await tx.get(
        `SELECT id, name, color_identity FROM card_cache WHERE id = ?`,
        [desired_card_id]
      );
      const cardName = (card && card.name) || desired_card_id;

      // AN EMPTY COMMAND ZONE ADMITS NOTHING.
      //
      // Not "anything goes". A Commander deck cannot be CREATED without a
      // commander, and since Zach's 2026-08-19 ruling a commander cannot be
      // DELETED either -- only swapped.
      //
      // ROUND-2 CORRECTION: this was previously documented as
      // expected-unreachable. It was NOT. Both commander gates on the swap
      // route were keyed on the DESTINATION board, so moving the only commander
      // OFF the zone emptied it and returned 200 -- and this refusal was the
      // only thing stopping an off-identity card going in behind it. It was
      // live, load-bearing logic described as a backstop, which is the worst of
      // both: nobody maintained it and everybody relied on it.
      //
      // The route now raises the last-commander refusal itself, on either side
      // of the write, so this IS defence in depth again -- but it is kept for
      // the reason it should have been kept all along: a rule that depends on
      // no future route ever reintroducing the state is not a rule that is
      // enforced. If this ever fires, a new write path has reopened the hole.
      if (zone.status === ZONE_EMPTY) {
        throw emptyZoneRefusal(cardName);
      }

      // A COMMANDER THE APP NEVER READ IS COULD-NOT-VERIFY, NOT COLOURLESS.
      //
      // The old code let a NULL commander identity parse as colourless, which
      // refuses every coloured card and tells the user their deck is colourless
      // -- a confident assertion built on data that was never fetched. Honest
      // error instead. Routes hydrate before the transaction; this is the
      // backstop for the paths that cannot.
      if (zone.status === ZONE_UNVERIFIED) {
        throw commanderIdentityUnverified(zone.unverified);
      }

      // THE BACKSTOP FOR AN UNVERIFIED CARD ROW. (Zach, 2026-08-18: fail hard.)
      //
      // Hydration happens on the route, OUTSIDE the transaction, because a
      // network call must not hold SQLite's write lock. That means the routes
      // that do not hydrate could otherwise reach this point with a row the app
      // has never read -- and a NULL colour identity parses as colourless,
      // which fits every deck. The rule would then ACCEPT an unverified card,
      // which is exactly the outcome the hard-fail decision rejects.
      if (isThinForColorIdentity(card)) {
        throw colorVerifyUnavailable(desired_card_id);
      }

      const colorRefusal = checkColorIdentity(zone.identity, card, { board });
      if (colorRefusal) {
        // A THROW, like singleton, so it rolls back with whatever else the
        // caller's transaction was doing. NOT overridable and deliberately not
        // flagged as such: colour identity is card data, so there is nothing
        // for the user to know that the app does not.
        throw new CommanderRuleError(409, colorRefusal.message, colorRefusal.code, {
          name: colorRefusal.name,
          offending: colorRefusal.offending,
          deck_identity: colorRefusal.deck_identity
        });
      }
    }
  }

  // The edit lands as one row, not two. Removed BEFORE the insert so the write
  // cannot momentarily hold both, and inside the caller's transaction so a
  // later refusal (the command-zone gate) takes the deletion back with it.
  //
  // Allocations go with it. The FK is ON DELETE CASCADE, but doing it here
  // explicitly keeps the intent visible and matches the delete route, which
  // does the same for the same reason.
  if (replacing && !(replacing.desired_card_id === desired_card_id
    && replacing.desired_finish === desired_finish
    && replacing.board === board)) {
    await tx.run(`DELETE FROM deck_card_allocations WHERE deck_card_id = ?`, [replacing.id]);
    await tx.run(`DELETE FROM deck_cards WHERE id = ?`, [replacing.id]);
  }

  await tx.run(`
    INSERT INTO deck_cards (deck_id, oracle_id, desired_card_id, desired_finish, board, quantity)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(deck_id, oracle_id, desired_card_id, desired_finish, board)
    DO UPDATE SET quantity = excluded.quantity
  `, [deck.id, oracle_id, desired_card_id, desired_finish, board, quantity]);
}

// COMMANDER PAIRING.
//
// The rule, per Zach (2026-08-18): a deck has ONE commander, or TWO only if
// the cards actually permit it -- Partner, Partner with, Friends Forever,
// Choose a Background, Doctor's companion, and whatever Wizards prints next.
//
// TWO DIFFERENT RULES LIVE NEXT TO EACH OTHER HERE AND MUST NOT BE MERGED:
//
//   SAME NAME    -> REFUSED, and NOT OVERRIDABLE. Two commanders sharing a
//                   card name is the SINGLETON rule applied to the command
//                   zone. It is FIXED: the app cannot be wrong about it, so
//                   there is nothing for a user to override. Enforced by
//                   writeDeckCard above, on every path, because it is a
//                   property of the WRITE.
//   ILLEGAL PAIR -> REFUSED, but OVERRIDABLE WITH A RECORDED REASON. Whether
//                   two legends may legally partner is detected by PARSING
//                   ORACLE TEXT, so unlike singleton the app CAN be wrong --
//                   Wizards prints new pairing mechanics regularly. It is a
//                   property of the COMMAND ZONE AS A WHOLE, so it is checked
//                   in checkCommanderZone below, after the writes land and
//                   inside the same transaction, where it can see both
//                   commanders at once and still roll back.
//
// The distinction is not "hard rule vs soft rule" -- both are hard. It is
// "the app is certain vs the app's knowledge may be out of date".
//
// DETECTED FROM CARD TEXT, NOT FROM A LIST OF NAMES.
//
// A hardcoded list of partner-capable cards would be wrong within one set
// release, and its failure mode is invisible: a legal new pair would be
// refused and the user would have no way to tell the app was simply out of
// date. The mechanic is written on the card, so the card is what we read --
// `keywords` when Scryfall supplies it (the reliable signal) and `oracle_text`
// as the fallback for rows cached before a keyword existed.
//
// This is the OPPOSITE trade from ANY_NUMBER_CARDS above, deliberately. There,
// a list is safer because the set is small, fixed and closed, and a Scryfall
// REWORDING could silently start refusing a legal deck. Here the set is open
// and grows every set, so a list would go stale by construction -- and the
// override is what makes a stale parse recoverable rather than fatal.
const PARTNER_PATTERNS = [
  // Plain Partner. Anchored to a word boundary so "Partner with" is caught by
  // its own rule below and this one does not also have to think about it.
  /\bpartner\b/i,
  /\bfriends forever\b/i,
  /\bchoose a background\b/i,
  /\bdoctor's companion\b/i,
  // "Partner — Survivors" and similar restricted partner variants.
  /\bpartner\s*[—-]/i
];

function cardTextBlob(card) {
  if (!card) return '';
  let keywords = card.keywords;
  if (typeof keywords === 'string' && keywords) {
    try { keywords = JSON.parse(keywords); } catch { keywords = [keywords]; }
  }
  const keywordText = Array.isArray(keywords) ? keywords.join(' ') : '';
  return `${keywordText}\n${String(card.oracle_text || '')}`;
}

// Does this card carry ANY mechanic that permits a second commander?
function hasPartnerMechanic(card) {
  const blob = cardTextBlob(card);
  return PARTNER_PATTERNS.some(pattern => pattern.test(blob));
}

// "Partner with <Name>" names ONE specific card. Returns that name, or null.
//
// Parsed off the reminder-free portion of the line: Scryfall writes
// "Partner with Tevesh Szat, Doom of Fools (When this creature enters...)",
// so the name runs to the opening parenthesis or the end of the line.
function partnerWithName(card) {
  const match = /partner with ([^(\n]+)/i.exec(cardTextBlob(card));
  if (!match) return null;
  return match[1].trim().replace(/[.,]$/, '');
}

// Is this card a Background? Backgrounds are the second half of a
// "Choose a Background" pair and are matched on their SUBTYPE, which is what
// the rules text actually keys on.
function isBackground(card) {
  if (!card) return false;
  const subs = parseSubtypes(card.subtypes);
  return subs.includes('Background') || /\bBackground\b/.test(String(card.type_line || ''));
}

function choosesBackground(card) {
  return /\bchoose a background\b/i.test(cardTextBlob(card));
}

const PAIR_ILLEGAL_CODE = 'COMMANDER_PAIR_ILLEGAL';
const NOT_LEGAL_CODE = 'COMMANDER_NOT_LEGAL';
const TOO_MANY_CODE = 'COMMANDER_TOO_MANY';
const OVERRIDE_REASON_CODE = 'COMMANDER_OVERRIDE_REASON_REQUIRED';
const VERIFY_UNAVAILABLE_CODE = 'COMMANDER_VERIFY_UNAVAILABLE';

// ===========================================================================
// THIN-CACHE HYDRATION.
//
// THE PROBLEM THIS SOLVES. Every commander rule below reads type_line,
// subtypes, oracle_text and keywords. Every one of those fields, when MISSING,
// pushes the answer toward REFUSE: no type line means "not legendary", no
// oracle text means "no partner mechanic", no subtypes means "not a
// Background". So a row the app cached without ever reading the card's text
// does not produce an UNCERTAIN answer -- it produces a CONFIDENT WRONG ONE,
// and the user is blocked from a perfectly legal commander with nothing on
// screen to explain why.
//
// WHY NOT THE TWO OBVIOUS ALTERNATIVES. Both of them accept being wrong:
//
//   Refuse strictly  -> wrongly BLOCKS legal commanders.
//   Soften the rule  -> lets genuinely ILLEGAL ones through.
//
// Neither addresses the actual defect. The rule is not miscalibrated; the
// app's DATA was incomplete. Choosing between those two is choosing which
// direction to be wrong in.
//
// THE PRINCIPLE, per Zach (2026-08-18): WHEN KNOWLEDGE IS INSUFFICIENT TO
// DECIDE, GET BETTER KNOWLEDGE RATHER THAN GUESSING IN EITHER DIRECTION. So a
// thin row is refetched from Scryfall and the rule is re-evaluated against
// complete data. It also SELF-HEALS: the refetch writes the fresh card back to
// card_cache, so the same card is correct from then on and never pays the
// round trip twice.
// ===========================================================================

// IS THIS ROW TOO THIN TO DECIDE ON?
//
// NULL is the signal, and the distinction from '' is load-bearing.
// cacheNormalizedCards always writes '' for a text field and '[]' for a list
// on a card it ACTUALLY READ -- a vanilla creature legitimately has empty
// oracle text. NULL means the row never went through the normalizer at all:
// an early scan, a price-only sweep, a partial import. So NULL means "we never
// looked", while '' means "we looked and there was nothing there", and only
// the first is a reason to go ask.
//
// Treating '' as thin would refetch every vanilla creature forever -- an
// unbounded stream of network calls that never changes an answer.
function isThinForCommanderDecision(card) {
  if (!card) return false;
  const unread = (value) => value === null || value === undefined;
  return unread(card.type_line)
    || unread(card.oracle_text)
    || unread(card.keywords)
    || unread(card.subtypes);
}

// THE INJECTION SEAM.
//
// Required lazily rather than at module load because scryfallApi requires db,
// which requires this module's siblings -- a top-level require here creates a
// cycle that resolves to an empty object at exactly the wrong moment. The
// setter exists so tests can supply a stub and PROVE no network call happens
// on the happy path; a test that monkey-patched the real module could not
// distinguish "not called" from "called and fell through".
let cardFetcher = null;
function setCardFetcher(fetcher) { cardFetcher = fetcher; }
function getCardFetcher() {
  return cardFetcher || require('../scryfallApi');
}

// REFETCH THE THIN ROWS AMONG `cardIds` AND WRITE THEM BACK.
//
// MUST BE CALLED OUTSIDE ANY TRANSACTION. PR 6C/6E established the rule and
// addCardToCollection already follows it: a network call inside a transaction
// holds SQLite's single write lock for the duration of an upstream request,
// stalling every other writer behind a third party's latency. The hydration
// therefore happens BEFORE the transaction opens, exactly like the existing
// Scryfall lookup on the deck-add path.
//
// A FAILED REFETCH IS NOT EVIDENCE OF ILLEGALITY. If Scryfall is down, rate
// limiting us, or does not know the card, the app has learned NOTHING about
// whether the commander is legal -- so it must not quietly pass (writing a
// possibly-illegal deck) and must not quietly refuse (blaming the user for our
// outage). It says, in those words, that it could not verify right now.
//
// `hasOverride` is the one exception, and it is not a loophole. An override is
// the user explicitly asserting legality with a recorded reason; that assertion
// does not depend on us reaching Scryfall, and failing it on an upstream outage
// would reintroduce the exact dead end the override exists to prevent.
async function hydrateThinCommanderCards(database, cardIds, { hasOverride = false } = {}) {
  const ids = [...new Set((cardIds || []).filter(Boolean))];
  if (ids.length === 0) return;

  const fetcher = getCardFetcher();
  const { cacheNormalizedCards } = require('./cardCache');

  for (const id of ids) {
    const row = await client(database).get(
      `SELECT id, type_line, oracle_text, keywords, subtypes, color_identity
       FROM card_cache WHERE id = ?`,
      [id]
    );
    // A row that is absent, or already complete, is not our business. The
    // absent case belongs to the caller's own not-found handling, and the
    // complete case is the HAPPY PATH: a legal commander the app can already
    // decide on must stay instant and must not cost a network call.
    if (!row || !isThinForCommanderDecision(row)) continue;

    let fresh = null;
    try {
      fresh = await fetcher.getCardById(id);
    } catch (error) {
      if (hasOverride) continue;
      throw new CommanderRuleError(503,
        `Bindarr could not verify this card with Scryfall right now, so it cannot `
        + `say whether it is a legal commander. This is not a ruling that the card `
        + `is illegal -- it is the app being unable to check. Try again shortly, or `
        + `override with a reason if you know the card is legal.`,
        VERIFY_UNAVAILABLE_CODE,
        { overridable: true, cards: [{ id }] });
    }

    if (!fresh) {
      // Scryfall answered and does not know this printing. Still not a
      // legality finding: we cannot evaluate a rule against a card we cannot
      // read, and saying "illegal commander" here would be asserting something
      // we did not learn.
      if (hasOverride) continue;
      throw new CommanderRuleError(503,
        `Bindarr could not find this card on Scryfall, so it cannot verify whether `
        + `it is a legal commander. This is not a ruling that the card is illegal. `
        + `Override with a reason if you know the card is legal.`,
        VERIFY_UNAVAILABLE_CODE,
        { overridable: true, cards: [{ id }] });
    }

    // SELF-HEALING. Written through the SAME cache writer every other Scryfall
    // result goes through, so a hydrated row is indistinguishable from a
    // normally-cached one and the next decision about this card is instant.
    await cacheNormalizedCards([fresh]);
  }
}


// HYDRATE THE ROWS AMONG `cardIds` THAT ARE TOO THIN TO DECIDE COLOUR ON.
//
// DELIBERATELY SEPARATE FROM hydrateThinCommanderCards, and the separation is
// the point. The two ask DIFFERENT QUESTIONS of the same row:
//
//   Commander legality -> needs type_line, oracle_text, keywords, subtypes.
//   Colour identity    -> needs color_identity, and nothing else.
//
// Folding colour into the commander predicate (the first attempt) made every
// row with a complete type line but a NULL colour_identity look "thin for
// commander purposes", which sent perfectly decidable commanders off to
// Scryfall and turned a legal create into a 503 when the stub did not know the
// card. A row can be complete for one decision and incomplete for the other;
// merging them makes each answer depend on data it does not use.
//
// MUST BE CALLED OUTSIDE ANY TRANSACTION, like its sibling: a network call
// inside a transaction holds SQLite's single write lock for the duration of an
// upstream request.
//
// A FAILED REFETCH IS NOT EVIDENCE -- IN EITHER DIRECTION. (Zach, 2026-08-18.)
//
// This originally failed SOFT: on an upstream failure it swallowed the error
// and let the rule proceed on whatever the app happened to hold. The reasoning
// was that a colour refusal has no override, so a hard failure would be a dead
// end on an ordinary card add. Zach ruled the other way, and his reasoning is
// the standing principle this whole module is built on:
//
//   An app tracking PHYSICAL OBJECTS must not accept a card it could not
//   verify. "Could not verify this card right now, try again" is RECOVERABLE --
//   the user retries and the app is right. A wrongly-accepted off-identity card
//   is NOT recoverable, because the user would never know to go looking for it.
//   An unnoticed wrong answer is worse than a noticed refusal.
//
// The lockout risk is also much narrower than it first looked.
// isThinForColorIdentity fires ONLY when color_identity is entirely NULL -- a
// row the app has never read at all -- and any card the user has searched,
// owned, or added before is already cached. So the common case never reaches
// the network and an outage cannot lock them out of cards they have handled.
//
// NEVER A LEGALITY RULING IN EITHER DIRECTION. The failure must not silently
// accept (the old behaviour) and must not be dressed up as a colour refusal
// either -- the user must be told the APP could not check, not that their card
// is illegal. Hence the same could-not-verify shape the commander path uses.
//
// NOT OVERRIDABLE, and the omission is deliberate. Colour identity is computed
// from card DATA, so there is nothing for the user to assert that the app does
// not already know; advertising an override here would offer a door that leads
// nowhere. That is the one way this differs from hydrateThinCommanderCards.
async function hydrateThinColorIdentity(database, cardIds) {
  const ids = [...new Set((cardIds || []).filter(Boolean))];
  if (ids.length === 0) return;

  const fetcher = getCardFetcher();
  const { cacheNormalizedCards } = require('./cardCache');

  for (const id of ids) {
    const row = await client(database).get(
      `SELECT id, color_identity FROM card_cache WHERE id = ?`, [id]
    );
    // Absent, or already known: not our business. The complete case is the
    // HAPPY PATH and must not cost a network call.
    if (!row || !isThinForColorIdentity(row)) continue;

    let fresh = null;
    try {
      fresh = await fetcher.getCardById(id);
    } catch {
      throw colorVerifyUnavailable(id);
    }
    // Scryfall answered and does not know this printing. Still not a finding
    // about colour: a rule cannot be evaluated against a card we cannot read.
    if (!fresh) throw colorVerifyUnavailable(id, { notFound: true });

    // SELF-HEALING, through the same cache writer every other Scryfall result
    // goes through, so the next decision about this card is instant.
    await cacheNormalizedCards([fresh]);
  }
}

// THE COULD-NOT-VERIFY REFUSAL FOR COLOUR, written once so the hydration path
// and the checkColorIdentity backstop below say the same sentence.
function colorVerifyUnavailable(cardId, { notFound = false } = {}) {
  const cause = notFound
    ? `Bindarr could not find this card on Scryfall`
    : `Bindarr could not verify this card with Scryfall right now`;
  return new CommanderRuleError(503,
    `${cause}, so it cannot say whether the card's colour identity fits this `
    + `deck's commander. This is NOT a ruling that the card is illegal -- it is `
    + `the app being unable to check, and it will not add a card it could not `
    + `verify. Try again shortly.`,
    VERIFY_UNAVAILABLE_CODE,
    // No `overridable` key at all. Colour identity has no override, and an
    // explicit false could be misread by the UI as "an override exists, it is
    // just switched off".
    { cards: [{ id: cardId }] });
}

// THE COULD-NOT-VERIFY REFUSAL FOR AN UNREADABLE COMMANDER.
//
// Distinct from colorVerifyUnavailable above, which is about the CARD being
// added. This one is about the DECK's own identity being unknowable, and the
// difference matters to the user: nothing is wrong with the card they picked,
// the app simply cannot say what the deck allows.
//
// The alternative -- reading a NULL commander identity as colourless -- is a
// confident wrong answer in BOTH directions, and both are bad:
//
//   Adding cards -> every coloured card is refused, and the message tells the
//                   user their Izzet deck is "colourless". There is no way
//                   through and no way to tell it is a data problem.
//   Swapping     -- planCommanderSwapRemovals would compute a removal list
//                   against that phantom colourless identity and offer to
//                   DELETE the user's real cards. Deleting things from a
//                   decklist on the strength of data never read is the worst
//                   available outcome, and it is the one the old code chose.
//
// 503, matching every other could-not-verify in this module, because it is an
// outage rather than a ruling and will fix itself. NOT overridable: the answer
// is not something the user knows better than the app, it is something NOBODY
// knows until the card is read.
function commanderIdentityUnverified(unverified) {
  const names = (unverified || []).map(c => c.name || c.id).join(', ');
  return new CommanderRuleError(503,
    `Bindarr has not read the colour identity of this deck's commander `
    + `(${names}), so it cannot say which cards fit this deck. This is NOT a `
    + `ruling about any card -- it is the app being unable to check, and it will `
    + `not guess. Try again shortly.`,
    VERIFY_UNAVAILABLE_CODE,
    { cards: (unverified || []).map(c => ({ id: c.id, name: c.name })) });
}

// IS THIS CARD A LEGAL COMMANDER IN ITS OWN RIGHT? (Rule 3)
//
// A legendary creature, OR a card whose text says it can be your commander --
// the planeswalker-commander shape, and whatever else Wizards words that way
// next. Read from the card, not from a list, for the same reason pairing is.
//
// Note the ORDER of the two tests: the text clause is checked as well as the
// type line, never instead of it, because a card can qualify either way and a
// type-line-only rule would refuse every legal planeswalker commander.
function isLegalCommanderCard(card) {
  if (!card) return false;
  const typeLine = String(card.type_line || '');
  const subs = parseSubtypes(card.subtypes);
  const isLegendary = /\blegendary\b/i.test(typeLine)
    || subs.includes('Legendary') || card.supertype === 'Legendary';
  const isCreature = /\bcreature\b/i.test(typeLine) || subs.includes('Creature');
  if (isLegendary && isCreature) return true;
  // Backgrounds are legal in the command zone as the second half of a
  // "Choose a Background" pair, and they are enchantments, not creatures.
  if (isBackground(card)) return true;
  return /\bcan be your commander\b/i.test(cardTextBlob(card));
}

// Judge a pair of commander cards. Returns null when the pair is legal (or
// when there is nothing to judge), or a REFUSAL naming both cards.
//
// Only the two-commander case is judged. One commander is always fine, and
// three or more is already reported separately as COMMANDER_TOO_MANY -- adding
// a second complaint about the same deck would just be noise.
function checkCommanderPairing(cards) {
  if (!Array.isArray(cards) || cards.length !== 2) return null;
  const [a, b] = cards;
  if (!a || !b) return null;

  const nameA = String(a.name || '');
  const nameB = String(b.name || '');

  // "Partner with X" is the most specific form and is checked first: it names
  // its partner, so pairing it with anyone else is illegal EVEN THOUGH the
  // card carries the word Partner. Checking the general Partner rule first
  // would wave this straight through.
  const withA = partnerWithName(a);
  const withB = partnerWithName(b);
  if (withA || withB) {
    const matches = (withA && normalizeName(withA) === normalizeName(nameB))
      || (withB && normalizeName(withB) === normalizeName(nameA));
    if (matches) return null;
    return {
      code: PAIR_ILLEGAL_CODE,
      message: `${nameA} and ${nameB} are not a legal pair: `
        + `${withA ? nameA : nameB} may only partner with `
        + `${withA || withB}.`
    };
  }

  // Choose a Background pairs with a Background, in either order. BOTH sides
  // must match: a card that chooses a Background plus an ordinary legend is
  // not a pair, and neither is a Background beside a legend that does not
  // choose one.
  const backgroundPair = (choosesBackground(a) && isBackground(b))
    || (choosesBackground(b) && isBackground(a));
  if (backgroundPair) return null;
  // A Background that did NOT find a chooser above is not pairable by the
  // plain-Partner rule below either -- "Choose a Background" reminder text on
  // the Background itself must not be read as the Background carrying the
  // mechanic.
  if (isBackground(a) || isBackground(b)) {
    return {
      code: PAIR_ILLEGAL_CODE,
      message: `${nameA} and ${nameB} are not a legal pair. A Background may only `
        + `be paired with a commander whose text says "Choose a Background".`
    };
  }

  // Plain Partner / Friends Forever / Doctor's companion: BOTH cards must
  // carry a pairing mechanic. One partner-capable legend plus one ordinary
  // legend is not a pair.
  if (hasPartnerMechanic(a) && hasPartnerMechanic(b)) return null;

  return {
    code: PAIR_ILLEGAL_CODE,
    message: `${nameA} and ${nameB} are not a legal pair. A Commander deck has one `
      + `commander, or two only if the cards allow it (Partner, Friends Forever, `
      + `Choose a Background, and similar).`
  };
}

// THE COMMANDER-ZONE GATE. Refuse, don't warn.
//
// Per Zach (2026-08-18), superseding the earlier warning-only treatment:
// an illegal commander is REFUSED at creation and on any set/swap.
//
// WHY THIS ONE REFUSES WHILE DECK CONTENTS ONLY WARN. The test is: CAN THE
// USER FIX THIS BY CONTINUING TO WORK? Not owning a card yet, being 40 cards
// short, a colour-identity violation among the 99 -- all of those are normal
// states of a deck under construction, and the user resolves them by carrying
// on. So they warn, and they must keep warning.
//
// The commander is different in kind. It is the deck's identity, fixed at
// creation, and it defines the colour identity every other card is validated
// against. An illegal pair is not "unfinished"; it is a foundation that can
// never become legal, with every subsequent card checked against a wrong
// premise. So it is refused at the point it is introduced.
//
// WHY THIS REFUSAL IS OVERRIDABLE AND SINGLETON IS NOT.
//
// Singleton has NO override because the rule is fixed and the app cannot be
// wrong about it: two cards named Sol Ring is always illegal, in every set,
// forever. There is nothing for the user to know that the app does not.
//
// Pairing legality is different: it is detected by PARSING ORACLE TEXT, and
// Wizards prints new pairing mechanics regularly. So the app CAN be wrong --
// not because the rule is soft, but because the app's KNOWLEDGE is incomplete.
// Without an override, an unrecognised new mechanic would permanently block a
// legal deck with no way around it, and the user would be stuck with no
// recourse and no explanation.
//
// The override therefore requires a REASON, and the reason is not an audit
// formality. Each recorded override is a concrete report that detection failed
// on a real mechanic, with a worked example attached, so the parser can be
// improved instead of the user re-overriding the same pair forever. The list
// of overrides IS the to-do list for improving partner detection.
//
// SILENCE IS NOT CONSENT: the caller must actively supply an override with a
// non-empty reason. Absence of an override means refuse.
//
// THE FIRST INVARIANT, stated once and enforced here:
//
//   AFTER ANY MUTATION, a Commander deck's command zone must be a LEGAL
//   COMMAND ZONE -- one legal commander, or two that legally pair. Never three
//   or more, never two sharing a name.
//
// "AFTER ANY MUTATION" and "AS A WHOLE" are both load-bearing, and each was
// separately violated:
//
//   The pairing test used to sit behind `else if (rows.length === 2)`, so a
//   zone of three was never judged as a pair -- it was left as a tolerated
//   intermediate state, reported only as an advisory warning nobody had to act
//   on. And DELETE never called this function at all. Those two gaps compose
//   into a back door: grow the zone to three (each individual write sees "not
//   two", so pairing never runs), then delete one, and the deck is left holding
//   a pair that creating directly is correctly refused -- no warning, no
//   recorded override, no way for the user to know.
//
// The fix is not a bigger check at the add route; it is asking the question
// about the ZONE rather than about the INCOMING CARD, at every point the zone
// can change. A per-card rule can always be walked around by changing a
// different card. A whole-zone rule evaluated after every mutation cannot,
// because there is no sequence of steps whose end state escapes it.
//
// A ZONE OF THREE IS ILLEGAL IN ITS OWN RIGHT, and unlike pairing it is NOT
// overridable. That follows the same distinction the rest of this module draws:
// "at most two commanders" is a FIXED rule the app cannot be wrong about, like
// singleton, so there is nothing for a user to know that the app does not.
// Pairing legality is parsed from oracle text and therefore CAN be out of date,
// so it keeps its recorded-reason override.
async function checkCommanderZone(database, deck, { override = null } = {}) {
  if (!isCommanderFormat(deck && deck.format)) return null;

  const rows = await client(database).all(
    `SELECT cc.id, cc.name, cc.oracle_text, cc.keywords, cc.subtypes, cc.type_line,
            cc.supertype
     FROM deck_cards dc JOIN card_cache cc ON dc.desired_card_id = cc.id
     WHERE dc.deck_id = ? AND dc.board = 'commander'
     ORDER BY dc.id ASC`,
    [deck.id]
  );
  if (rows.length === 0) return null;

  // Rule 3 first: a card that is not a commander at all is refused before we
  // ask whether two of them pair, because "these two do not partner" is a
  // confusing thing to say about a Sol Ring.
  const notCommander = rows.find(row => !isLegalCommanderCard(row));
  let refusal = null;
  if (notCommander) {
    refusal = {
      code: NOT_LEGAL_CODE,
      message: `${notCommander.name} is not a legal commander. A commander must be a `
        + `legendary creature, or a card whose text says it can be your commander.`,
      cards: [notCommander]
    };
  } else if (rows.length > 2) {
    // NOT OVERRIDABLE, and it throws from here rather than falling through to
    // the override handling below. There is no arrangement of three commanders
    // that is a legal Commander deck, in any set, ever.
    throw new CommanderRuleError(409,
      `This Commander deck would have ${rows.length} commanders. A Commander deck has `
      + `one commander, or two only if the cards allow it (Partner, Friends Forever, `
      + `Choose a Background, and similar).`,
      TOO_MANY_CODE,
      { cards: rows.map(c => ({ id: c.id, name: c.name })) });
  } else if (rows.length === 2) {
    const pairing = checkCommanderPairing(rows);
    if (pairing) refusal = { ...pairing, cards: rows };
  }

  if (!refusal) return null;

  // NO OVERRIDE OFFERED -> refuse, and SAY that an override exists. A refusal
  // the user cannot see a way past is the failure mode this whole design is
  // avoiding.
  if (!override) {
    throw new CommanderRuleError(409, refusal.message, refusal.code, {
      overridable: true,
      cards: refusal.cards.map(c => ({ id: c.id, name: c.name }))
    });
  }

  // AN OVERRIDE WITHOUT A REASON IS NOT AN OVERRIDE. The reason is the entire
  // point: it is what turns a bypass into a bug report. A bare `true` or an
  // empty string is rejected rather than quietly accepted, so the override
  // cannot become a reflexive click.
  //
  // The reason must be an actual STRING. Coercing whatever arrives would let
  // `{ reason: 123 }` record "123" and `{ reason: {} }` record
  // "[object Object]" -- entries that satisfy the check while telling a future
  // reader nothing, which is worse than refusing outright because the override
  // still happened and the report it was collected for is useless.
  const reason = (override && typeof override === 'object' && !Array.isArray(override)
    && typeof override.reason === 'string')
    ? override.reason.trim()
    : '';
  if (!reason) {
    throw new CommanderRuleError(409,
      'To override this refusal, say why you believe the pairing is legal. '
      + 'The reason is recorded so the app can learn the mechanic it did not recognise.',
      OVERRIDE_REASON_CODE,
      { overridable: true, cards: refusal.cards.map(c => ({ id: c.id, name: c.name })) });
  }

  // Accepted. Hand the caller everything the RECORD needs -- both card IDs and
  // NAMES (an id alone is not a worked example a human can read), the reason
  // verbatim, and what was refused.
  return {
    code: refusal.code,
    reason,
    message: refusal.message,
    cards: refusal.cards.map(c => ({ id: c.id, name: c.name }))
  };
}

// ===========================================================================
// COLOUR IDENTITY. A HARD FORMAT RULE -- REFUSED, NOT WARNED.
//
// A Commander deck may only contain cards whose colour identity is a SUBSET of
// the commander's. Zach added Kodama of the West Tree (green) to a red/blue
// deck and it was accepted; that is a deck that cannot be played, produced by
// the app itself.
//
// WHY THIS REFUSES RATHER THAN WARNS, when "you do not own this card yet" only
// warns. The test the rest of this module uses is: CAN THE USER FIX THIS BY
// CONTINUING TO WORK? An unowned card is a normal state of a deck under
// construction -- they resolve it by buying the card. An off-identity card is
// not unfinished; it can never become legal in this deck no matter how much
// more work is done. So it is refused where it is introduced, consistent with
// singleton and commander validity.
//
// WHY IT IS NOT OVERRIDABLE.
//
// This is the same distinction PR 6F drew, applied again. An override exists
// only where the APP CAN BE WRONG:
//
//   Pairing legality  -> parsed from ORACLE TEXT. Wizards prints new mechanics,
//                        so the app's knowledge goes stale. OVERRIDABLE with a
//                        recorded reason, and the reasons are the to-do list.
//   Singleton         -> a FIXED rule about names. NOT overridable.
//   Colour identity   -> computed from Scryfall's own `color_identity` FIELD,
//                        which is card DATA, not prose we parsed. There is
//                        nothing for the user to know that the app does not,
//                        so there is nothing to override. NOT overridable.
//
// A thin row is the one case where the app might not know, and that is handled
// the way PR 6F handles it -- by GETTING BETTER DATA (hydrateThinCommanderCards
// before the transaction), not by guessing in either direction.
// ===========================================================================

const COLOR_IDENTITY_CODE = 'COMMANDER_COLOR_IDENTITY';

// READ THE STORED FIELD, DO NOT DERIVE IT.
//
// Colour identity includes mana symbols in COSTS, in RULES TEXT, and colour
// indicators. A land with no mana cost and no colours whose text reads
// "{T}: Add {G}" has a GREEN identity -- so any implementation that looked at
// the card's `colors` would wave it straight into an Izzet deck. Scryfall
// already computes the correct answer and the cache already stores it; the only
// correct move is to read it.
//
// The cache stores colour NAMES ('Green'), because scryfallApi.normalizeCard
// maps WUBRG through COLOR_NAMES on the way in. Both spellings are accepted
// here so the rule cannot be broken by a row cached under either convention,
// and the output is always canonical single letters for comparison.
const COLOR_LETTER_BY_NAME = {
  white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G',
  w: 'W', u: 'U', b: 'B', r: 'R', g: 'G'
};
const COLOR_NAME_BY_LETTER = {
  W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green'
};

function parseColorIdentity(raw) {
  let list = raw;
  if (typeof list === 'string' && list) {
    try { list = JSON.parse(list); } catch { list = [list]; }
  }
  if (!Array.isArray(list)) return [];
  const letters = new Set();
  for (const entry of list) {
    const letter = COLOR_LETTER_BY_NAME[String(entry || '').trim().toLowerCase()];
    if (letter) letters.add(letter);
  }
  // WUBRG order, so two identities built from differently-ordered rows compare
  // and PRINT the same. A refusal that says "Blue, Red" one time and
  // "Red, Blue" the next reads like two different problems.
  return ['W', 'U', 'B', 'R', 'G'].filter(letter => letters.has(letter));
}

function colorIdentityOfCard(card) {
  return card ? parseColorIdentity(card.color_identity) : [];
}

// Human-readable identity, for a refusal the user can act on.
// A colourless identity is named rather than rendered as an empty string.
function describeColors(letters) {
  if (!letters || letters.length === 0) return 'colourless';
  return letters.map(letter => COLOR_NAME_BY_LETTER[letter] || letter).join(', ');
}

// THE DECK'S COLOUR IDENTITY: the union of its commanders'.
//
// A partner pair's identity is the union of both cards, which is why this is
// computed from the ZONE rather than from a single card.
//
// RETURNS A STATE, NOT A BARE ARRAY-OR-NULL, and that change is the fix for the
// PR 6G blocker. The old signature collapsed THREE different situations into
// one `null`, and every caller then read that null as "nothing to judge, let it
// through":
//
//   EMPTY      -- the command zone has no rows. Under PR 6F a Commander deck
//                 cannot be CREATED without a commander, so this is only
//                 reachable by DELETING one. It is an INVALID deck state, not a
//                 blank cheque, and the window it opened is exactly how a green
//                 card got into an Izzet deck: delete the commander, add the
//                 card while the identity read null, put the commander back.
//   UNVERIFIED -- a commander row's colour identity is NULL, meaning the app
//                 never READ that card. Reading that as colourless is a
//                 confident wrong answer in BOTH directions: it refuses every
//                 coloured card with no way through, and it lets the swap
//                 planner propose DELETING the user's cards on the strength of
//                 data the app never had.
//   KNOWN      -- the ordinary case: `identity` is the union, possibly [] for a
//                 genuinely colourless commander the app DID read.
//
// A non-Commander deck never gets here; callers gate on the format first, so
// other formats pay nothing.
const ZONE_EMPTY = 'empty';
const ZONE_UNVERIFIED = 'unverified';
const ZONE_KNOWN = 'known';

async function deckColorIdentity(database, deckId) {
  const rows = await client(database).all(
    `SELECT cc.id, cc.name, cc.color_identity
     FROM deck_cards dc JOIN card_cache cc ON dc.desired_card_id = cc.id
     WHERE dc.deck_id = ? AND dc.board = 'commander'`,
    [deckId]
  );
  return colorIdentityOfZone(rows);
}

// The same judgement applied to rows the caller already has, so a hypothetical
// zone (the one a swap or a delete WOULD produce) is evaluated by exactly the
// same code as the real one. Two implementations of "what is this zone's
// identity" is how the real zone and the planned zone start disagreeing.
function colorIdentityOfZone(rows) {
  if (!rows || rows.length === 0) {
    return { status: ZONE_EMPTY, identity: null, unverified: [] };
  }
  // Reported BEFORE any union is computed. A single unread commander makes the
  // whole answer unknown -- the union of "red" and "we never looked" is not
  // "red", it is "we do not know".
  const unverified = rows
    .filter(row => isThinForColorIdentity(row))
    .map(row => ({ id: row.id, name: row.name }));
  if (unverified.length > 0) {
    return { status: ZONE_UNVERIFIED, identity: null, unverified };
  }
  const union = new Set();
  for (const row of rows) {
    for (const letter of parseColorIdentity(row.color_identity)) union.add(letter);
  }
  return {
    status: ZONE_KNOWN,
    identity: ['W', 'U', 'B', 'R', 'G'].filter(letter => union.has(letter)),
    unverified: []
  };
}

// THE REFUSAL FOR AN EMPTY COMMAND ZONE.
//
// Written once so every path says the same sentence, and it NAMES THE WAY OUT.
// A Commander deck with no commander has no identity, so it admits NOTHING --
// not even a colourless card, which is a subset of every identity but not of
// "no identity at all". The deck is in a state the app refuses to create, and
// the only thing that can move it forward is choosing a commander.
function emptyZoneRefusal(cardName) {
  return new CommanderRuleError(409,
    `${cardName} cannot be added yet: this Commander deck has no commander, so `
    + `there is no colour identity to judge cards against. Choose a commander `
    + `first and the deck will accept every card that fits it.`,
    ZONE_EMPTY_CODE,
    // No override. This is not the app being unsure about a card -- it is the
    // deck being incomplete, and the user fixes it by continuing.
    { requires: 'commander' });
}

const ZONE_EMPTY_CODE = 'COMMANDER_ZONE_EMPTY';

// The refusal message, written once so every path says the same sentence.
//
// It NAMES the offending colour(s) and the commander's identity, because
// "invalid card" is a refusal the user cannot act on: they need to know which
// colour is the problem and what the deck actually allows.
function colorIdentityMessage(cardName, offending, deckIdentity) {
  return `${cardName} cannot go in this deck: its colour identity includes `
    + `${describeColors(offending)}, but this deck's commander identity is `
    + `${describeColors(deckIdentity)}. A Commander deck may only contain cards `
    + `whose colour identity fits its commander's.`;
}

// THE COLOUR IDENTITY CHECK. Returns null when allowed, or a refusal.
//
// `board` gating, and both halves are load-bearing:
//
//   'commander'  -- SKIPPED. The commander DEFINES the identity; judging it
//                   against itself is circular, and a swap to a commander of a
//                   different identity is a deliberate, separately-handled
//                   operation (see the swap plan in decks.js).
//   'considering'-- SKIPPED, for the same reason singleton skips it. A
//                   considering entry is a note that the user is thinking about
//                   a card. It is not in the deck, reserves nothing, and counts
//                   towards no other legality rule. Refusing it would stop the
//                   user shortlisting a card they may build another deck around.
function checkColorIdentity(deckIdentityLetters, card, { board = 'mainboard' } = {}) {
  if (deckIdentityLetters === null || deckIdentityLetters === undefined) return null;
  if (board === 'commander' || board === 'considering') return null;
  if (!card) return null;

  const cardIdentity = colorIdentityOfCard(card);
  // Colourless fits in EVERY deck -- the empty set is a subset of anything.
  if (cardIdentity.length === 0) return null;

  const allowed = new Set(deckIdentityLetters);
  const offending = cardIdentity.filter(letter => !allowed.has(letter));
  if (offending.length === 0) return null;

  return {
    code: COLOR_IDENTITY_CODE,
    name: card.name,
    offending,
    deck_identity: deckIdentityLetters,
    message: colorIdentityMessage(card.name, offending, deckIdentityLetters)
  };
}

// IS THIS ROW TOO THIN TO DECIDE COLOUR IDENTITY ON?
//
// NULL is the signal, exactly as it is for the commander decision above:
// cacheNormalizedCards always writes '[]' for a card it actually READ, even a
// genuinely colourless one. NULL means the row never went through the
// normalizer, so the app has not learned that the card is colourless -- it has
// learned nothing at all. Treating that as colourless would confidently accept
// an off-identity card, which is the exact bug being fixed.
function isThinForColorIdentity(card) {
  if (!card) return false;
  return card.color_identity === null || card.color_identity === undefined;
}

// PRE-FLIGHT FOR A MULTI-CARD SELECTION.
//
// Per Zach (2026-08-18): "if its taking in a list it should verify the list
// before adding and giving you errors if the list has issues like duplicates
// or something."
//
// This is the same rule the import preview already implements, factored out so
// there is ONE implementation rather than two that can drift. The shape of the
// problem is identical: many candidate writes must be judged against ONE
// snapshot of the deck PLUS the candidates already accepted in the same pass,
// because the database does not know about those yet.
//
// Returns { problems, applicable } -- `problems` naming every candidate that
// will not apply and why, `applicable` counting the copies that would. It
// WRITES NOTHING. The caller decides whether to apply, and the point of the
// split is that the user gets to see the problems before that decision.
//
// `candidates` are { card_id, finish, quantity } as the caller resolved them.
async function preflightDeckAdds(database, deck, candidates, { board = 'mainboard' } = {}) {
  const tx = client(database);
  const isCommander = isCommanderFormat(deck && deck.format);
  const counts = isCommander ? await nameCountsForDeck(tx, deck.id) : new Map();
  // Read ONCE for the whole batch rather than per candidate: the command zone
  // does not change during a pre-flight, and re-reading it per card would turn
  // a 100-card selection into 100 extra queries for an unchanging answer.
  const zone = isCommander
    ? await deckColorIdentity(tx, deck.id)
    : { status: ZONE_KNOWN, identity: null, unverified: [] };

  const problems = [];
  const accepted = [];
  let applicable = 0;

  // THE ZONE'S OWN STATE IS A PROBLEM WITH THE WHOLE BATCH, NOT WITH ONE CARD.
  //
  // An empty or unreadable command zone is not a fact about any candidate, so
  // reporting it per candidate would name the user's cards as if they were the
  // issue. Reported once, and every candidate is rejected -- there is no
  // identity to judge them against, and PR 6G's blocker was exactly the code
  // that treated "no identity" as "no objection".
  const judgedBoard = board !== 'commander' && board !== 'considering';
  if (isCommander && judgedBoard && zone.status !== ZONE_KNOWN) {
    return {
      problems: [zone.status === ZONE_EMPTY
        ? {
          code: ZONE_EMPTY_CODE,
          message: `This Commander deck has no commander, so there is no colour `
            + `identity to judge these cards against. Choose a commander first.`
        }
        : {
          code: VERIFY_UNAVAILABLE_CODE,
          message: `Bindarr has not read the colour identity of this deck's `
            + `commander (${zone.unverified.map(c => c.name || c.id).join(', ')}), `
            + `so it cannot say which of these cards fit. This is not a ruling `
            + `about any card. Try again shortly.`
        }],
      applicable: 0,
      accepted: []
    };
  }
  const identity = zone.identity;

  for (const candidate of candidates) {
    const card = await tx.get(
      `SELECT id, name, supertype, subtypes, type_line, color_identity
       FROM card_cache WHERE id = ?`,
      [candidate.card_id]
    );
    if (!card) {
      problems.push({
        code: 'CARD_UNKNOWN',
        card_id: candidate.card_id,
        message: `${candidate.card_id} is not a known printing and cannot be added.`
      });
      continue;
    }

    // AN UNVERIFIED ROW IS REPORTED HERE, NOT LEFT TO THE WRITE.
    //
    // The batch paths (multi-select add, import) do not hydrate: hydration is a
    // network call and these judge many candidates at once, so a selection of
    // 100 cards would become 100 upstream requests inside one user action.
    //
    // The choke point refuses an unverified row with a 503, which is right but
    // is the WRONG SHAPE here -- it would fail the ENTIRE selection because of
    // one card the app has never read, and say nothing about which. So the
    // pre-flight names the card, the rest of the batch still applies, and the
    // choke point's 503 remains a backstop that should never fire.
    //
    // This is NOT a colour ruling and does not pretend to be: the card is not
    // said to be illegal, only unverifiable right now.
    // GATED EXACTLY LIKE THE COLOUR RULE ITSELF. `identity === null` means
    // there is nothing to judge against -- a non-Commander deck, or a Commander
    // deck with no commander chosen yet -- so there is nothing to verify
    // against and an unread row costs the user nothing. Without this gate a
    // Modern deck would be refused by a rule that does not apply to it at all.
    if (identity !== null
      && board !== 'commander' && board !== 'considering'
      && isThinForColorIdentity(card)) {
      problems.push({
        code: VERIFY_UNAVAILABLE_CODE,
        card_id: candidate.card_id,
        name: card.name,
        message: `${card.name}: Bindarr has never read this card's colour identity, `
          + `so it cannot verify the card fits this deck's commander. This is not a `
          + `ruling that the card is illegal -- add it on its own and Bindarr will `
          + `look it up.`
      });
      continue;
    }

    // COLOUR IDENTITY IS CHECKED BEFORE THE SINGLETON EXEMPTION.
    //
    // Ordering matters and this is the subtle one: basic lands are exempt from
    // SINGLETON but NOT from colour identity. Checking the exemption first
    // would `continue` past this check and wave a Forest into an Izzet deck --
    // two different rules that happen to share an early-out.
    const colorRefusal = checkColorIdentity(identity, card, { board });
    if (colorRefusal) {
      problems.push({
        code: colorRefusal.code,
        card_id: candidate.card_id,
        name: card.name,
        message: colorRefusal.message
      });
      continue;
    }

    if (!isCommander || isSingletonExempt(card)) {
      accepted.push(candidate);
      applicable += candidate.quantity;
      continue;
    }

    const key = normalizeName(card.name);
    const already = counts.get(key) || 0;
    if (already > 0) {
      problems.push({
        code: SINGLETON_CODE,
        card_id: candidate.card_id,
        name: card.name,
        message: singletonMessage(card.name)
      });
      continue;
    }
    if (candidate.quantity > 1) {
      problems.push({
        code: SINGLETON_CODE,
        card_id: candidate.card_id,
        name: card.name,
        message: `${card.name}: Commander decks allow one copy by name, `
          + `so ${candidate.quantity} copies cannot be added.`
      });
      continue;
    }
    // Counted immediately, so a LATER candidate naming the same card by a
    // different printing sees it. Without this, selecting two printings of one
    // card in a single gesture would pass the pre-flight and then be refused
    // at write time -- the exact disagreement the pre-flight exists to remove.
    counts.set(key, already + candidate.quantity);
    accepted.push(candidate);
    applicable += candidate.quantity;
  }

  return { problems, applicable, accepted };
}

// ===========================================================================
// CHANGING THE COMMANDER.
//
// Zach, 2026-08-18, verbatim: "You should allow the swap with a warning that it
// will remove any cards from the deck that are no longer valid."
//
// So the swap is ALLOWED -- it is a legitimate thing to want to do, and
// refusing it would leave the user hand-deleting cards to get permission to
// make a change the app could make for them. But it is NOT SILENT, and that is
// the whole design:
//
//   1. BEFORE anything is applied, the exact cards that will be removed are
//      NAMED, with a count. "Some cards will be removed" is not consent; the
//      user cannot reconcile that against a physical binder.
//   2. The user confirms.
//   3. The swap and the removals happen TOGETHER, in ONE transaction. Never a
//      swapped commander beside a half-cleaned deck -- that state is illegal by
//      the app's own rule and would have been produced by the app itself.
//
// This is the standing principle applied to a multi-step mutation: when an
// operation cannot complete correctly, error out and roll back rather than
// leaving a partial result.
//
// WHAT THIS PLANS AGAINST. `newCommanderIds` is the command zone AS IT WOULD BE
// after the mutation, not the incoming card alone, because a partner pair's
// identity is the union of both -- swapping one half of a pair leaves the other
// half's colours in play, and planning against the incoming card alone would
// over-remove.
//
// AN EMPTY list is still handled below, but since Zach's 2026-08-19 ruling no
// caller should be able to produce one: a commander is swapped, never deleted,
// so every real mutation arrives at a zone with at least one commander in it.
// The branch is kept for the same defence-in-depth reason the choke point's
// empty-zone refusal is.
//
// IT ONLY REPORTS WHAT IS ACTUALLY STRANDED, and that is the second half of
// Zach's ruling. `removing` comes back EMPTY whenever the new identity is the
// SAME as the old one or BROADER than it, because every card in the deck still
// fits and there is nothing to agree to. The caller must not prompt on an empty
// plan: a confirmation dialog that always appears is one the user learns to
// click through without reading, which destroys the value of the one that
// matters. Only a swap that genuinely narrows the identity under cards already
// in the deck produces a non-empty plan and therefore a question.
//
// The 'considering' board is excluded for the same reason it is excluded
// everywhere else: it reserves nothing and is not deck contents, so a swap has
// no business emptying the user's shortlist.
//
// WRITES NOTHING. Returns the plan; the caller decides.
//
// IT REFUSES TO PLAN FROM DATA IT NEVER READ. The removal list decides which of
// the user's REAL CARDS to delete, so it is the last place in the app that may
// guess. A commander row with a NULL colour identity used to parse as
// colourless, which made every coloured card in the deck look off-identity and
// produced a plan offering to delete them all -- built entirely on an identity
// the app never fetched. Now that case throws the honest could-not-verify
// instead, and the plan is empty rather than wrong.
async function planCommanderSwapRemovals(database, deck, newCommanderIds) {
  const tx = client(database);
  if (!isCommanderFormat(deck && deck.format)) return { removing: [] };

  const ids = [...new Set((newCommanderIds || []).filter(Boolean))];
  const commanderRows = ids.length === 0 ? [] : await tx.all(
    `SELECT id, name, color_identity FROM card_cache WHERE id IN (${
      ids.map(() => '?').join(',')
    })`,
    ids
  );
  // The SAME judgement the live zone gets, so the planned zone and the real one
  // cannot disagree about what a NULL means.
  const zone = colorIdentityOfZone(commanderRows);
  if (zone.status === ZONE_UNVERIFIED) throw commanderIdentityUnverified(zone.unverified);

  const entries = await tx.all(
    `SELECT dc.id, dc.board, dc.quantity, cc.id AS card_id, cc.name, cc.color_identity,
            cc.set_name, cc.number
     FROM deck_cards dc JOIN card_cache cc ON dc.desired_card_id = cc.id
     WHERE dc.deck_id = ? AND dc.board NOT IN ('commander', 'considering')
     ORDER BY dc.id ASC`,
    [deck.id]
  );

  // AN EMPTY RESULTING ZONE STRANDS EVERY CARD IN THE DECK, because a deck with
  // no commander has no identity and therefore admits nothing -- the same rule
  // the choke point applies to adds, applied to the state a delete would leave.
  // The caller decides what to do with a plan this large; it does NOT get
  // silently applied.
  const removing = [];
  for (const entry of entries) {
    const refusal = zone.status === ZONE_EMPTY
      ? { offending: colorIdentityOfCard(entry) }
      : checkColorIdentity(zone.identity, entry, { board: entry.board });
    if (!refusal) continue;
    // The set and number are carried because the user has to find these cards
    // in a physical binder afterwards, and a bare name does not identify a
    // printing under exact-only identity.
    removing.push({
      deck_card_id: entry.id,
      card_id: entry.card_id,
      name: entry.name,
      set_name: entry.set_name,
      number: entry.number,
      quantity: entry.quantity,
      board: entry.board,
      offending: refusal.offending
    });
  }

  return { removing, deck_identity: zone.identity, zone_status: zone.status };
}

// APPLY the planned removals, inside the caller's transaction.
//
// Allocations go first and explicitly. The FK is ON DELETE CASCADE, but doing
// it here keeps the intent visible and matches the delete route, which does the
// same for the same reason.
//
// THE PHYSICAL CARD IS NOT TOUCHED. Removing a deck entry releases its
// reservation and its allocation; the collection row -- a real object in a real
// binder -- is untouched and the copy simply becomes available again.
async function applyCommanderSwapRemovals(database, removing) {
  const tx = client(database);
  for (const entry of removing) {
    await tx.run(`DELETE FROM deck_card_allocations WHERE deck_card_id = ?`, [entry.deck_card_id]);
    await tx.run(`DELETE FROM deck_cards WHERE id = ?`, [entry.deck_card_id]);
  }
}

const SWAP_REMOVES_CODE = 'COMMANDER_SWAP_REMOVES_CARDS';

// The warning message. Names the cards and states the count, because that is
// what the user is being asked to agree to.
function swapRemovalMessage(removing, identity) {
  const names = removing.map(r => r.name).join(', ');
  return `Changing the commander to a ${describeColors(identity)} identity will `
    + `remove ${removing.length} card(s) that no longer fit: ${names}. `
    + `The physical cards stay in your collection and become available again. `
    + `Confirm to change the commander and remove them together.`;
}

// RECORD AN ACCEPTED OVERRIDE.
//
// Written through the EXISTING audit_logs table and auditLogger util rather
// than a new store. There is no reason for a second place that means "a thing
// happened, here is what and when" -- and reusing it means the overrides show
// up on the log surface the app already has, which is exactly where the spec
// wants them reviewable.
//
// `action_type` is its own value so the overrides can be filtered out of the
// general log: this list is the to-do list for improving partner detection,
// and it is only useful if you can see it as a list.
//
// after_state carries the WORKED EXAMPLE -- both card ids AND names, the
// user's reason verbatim, and the rule that was overridden. The id alone would
// make the record unreadable to a human six months later, which would defeat
// the point of collecting it.
async function recordCommanderOverride(database, userId, deckId, accepted) {
  await logAuditEvent(
    userId,
    'COMMANDER_PAIR_OVERRIDE',
    'deck',
    deckId,
    null,
    {
      rule: accepted.code,
      refusal: accepted.message,
      reason: accepted.reason,
      cards: accepted.cards
    },
    client(database)
  );
}

module.exports = {
  CommanderRuleError,
  writeDeckCard,
  SINGLETON_CODE,
  PAIR_ILLEGAL_CODE,
  NOT_LEGAL_CODE,
  TOO_MANY_CODE,
  OVERRIDE_REASON_CODE,
  VERIFY_UNAVAILABLE_CODE,
  isThinForCommanderDecision,
  hydrateThinCommanderCards,
  setCardFetcher,
  ANY_NUMBER_CARDS,
  isCommanderFormat,
  isAnyNumberCard,
  isBasicLand,
  isSingletonExempt,
  normalizeName,
  singletonMessage,
  checkSingleton,
  nameCountsForDeck,
  hasPartnerMechanic,
  partnerWithName,
  isBackground,
  isLegalCommanderCard,
  checkCommanderPairing,
  checkCommanderZone,
  recordCommanderOverride,
  preflightDeckAdds,
  // Colour identity (PR 6G).
  COLOR_IDENTITY_CODE,
  SWAP_REMOVES_CODE,
  ZONE_EMPTY_CODE,
  ZONE_EMPTY,
  ZONE_UNVERIFIED,
  ZONE_KNOWN,
  parseColorIdentity,
  colorIdentityOfCard,
  describeColors,
  deckColorIdentity,
  colorIdentityOfZone,
  commanderIdentityUnverified,
  colorIdentityMessage,
  checkColorIdentity,
  isThinForColorIdentity,
  hydrateThinColorIdentity,
  planCommanderSwapRemovals,
  applyCommanderSwapRemovals,
  swapRemovalMessage
};
