// AN ESTIMATE HE CAN ACT ON, FROM PRICES WE ALREADY HAVE.
//
// Zach killed the optimizer integration himself: "I also feel like the price it
// isn't worth it either. Because you are preparing it for nothing. I would
// rather when I go to export tell me what the cost would be if I was to export
// for manapool using the cheapest prices you have. Obviously won't be exact
// because shipping cost but it gives an idea."
//
// He was right on the facts as well as the feel:
//   * POST /buyer/orders/pending-orders creates a CHECKOUT with a paymentIntent,
//     not a cart -- his cart stayed empty, and the only way to finish it is
//     /purchase, which spends real money
//   * Mana Pool exposes NO cart API (/buyer/cart, /cart, /buyer/basket,
//     /buyer/carts all 404; GET /pending-orders is 405)
//   * the optimizer took ~40s and was capped at ~3 calls/minute
//
// This replaces it with arithmetic over stored prices, and these guards cover
// the parts that can silently lie.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';

const decks = readFileSync(new URL('../src/routes/decks.js', import.meta.url), 'utf8');
const buylist = readFileSync(new URL('../src/manaPoolBuylist.js', import.meta.url), 'utf8');
const modal = readFileSync(
  new URL('../../frontend/src/components/ExportModal.jsx', import.meta.url), 'utf8');

test('EST-TC1: the estimate never calls Mana Pool', () => {
  // The whole point: it answers instantly from prices refreshed every 6 hours.
  // A network call here would reintroduce the 40-second wait he rejected.
  assert.ok(!/https?:\/\/manapool\.com/.test(buylist),
    'the pricing module must not talk to the marketplace at all');
  assert.ok(!/require\('https'\)/.test(buylist),
    'and must not carry HTTP plumbing');
});

test('EST-TC2: Bindarr never creates an order or spends money', () => {
  // The pending-order and purchase endpoints are both gone. This is the guard
  // that must survive every future refactor.
  //
  // Checks CODE, not prose. My first version scanned the whole file and failed
  // on correct code, because the comments explaining WHY those endpoints were
  // removed necessarily name them. A guard that fires on its own documentation
  // teaches you to ignore it -- this is the third time on this branch.
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');

  for (const [name, src] of [['pricing module', buylist], ['deck routes', decks]]) {
    const code = strip(src);
    for (const forbidden of ['pending-orders', 'purchase', 'paymentIntent', 'optimizer']) {
      assert.ok(!code.includes(forbidden),
        `${forbidden} must not appear in executable ${name} code`);
    }
  }
});

test('EST-TC2b: no dead strings left behind by removed features', () => {
  // A locale key that looks live and is not is how a test in this project once
  // passed while asserting the wrong thing. Removing a feature means removing
  // its words, in every language -- otherwise the next person wiring up
  // "Send to Mana Pool cart" finds a ready-made string and assumes it works.
  const localeDir = new URL('../../frontend/src/locales/', import.meta.url);
  const en = JSON.parse(readFileSync(new URL('en.json', localeDir), 'utf8'));

  // Every source file, so a key used anywhere counts as live.
  const srcDir = new URL('../../frontend/src/', import.meta.url);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((f) => {
    const p = new URL(f.name + (f.isDirectory() ? '/' : ''), dir);
    if (f.isDirectory()) return f.name === 'locales' ? [] : walk(p);
    return /\.jsx?$/.test(f.name) ? [readFileSync(p, 'utf8')] : [];
  });
  const all = walk(srcDir).join('\n');

  const orphans = Object.keys(en)
    .filter(k => /^(deck\.mp|settings\.ship|settings\.manapool)/.test(k))
    .filter(k => !all.includes(k));
  assert.deepEqual(orphans, [],
    `these Mana Pool strings are referenced by nothing: ${orphans.join(', ')}`);
});

