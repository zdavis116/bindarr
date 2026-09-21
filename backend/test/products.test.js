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
  // EVERY assertion carries its PR-TC tag. An untagged failure still fails the
  // suite, but the mutation harness cannot tell WHICH guard fired, so it reads
  // as a crash -- and a harness that cannot attribute a failure is one I would
  // start ignoring.
  assert.equal(svc.finishOf({ isFoil: true }), 'foil',
    'PR-TC3 isFoil must produce foil');
  assert.equal(svc.finishOf({ isFoil: false }), 'nonfoil',
    'PR-TC3 a nonfoil card must produce nonfoil');
  assert.equal(svc.finishOf({}), 'nonfoil',
    'PR-TC3 a card with no finish flags is nonfoil');
  // Etched wins: an etched card can also carry isFoil, and etched is the more
  // specific truth.
  assert.equal(svc.finishOf({ isEtched: true }), 'etched',
    'PR-TC3 isEtched must produce etched');
  assert.equal(svc.finishOf({ isFoil: true, isEtched: true }), 'etched',
    'PR-TC3 etched must win over foil');
  // THE NAME MUST NOT MATTER. "Hidden Pathways" has no "Foil" in its title and
  // is entirely foil; a card called "Foil Fighter" that is not foil must come
  // back nonfoil.
  assert.equal(svc.finishOf({ name: 'Foil Fighter', isFoil: false }), 'nonfoil',
    'PR-TC3 a name containing "foil" must not make a card foil');
  assert.equal(svc.finishOf({ name: 'Hidden Pathways', isFoil: true }), 'foil',
    'PR-TC3 a foil card with no "foil" in its name is still foil');

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

  // BEHAVIOUR, not a regex over the source.
  //
  // The first version of this test only scanned for a `.filter(...known)`
  // shape, and a mutation that filtered the list a slightly different way
  // sailed straight through. A source scan can only reject the spelling of the
  // bug I imagined.
  //
  // So the route handler is RUN, against a stubbed db and service: no network,
  // no fixture database, and the assertion is on what actually comes back.
  const routeSrc = fs.readFileSync(
    path.join(repo, 'backend/src/routes/products.js'), 'utf8');
  assert.match(routeSrc, /addableCards/,
    'PR-TC4 the count of addable cards must be reported separately');
}

