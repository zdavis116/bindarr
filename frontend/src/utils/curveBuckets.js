// WHERE A CARD SITS ON THE CURVE.
//
// Extracted from CurveTab.jsx so it can be tested directly: node --test cannot
// import .jsx, and this logic earned a test the hard way -- Zach found Kefka,
// Court Mage sitting in the ZERO bucket because his transform back face has no
// cost and the split rule took the cheaper half.
//
// See curveBuckets.test.js.

// LAYOUTS WHERE THE BACK FACE IS NOT A SPELL YOU CAST.
//
// Inverted on purpose. My first version listed the layouts that DO split, and
// it silently missed `prepare` -- 108 real cards in Zach's catalogue that work
// exactly like Adventure (Adventurous Eater {2}{B} // Have a Bite {B}). A
// whitelist of Magic mechanics is a list that goes stale every set.
//
// So the rule is now structural, matching what Zach actually asked for:
// EVERYTHING with two faces and two costs counts twice. Only these layouts are
// excluded, because their back face has no cost at all -- you flip to it, you
// never cast it, and counting it would invent a spell that is not in the deck.
const FLIP_ONLY_LAYOUTS = new Set(['transform', 'flip', 'meld', 'double_faced_token']);

// Why a second face appears on the curve, in words the card can show.
const NOTE_FOR_SECOND_FACE = {
  modal_dfc: 'mdfc-back',
  adventure: 'adventure-half',
  prepare: 'adventure-half',
  split: 'split-half',
};

/**
 * THE CURVE ENTRIES A CARD PRODUCES — usually one, sometimes two.
 *
 * Zach: "cards that have a flip side both cards should be counted in the mana
 * value like Tony stark should account for 2 and 6 because technically I still
 * need 6 mana to play his flip side."
 *
 * He is right, and it is specific to MODAL DFCs. Both faces are real spells
 * you cast and pay for, so a curve that shows only the {1}{U} front is hiding
 * a six-drop -- and the six-drop is exactly the kind of card a curve exists to
 * warn you about.
 *
 * NOT transform cards. Kefka's back face has no cost; you flip to it, you
 * never cast it. Counting that side would invent a spell that does not exist.
 *
 * NOT split cards either: Fire // Ice is ONE spell with two ways to cast it,
 * and you only ever cast one. Counting both would double the card.
 *
 * Returns an array of { mv, note, face } -- one per castable face.
 */
export function curveEntriesFor(card) {
  const layout = (card.layout || '').toLowerCase();
  const cost = card.mana_cost || '';

  // TWO COSTS YOU CAN ACTUALLY PAY = TWO ENTRIES.
  //
  // Zach: "EVERYTHING that has '2 cards' with 2 different mana values should
  // all be treated like tony stark // the invincible iron man."
  //
  // modal_dfc  Tony Stark {1}{U} / The Invincible Iron Man {4}{U}{R}
  // adventure  Sagu Wildling {4}{G} / Roost Seek {G}
  // split      Fire {1}{R} / Ice {1}{U}
  //
  // All three are one physical card offering two DIFFERENT spells at two
  // DIFFERENT costs, and you decide which to cast. A curve that shows one of
  // them is hiding a real play -- either a six-drop you must reach, or a
  // one-mana option you actually have on turn one.
  //
  // Split cards were previously collapsed to the cheaper half. That was my
  // call and it was wrong for the same reason: Fire at 2 and Ice at 2 happen
  // to match, but Wear {1}{R} // Tear {W} do not, and the curve only showed
  // one of them.
  // TWO FACES WITH TWO COSTS = TWO ENTRIES. Zach: "EVERYTHING that has
  // '2 cards' with 2 different mana values should all be treated like tony
  // stark // the invincible iron man."
  //
  // Structural, not a whitelist of mechanics: modal DFCs, Adventures, Omens,
  // splits and Prepare cards all qualify, and so will whatever the next set
  // invents. The only exclusions are layouts whose back face cannot be cast.
  if (!FLIP_ONLY_LAYOUTS.has(layout) && cost.includes('//')) {
    const halves = cost.split('//').map((h) => h.trim());
    const names = String(card.name || '').split('//').map((n) => n.trim());
    const types = String(card.type_line || '').split('//').map((s) => s.trim());

    // A face with no cost is not castable -- that is a transform back, and
    // those are filtered out before this runs. Guard anyway: an empty half
    // would otherwise become a phantom 0-drop, the Kefka bug again.
    const castable = halves
      .map((half, i) => ({ half, i }))
      .filter(({ half }) => /\{[^}]+\}/.test(half));

    if (castable.length > 1) {
      return castable.map(({ half, i }) => ({
        mv: manaValueOf(half),
        // Only the SECOND face is flagged. The first is an ordinary card and
        // a note on every one of these would be wallpaper.
        note: i === 0 ? null : NOTE_FOR_SECOND_FACE[layout] || 'second-face',
        faceIndex: i,
        // THE FACE'S OWN NAME, not the joined string. Zach: "Why does it say
        // Tony stark and not the invincible iron man because that's wrong."
        // The row IS the face, so it must be named as the face.
        faceName: names[i] || names[0] || card.name,
        faceType: types[i] || types[0] || card.type_line,
        faceCost: half,
      }));
    }
  }

  const single = bucketFor(card);
  return [{
    ...single,
    faceIndex: 0,
    faceName: String(card.name || '').split('//')[0].trim() || card.name,
    faceType: card.type_line,
    faceCost: cost,
  }];
}

