// ADD A WHOLE PRODUCT TO THE COLLECTION.
//
// Zach: "adding cards to my collection through like precons, secret lair drops
// and my orders on manapool ... those lists are exactly what I would scan so
// would save me time."
//
// Three routes, matching the approved mockup (sketches/017-add-product):
//   GET  /api/products              -> the picker's search results
//   GET  /api/products/:id/cards    -> the confirm list
//   POST /api/products/:id/add      -> commit the ticked cards
//
// THE SPLIT BETWEEN RESOLVE AND ADD IS THE FEATURE, not an implementation
// detail. He asked to "show me the list first, let me confirm or untick cards,
// then add", so nothing touches the collection until the third call.

const express = require('express');
const db = require('../db');
const products = require('../services/mtgjsonProducts');
const collectionRoutes = require('./collection');

const { addCardToCollection, AddCardError } = collectionRoutes;

const router = express.Router();

// A precon is 100 cards; a Secret Lair is a handful. This cap exists so a
// malformed request cannot ask the server to perform an unbounded number of
// sequential inserts, not because any real product approaches it.
const MAX_CARDS = 500;

function sendSourceError(res, error, fallback) {
  // A third party being down must look like a third party being down, never
  // like an empty catalogue.
  if (error.name === 'ProductSourceError') {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error.status && error.code) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  console.error(error);
  return res.status(500).json({ error: fallback });
}

// THE PICKER.
//
// Returns edition GROUPS: one row per drop, with its editions attached, so the
// screen can ask "which edition?" only when there is genuinely a choice. 332 of
// the 751 Secret Lair drops have a foil twin whose name differs by a suffix.
router.get('/', async (req, res) => {
  try {
    const { q, kind } = req.query;
    const allowed = new Set(['precon', 'secretlair']);
    const result = await products.searchProducts(q, {
      kind: allowed.has(kind) ? kind : null,
    });
    res.json(result);
  } catch (error) {
    sendSourceError(res, error, 'Failed to search products');
  }
});

// THE CONFIRM LIST.
//
// Every card is resolved against card_cache and flagged. A card that is NOT in
// the catalogue is returned with inCatalogue:false and MUST still appear -- a
// silently dropped card means a 98-card precon and no way to tell which two are
// missing. Measured 0 of 499 missing across ten real products, so this is the
// rare path, but it is the one that would be invisible if it were wrong.
router.get('/:id/cards', async (req, res) => {
  try {
    const { product, cards, totalCards } = await products.fetchProductCards(req.params.id);

    const ids = [...new Set(cards.map((c) => c.scryfallId).filter(Boolean))];
    const known = new Set();
    if (ids.length) {
      // ONE query, not one per card. This route already runs on a phone over a
      // tailnet; 100 round trips would be felt.
      const rows = await db.all(
        `SELECT id FROM card_cache WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );
      for (const r of rows) known.add(r.id);
    }

    const resolved = cards.map((c) => ({
      ...c,
      inCatalogue: !!(c.scryfallId && known.has(c.scryfallId)),
    }));

    const missing = resolved.filter((c) => !c.inCatalogue);
    res.json({
      product,
      cards: resolved,
      totalCards,
      addableCards: resolved.filter((c) => c.inCatalogue)
        .reduce((n, c) => n + c.quantity, 0),
      missingCount: missing.reduce((n, c) => n + c.quantity, 0),
    });
  } catch (error) {
    sendSourceError(res, error, 'Failed to read that product');
  }
});

// COMMIT.
//
// The client sends back exactly which cards to add, because he may have
// unticked some. The server re-reads the product rather than trusting the
// posted quantities: a client that has been tampered with -- or is simply
// stale -- must not be able to write a quantity the product does not contain.
router.post('/:id/add', async (req, res) => {
  const { scryfall_ids: scryfallIds } = req.body || {};
  if (!Array.isArray(scryfallIds) || scryfallIds.length === 0) {
    return res.status(400).json({ error: 'scryfall_ids must be a non-empty array' });
  }
  if (scryfallIds.length > MAX_CARDS) {
    return res.status(400).json({ error: `At most ${MAX_CARDS} cards at a time` });
  }

  try {
    const { product, cards } = await products.fetchProductCards(req.params.id);
    const wanted = new Set(scryfallIds);
    const chosen = cards.filter((c) => c.scryfallId && wanted.has(c.scryfallId));

    if (chosen.length === 0) {
      return res.status(400).json({ error: 'None of those cards are in that product' });
    }

    // SEQUENTIAL ON PURPOSE. addCardToCollection resolves placement against the
    // rows already inserted, so concurrent adds would race for the same slot --
    // the same reason bulk-add loops rather than parallelises.
    const added = [];
    const failed = [];
    for (const card of chosen) {
      try {
        const result = await addCardToCollection(req.user, {
          card_id: card.scryfallId,
          quantity: card.quantity,
          // Finish comes from the PRODUCT DATA, never from its name.
          finish: card.finish,
          // A sealed product is new cardboard.
          condition: 'Near Mint',
          list_type: 'collection',
        });
        added.push({ scryfallId: card.scryfallId, name: card.name,
          quantity: card.quantity, id: result.id });
      } catch (error) {
        if (!(error instanceof AddCardError)) console.error(error);
        failed.push({
          scryfallId: card.scryfallId,
          name: card.name,
          error: error.message || 'Failed to add card',
        });
      }
    }

    const addedCards = added.reduce((n, a) => n + a.quantity, 0);
    // NEVER CLAIM SUCCESS NOT VERIFIED. The counts are what actually happened,
    // and a partial failure says so rather than rounding up to "done".
    res.status(failed.length && !added.length ? 500 : 200).json({
      product: { id: product.id, name: product.name },
      addedRows: added.length,
      addedCards,
      failed,
      message: failed.length
        ? `Added ${addedCards} cards; ${failed.length} could not be added.`
        : `Added ${addedCards} cards from ${product.name}.`,
    });
  } catch (error) {
    sendSourceError(res, error, 'Failed to add that product');
  }
});

module.exports = router;
