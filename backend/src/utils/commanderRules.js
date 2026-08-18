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
async function writeDeckCard(database, deck, {
  oracle_id,
  desired_card_id,
  desired_finish,
  board = 'mainboard',
  quantity = 1,
  replacingDeckCardId = null
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
      `SELECT id, type_line, oracle_text, keywords, subtypes FROM card_cache WHERE id = ?`,
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
async function preflightDeckAdds(database, deck, candidates) {
  const tx = client(database);
  const isCommander = isCommanderFormat(deck && deck.format);
  const counts = isCommander ? await nameCountsForDeck(tx, deck.id) : new Map();

  const problems = [];
  const accepted = [];
  let applicable = 0;

  for (const candidate of candidates) {
    const card = await tx.get(
      `SELECT id, name, supertype, subtypes, type_line FROM card_cache WHERE id = ?`,
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
  preflightDeckAdds
};
