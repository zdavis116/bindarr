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

await test('FSS-TC7', 'the uncertain BAND is flagged, not the lowest scores', async () => {
  // Zach caught the first version of this pointing at the wrong number, and the
  // corpus proved him right. I flagged the LOWEST artwork scores (<= 32) on the
  // reasoning that a weak match is a risky match. Measured over 191 resolved
  // scans, that band contained 46 correct rows and ZERO errors -- it flagged a
  // quarter of the list and caught nothing.
  //
  // All four wrong records scored 41-55: mediocre matches, strong enough to end
  // the search early and not strong enough to be right.
  //
  //   inliers   correct   wrong
  //    0-32        46       0
  //   33-49        12       3   <- flagged
  //   50-79        50       1
  //     80+        79       0
  //
  // If someone "fixes" this back to a simple <= threshold, these cases fail.
  assert.equal(isWeakMatch({ match_inliers: 42, name: 'Sol Ring' }), true,
    '42 is inside the band where every observed wrong card lived');
  assert.equal(isWeakMatch({ match_inliers: 33, name: 'Sol Ring' }), true, 'lower edge');
  assert.equal(isWeakMatch({ match_inliers: 49, name: 'Sol Ring' }), true, 'upper edge');

  assert.equal(isWeakMatch({ match_inliers: 12, name: 'Sol Ring' }), false,
    'a LOW score must NOT be flagged -- the collector number carried it, and '
    + 'the corpus shows that is reliable (46 correct, 0 wrong)');
  assert.equal(isWeakMatch({ match_inliers: 120, name: 'Sol Ring' }), false,
    'a decisive artwork match must not be flagged');
  assert.equal(isWeakMatch({ match_inliers: 55, name: 'Sol Ring' }), false,
    '50-79 is deliberately NOT flagged: widening to catch the one error there '
    + 'dashes a third of the list, and a marker on every third row is wallpaper');

  // BASIC LANDS ARE NEVER FLAGGED, and the measurement inverted the expectation.
  // Zach: "Remember basic lands are the biggest issues" -- true of ARTWORK
  // matching, but of 54 basic-land scans ZERO resolved wrong. Their printing is
  // decided by the collector number, which reads fine on a Mountain.
  assert.equal(isWeakMatch({ match_inliers: 42, name: 'Mountain' }), false,
    'basic lands must never be flagged: 54 scans, 0 errors');
  assert.equal(isWeakMatch({ match_inliers: 42, name: 'Snow-Covered Forest' }), false,
    'including snow-covered basics');

  // No score is not a problem. Absence of evidence must not look like evidence
  // of a bad match, or every older row lights up for no reason.
  assert.equal(isWeakMatch({ name: 'Sol Ring' }), false,
    'a row with no recorded score must not be flagged');

  // An unresolved row has its own treatment; double-marking it is noise.
  assert.equal(isWeakMatch({ match_inliers: 42, unresolved: true, name: 'Sol Ring' }), false,
    'unresolved rows are not additionally flagged');
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
