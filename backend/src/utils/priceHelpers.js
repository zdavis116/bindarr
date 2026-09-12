// SQLite's CURRENT_TIMESTAMP stores UTC but as a naive "YYYY-MM-DD HH:MM:SS"
// string with no timezone marker. JS's Date parser treats a string like that
// as LOCAL time, so on any server not running in UTC, a value that's really
// "now" gets parsed as hours off — enough to misorder it against a properly
// UTC-tagged timestamp (e.g. an ISO string with a trailing Z). Always read
// SQLite datetimes through this so they compare correctly against Date.now()
// or other real UTC timestamps.
function parseSqliteUtc(str) {
  if (!str) return new Date(NaN);
  return /Z$|[+-]\d\d:\d\d$/.test(str) ? new Date(str) : new Date(str.replace(' ', 'T') + 'Z');
}

// Market price for one collection row, chosen by its FINISH.
//
// Reads the canonical `finish` column, falling back to the display mirror only
// for callers that pass a bare card object without one. It previously matched
// Pokemon values ('Holofoil', 'Reverse Holofoil') that MTG rows can no longer
// hold, so every foil silently fell through to the generic price_trend and the
// collection was valued as if the user owned no foils at all.
//
// price_holofoil is Scryfall's usd_foil. Etched has no separate price field, so
// it uses the foil price -- closer to the truth than the nonfoil price, and the
// alternative (price_trend) is a blend that is wrong for both.
//
// MARKETPLACE PRICES COME FIRST WHEN PRESENT.
//
// Zach: "if I say my top 3 card prices should come from 1. Mana pool, then tcg
// player then card kingdom then what should happen is show me mana pool price
// if possible then if it can't there fall back to tcg player then card
// kingdom." Scryfall is the pinned last resort.
//
// This is the ONE function every priced screen already goes through -- 57 call
// sites across collection, decks, stats, storage and the exporters -- so the
// chain lives here rather than being reimplemented per screen. A second
// implementation of a pricing rule is how the deck completion ring and
// missing_cost drifted apart earlier in this project.
//
// The marketplace columns arrive by JOIN as mp_price_cents / mp_price_cents_foil
// / mp_price_cents_etched / mp_source. A row fetched without that join simply
// has no marketplace price and falls through to Scryfall, so callers that have
// not been updated keep working and keep showing a real number.
function resolveCardPrice(card) {
  return resolvePricedCard(card).price;
}

// The same decision, but returning WHERE the number came from.
//
// Zach approved this explicitly: "maybe it tells you where that price is coming
// from" and "showing where the source came from in the total price is a good
// idea". A price with no attribution is the kind of figure that drifts without
// anyone being able to argue with it.
function resolvePricedCard(card) {
  if (!card) return { price: 0, source: null, sourceLabel: null };

  const finish = card.finish
    || (card.printing === 'Foil' ? 'foil' : card.printing === 'Etched' ? 'etched' : 'nonfoil');
  const isFoilish = finish === 'foil' || finish === 'etched';

  // 1. MARKETPLACE, in cents. Etched falls back to the foil price for the same
  //    reason Scryfall's does: no separate etched market, and the foil number is
  //    far closer than the nonfoil one.
  const cents = isFoilish
    ? (finish === 'etched'
        ? (card.mp_price_cents_etched ?? card.mp_price_cents_foil)
        : card.mp_price_cents_foil)
    : card.mp_price_cents;
  if (Number.isFinite(cents) && cents > 0) {
    // WHICH CONDITION THAT PRICE IS FOR.
    //
    // Zach: "Lowest condition I would go is lightly played, so if there is
    // value for lightly played that is what I would like to use if not use near
    // mint." $32.99 LP and $33.73 NM are different offers; a price with no
    // condition beside it cannot be judged.
    const condition = isFoilish
      ? (finish === 'etched'
          ? (card.mp_condition_etched || card.mp_condition_foil)
          : card.mp_condition_foil)
      : card.mp_condition;
    return {
      price: cents / 100,
      source: card.mp_source || 'manapool',
      sourceLabel: MARKETPLACE_LABELS[card.mp_source || 'manapool'] || 'Marketplace',
      condition: condition || null,
    };
  }

  // 2. SCRYFALL, the floor.
  if (isFoilish && card.price_holofoil !== null && card.price_holofoil > 0) {
    return { price: card.price_holofoil, source: 'scryfall', sourceLabel: 'Scryfall' };
  }
  if (finish === 'nonfoil' && card.price_normal !== null && card.price_normal > 0) {
    return { price: card.price_normal, source: 'scryfall', sourceLabel: 'Scryfall' };
  }
  if (card.price_trend > 0) {
    return { price: card.price_trend, source: 'scryfall', sourceLabel: 'Scryfall' };
  }

  // 3. Genuinely unpriced. Reported as such rather than as a $0 card, so a
  //    missing price can never masquerade as a worthless one.
  return { price: 0, source: null, sourceLabel: null };
}

