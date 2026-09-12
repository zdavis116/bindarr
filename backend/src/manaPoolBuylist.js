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

// SUBSTITUTE THE CHEAPEST PRINTING, FOR A WHOLE BUYLIST AT ONCE.
//
// Zach: "Some cards I would be fine with a substitute and some I wouldn't."
//
// ONE QUERY FOR THE WHOLE LIST, not one per card. The first version called this
// per card inside a loop, and db.js serialises every query through a single
// operation queue -- so a 49-card estimate meant 49 sequential round trips and
// took 41 seconds. That is the same mistake that made /api/stats take 26s during
// a catalogue refresh, made twice.
//
// Done in Bindarr rather than by the marketplace because Mana Pool's card_id
// substitution field returns 409 for every value tested (printing id AND oracle
// id). Doing it here is better anyway:
//
//   * it obeys his LP/NM floor, which a marketplace substitution would not
//   * it can SAY which printing it swapped to, so the list he pastes matches
//     the cardboard that arrives
//   * it uses prices Bindarr already refreshed, so it costs no API call
//
// Only applied to lines he left flexible. A pinned line is returned untouched.
async function chooseCheapestPrintings(database, cards, sourceId = 'manapool') {
  // WHICH SHOP THIS LIST IS PRICED AT.
  //
  // Each export tab prices itself at its OWN shop -- Zach: "export buylist
  // wouldn't change" when the valuation source became a selection. A Card
  // Kingdom list has to cost Card Kingdom money regardless of which shop he
  // values his binder at, or the total he reads is for a cart he is not
  // building.
  //
  // Validated against a known set rather than interpolated: this goes into SQL.
  const source = ['manapool', 'cardkingdom'].includes(sourceId) ? sourceId : 'manapool';
  const flexible = cards.filter(c => c.allow_any_printing && c.card_id);
  if (flexible.length === 0) return cards;

  const ids = [...new Set(flexible.map(c => c.card_id))];

  // TWO SIMPLE QUERIES, NOT ONE THREE-WAY JOIN.
  //
  // The join version took 5,174ms because SQLite chose to drive from
  // source_prices -- 98,000 rows -- rather than from the 49 cards actually
  // wanted, and neither a covering index nor INDEXED BY would move it. Resolving
  // the oracle ids first and then fetching their printings costs 101ms for the
  // identical 1,507 rows. Measured, not reasoned about.
  const wants = await database.all(
    `SELECT id, oracle_id FROM card_cache WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  const oracleOf = new Map(wants.map(w => [w.id, w.oracle_id]));
  const oracles = [...new Set(wants.map(w => w.oracle_id).filter(Boolean))];
  if (oracles.length === 0) return cards;

  const rows = await database.all(
    `SELECT cc.oracle_id, cc.set_id, cc.number,
            sp.price_cents, sp.price_cents_foil, sp.condition, sp.condition_foil
       FROM card_cache cc
       JOIN source_prices sp
         ON sp.card_id = cc.id AND sp.source = '${source}'
      WHERE cc.oracle_id IN (${oracles.map(() => '?').join(',')})`,
    oracles
  );

  const byOracle = new Map();
  for (const r of rows) {
    if (!byOracle.has(r.oracle_id)) byOracle.set(r.oracle_id, []);
    byOracle.get(r.oracle_id).push(r);
  }

  return cards.map((card) => {
    if (!card.allow_any_printing || !card.card_id) return card;
    const oracle = oracleOf.get(card.card_id);
    const wantFoil = card.finish === 'foil' || card.finish === 'etched';
    const priced = (byOracle.get(oracle) || [])
      .map(r => ({
        set_code: r.set_id,
        collector_number: r.number,
        cents: wantFoil ? r.price_cents_foil : r.price_cents,
        condition: wantFoil ? r.condition_foil : r.condition,
      }))
      .filter(r => Number.isFinite(r.cents) && r.cents > 0)
      .sort((a, b) => a.cents - b.cents);

    // NO CHEAPER OPTION IS NOT AN ERROR. If nothing is stocked, keep the exact
    // printing -- silently dropping the line would be far worse.
    if (priced.length === 0) return card;

    const best = priced[0];
    return {
      ...card,
      set_code: best.set_code,
      collector_number: best.collector_number,
      // Reported so the UI can show the swap. A substitution he cannot see is
      // the silent state change he has ruled out.
      substituted_from: (card.set_code !== best.set_code
                      || String(card.collector_number) !== String(best.collector_number))
        ? { set_code: card.set_code, collector_number: card.collector_number }
        : null,
      substituted_price: best.cents / 100,
      substituted_condition: best.condition,
    };
  });
}

module.exports = {
  chooseCheapestPrintings,
  CONDITION_IDS,
  LANGUAGE_IDS,
};
