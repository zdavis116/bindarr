// PRE-BUILT DECKS FROM MANA POOL.
//
// Zach: "I am looking for seeing all the premade decks like this link shows
// https://manapool.com/decks?q=doctor+doom%2C+king" and then "I am just looking
// to compare with decks I have already built to see if it makes sense to maybe
// use some of those cards in my deck."
//
// So this is a COMPARISON tool, not a shopping one. It answers "is there
// anything in that deck worth stealing for mine?"
//
// THIS IS AN UNDOCUMENTED ENDPOINT. Mana Pool's public API (/api/docs/v1) has
// prices, products, orders and seller inventory -- and exactly one deck route,
// `POST /deck`, which VALIDATES a list rather than returning one. There is no
// supported way to read a deck.
//
// What does exist is the SvelteKit data endpoint that their own pages call:
//   /decks/__data.json?q=<query>        -> the browse tiles
//   /lists/<publicId>/__data.json       -> that deck's cards
//
// It is structured JSON rather than scraped HTML, so it is far steadier than
// parsing a page, but it carries no compatibility promise. Every failure here
// is therefore LOUD: callers get an error they can show, never an empty list
// that looks like "no decks found". A silent empty result would have Zach
// concluding no premade deck exists for a commander when the truth is the
// endpoint moved.
//
// Verified live before this file was written:
//   /decks/__data.json?q=doctor+doom%2C+king  -> 53 decks
//   the first tile's list                     -> 88 rows, 100 cards,
//                                                commander flagged,
//                                                scryfallOracleId on every card

const BASE = 'https://manapool.com';

// A browser-ish UA. Their edge returns HTML error pages to obvious scripts, and
// an HTML body parsed as JSON is the "Unexpected token '<'" failure that has
// bitten this project before -- better to look like the browser their own page
// runs in.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Bindarr/1.0; +https://github.com/zdavis116/bindarr)',
  Accept: 'application/json,text/plain,*/*',
};

class ManaPoolError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ManaPoolError';
    this.status = 502;          // an upstream failure, not the user's fault
    this.code = 'MANAPOOL_UNAVAILABLE';
    this.cause = cause;
  }
}

/**
 * SvelteKit serialises its page data with `devalue`: node.data is a FLAT array
 * where every object's values are INDEXES into that same array, so shared
 * references are stored once.
 *
 * Walking it needs a seen-map or a cyclic structure spins forever -- the card
 * objects genuinely do share set records.
 */
function deref(arr) {
  const seen = new Map();
  const walk = (i) => {
    if (typeof i !== 'number') return i;      // already a literal
    if (seen.has(i)) return seen.get(i);
    const v = arr[i];
    if (Array.isArray(v)) {
      const out = [];
      seen.set(i, out);
      for (const x of v) out.push(walk(x));
      return out;
    }
    if (v && typeof v === 'object') {
      const out = {};
      seen.set(i, out);
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return walk(0);
}

async function fetchData(path) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  } catch (err) {
    throw new ManaPoolError('Could not reach Mana Pool.', err);
  }
  if (!res.ok) {
    throw new ManaPoolError(`Mana Pool returned ${res.status}.`);
  }
  // An HTML body here means the endpoint moved or we were blocked. Say so
  // rather than letting JSON.parse throw a token error nobody can act on.
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) {
    throw new ManaPoolError(
      'Mana Pool returned a page instead of data -- their deck endpoint has '
      + 'likely changed.');
  }
  const raw = await res.json();
  if (!raw || !Array.isArray(raw.nodes)) {
    throw new ManaPoolError('Mana Pool sent an unfamiliar response shape.');
  }
  return raw;
}

// Pick the page-data node that actually holds `key`. Which node it is depends
// on their layout nesting, so find it by content rather than by index.
function nodeWith(raw, key) {
  for (const node of raw.nodes) {
    if (!node || !node.data) continue;
    let root;
    try { root = deref(node.data); } catch { continue; }
    if (root && Object.prototype.hasOwnProperty.call(root, key)) return root;
  }
  return null;
}

/**
 * Search pre-built decks. Returns the browse tiles, which carry everything the
 * picker needs WITHOUT a second request per deck.
 */
async function searchDecks(query, { bracket } = {}) {
  const q = String(query || '').trim();
  if (!q) return { total: 0, decks: [] };

  const raw = await fetchData(`/decks/__data.json?q=${encodeURIComponent(q)}`);
  const root = nodeWith(raw, 'tiles');
  if (!root) {
    throw new ManaPoolError(
      'Mana Pool sent no deck list -- their browse endpoint has likely changed.');
  }

  let decks = (root.tiles || []).map((t) => ({
    id: t.publicId,
    commander: t.commanderName,
    theme: t.theme,
    bracket: t.bracket,
    // priceCents, like every other price in Bindarr. Formatting is the UI's job.
    priceCents: t.priceCents,
    seller: t.sellerUsername,
    colorIdentity: t.colorIdentity || [],
    url: `${BASE}/lists/${t.publicId}`,
  }));

  // Zach plays Bracket 3 and asked for this one filter specifically.
  if (bracket) decks = decks.filter((d) => d.bracket === Number(bracket));

  return { total: root.total ?? decks.length, decks };
}

/**
 * The cards in one pre-built deck.
 *
 * scryfallOracleId is the field that matters: it identifies the CARD rather
 * than a printing, so a diff against Zach's collection is not defeated by him
 * owning a different edition. Matching on name would break on split/adventure
 * cards and on the flavour-name reprints this app already had to handle once.
 */
async function fetchDeckCards(publicId) {
  const id = String(publicId || '').trim();
  if (!id) throw new ManaPoolError('No deck id given.');

  const raw = await fetchData(`/lists/${encodeURIComponent(id)}/__data.json`);
  const root = nodeWith(raw, 'cards');
  if (!root) {
    throw new ManaPoolError(
      'Mana Pool sent no card list for that deck.');
  }

  const cards = (root.cards || [])
    // Sideboard rows are not part of a Commander deck; counting them would
    // inflate the comparison.
    .filter((row) => !row.is_sideboard)
    .map((row) => {
      const c = row.card || {};
      return {
        oracleId: c.scryfallOracleId || null,
        scryfallId: c.scryfallId || null,
        name: c.name || '',
        setCode: (c.setCode || '').toUpperCase(),
        setName: c.set?.name || '',
        number: c.number || '',
        quantity: row.quantity_main ?? row.quantity ?? 1,
        isCommander: !!row.is_commander,
        isBasic: !!row.is_basic,
        types: c.types || [],
        manaValue: Number(c.manaValue ?? 0),
        colorIdentity: c.colorIdentity || [],
        // What Mana Pool would charge, in cents, for comparison against
        // Bindarr's own price chain.
        marketPriceCents: Number.isFinite(c.market_prices?.price)
          ? Math.round(c.market_prices.price)
          : null,
      };
    });

  if (cards.length === 0) {
    throw new ManaPoolError('That deck came back empty.');
  }

  return {
    id,
    url: `${BASE}/lists/${id}`,
    name: root.name || root.title || null,
    cards,
    totalCards: cards.reduce((n, c) => n + c.quantity, 0),
  };
}

module.exports = { searchDecks, fetchDeckCards, ManaPoolError, deref };