const MARKETPLACE_LABELS = { manapool: 'Mana Pool', cardkingdom: 'Card Kingdom' };

// THE JOIN THAT BRINGS SHOP PRICES INTO A QUERY.
//
// One definition, used by every priced read, so the columns resolvePricedCard
// looks for can never be spelled differently in two places.
//
// THIS USED TO BE HARDCODED TO MANA POOL, with a comment admitting it was a
// first step. It now honours the shop he selected -- Zach: "I would like to get
// rid of the priority list and it be a selection whether I used mana pool or
// card kingdom but the fallback is always scryfall."
//
// A FUNCTION, NOT A CONSTANT, because the shop is a runtime setting. Call sites
// pass the selected id; the parameter is validated against the registry rather
// than interpolated, since this string goes straight into SQL.
//
// LEFT JOIN, always: a card the chosen shop does not stock must still appear
// with its Scryfall price, never vanish from the listing.
function marketplacePriceJoin(sourceId) {
  const id = MARKETPLACE_LABELS[sourceId] ? sourceId : 'manapool';
  return `
  LEFT JOIN source_prices mp
         ON mp.card_id = cc.id AND mp.source = '${id}'`;
}

// WHICH SHOP IS SELECTED, READ AT REQUEST TIME.
//
// Cached briefly because every priced endpoint needs it and it changes only
// when he taps Settings. Without the cache a collection page would issue an
// extra settings query per request through the single operation queue -- the
// same queue that already made /api/stats take 26 seconds under load.
let _shopCache = { id: null, at: 0 };
const SHOP_CACHE_MS = 5000;

async function selectedShop(database) {
  if (_shopCache.id && Date.now() - _shopCache.at < SHOP_CACHE_MS) return _shopCache.id;
  try {
    const row = await database.get(
      `SELECT price_source_order AS o FROM app_settings WHERE id = 1`);
    let stored = null;
    try { stored = JSON.parse(row?.o || 'null'); } catch { stored = null; }
    // Accepts the legacy array form as well as the current string.
    const id = typeof stored === 'string'
      ? stored
      : (Array.isArray(stored) ? stored[0] : null);
    _shopCache = { id: MARKETPLACE_LABELS[id] ? id : 'manapool', at: Date.now() };
  } catch {
    // A failed settings read must not blank every price: fall back to the
    // default shop rather than to no join at all.
    _shopCache = { id: 'manapool', at: Date.now() };
  }
  return _shopCache.id;
}

// Called after a write so his choice takes effect immediately rather than up to
// five seconds later -- a setting that appears not to work is worse than a slow
// one.
function clearShopCache() { _shopCache = { id: null, at: 0 }; }

// Kept for the few call sites with no database handle. Same shape, default shop.
const MARKETPLACE_PRICE_JOIN = marketplacePriceJoin('manapool');

const MARKETPLACE_PRICE_COLUMNS = `
  mp.price_cents        AS mp_price_cents,
  mp.price_cents_foil   AS mp_price_cents_foil,
  mp.price_cents_etched AS mp_price_cents_etched,
  mp.condition          AS mp_condition,
  mp.condition_foil     AS mp_condition_foil,
  mp.condition_etched   AS mp_condition_etched,
  mp.available_quantity AS mp_available_quantity,
  mp.url                AS mp_url,
  mp.source             AS mp_source,`;


