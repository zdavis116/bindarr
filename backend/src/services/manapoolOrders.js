// MANA POOL BUYER ORDERS -> COLLECTION.
//
// Zach: "adding cards to my collection through like precons, secret lair drops
// and my orders on manapool ... those lists are exactly what I would scan so
// would save me time."
//
// THIS IS A DOCUMENTED, SUPPORTED API, unlike the undocumented deck endpoint
// the compare screen scrapes. Read off the real OpenAPI spec at
// https://manapool.com/api/docs/v1/openapi.json (2026-09-21):
//
//   GET /buyer/orders          -> { orders: [{ id, order_number, created_at,
//                                   total_cents, order_seller_details: [...] }] }
//   GET /buyer/orders/{id}     -> { order: { ..., order_seller_details: [
//                                   { seller_username, items: [...] } ] } }
//
// THE LIST CARRIES NO CARDS. It has totals and an item_count only, so the
// cards come from the detail call per order. Do not try to shortcut this.
//
// Auth is two headers, both required:
//   X-ManaPool-Email         his account email
//   X-ManaPool-Access-Token  a token he generates, shaped mpat_...
//
// FIELD NAMES ARE COPIED FROM THE SPEC, NOT GUESSED. Three earlier bugs on this
// feature came from inventing plausible field names; every name below appears
// in the schema dump.

const MANAPOOL_API = 'https://manapool.com/api/v1';
const FETCH_TIMEOUT_MS = 20000;

// Mana Pool's own enums -> Bindarr's stored values.
//
// Condition: Zach chose "use the real condition from the order -- NM, LP, MP,
// HP, DMG as bought", unlike precons which are always Near Mint because a
// sealed product is new cardboard.
const CONDITION_BY_ID = {
  NM: 'Near Mint',
  LP: 'Lightly Played',
  MP: 'Moderately Played',
  HP: 'Heavily Played',
  DMG: 'Damaged',
  // "UC" is Mana Pool's ungraded/unspecified. Near Mint would be a flattering
  // guess about a card he can see and I cannot; Lightly Played is his stated
  // floor, so it is the honest default.
  UC: 'Lightly Played',
};

// Finish: NF nonfoil, FO foil, EF etched. Same canonical values the rest of the
// app uses, so this feeds addCardToCollection unchanged.
const FINISH_BY_ID = { NF: 'nonfoil', FO: 'foil', EF: 'etched' };

class ManaPoolAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManaPoolAuthError';
    this.status = 401;
    this.code = 'MANAPOOL_AUTH';
  }
}

class ManaPoolOrdersError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ManaPoolOrdersError';
    this.status = 502;
    this.code = 'MANAPOOL_UNAVAILABLE';
    this.cause = cause;
  }
}

