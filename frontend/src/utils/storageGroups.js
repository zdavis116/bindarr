// THE SORT STACK: how a container decides what sits next to what.
//
// Zach: "I like to order by set and color identity except I can organize by
// type like lands and even categorize lands by basic and non basic."
//
// The word doing the work is EXCEPT. One sort rule cannot express it, so a
// container carries an ORDERED STACK of levels -- Type, then Color, then Set --
// and the stack both sorts the cards and cuts them into labelled groups. The
// order IS the shelf order.
//
// This file owns the GROUPING. The existing cardSort.js owns the comparison
// inside a group, and the two must agree about what a group is, so both read
// the level definitions from here.
//
// Measured against Zach's real 2,626 cards before any of this was designed:
//   73 distinct sets
//   27 distinct colour identities (5 mono, Colorless, 21 combinations)
//   Creature 1,153 | Artifact 328 | Instant 303 | Basic Land 264 |
//   Nonbasic Land 231 | Sorcery 191 | Enchantment 152 | Planeswalker 4
//
// The 27 is why `multiAsOne` exists: a raw colour axis produces 27 piles, and
// Zach chose 5 mono + Colorless + one Multicolour pile.

// WUBRG, the order every Magic player reads colours in. Shared with the backend
// filing engine via shared/cardOrder.json -- see cardSort.js, which had to be
// corrected once because the display order disagreed with the filed order.
const COLOR_RANK = {
  White: 1, Blue: 2, Black: 3, Red: 4, Green: 5,
  Multicolour: 6, Colorless: 7,
};

// The card types Zach sorts by, in the order a collection is usually laid out:
// spells first, lands last, because lands are the bulk you flip past.
const TYPE_RANK = {
  Creature: 1, Planeswalker: 2, Instant: 3, Sorcery: 4,
  Enchantment: 5, Artifact: 6, Battle: 7,
  'Nonbasic Land': 8, 'Basic Land': 9, Other: 10,
};

/**
 * A card's colour identity as a single group label.
 *
 * color_identity arrives as an ARRAY of colour NAMES (["Blue"], ["Black",
 * "White"]) -- verified against the live API, not assumed. It can also be a
 * JSON string from older rows, so both shapes are handled.
 *
 * @param card       the card
 * @param multiAsOne true: every multicolour card lands in one "Multicolour"
 *                   pile (Zach's choice). false: each combination is its own
 *                   group, which his collection would split into 21 of them.
 */
export function colorGroup(card, multiAsOne = true) {
  let ci = card?.color_identity;
  if (typeof ci === 'string') {
    try { ci = JSON.parse(ci); } catch { ci = []; }
  }
  if (!Array.isArray(ci) || ci.length === 0) return 'Colorless';
  if (ci.length === 1) return ci[0];
  // NOT ci[0]. cardSort.js took the first colour, so a Black/White card sorted
  // as Black and no multicolour pile could ever form -- the bug this replaces.
  return multiAsOne ? 'Multicolour' : [...ci].sort(
    (a, b) => (COLOR_RANK[a] || 99) - (COLOR_RANK[b] || 99)
  ).join('/');
}

/**
 * A card's type as a single group label, reading BOTH faces.
 *
 * type_line is "Legendary Creature — Human // Legendary Artifact Creature" for
 * a double-faced card. Splitting on the em dash alone stops inside the front
 * face, which is the bug that hid Tony Stark from the Artifact filter.
 *
 * @param splitLands true: "Basic Land" and "Nonbasic Land" are separate groups,
 *                   which is what Zach asked for by name.
 */
export function typeGroup(card, splitLands = true) {
  const line = card?.type_line || '';
  const faces = line.split(' // ');
  const isLand = faces.some((f) => /\bLand\b/.test(f));
  if (isLand) {
    if (!splitLands) return 'Nonbasic Land';
    return faces.some((f) => /\bBasic\b/.test(f)) ? 'Basic Land' : 'Nonbasic Land';
  }
  // First matching type across either face, in shelf order -- a card that is
  // both a Creature and an Artifact files under Creature, which is where a
  // player looks for it.
  for (const t of ['Creature', 'Planeswalker', 'Instant', 'Sorcery',
    'Enchantment', 'Artifact', 'Battle']) {
    if (faces.some((f) => new RegExp(`\\b${t}\\b`).test(f))) return t;
  }
  return 'Other';
}

