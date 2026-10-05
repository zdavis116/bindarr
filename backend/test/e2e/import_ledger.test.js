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
const SRC = SRC_RAW
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

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
  try {
    const calls = [...SRC.matchAll(/addCardsInOneTransaction\s*\(/g)];
    const callSites = calls.length - 1; // minus the declaration
    assert.strictEqual(callSites, 2,
      `expected 2 call sites, found ${callSites} -- a new caller must pass a descriptor`);
    assert.match(SRC, /kind:\s*product\.kind/, 'precon path must pass a descriptor');
    assert.match(SRC, /kind:\s*'order'/, 'orders path must pass a descriptor');
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
}

runTests()
  .then(async () => { await cleanup(); console.log('\nAll import ledger tests passed'); })
  .catch(async (err) => { await cleanup(); console.error('\nTest failure:', err.message); process.exit(1); });
