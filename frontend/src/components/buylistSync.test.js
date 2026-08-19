// PR 7B — the live combined buylist's sequencing rules.
//
// WHAT THESE CAN PROVE, and it is more than the usual source-contract checks:
// createBuylistSync is a pure controller with an injected clock and an injected
// fetch, so the dangerous interleavings can be DRIVEN, not asserted about from
// the outside. Every case below is a real out-of-order or empty-selection
// sequence played through the real code.
//
// WHAT THEY CANNOT PROVE: that 300ms feels right on a phone, that the spinner
// reads as "working" rather than as "broken", or that the panel fits an iPhone
// 16. Those need Zach's eyes.
import assert from 'node:assert/strict';
import { createBuylistSync, BUYLIST_DEBOUNCE_MS } from './buylistSync.js';

let passed = 0;
// The cases below resolve promises by hand, so the runner MUST await what the
// case returns. An earlier draft of this file called fn() and dropped the
// promise — every async assertion would have been unobserved and the suite
// would have printed PASS for tests that never ran their assertions. A green
// suite that proves nothing is worse than a red one.
const cases = [];
const test = (id, name, fn) => cases.push({ id, name, fn });
async function run() {
  for (const { id, name, fn } of cases) {
    await fn();
    passed++;
    console.log(`PASS: ${id} ${name}`);
  }
}

// Let all already-resolved promise callbacks run. Two turns, because a
// response handler is itself chained behind a Promise.resolve().
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// A hand-cranked clock, so debounce timing is deterministic rather than raced.
function fakeScheduler() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; pending.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    // Fire everything currently due, as the browser would after `delay` passes.
    tick() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, { fn }] of due) fn();
    },
    get size() { return pending.size; }
  };
}

// A fetch whose responses are resolved BY HAND, so "the slow one lands last"
// is a fact of the test rather than a hope about timing.
function controllableFetch() {
  const calls = [];
  const fn = (deckIds) => new Promise((resolve, reject) => {
    calls.push({ deckIds: [...deckIds], resolve, reject });
  });
  fn.calls = calls;
  return fn;
}

function harness({ delay = BUYLIST_DEBOUNCE_MS } = {}) {
  const scheduler = fakeScheduler();
  const fetchBuylist = controllableFetch();
  const states = [];
  const sync = createBuylistSync({
    fetchBuylist,
    onState: (s) => states.push(s),
    delay,
    scheduler
  });
  return { sync, scheduler, fetchBuylist, states, last: () => states[states.length - 1] };
}

const listFor = (names) => ({ items: names.map(n => ({ name: n })), decks: names.map(n => ({ name: n })) });

// ---------------------------------------------------------------------------
// THE CORRECTNESS PROPERTY: a stale answer can never repaint the screen.
//
// This is the one that would cost him money. He ticks A, then B. The response
// for [A] is slow and arrives AFTER the response for [A, B]. Naive
// last-write-wins leaves the screen showing A's cards while A and B are both
// ticked — a shopping list for the wrong decks, with nothing on screen to
// suggest anything went wrong.
// ---------------------------------------------------------------------------

test('F7B-TC1', 'a slow response for an older selection cannot overwrite a newer one', () => {
  const h = harness();

  h.sync.select(['a']);
  h.scheduler.tick();                    // request for [a] goes out
  h.sync.select(['a', 'b']);
  h.scheduler.tick();                    // request for [a,b] goes out

  assert.equal(h.fetchBuylist.calls.length, 2);
  assert.deepEqual(h.fetchBuylist.calls[0].deckIds, ['a']);
  assert.deepEqual(h.fetchBuylist.calls[1].deckIds, ['a', 'b']);

  // The NEWER one lands first...
  h.fetchBuylist.calls[1].resolve(listFor(['A', 'B']));
  // ...and the OLDER one lands afterwards, which is the whole trap.
  h.fetchBuylist.calls[0].resolve(listFor(['A']));

  return settle().then(() => {
    assert.deepEqual(
      h.last().buylist.decks.map(d => d.name), ['A', 'B'],
      'the late answer for the smaller selection must be discarded, not painted'
    );
  });
});

test('F7B-TC2', 'a stale FAILURE cannot clear a newer good list either', () => {
  const h = harness();
  h.sync.select(['a']);
  h.scheduler.tick();
  h.sync.select(['a', 'b']);
  h.scheduler.tick();

  h.fetchBuylist.calls[1].resolve(listFor(['A', 'B']));
  h.fetchBuylist.calls[0].reject(new Error('slow request failed'));

  return settle().then(() => {
    assert.ok(h.last().buylist, 'a stale rejection must not blank a current, correct list');
    assert.equal(h.last().error, null, 'nor raise an error about a selection he has moved on from');
  });
});

