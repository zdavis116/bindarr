// applyScanOutcome: ONE rule for what happens after an identified card is
// submitted, and it must stay one.
//
// WHY A SOURCE TEST RATHER THAN A RENDER TEST. The risk here is not that the
// function is wrong today -- it was extracted verbatim and diffed against the
// original, byte for byte after indentation. The risk is that the next person
// to add a scan path pastes the block a fourth time instead of calling it,
// which is exactly how this component ended up with the duplication that
// prompted the extraction. That is a shape question, and a render test cannot
// see it.
//
// Every assertion below is mutation-checked: break the rule it names and this
// file fails. See tools/mutate-scanoutcome.sh.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'CameraScanner.jsx'), 'utf8');

let passed = 0;
// Each case announces itself BEFORE it asserts. node:assert throws, so a case
// that only prints on success tells a mutation harness nothing about WHICH
// rule broke -- every failure looks identical from outside. Naming the case up
// front is what lets tools/mutate-scanoutcome.sh verify that the intended
// assertion is the one doing the work.
const start = (id) => { console.log(`RUN: ${id}`); };
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// COMMENTS ARE STRIPPED BEFORE ANY ABSENCE CHECK.
// A `doesNotMatch` against the raw file matches the comment that EXPLAINS the
// rule and fails for the wrong reason -- a trap this project has hit before.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

// The function's own body, sliced out so assertions about it cannot
// accidentally match a lookalike elsewhere in a 4,000-line file.
const fnStart = code.indexOf('const applyScanOutcome = (outcome, identified) => {');
assert.ok(fnStart > 0, 'applyScanOutcome must exist');
// Balance braces rather than regex to the next `};` -- the body contains
// several of those and a lazy match would slice it off mid-branch, leaving an
// assertion that passes because it is looking at nothing (a vacuous pass this
// project has shipped before).
let depth = 0, fnEnd = -1;
for (let i = code.indexOf('{', fnStart); i < code.length; i++) {
  if (code[i] === '{') depth++;
  else if (code[i] === '}') { depth--; if (depth === 0) { fnEnd = i; break; } }
}
assert.ok(fnEnd > fnStart, 'applyScanOutcome body must be brace-balanced');
const body = code.slice(fnStart, fnEnd);

// SO-TC1: every outcome submitScan can return is handled. A missing branch is
// a card that vanishes: the scan succeeds, the server records it, and nothing
// in the UI acknowledges it.
{
  start('SO-TC1');
  for (const action of ['staged', 'added', 'staged_unresolved']) {
    assert.ok(body.includes(`outcome.action === '${action}'`),
      `applyScanOutcome must handle '${action}'`);
  }
  // ...and an else for everything else, so an unknown action reports rather
  // than silently doing nothing.
  assert.match(body, /\}\s*else\s*\{/, 'applyScanOutcome needs a terminal else branch');
  pass('SO-TC1', 'every submitScan outcome is handled, including the unknown case');
}

// SO-TC2: THE REGRESSION GUARD. The outcome rule lives in exactly ONE place.
//
// Before this extraction the identified-card handler was inline, and adding
// the on-device path would have made a second copy of the logic that decides
// what reaches Zach's collection. Two copies drift the moment either is
// touched -- four Curve-tab bugs in this app traced to exactly that.
{
  start('SO-TC2');
  const staged = [...code.matchAll(/outcome\.action === 'staged'/g)].length;
  assert.strictEqual(staged, 1,
    `the 'staged' outcome is handled in ${staged} places; it must be 1 `
    + '(call applyScanOutcome instead of pasting the block)');
  const added = [...code.matchAll(/outcome\.action === 'added'/g)].length;
  assert.strictEqual(added, 1,
    `the 'added' outcome is handled in ${added} places; it must be 1`);
  pass('SO-TC2', "the staged/added rule exists once, not once per caller");
}

// SO-TC3: staging is not bypassed. Zach chose staging for on-device reads --
// nothing reaches the collection until Add All -- so the only path that calls
// onAddSuccess is the server's own 'added' outcome, never a client decision.
{
  start('SO-TC3');
  const addedIdx = body.indexOf("outcome.action === 'added'");
  const unresolvedIdx = body.indexOf("outcome.action === 'staged_unresolved'");
  const successIdx = body.indexOf('onAddSuccess');
  assert.ok(successIdx > addedIdx && successIdx < unresolvedIdx,
    'onAddSuccess must fire only inside the server-decided "added" branch');
  pass('SO-TC3', 'the collection is only touched when the SERVER says added');
}

// SO-TC4: a failed scan stays retryable.
//
// REWRITTEN with the mechanism it guards. The rule is unchanged -- a card
// whose scan ERRORED must not be marked "already seen", or the app ignores it
// until the user notices it never appeared -- but the duplicate guard is no
// longer a name-keyed latch written here. It is a per-card-id time window
// (seenIdsRef/SEEN_CARD_MS, upstream's FastScanner.jsx:301-306), recorded by
// each scan path BEFORE submit and never by this outcome handler.
//
// So the property to assert flipped: applyScanOutcome must NOT touch the
// dedupe window at all. A handler that recorded on error would re-introduce
// exactly the silent-skip bug this case has always been about.
{
  start('SO-TC4');
  assert.ok(!/lastQueuedNameRef/.test(body),
    'the name-keyed latch is back in the outcome handler; duplicates are now '
    + 'judged by the seenIdsRef time window, recorded per scan path');
  assert.ok(!/seenIdsRef/.test(body),
    'applyScanOutcome must not record into the dedupe window -- an errored '
    + 'scan would then be treated as already seen and silently skipped');
  pass('SO-TC4', 'an errored scan does not arm the duplicate guard');
}

// SO-TC5: the UNIDENTIFIED path is deliberately NOT routed through this
// function. It answers a different question -- it has no name, so its only
// outcome is "needs a printing chosen" and it must say 'Unidentified card'
// rather than echo raw OCR text back as if it were a card name.
{
  start('SO-TC5');
  // Asserted against `code` (comments stripped) and anchored to the STATEMENT,
  // not the bare string. The first draft asserted `code.includes('Unidentified
  // card')` -- which matched the COMMENT of this very test file's rule inside
  // CameraScanner.jsx, so deleting the real label left the test green. A
  // mutation run caught it. Match the assignment that actually renders.
  assert.match(code, /const label = clipName \|\| titleText \|\| 'Unidentified card';/,
    "the unidentified path must label the card 'Unidentified card', never echo raw OCR text");
  // ...and it must NOT be routed through the identified handler, which would
  // force it through branches ('added', 'staged') it can never produce.
  const afterFn = code.slice(fnEnd);
  assert.ok(/submitScan/.test(afterFn),
    'the unidentified caller must still submit on its own terms');
  assert.ok(!/const label = clipName[\s\S]{0,200}applyScanOutcome/.test(afterFn),
    'the unidentified path must not be routed through applyScanOutcome');
  pass('SO-TC5', 'the unidentified path keeps its own handler, by design');
}

console.log(`\nscanOutcome.test.js: ${passed} cases passed`);
