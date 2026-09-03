const db = require('../db');
const { alternativesForRequirement } = require('./deckRepoint');
const { summarise } = require('./moxfieldPayload');

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

// Match on ORACLE identity: not the printing, and NOT THE FINISH.
//
// "Is this card still in the deck?" is a question about the CARD. Keying on
// desired_card_id would make a printing change look like a removal plus an
// addition -- which is how his choices would get destroyed.
//
// The finish is excluded for the same reason, learned the hard way: the first
// version keyed on it, preferOwnedPrinting swapped two cards to FOIL promos he
// owns, and every subsequent sync then read those rows as "remove the nonfoil,
// add the foil". Two rows churned forever. If the sync is allowed to choose the
// finish, the finish cannot be part of the identity it diffs on.
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
  const unchanged = [];

  for (const [key, w] of wantByKey) {
    const have = haveByKey.get(key);
    if (!have) {
      add.push(w);
    } else if (have.quantity !== w.quantity) {
      requantify.push({ ...w, deck_card_id: have.id, from: have.quantity, to: w.quantity,
                        keeps_printing: { set_id: have.set_id, number: have.number } });
    } else {
      // THE CARD IS STILL HERE, SO HIS PRINTING STANDS.
      unchanged.push({ name: have.name, board: have.board,
                       keeps_printing: { set_id: have.set_id, number: have.number } });
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
                  quantity: have.quantity,
                  printing: { set_id: have.set_id, number: have.number } });
  }

  return {
    deck: { name: summary.name, format: summary.format,
            public_id: summary.public_id, last_updated_at: summary.last_updated_at },
    add, remove, requantify, unchanged, skipped,
    changes: add.length + remove.length + requantify.length
  };
}

// For a card being ADDED, pick the printing he owns and has free.
//
// Zach: "when we sync it should automatically use the printing of the card we
// have 1 available."
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
  const applied = { added: 0, removed: 0, requantified: 0, printing_preferred: 0 };

  // Resolve preferred printings BEFORE opening the transaction: each lookup
  // runs its own queries, and holding a write transaction open across them
  // would serialize every other request on the instance.
  const additions = [];
  for (const row of plan.add) {
    const better = await preferOwnedPrinting(userId, row);
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
      `UPDATE decks SET moxfield_synced_at = CURRENT_TIMESTAMP,
                        moxfield_updated_at = ?
        WHERE id = ? AND user_id = ?`,
      [plan.deck.last_updated_at, deckId, userId]);

    await db.run('COMMIT');
  } catch (err) {
    await db.run('ROLLBACK').catch(() => {});
    throw err;
  }
  return applied;
}

module.exports = { planSync, applySync, preferOwnedPrinting, oracleKey };
