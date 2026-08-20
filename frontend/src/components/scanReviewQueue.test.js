// PR 9 — the scan review queue controller.
//
// WHAT THESE CAN PROVE, and it is more than a source grep: createScanReviewQueue
// is a pure controller with an injected fetch, so the routing decisions can be
// DRIVEN. "An unresolved scan goes to the queue and not the collection" is
// asserted by inspecting the actual HTTP call the controller made, not by
// hoping the component calls the right thing.
//
// WHAT THEY CANNOT PROVE: that the queue screen fits an iPhone 16, that a
// 40-entry list with thumbnails scrolls acceptably, or that a one-tap resolve
// feels like one tap. Nothing in this repo runs a browser. Those need Zach's
// eyes.
import assert from 'node:assert/strict';
import { createScanReviewQueue } from './scanReviewQueue.js';

let passed = 0;
const cases = [];
const test = (id, name, fn) => cases.push({ id, name, fn });
async function run() {
  for (const { id, name, fn } of cases) {
    await fn();
    passed++;
    console.log(`PASS: ${id} ${name}`);
  }
}

// A fetch recording every call, answering from a scripted queue of responses.
function recordingFetch(script = []) {
  const calls = [];
  const responses = [...script];
  const fn = async (url, options) => {
    calls.push({
      url,
      method: options?.method || 'GET',
      body: options?.body ? JSON.parse(options.body) : null,
    });
    const next = responses.shift();
    if (!next) return { ok: true, json: async () => ({}) };
    return { ok: next.ok !== false, json: async () => next.data ?? {} };
  };
  fn.calls = calls;
  return fn;
}

const entry = (over = {}) => ({
  id: 1,
  matched_name: 'Sol Ring',
  reason: 'ambiguous',
  ocr: { number: '263', set: 'c21', confident: true, raw: '263/281 U' },
  candidates: [
    { id: 'cmm-1', name: 'Sol Ring', set_id: 'cmm', number: '410', owned_qty: 0 },
  ],
  crop: null,
  ...over,
});

// --- The routing decision this whole PR exists to fix ----------------------

test('F9-TC1', 'a scanned card is submitted to /scan-resolve, never straight to /api/collection', async () => {
  const fetchImpl = recordingFetch([{ data: { action: 'queued', queue_id: 7, reason: 'unreadable' } }]);
  const q = createScanReviewQueue({ fetchImpl });

  await q.submitScan({ name: 'Sol Ring', ocrText: '263/281 U', crop: 'data:image/jpeg;base64,xx' });

  const posts = fetchImpl.calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/scan-resolve');
  // The bug PR 9 fixes: the scanner used to POST /api/collection directly, so
  // every scan became an owned card regardless of whether the printing was known.
  assert.equal(fetchImpl.calls.some(c => c.url === '/api/collection'), false);
});

test('F9-TC2', 'the raw OCR text is forwarded so the server can resolve the printing', async () => {
  const fetchImpl = recordingFetch([{ data: { action: 'added', card: { id: 'c21-263' } } }]);
  const q = createScanReviewQueue({ fetchImpl });

  await q.submitScan({ name: 'Sol Ring', ocrText: '263/281 U\nC21 * EN Mike Bierek' });

  assert.equal(fetchImpl.calls[0].body.name, 'Sol Ring');
  assert.equal(fetchImpl.calls[0].body.ocr_text, '263/281 U\nC21 * EN Mike Bierek');
});

test('F9-TC3', 'a queued outcome is reported as queued and does NOT count as an add', async () => {
  const fetchImpl = recordingFetch([{ data: { action: 'queued', queue_id: 7, reason: 'no_number' } }]);
  const q = createScanReviewQueue({ fetchImpl });

  const outcome = await q.submitScan({ name: 'Black Lotus', ocrText: 'Illus. Christopher Rush' });

  assert.equal(outcome.action, 'queued');
  assert.equal(outcome.reason, 'no_number');
  // A pending decision is not a card he owns.
  assert.equal(outcome.added, false);
});

