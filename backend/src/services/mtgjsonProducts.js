// SEALED PRODUCT CONTENTS, FROM MTGJSON.
//
// Zach: "adding cards to my collection through like precons, secret lair drops
// and my orders on manapool ... it's silly I have to scan those in when those
// lists are exactly what I would scan."
//
// WHY NOT SCRYFALL. Scryfall cannot answer this at all: a card carries no field
// saying which product it came from. A Commander *set* is one undifferentiated
// bag ("Reality Fracture Commander" is 103 cards across several decks), and
// Secret Lair is worse -- set `sld` holds 2,757 cards spanning every drop ever
// released. The set is not the product.
//
// MTGJSON publishes the products themselves. Measured 2026-09-20:
//   DeckList.json          -> 3,059 decks, incl. 191 Commander, 751 Secret Lair
//   decks/<fileName>.json  -> commander[] / mainBoard[] / sideBoard[]
//
// Every card row carries identifiers.scryfallId (the exact printing, which IS
// Bindarr's card_cache.id), a count, and isFoil/isEtched. Verified faithful:
// six recent precons each total exactly 100 cards, zero rows missing an id, and
// foil flags match the edition.
//
// NEVER INFER FINISH FROM THE PRODUCT NAME. "Hidden Pathways" carries no "Foil"
// in its title and is 100% foil in the data. The flag is the only truth.

const CATALOGUE_URL = 'https://mtgjson.com/api/v5/DeckList.json';
// SET NAMES, so a product is findable by the set everyone calls it.
//
// Zach: "when searching precons I would like to be able to search by set like
// Duskmorn. When I did that I got nothing I had to search by the precon name
// of Death Toll."
//
// DeckList.json carries only a set CODE ("DSC"), and nobody searches for a
// three-letter code. SetList.json maps DSC -> "Duskmourn: House of Horror
// Commander", so joining the two makes "duskmourn" find all four of its
// precons. Same TTL and the same loud failure handling as the deck list.
const SETLIST_URL = 'https://mtgjson.com/api/v5/SetList.json';
const DECK_URL = (fileName) =>
  `https://mtgjson.com/api/v5/decks/${encodeURIComponent(fileName)}.json`;

// MTGJSON is a volunteer project with no SLA. The catalogue changes only when a
// product releases, so it is cached for a day rather than fetched per keystroke.
const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;

const HEADERS = {
  'User-Agent': 'Bindarr/1.0 (+https://github.com/zdavis116/bindarr)',
  Accept: 'application/json',
};

// A THIRD PARTY BEING DOWN MUST LOOK LIKE A THIRD PARTY BEING DOWN.
//
// The same rule the Mana Pool service was written to obey: an empty list here
// would read as "no precons exist", which is a different and wrong conclusion.
// Every failure is loud and carries a message worth showing.
class ProductSourceError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ProductSourceError';
    this.status = 502;
    this.code = 'PRODUCT_SOURCE_UNAVAILABLE';
    this.cause = cause;
  }
}

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProductSourceError(
      'Could not reach the product catalogue (MTGJSON).', error);
  }
  if (!res.ok) {
    throw new ProductSourceError(
      `The product catalogue returned ${res.status}.`);
  }
  try {
    return await res.json();
  } catch (error) {
    // An HTML error page parsed as JSON is the "Unexpected token '<'" failure
    // this project has hit before. Name it rather than leaking a parser error.
    throw new ProductSourceError(
      'The product catalogue sent something that was not JSON.', error);
  }
}

// The product TYPES this feature offers. MTGJSON publishes 3,059 decks across
// many types (Jumpstart, Theme Deck, MTGO Redemption...); Zach asked for
// precons and Secret Lair, and offering the rest would bury those two.
const OFFERED_TYPES = {
  'Commander Deck': 'precon',
  'Secret Lair Drop': 'secretlair',
};

let catalogueCache = { at: 0, products: null };

// A stable id for a product. MTGJSON identifies a deck by fileName, which is
// unique and URL-safe, so it is used directly rather than inventing a mapping
// that would have to be kept in step.
const productIdOf = (d) => d.fileName;

/**
 * The browsable product list. Cached for a day.
 */
