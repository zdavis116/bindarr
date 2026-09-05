const db = require('../db');
const { alternativesForRequirement } = require('./deckRepoint');
const { summarise } = require('./moxfieldPayload');

// Boards where a card is genuinely REQUIRED, and so where preferring a copy he
// owns is meaningful. Mirrors deckIdentity's RESERVING_BOARDS: 'considering' is
// excluded there too, because a card he is only thinking about claims nothing.
const PREFERENCE_BOARDS = new Set(['commander', 'mainboard', 'sideboard']);

// RECONCILE A BINDARR DECK AGAINST ITS MOXFIELD SOURCE.
//
// Zach: "Moxfield owns the card list and when we sync it should automatically
// use the printing of the card we have 1 available."
//
// So there are two owners, at two levels:
//
//   MOXFIELD owns WHICH CARDS  -- adds, removals and quantities follow it.
//   BINDARR  owns WHICH PRINTING -- a card he has already pointed at a copy on
//                                   his shelf keeps that choice forever.
//
// Without the second rule every sync would undo his repointing work. He has 78
// of 88 Tony Stark rows on printings he owns; Moxfield names its own printings
// and knows nothing about his shelf.
//
// Local decks (moxfield_public_id IS NULL) are never touched by any of this.

// IDENTITY IS THE CARD ON ITS BOARD; A RELOCATION IS DETECTED SEPARATELY.
//
// Zach: "if deck does exist in Bindarr then all moxfield should be doing is
// making sure the card name is there and ignore printing and foil diff."
//
// Neither the printing nor the finish is part of identity. Both were tried:
//
//   desired_card_id -- a printing change reads as remove + add, and the add
//                      re-picks a printing. His choice is destroyed.
//   finish          -- preferOwnedPrinting swapped two cards to foil promos he
//                      owns, so those rows stopped matching Moxfield's key and
//                      churned on EVERY sync, forever.
//
// The BOARD is different. I removed it too, and that was wrong: his Ur-Dragon
// has Dracogenesis in the mainboard (TDM #105) AND the maybeboard (PTDM #105p).
// Keying on the card alone collapsed two Moxfield rows into one Bindarr row,
// the mainboard copy VANISHED, and a 100-card deck silently became 99.
//
// So the board is back in the key, and relocation is handled as its own case
// (see planSync): when a card sits on exactly one board on each side and those
// differ, it is a move -- the row keeps its printing and finish. When it sits
// on several boards there is no single true answer about which row moved, so we
// do not guess; add and remove are correct because those are distinct
// requirements.
function oracleKey(oracleId, board) {
  return `${oracleId}|${board}`;
}

