// COLOUR SCREW: can you actually cast the thing, not just afford it.
//
// handOdds.js answers "do I have N lands by turn N". That is necessary and not
// sufficient. Zach: "three lands that cannot cast your three-drop is not three
// mana." This answers the harder question: do those lands make the COLOURS the
// card needs.
//
// WHY SIMULATION AND NOT A FORMULA
//
// The obvious approach -- P(white) x P(blue) -- is wrong, and wrong in the
// direction that matters. Measured against 200,000 simulated hands:
//
//   no dual lands      naive product off by  +1.1pp   (tolerable)
//   dual-heavy base    naive product off by  -8.4pp   (badly pessimistic)
//
// because a Command Tower is a white source AND a blue source at once, so the
// two events are not independent. Multiplying would tell you a well-built
// manabase is worse than it is, which is the opposite of useful.
//
// Double pips make it worse again. {W}{W} needs TWO white sources, not one:
// with 14 sources that is 76% versus 37% -- a 39-point gap. Any number that
// ignores pip COUNTS is misleading exactly where casting is hardest.
//
// So: deal real hands, check the whole cost at once. Overlap, pip counts and
// "enough total lands" all fall out of that automatically.
//
// COST
//
// Simulating every card x every turn is ~600 cells and far too slow to run on
// render. It does not need to be: colour screw is a property of the MANABASE,
// so the headline is five per-colour numbers, and the per-CARD figure is
// computed only for the one card you are looking at.

const COLOURS = ['W', 'U', 'B', 'R', 'G'];

// A deterministic PRNG. Math.random() would make the same deck show slightly
// different odds on every render, which reads as a bug and destroys trust in
// every other number on the screen.
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const parseProduced = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const isLandCard = (card) => /\bland\b/i.test(card.type_line || '');

/**
 * What colours a card can produce, as a Set of WUBRG letters.
 *
 * FETCHLANDS are the awkward case: Scryfall gives Evolving Wilds, Fabled
 * Passage and friends `produced_mana: null`, because they produce no mana --
 * they fetch. Counted literally they would be dead sources, which is plainly
 * wrong: in practice a fetch gets whatever basic you are missing.
 *
 * They are credited with the colours THIS DECK'S BASICS can provide, which is
 * the honest approximation: a fetch in a deck with no Islands cannot find one.
 * `fetchColours` is passed in rather than assumed.
 */
export function sourceColours(card, fetchColours) {
  const produced = parseProduced(card.produced_mana);
  if (produced && produced.length) {
    return new Set(produced.filter((c) => COLOURS.includes(c)));
  }
  // No produced_mana AND it is a land that searches your library -> a fetch.
  if (isLandCard(card) && /search your library/i.test(card.oracle_text || '')) {
    return new Set(fetchColours || []);
  }
  return new Set();
}

/** The coloured pips in a mana cost: '{1}{W}{W}' -> { W: 2 }. */
export function pipsOf(manaCost) {
  // SPLIT CARDS ARE TWO COSTS, NOT ONE.
  //
  // Scryfall gives Fire // Ice as '{1}{R} // {1}{U}'. Parsed whole, that reads
  // as needing red AND blue at once -- which is never true, and the UI showed
  // it as 0% castable. You cast ONE half, so the relevant question is the
  // EASIER half: if you can cast Fire, the card is live in your hand.
  //
  // This matches how the curve already buckets split cards at the cheaper
  // half, so the two numbers agree instead of contradicting each other.
  const halves = String(manaCost || '').split('//');
  if (halves.length > 1) {
    const parsed = halves.map((half) => pipsOf(half));
    // Fewest total pips = easiest to cast. Ties keep the first half.
    return parsed.reduce((best, cur) => {
      const total = (p) => Object.values(p).reduce((s, n) => s + n, 0);
      return total(cur) < total(best) ? cur : best;
    });
  }

  const pips = {};
  for (const m of String(manaCost || '').matchAll(/\{([^}]+)\}/g)) {
    const sym = m[1].toUpperCase();
    // Hybrid ({W/U}) and Phyrexian ({W/P}) are payable more than one way, so
    // counting them as a hard requirement would understate castability. Left
    // out rather than guessed at -- see the caveat shown in the UI.
    if (sym.includes('/')) continue;
    if (COLOURS.includes(sym)) pips[sym] = (pips[sym] || 0) + 1;
  }
  return pips;
}

/**
 * Build the mana-source deck: one entry per card in the library, each either a
 * Set of colours it makes or null for a non-source.
 *
 * Only LANDS count. Mana rocks and dorks produce colour too, but they have to
 * be cast first and then survive -- folding them in as if they were lands in
 * play would flatter every deck. That limit is stated in the UI.
 */
