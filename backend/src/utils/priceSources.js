// WHERE A PRICE COMES FROM: ONE CHOSEN SHOP, PLUS A FLOOR.
//
// This began as a ranked list, at Zach's original request. He changed it after
// living with it: "I would like to get rid of the priority list and it be a
// selection whether I used mana pool or card kingdom but the fallback is always
// scryfall since it's an average."
//
// He is right, and the measurements back him up. A ranking implied the sources
// were interchangeable rungs of one ladder. They are not -- they are different
// SHOPS with different price floors:
//
//   most common Card Kingdom price   $0.35 x1584
//   most common Mana Pool price      $0.15 x2225
//
// His collection is $2461 at Card Kingdom and $1319 at Mana Pool, and 61% of
// that $1142 gap is bulk commons sitting on each shop's minimum price. Neither
// number is wrong. But a ranked chain would have blended them -- most cards at
// Mana Pool's floor, a handful at Card Kingdom's -- producing a total that is
// the price at NO shop and cannot be checked against any real page.
//
// A selection answers a question that has an answer: "what is this worth at the
// shop I actually use?"
//
// TWO RULES THAT ARE NOT PREFERENCES:
//
//   1. SCRYFALL IS ALWAYS THE FALLBACK. It is the only source with a price for
//      essentially every printing, so it stops a card the chosen shop does not
//      stock from silently having no value and quietly shrinking the total. It
//      cannot be selected as the primary: it is an average of what cards sold
//      for, not an offer anyone will honour today.
//
//   2. A PRICE ALWAYS CARRIES ITS SOURCE. Never return a bare number. A total
//      that blends 1,496 Card Kingdom prices with 12 Scryfall ones is not "the
//      Card Kingdom value", and showing it as one anonymous figure is how
//      numbers drift without anyone being able to argue with them.
//
// EXPORTS ARE UNAFFECTED, deliberately. Zach: "export buylist wouldn't change."
// Each export tab prices itself at ITS OWN shop -- the Card Kingdom list must
// cost Card Kingdom money regardless of which shop he values his binder at.

const SOURCES = {
  manapool: {
    id: 'manapool',
    label: 'Mana Pool',
    // Live marketplace asking prices with real stock behind them: what the card
    // would actually cost today, not a market average.
    kind: 'marketplace',
    selectable: true,
  },
  cardkingdom: {
    id: 'cardkingdom',
    label: 'Card Kingdom',
    // A single retailer rather than a marketplace: one price, their stock, and
    // a higher floor ($0.35 vs $0.15). Graded NM/EX/VG/G, where EX is the
    // equivalent of Lightly Played -- his condition floor.
    kind: 'retailer',
    selectable: true,
  },
  scryfall: {
    id: 'scryfall',
    label: 'Scryfall',
    // Market averages. Near-total coverage, which is exactly why it is the
    // floor rather than a competitor in the ranking.
    kind: 'index',
    // Never selectable as the primary: an average of past sales is not an offer.
    // It exists so a card the chosen shop does not carry still has a value.
    selectable: false,
  },
};

// The floor. Never selectable, always appended last.
const FALLBACK_SOURCE = 'scryfall';

// The shop used when nothing is configured.
const DEFAULT_SOURCE = 'manapool';

// Every shop he can choose between, in display order.
function selectableSources() {
  return Object.values(SOURCES).filter(s => s.selectable);
}

// Turn the stored selection into an order that is safe to walk.
//
// The chain machinery is unchanged -- a selection is simply a one-shop order
// with the fallback behind it. Keeping the same shape means every call site
// that walks an order still works, and a future "compare both" view is a list
// of two rather than a rewrite.
//
// Defensive on purpose: this comes from a settings row, and a stale or unknown
// id must not blank out every price in the app. It also accepts the OLD array
// form, because his database already holds one -- reading a legacy value as
// garbage would silently reprice his whole collection at Scryfall.
function normaliseOrder(stored) {
  let chosen = null;
  if (typeof stored === 'string') {
    chosen = stored;
  } else if (Array.isArray(stored)) {
    // Legacy ranked order: the first real shop in it was the primary.
    chosen = stored.find(id => SOURCES[id]?.selectable) || null;
  }
  if (!SOURCES[chosen]?.selectable) chosen = DEFAULT_SOURCE;
  return [chosen, FALLBACK_SOURCE];
}

// THE CHAIN. Walk the order and take the first source that has a real price.
//
// `lookups` maps source id -> (card) => number|null. Returning null means "this
// source has nothing for this card", which is different from zero: a card
// genuinely priced at $0.00 is not a miss, and treating it as one would push it
// down the chain and report the wrong provenance.
//
// Returns { price, source, sourceLabel } -- never a bare number, so no caller
// can accidentally show a figure without saying where it came from.
function priceFrom(card, order, lookups) {
  for (const id of order) {
    const lookup = lookups[id];
    if (!lookup) continue;
    const value = lookup(card);
    if (value === null || value === undefined) continue;
    if (!(value > 0)) continue;
    return { price: value, source: id, sourceLabel: SOURCES[id]?.label || id };
  }
  return { price: 0, source: null, sourceLabel: null };
}

// Summarise a set of priced rows for display: the total, and how it splits by
// source.
//
// Zach approved showing this: "showing where the source came from in the total
// price is a good idea". The breakdown is the honest form of a blended total --
// "$1,718.72 from 1,400 Mana Pool and 108 Scryfall" is a fact; "$1,718.72"
// alone invites the reader to believe it is all one thing.
function summarise(priced) {
  const bySource = new Map();
  let total = 0;
  for (const p of priced) {
    total += p.price || 0;
    if (!p.source) continue;
    const e = bySource.get(p.source) || { source: p.source, label: p.sourceLabel, count: 0, total: 0 };
    e.count += 1;
    e.total += p.price || 0;
    bySource.set(p.source, e);
  }
  return {
    total,
    // Largest contributor first: the source that actually shaped the number.
    breakdown: [...bySource.values()].sort((a, b) => b.count - a.count),
  };
}

module.exports = {
  SOURCES,
  FALLBACK_SOURCE,
  DEFAULT_SOURCE,
  selectableSources,
  normaliseOrder,
  priceFrom,
  summarise,
};
