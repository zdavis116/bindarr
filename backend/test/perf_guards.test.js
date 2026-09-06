// PERFORMANCE GUARDS.
//
// Zach: "I want performance to be a new feature branch and yeah I would like
// you measure a bunch of load times across the app especially the catalogue
// because I want to make sure in the future it can handle 10k cards."
//
// These pin the SHAPE of three fixes, not their timings. A wall-clock assertion
// would be flaky on a shared box and would fail for reasons unrelated to the
// code -- but the structures that made things slow are exactly reproducible, so
// those are what get asserted.
//
// Measured before/after, dev box, copy of the real database:
//   deck list      691ms -> 15ms  at 2,438 collection rows
//   deck list     1745ms -> 22ms  at 10,000
//   collection    3.6 MB -> pageable, 663 KB of dead URLs removed
//   catalogue swap  one 25s lock  -> 2,000-row batches

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = f => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8');
const strip = s => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('--')).join('\n');

const decks = read('routes/decks.js');
const collection = read('routes/collection.js');
const catalogue = read('cardCatalogue.js');

// The deck-list query only, so a correlated subquery elsewhere in the file
// cannot make this pass or fail by accident.
function deckListQuery() {
  const i = decks.indexOf("router.get('/', async (req, res) => {");
  const start = decks.indexOf('db.all(`', i);
  return strip(decks.slice(start, decks.indexOf('`,', start)));
}

