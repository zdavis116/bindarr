// DELETING THE WHOLE COLLECTION MUST WORK.
//
// Zach: "The issue I'm having is being able to delete my entire collection. I
// get an error that there is more than 1k ids in the collection."
//
// Selecting all 2,438 of his cards and pressing delete was refused by a 1,000
// id cap on POST /api/collection/bulk. The cap existed to stop an unbounded
// request body -- a reasonable goal -- but 1,000 was not a limit anything
// actually had, and it made "select all, delete" impossible on a collection he
// had already grown past.
//
// TWO SEPARATE CEILINGS, and it matters not to confuse them:
//
//   THE ROUTE CAP (1,000)  -- arbitrary, and what he actually hit.
//   SQLITE'S PARAMETERS    -- real, measured here, not assumed:
//                             2,438 ids  ok
//                            10,000 ids  ok
//                            32,766 ids  FAIL "too many SQL variables"
//
// So raising the cap alone WOULD have fixed his report. It is chunked anyway,
// because he has said he is planning for 10k cards and a cap that works today
// and fails at some larger number is the same bug postponed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = f => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8');
const strip = s => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const trash = read('utils/collectionTrash.js');
const route = read('routes/collection.js');

test('DEL-TC1: a full-collection delete is not refused by an arbitrary cap', () => {
  const code = strip(route);
  assert.doesNotMatch(code, /entry_ids', maxLength: 1000/,
    'the 1,000 cap made "select all, delete" impossible past 1,000 cards');
  assert.match(code, /BULK_IDS_MAX/,
    'the limit must be a named constant that explains itself');
  // Above his stated 10k target, below SQLite's measured 32,766 ceiling.
  const m = strip(route).match(/const BULK_IDS_MAX = (\d+)/);
  assert.ok(m, 'BULK_IDS_MAX must be defined');
  const cap = Number(m[1]);
  assert.ok(cap >= 10000, `the cap must clear the 10,000 cards he is planning for (got ${cap})`);
  assert.ok(cap < 32766, `and stay under SQLite's parameter ceiling (got ${cap})`);
});

test('DEL-TC2: the delete chunks its statements', () => {
  const code = strip(trash);
  // Without chunking the id list becomes one bound parameter each, and the
  // statement dies at 32,766. Measured, not assumed.
  assert.match(code, /const CHUNK = \d+/, 'the id list must be chunked');
  assert.match(code, /for \(let i = 0; i < ids\.length; i \+= CHUNK\)/,
    'and every chunk must be processed, not just the first');
  assert.match(code, /ids\.slice\(i, i \+ CHUNK\)/,
    'each chunk must be a distinct slice -- no row twice, none skipped');
});

test('DEL-TC3: copy and delete stay atomic across ALL chunks', () => {
  // THE PART THAT MATTERS MORE THAN THE BATCHING.
  //
  // The rows are copied to collection_trash and then removed from collection.
  // If those two are not in one transaction, a failure between them either
  // destroys rows with no trash entry to undo from, or leaves the row in both
  // tables -- deleted and still counted. Per-CHUNK transactions would be just
  // as bad: a crash halfway leaves a half-deleted selection, which is a silent
  // state change against physical cardboard.
  const code = strip(trash);
  const fn = code.slice(code.indexOf('async function trashEntries'),
                        code.indexOf('async function purgeOldBatches'));

  assert.match(fn, /db\.withTransaction/, 'the move must be transactional');
  // The transaction must OPEN BEFORE the loop, not inside it.
  const tx = fn.indexOf('withTransaction');
  const loop = fn.indexOf('for (let i = 0');
  assert.ok(tx < loop,
    'the transaction must wrap the whole loop -- per-chunk transactions can half-delete');
  assert.match(fn, /tx\.run\(/,
    'statements inside must run on the transaction, not the pooled connection');
  assert.doesNotMatch(fn, /\bdb\.run\(/,
    'a db.run inside the transaction would escape it');
});

test('DEL-TC4: both statements stay scoped to the owning user', () => {
  // A client can post any id. The COPY must not be able to read another user's
  // row even if the DELETE would have refused it -- otherwise a crafted request
  // leaks rows into the caller's trash, where restore would hand them over.
  const code = strip(trash);
  const fn = code.slice(code.indexOf('async function trashEntries'),
                        code.indexOf('async function purgeOldBatches'));
  const guards = fn.match(/AND user_id = \?/g) || [];
  assert.ok(guards.length >= 2,
    'both the INSERT...SELECT and the DELETE must filter on user_id');
});

test('DEL-TC5: the whole batch is one undo, not one per chunk', () => {
  // Zach relies on undo after a bulk delete. Chunking must not turn a single
  // deletion into several batches, or the toast restores 500 of 2,438 cards
  // and reports success.
  const code = strip(trash);
  const fn = code.slice(code.indexOf('async function trashEntries'),
                        code.indexOf('async function purgeOldBatches'));
  const newIds = (fn.match(/newBatchId\(\)/g) || []).length;
  assert.equal(newIds, 1, 'exactly one batch id for the whole delete');
  const before = fn.indexOf('newBatchId()');
  assert.ok(before < fn.indexOf('for (let i = 0'),
    'the batch id must be allocated once, before the loop');
  assert.match(fn, /moved \+= del\.changes/,
    'the reported count must accumulate across chunks, not report the last one');
});
