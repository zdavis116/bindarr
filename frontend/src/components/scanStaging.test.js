// The staging controller, driven with a fake fetch.
//
// These test the rules that protect a stack of PHYSICAL cards Zach has already
// put away, so they are worth stating plainly:
//   - a failed "add all" must leave the session intact and say so
//   - unresolved rows must surface at the top, because a long list gets skimmed
//   - the server is the only authority on what is staged
import assert from 'node:assert/strict';
import { createScanStaging, sortForReview, isWeakMatch } from './scanStaging.js';

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
  unresolved: entries.filter(e => e.unresolved).length,
});

await test('FSS-TC1', 'reads the session from the server, never invents it', async () => {
  const rows = [
    { id: 1, name: 'Sol Ring', unresolved: false },
    { id: 2, matched_name: 'Island', unresolved: true },
  ];
  const s = createScanStaging({ fetchImpl: fakeFetch({ 'GET /api/scan-stage': { body: listBody(rows) } }) });
  const st = await s.refresh();
  assert.equal(st.entries.length, 2);
  assert.equal(st.stagedCount, 2);
  assert.equal(st.unresolvedCount, 1, 'the row needing a printing is counted');
});

await test('FSS-TC2', 'staging bumps the badge without re-reading the whole list', async () => {
  // This runs once per card in a stack of hundreds. Pulling every thumbnail
  // back on each scan would make scanning slower the longer the session ran.
  const f = fakeFetch({
    'POST /api/scan-stage': { body: { staged: true, id: 9 } },
  });
  const s = createScanStaging({ fetchImpl: f });
  const r = await s.stage({ card_id: 'x' });
  assert.equal(r.ok, true);
  assert.equal(s.getState().stagedCount, 1);
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

await test('FSS-TC5', 'NOTHING floats: strict most-recent-first', async () => {
  // Zach, correcting what I built: "But I always want the order of the cards in
  // the scanned to be most recent scanned first. Don't pop issues to the top."
  //
  // The first version sorted unresolved rows to the top so they could not be
  // missed. That broke his actual workflow: he scans a card and looks at the top
  // of the list to confirm it registered against the cardboard in his hand. If
  // the list rearranges itself, the row he just made is not where he is looking.
  //
  // Attention is signalled by COLOUR, not position.
  const sorted = sortForReview([
    { id: 1, unresolved: false },
    { id: 2, unresolved: false },
    { id: 3, unresolved: true },
    { id: 4, unresolved: false },
    { id: 5, unresolved: true },
  ]);
  assert.deepEqual(sorted.map(e => e.id), [5, 4, 3, 2, 1],
    'strict id-descending -- an unresolved row must NOT jump the queue');
});

await test('FSS-TC6', 'rows are newest-scanned first', async () => {
  const sorted = sortForReview([{ id: 3 }, { id: 7 }, { id: 5 }]);
  assert.deepEqual(sorted.map(e => e.id), [7, 5, 3]);
});

await test('FSS-TC7', 'weak matches are flagged, and only the right ones', async () => {
  // The backstop Zach asked for in place of a slower scanner: "add an override
  // button in the scanned section and highlight yellow that match is weak if
  // below a threshold".
  assert.equal(isWeakMatch({ match_inliers: 12, name: 'Sol Ring' }), true,
    'a noise-level art match must be flagged');
  assert.equal(isWeakMatch({ match_inliers: 120, name: 'Sol Ring' }), false,
    'a strong art match must not be');

  // BASIC LANDS ARE NEVER FLAGGED. Dozens of Mountain printings score 120+
  // against one photo of a Mountain, so the score says nothing about WHICH
  // Mountain -- high or low. Flagging them would mark most of a land-heavy
  // stack and train him to ignore the colour entirely.
  assert.equal(isWeakMatch({ match_inliers: 5, name: 'Mountain' }), false,
    'basic lands must never be flagged weak');
  assert.equal(isWeakMatch({ match_inliers: 5, name: 'Snow-Covered Forest' }), false,
    'including snow-covered basics');

  // No score is not a problem. Absence of evidence must not look like evidence
  // of a bad match, or every older row lights up yellow for no reason.
  assert.equal(isWeakMatch({ name: 'Sol Ring' }), false,
    'a row with no recorded score must not be flagged');

  // An unresolved row has its own treatment; double-marking it is noise.
  assert.equal(isWeakMatch({ match_inliers: 3, unresolved: true, name: 'Sol Ring' }), false,
    'unresolved rows are not additionally flagged as weak');
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
