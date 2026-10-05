// THE IMPORT LEDGER
//
// Zach: "tracking for what precon's I added to my collection. Because right now
// I have 2 more I want to add but I am unsure if I added them or not."
//
// WHAT THESE TESTS ARE ACTUALLY FOR. The failure mode is not "the table is
// missing" -- it is "the ledger silently stops being written while the import
// keeps working", because then the screen he trusts says NO for a precon he
// owns, which is worse than no feature at all. So the load-bearing tests here
// assert the COUPLING between adding cards and recording the import, not the
// existence of a route.
//
// Every one of these was mutation-tested: see tools/mutate-import-ledger.sh.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `bindarr-ledger-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../../src/db');

async function cleanup() {
  try { await db.close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch {}
  }
}

const SRC_RAW = fs.readFileSync(
  path.join(__dirname, '../../src/routes/products.js'), 'utf8');

// STRIP COMMENTS BEFORE ASSERTING ON CODE.
//
// This file is heavily commented, and the first version of IL-TC3 passed
// against a COMMENTED-OUT recordImport call: the mutation harness disabled the
// ledger write entirely and the test still went green. A guard that matches the
// prose explaining the rule instead of the rule itself is worse than no guard,
// because it reports confidence it has not earned.
function stripComments(src) {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
}

const SRC = stripComments(SRC_RAW);

// The picker component. Comments stripped for the same reason as SRC: this
// file explains its own rules at length, and a guard that matches the prose
// instead of the JSX proves nothing.
const UI_RAW = fs.readFileSync(
  path.join(__dirname, '../../../frontend/src/components/ProductImportModal.jsx'), 'utf8');
const UI = stripComments(UI_RAW);