const RARITY_RANK = { Common: 1, Uncommon: 2, Rare: 3, Mythic: 4 };

/**
 * The label and sort rank a single level assigns to a card.
 * Returns { key, rank } -- key is what the user reads, rank orders the groups.
 */
export function levelKey(card, level, setsList = []) {
  const opts = level.opts || {};
  switch (level.by) {
    case 'type': {
      const k = typeGroup(card, opts.splitLands !== false);
      return { key: k, rank: TYPE_RANK[k] || 99 };
    }
    case 'color': {
      const k = colorGroup(card, opts.multiAsOne !== false);
      return { key: k, rank: COLOR_RANK[k] || 50 };
    }
    case 'set': {
      const k = card?.set_name || card?.set_id || 'Unknown set';
      // Release order, not alphabetical: a collection reads chronologically,
      // and this is the same list the backend files by.
      const idx = setsList.findIndex((s) => s.name === k || s.code === card?.set_id);
      return { key: k, rank: idx >= 0 ? idx : 999999 };
    }
    case 'rarity': {
      const k = card?.rarity || 'Unknown';
      return { key: k, rank: RARITY_RANK[k] || 99 };
    }
    case 'name': {
      const n = card?.name || '';
      return { key: (n[0] || '#').toUpperCase(), rank: 0 };
    }
    case 'price': {
      // Bands, not exact prices -- a group per distinct price is 2,626 groups.
      const p = card?.price_trend || 0;
      if (p >= 20) return { key: '$20+', rank: 1 };
      if (p >= 5) return { key: '$5 – $20', rank: 2 };
      if (p >= 1) return { key: '$1 – $5', rank: 3 };
      return { key: 'Under $1', rank: 4 };
    }
    default:
      return { key: '', rank: 0 };
  }
}

/**
 * Apply a stack to a list of cards, producing ordered groups.
 *
 * Returns [{ path: ['Creature','White'], label: 'Creature · White',
 *            cards: [...] }] in shelf order.
 *
 * An empty stack returns one unlabelled group holding everything -- an
 * unconfigured container still shows its cards rather than nothing.
 */
export function groupCards(cards, stack, setsList = []) {
  const list = Array.isArray(cards) ? cards : [];
  const levels = (Array.isArray(stack) ? stack : []).filter((l) => l && l.by);
  if (levels.length === 0) return [{ path: [], label: '', cards: list }];

  const buckets = new Map();
  for (const card of list) {
    const keys = levels.map((l) => levelKey(card, l, setsList));
    const id = keys.map((k) => k.key).join('\u0000');
    if (!buckets.has(id)) {
      buckets.set(id, {
        path: keys.map((k) => k.key),
        ranks: keys.map((k, i) => (levels[i].dir === 'desc' ? -k.rank : k.rank)),
        label: keys.map((k) => k.key).filter(Boolean).join(' \u00b7 '),
        cards: [],
      });
    }
    buckets.get(id).cards.push(card);
  }

  return [...buckets.values()].sort((a, b) => {
    for (let i = 0; i < a.ranks.length; i += 1) {
      if (a.ranks[i] !== b.ranks[i]) return a.ranks[i] - b.ranks[i];
      // Equal rank, different label: alphabetical, so two sets released the
      // same week do not swap places between renders.
      if (a.path[i] !== b.path[i]) return String(a.path[i]).localeCompare(String(b.path[i]));
    }
    return 0;
  });
}

// The levels a user may pick, for the editor's dropdown.
export const SORT_FIELDS = [
  { by: 'type', label: 'Type' },
  { by: 'color', label: 'Color' },
  { by: 'set', label: 'Set' },
  { by: 'rarity', label: 'Rarity' },
  { by: 'name', label: 'Name' },
  { by: 'price', label: 'Price' },
];

export const DEFAULT_STACK = [
  { by: 'type', dir: 'asc', opts: { splitLands: true } },
  { by: 'color', dir: 'asc', opts: { multiAsOne: true } },
  { by: 'set', dir: 'desc', opts: {} },
];