function parseCardRow(row) {
  if (!row) return row;
  return {
    ...row,
    subtypes: JSON.parse(row.subtypes || '[]'),
    types: JSON.parse(row.types || '[]'),
    color_identity: JSON.parse(row.color_identity || '[]'),
    keywords: JSON.parse(row.keywords || '[]'),
    legalities: JSON.parse(row.legalities || '{}'),
    finishes: JSON.parse(row.finishes || '[]'),
  };
}

// position orders cards WITHIN a single compartment (a binder page, a box
// row) — see compartmentSort.js for how a card's compartment+position is
// chosen in the first place.
async function rebalanceCompartmentPositions(db, compartmentId, userId) {
  if (!compartmentId) return;
  const cards = await db.all(`SELECT id FROM collection WHERE compartment_id = ? AND user_id = ? ORDER BY position ASC`, [compartmentId, userId]);
  for (let i = 0; i < cards.length; i++) {
    const cleanPos = (i + 1) * 1000;
    await db.run(`UPDATE collection SET position = ? WHERE id = ?`, [cleanPos, cards[i].id]);
  }
}

const isVintageSet = (setId) => {
  const id = (setId || '').toLowerCase();
  return id.startsWith('base') || id.startsWith('gym') || id.startsWith('neo') ||
         id.startsWith('lc') || id.startsWith('ecard') || id.startsWith('ex') ||
         id.startsWith('pop') || id.startsWith('promo1') || id.startsWith('si') ||
         id.startsWith('xy12') || id.startsWith('cel25');
};

// Record a price point, but only when it actually moved. The price sweep runs
// on every boot and nodemon reboots on every code edit, so the unguarded insert
// was writing a fresh row per card per restart — 17k rows in a single day, all
// the same number. A price series only needs the points where the price
// changed; the flat stretches between them are implied by the line.
async function recordPrice(cardId, price) {
  if (!cardId || !(price > 0)) return false;
  const db = require('../db');
  // One SQL statement makes the movement check and insert atomic at the
  // database boundary. The global DB queue preserves invocation order and
  // suppresses duplicates without a second queue that can deadlock a tx.
  const result = await db.run(
    `INSERT INTO price_history (card_id, price, recorded_at)
     SELECT ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now')
     WHERE (
       SELECT price FROM price_history
       WHERE card_id = ?
       ORDER BY recorded_at DESC, id DESC
       LIMIT 1
     ) IS NOT ?`,
    [cardId, price, cardId, price]
  );
  return result.changes === 1;
}

// Scryfall: "We only update prices for cards once per day. Fetching card data
// more frequently than 24 hours will not yield new prices."
// (https://scryfall.com/docs/api/rate-limits). Sweeping more often than daily
// is pure load for zero new data, so both providers gate on this.
const PRICE_SWEEP_INTERVAL_MS = 1000 * 60 * 60 * 24;
const SWEEP_COLUMN = { mtg: 'mtg_prices_swept_at' };

// Has this game's price sweep gone stale enough to be worth running again?
async function shouldSweepPrices(game) {
  const col = SWEEP_COLUMN[game];
  if (!col) return false;
  const db = require('../db');
  try {
    const row = await db.get(`SELECT ${col} AS sweptAt FROM app_settings WHERE id = 1`);
    if (!row || !row.sweptAt) return true;
    return Date.now() - parseSqliteUtc(row.sweptAt).getTime() >= PRICE_SWEEP_INTERVAL_MS;
  } catch {
    return true; // never block the sweep on a bookkeeping failure
  }
}

async function markPricesSwept(game) {
  const col = SWEEP_COLUMN[game];
  if (!col) return;
  const db = require('../db');
  try {
    await db.run(`UPDATE app_settings SET ${col} = CURRENT_TIMESTAMP WHERE id = 1`);
  } catch (e) {
    console.warn(`Could not record ${game} price sweep time:`, e.message);
  }
}

module.exports = {
  parseSqliteUtc,
  shouldSweepPrices,
  markPricesSwept,
  PRICE_SWEEP_INTERVAL_MS,
  resolveCardPrice,
  resolvePricedCard,
  MARKETPLACE_PRICE_JOIN,
  marketplacePriceJoin,
  selectedShop,
  clearShopCache,
  MARKETPLACE_PRICE_COLUMNS,
  parseCardRow,
  rebalanceCompartmentPositions,
  isVintageSet,
  recordPrice
};