export function manaSources(cards) {
  const live = (cards || []).filter((c) => c.board !== 'considering');

  // What a fetchland can find: the colours this deck's BASIC lands make.
  const fetchColours = new Set();
  for (const card of live) {
    if (!/basic/i.test(card.type_line || '')) continue;
    for (const colour of sourceColours(card, [])) fetchColours.add(colour);
  }

  const deck = [];
  let commanders = 0;
  for (const card of live) {
    const qty = card.quantity || 1;
    if (card.board === 'commander') { commanders += qty; continue; }
    const colours = isLandCard(card) ? sourceColours(card, fetchColours) : new Set();
    for (let i = 0; i < qty; i += 1) {
      deck.push(colours.size ? colours : null);
    }
  }
  return { deck, fetchColours, commanders };
}

/** How many sources of each colour the deck runs. The headline numbers. */
export function sourceCounts(cards) {
  const { deck } = manaSources(cards);
  const counts = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const src of deck) {
    if (!src) continue;
    for (const colour of src) counts[colour] += 1;
  }
  return counts;
}

/**
 * Can this hand pay these pips using at most `landLimit` lands?
 *
 * Assigns the SCARCEST colour first -- the colour with fewest capable sources
 * in hand. Taking them in cost order instead lets a dual that was the only
 * source of a rare colour get spent on a common one, which under-reports.
 */
function canPay(hand, pips, landLimit) {
  const pool = hand.filter(Boolean);
  const needed = Object.keys(pips);
  const scarcity = (c) => pool.filter((s) => s.has(c)).length;
  const order = needed.sort((a, b) => scarcity(a) - scarcity(b));

  let used = 0;
  for (const colour of order) {
    for (let i = 0; i < pips[colour]; i += 1) {
      const idx = pool.findIndex((s) => s.has(colour));
      if (idx === -1) return false;
      pool.splice(idx, 1);
      used += 1;
      if (used > landLimit) return false;
    }
  }
  return true;
}

/**
 * P(you can cast this card on `turn`): enough lands in play AND the right
 * colours among them.
 *
 * `trials` is the accuracy/speed trade. 4000 gives about +/-1.5pp at 95%
 * confidence, which is finer than the number is displayed to and fast enough
 * to run while you hover.
 */
export function castOdds(cards, card, turn, { trials = 4000, seed = 1 } = {}) {
  const pips = pipsOf(card.mana_cost);
  // MV, PREFERRING THE CURVE'S VALUE OVER RAW cmc.
  //
  // They disagree on split cards: Scryfall's cmc for Fire // Ice is 4 (both
  // halves), while the curve buckets it at 2 (the half you actually cast).
  // Reading cmc first made the check "4 > 2, return 0" and the card showed as
  // 0% castable -- correct arithmetic, wrong question.
  //
  // card.mv is the deliberate answer where one exists; cmc is the fallback.
  const mv = Math.max(0, Math.round(card.mv ?? card.cmc ?? 0));
  // You cannot cast a 5-drop on turn 3 however good the colours are.
  if (mv > turn) return 0;
  if (!Object.keys(pips).length) {
    // Colourless: only the land count matters, and handOdds already answers it.
    return null;
  }

  const { deck, commanders } = manaSources(cards);
  const library = deck.length;
  if (!library) return 0;

  const drawn = Math.min(7 + Math.max(0, turn - 1), library);
  const rng = makeRng(seed + turn * 7919 + (card.cmc || 0));
  void commanders;

  let hits = 0;
  const pool = deck.slice();
  for (let t = 0; t < trials; t += 1) {
    // Partial Fisher-Yates: shuffle only the cards actually drawn. A full
    // shuffle of 99 cards per trial is most of the cost for no benefit.
    const hand = [];
    for (let i = 0; i < drawn; i += 1) {
      const j = i + Math.floor(rng() * (library - i));
      const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
      hand.push(pool[i]);
    }
    const landsInHand = hand.filter(Boolean).length;
    if (landsInHand < turn) continue;
    if (canPay(hand, pips, turn)) hits += 1;
  }
  return hits / trials;
}

/**
 * The earliest turn this card is castable at least `threshold` of the time.
 * One number is easier to read at a glance than six, and "reliably castable on
 * turn 4" is the actual question when a three-drop keeps sitting in your hand.
 */
export function reliableTurn(cards, card, { threshold = 0.6, maxTurn = 10 } = {}) {
  // Same mv precedence as castOdds -- see the note there.
  const mv = Math.max(0, Math.round(card.mv ?? card.cmc ?? 0));
  for (let turn = Math.max(1, mv); turn <= maxTurn; turn += 1) {
    const p = castOdds(cards, card, turn);
    if (p == null) return null;
    if (p >= threshold) return { turn, p };
  }
  return null;
}

export { COLOURS };
