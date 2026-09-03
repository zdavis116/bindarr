const db = require('../db');
const {
  availabilityForRequirement,
  ownedVariantsForOracle,
  entryReserves
} = require('./deckIdentity');

// REPOINTING A DECK ROW AT A PRINTING YOU ACTUALLY HAVE.
//
// Zach's Moxfield import gave every deck row a SPECIFIC printing; his ManaBox
// import gave his collection DIFFERENT printings of many of the same cards.
// Neither is wrong, they just do not agree -- 38 of his 90 deck rows ask for a
// printing he does not own while a copy sits on the shelf.
//
// Zach: "we could own 1 but it could be in another deck so we need to own it
// and it needs to be available."
//
// That is the claim rule deckIdentity.js already owns: copies are claimed by
// deck_cards.id ASC, a `considering` entry claims nothing, and availability is
// DERIVED on every read rather than stored. This module asks that module the
// question rather than computing a rival answer -- two availability
// calculations would eventually disagree, and then the "covered" badge and
// this feature would tell different stories about the same card.

// Can this requirement be satisfied by a printing other than the one it names?
//
// Returns the candidate variants that are genuinely FREE right now, richest
// context first, or an empty list. Never guesses: a caller that wants to swap
// automatically must decide what to do when there is more than one.
async function alternativesForRequirement(database, userId, requirement) {
  // DERIVE `reserves` from the board rather than trusting the caller to attach
  // it. availabilityForRequirement tests `reserves === true`, so a missing
  // field silently means "non-reserving" -- and a non-reserving requirement is
  // told the full availability, ignoring what other decks have claimed. That
  // is the exact guarantee Zach asked for, so it cannot rest on a caller
  // remembering a field.
  const req = {
    ...requirement,
    reserves: requirement.reserves ?? entryReserves(requirement.board)
  };

  // What the row asks for today, and whether it is already satisfiable.
  const current = await availabilityForRequirement(database, userId, req);
  if (current.quantity_available >= req.quantity) {
    // Already covered by the printing it names. Nothing to fix.
    return { current, alternatives: [] };
  }

  // Every printing/finish of this card he owns at least one of.
  const variants = await ownedVariantsForOracle(database, userId, req.oracle_id);

  // Prices for the ordering. ownedVariantsForOracle does not select them, and
  // sorting on undefined would silently preserve insertion order while looking
  // like it sorted.
  const priceRows = variants.length
    ? await database.all(
        `SELECT id, price_trend FROM card_cache WHERE id IN (${
          variants.map(() => '?').join(',')})`,
        variants.map(v => v.desired_card_id))
    : [];
  const priceOf = new Map(priceRows.map(r => [r.id, r.price_trend]));

  const alternatives = [];
  for (const v of variants) {
    // The helper names this field desired_card_id, not card_id.
    if (v.desired_card_id === req.desired_card_id
        && v.finish === req.desired_finish) {
      continue;   // that is the printing it already wants
    }

    // THE SAME AVAILABILITY QUESTION, asked of the alternative. This is the
    // whole point: owning a copy is not enough if another deck has claimed it.
    //
    // The probe carries this requirement's OWN id, so the alternative is
    // judged from this row's position in the claim order rather than as a
    // newcomer at the back of the queue.
    const probe = {
      id: req.id,
      oracle_id: req.oracle_id,
      desired_card_id: v.desired_card_id,
      desired_finish: v.finish,
      quantity: req.quantity,
      reserves: req.reserves
    };
    const avail = await availabilityForRequirement(database, userId, probe);

    if (avail.quantity_available >= req.quantity) {
      alternatives.push({
        card_id: v.desired_card_id,
        finish: v.finish,
        set_id: v.set_id,
        set_name: v.set_name,
        number: v.number,
        // price_trend is NOT selected by ownedVariantsForOracle; fetched
        // below so the cheapest-first ordering has something real to sort on
        // rather than silently comparing undefined to undefined.
        price_trend: priceOf.get(v.desired_card_id) ?? null,
        quantity_owned: avail.quantity_owned,
        quantity_available: avail.quantity_available
      });
    }
  }

  // Same finish first, then cheapest.
  //
  // Finish differences are NOT excluded: Zach, asked directly, said "if I
  // already own it idc if it changes the price of what the deck is worth". A
  // nonfoil he has beats a foil he does not -- the deck is for playing, and a
  // missing card is a real problem where a finish difference is a preference.
  //
  // So this is a tiebreak, not a gate. Given a real choice between an exact
  // finish match and a different one, the exact match is the better default;
  // when only a different finish is free, it is still offered.
  //
  // Cheapest second, so an automatic swap never reaches for the expensive copy
  // when two are equally free.
  alternatives.sort((a, b) => {
    const af = a.finish === req.desired_finish ? 0 : 1;
    const bf = b.finish === req.desired_finish ? 0 : 1;
    if (af !== bf) return af - bf;
    return (a.price_trend || 0) - (b.price_trend || 0);
  });

  return { current, alternatives };
}

// Move a deck row to a different printing.
//
// UNIQUE(deck_id, oracle_id, desired_card_id, desired_finish, board) means the
// target may already exist as its own row. Merging rather than failing: two
// rows for the same card, printing, finish and board is not a state the deck
// screen can show, and refusing would leave him unable to consolidate.
async function repointRequirement(database, deckCardId, userId, cardId, finish) {
  const row = await database.get(
    `SELECT dc.* FROM deck_cards dc
       JOIN decks d ON d.id = dc.deck_id
      WHERE dc.id = ? AND d.user_id = ?`,
    [deckCardId, userId]
  );
  if (!row) return { ok: false, reason: 'not_found' };

  // A checked-out row has a PHYSICAL card allocated against it. Repointing it
  // would leave the allocation describing a card the deck no longer wants --
  // and the only way to discover that is counting cardboard.
  if (row.checked_out) return { ok: false, reason: 'checked_out' };

  const target = await database.get(
    `SELECT id FROM card_cache WHERE id = ?`, [cardId]);
  if (!target) return { ok: false, reason: 'unknown_printing' };

  const existing = await database.get(
    `SELECT id, quantity FROM deck_cards
      WHERE deck_id = ? AND oracle_id = ? AND desired_card_id = ?
        AND desired_finish = ? AND board = ? AND id != ?`,
    [row.deck_id, row.oracle_id, cardId, finish, row.board, row.id]
  );

  if (existing) {
    await database.run(
      `UPDATE deck_cards SET quantity = quantity + ? WHERE id = ?`,
      [row.quantity, existing.id]);
    await database.run(`DELETE FROM deck_cards WHERE id = ?`, [row.id]);
    return { ok: true, merged_into: existing.id };
  }

  await database.run(
    `UPDATE deck_cards SET desired_card_id = ?, desired_finish = ? WHERE id = ?`,
    [cardId, finish, row.id]);
  return { ok: true, updated: row.id };
}

module.exports = { alternativesForRequirement, repointRequirement };
