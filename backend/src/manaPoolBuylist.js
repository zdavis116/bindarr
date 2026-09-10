// CHOOSING WHICH PRINTING TO BUY.
//
// This file used to send buylists to Mana Pool's optimizer and create orders.
// Both are gone, at Zach's call: "I also feel like the price it isn't worth it
// either. Because you are preparing it for nothing."
//
// He was right, and the measurements agreed:
//
//   * POST /buyer/orders/pending-orders creates a CHECKOUT, not a cart -- the
//     response carries a paymentIntent and the only way to finish it is
//     /purchase, which spends real money. His actual cart stayed empty.
//   * Mana Pool exposes NO cart API. /buyer/cart, /cart, /buyer/basket and
//     /buyer/carts are all 404, and GET /pending-orders is 405.
//   * the optimizer took ~40 seconds and was rate limited to ~3 calls/minute,
//     to answer a question Bindarr can answer instantly from the prices it
//     already refreshes every 6 hours.
//
// What survives is the part that was always Bindarr's job: given a card he is
// willing to substitute, pick the cheapest printing HE would accept, and be
// able to say what was swapped.

const CONDITION_IDS = ['LP', 'NM'];
const LANGUAGE_IDS = ['EN'];

const FINISH_ID = { nonfoil: 'NF', foil: 'FO', etched: 'EF' };

class ManaPoolAuthError extends Error {}
class ManaPoolRateLimitError extends Error {}
class ManaPoolStockError extends Error {
  constructor(message, unavailable) { super(message); this.unavailable = unavailable; }
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
  chooseCheapestPrinting,
  CONDITION_IDS,
  LANGUAGE_IDS,
};