// ---------------------------------------------------------------------------
// UNTICKING REMOVES A DECK'S CONTRIBUTION, IMMEDIATELY.
// ---------------------------------------------------------------------------

test('F7B-TC3', 'changing the selection drops the previous list at once', () => {
  const h = harness();
  h.sync.select(['a', 'b']);
  h.scheduler.tick();
  h.fetchBuylist.calls[0].resolve(listFor(['A', 'B']));

  return settle().then(() => {
    assert.deepEqual(h.last().buylist.decks.map(d => d.name), ['A', 'B']);

    // He unticks B. The list for [a,b] is wrong from this instant.
    h.sync.select(['a']);
    assert.equal(h.last().buylist, null, 'a list built for decks he just unticked must not linger');
    assert.equal(h.last().loading, true, 'and the panel must not look settled while the new one is fetched');
  });
});

test('F7B-TC4', 'unticking everything clears locally and fires NO request', () => {
  const h = harness();
  h.sync.select(['a']);
  h.scheduler.tick();
  h.fetchBuylist.calls[0].resolve(listFor(['A']));

  return settle().then(() => {
    h.sync.select([]);
    h.scheduler.tick();

    assert.equal(h.fetchBuylist.calls.length, 1, 'an empty selection must never reach the server');
    assert.equal(h.last().buylist, null, 'the list must be gone, not stale');
    assert.equal(h.last().loading, false, 'and nothing is loading — nothing was asked');
    assert.equal(h.last().error, null, 'clearing the last tick is not an error he did');
  });
});

test('F7B-TC5', 'an in-flight request is abandoned when he unticks everything', () => {
  const h = harness();
  h.sync.select(['a']);
  h.scheduler.tick();
  h.sync.select([]);

  h.fetchBuylist.calls[0].resolve(listFor(['A']));
  return settle().then(() => {
    assert.equal(h.last().buylist, null, 'an answer for a selection he has cleared must not appear');
  });
});

// ---------------------------------------------------------------------------
// DEBOUNCE — live updates must not mean a request per checkbox.
// ---------------------------------------------------------------------------

test('F7B-TC6', 'rapid ticking costs ONE request, for the final selection', () => {
  const h = harness();
  h.sync.select(['a']);
  h.sync.select(['a', 'b']);
  h.sync.select(['a', 'b', 'c']);
  assert.equal(h.fetchBuylist.calls.length, 0, 'nothing should be sent while he is still ticking');

  h.scheduler.tick();
  assert.equal(h.fetchBuylist.calls.length, 1, 'three ticks in a row must collapse into one request');
  assert.deepEqual(h.fetchBuylist.calls[0].deckIds, ['a', 'b', 'c'], 'and it must ask for the FINAL selection');
});

test('F7B-TC7', 'the debounce window is small enough to feel immediate', () => {
  assert.ok(
    BUYLIST_DEBOUNCE_MS >= 250 && BUYLIST_DEBOUNCE_MS <= 400,
    'ticking a deck should update the list without a wait he notices'
  );
});

test('F7B-TC8', 'a repeated identical selection does not refetch or flash the spinner', () => {
  const h = harness();
  h.sync.select(['a', 'b']);
  h.scheduler.tick();
  const callsAfterFirst = h.fetchBuylist.calls.length;
  const statesAfterFirst = h.states.length;

  h.sync.select(['b', 'a']);   // same selection, different order
  h.scheduler.tick();

  assert.equal(h.fetchBuylist.calls.length, callsAfterFirst, 'the same set of decks is not a new question');
  assert.equal(h.states.length, statesAfterFirst, 'and must not blank the list or show a spinner');
});

// ---------------------------------------------------------------------------
// LEAVING THE MODE.
// ---------------------------------------------------------------------------

test('F7B-TC9', 'leaving buylist mode drops the list and any in-flight answer', () => {
  const h = harness();
  h.sync.select(['a']);
  h.scheduler.tick();
  h.sync.reset();

  assert.equal(h.last().buylist, null);
  assert.equal(h.last().loading, false);

  h.fetchBuylist.calls[0].resolve(listFor(['A']));
  return settle().then(() => {
    assert.equal(h.last().buylist, null, 'a list must not appear after he has left the flow');
  });
});

test('F7B-TC10', 'a genuine failure for the CURRENT selection is reported, with no list', () => {
  const h = harness();
  h.sync.select(['a']);
  h.scheduler.tick();
  h.fetchBuylist.calls[0].reject(new Error('boom'));

  return settle().then(() => {
    assert.equal(h.last().loading, false);
    assert.equal(h.last().buylist, null, 'a failed read must never render as an empty list — that reads as "you need nothing"');
    assert.ok(h.last().error, 'and he must be told the read failed');
  });
});

await run();
console.log(`buylistSync self-check passed (${passed} cases)`);
