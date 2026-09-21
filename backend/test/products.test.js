// ADD A PRODUCT (precon / Secret Lair) -> COLLECTION.
//
// The failures this guards are all silent ones: a collection that does not
// match the cards on the shelf looks exactly like a collection that does, and
// Zach would only find out when a deck said he owned something he did not.
//
// Run: node backend/test/products.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const svc = require('../src/services/mtgjsonProducts');

const here = __dirname;
const repo = path.resolve(here, '..', '..');

// ---------------------------------------------------------------------------
// PR-TC3: FINISH COMES FROM THE DATA, NEVER THE PRODUCT NAME.
//
// The single most dangerous rule here. "Hidden Pathways" carries no "Foil" in
// its title and is 100% foil; a name-based guess would record ten nonfoil cards
// Zach does not own. A foil and a nonfoil are different physical objects under
// this app's exact-only identity model.
// ---------------------------------------------------------------------------
{
  assert.equal(svc.finishOf({ isFoil: true }), 'foil');
  assert.equal(svc.finishOf({ isFoil: false }), 'nonfoil');
  assert.equal(svc.finishOf({}), 'nonfoil');
  // Etched wins: an etched card can also carry isFoil, and etched is the more
  // specific truth.
  assert.equal(svc.finishOf({ isEtched: true }), 'etched');
  assert.equal(svc.finishOf({ isFoil: true, isEtched: true }), 'etched');

  // And the rule is enforced in the SOURCE: nothing may read a name to decide
  // a finish. A regex over the service catches a future edit that reintroduces
  // it, which no unit assertion on finishOf() would notice.
  const src = fs.readFileSync(
    path.join(repo, 'backend/src/services/mtgjsonProducts.js'), 'utf8');
  const finishFn = src.slice(src.indexOf('function finishOf'),
    src.indexOf('function fetchProductCards'));
  assert.doesNotMatch(finishFn, /name|title/i,
    'PR-TC3 finishOf must not look at the product or card name');
}

// ---------------------------------------------------------------------------
// PR-TC7: the two editions of one drop are recognised as ONE product with a
// choice, not two unrelated rows. 332 of 751 drops are twins.
// ---------------------------------------------------------------------------
{
  assert.equal(svc.baseNameOf('A Box of Rocks Foil Edition'), 'A Box of Rocks');
  assert.equal(svc.baseNameOf('A Box of Rocks'), 'A Box of Rocks');
  assert.equal(svc.baseNameOf('vroooOOOMMMMMM! Raised Foil Edition'), 'vroooOOOMMMMMM!');
  assert.equal(svc.baseNameOf('Absolute Annihilation Foil Edition'), 'Absolute Annihilation');
  // A name that merely CONTAINS a finish word mid-string is not a suffix and
  // must survive intact, or real drops would be merged into the wrong group.
  assert.equal(svc.baseNameOf('Foil Fighters Assemble'), 'Foil Fighters Assemble');

  const groups = svc.groupEditions([
    { id: 'a', name: 'A Box of Rocks', kind: 'secretlair', releaseDate: '2024-01-01' },
    { id: 'b', name: 'A Box of Rocks Foil Edition', kind: 'secretlair', releaseDate: '2024-01-01' },
    { id: 'c', name: 'Making Fetch Happen', kind: 'secretlair', releaseDate: '2024-01-01' },
  ]);
  assert.equal(groups.length, 2, 'PR-TC7 twins must collapse into one group');
  const box = groups.find((g) => g.base === 'A Box of Rocks');
  assert.equal(box.editions.length, 2);
  // Plain edition first, so the default choice is the ordinary one.
  assert.equal(box.editions[0].name, 'A Box of Rocks');
  const fetch = groups.find((g) => g.base === 'Making Fetch Happen');
  assert.equal(fetch.editions.length, 1,
    'PR-TC7 a product with one edition must not be asked about');
}

// ---------------------------------------------------------------------------
// PR-TC5: THE IMPORT NEVER WRITES TO card_cache.
//
// That cache is the shared catalogue every price, legality and buylist trusts.
// A row written from a third party's product list becomes a permanent fake
// card. Import may only ADD collection rows pointing at entries that already
// exist -- the same rule the ManaBox import obeys.
// ---------------------------------------------------------------------------
{
  for (const f of ['backend/src/services/mtgjsonProducts.js',
    'backend/src/routes/products.js']) {
    const src = fs.readFileSync(path.join(repo, f), 'utf8');
    assert.doesNotMatch(src, /INSERT\s+(OR\s+\w+\s+)?INTO\s+card_cache/i,
      `PR-TC5 ${f} must never insert into card_cache`);
    assert.doesNotMatch(src, /UPDATE\s+card_cache/i,
      `PR-TC5 ${f} must never update card_cache`);
  }
}

// ---------------------------------------------------------------------------
// PR-TC6: NOTHING IS WRITTEN UNTIL CONFIRM.
//
// Zach chose "show me the list first, let me confirm or untick cards, then
// add". So the read routes must not mutate: only the POST may add.
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(repo, 'backend/src/routes/products.js'), 'utf8');
  const getCards = src.slice(src.indexOf("router.get('/:id/cards'"),
    src.indexOf("router.post('/:id/add'"));
  assert.doesNotMatch(getCards, /addCardToCollection/,
    'PR-TC6 the preview route must not add anything');
  assert.doesNotMatch(getCards, /INSERT\s+INTO/i,
    'PR-TC6 the preview route must not write');
  // And the commit route must exist and be the only writer.
  assert.match(src, /router\.post\('\/:id\/add'/,
    'PR-TC6 there must be an explicit commit route');
}