async function listProducts({ force = false } = {}) {
  const fresh = catalogueCache.products
    && (Date.now() - catalogueCache.at) < CATALOGUE_TTL_MS;
  if (fresh && !force) return catalogueCache.products;

  const body = await fetchJson(CATALOGUE_URL);
  const raw = Array.isArray(body?.data) ? body.data : null;
  if (!raw || raw.length === 0) {
    throw new ProductSourceError('The product catalogue came back empty.');
  }

  // Set names, joined by code. Fetched alongside rather than lazily, because a
  // product whose set name is missing is INVISIBLE to a set search -- a silent
  // partial result, which is the failure mode this whole file avoids.
  let setNames = {};
  try {
    const sets = await fetchJson(SETLIST_URL);
    for (const s of (sets?.data || [])) {
      if (s.code) setNames[s.code] = s.name;
    }
  } catch (error) {
    // A set-name outage must not take the whole picker down: products are still
    // findable by their own name, which is how it worked before. Degrade, and
    // say so in the log rather than pretending the data is complete.
    console.warn('mtgjsonProducts: set names unavailable,'
      + ' search by set will not work this cycle:', error.message);
    setNames = {};
  }

  const products = raw
    .filter((d) => OFFERED_TYPES[d.type])
    .map((d) => ({
      id: productIdOf(d),
      name: d.name,
      kind: OFFERED_TYPES[d.type],
      type: d.type,
      setCode: d.code,
      setName: setNames[d.code] || null,
      releaseDate: d.releaseDate || null,
    }));

  catalogueCache = { at: Date.now(), products };
  return products;
}

// THE EDITION PROBLEM.
//
// 332 of the 751 Secret Lair drops ship in two editions whose names differ only
// by a suffix ("A Box of Rocks" / "A Box of Rocks Foil Edition"). Picking the
// wrong one records cards Zach does not own, so the UI asks him outright -- and
// to ask, it has to know which products are twins.
const EDITION_SUFFIX =
  /\s*(Traditional Foil|Raised Foil|Galaxy Foil|Rainbow Foil|Textured Foil|Gilded Foil|Surge Foil|Foil|Non-?foil)\s*(Edition)?\s*$/i;

function baseNameOf(name) {
  return String(name || '').replace(EDITION_SUFFIX, '').trim();
}

/**
 * Group a product list into one entry per base name, carrying its editions.
 * A product with a single edition is returned unchanged, so the picker only
 * asks the edition question when there is genuinely a choice.
 */
function groupEditions(products) {
  const byBase = new Map();
  for (const p of products) {
    const base = baseNameOf(p.name) || p.name;
    const key = `${p.kind}:${base.toLowerCase()}`;
    if (!byBase.has(key)) byBase.set(key, { base, kind: p.kind, editions: [] });
    byBase.get(key).editions.push(p);
  }
  return [...byBase.values()].map((g) => ({
    ...g,
    // Stable order: the plain edition first, so the default selection is the
    // ordinary one rather than whichever MTGJSON happened to list first.
    editions: g.editions.sort((a, b) => a.name.length - b.name.length),
  }));
}

/**
 * Search products by name.
 *
 * Returns edition GROUPS, not raw products: the screen shows one row per drop
 * and asks about the finish afterwards.
 *
 * `addedIds` is the set of product ids already in the user's import ledger.
 * THE SORT MUST HAPPEN BEFORE THE LIMIT, which is why this is a parameter
 * rather than something the client does afterwards.
 *
 * Zach: "uhhh you are missing decks marked as added. Explorers of the deep is
 * marked as added and isnt at the top. ALL DECKS marked as added should be at
 * the top"
 *
 * He was right and my first fix was in the wrong place. Sorting in the
 * component can only reorder the rows that ARRIVED: this search matches 611
 * products and returns 40, so "Explorers of the Deep" (LCC, 2023 -- roughly
 * #200 by release date) was never in the response at all. A client-side sort
 * of a truncated list silently answers a different question.
 */