export function bucketFor(card) {
  const cost = card.mana_cost || '';
  const type = card.type_line || '';
  const layout = (card.layout || '').toLowerCase();

  // TRANSFORM CARDS ARE NOT SPLIT CARDS.
  //
  // Kefka, Court Mage is '{2}{U}{B}{R}' on the front and NOTHING on the back --
  // it transforms, you never cast that side. Bindarr stores every face joined,
  // so the string is '{2}{U}{B}{R} // ', and taking the cheaper half made him a
  // ZERO-DROP. Zach: "his flip doesn't have a cost because he transforms so his
  // cost looks like 0 but in reality his cost is 5."
  //
  // Checked BEFORE the '//' branch, because the string looks split either way.
  // The layout field is what tells them apart.
  if (layout === 'transform' || layout === 'flip' || layout === 'meld') {
    const front = cost.split('//')[0];
    return { mv: manaValueOf(front), note: null };
  }

  // MODAL DFCs ARE TWO CASTABLE CARDS.
  //
  // Tony Stark is {1}{U}; The Invincible Iron Man is {4}{U}{R}. You pay for
  // both -- flipping him is casting the back face. Zach: "we need to be
  // treating them as separate cards since each has their own mana cost."
  //
  // The curve buckets the FRONT, because that is the turn the card first does
  // something, and the note says there is a second cost so the bar is not
  // quietly lying about the deck's top end.
  if (layout === 'modal_dfc' && cost.includes('//')) {
    const halves = cost.split('//').map((h) => manaValueOf(h));
    return { mv: halves[0], note: 'mdfc' };
  }

  // A split card's mana_cost is "{1}{R} // {1}{U}". Adventures print the same
  // way, and their creature half is the FIRST face.
  if (cost.includes('//')) {
    const halves = cost.split('//').map((h) => manaValueOf(h));
    const isAdventure = /adventure/i.test(type);
    const mv = isAdventure ? halves[0] : Math.min(...halves);
    return { mv, note: isAdventure ? 'adv' : '//' };
  }

  const mv = typeof card.cmc === 'number' ? card.cmc : manaValueOf(cost);
  if (/\{X\}/i.test(cost)) return { mv, note: 'X' };
  if (!cost && mv === 0) return { mv: 0, note: 'no cost' };
  return { mv, note: null };
}

// Sum a mana cost string. Hybrid and Phyrexian pips each count 1, matching the
// rules; {2/W} counts 2 because that is its mana value.
function manaValueOf(cost) {
  const symbols = (cost || '').match(/\{[^}]+\}/g) || [];
  let total = 0;
  for (const sym of symbols) {
    const body = sym.slice(1, -1);
    if (/^\d+$/.test(body)) { total += Number(body); continue; }
    if (body === 'X' || body === 'Y' || body === 'Z') continue;   // 0 off the stack
    const generic = body.split('/').find((p) => /^\d+$/.test(p));
    total += generic ? Number(generic) : 1;
  }
  return total;
}