// ---------------------------------------------------------------------------
// PR-TC4: A CARD NOT IN THE CATALOGUE IS REPORTED, NEVER DROPPED.
//
// The mockup's screen 4. A silently dropped card means a 98-card precon and no
// idea which two are gone -- worse than the scanning it replaces, because he
// would not notice.
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(repo, 'backend/src/routes/products.js'), 'utf8');
  assert.match(src, /inCatalogue/,
    'PR-TC4 every card must carry an inCatalogue flag');
  assert.match(src, /missingCount/,
    'PR-TC4 the response must report how many cards cannot be added');
  // The cards array must be built from ALL cards, never filtered to the known
  // ones -- that filter is exactly how the drop would happen.
  const cardsRoute = src.slice(src.indexOf("router.get('/:id/cards'"),
    src.indexOf("router.post('/:id/add'"));
  assert.doesNotMatch(cardsRoute, /cards\s*\.filter\([^)]*known/,
    'PR-TC4 the returned list must not be filtered down to known cards');
}

// ---------------------------------------------------------------------------
// PR-TC8: the commit re-reads the product rather than trusting posted
// quantities. A stale or tampered client must not be able to write a quantity
// the product does not contain.
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(repo, 'backend/src/routes/products.js'), 'utf8');
  const add = src.slice(src.indexOf("router.post('/:id/add'"));
  assert.match(add, /fetchProductCards\(req\.params\.id\)/,
    'PR-TC8 the commit route must re-read the product');
  assert.match(add, /quantity:\s*card\.quantity/,
    'PR-TC8 quantity must come from the product, not the request body');
  assert.match(add, /finish:\s*card\.finish/,
    'PR-TC8 finish must come from the product, not the request body');
}

// ---------------------------------------------------------------------------
// PR-TC9: the collection add-path is REUSED, not reimplemented.
//
// addCardToCollection resolves the finish into the finish/printing column pair
// and refuses a finish it cannot represent. A second implementation would drift
// and the drift would be invisible.
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(repo, 'backend/src/routes/products.js'), 'utf8');
  assert.match(src, /require\('\.\/collection'\)/,
    'PR-TC9 products must reuse the collection add-path');
  assert.doesNotMatch(src, /INSERT\s+INTO\s+collection/i,
    'PR-TC9 products must not write collection rows directly');

  const collection = require('../src/routes/collection');
  assert.equal(typeof collection.addCardToCollection, 'function',
    'PR-TC9 addCardToCollection must be exported');
}

// ---------------------------------------------------------------------------
// PR-TC1 / PR-TC2: QUANTITY AND TOTALS, against the REAL source.
//
// These hit MTGJSON, because the failure they guard cannot be reproduced with a
// fixture I wrote: a fixture proves my parser reads my own file. The questions
// are "does a precon still come to 100?" and "is a 15x Swamp one row of 15 or
// fifteen rows of 1?" -- and only the real feed can answer them.
//
// Skipped with PRODUCTS_OFFLINE=1 so the suite still runs without a network.
// ---------------------------------------------------------------------------
async function liveChecks() {
  if (process.env.PRODUCTS_OFFLINE === '1') {
    console.log('SKIP: PR-TC1/PR-TC2 (PRODUCTS_OFFLINE=1)');
    return;
  }

  const found = await svc.searchProducts('Sneak Attack', { kind: 'precon' });
  const group = found.groups.find((g) => /^sneak attack$/i.test(g.base));
  assert.ok(group, 'PR-TC1 the Sneak Attack precon must be findable');

  const { product, cards, totalCards } = await svc.fetchProductCards(group.editions[0].id);

  // PR-TC1: a Commander precon is exactly 100 cards. Measured across six recent
  // decks; a total that drifts means rows were lost or double-counted.
  assert.equal(totalCards, 100,
    `PR-TC1 ${product.name} must total 100 cards, got ${totalCards}`);
  assert.equal(cards.reduce((n, c) => n + c.quantity, 0), 100,
    'PR-TC1 the normalised rows must also total 100');

  // PR-TC2: quantity is PER CARD. 15x Island is one row carrying fifteen, not
  // fifteen rows -- the whole reason this beats scanning.
  const island = cards.find((c) => c.name === 'Island');
  assert.ok(island, 'PR-TC2 the deck must contain Island');
  assert.equal(island.quantity, 15,
    `PR-TC2 Island must be one row of 15, got ${island.quantity}`);
  assert.equal(cards.filter((c) => c.name === 'Island').length, 1,
    'PR-TC2 Island must not be split across rows');

  // Every row must carry an exact printing id, or it cannot be added at all.
  assert.equal(cards.filter((c) => !c.scryfallId).length, 0,
    'PR-TC2 every row must carry a scryfall printing id');

  // The real foil case: this deck's commander is foil and the rest is not.
  const foils = cards.filter((c) => c.finish !== 'nonfoil');
  assert.equal(foils.length, 1,
    `PR-TC3 expected exactly one foil row, got ${foils.length}`);
  assert.equal(foils[0].name, 'Anowon, the Ruin Thief');

  console.log('PASS: PR-TC1 a precon resolves to exactly 100 cards');
  console.log('PASS: PR-TC2 quantities are per-card (15x Island is one row)');
}

console.log('PASS: PR-TC3 finish comes from data, never the product name');
console.log('PASS: PR-TC4 unknown cards are reported, never dropped');
console.log('PASS: PR-TC5 card_cache is never written');
console.log('PASS: PR-TC6 nothing is written until confirm');
console.log('PASS: PR-TC7 foil/nonfoil twins become one choice');
console.log('PASS: PR-TC8 commit re-reads the product, ignores posted values');
console.log('PASS: PR-TC9 the collection add-path is reused, not reimplemented');

liveChecks().then(() => process.exit(0))
  .catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