async function callApi(path, { email, token }) {
  if (!email || !token) {
    throw new ManaPoolAuthError(
      'Add your Mana Pool email and API token in Settings first.');
  }
  let res;
  try {
    res = await fetch(`${MANAPOOL_API}${path}`, {
      headers: {
        'X-ManaPool-Email': email,
        'X-ManaPool-Access-Token': token,
        Accept: 'application/json',
        'User-Agent': 'Bindarr/1.0 (+https://github.com/zdavis116/bindarr)',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ManaPoolOrdersError('Could not reach Mana Pool.', error);
  }

  // A BAD TOKEN MUST NOT LOOK LIKE AN EMPTY ORDER HISTORY. They are different
  // problems with different fixes, and "you have no orders" would send him
  // looking in the wrong place entirely.
  if (res.status === 401 || res.status === 403) {
    throw new ManaPoolAuthError(
      'Mana Pool rejected your email or API token. Check them in Settings.');
  }
  if (!res.ok) {
    throw new ManaPoolOrdersError(`Mana Pool returned ${res.status}.`);
  }
  try {
    return await res.json();
  } catch (error) {
    throw new ManaPoolOrdersError('Mana Pool sent something that was not JSON.', error);
  }
}

/**
 * The buyer's orders, newest first. Summary only -- no cards.
 */
async function listOrders(creds, { limit = 25 } = {}) {
  const body = await callApi(`/buyer/orders?limit=${encodeURIComponent(limit)}`, creds);
  const orders = Array.isArray(body?.orders) ? body.orders : [];
  return orders.map((o) => ({
    id: o.id,
    orderNumber: o.order_number,
    createdAt: o.created_at,
    totalCents: o.total_cents,
    // One Mana Pool order can span several sellers, each shipping separately.
    sellers: (o.order_seller_details || []).map((s) => s.seller_username).filter(Boolean),
    itemCount: (o.order_seller_details || [])
      .reduce((n, s) => n + (s.item_count || 0), 0),
  }));
}

/**
 * One order's cards, normalised into the shape the product import already uses.
 *
 * WHAT SHIPPED, NOT WHAT WAS ORDERED. Zach: "Only what actually shipped --
 * don't add refunded/missing cards." An order can be partly refunded or
 * replaced, and `shipped_quantity` is the count that physically arrived. Adding
 * the ordered quantity would put cards in his collection that a seller never
 * sent, which is worse than the scanning this replaces because he would not
 * notice.
 */
async function fetchOrderCards(orderId, creds) {
  const body = await callApi(`/buyer/orders/${encodeURIComponent(orderId)}`, creds);
  const order = body?.order;
  if (!order) throw new ManaPoolOrdersError('That order came back empty.');

  const cards = [];
  const skipped = [];

  for (const seller of (order.order_seller_details || [])) {
    for (const item of (seller.items || [])) {
      const product = item.product || {};
      const single = product.single;

      // A SEALED PRODUCT IN AN ORDER IS A BOX, NOT CARDS. It carries an
      // mtgjson_id that resolves to a card list through the precon path, but
      // that is a different flow: silently expanding a sealed deck into 100
      // loose cards would be a decision he did not make.
      if (product.product_type === 'mtg_sealed' || !single) {
        skipped.push({
          name: product.sealed?.name || 'Sealed product',
          reason: 'sealed',
          // What ARRIVED, like every other count here. Falling back to the
          // ordered quantity would report "1x sealed deck skipped" for a box
          // that was refunded and never sent.
          quantity: item.shipped_quantity ?? 0,
        });
        continue;
      }

      // Only what actually arrived.
      const shipped = item.shipped_quantity ?? 0;
      if (shipped <= 0) {
        skipped.push({
          name: single.name,
          reason: 'not shipped',
          quantity: item.quantity || 0,
        });
        continue;
      }

      cards.push({
        scryfallId: single.scryfall_id || null,
        name: single.name,
        setCode: single.set || '',
        number: single.number || '',
        // From the DATA, never inferred from a name.
        finish: FINISH_BY_ID[single.finish_id] || 'nonfoil',
        condition: CONDITION_BY_ID[single.condition_id] || 'Lightly Played',
        language: single.language_id || 'EN',
        quantity: shipped,
        // WHAT HE ACTUALLY PAID, per card. He asked for this: "Yes -- record
        // what I paid per card." price_cents is the LINE price for the item, so
        // divide by the ordered quantity to get a per-card figure, then store
        // it in dollars because that is what the collection column holds.
        unitPrice: item.quantity
          ? (item.price_cents / item.quantity) / 100
          : (item.price_cents || 0) / 100,
        sellerUsername: seller.seller_username || null,
      });
    }
  }

  return {
    order: {
      id: order.id,
      orderNumber: order.order_number,
      createdAt: order.created_at,
      totalCents: order.total_cents,
    },
    cards,
    skipped,
    totalCards: cards.reduce((n, c) => n + c.quantity, 0),
  };
}

module.exports = {
  listOrders,
  fetchOrderCards,
  ManaPoolAuthError,
  ManaPoolOrdersError,
  // exported for tests
  CONDITION_BY_ID,
  FINISH_BY_ID,
};
