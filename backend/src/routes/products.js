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
//
// `descriptor` names WHAT is being added (kind, product id, name, set code).
// It is required, and the ledger row is written in THIS transaction with the
// cards, so the two can never disagree: either both land or neither does.
async function addCardsInOneTransaction(user, cards, descriptor) {
  const added = [];
  const failed = [];
  let ledger = null;
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
    // INSIDE the transaction, after the cards. A ledger row committed while the
    // card inserts rolled back would be a lie in the exact place he goes to
    // find the truth.
    ledger = await recordImport(user, descriptor, added);
  }, { timeoutMs: 120000 });
  return { added, failed, ledger };
}

// RECORD THE IMPORT, INSIDE THE SAME TRANSACTION AS THE CARDS.
//
// Zach: "I have 2 more I want to add but I am unsure if I added them or not."
// Before this, the product identity was discarded the moment the cards landed.
//
// WHY THIS LIVES NEXT TO addCardsInOneTransaction AND IS CALLED BY IT, not by
// each route: there are two paths to the same write (precons and Mana Pool
// orders), and the skill's own lesson from the repoint bug is that fixing one
// caller and leaving the other produces a feature that is silently half-there.
// A route cannot add cards without also writing the ledger row, because it
// never calls the adder directly.
//
// The row is written only when at least one card actually landed. An import
// that failed entirely is not history, it is a failed attempt -- logging it
// would answer "did I add this?" with YES for a product he does not own.
async function recordImport(user, descriptor, added) {
  const cardsAdded = added.reduce((n, a) => n + a.quantity, 0);
  if (!cardsAdded) return null;
  const result = await db.run(
    `INSERT INTO import_ledger
       (user_id, kind, product_id, product_name, set_code, cards_added, rows_added, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'import')`,
    [user.id, descriptor.kind, descriptor.productId ?? null, descriptor.productName,
     descriptor.setCode ?? null, cardsAdded, added.length]
  );
  return { id: result.lastID, cardsAdded, rowsAdded: added.length };
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
    const { added, failed, ledger } = await addCardsInOneTransaction(req.user, chosen, {
      kind: 'order',
      productId: String(order.id),
      productName: `Order ${order.orderNumber}`,
      setCode: null,
    });

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

// ===========================================================================
// THE IMPORT LEDGER
//
// Zach: "tracking for what precon's I added to my collection. Because right now
// I have 2 more I want to add but I am unsure if I added them or not."
//
// DECLARED BEFORE THE PARAMETERISED PRODUCT ROUTES. `/:id/cards` matches
// `/ledger/anything` and `GET /:id` would match `/ledger` outright. This file
// has already shipped that exact bug once -- every Mana Pool orders request was
// swallowed by the precon handler looking for a product named "orders", a fully
// built feature that was 0% reachable. Specific literal paths first, always.
// ===========================================================================

// WHAT HAVE I ADDED. Newest first, because the question is always about recent
// history.
router.get('/ledger', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT id, kind, product_id AS productId, product_name AS productName,
              set_code AS setCode, cards_added AS cardsAdded,
              rows_added AS rowsAdded, source, note, added_at AS addedAt
         FROM import_ledger
        WHERE user_id = ?
        ORDER BY added_at DESC, id DESC`,
      [req.user.id]
    );
    res.json({ entries: rows, total: rows.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to read the import history' });
  }
});

// HAND-ENTER SOMETHING ALREADY ADDED.
//
// He said he can list the precons he added before this existed. A backfilled
// row is HIS MEMORY, not our evidence, so it is stored with source='manual' and
// the UI must show that difference. Collapsing the two would turn a recollection
// into a system record.
//
// This writes NO CARDS. It is a note that an import happened, nothing more --
// which is why it cannot silently duplicate a real collection.
router.post('/ledger', async (req, res) => {
  const { product_name: productName, kind, set_code: setCode,
          cards_added: cardsAdded, note, added_at: addedAt } = req.body || {};
  const name = typeof productName === 'string' ? productName.trim() : '';
  if (!name) {
    return res.status(400).json({ error: 'product_name is required' });
  }
  const allowedKinds = new Set(['precon', 'secretlair', 'order', 'other']);
  const entryKind = allowedKinds.has(kind) ? kind : 'precon';
  try {
    const result = await db.run(
      `INSERT INTO import_ledger
         (user_id, kind, product_id, product_name, set_code, cards_added,
          rows_added, source, note, added_at)
       VALUES (?, ?, NULL, ?, ?, ?, 0, 'manual', ?, COALESCE(?, CURRENT_TIMESTAMP))`,
      [req.user.id, entryKind, name, setCode || null,
       Number.isFinite(cardsAdded) ? cardsAdded : 0,
       typeof note === 'string' ? note : '',
       addedAt || null]
    );
    res.status(201).json({ id: result.lastID, productName: name, source: 'manual' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to record that import' });
  }
});

// REMOVE A LEDGER ENTRY. Mistyped backfill, or an import he wants to disown.
// Deleting the note does NOT touch the cards -- the collection is a separate
// fact and removing history must never silently remove cardboard.
router.delete('/ledger/:entryId', async (req, res) => {
  try {
    const result = await db.run(
      `DELETE FROM import_ledger WHERE id = ? AND user_id = ?`,
      [req.params.entryId, req.user.id]
    );
    if (!result.changes) return res.status(404).json({ error: 'No such entry' });
    res.json({ deleted: result.changes });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete that entry' });
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
    const { added, failed, ledger } = await addCardsInOneTransaction(
      req.user,
      chosen.map((c) => ({ ...c, condition: 'Near Mint' })),
      {
        kind: product.kind,
        productId: product.id,
        productName: product.name,
        setCode: product.setCode,
      },
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
