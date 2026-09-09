// SENDING A BUYLIST TO MANA POOL.
//
// Zach: "being able to send buy list to mana pool" -- then, once the numbers
// were measured: "I assume the 3 calls/min wont be problem if we are just doing
// 1 buylist at a time."
//
// WHY THIS EXISTS SEPARATELY FROM CARD PRICES. A card's price is a property of
// a card: cheapest LP/NM English listing, from the variants feed, item only.
// DELIVERED cost is a property of an ORDER -- three cards from one seller ship
// once, from three sellers ship three times. Measured on a real three-card cart:
//
//   lowest_price     items $65.96 + ship $4.05 = $72.78   3 sellers
//   fewest_packages  items $78.97 + ship $0.00 = $82.29   1 seller
//
// Neither is "right"; they are different trades. That is why this is an action
// he takes, not a number on a screen.
//
// FOUR THINGS THE PUBLISHED SCHEMA GOT WRONG, all found by calling it:
//
//   1. It declares no auth. The endpoint returns 401 without a key.
//   2. It describes cart lines as {type, name, card_id, quantity}. The live API
//      demands language_ids[], finish_ids[], condition_ids[], quantity_requested.
//   3. card_id (a Scryfall printing id) returns 409 "no_candidates" even for a
//      Sol Ring everyone stocks. set_code + collector_number works.
//   4. The response is NDJSON -- a stream of improving solutions, one per line.
//      JSON.parse() on the whole body throws. The last line is the answer.
//      (This one cost an hour: my error handler swallowed the throw and every
//      total read $0.00, which looked like an API fault rather than my bug.)
const https = require('https');

const HOST = 'manapool.com';
const PATH = '/api/v1/buyer/optimizer';

// Mana Pool's own limit, measured: the 4th call in a burst returns 429 and no
// rate-limit headers are advertised. One buylist is one call, so this only
// matters if something loops.
const MIN_CALL_SPACING_MS = 21000;
let lastCallAt = 0;

// Conditions Zach accepts, sent to the marketplace rather than filtered after.
// Same floor as the price import: LP or NM, nothing below.
const CONDITION_IDS = ['LP', 'NM'];
const LANGUAGE_IDS = ['EN'];

const FINISH_ID = { nonfoil: 'NF', foil: 'FO', etched: 'EF' };

class ManaPoolAuthError extends Error {}
class ManaPoolRateLimitError extends Error {}
class ManaPoolStockError extends Error {
  constructor(message, unavailable) { super(message); this.unavailable = unavailable; }
}

function credentials() {
  const email = process.env.MANAPOOL_EMAIL;
  const token = process.env.MANAPOOL_API_KEY;
  if (!email || !token) {
    throw new ManaPoolAuthError(
      'Mana Pool credentials are not configured on this server');
  }
  return { email, token };
}

function isConfigured() {
  return Boolean(process.env.MANAPOOL_EMAIL && process.env.MANAPOOL_API_KEY);
}

// One cart line per card Bindarr wants priced.
//
// IDENTIFIED BY SET CODE + COLLECTOR NUMBER, not by Scryfall id: card_id 409s
// on this endpoint even for cards that are demonstrably in stock. Bindarr has
// both fields for every card, so this costs nothing.
//
// EXACT PRINTING BY DEFAULT, WIDENED ONLY WHEN HE SAYS SO.
//
// Zach: "I would like the ability to specify each card for exact printing or
// not. Because I get a different number when doing any printing."
//
// Sending set_code + collector_number pins the printing. Sending card_id alone
// lets Mana Pool substitute any interchangeable printing -- which is cheaper,
// and is the right trade for a Sol Ring but not for a card he chose for its
// art. The default stays exact because a substitution he did not ask for
// arrives as the wrong cardboard.
//
// NOTE the asymmetry: card_id does not work as an EXACT identifier on this
// endpoint (it 409s), but it is the only way to express "any printing". So the
// two modes genuinely use different fields.
function toCartLine(card) {
  const finish = FINISH_ID[card.finish || 'nonfoil'] || 'NF';
  const base = {
    type: 'mtg_single',
    quantity_requested: Math.max(1, Number(card.quantity) || 1),
    language_ids: LANGUAGE_IDS,
    finish_ids: [finish],
    condition_ids: CONDITION_IDS,
  };
  if (card.allow_any_printing && card.card_id) {
    // Any interchangeable printing. Requires the Scryfall id, which Bindarr
    // always has for a deck card.
    return { ...base, card_id: card.card_id };
  }
  return {
    ...base,
    set_code: String(card.set_code || '').toUpperCase(),
    collector_number: String(card.collector_number),
  };
}

function requestTo(path, body) {
  const { email, token } = credentials();
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-ManaPool-Email': email,
        'X-ManaPool-Access-Token': token,
        'User-Agent': 'Bindarr/1.0 (self-hosted collection manager)',
      },
      timeout: 120000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Mana Pool request timed out')); });
    req.end(payload);
  });
}

// NDJSON: a stream of improving solutions. Take the last COMPLETE object.
//
// Parsed defensively because a truncated final line is possible on a stream --
// returning the best complete solution is right, and silently returning a
// half-parsed one is not.
function parseSolutionStream(data) {
  const out = [];
  for (const raw of String(data).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* incomplete line, ignore */ }
  }
  return out.length ? out[out.length - 1] : null;
}

/**
 * Price a basket of cards as one order.
 *
 * `cards`: [{ set_code, collector_number, finish, quantity, name }]
 * `model`: lowest_price | fewest_packages | balanced | gathered_shipping_only
 */