async function runTests() {
  await db.initDb();

  // IL-TC1: the table exists with the columns the feature needs.
  try {
    const cols = await db.all(`PRAGMA table_info(import_ledger)`);
    assert.ok(cols.length, 'import_ledger table must exist');
    const names = cols.map(c => c.name);
    for (const required of ['user_id', 'kind', 'product_id', 'product_name',
                            'cards_added', 'source', 'added_at']) {
      assert.ok(names.includes(required), `import_ledger needs ${required}`);
    }
    console.log('PASS: IL-TC1');
  } catch (err) {
    console.error('FAIL: IL-TC1 -', err.message);
    throw err;
  }

  // IL-TC2: source is constrained. A row that is neither a real import nor a
  // declared manual entry has no meaning -- the whole value of this table is
  // that 'import' means the app really did it.
  try {
    await db.run(
      `INSERT INTO import_ledger (user_id, kind, product_name, source)
       VALUES (1, 'precon', 'Bogus', 'guessed')`);
    throw new Error('a bogus source was accepted');
  } catch (err) {
    if (/a bogus source was accepted/.test(err.message)) {
      console.error('FAIL: IL-TC2 -', err.message);
      throw err;
    }
    console.log('PASS: IL-TC2');
  }

  // IL-TC3: THE COUPLING. addCardsInOneTransaction must record the import
  // itself, so a route cannot add cards without writing the ledger row.
  //
  // This asserts the CALL inside the adder, not merely that recordImport is
  // defined somewhere -- a defined-but-uncalled function is exactly how this
  // feature would rot. Mutation: delete the recordImport(...) call and this
  // test must fail.
  try {
    const adder = SRC.slice(
      SRC.indexOf('async function addCardsInOneTransaction'),
      SRC.indexOf('async function recordImport'));
    assert.ok(adder.length > 0, 'could not locate addCardsInOneTransaction');
    assert.match(adder, /ledger\s*=\s*await\s+recordImport\s*\(/,
      'addCardsInOneTransaction must call recordImport');
    // and it must happen INSIDE the transaction, before it closes.
    const txEnd = adder.indexOf('}, { timeoutMs');
    assert.ok(txEnd > 0, 'could not locate the transaction close');
    assert.ok(adder.indexOf('recordImport(') < txEnd,
      'recordImport must run inside the transaction, not after it');
    console.log('PASS: IL-TC3');
  } catch (err) {
    console.error('FAIL: IL-TC3 -', err.message);
    throw err;
  }

  // IL-TC4: BOTH callers pass a descriptor.
  //
  // The precon path and the orders path are two routes into one write. This
  // project has already shipped a fix to one caller and left the other
  // (the repoint preview), producing a feature that was silently half-there.
  // A descriptor-less call would insert a row with a NULL product_name.
  //
  // ASSERT THE PROPERTY AT EACH CALL SITE, NOT A STRING THAT EXISTS SOMEWHERE.
  // The first version matched /kind:\s*'order'/ against the whole file and
  // passed while the orders descriptor was broken -- there is an unrelated
  // `kind: 'order'` elsewhere in this file that satisfied it. A guard anchored
  // to a shape rather than the intended case goes vacuous exactly like this.
  try {
    const decl = 'async function addCardsInOneTransaction';
    const sites = [];
    let from = SRC.indexOf(decl) + decl.length;
    for (;;) {
      const at = SRC.indexOf('addCardsInOneTransaction(', from);
      if (at === -1) break;
      // Read the full argument list of THIS call by balancing parentheses.
      let depth = 0, end = SRC.indexOf('(', at);
      const open = end;
      do {
        if (SRC[end] === '(') depth++;
        else if (SRC[end] === ')') depth--;
        end++;
      } while (depth > 0 && end < SRC.length);
      sites.push(SRC.slice(open, end));
      from = end;
    }
    assert.strictEqual(sites.length, 2,
      `expected 2 call sites, found ${sites.length} -- a new caller must pass a descriptor`);
    for (const [i, args] of sites.entries()) {
      // Three arguments, the third being a descriptor object with the fields
      // the ledger row cannot be written without.
      assert.match(args, /kind:/,
        `call site ${i + 1} passes no kind -- descriptor missing`);
      assert.match(args, /productName:/,
        `call site ${i + 1} passes no productName -- the row would be NULL`);
    }
    console.log('PASS: IL-TC4');
  } catch (err) {
    console.error('FAIL: IL-TC4 -', err.message);
    throw err;
  }

  // IL-TC5: a failed import writes NO ledger row.
  //
  // "Did I add this?" answered YES for a product whose cards all failed is the
  // single most damaging thing this table could do -- he would skip adding a
  // precon he does not own.
  try {
    const before = await db.get(`SELECT COUNT(*) n FROM import_ledger`);
    // recordImport's own rule: nothing added -> nothing recorded.
    const cardsAdded = [].reduce((n, a) => n + a.quantity, 0);
    assert.strictEqual(cardsAdded, 0);
    assert.match(SRC, /if\s*\(!cardsAdded\)\s*return null;/,
      'recordImport must refuse to log an import that added nothing');
    const after = await db.get(`SELECT COUNT(*) n FROM import_ledger`);
    assert.strictEqual(after.n, before.n, 'no row may be written');
    console.log('PASS: IL-TC5');
  } catch (err) {
    console.error('FAIL: IL-TC5 -', err.message);
    throw err;
  }

  // IL-TC6: a real row round-trips and reads back as an import.
  try {
    await db.run(
      `INSERT INTO import_ledger
         (user_id, kind, product_id, product_name, set_code, cards_added, rows_added, source)
       VALUES (1, 'precon', 'deathtoll_dsc', 'Death Toll', 'DSC', 100, 98, 'import')`);
    const row = await db.get(
      `SELECT * FROM import_ledger WHERE product_name = 'Death Toll'`);
    assert.strictEqual(row.cards_added, 100);
    assert.strictEqual(row.source, 'import');
    assert.ok(row.added_at, 'added_at must be stamped');
    console.log('PASS: IL-TC6');
  } catch (err) {
    console.error('FAIL: IL-TC6 -', err.message);
    throw err;
  }

  // IL-TC7: a manual backfill row is DISTINGUISHABLE from a real import.
  // His memory and the app's record must never be collapsed into one claim.
  try {
    await db.run(
      `INSERT INTO import_ledger (user_id, kind, product_name, cards_added, source, note)
       VALUES (1, 'precon', 'Remembered Deck', 0, 'manual', 'added before tracking')`);
    const row = await db.get(
      `SELECT source FROM import_ledger WHERE product_name = 'Remembered Deck'`);
    assert.strictEqual(row.source, 'manual');
    const real = await db.get(
      `SELECT source FROM import_ledger WHERE product_name = 'Death Toll'`);
    assert.notStrictEqual(row.source, real.source,
      'a backfill must not look identical to a verified import');
    console.log('PASS: IL-TC7');
  } catch (err) {
    console.error('FAIL: IL-TC7 -', err.message);
    throw err;
  }

  // IL-TC8: REACHABILITY. The ledger routes must be declared before the
  // parameterised product routes, or GET /ledger is swallowed by GET /:id/cards
  // and the feature is 0% reachable while every unit test passes.
  //
  // Asserted by matching against the real router stack, never by reading the
  // file order -- that is how this exact bug shipped for the orders routes.
  try {
    const router = require('../../src/routes/products.js');
    const match = (method, p) => {
      const layer = router.stack.find(
        (l) => l.route && l.route.methods[method] && l.regexp.test(p));
      return layer ? layer.route.path : 'NO MATCH';
    };
    assert.strictEqual(match('get', '/ledger'), '/ledger',
      'GET /ledger must not be swallowed by /:id/cards');
    assert.strictEqual(match('post', '/ledger'), '/ledger');
    assert.strictEqual(match('delete', '/ledger/7'), '/ledger/:entryId');
    // and the product routes still work
    assert.strictEqual(match('get', '/abc123/cards'), '/:id/cards');
    assert.strictEqual(match('get', '/orders/list'), '/orders/list');
    console.log('PASS: IL-TC8');
  } catch (err) {
    console.error('FAIL: IL-TC8 -', err.message);
    throw err;
  }

  // IL-TC9: deleting a ledger entry must not delete cards. The note and the
  // cardboard are separate facts.
  try {
    const handler = SRC.slice(SRC.indexOf("router.delete('/ledger/:entryId'"));
    const body = handler.slice(0, handler.indexOf('});'));
    assert.doesNotMatch(body, /FROM\s+collection/i,
      'deleting a ledger entry must never touch the collection');
    assert.match(body, /DELETE FROM import_ledger/);
    console.log('PASS: IL-TC9');
  } catch (err) {
    console.error('FAIL: IL-TC9 -', err.message);
    throw err;
  }
  // IL-TC10: hand-marking is GONE, route and all.
  //
  // Zach: "Now that I marked everything I needed added. Can we take away the
  // ability to manually add precons. Because at this point it should no longer
  // be needed."
  //
  // REMOVING THE BUTTON IS NOT REMOVING THE FEATURE. If POST /ledger still
  // wrote rows, the write would stay reachable and the next component wanting
  // a shortcut would find it. The ledger's value is that a row means the app
  // really did the import.
  try {
    const post = SRC.slice(SRC.indexOf("router.post('/ledger'"));
    const body = post.slice(0, post.indexOf('router.delete'));
    assert.doesNotMatch(body, /INSERT INTO import_ledger/,
      'the manual-mark route must no longer write ledger rows');
    assert.match(body, /MANUAL_LEDGER_REMOVED/,
      'the route must refuse explicitly rather than 404 by accident');
    // And the UI must not call it.
    assert.ok(!/markAdded/.test(UI),
      'markAdded must be DELETED, not merely unrendered');
    assert.ok(!/t\('product\.mark'\)/.test(UI),
      'the Mark added control must be gone from the picker');
    console.log('PASS: IL-TC10');
  } catch (err) {
    console.error('FAIL: IL-TC10 -', err.message);
    throw err;
  }

  // IL-TC11: UNMARK SURVIVES, and only for his own rows.
  //
  // Removing the undo alongside the action would make a mis-marked row
  // permanent -- the backfilled rows are still in the ledger. A VERIFIED
  // import still has no control at all: the app recorded that itself.
  //
  // ASSERT EACH RENDER SITE, NOT A COUNT OF MATCHES. The first version counted
  // `source === 'manual'` across the whole file, so disabling ONE gate still
  // left enough occurrences elsewhere to satisfy it -- both mutations passed
  // while a gate was off. Every unmark button is located and its own condition
  // checked.
  try {
    assert.match(UI, /unmark\(/, 'unmark must still be reachable');
    const sites = [...UI.matchAll(/className="pp-markbtn"/g)];
    assert.strictEqual(sites.length, 2,
      `expected exactly 2 unmark buttons, found ${sites.length}`);
    for (const [i, m] of sites.entries()) {
      // The JSX condition immediately preceding this button.
      const before = UI.slice(Math.max(0, m.index - 220), m.index);
      assert.match(before, /[Ee]ntry\??\.source === 'manual'\s*&&\s*\(/,
        `unmark button ${i + 1} must be gated on source === 'manual'`);
    }
    // The delete route is untouched.
    assert.match(SRC, /DELETE FROM import_ledger WHERE id = \? AND user_id = \?/,
      'the delete route must still work');
    console.log('PASS: IL-TC11');
  } catch (err) {
    console.error('FAIL: IL-TC11 -', err.message);
    throw err;
  }

  // IL-TC12: the mark control is NOT nested inside the row button.
  //
  // `.pp-prod` and `.pp-edopt` are both <button>. A button inside a button is
  // invalid HTML: the browser unnests it and the inner control silently stops
  // being clickable -- rendered, present in the DOM, and unreachable. That is
  // this project's recurring UI failure, so it is asserted structurally.
  try {
    for (const cls of ['pp-prod', 'pp-edopt']) {
      const at = UI.indexOf(`className="${cls}"`);
      assert.ok(at > 0, `${cls} not found`);
      const close = UI.indexOf('</button>', at);
      const inner = UI.slice(at, close);
      assert.ok(!/pp-markbtn/.test(inner),
        `the mark button must NOT be nested inside the ${cls} button`);
    }
    assert.match(UI, /className="pp-prodrow"/, 'product rows need a sibling wrapper');
    assert.match(UI, /className="pp-edrow"/, 'edition rows need a sibling wrapper');
    console.log('PASS: IL-TC12');
  } catch (err) {
    console.error('FAIL: IL-TC12 -', err.message);
    throw err;
  }

  // IL-TC13: nothing in the ledger routes writes cards.
  //
  // The manual-mark route is gone, but the rule it existed under still holds
  // for everything on this router: recording history must never put cardboard
  // on his shelf.
  try {
    const post = SRC.slice(SRC.indexOf("router.post('/ledger'"));
    const body = post.slice(0, post.indexOf('router.delete'));
    assert.doesNotMatch(body, /INSERT INTO collection/i,
      'a ledger route must never write collection rows');
    assert.doesNotMatch(body, /addCardToCollection|addCardsInOneTransaction/,
      'a ledger route must not call the card adder');
    console.log('PASS: IL-TC13');
  } catch (err) {
    console.error('FAIL: IL-TC13 -', err.message);
    throw err;
  }

  // IL-TC17: every badge is green.
  //
  // Zach: "can you make all the badges show green so they stand out"
  //
  // The muted grey on hand-marked rows made his own backfill nearly invisible.
  // The honest distinction stays in the TEXT ("Added Oct 5" vs "Marked added"),
  // not in a colour he has to squint at.
  try {
    const css = fs.readFileSync(
      path.join(__dirname, '../../../frontend/src/index.css'), 'utf8');
    assert.ok(!/\.pp-added\.manual\s*\{/.test(css),
      'the muted manual badge variant must be gone');
    const rule = css.slice(css.indexOf('.pp-added {'),
                           css.indexOf('}', css.indexOf('.pp-added {')) + 1);
    assert.match(rule, /color:\s*#7ddc9a/,
      'the single .pp-added rule must carry the green colour itself');
    console.log('PASS: IL-TC17');
  } catch (err) {
    console.error('FAIL: IL-TC17 -', err.message);
    throw err;
  }
  // IL-TC14: added products sort to the top BEFORE the result limit.
  //
  // Zach: "uhhh you are missing decks marked as added. Explorers of the deep is
  // marked as added and isnt at the top. ALL DECKS marked as added should be at
  // the top"
  //
  // The first version sorted in the COMPONENT and was wrong in a way the tests
  // could not see: the search matches 611 products and returns 40, so a
  // client-side sort reorders only what arrived. "Explorers of the Deep" (LCC,
  // 2023) ranked ~#200 by release date and was never in the response at all.
  //
  // THE SORT AND THE LIMIT MUST BE IN THE SAME PLACE. Asserted by CALLING the
  // real searchProducts against a stub catalogue, not by reading its source.
  //
  // Source-text assertions went vacuous twice here: `sortAt < sliceAt` still
  // held when a no-op sort was appended after the slice, and matching the word
  // `addedPastCut` still held when the returned value stopped using it. Only
  // running the function catches those.
  try {
    const svc = require('../../src/services/mtgjsonProducts.js');

    // A catalogue where the ADDED product is far past the limit by date.
    const fake = [];
    for (let i = 0; i < 60; i++) {
      fake.push({ id: `NEW${i}`, name: `New ${i}`, kind: 'precon',
        setCode: 'AAA', setName: 'A', releaseDate: `2026-${String((i % 12) + 1).padStart(2, '0')}-01` });
    }
    fake.push({ id: 'LATE', name: 'Explorers of the Deep', kind: 'precon',
      setCode: 'LCC', setName: 'Lost Caverns', releaseDate: '2023-01-01' });

    const unsorted = await svc.searchProducts('', { catalogue: fake, addedIds: new Set() });
    assert.ok(!unsorted.groups.some((g) => g.base === 'Explorers of the Deep'),
      'precondition: the 2023 product must fall outside the default limit');

    const sorted = await svc.searchProducts('', { catalogue: fake, addedIds: new Set(['LATE']) });
    const names = sorted.groups.map((g) => g.base);
    assert.ok(names.includes('Explorers of the Deep'),
      'an ADDED product beyond the limit must still be returned');
    assert.strictEqual(names[0], 'Explorers of the Deep',
      'added products must come FIRST, ahead of newer unadded ones');
    // and the newest-first rule still holds among the unadded remainder
    const dates = sorted.groups.slice(1).map((g) => g.editions[0].releaseDate);
    assert.deepStrictEqual(dates, [...dates].sort().reverse(),
      'unadded products must stay newest-first');

    // MORE ADDED PRODUCTS THAN THE LIMIT. Once he has marked more than `limit`
    // products, the added ones stop fitting in the head and the overflow is the
    // only thing keeping them visible -- "ALL DECKS marked as added should be
    // at the top", not "the first 40 of them".
    const manyAdded = new Set(fake.slice(0, 50).map((p) => p.id));
    const over = await svc.searchProducts('', { catalogue: fake, addedIds: manyAdded });
    const returned = new Set(over.groups.map((g) => g.editions[0].id));
    const missingAdded = [...manyAdded].filter((id) => !returned.has(id));
    assert.deepStrictEqual(missingAdded, [],
      `every added product must be returned even past the limit (${missingAdded.length} dropped)`);

    // POSITION, NOT MERELY PRESENCE.
    //
    // Deleting the added-first comparison still left the 2023 product in the
    // response -- the past-the-cut overflow rescued it -- so a presence-only
    // assertion passed while it rendered in the WRONG PLACE, which is exactly
    // what Zach reported ("marked as added and isnt at the top"). Assert that
    // no unadded product appears above an added one.
    const flags = over.groups.map((g) => manyAdded.has(g.editions[0].id));
    const firstUnadded = flags.indexOf(false);
    if (firstUnadded !== -1) {
      assert.ok(!flags.slice(firstUnadded).includes(true),
        'no added product may render below an unadded one');
    }
    const singleFlags = sorted.groups.map((g) => g.editions[0].id === 'LATE');
    const firstPlain = singleFlags.indexOf(false);
    assert.ok(firstPlain === -1 || !singleFlags.slice(firstPlain).includes(true),
      'the added product must rank above every unadded one, not merely appear');

    // The route has to supply the ids, or the parameter is never exercised.
    assert.match(SRC, /SELECT product_id FROM import_ledger WHERE user_id = \? AND product_id IS NOT NULL/,
      'the search route must read the ledger');
    assert.match(SRC, /addedIds: new Set\(/, 'the route must pass addedIds down');
    // And the component must NOT re-sort: a second rule would hide a server
    // regression by agreeing on the rows that made it through.
    assert.ok(!/sortedGroups/.test(UI),
      'the component must not re-sort a truncated list');
    console.log('PASS: IL-TC14');
  } catch (err) {
    console.error('FAIL: IL-TC14 -', err.message);
    throw err;
  }

  // IL-TC15: a partial import records WHICH cards came in.
  //
  // Zach: "for my one manapool order I only received 7 of my 10 cards. When I
  // add just those 7 can you show them as added on the order screen so I dont
  // accidentally readd them"
  //
  // "This order was imported" cannot answer that -- a partial import is the
  // normal case for an order, so the per-card rows are the whole feature.
  try {
    const cols = await db.all(`PRAGMA table_info(import_ledger_cards)`);
    assert.ok(cols.length, 'import_ledger_cards must exist');
    const names = cols.map((c) => c.name);
    for (const req of ['ledger_id', 'user_id', 'product_id', 'scryfall_id', 'quantity']) {
      assert.ok(names.includes(req), `import_ledger_cards needs ${req}`);
    }
    const rec = SRC.slice(SRC.indexOf('async function recordImport'));
    const body = rec.slice(0, rec.indexOf('async function flagAgainstCatalogue'));
    assert.match(body, /INSERT INTO import_ledger_cards/,
      'recordImport must write the per-card rows');
    assert.match(body, /a\.scryfallId/,
      'the card rows must record the scryfall id actually added');
    console.log('PASS: IL-TC15');
  } catch (err) {
    console.error('FAIL: IL-TC15 -', err.message);
    throw err;
  }

  // IL-TC16: the card list reports what was already taken, and the UI cannot
  // silently re-add it.
  //
  // A LABEL ALONE IS NOT ENOUGH: if the seven received cards stay ticked, the
  // Add button is still primed to import all ten. The already-taken rows must
  // start EXCLUDED, and "Select all" must not re-tick them -- that button would
  // otherwise hand the double-add straight back.
  try {
    assert.match(SRC, /async function flagAlreadyImported/,
      'the card endpoints need an already-imported flag');
    // BOTH card endpoints, not just orders -- precons can be partially added too.
    const calls = [...SRC.matchAll(/flagAlreadyImported\(/g)];
    assert.ok(calls.length >= 3,
      `both /:id/cards and /orders/:id/cards must flag (found ${calls.length - 1} call sites)`);
    // A COUNT, not a boolean: 1 of 2 received must not read as done.
    assert.match(SRC, /alreadyAdded:/, 'cards must carry an alreadyAdded count');
    assert.match(UI, /c\.alreadyAdded >= c\.quantity/,
      'only FULLY taken cards may be auto-excluded');
    assert.match(UI, /setExcluded\(new Set\(\(body\.cards \|\| \[\]\)/,
      'already-taken cards must start unticked');
    // Select all must respect it.
    const selAll = UI.slice(UI.indexOf("t('product.selectAll')") - 400,
                            UI.indexOf("t('product.selectAll')"));
    assert.match(selAll, /alreadyAdded >= c\.quantity/,
      'Select all must not re-tick cards already received');
    console.log('PASS: IL-TC16');
  } catch (err) {
    console.error('FAIL: IL-TC16 -', err.message);
    throw err;
  }
}

runTests()
  .then(async () => { await cleanup(); console.log('\nAll import ledger tests passed'); })
  .catch(async (err) => { await cleanup(); console.error('\nTest failure:', err.message); process.exit(1); });
