import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'components/ExactDeckPanel.jsx'), 'utf8');

// The exact-finish deck UI must not RECOMPUTE ownership, reservation or missing
// counts. The server is the single source of truth for those numbers (PR 6C),
// and a second implementation in the client is how the screen and the database
// end up disagreeing about whether the user needs to buy a card.
//
// This is a source-level guard rather than a render test because the failure it
// prevents is the reintroduction of arithmetic, which is easy to spot in text
// and awkward to assert on in a DOM.
const forbiddenArithmetic = [
  /quantity_required\s*-\s*quantity_owned/,
  /quantity_owned\s*-\s*quantity_allocated/,
  /Math\.max\([^)]*quantity_(required|owned|missing)/,
  /reduce\([^)]*quantity_owned/
];
for (const pattern of forbiddenArithmetic) {
  assert.ok(
    !pattern.test(source),
    `ExactDeckPanel must not recompute server-owned quantities (matched ${pattern})`
  );
}

// Finish must never be defaulted. A preselected finish is the app choosing a
// physical object on the user's behalf; they find out it was the wrong one when
// they are standing at the binder.
assert.match(
  source,
  /const \[finish, setFinish\] = useState\(''\)/,
  'the finish field must start empty so the user makes an explicit choice'
);
assert.match(
  source,
  /<option value="">Choose a finish/,
  'the finish selector must offer an unchosen state'
);
assert.ok(
  /disabled=\{busy \|\| !printingId\.trim\(\) \|\| !finish\}/.test(source),
  'the add button must stay disabled until BOTH printing and finish are chosen'
);

// Exactly the three canonical MTG finishes, and no legacy Pokemon-era values.
// The list lives in the extracted status module, so that is where it is
// asserted; the component must not carry a second copy of it.
const statusSource = fs.readFileSync(path.join(root, 'components/exactDeckStatus.js'), 'utf8');
assert.match(statusSource, /'nonfoil'/, 'nonfoil is offered');
assert.match(statusSource, /'foil'/, 'foil is offered');
assert.match(statusSource, /'etched'/, 'etched is offered');
for (const file of [source, statusSource]) {
  assert.ok(
    !/Reverse Holofoil|1st Edition|'Normal'/.test(file),
    'no legacy printing vocabulary may leak into the exact-finish UI'
  );
}

// Ownership problems are advisory. If the UI ever renders warnings through an
// error path, the user is told a save failed when it did not -- which is the
// exact behavior PR 6C requirement 5 removes.
const { requirementStatus } = await import('./exactDeckStatus.js');

assert.deepEqual(
  requirementStatus({
    reserves: true, quantity_required: 4, quantity_reserved: 4, quantity_missing: 0
  }),
  { tone: 'ok', label: 'Reserved 4 of 4' },
  'a fully reserved requirement reads as satisfied'
);

assert.deepEqual(
  requirementStatus({
    reserves: true, quantity_required: 4, quantity_reserved: 1, quantity_missing: 3
  }),
  { tone: 'warn', label: 'Missing 3 of 4' },
  'a shortfall is a warning tone, never an error tone'
);

// A considering entry is a note that the user is thinking about a card which
// is NOT physically in the deck. It reserves nothing, so it can never be
// "missing" anything -- but it must still tell the user whether a matching
// copy is free right now, because that is the question they are asking when
// they look at a maybeboard.
assert.deepEqual(
  requirementStatus({
    reserves: false, quantity_required: 1, quantity_reserved: 0, quantity_missing: 0,
    quantity_available: 1, available: true
  }),
  { tone: 'ok', label: 'Available 1' },
  'a considering entry with a free copy reads as available, with the count'
);

// The red case. Another deck took the last copy; this entry is untouched and
// still listed, it simply cannot be filled right now.
assert.deepEqual(
  requirementStatus({
    reserves: false, quantity_required: 1, quantity_reserved: 0, quantity_missing: 0,
    quantity_available: 0, available: false
  }),
  { tone: 'unavailable', label: 'Unavailable — no free copy' },
  'a considering entry whose copies are all taken reads as unavailable'
);

// Availability is the SERVER's number. The UI must branch on the server's
// flag, never recompute it from owned/allocated -- a second implementation
// here is how the screen and the database end up disagreeing.
assert.deepEqual(
  requirementStatus({
    reserves: false, quantity_required: 1, quantity_reserved: 0, quantity_missing: 0,
    quantity_owned: 5, quantity_allocated_elsewhere: 5,
    quantity_available: 0, available: false
  }).tone,
  'unavailable',
  'owning copies does not make an entry available when they are all reserved elsewhere'
);

// 'unavailable' must be a real, distinct tone so it can be styled red. Reusing
// 'warn' would make it look like the ordinary "you still need to buy this"
// state, which is not what this is.
assert.ok(
  /unavailable/.test(statusSource),
  'the status module must define a distinct unavailable tone for the red state'
);

// Ownership state for RESERVING entries still never escalates to an error.
for (const sample of [
  { reserves: true, quantity_required: 1, quantity_reserved: 1, quantity_missing: 0 },
  { reserves: true, quantity_required: 1, quantity_reserved: 0, quantity_missing: 1 }
]) {
  assert.ok(
    ['ok', 'warn', 'muted'].includes(requirementStatus(sample).tone),
    'ownership state never escalates to an error tone'
  );
}

// The panel must render the availability column and mark the unavailable state
// so it can be shown in red.
assert.ok(
  /quantity_available/.test(source),
  'the panel must surface the server-computed availability count'
);

console.log('ExactDeckPanel exact-identity self-check passed');