async function searchProducts(query, { kind = null, limit = 40, addedIds = null,
                                       catalogue = null } = {}) {
  // `catalogue` is a test seam. searchProducts calls listProducts internally,
  // so replacing the module export does NOT intercept it -- the test proved
  // that by failing. An explicit parameter is honest about the dependency and
  // lets the limit/sort interaction be exercised against a known list.
  const all = catalogue || await listProducts();
  const q = String(query || '').trim().toLowerCase();
  const filtered = all.filter((p) => {
    if (kind && p.kind !== kind) return false;
    if (!q) return true;
    // MATCH THE PRODUCT NAME, THE SET NAME, OR THE SET CODE.
    //
    // "duskmourn" must find Death Toll, Endless Punishment, Jump Scare! and
    // Miracle Worker -- none of which contain the word. Zach searched the set
    // and got nothing, then had to already know a deck's name to find it,
    // which defeats the point of browsing.
    return p.name.toLowerCase().includes(q)
      || (p.setName || '').toLowerCase().includes(q)
      || (p.setCode || '').toLowerCase() === q;
  });
  const groups = groupEditions(filtered);
  // ADDED FIRST, THEN NEWEST FIRST -- in that order, and BEFORE the slice.
  //
  // "ALL DECKS marked as added should be at the top", including ones that
  // would fall outside the 40 returned. Within each half the newest-first rule
  // is kept: Zach is far likelier to be adding a product he just bought than
  // one from 2013.
  const isAdded = (g) => !!addedIds && g.editions.some((e) => addedIds.has(e.id));
  groups.sort((a, b) => {
    const aa = isAdded(a), ba = isAdded(b);
    if (aa !== ba) return aa ? -1 : 1;
    const da = a.editions[0].releaseDate || '';
    const db = b.editions[0].releaseDate || '';
    return db.localeCompare(da);
  });
  // EVERY added product survives the limit, even past the cut. Returning 40 of
  // 611 by date is fine for browsing, but silently dropping something he told
  // us he owns is the exact complaint this fixes.
  const head = groups.slice(0, limit);
  const kept = new Set(head);
  const addedPastCut = groups.filter((g) => isAdded(g) && !kept.has(g));
  return { total: groups.length, groups: [...addedPastCut, ...head] };
}

/**
 * The finish for a card row, as Bindarr names it.
 *
 * READ FROM THE DATA, NEVER THE NAME. Etched is checked first because an etched
 * card also carries isFoil in some rows, and etched is the more specific truth.
 */
function finishOf(card) {
  if (card.isEtched) return 'etched';
  if (card.isFoil) return 'foil';
  return 'nonfoil';
}

/**
 * Fetch one product's contents, normalised.
 *
 * Boards are FLATTENED deliberately. Zach is adding physical cards to a
 * collection, not building a deck: the commander and the mainboard are all
 * cards in the box, and he said "just add precon to collection only".
 */
async function fetchProductCards(productId) {
  const all = await listProducts();
  const product = all.find((p) => p.id === productId);
  if (!product) {
    const err = new Error('That product is not in the catalogue.');
    err.status = 404;
    err.code = 'PRODUCT_NOT_FOUND';
    throw err;
  }

  const body = await fetchJson(DECK_URL(product.id));
  const deck = body?.data;
  if (!deck) throw new ProductSourceError('That product came back empty.');

  const rows = [
    ...(deck.commander || []),
    ...(deck.mainBoard || []),
    ...(deck.sideBoard || []),
  ];
  if (rows.length === 0) {
    throw new ProductSourceError('That product lists no cards.');
  }

  // Merge rows that are the same PRINTING AND FINISH. A foil and a nonfoil of
  // one card are two different physical objects and must stay apart -- that is
  // the exact-only identity model the rest of the app is built on.
  const merged = new Map();
  for (const c of rows) {
    const scryfallId = c.identifiers?.scryfallId || null;
    const finish = finishOf(c);
    const key = `${scryfallId || `name:${c.name}`}|${finish}`;
    const prev = merged.get(key);
    if (prev) { prev.quantity += (c.count || 1); continue; }
    merged.set(key, {
      scryfallId,
      oracleId: c.identifiers?.scryfallOracleId || null,
      name: c.name,
      typeLine: c.type || '',
      setCode: c.setCode || product.setCode,
      number: c.number || '',
      finish,
      quantity: c.count || 1,
    });
  }

  return {
    product,
    cards: [...merged.values()],
    totalCards: rows.reduce((n, c) => n + (c.count || 1), 0),
  };
}

module.exports = {
  listProducts,
  searchProducts,
  fetchProductCards,
  groupEditions,
  baseNameOf,
  finishOf,
  ProductSourceError,
  // exported for tests
  OFFERED_TYPES,
  _resetCache: () => { catalogueCache = { at: 0, products: null }; },
};