// Work out what would change, without changing anything.
//
// Returns { add, remove, requantify, unchanged, skipped } where every entry
// carries enough to explain itself in the UI. A sync that cannot be previewed
// is a silent state change.
async function planSync(userId, deckId, payload) {
  const summary = summarise(payload);

  // Resolve Moxfield's scryfall ids to catalogue rows. The admission boundary:
  // a sync may reference cards already in card_cache and must NEVER insert.
  const ids = [...new Set(summary.rows.map(r => r.scryfall_id))];
  const known = ids.length
    ? await db.all(
        `SELECT id, oracle_id, name, set_id, number
           FROM card_cache WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
    : [];
  const byId = new Map(known.map(c => [c.id, c]));

  const wanted = [];
  const skipped = [...summary.skipped];
  for (const r of summary.rows) {
    const cc = byId.get(r.scryfall_id);
    if (!cc) {
      // Reported, never invented. An unknown card means the catalogue is behind
      // Scryfall, and the honest answer is to say so.
      skipped.push({ name: r.name, board: r.board, reason: 'not_in_catalogue' });
      continue;
    }
    wanted.push({ ...r, oracle_id: cc.oracle_id, card_id: cc.id });
  }

  const existing = await db.all(
    `SELECT dc.id, dc.oracle_id, dc.desired_card_id, dc.desired_finish,
            dc.quantity, dc.board, dc.checked_out,
            cc.name, cc.set_id, cc.number
       FROM deck_cards dc
       JOIN card_cache cc ON cc.id = dc.desired_card_id
      WHERE dc.deck_id = ?
      ORDER BY dc.id ASC`, [deckId]);

  const haveByKey = new Map();
  for (const e of existing) {
    haveByKey.set(oracleKey(e.oracle_id, e.board), e);
  }
  const wantByKey = new Map();
  for (const w of wanted) {
    wantByKey.set(oracleKey(w.oracle_id, w.board), w);
  }

  const add = [];
  const requantify = [];
  const moveBoard = [];
  const unchanged = [];

  for (const [key, w] of wantByKey) {
    const have = haveByKey.get(key);
    if (!have) {
      add.push(w);
      continue;
    }

    // THE CARD IS STILL HERE, SO HIS PRINTING AND FINISH STAND.
    // Only quantity and board may follow Moxfield.
    const keeps = { set_id: have.set_id, number: have.number,
                    finish: have.desired_finish };

    // No board test here: the board is part of the key, so a matched pair is
    // always on the same board. Relocation is paired up after this loop.
    if (have.quantity !== w.quantity) {
      requantify.push({ ...w, deck_card_id: have.id, from: have.quantity, to: w.quantity,
                        keeps_printing: keeps });
    } else {
      unchanged.push({ name: have.name, board: have.board, keeps_printing: keeps });
    }
  }

  const remove = [];
  for (const [key, have] of haveByKey) {
    if (wantByKey.has(key)) continue;
    // A checked-out row has a physical card allocated against it. Removing it
    // would leave an allocation describing a card no deck wants -- findable
    // only by counting cardboard.
    if (have.checked_out) {
      skipped.push({ name: have.name, board: have.board, reason: 'checked_out' });
      continue;
    }
    remove.push({ deck_card_id: have.id, name: have.name, board: have.board,
                  oracle_id: have.oracle_id, quantity: have.quantity,
                  printing: { set_id: have.set_id, number: have.number,
                              finish: have.desired_finish } });
  }

  // PAIR UP RELOCATIONS.
  //
  // A card that left one board and appeared on another is the same requirement
  // moved, not a deletion plus a purchase -- and his printing must survive it.
  // Only unambiguous pairs qualify: one removal and one addition of the same
  // card. With the card on several boards there is no single true answer about
  // which row moved, and a wrong guess silently rewrites a printing.
  const removedByCard = new Map();
  for (const r of remove) {
    const list = removedByCard.get(r.oracle_id) || [];
    list.push(r);
    removedByCard.set(r.oracle_id, list);
  }
  const addedByCard = new Map();
  for (const a of add) {
    const list = addedByCard.get(a.oracle_id) || [];
    list.push(a);
    addedByCard.set(a.oracle_id, list);
  }

  for (const [oracleId, removals] of removedByCard) {
    const additions = addedByCard.get(oracleId) || [];
    if (removals.length !== 1 || additions.length !== 1) continue;
    const from = removals[0];
    const to = additions[0];
    moveBoard.push({
      deck_card_id: from.deck_card_id,
      name: from.name,
      from_board: from.board,
      to_board: to.board,
      quantity: to.quantity,
      from_quantity: from.quantity,
      keeps_printing: { set_id: from.printing.set_id, number: from.printing.number,
                        finish: from.printing.finish }
    });
    remove.splice(remove.indexOf(from), 1);
    add.splice(add.indexOf(to), 1);
  }

  // WHICH ADDS WILL USE A COPY HE ALREADY OWNS.
  //
  // Resolved here, not just in applySync, so the preview names the printing
  // that will actually be stored. Otherwise he approves a plan showing C20 #253
  // and ends up with MSH #80 -- a preview that disagrees with its own outcome.
  for (const row of add) {
    const better = PREFERENCE_BOARDS.has(row.board)
      ? await preferOwnedPrinting(userId, row)
      : null;
    if (better) {
      row.uses_owned_copy = true;
      row.owned_printing = { set_id: better.set_id, number: better.number,
                             finish: better.finish, card_id: better.card_id };
    }
  }

  return {
    deck: { name: summary.name, format: summary.format,
            public_id: summary.public_id, last_updated_at: summary.last_updated_at },
    add, remove, requantify, moveBoard, unchanged, skipped,
    changes: add.length + remove.length + requantify.length + moveBoard.length,
    // For the banner's reassurance line: "N of the added cards will use copies
    // you already own."
    uses_owned: add.filter(r => r.uses_owned_copy).length
  };
}

// For a card being ADDED, pick the printing he owns and has free.
//
// Zach: "when we sync it should automatically use the printing of the card we
// have 1 available."
//
// This runs for ADDS ONLY, which is what makes the two halves of his rule the
// same code. On a FIRST sync every row is an add, so Moxfield "semi controls"
// the printing -- its choice is the starting point and ours wins wherever we
// own something free. On LATER syncs only genuinely new cards are adds;
// existing rows are moves, requantifies or unchanged, and none of those touch
// printing or finish.
//
// alternativesForRequirement already answers exactly this, using
// deckIdentity's claim rule -- owned AND not spoken for by another deck. Asking
// it rather than writing a second availability calculation: two of those would
// eventually disagree, and then the "covered" badge and the sync would tell
// different stories about the same card.
async function preferOwnedPrinting(userId, row) {
  const probe = {
    id: null,
    oracle_id: row.oracle_id,
    desired_card_id: row.card_id,
    desired_finish: row.finish,
    quantity: row.quantity,
    board: row.board
  };
  try {
    const { current, alternatives } = await alternativesForRequirement(db, userId, probe);
    if (current.quantity_available >= row.quantity) return null;  // already fine
    // alternatives are ordered same-finish-first, then cheapest, and every one
    // is genuinely free. Ambiguity is not a problem here the way it is for a
    // bulk repoint: this is a NEW card with no prior choice to overwrite.
    return alternatives.length ? alternatives[0] : null;
  } catch {
    return null;   // never let printing preference fail a sync
  }
}


// APPLY A PLAN, all or nothing.
//
// A half-applied sync leaves him unable to tell which decklist he is holding --
// the same reason the bulk repoint runs in one transaction.
//
// Adds get the printing he OWNS AND HAS FREE, per his instruction: "when we
// sync it should automatically use the printing of the card we have 1
// available." Existing rows keep the printing they already have, because the
// card is still in the deck and that choice was his.
async function applySync(userId, deckId, plan) {
  const applied = { added: 0, removed: 0, requantified: 0, moved: 0, printing_preferred: 0 };

  // Resolve preferred printings BEFORE opening the transaction: each lookup
  // runs its own queries, and holding a write transaction open across them
  // would serialize every other request on the instance.
  const additions = [];
  for (const row of plan.add) {
    // Only boards that actually require the card. A considering row is a note
    // about something he is thinking about, so it keeps Moxfield's printing --
    // his words: "they should stay as what they are in moxfield". It is also
    // the board deckIdentity excludes from RESERVING_BOARDS, so substituting a
    // copy would imply a claim the row deliberately does not make.
    const better = PREFERENCE_BOARDS.has(row.board)
      ? await preferOwnedPrinting(userId, row)
      : null;
    additions.push({
      ...row,
      final_card_id: better ? better.card_id : row.card_id,
      final_finish: better ? better.finish : row.finish,
      swapped: Boolean(better)
    });
  }

  await db.run('BEGIN');
  try {
    for (const a of additions) {
      await db.run(
        `INSERT INTO deck_cards
           (deck_id, oracle_id, desired_card_id, desired_finish, board, quantity)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [deckId, a.oracle_id, a.final_card_id, a.final_finish, a.board, a.quantity]);
      applied.added += 1;
      if (a.swapped) applied.printing_preferred += 1;
    }

    // A BOARD MOVE KEEPS EVERYTHING ELSE.
    //
    // Zach moves a card maybeboard -> mainboard in Moxfield. The row stays: same
    // desired_card_id, same finish, same id. Only the board changes, and the
    // quantity follows Moxfield because that is part of the card list.
    for (const m of plan.moveBoard) {
      await db.run(
        `UPDATE deck_cards SET board = ?, quantity = ? WHERE id = ? AND deck_id = ?`,
        [m.to_board, m.quantity, m.deck_card_id, deckId]);
      applied.moved += 1;
    }

    for (const r of plan.requantify) {
      // Quantity only. The row keeps its desired_card_id, so a repointed
      // printing survives a quantity change from Moxfield.
      await db.run(`UPDATE deck_cards SET quantity = ? WHERE id = ? AND deck_id = ?`,
        [r.to, r.deck_card_id, deckId]);
      applied.requantified += 1;
    }

    for (const r of plan.remove) {
      await db.run(`DELETE FROM deck_cards WHERE id = ? AND deck_id = ?`,
        [r.deck_card_id, deckId]);
      applied.removed += 1;
    }

    await db.run(
      // BOTH COLUMNS HOLD THE SAME KIND OF VALUE, because the deck list and the
      // panel compare them to each other to answer "has Moxfield moved since we
      // synced?". CURRENT_TIMESTAMP wrote SQLite's '2026-09-04 12:04:21' while
      // the other side holds Moxfield's '2026-09-03T16:09:06.33Z' -- comparing
      // those as strings is meaningless, and on the same day ' ' vs 'T'
      // inverts the answer.
      `UPDATE decks SET moxfield_synced_at = ?,
                        moxfield_updated_at = ?
        WHERE id = ? AND user_id = ?`,
      [plan.deck.last_updated_at, plan.deck.last_updated_at, deckId, userId]);

    await db.run('COMMIT');
  } catch (err) {
    await db.run('ROLLBACK').catch(() => {});
    throw err;
  }
  return applied;
}

module.exports = { planSync, applySync, preferOwnedPrinting, oracleKey };
