// DOES THE MULTI-DECK BUYLIST ACTUALLY FIRE?
//
// Zach has reported this twice: "the buylist when selecting multiple decks
// still doesn't work at all. I don't understand the mock has it right."
//
// I verified the ENDPOINT twice (in-process and over real HTTP with a session
// token, both returning a correct buylist) and concluded the backend was fine
// -- which was true and completely beside the point. Verifying the half that
// was never broken is not debugging.
//
// This exercises the client sequencing instead: the createBuylistSync contract
// that DeckList depends on. If select() is called with two deck ids, a request
// must actually be issued and its result must reach onState.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuylistSync } from './buylistSync.js';

const here = dirname(fileURLToPath(import.meta.url));

const flush = (ms = 400) => new Promise(r => setTimeout(r, ms));

test('BUY-TC1: selecting two decks issues ONE request with both ids', async () => {
  const calls = [];
  const states = [];
  const sync = createBuylistSync({
    fetchBuylist: async (ids) => { calls.push([...ids]); return { items: [{ name: 'Sol Ring', quantity: 2 }] }; },
    onState: (s) => states.push(s),
  });

  sync.select([6, 7]);
  await flush();

  assert.equal(calls.length, 1, 'exactly one request for one selection');
  assert.deepEqual(calls[0], [6, 7], 'both deck ids must be sent');

  const final = states[states.length - 1];
  assert.ok(final.buylist, 'the result must reach onState');
  assert.equal(final.loading, false, 'loading must end');
  assert.equal(final.buylist.items[0].quantity, 2);
});

test('BUY-TC2: adding a deck to the selection re-requests', async () => {
  const calls = [];
  const sync = createBuylistSync({
    fetchBuylist: async (ids) => { calls.push([...ids]); return { items: [] }; },
    onState: () => {},
  });

  sync.select([6]);
  await flush();
  sync.select([6, 7]);
  await flush();

  assert.equal(calls.length, 2, 'a changed selection must refetch');
  assert.deepEqual(calls[1], [6, 7]);
});

test('BUY-TC3: clearing the selection does NOT request, and clears the list', async () => {
  // "Buy nothing" and "you selected nothing" are different facts. An empty
  // shopping list reads as the good news that he needs nothing.
  const calls = [];
  const states = [];
  const sync = createBuylistSync({
    fetchBuylist: async (ids) => { calls.push([...ids]); return { items: [] }; },
    onState: (s) => states.push(s),
  });

  sync.select([6]);
  await flush();
  const before = calls.length;
  sync.select([]);
  await flush();

  assert.equal(calls.length, before, 'an empty selection must not hit the server');
  assert.equal(states[states.length - 1].buylist, null, 'the list must be cleared, not stale');
});

test('BUY-TC4: DeckList wires select() to its selection state', () => {
  // Guards the integration the cases above cannot see. If the component stops
  // calling select(), every case here keeps passing while the screen does
  // nothing -- which is exactly what Zach reported.
  const src = readFileSync(join(here, 'DeckList.jsx'), 'utf8');
  assert.match(src, /syncRef\.current\.select\(\[\.\.\.selected\]\)/,
    'DeckList must push its selection into the buylist sync');
  assert.match(src, /useEffect\(\(\) => \{\s*syncRef\.current\.select/,
    'the push must run in an effect keyed on the selection');
  assert.match(src, /\}, \[selected\]\)/,
    'the effect must depend on `selected`, or ticking a deck changes nothing');
});