test('F9-TC4', 'an added outcome carries the resolved card so the scanner can show it', async () => {
  const fetchImpl = recordingFetch([{ data: { action: 'added', card: { id: 'c21-263', name: 'Sol Ring' } } }]);
  const q = createScanReviewQueue({ fetchImpl });

  const outcome = await q.submitScan({ name: 'Sol Ring', ocrText: '263/281 U' });

  assert.equal(outcome.action, 'added');
  assert.equal(outcome.added, true);
  assert.equal(outcome.card.id, 'c21-263');
});

// --- The count must track the server, not the UI's optimism ---------------

test('F9-TC5', 'the pending count rises when a scan queues and not when one is added', async () => {
  const fetchImpl = recordingFetch([
    { data: { action: 'queued', queue_id: 1, reason: 'unreadable' } },
    { data: { action: 'added', card: { id: 'x' } } },
    { data: { action: 'queued', queue_id: 2, reason: 'ambiguous' } },
  ]);
  const q = createScanReviewQueue({ fetchImpl });

  await q.submitScan({ name: 'A', ocrText: '' });
  assert.equal(q.getState().pendingCount, 1);
  await q.submitScan({ name: 'B', ocrText: '263' });
  assert.equal(q.getState().pendingCount, 1, 'an ADDED card is in the collection, not the queue');
  await q.submitScan({ name: 'C', ocrText: '' });
  assert.equal(q.getState().pendingCount, 2);
});

test('F9-TC6', 'the queue is READ FROM THE SERVER, so a reload shows what the server holds', async () => {
  // The scanner never queued anything in this session — a fresh page load.
  const fetchImpl = recordingFetch([
    { data: { entries: [entry({ id: 4 }), entry({ id: 5 })] } },
  ]);
  const q = createScanReviewQueue({ fetchImpl });

  await q.refresh();

  assert.equal(fetchImpl.calls[0].url, '/api/scan-queue');
  assert.equal(fetchImpl.calls[0].method, 'GET');
  assert.equal(q.getState().entries.length, 2);
  // The count comes from the server's rows, not from a local tally that a
  // reload would have reset to zero.
  assert.equal(q.getState().pendingCount, 2);
});

test('F9-TC7', 'resolving an entry re-reads the server rather than splicing local state', async () => {
  const fetchImpl = recordingFetch([
    { data: { entries: [entry({ id: 4 }), entry({ id: 5 })] } },
    { data: { resolved: true, entry_id: 99 } },
    { data: { entries: [entry({ id: 5 })] } },
  ]);
  const q = createScanReviewQueue({ fetchImpl });
  await q.refresh();

  await q.resolveEntry(4, { card_id: 'cmm-1', printing: 'nonfoil', quantity: 1 });

  const post = fetchImpl.calls.find(c => c.method === 'POST');
  assert.equal(post.url, '/api/scan-queue/4/resolve');
  assert.equal(post.body.card_id, 'cmm-1');
  // Server is the source of truth: a GET followed the mutation.
  assert.equal(fetchImpl.calls[2].url, '/api/scan-queue');
  assert.equal(fetchImpl.calls[2].method, 'GET');
  assert.equal(q.getState().entries.length, 1);
  assert.equal(q.getState().entries[0].id, 5);
});

test('F9-TC8', 'a failed resolve leaves the entry in the queue and reports the error', async () => {
  const fetchImpl = recordingFetch([
    { data: { entries: [entry({ id: 4 })] } },
    { ok: false, data: { error: 'Chosen printing was not among the scanned candidates' } },
    { data: { entries: [entry({ id: 4 })] } },
  ]);
  const q = createScanReviewQueue({ fetchImpl });
  await q.refresh();

  const result = await q.resolveEntry(4, { card_id: 'bogus' });

  assert.equal(result.ok, false);
  assert.match(result.error, /not among the scanned candidates/);
  // Losing a card Zach physically scanned is worse than asking him again.
  assert.equal(q.getState().entries.length, 1);
});

test('F9-TC9', 'discarding an entry deletes it server-side and re-reads', async () => {
  const fetchImpl = recordingFetch([
    { data: { entries: [entry({ id: 4 }), entry({ id: 5 })] } },
    { data: { discarded: true } },
    { data: { entries: [entry({ id: 5 })] } },
  ]);
  const q = createScanReviewQueue({ fetchImpl });
  await q.refresh();

  await q.discardEntry(4);

  const del = fetchImpl.calls.find(c => c.method === 'DELETE');
  assert.equal(del.url, '/api/scan-queue/4');
  assert.equal(q.getState().pendingCount, 1);
});

