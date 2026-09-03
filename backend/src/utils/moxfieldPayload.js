// Turn a Moxfield deck payload into the rows Bindarr's deck_cards holds.
//
// Moxfield gives each card a SCRYFALL UUID, and card_cache.id IS that UUID --
// verified: all 93 cards of Zach's Ur-Dragon deck were already in the
// catalogue, 0 missing. So this needs no Scryfall backfill, and the importer's
// admission boundary holds unchanged: a sync may reference cards already in
// card_cache and must never insert into it.

// Moxfield board -> Bindarr board. Anything unlisted is deliberately dropped:
// tokens, attractions, stickers and planes are not deck requirements, and
// counting them would inflate the buy-list with cards he does not need to own.
const BOARD_MAP = {
  commanders: 'commander',
  mainboard: 'mainboard',
  sideboard: 'sideboard',
  maybeboard: 'considering'
};

// Moxfield finish -> Bindarr finish. `etched` is separate from `foil`: they are
// separately priced physical objects and the distinction cannot be recovered
// once flattened.
function finishOf(entry, card) {
  const raw = String(entry.finish || card.finish || '').toLowerCase();
  if (raw === 'etched') return 'etched';
  if (raw === 'foil') return 'foil';
  if (entry.isFoil === true) return 'foil';
  return 'nonfoil';
}

// Flatten every board into one list of requirements.
//
// Returns { rows, skipped }. `skipped` is not noise -- a card Moxfield names
// that we cannot resolve must be REPORTED, never silently dropped, or the deck
// quietly loses a card and the buy-list understates what he needs.
function rowsFromPayload(payload) {
  const rows = [];
  const skipped = [];
  const boards = (payload && payload.boards) || {};

  for (const [mfxBoard, board] of Object.entries(boards)) {
    const target = BOARD_MAP[mfxBoard];
    if (!target) continue;                    // tokens etc: not requirements
    const cards = (board && board.cards) || {};

    for (const [mfxCardId, entry] of Object.entries(cards)) {
      const card = (entry && entry.card) || {};
      const qty = parseInt(entry.quantity, 10);

      if (!card.scryfall_id) {
        skipped.push({ name: card.name || mfxCardId, board: target,
                       reason: 'no_scryfall_id' });
        continue;
      }
      // Zero or unreadable quantities are rejected, not defaulted to 1. The
      // ManaBox importer had exactly this bug: `parseInt(x) || 1` turned an
      // explicit 0 into an owned copy.
      if (!Number.isFinite(qty) || qty < 1) {
        skipped.push({ name: card.name, board: target, reason: 'bad_quantity' });
        continue;
      }

      rows.push({
        scryfall_id: card.scryfall_id,
        name: card.name || null,
        set_id: card.set || null,
        number: card.cn || null,
        board: target,
        quantity: qty,
        finish: finishOf(entry, card)
      });
    }
  }

  // Moxfield can list the same card in one board twice (different finishes).
  // Bindarr's UNIQUE(deck_id, oracle_id, desired_card_id, desired_finish,
  // board) would reject the second, so merge them here rather than let the
  // insert fail halfway through a sync.
  const merged = new Map();
  for (const r of rows) {
    const key = `${r.scryfall_id}|${r.finish}|${r.board}`;
    const seen = merged.get(key);
    if (seen) seen.quantity += r.quantity;
    else merged.set(key, { ...r });
  }

  return { rows: [...merged.values()], skipped };
}

// Everything the sync needs about a deck, in one shape.
function summarise(payload) {
  const { rows, skipped } = rowsFromPayload(payload);
  return {
    public_id: payload.publicId || null,
    name: payload.name || 'Untitled',
    format: payload.format || null,
    // Moxfield's own stamp. Change detection compares this, so an unchanged
    // deck costs one list call rather than a full fetch.
    last_updated_at: payload.lastUpdatedAtUtc || null,
    rows,
    skipped,
    total_cards: rows.reduce((n, r) => n + r.quantity, 0)
  };
}

module.exports = { rowsFromPayload, summarise, BOARD_MAP, finishOf };
