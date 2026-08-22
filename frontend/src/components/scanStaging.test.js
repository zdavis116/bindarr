// The staging controller, driven with a fake fetch.
//
// These test the rules that protect a stack of PHYSICAL cards Zach has already
// put away, so they are worth stating plainly:
//   - a failed "add all" must leave the session intact and say so
//   - flagged rows must surface at the top, because a long list gets skimmed
//   - the server is the only authority on what is staged
import assert from 'node:assert/strict';
import { createScanStaging, sortForReview, describeFlag } from './scanStaging.js';

let passed = 0;
function test(id, name, fn) {
  return fn().then(
    () => { passed++; console.log(`PASS: ${id} ${name}`); },
    (e) => { console.error(`FAIL: ${id} ${name}\n  ${e.message}`); process.exitCode = 1; }
  );
}

// A fake server: routes by method+path, records every call.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    calls.push(`${method} ${url}`);
    const key = `${method} ${url}`;
    const handler = routes[key] || routes[`${method} *`];
    if (!handler) throw new Error(`unexpected call ${key}`);
    const out = typeof handler === 'function' ? handler(opts) : handler;
    return {
      ok: out.status ? out.status < 400 : true,
      status: out.status || 200,
      json: async () => out.body,
    };
  };
  impl.calls = calls;
  return impl;
}

const listBody = (entries) => ({
  entries,
  total: entries.length,
  flagged: entries.filter(e => e.flag).length,
});

await test('FSS-TC1', 'reads the session from the server, never invents it', async () => {
  const rows = [{ id: 1, name: 'Sol Ring', flag: null }, { id: 2, name: 'Island', flag: 'already_owned' }];
  const s = createScanStaging({ fetchImpl: fakeFetch({ 'GET /api/scan-stage': { body: listBody(rows) } }) });
  const st = await s.refresh();
  assert.equal(st.entries.length, 2);
  assert.equal(st.stagedCount, 2);
  assert.equal(st.flaggedCount, 1);
});

await test('FSS-TC2', 'staging bumps the badge without re-reading the whole list', async () => {
  // This runs once per card in a stack of hundreds. Pulling every thumbnail
  // back on each scan would make scanning slower the longer the session ran.
  const f = fakeFetch({
    'POST /api/scan-stage': { body: { staged: true, id: 9, flag: 'duplicate_in_session' } },
  });
  const s = createScanStaging({ fetchImpl: f });
  const r = await s.stage({ card_id: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.flag, 'duplicate_in_session');
  assert.equal(s.getState().stagedCount, 1);
  assert.equal(s.getState().flaggedCount, 1);
  assert.equal(f.calls.filter(c => c.startsWith('GET')).length, 0,
    'staging must not trigger a full list read');
});

await test('FSS-TC3', 'a successful commit clears the session', async () => {
  let committed = false;
  const s = createScanStaging({
    fetchImpl: fakeFetch({
      'POST /api/scan-stage/commit': () => { committed = true; return { body: { committed: 3 } }; },
      'GET /api/scan-stage': () => ({ body: listBody(committed ? [] : [{ id: 1 }]) }),
    }),
  });
  const r = await s.commitAll();
  assert.equal(r.ok, true);
  assert.equal(r.committed, 3);
  assert.equal(s.getState().entries.length, 0);
});

await test('FSS-TC4', 'A FAILED COMMIT LEAVES THE SESSION INTACT AND REPORTS IT', async () => {
  // THE ONE THAT MATTERS. The server commits atomically, so a failure means
  // NOTHING was added. If this controller cleared the list anyway, Zach would
  // see an empty session, believe his stack was filed, and have no way to
  // reconcile it against cards he has already put away. Silent loss of a
  // scanned stack is the worst outcome this feature can produce.
  const rows = [{ id: 1, name: 'Sol Ring' }, { id: 2, name: 'Island' }];
  const s = createScanStaging({
    fetchImpl: fakeFetch({
      'POST /api/scan-stage/commit': { status: 400, body: { error: 'Unknown card_id', committed: 0 } },
      'GET /api/scan-stage': { body: listBody(rows) },
    }),
  });
  const r = await s.commitAll();
  assert.equal(r.ok, false);
  assert.equal(r.committed, 0, 'a failed commit must report zero added');
  assert.equal(s.getState().entries.length, 2,
    'the session must survive so he can fix the row and retry');
  assert.match(s.getState().error || '', /Unknown card_id/,
    'and he must be told why, not just shown a stale list');
});

await test('FSS-TC5', 'flagged rows sort to the top, worst first', async () => {
  // A sixty-row list gets skimmed. If the rows needing attention are not at the
  // top, the flags may as well not exist.
  const sorted = sortForReview([
    { id: 1, flag: null },
    { id: 2, flag: 'already_owned' },
    { id: 3, flag: null },
    { id: 4, flag: 'low_confidence' },
    { id: 5, flag: 'duplicate_in_session' },
  ]);
  assert.deepEqual(sorted.map(e => e.id), [4, 5, 2, 1, 3]);
  // low_confidence outranks the rest because it questions whether the app got
  // the right CARD; the others only say "you have one already".
  assert.equal(sorted[0].flag, 'low_confidence');
});

await test('FSS-TC6', 'unflagged rows keep scan order', async () => {
  // Scan order is the order the physical stack is in, which is how he checks a
  // row against the card in his hand.
  const sorted = sortForReview([{ id: 7 }, { id: 3 }, { id: 5 }]);
  assert.deepEqual(sorted.map(e => e.id), [3, 5, 7]);
});

await test('FSS-TC7', 'every flag has human wording, and unknown flags do not crash', async () => {
  for (const f of ['duplicate_in_session', 'already_owned', 'low_confidence']) {
    assert.ok(describeFlag(f), `${f} needs an explanation Zach can act on`);
  }
  assert.equal(describeFlag(null), null);
  assert.equal(describeFlag('something_new'), null);
});

await test('FSS-TC8', 'a network failure is reported, not swallowed', async () => {
  const s = createScanStaging({
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const st = await s.refresh();
  assert.match(st.error || '', /offline/);
  assert.equal(st.loading, false, 'a failed load must not leave the UI spinning forever');
});

console.log(`scanStaging: ${passed} cases passed`);
if (process.exitCode) process.exit(process.exitCode);
