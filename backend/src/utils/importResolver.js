const db = require('../db');

// RESOLVING A CSV ROW TO A CARD WE ALREADY HAVE.
//
// The admission boundary: an import may add COLLECTION rows pointing at cards
// already in card_cache. It may never INSERT into card_cache itself. Uploaded
// metadata is not a source of truth about what a Magic card is -- only the
// nightly Scryfall catalogue is. A row naming a card we do not have is
// REPORTED, never invented.
//
// Zach: "Report it as rejected." So a file imports what it can and tells him
// precisely what it could not, rather than refusing wholesale.

// Three ways to find a card, in descending order of certainty.
const MATCH = {
  // 1. THE SCRYFALL ID IS THE CARD. card_cache.id IS a Scryfall UUID, so this
  //    is a primary-key lookup: exact, one row, no ambiguity.
  scryfallId: async (row) => {
    if (!row.scryfall_id) return null;
    const hit = await db.get(
      'SELECT id, name, set_id, number FROM card_cache WHERE id = ?',
      [row.scryfall_id]
    );
    return hit ? { card: hit, matchedBy: 'scryfall_id' } : null;
  },

  // 2. SET CODE + COLLECTOR NUMBER identifies a printing, for exports that
  //    predate the Scryfall column. COLLATE NOCASE because ManaBox writes
  //    "(MSH)" where the catalogue stores "msh" -- and a bare LOWER() here
  //    would discard the index and scan 105k rows per line, which is the bug
  //    that made deck import take 30 seconds.
  setAndNumber: async (row) => {
    if (!row.set_code || !row.collector_number) return null;
    const hits = await db.all(
      `SELECT id, name, set_id, number FROM card_cache
        WHERE set_id = ? COLLATE NOCASE
          AND number = ? COLLATE NOCASE
        LIMIT 2`,
      [String(row.set_code).trim(), String(row.collector_number).trim()]
    );
    if (hits.length !== 1) return null;   // ambiguous is not a match
    return { card: hits[0], matchedBy: 'set_and_number' };
  },

  // 3. NAME ALONE IS NOT A MATCH for an import.
  //
  //    A name maps to dozens of printings at wildly different values -- Zach's
  //    own Tony Stark is $6.50 in one printing and $25.30 in another. Guessing
  //    which one he owns would write a wrong record, and a wrong record costs
  //    a recount against cardboard. Reported instead.
  byName: async (row) => {
    if (!row.name) return null;
    const printings = await db.all(
      `SELECT id, name, set_id, number FROM card_cache
        WHERE name = ? COLLATE NOCASE LIMIT 2`,
      [String(row.name).trim()]
    );
    if (printings.length === 0) return null;
    return { ambiguous: true, name: printings[0].name };
  }
};

const REASONS = {
  NOT_IN_CATALOGUE: 'not_in_catalogue',
  AMBIGUOUS_PRINTING: 'ambiguous_printing',
  NO_IDENTIFIER: 'no_identifier',
  BAD_QUANTITY: 'bad_quantity'
};

async function resolveRow(row, index) {
  const label = row.name || row.scryfall_id || `row ${index + 1}`;

  if (!row.scryfall_id && !(row.set_code && row.collector_number) && !row.name) {
    return { ok: false, index, label, reason: REASONS.NO_IDENTIFIER };
  }

  const qty = Number(row.quantity);
  if (!Number.isInteger(qty) || qty < 1) {
    return { ok: false, index, label, reason: REASONS.BAD_QUANTITY, detail: String(row.quantity) };
  }

  const exact = (await MATCH.scryfallId(row)) || (await MATCH.setAndNumber(row));
  if (exact) {
    return { ok: true, index, label, ...exact, row };
  }

  const named = await MATCH.byName(row);
  if (named && named.ambiguous) {
    return {
      ok: false, index, label,
      reason: REASONS.AMBIGUOUS_PRINTING,
      detail: `${row.set_code || '?'} #${row.collector_number || '?'}`
    };
  }

  return {
    ok: false, index, label,
    reason: REASONS.NOT_IN_CATALOGUE,
    detail: `${row.set_code || '?'} #${row.collector_number || '?'}`
  };
}

// Resolve every row, keeping the rejects with enough detail to act on.
async function resolveRows(rows) {
  const resolved = [];
  const rejected = [];
  for (let i = 0; i < rows.length; i++) {
    const r = await resolveRow(rows[i], i);
    (r.ok ? resolved : rejected).push(r);
  }
  return { resolved, rejected };
}

module.exports = { resolveRow, resolveRows, REASONS, MATCH };
