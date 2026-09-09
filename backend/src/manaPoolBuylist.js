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
// Every path is built from this ONE base. A caller passed '/buyer/...' without
// the /api/v1 prefix and got a 404 that read as "the endpoint does not exist" --
// two ways to spell a path is one too many.
const API_BASE = '/api/v1';
const OPTIMIZER_PATH = '/buyer/optimizer';
const PENDING_ORDER_PATH = '/buyer/orders/pending-orders';

// Mana Pool's own limit, measured: the 4th call in a burst returns 429 and no
// rate-limit headers are advertised.
//
// THIS IS A CEILING, NOT A DELAY TO PAY UP FRONT. The first version slept 21s
// before EVERY call, including the first one after minutes of idle -- so a
// 39-second solve became a 60-second request and Zach's phone gave up with
// "load failed" before the answer arrived. Now it only waits when calls are
// genuinely close together.
const MIN_CALL_SPACING_MS = 21000;
let lastCallAt = 0;

// How long we are willing to make a person wait before saying so plainly.
// Mana Pool's optimizer takes ~40s on a 49-card cart; browsers and phones give
// up silently well before a minute, which reads as "broken" rather than "slow".
const SOLVE_TIMEOUT_MS = 115000;

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
// ALWAYS IDENTIFIED BY SET CODE + COLLECTOR NUMBER.
//
// card_id does not work on this endpoint AT ALL. Measured on An Offer You Can't
// Refuse (FDN #160), a card Mana Pool demonstrably stocks:
//
//   set_code + collector_number  -> 200, $2.59
//   card_id = Scryfall printing id -> 409 no_candidates
//   card_id = Scryfall oracle id   -> 409 no_candidates
//
// So the schema's documented route to substitution ("card_id ... any
// interchangeable printing may be substituted") is unusable. Every line is
// therefore an EXACT printing at the API boundary.
//
// "ANY PRINTING" IS RESOLVED BEFORE WE GET HERE, in chooseCheapestPrinting(),
// using the price data Bindarr already holds for every printing. That is
// strictly better than delegating it: Bindarr can apply Zach's LP/NM floor and
// tell him exactly WHICH printing it swapped to, rather than being surprised by
// whatever the marketplace picked.
function toCartLine(card) {
  const finish = FINISH_ID[card.finish || 'nonfoil'] || 'NF';
  return {
    type: 'mtg_single',
    set_code: String(card.set_code || '').toUpperCase(),
    collector_number: String(card.collector_number),
    quantity_requested: Math.max(1, Number(card.quantity) || 1),
    language_ids: LANGUAGE_IDS,
    finish_ids: [finish],
    condition_ids: CONDITION_IDS,
  };
}

function requestTo(path, body) {
  const { email, token } = credentials();
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, path: `${API_BASE}${path}`, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-ManaPool-Email': email,
        'X-ManaPool-Access-Token': token,
        'User-Agent': 'Bindarr/1.0 (self-hosted collection manager)',
      },
      timeout: SOLVE_TIMEOUT_MS,
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

  // Wait only if the PREVIOUS call finished recently. Stamping the time before
  // a 40-second solve made every follow-up wait as though the solve had been
  // instant, stacking 21s of throttle onto a request that was already slow.
  const since = Date.now() - lastCallAt;
  if (lastCallAt && since < MIN_CALL_SPACING_MS) {
    await new Promise(r => setTimeout(r, MIN_CALL_SPACING_MS - since));
  }

  const { status, data } = await requestTo(OPTIMIZER_PATH, {
    cart: cards.map(toCartLine),
    model,
    destination_country: 'US',
  });
  lastCallAt = Date.now();

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
async function sendToCart(cartLines, shippingAddress) {
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
  if (lastCallAt && since < MIN_CALL_SPACING_MS) {
    await new Promise(r => setTimeout(r, MIN_CALL_SPACING_MS - since));
  }

  if (!shippingAddress?.line1) {
    throw new Error('A shipping address is required to create an order');
  }
  const { status, data } = await requestTo(PENDING_ORDER_PATH, {
    line_items,
    shipping_address: shippingAddress,
  });

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

  lastCallAt = Date.now();

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
    // WHERE HE GOES TO REVIEW AND PAY.
    //
    // /cart is the real page and it resolves (200). I first built
    // manapool.com/orders/<id> from the order id, which looked plausible and
    // 404s -- a dead link on a money screen is worse than no link, and I only
    // caught it by fetching the URL rather than trusting the shape.
    //
    // The pending order is attached to his account, so the cart page shows it.
    url: 'https://manapool.com/cart',
    // Kept for support: the order IS retrievable through the API by id even
    // though there is no public page for it.
    orderApiPath: `/api/v1/buyer/orders/pending-orders/${order.id}`,
  };
}

// SUBSTITUTE THE CHEAPEST PRINTING, WHERE HE ALLOWED IT.
//
// Zach: "Some cards I would be fine with a substitute and some I wouldn't."
//
// Done in Bindarr rather than by the marketplace because card_id -- the API's
// only substitution mechanism -- returns 409 for every value tested. But doing
// it here is better anyway:
//
//   * it obeys his LP/NM floor, which a marketplace substitution would not
//   * it can SAY which printing it swapped to, so the buylist he reads matches
//     the cardboard that arrives
//   * it uses prices Bindarr already refreshed, so it costs no API call
//
// Only ever applied to lines he explicitly unlocked. A line left exact is sent
// exactly as the deck specifies.
async function chooseCheapestPrinting(database, card) {
  if (!card.allow_any_printing || !card.card_id) return card;

  // Every printing of the same card that Mana Pool stocks, cheapest first.
  // Joined on oracle_id: that is what "another printing of this card" means.
  const rows = await database.all(
    `SELECT cc.id, cc.set_id, cc.number, sp.price_cents, sp.price_cents_foil,
            sp.condition, sp.condition_foil
       FROM card_cache cc
       JOIN source_prices sp
         ON sp.card_id = cc.id AND sp.source = 'manapool'
      WHERE cc.oracle_id = (SELECT oracle_id FROM card_cache WHERE id = ?)`,
    [card.card_id]
  );

  const wantFoil = card.finish === 'foil' || card.finish === 'etched';
  const priced = rows
    .map(r => ({
      set_code: r.set_id,
      collector_number: r.number,
      cents: wantFoil ? r.price_cents_foil : r.price_cents,
      condition: wantFoil ? r.condition_foil : r.condition,
    }))
    .filter(r => Number.isFinite(r.cents) && r.cents > 0)
    .sort((a, b) => a.cents - b.cents);

  // NO CHEAPER OPTION IS NOT AN ERROR. If nothing is stocked, keep the exact
  // printing and let the optimizer answer for it -- silently dropping the line
  // would be far worse.
  if (priced.length === 0) return card;

  const best = priced[0];
  return {
    ...card,
    set_code: best.set_code,
    collector_number: best.collector_number,
    // Reported so the UI can show the swap. A substitution he cannot see is the
    // silent state change he has ruled out.
    substituted_from: (card.set_code !== best.set_code
                    || String(card.collector_number) !== String(best.collector_number))
      ? { set_code: card.set_code, collector_number: card.collector_number }
      : null,
    substituted_price: best.cents / 100,
    substituted_condition: best.condition,
  };
}

module.exports = {
  priceBuylist,
  sendToCart,
  chooseCheapestPrinting,
  isConfigured,
  parseSolutionStream,
  toCartLine,
  CONDITION_IDS,
  LANGUAGE_IDS,
  ManaPoolAuthError,
  ManaPoolRateLimitError,
  ManaPoolStockError,
};