test('DECK-TC-PERF1: the deck list does not re-scan the collection per row', () => {
  // THE ORIGINAL SHAPE: five correlated subqueries inside SUM(), so collection
  // and card_cache were rescanned for every deck_cards row -- cost grew with
  // (decks x cards x collection). The rewrite pre-aggregates supply ONCE.
  const q = deckListQuery();

  assert.match(q, /WITH\b/, 'the rewrite is CTE-based');
  for (const cte of ['req AS', 'supply AS', 'claims AS', 'resolved AS']) {
    assert.match(q, new RegExp(cte), `the ${cte} pass must exist`);
  }

  // The tell-tale of the old shape: a SELECT against collection sitting inside
  // the aggregate, correlated to the outer row.
  assert.doesNotMatch(q, /SUM\(\s*\n?\s*CASE WHEN dc\.board/,
    'no per-row CASE/SUM over deck_cards -- that was the correlated shape');
  assert.doesNotMatch(q, /o\.id < dc\.id/,
    'higher-priority claims must come from a window function, not a correlated subquery');
  assert.match(q, /ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING/,
    'claims are an exclusive running total: a requirement never claims against itself');
});

test('DECK-TC-PERF2: basic-land pooling survived the rewrite', () => {
  // The completion ring has burned him twice. Pooling is the rule that makes a
  // Mountain a Mountain across printings and finishes, and it must match
  // deckIdentity.js -- if these disagree the deck list and deck view report
  // different completion for the same deck.
  const q = deckListQuery();
  assert.match(q, /type_line LIKE 'Basic Land%'/,
    'basics must still be detected');
  assert.match(q, /'basic:' \|\| dcc\.name/,
    'a requirement for a basic must key on NAME, pooling every printing');
  assert.match(q, /'basic:' \|\| ucc\.name/,
    'and the supply side must pool the same way, or the two halves disagree');
  assert.match(q, /'exact:' \|\| dc\.desired_card_id \|\| ':' \|\| COALESCE\(dc\.desired_finish/,
    'non-basics stay keyed on the exact printing AND finish');
});

test('DECK-TC-PERF3: completion and missing_cost use ONE ownership rule', () => {
  // THE BUG THE REWRITE EXPOSED. The old query pooled basics for the ring but
  // matched the exact printing for missing_cost, so "I Am Iron Man" read 100%
  // built AND asked him to buy 6 Islands he already owned (47.41 vs 46.57).
  //
  // Two figures on one row derived from two different rules is a disagreement
  // waiting to surface; both now read the same `resolved` rows.
  const q = deckListQuery();
  const costMatch = q.match(/AS missing_cost/);
  assert.ok(costMatch, 'missing_cost must exist');

  // Everything the deck row reports must come from the shared CTE.
  for (const field of ['owned_cards', 'missing_cost', 'deck_value', 'total_cards']) {
    const idx = q.indexOf(`AS ${field}`);
    const expr = q.slice(Math.max(0, idx - 220), idx);
    assert.match(expr, /FROM resolved r/,
      `${field} must read the shared resolved rows, not its own ownership rule`);
  }
  // And specifically: no second, exact-printing-only ownership lookup.
  assert.doesNotMatch(q, /uc\.card_id = dc\.desired_card_id\s*\n?\s*AND uc\.finish = dc\.desired_finish/,
    'the exact-printing-only rule that contradicted the ring must not come back');
});

test('COLL-TC-PERF1: /api/collection actually honours page and limit', () => {
  // It ACCEPTED both and ignored them: limit=1, limit=200 and page=99 all
  // returned 2,438 rows and 3,595,959 bytes. Parameters that are accepted and
  // discarded read as a working contract.
  const i = collection.indexOf("router.get('/collection'");
  const block = strip(collection.slice(i, collection.indexOf('router.', i + 10)));

  assert.match(block, /req\.query\.limit/, 'limit must be read');
  assert.match(block, /req\.query\.page/, 'page must be read');
  assert.match(block, /\.slice\(start, start \+ limit\)/,
    'and must actually narrow the rows returned');
  assert.match(block, /Math\.min\(rawLimit, 500\)/,
    'limit must be capped -- an unbounded client limit is the same bug with extra steps');

  // OPT-IN. Four screens fetch this list and filter client-side; a default page
  // size would silently truncate all of them.
  assert.match(block, /if \(!paging\)/,
    'a caller that asks for no page must still receive the whole list');
  assert.match(block, /total_pages/, 'the envelope must say how many pages exist');
});

test('COLL-TC-PERF2: dead marketplace URLs are not shipped with every row', () => {
  // 663 KB of the 3.6 MB payload -- 23% -- for two fields with NO consumer.
  // utils/marketplaceLinks.js is their only reader and it has no call sites; it
  // falls back to a name search when they are absent.
  const i = collection.indexOf("router.get('/collection'");
  const block = collection.slice(i, collection.indexOf('router.', i + 10));
  // SLICE FROM THE QUERY, NOT FROM THE BLOCK START. My first version searched
  // for the closing backtick from index 0 of the block and found one at 260 --
  // BEFORE the query begins at 589 -- so it tested an empty string and passed
  // with the URLs restored. A vacuous assertion is worse than none: it reports
  // a guard that is not guarding.
  const qStart = block.indexOf('const query = `');
  assert.ok(qStart > -1, 'the list query must be locatable');
  const sql = block.slice(qStart, block.indexOf('`;', qStart));
  assert.ok(sql.length > 500, 'the extracted SQL must actually be the query');
  assert.doesNotMatch(strip(sql), /cc\.tcgplayer_url|cc\.cardmarket_url/,
    'the list query must not select marketplace URLs for every row');
});

test('CAT-TC-PERF1: the catalogue swap cannot hold the write lock for 25s', () => {
  // MEASURED: during a forced refresh the deck list ran 0.8-1.8s throughout the
  // import and then spiked to 24.99 SECONDS at the swap, because ~105,000 rows
  // were copied in ONE transaction. SQLite holds one write lock for a
  // transaction's life and db.js serializes everything behind it, so nothing --
  // not even /api/health -- could run.
  const fn = catalogue.slice(catalogue.indexOf('async function applyStaged'),
                             catalogue.indexOf('// --- The in-flight lock'));
  const body = strip(fn);

  assert.match(body, /APPLY_BATCH_ROWS/, 'the copy must be batched');
  assert.match(body, /rowid > \? AND rowid <= \?/,
    'each batch must take a bounded rowid RANGE');
  // OFFSET made batch N rescan the table from the start, so the apply was
  // quadratic and slowest at the end -- the first fix only moved the deck list
  // from 25s to 15s because of this.
  assert.doesNotMatch(body, /LIMIT \? OFFSET \?/,
    'OFFSET pagination rescans from row 0 every batch: seek on rowid instead');
  assert.match(body, /APPLY_BATCH_PAUSE_MS/,
    'batches must YIELD between transactions -- db.js serializes queries, so ' +
    'back-to-back batches leave no gap for a waiting read');
  assert.match(body, /setTimeout\(resolve, APPLY_BATCH_PAUSE_MS\)/,
    'and the yield must be a real pause, not a resolved promise');
  assert.match(body, /while \(done < total\)/,
    'and loop until every staged row is applied -- a partial copy is a silent data loss');

  // The old shape: one unbounded INSERT...SELECT inside a single transaction.
  const txCount = (body.match(/withTransaction/g) || []).length;
  assert.equal(txCount, 1, 'exactly one transaction, inside the loop -- not wrapping it');
  const loopStart = body.indexOf('while (done < total)');
  assert.ok(body.indexOf('withTransaction') > loopStart,
    'the transaction must be INSIDE the loop, or batching changes nothing');
});

test('CAT-TC-PERF2: the batched swap still upserts, never deletes', () => {
  // The safety argument for giving up atomicity. Every row is an UPSERT of
  // Scryfall's own facts on the same primary key, so a crash mid-way leaves
  // some cards fresher than others and the next refresh finishes the job.
  // A DELETE would break collection.card_id / deck_cards.desired_card_id, which
  // are real foreign keys -- a card someone OWNS could vanish.
  const fn = strip(catalogue.slice(catalogue.indexOf('async function applyStaged'),
                                   catalogue.indexOf('// --- The in-flight lock')));
  assert.match(fn, /INSERT OR REPLACE INTO card_cache/,
    'rows are replaced in place, keeping their primary key');
  assert.doesNotMatch(fn, /DELETE FROM card_cache/,
    'nothing a collection or deck points at may be deleted');
});