test('EST-TC3: a card with no price is NAMED, not costed at zero', () => {
  // Rounding an unpriced card to zero would make the deck look cheaper than it
  // is -- the same class of lie as a total that hides its source.
  assert.match(decks, /unpriced\.push\(/,
    'unpriced cards must be collected');
  assert.match(decks, /unpriced,/,
    'and returned to the screen');
  assert.match(modal, /estimate\.unpriced\?\.length > 0/,
    'and the UI must show them');
});

test('EST-TC3b: a PINNED card keeps its marketplace price', () => {
  // Zach: "When choosing some cards for exact printing the deck as it says
  // manapool doesn't have a price which I know is wrong."
  //
  // He was right. availabilityForDeck resolves a marketplace price for every
  // row, but buylistForDeck built its line WITHOUT copying price_trend across.
  // Flexible cards hid it, because substitution looks the price up again --
  // only PINNED cards arrived priceless and were reported as "Mana Pool has no
  // price for", which is a claim about the marketplace that was simply false.
  const identity = readFileSync(
    new URL('../src/utils/deckIdentity.js', import.meta.url), 'utf8');
  const line = identity.slice(identity.indexOf('byVariant.set(key, {'),
                              identity.indexOf('byVariant.set(key, {') + 1800);
  assert.match(line, /price_trend: entry\.price_trend/,
    'the buylist line must carry the resolved price');
  assert.match(line, /price_source: entry\.price_source/,
    'and its provenance, so a price is never anonymous');
});

test('EST-TC4: the estimate states that shipping is excluded', () => {
  // Shipping genuinely cannot be known until checkout -- it depends on how the
  // order splits across sellers. Presenting this as a final price would be the
  // same mistake as the $34.37 he could not find on their site.
  assert.match(decks, /excludes_shipping: true/,
    'the payload must say so');
  assert.match(modal, /mpEstExcludesShipping/,
    'and the screen must render it');
});

test('EST-TC5: the estimate prices the printing it would actually export', () => {
  // If the estimate used the deck's listed printing while the exported text used
  // a cheaper substitute, the number and the list would disagree.
  assert.match(decks, /chooseCheapestPrintings\(db,/,
    'substitution must run before the total is computed');
  assert.match(decks, /Number\.isFinite\(r\.substituted_price\)\s*\?\s*r\.substituted_price/,
    'and the substituted price must be the one counted');
});

test('EST-TC6: substitution is one query for the whole list, not one per card', () => {
  // Calling it per card took 41 seconds, because db.js serialises every query
  // through a single operation queue. Same mistake as /api/stats' per-set loop.
  assert.match(buylist, /async function chooseCheapestPrintings\(database, cards\)/,
    'the chooser must take the whole list');
  const perCardLoop = /for \(const \w+ of items\)[\s\S]{0,200}await manaPoolBuylist\./;
  assert.ok(!perCardLoop.test(decks),
    'the route must not await the chooser inside a loop');
});

test('EST-TC7: every swap is reported', () => {
  // Any printing is now the DEFAULT, so a card he never touched can be swapped.
  // This is the only thing standing between him and different cardboard.
  //
  // The swaps USED to be listed in a summary block under the total. He called
  // that out as duplication -- "Why the fuck are both lists back I only wanted
  // one" -- because each row already shows its own swap. So the rule did not
  // change, only where it is satisfied: every row states the printing it
  // resolved to and what it was before.
  assert.match(decks, /substitutions\.push\(/);
  assert.match(decks, /substitutions,/, 'and they must reach the response');
  assert.match(modal, /estimate\?\.substitutions\?\.find/,
    'each row must look up its own swap');
  assert.match(modal, /mpSwappedFrom/,
    'and say what the printing was before');
});

test('EST-TC9: the exported text names the printing we priced', () => {
  // Zach: "when I do the copy and paste it into manapool the set code and number
  // don't match the cheapest option you show it matches what the deck has like
  // your copy is just taking what the deck has set not the cheapest option."
  //
  // This was the feature failing at its last step. The rows showed the
  // substitute, the total was computed FROM the substitute, and then the text
  // was built straight off `cards` -- so the list he pasted into Mass Entry
  // asked for the deck's printings at prices he had never been shown.
  //
  // Everything upstream can be right and the deliverable still wrong. The one
  // artefact that leaves the app must agree with the screen that described it.
  const memo = modal.slice(modal.indexOf('const text = useMemo'),
                           modal.indexOf('const text = useMemo') + 1400);
  assert.match(memo, /chosen\.priced && estimate\?\.substitutions\?\.length/,
    'substitutions must be applied on a priced format');
  assert.match(memo, /set_id: m\[1\], number: m\[2\]/,
    'and must rewrite the set and collector number');
  assert.match(memo, /\}, \[cards, formatId, estimate\]\);/,
    'and the text must recompute when the estimate arrives -- otherwise it is '
    + 'built once from the deck printings and never corrected');
});

test('EST-TC10: the deck header explains its two totals', () => {
  // Zach: "where does that 142.51 come from that is on the deck... but when I go
  // to buylist it shows 126. Shouldn't it be 126? Or is that 142.51 the total
  // for the exact printings?"
  //
  // He read it right, and they reconcile to the cent: $142.51 as listed, minus
  // $15.26 across 25 cheaper printings, is $127.25. Neither figure was wrong --
  // but two totals for the same 49 cards on adjacent screens with no label is
  // the same failure as a price that appears nowhere on the vendor's page.
  //
  // He chose to keep the as-listed headline and SHOW the saving rather than
  // silently apply it.
  const view = readFileSync(
    new URL('../../frontend/src/components/DeckView.jsx', import.meta.url), 'utf8');
  assert.match(view, /buylist\/estimate/,
    'the header must read the same estimate the export sheet uses, not '
    + 'recompute a second opinion');
  assert.match(view, /costToFinish > cheapest \+ 0\.005/,
    'and only claim a saving when there genuinely is one');
  assert.match(view, /toFinishAsListed/,
    'the headline figure must say it is the printings the decklist names');
  assert.match(view, /toFinishCheapest/,
    'and the cheaper total must be shown beside it');
});

test('EST-TC8: Mass Entry opens only after the list is on the clipboard', () => {
  // Zach: "I do like the idea of just copying and sending me right to mass
  // entry." Opening the tab when the copy failed would land him on an empty
  // textarea with nothing to paste.
  assert.match(modal, /manapool\.com\/add-deck/,
    'the Mass Entry screen is the destination');
  const fn = modal.slice(modal.indexOf('const copyAndOpen'),
                         modal.indexOf('const copyAndOpen') + 900);
  const copyAt = fn.indexOf('clipboard.writeText');
  const openAt = fn.indexOf('window.open');
  assert.ok(copyAt > -1 && openAt > copyAt,
    'the clipboard write must happen before the tab opens');
  assert.match(fn, /return;\s*\/\/ no tab if the list is not on the clipboard/,
    'and a failed copy must abort before opening the tab');
});

console.log('buylist estimate guards passed');