// ---------------------------------------------------------------------------
// PR-TC10: A FOIL AND A NONFOIL ARE TWO ROWS, NEVER MERGED.
//
// They are different physical objects under this app's exact-only identity
// model: a foil Sol Ring does not substitute for a nonfoil one. A merge would
// silently turn "1 foil + 1 nonfoil" into "2 of something", and the collection
// would claim cards Zach does not own.
// ---------------------------------------------------------------------------
{
  const svcSrc = fs.readFileSync(
    path.join(repo, 'backend/src/services/mtgjsonProducts.js'), 'utf8');
  // Scope to fetchProductCards. There are two `const key =` lines in this file
  // -- the edition grouping key and the merge key -- and an unscoped search
  // grabbed the wrong one, asserting against a rule that was never in question.
  const mergeFn = svcSrc.slice(svcSrc.indexOf('async function fetchProductCards'));
  const keyLine = mergeFn.split('\n').find((l) => l.includes('const key ='));
  assert.ok(keyLine, 'PR-TC10 the merge must build an explicit key');
  assert.match(keyLine, /finish/,
    'PR-TC10 the merge key MUST include the finish, or foil and nonfoil merge');
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
  // The commit route must NOT read quantity or finish out of the request body:
  // a stale or tampered client must not be able to write a quantity the product
  // does not contain. It passes `chosen`, which came from the re-read.
  assert.doesNotMatch(add, /quantity:\s*req\.body/,
    'PR-TC8 quantity must come from the product, not the request body');
  assert.doesNotMatch(add, /finish:\s*req\.body/,
    'PR-TC8 finish must come from the product, not the request body');

  // The rules below moved into addCardsInOneTransaction when the Mana Pool
  // orders path needed the same behaviour. Assert them WHERE THEY LIVE -- a
  // test that keeps asserting the old location passes or fails for reasons
  // unrelated to the rule.
  const shared = src.slice(src.indexOf('async function addCardsInOneTransaction'),
    src.indexOf('async function flagAgainstCatalogue'));
  assert.match(shared, /quantity:\s*card\.quantity/,
    'PR-TC8 quantity must come from the card record');
  assert.match(shared, /finish:\s*card\.finish/,
    'PR-TC8 finish must come from the card record');
  // PR-TC11: ONE ROW OF N, NOT N ROWS OF ONE.
  //
  // addCardToCollection defaults to stackable:false. Omitting it added the
  // right 100 cards in the wrong SHAPE -- fifteen rows of "1x Island" instead
  // of one row of 15 -- and the API reported "Added 100 cards", true about the
  // count and silent about the shape. Only counting rows in the database found
  // it.
  assert.match(shared, /stackable:\s*true/,
    'PR-TC11 a product add must stack, or 15x Island becomes fifteen rows');
  // PR-TC12: ONE TRANSACTION FOR THE WHOLE PRODUCT.
  //
  // Not a micro-optimisation. Every db call goes through a serialized queue and
  // each addCardToCollection opens its own transaction, so 72 cards meant 72
  // queue round-trips -- 14 seconds of waiting against 25ms of actual SQL.
  // Bulk INSERT syntax, the obvious "fix", would have saved 9ms.
  assert.match(shared, /db\.withTransaction\(/,
    'PR-TC12 the whole product must be added in ONE transaction');
  const txAt = shared.indexOf('db.withTransaction(');
  const loopAt = shared.indexOf('for (const card of cards)');
  assert.ok(txAt >= 0 && loopAt > txAt,
    'PR-TC12 the per-card loop must run inside the transaction');
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
// MANA POOL ORDERS
// ---------------------------------------------------------------------------

// PR-TC14: THE ORDER ROUTES MUST BE REACHABLE.
//
// Express matches in declaration order and `/:id/cards` matches
// `/orders/list` with id="orders". Declared after the precon routes, every
// orders request was swallowed and looked for a product called "orders" --
// a feature that is fully built and completely unreachable, which is this
// project's most repeated bug class.
{
  const router = require('../src/routes/products.js');
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
  const ordersList = paths.indexOf('/orders/list');
  const productCards = paths.indexOf('/:id/cards');
  assert.ok(ordersList >= 0, 'PR-TC14 /orders/list must exist');
  assert.ok(ordersList < productCards,
    'PR-TC14 /orders/list must be declared BEFORE /:id/cards or it never matches');
  assert.ok(paths.indexOf('/orders/:id/cards') < productCards,
    'PR-TC14 /orders/:id/cards must be declared before /:id/cards');
  assert.ok(paths.indexOf('/orders/:id/add') < paths.indexOf('/:id/add'),
    'PR-TC14 /orders/:id/add must be declared before /:id/add');
}

// PR-TC15: ONLY WHAT SHIPPED.
//
// Zach: "Only what actually shipped -- don't add refunded/missing cards."
// An order can be partly refunded or replaced. Adding the ORDERED quantity
// would put cards in his collection a seller never sent, and he would not
// notice -- worse than the scanning this replaces.
{
  const src = fs.readFileSync(
    path.join(repo, 'backend/src/services/manapoolOrders.js'), 'utf8');
  assert.match(src, /shipped_quantity/,
    'PR-TC15 the orders service must read shipped_quantity');
  const fn = src.slice(src.indexOf('async function fetchOrderCards'));
  assert.match(fn, /const shipped = item\.shipped_quantity/,
    'PR-TC15 quantity must come from shipped_quantity');
  assert.match(fn, /quantity:\s*shipped/,
    'PR-TC15 the card quantity must BE the shipped count');
  // Scoped to the CARD RECORD. An unscoped search also hit the unit-price
  // division (price_cents / item.quantity), which is a legitimate use -- the
  // per-card price genuinely needs the ordered quantity. Asserting over the
  // whole function would have forced me to break correct code to satisfy a
  // test, which is how a guard starts lying.
  const cardRecord = fn.slice(fn.indexOf('cards.push({'), fn.indexOf('sellerUsername'));
  assert.doesNotMatch(cardRecord, /quantity:\s*item\.quantity\b/,
    'PR-TC15 must not use the ordered quantity as the card quantity');
  // Nothing in the function may fall back from shipped to ordered.
  assert.doesNotMatch(fn, /shipped_quantity\s*\?\?\s*item\.quantity/,
    'PR-TC15 must never fall back from shipped to ordered quantity');
  // A line that shipped nothing is skipped AND named.
  assert.match(fn, /if \(shipped <= 0\)/,
    'PR-TC15 a line that shipped nothing must be skipped');
  assert.match(fn, /skipped\.push/,
    'PR-TC15 skipped lines must be reported, never silently dropped');
}

// PR-TC16: CONDITION AND FINISH COME FROM THE ORDER DATA.
//
// Zach chose "use the real condition from the order -- NM, LP, MP, HP, DMG as
// bought", unlike a precon which is always Near Mint. Recording a played card
// as Near Mint overstates what he owns, and the price of his collection with
// it.
{
  const svc = require('../src/services/manapoolOrders.js');
  assert.equal(svc.CONDITION_BY_ID.NM, 'Near Mint');
  assert.equal(svc.CONDITION_BY_ID.LP, 'Lightly Played');
  assert.equal(svc.CONDITION_BY_ID.MP, 'Moderately Played');
  assert.equal(svc.CONDITION_BY_ID.HP, 'Heavily Played');
  assert.equal(svc.CONDITION_BY_ID.DMG, 'Damaged');
  // Mana Pool's "unspecified". Near Mint would be a flattering guess about a
  // card he can see and I cannot; Lightly Played is his stated floor.
  assert.equal(svc.CONDITION_BY_ID.UC, 'Lightly Played',
    'PR-TC16 an unspecified condition must not default to Near Mint');
  assert.equal(svc.FINISH_BY_ID.NF, 'nonfoil');
  assert.equal(svc.FINISH_BY_ID.FO, 'foil');
  assert.equal(svc.FINISH_BY_ID.EF, 'etched');

  const src = fs.readFileSync(
    path.join(repo, 'backend/src/services/manapoolOrders.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function fetchOrderCards'));
  assert.match(fn, /FINISH_BY_ID\[single\.finish_id\]/,
    'PR-TC16 finish must come from finish_id');
  assert.match(fn, /CONDITION_BY_ID\[single\.condition_id\]/,
    'PR-TC16 condition must come from condition_id');
}

// PR-TC17: A SEALED PRODUCT IN AN ORDER IS A BOX, NOT CARDS.
//
// Ordering a precon on Mana Pool gives one sealed line. Silently expanding it
// into 100 loose cards would be a decision he did not make -- and he may not
// have opened it.
{
  const src = fs.readFileSync(
    path.join(repo, 'backend/src/services/manapoolOrders.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function fetchOrderCards'));
  assert.match(fn, /mtg_sealed/,
    'PR-TC17 sealed products must be recognised');
  assert.match(fn, /reason: 'sealed'/,
    'PR-TC17 a sealed line must be skipped and NAMED');
}

// PR-TC18: A BAD TOKEN MUST NOT LOOK LIKE AN EMPTY ORDER HISTORY.
//
// They are different problems with different fixes. "You have no orders" would
// send him looking in entirely the wrong place.
{
  const src = fs.readFileSync(
    path.join(repo, 'backend/src/services/manapoolOrders.js'), 'utf8');
  assert.match(src, /res\.status === 401 \|\| res\.status === 403/,
    'PR-TC18 a 401/403 must be distinguished');
  assert.match(src, /class ManaPoolAuthError/,
    'PR-TC18 an auth failure needs its own error type');
  // And the service must never return an empty list on failure.
  assert.doesNotMatch(src, /catch[\s\S]{0,120}return \[\]/,
    'PR-TC18 a failure must never degrade into an empty list');
}

// PR-TC19: THE TOKEN NEVER LEAVES THE SERVER.
//
// It is stored in plaintext on his own tailnet, which is a deliberate choice --
// but a token echoed back to the browser can leak through a screenshot or a
// shared session, and that is avoidable.
{
  const settings = fs.readFileSync(
    path.join(repo, 'backend/src/routes/settings.js'), 'utf8');
  assert.doesNotMatch(settings, /SELECT[^;]*manapool_token[^;]*AS\s+token/i,
    'PR-TC19 the settings API must not return the raw token');
  assert.match(settings, /manapool_token/,
    'PR-TC19 settings must handle the token at all');
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
async function previewRouteCheck() {
// ---------------------------------------------------------------------------
// PR-TC4b: RUN THE PREVIEW ROUTE. Two of the product's cards are unknown to the
// catalogue; all of them must still come back.
// ---------------------------------------------------------------------------
{
  const Module = require('node:module');
  const origLoad = Module._load;
  const productsPath = require.resolve('../src/routes/products.js');
  delete require.cache[productsPath];

  const fakeCards = [
    { scryfallId: 'known-1', name: 'Sol Ring', finish: 'nonfoil', quantity: 1 },
    { scryfallId: 'known-2', name: 'Island', finish: 'nonfoil', quantity: 15 },
    { scryfallId: 'ghost-1', name: 'Unknown A', finish: 'nonfoil', quantity: 1 },
    { scryfallId: 'ghost-2', name: 'Unknown B', finish: 'foil', quantity: 1 },
  ];

  // Stub the two modules the route pulls in. Only `all` is stubbed on db: if
  // the route tried to WRITE, it would throw, which is itself the PR-TC6 rule.
  Module._load = function stub(request, parent, isMain) {
    if (request === '../db') {
      return {
        all: async (_sql, params) =>
          params.filter((p) => p.startsWith('known-')).map((id) => ({ id })),
        run: async () => { throw new Error('the preview route must not write'); },
      };
    }
    if (request === '../services/mtgjsonProducts') {
      return {
        fetchProductCards: async () => ({
          product: { id: 'p', name: 'Test Deck' },
          cards: fakeCards,
          totalCards: 18,
        }),
        searchProducts: async () => ({ total: 0, groups: [] }),
      };
    }
    if (request === './collection') {
      return { addCardToCollection: async () => ({ id: 1 }), AddCardError: Error };
    }
    return origLoad(request, parent, isMain);
  };

  let router;
  try { router = require('../src/routes/products.js'); }
  finally { Module._load = origLoad; delete require.cache[productsPath]; }

  // Find the GET /:id/cards handler on the router stack and invoke it.
  const layer = router.stack.find((l) => l.route?.path === '/:id/cards'
    && l.route.methods.get);
  assert.ok(layer, 'PR-TC4b the preview route must exist');

  const body = await new Promise((resolve, reject) => {
    const res = {
      json: resolve,
      status(code) { this._code = code; return this; },
    };
    layer.route.stack[0].handle({ params: { id: 'p' }, query: {} }, res, reject);
  });

  assert.equal(body.cards.length, 4,
    `PR-TC4b every card must come back, got ${body.cards.length} of 4`);
  assert.equal(body.cards.filter((c) => !c.inCatalogue).length, 2,
    'PR-TC4b the two unknown cards must be present and flagged');
  assert.deepEqual(body.cards.filter((c) => !c.inCatalogue).map((c) => c.name),
    ['Unknown A', 'Unknown B'],
    'PR-TC4b the unknown cards must be NAMED so they can be scanned by hand');
  // addableCards counts physical cards, not rows: 1 Sol Ring + 15 Island.
  assert.equal(body.addableCards, 16,
    `PR-TC4b addableCards must count cards, got ${body.addableCards}`);
  assert.equal(body.missingCount, 2,
    `PR-TC4b missingCount must count the unknown cards, got ${body.missingCount}`);
}
  console.log('PASS: PR-TC4b the preview route returns every card, unknown ones flagged');
}

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

  // PR-TC13: SEARCH BY SET.
  //
  // Zach searched "Duskmourn" and got nothing, because DeckList.json carries
  // only a set CODE ("DSC") and none of that set's four precons have the word
  // in their name. He had to already know "Death Toll" to find it, which
  // defeats browsing. Live, because it depends on the real join.
  const dusk = await svc.searchProducts('duskmourn', { kind: 'precon' });
  const names = dusk.groups.map((g) => g.base);
  assert.ok(dusk.groups.length >= 4,
    `PR-TC13 "duskmourn" must find its precons, got ${dusk.groups.length}`);
  for (const expected of ['Death Toll', 'Endless Punishment', 'Jump Scare!',
    'Miracle Worker']) {
    assert.ok(names.includes(expected),
      `PR-TC13 "duskmourn" must find ${expected}; got ${names.join(', ')}`);
  }
  // And every product must carry a readable set name, not just a code -- the
  // results row shows it, so a null would render as a bare bullet.
  const noSet = dusk.groups.filter((g) => !g.editions[0].setName);
  assert.equal(noSet.length, 0,
    `PR-TC13 every product needs a set name; ${noSet.length} had none`);
  // The code itself still works as an exact match.
  const byCode = await svc.searchProducts('DSC', { kind: 'precon' });
  assert.ok(byCode.groups.length >= 4,
    'PR-TC13 a set CODE must also match');

  console.log('PASS: PR-TC1 a precon resolves to exactly 100 cards');
  console.log('PASS: PR-TC2 quantities are per-card (15x Island is one row)');
  console.log('PASS: PR-TC13 searching a set name finds its precons');
}

console.log('PASS: PR-TC3 finish comes from data, never the product name');
console.log('PASS: PR-TC4 unknown cards are reported, never dropped');
console.log('PASS: PR-TC5 card_cache is never written');
console.log('PASS: PR-TC6 nothing is written until confirm');
console.log('PASS: PR-TC7 foil/nonfoil twins become one choice');
console.log('PASS: PR-TC8 commit re-reads the product, ignores posted values');
console.log('PASS: PR-TC9 the collection add-path is reused, not reimplemented');
console.log('PASS: PR-TC11 a product add stacks: one row of N, not N rows of one');
console.log('PASS: PR-TC12 the whole product is added in ONE transaction');
console.log('PASS: PR-TC14 the order routes are reachable, not shadowed');
console.log('PASS: PR-TC15 orders add only what actually shipped');
console.log('PASS: PR-TC16 condition and finish come from the order data');
console.log('PASS: PR-TC17 a sealed line is skipped and named, not expanded');
console.log('PASS: PR-TC18 a bad token is not an empty order history');
console.log('PASS: PR-TC19 the API token never leaves the server');

previewRouteCheck().then(liveChecks).then(() => process.exit(0))
  .catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