// --- Owned-first ordering is the server's, and the UI must not disturb it --

test('F9-TC10', 'candidate order from the server is preserved exactly (owned printings first)', async () => {
  // The server pre-sorts owned-first (PR 6I banding). If the UI re-sorted by
  // set code or name, the one-tap common case would silently stop being the
  // first row and every resolve would become a hunt.
  const fetchImpl = recordingFetch([{
    data: {
      entries: [entry({
        candidates: [
          { id: 'znr-1', name: 'Sol Ring', set_id: 'znr', number: '252', owned_qty: 4 },
          { id: 'aaa-1', name: 'Sol Ring', set_id: 'aaa', number: '001', owned_qty: 0 },
          { id: 'c21-1', name: 'Sol Ring', set_id: 'c21', number: '263', owned_qty: 1 },
        ],
      })],
    },
  }]);
  const q = createScanReviewQueue({ fetchImpl });

  await q.refresh();

  const ids = q.getState().entries[0].candidates.map(c => c.id);
  assert.deepEqual(ids, ['znr-1', 'aaa-1', 'c21-1']);
  // And the owned ones really are the leading band as delivered.
  assert.equal(q.getState().entries[0].candidates[0].owned_qty, 4);
});

test('F9-TC11', 'every queue reason gets its own wording, and an unknown reason still reads sanely', async () => {
  // "This card prints no number" is NOT a failure and must not be worded as one.
  const { describeReason } = createScanReviewQueue({ fetchImpl: recordingFetch() });
  assert.match(describeReason('no_number'), /prints no collector number/i);
  assert.match(describeReason('unreadable'), /could not read/i);
  assert.match(describeReason('ambiguous'), /several printings/i);
  assert.equal(typeof describeReason('something_new'), 'string');
  assert.ok(describeReason('something_new').length > 0);
});

test('F9-TC12', 'a scan submission that fails outright is reported, never silently dropped', async () => {
  const fetchImpl = recordingFetch([{ ok: false, data: { error: 'Failed to resolve scanned card' } }]);
  const q = createScanReviewQueue({ fetchImpl });

  const outcome = await q.submitScan({ name: 'Sol Ring', ocrText: '' });

  assert.equal(outcome.action, 'error');
  assert.equal(outcome.added, false);
  assert.match(outcome.error, /Failed to resolve/);
});

test('F9-TC13', 'a failed submission does not inflate the pending count', async () => {
  // The badge claims cards are waiting on the server. A failed POST queued
  // nothing, so counting it would send Zach to a review screen that does not
  // contain the card he is looking for.
  const fetchImpl = recordingFetch([{ ok: false, data: { error: 'boom' } }]);
  const q = createScanReviewQueue({ fetchImpl });

  await q.submitScan({ name: 'Sol Ring', ocrText: '' });

  assert.equal(q.getState().pendingCount, 0);
});

test('F9-TC14', 'the finish is passed through untouched and never inferred', async () => {
  // Special treatments share artwork AND collector numbers with the standard
  // printing, so no still image can separate them. Whatever the caller states
  // explicitly is what gets sent.
  const fetchImpl = recordingFetch([{ data: { action: 'added', card: { id: 'x' } } }]);
  const q = createScanReviewQueue({ fetchImpl });

  await q.submitScan({ name: 'Sol Ring', ocrText: '263', printing: 'etched' });

  assert.equal(fetchImpl.calls[0].body.printing, 'etched');
});

test('F9-TC15', 'omitting a finish sends none, leaving the app default to the server', async () => {
  const fetchImpl = recordingFetch([{ data: { action: 'added', card: { id: 'x' } } }]);
  const q = createScanReviewQueue({ fetchImpl });

  await q.submitScan({ name: 'Sol Ring', ocrText: '263' });

  assert.equal('printing' in fetchImpl.calls[0].body, false);
});

run().then(() => {
  console.log(`scanReviewQueue self-check passed (${passed} cases)`);
}).catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
