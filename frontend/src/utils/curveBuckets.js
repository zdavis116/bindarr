// WHERE A CARD SITS ON THE CURVE.
//
// Extracted from CurveTab.jsx so it can be tested directly: node --test cannot
// import .jsx, and this logic earned a test the hard way -- Zach found Kefka,
// Court Mage sitting in the ZERO bucket because his transform back face has no
// cost and the split rule took the cheaper half.
//
// See curveBuckets.test.js.

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
