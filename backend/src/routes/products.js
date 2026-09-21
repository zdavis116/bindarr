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
const orders = require('../services/manapoolOrders');
const collectionRoutes = require('./collection');

const { addCardToCollection, AddCardError } = collectionRoutes;

const router = express.Router();

// A precon is 100 cards; a Secret Lair is a handful. This cap exists so a
// malformed request cannot ask the server to perform an unbounded number of
// sequential inserts, not because any real product approaches it.
const MAX_CARDS = 500;

// ADD A LIST OF CARDS IN ONE TRANSACTION.
//
// Shared by the precon path and the Mana Pool orders path, because they differ
// only in WHERE the cards came from: the rules about stacking, one transaction,
// and honest counts are identical, and two copies would drift.
//
// Each card carries its own quantity, finish, condition and optional purchase
// price -- an order's cards are not all Near Mint nonfoil the way a sealed
// precon's are.
async function addCardsInOneTransaction(user, cards) {
  const added = [];
  const failed = [];
  await db.withTransaction(async () => {
    for (const card of cards) {
      try {
        const result = await addCardToCollection(user, {
          card_id: card.scryfallId,
          quantity: card.quantity,
          // ONE ROW OF N, NOT N ROWS OF ONE.
          //
          // addCardToCollection defaults to stackable:false, which files each
          // copy as its own row. Omitting this turned "15x Island" into fifteen
          // rows of 1 -- the right cards in the wrong shape. Search-and-add
          // (CardSearch.jsx) passes stackable: true too.
          stackable: true,
          // Finish comes from the DATA, never from a name.
          finish: card.finish,
          condition: card.condition,
          // What he actually paid, when the source knows. A precon does not
          // price its cards individually; an order does.
          ...(card.unitPrice ? { purchase_price: card.unitPrice } : {}),
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
  }, { timeoutMs: 120000 });
  return { added, failed };
}

// Resolve a list of cards against card_cache in ONE query, flagging each.
//
// A card that is NOT in the catalogue is returned with inCatalogue:false and
// MUST still appear: a silently dropped card means a short order and no way to
// tell which cards are missing.
async function flagAgainstCatalogue(cards) {
  const ids = [...new Set(cards.map((c) => c.scryfallId).filter(Boolean))];
  const known = new Set();
  if (ids.length) {
    const rows = await db.all(
      `SELECT id FROM card_cache WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    for (const r of rows) known.add(r.id);
  }
  return cards.map((c) => ({
    ...c,
    inCatalogue: !!(c.scryfallId && known.has(c.scryfallId)),
  }));
}

// The stored Mana Pool credentials. Read per request rather than cached, so
// changing them in Settings takes effect immediately.
async function manapoolCreds() {
  const row = await db.get(
    'SELECT manapool_email AS email, manapool_token AS token FROM app_settings WHERE id = 1');
  return { email: row?.email || null, token: row?.token || null };
}

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

// ORDER ROUTES ARE DECLARED FIRST, DELIBERATELY.
//
// Express matches in declaration order, and `/:id/cards` happily matches
// `/orders/list` with id="orders". Declared after the precon routes, every
// orders request was swallowed by the precon handler and looked for a product
// called "orders". Verified by printing router.stack, not by reasoning about
// it.
// ===========================================================================
// MANA POOL ORDERS
//
// Zach: "mana pool orders should be in the add product section." So these live
// on the same router and surface as a filter INSIDE the product picker, not as
// another row in the Add cards sheet.
//
// Same two-step contract as precons: look, then commit. Nothing is written
// until the POST.
// ===========================================================================

// THE ORDER LIST. Summary only -- Mana Pool's list endpoint carries no cards,
// so this is cheap and the detail call happens when he picks one.
router.get('/orders/list', async (req, res) => {
  try {
    const creds = await manapoolCreds();
    const list = await orders.listOrders(creds);
    res.json({ orders: list, connected: true });
  } catch (error) {
    // NOT CONNECTED IS NOT AN ERROR. The picker shows a "connect your account"
    // state rather than a red failure, because he has not done anything wrong.
    if (error.code === 'MANAPOOL_AUTH' && !error.message.includes('rejected')) {
      return res.json({ orders: [], connected: false, reason: error.message });
    }
    sendSourceError(res, error, 'Failed to read your Mana Pool orders');
  }
});

// ONE ORDER'S CARDS, resolved against the catalogue. Read-only.
router.get('/orders/:id/cards', async (req, res) => {
  try {
    const creds = await manapoolCreds();
    const { order, cards, skipped, totalCards } =
      await orders.fetchOrderCards(req.params.id, creds);

    const resolved = await flagAgainstCatalogue(cards);
    const missing = resolved.filter((c) => !c.inCatalogue);

    res.json({
      product: {
        id: order.id,
        name: `Order ${order.orderNumber}`,
        kind: 'order',
        orderNumber: order.orderNumber,
        createdAt: order.createdAt,
        totalCents: order.totalCents,
      },
      cards: resolved,
      totalCards,
      addableCards: resolved.filter((c) => c.inCatalogue)
        .reduce((n, c) => n + c.quantity, 0),
      missingCount: missing.reduce((n, c) => n + c.quantity, 0),
      // Sealed products and unshipped lines are NAMED, never silently absent.
      // "Why is my order 3 cards short" must have an answer on the screen.
      skipped,
    });
  } catch (error) {
    sendSourceError(res, error, 'Failed to read that order');
  }
});

// COMMIT AN ORDER.
//
// Re-reads the order from Mana Pool rather than trusting posted values, for the
// same reason the precon path re-reads the product: a stale or tampered client
// must not be able to write a quantity, condition or price that the order does
// not contain.
router.post('/orders/:id/add', async (req, res) => {
  const { scryfall_ids: scryfallIds } = req.body || {};
  if (!Array.isArray(scryfallIds) || scryfallIds.length === 0) {
    return res.status(400).json({ error: 'scryfall_ids must be a non-empty array' });
  }
  if (scryfallIds.length > MAX_CARDS) {
    return res.status(400).json({ error: `At most ${MAX_CARDS} cards at a time` });
  }

  try {
    const creds = await manapoolCreds();
    const { order, cards } = await orders.fetchOrderCards(req.params.id, creds);
    const wanted = new Set(scryfallIds);
    const chosen = cards.filter((c) => c.scryfallId && wanted.has(c.scryfallId));

    if (chosen.length === 0) {
      return res.status(400).json({ error: 'None of those cards are in that order' });
    }

    // The card records already carry the condition he bought and what he paid,
    // so unlike a precon nothing is overridden here.
    const { added, failed } = await addCardsInOneTransaction(req.user, chosen);

    await db.run(
      `UPDATE app_settings SET manapool_orders_synced_at = CURRENT_TIMESTAMP WHERE id = 1`);

    const addedCards = added.reduce((n, a) => n + a.quantity, 0);
    res.status(failed.length && !added.length ? 500 : 200).json({
      product: { id: order.id, name: `Order ${order.orderNumber}` },
      addedRows: added.length,
      addedCards,
      failed,
      message: failed.length
        ? `Added ${addedCards} cards; ${failed.length} could not be added.`
        : `Added ${addedCards} cards from order ${order.orderNumber}.`,
    });
  } catch (error) {
    sendSourceError(res, error, 'Failed to add that order');
  }
});

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

    const resolved = await flagAgainstCatalogue(cards);

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

    // ONE TRANSACTION FOR THE WHOLE PRODUCT, via the shared helper.
    //
    // Zach: "it takes way to long to add a deck. Why is it inserting 1 card at
    // a time? Shouldnt it be bulk inserting." Right that it was slow, but
    // MEASURED the cost was never the INSERT:
    //
    //   72 inserts, a transaction each :    12 ms
    //   72 inserts, one transaction    :     3 ms
    //   the real HTTP request          : 14,034 ms
    //
    // Every db call goes through a serialized queue and every
    // addCardToCollection opened its own transaction, so each card queued and
    // committed separately. Bulk INSERT syntax would have saved 9ms of a 14s
    // wait. Measured after: 0.37s.
    //
    // A sealed product is new cardboard, so every card is Near Mint. An ORDER
    // is different -- it carries the condition he actually bought.
    const { added, failed } = await addCardsInOneTransaction(
      req.user,
      chosen.map((c) => ({ ...c, condition: 'Near Mint' })),
    );

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