async function priceBuylist(cards, { model = 'lowest_price' } = {}) {
  if (!Array.isArray(cards) || cards.length === 0) {
    throw new Error('Nothing to price');
  }
  // Mana Pool's documented cart ceiling.
  if (cards.length > 2000) {
    throw new Error(`Too many lines for one order: ${cards.length} (max 2000)`);
  }

  const since = Date.now() - lastCallAt;
  if (since < MIN_CALL_SPACING_MS) {
    await new Promise(r => setTimeout(r, MIN_CALL_SPACING_MS - since));
  }
  lastCallAt = Date.now();

  const { status, data } = await requestTo(PATH, {
    cart: cards.map(toCartLine),
    model,
    destination_country: 'US',
  });

  if (status === 401 || status === 403) {
    throw new ManaPoolAuthError('Mana Pool rejected the API key');
  }
  if (status === 429) {
    throw new ManaPoolRateLimitError(
      'Mana Pool is rate limiting us; try again in a minute');
  }
  if (status === 409) {
    // NOT SILENTLY DROPPED. A buylist that quietly omits the cards nobody
    // stocks would be the worst version of this feature: he would order,
    // receive less than he asked for, and only notice against cardboard.
    let details = [];
    try { details = JSON.parse(data)?.details || []; } catch { /* keep empty */ }
    const unavailable = details.map((d) => ({
      set_code: d?.item?.set_code || null,
      collector_number: d?.item?.collector_number || null,
      index: d?.item?.index ?? null,
      reason: d?.reason || 'no_candidates',
      available: d?.total_available ?? 0,
    }));
    throw new ManaPoolStockError(
      'Mana Pool has no stock for some of these cards', unavailable);
  }
  if (status !== 200) {
    let msg = `Mana Pool returned HTTP ${status}`;
    try {
      const body = JSON.parse(data);
      if (body?.message) msg = `${msg}: ${body.message}`;
      if (Array.isArray(body?.details)) msg += ` (${body.details.slice(0, 3).join('; ')})`;
    } catch { /* keep the status-only message */ }
    throw new Error(msg);
  }

  const solution = parseSolutionStream(data);
  if (!solution || !solution.totals) {
    throw new Error('Mana Pool returned no usable solution');
  }

  const t = solution.totals;
  return {
    model,
    lines: cards.length,
    // Cents in, dollars out, converted once at this boundary.
    items: (t.subtotal_cents || 0) / 100,
    shipping: (t.shipping_cents || 0) / 100,
    buyerFee: (t.buyer_fee_cents || 0) / 100,
    gatheredFee: (t.gathered_fee_cents || 0) / 100,
    total: (t.total_cents || 0) / 100,
    sellerCount: t.seller_count ?? null,
    // The cart Mana Pool would build. Kept so a future "open this cart on their
    // site" step has something real to hand over.
    cart: solution.cart || [],
  };
}

/**
 * Turn a priced solution into a real pending order on Mana Pool.
 *
 * Zach: "is there a way to send my choice to mana pool and have it go to cart?"
 *
 * The optimizer already returns exactly what the order endpoint wants --
 * { inventory_id, quantity_selected } per line -- so this hands over the cart it
 * just chose rather than re-deriving one. Re-deriving would risk ordering a
 * different set of listings than the ones he was quoted.
 *
 * DELIBERATELY STOPS AT THE PENDING ORDER. There is a
 * POST /buyer/orders/pending-orders/{id}/purchase that would complete the sale,
 * and Bindarr will not call it. A bug in a hobby app that can spend real money
 * costs money, not a recount. He reviews and pays on Mana Pool's own site.
 */
async function sendToCart(cartLines) {
  if (!Array.isArray(cartLines) || cartLines.length === 0) {
    throw new Error('Nothing to send');
  }
  const line_items = cartLines
    .filter(l => l && l.inventory_id && l.quantity_selected > 0)
    .map(l => ({
      inventory_id: l.inventory_id,
      quantity_selected: l.quantity_selected,
    }));
  if (line_items.length === 0) {
    throw new Error('The quote contained no purchasable lines');
  }

  const since = Date.now() - lastCallAt;
  if (since < MIN_CALL_SPACING_MS) {
    await new Promise(r => setTimeout(r, MIN_CALL_SPACING_MS - since));
  }
  lastCallAt = Date.now();

  const { status, data } = await requestTo('/buyer/orders/pending-orders', { line_items });

  if (status === 401 || status === 403) {
    throw new ManaPoolAuthError('Mana Pool rejected the API key');
  }
  if (status === 429) {
    throw new ManaPoolRateLimitError('Mana Pool is rate limiting us; try again in a minute');
  }
  if (status !== 200 && status !== 201) {
    let msg = `Mana Pool returned HTTP ${status}`;
    try {
      const body = JSON.parse(data);
      if (body?.message) msg = `${msg}: ${body.message}`;
      if (Array.isArray(body?.details)) msg += ` (${body.details.slice(0, 3).join('; ')})`;
    } catch { /* keep the status-only message */ }
    throw new Error(msg);
  }

  let order;
  try { order = JSON.parse(data); } catch { order = null; }
  if (!order?.id) throw new Error('Mana Pool did not return an order id');

  const t = order.totals || {};
  return {
    orderId: order.id,
    status: order.status || null,
    lines: line_items.length,
    items: (t.subtotal_cents || 0) / 100,
    shipping: (t.shipping_cents || 0) / 100,
    total: (t.total_cents || 0) / 100,
    // Where he goes to review and pay. Built from the order id rather than
    // guessed at: a wrong link on a money screen is worse than no link.
    url: `https://manapool.com/orders/${order.id}`,
  };
}

module.exports = {
  priceBuylist,
  sendToCart,
  isConfigured,
  parseSolutionStream,
  toCartLine,
  CONDITION_IDS,
  LANGUAGE_IDS,
  ManaPoolAuthError,
  ManaPoolRateLimitError,
  ManaPoolStockError,
};
