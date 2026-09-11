// WHERE A PRICE CAME FROM, AND WHICH SOURCE WINS.
//
// Zach: "I think it should use manapool outright but maybe be configurable like
// if there is no price for manapool it uses scryfall almost like a ranking
// system. Like long term thought is we take in tcg player and card kingdom
// prices too. Like if I say my top 3 card prices should come from 1. Mana pool,
// then tcg player then card kingdom then what should happen is show me mana
// pool price if possible then if it can't there fall back to tcg player then
// card kingdom. So then also maybe it tells you where that price is coming
// from."
//
// So this is a REGISTRY, not a Mana Pool special case. Adding TCGplayer later
// should be one entry here plus a fetcher, not a rewrite of every screen.
//
// TWO RULES THAT ARE NOT PREFERENCES:
//
//   1. SCRYFALL IS ALWAYS LAST. Zach: "scryfall last resort". It is the only
//      source with a price for essentially every printing, so it is the floor
//      that stops a card showing no price at all. It cannot be reordered above
//      a marketplace or removed, because then a card no marketplace stocks
//      would silently have no value and the collection total would quietly drop.
//
//   2. A PRICE ALWAYS CARRIES ITS SOURCE. Never return a bare number. A total
//      that blends 1,400 Mana Pool prices with 108 Scryfall ones is not "the
//      Mana Pool value", and showing it as one anonymous figure is how numbers
//      drift without anyone being able to argue with them -- the same class of
//      problem as a schedule hardcoded in the UI.

// Every source Bindarr can price from. `id` is what gets stored in settings and
// returned as provenance, so these strings are a contract -- renaming one
// invalidates a user's saved order.
const SOURCES = {
  manapool: {
    id: 'manapool',
    label: 'Mana Pool',
    // Live marketplace asking prices with real stock behind them: what the card
    // would actually cost today, not a market average.
    kind: 'marketplace',
    reorderable: true,
  },
  scryfall: {
    id: 'scryfall',
    label: 'Scryfall',
    // Market averages. Near-total coverage, which is exactly why it is the
    // floor rather than a competitor in the ranking.
    kind: 'index',
    reorderable: false,
  },
};

// The floor. Not in the reorderable set, always appended last.
const FALLBACK_SOURCE = 'scryfall';

// Default order when nothing is configured. Mana Pool first because it is the
// one Zach asked for; Scryfall is appended by normaliseOrder regardless.
const DEFAULT_ORDER = ['manapool'];

// Turn whatever is stored in settings into an order that is safe to walk.
//
// Defensive on purpose: this list comes from a settings row a user can edit, and
// a typo there must not blank out every price in the app. Unknown ids are
// dropped, duplicates collapse, and the fallback is appended if missing.
function normaliseOrder(stored) {
  const seen = new Set();
  const order = [];
  for (const id of Array.isArray(stored) ? stored : []) {
    if (!SOURCES[id] || id === FALLBACK_SOURCE || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  if (order.length === 0) {
    for (const id of DEFAULT_ORDER) {
      if (SOURCES[id] && !seen.has(id)) { seen.add(id); order.push(id); }
    }
  }
  order.push(FALLBACK_SOURCE);
  return order;
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
  DEFAULT_ORDER,
  normaliseOrder,
  priceFrom,
  summarise,
};
