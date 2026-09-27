#!/usr/bin/env bash
# MUTATION TEST for scanOutcome.test.js.
#
# A guard that cannot fail is worse than no guard: it reports safety it does
# not provide. This breaks each rule the test claims to protect and asserts
# that the test -- and specifically the case named for that rule -- goes red.
#
# RULES THIS HARNESS OBEYS, all three load-bearing and all three learned from
# a harness that silently reverted a real fix:
#   1. Restore with `git checkout`, never a /tmp copy. Refuse to run against a
#      dirty tree, so it cannot destroy work it did not create.
#   2. A failed anchor ABORTS that mutation. Falling through to the test would
#      measure an UNMUTATED file and print a reassuring "still passed".
#   3. Assert the tree is clean at the end.
set -uo pipefail
cd "$(dirname "$0")/.."

TARGET=frontend/src/components/CameraScanner.jsx
TEST=frontend/src/components/scanOutcome.test.js
NODE="${NODE:-node}"

if ! git diff --quiet -- "$TARGET" "$TEST"; then
  echo "REFUSING: $TARGET or $TEST has uncommitted changes. Commit first."
  exit 2
fi

fail=0

mutate() {
  local id="$1" desc="$2" expect="$3" py="$4"
  printf '\n=== %s: %s\n' "$id" "$desc"

  if ! $NODE -e "
    const fs = require('fs');
    const p = '$TARGET';
    const before = fs.readFileSync(p, 'utf8');
    $py
    if (after === before) { console.error('ANCHOR FAILED - source unchanged'); process.exit(3); }
    fs.writeFileSync(p, after);
  "; then
    echo "  ABORT: anchor did not match. Not running the test (it would measure an unmutated file)."
    git checkout -- "$TARGET"
    fail=1
    return
  fi

  local out
  out="$($NODE "$TEST" 2>&1)"
  local rc=$?
  git checkout -- "$TARGET"

  if [ $rc -eq 0 ]; then
    echo "  STILL PASSED -> the test is VACUOUS. Fix the test, not this script."
    fail=1
    return
  fi
  # WHICH case failed, not merely that something did.
  #
  # node:assert THROWS, so the failing case never prints its own PASS line --
  # grepping for "PASS: SO-TCn" therefore reports every mutation as "caught by
  # the wrong assertion", which is how the first version of this harness lied
  # about three of five mutations. Each case prints `RUN: <id>` before it
  # asserts, so the LAST id announced is the one that threw.
  local last
  last="$(echo "$out" | grep '^RUN: ' | tail -1 | sed 's/^RUN: //')"
  if [ "$last" = "$expect" ]; then
    echo "  caught by $expect (the intended case)"
  else
    echo "  failed, but via ${last:-<none>} rather than $expect -- the wrong assertion is doing the work:"
    echo "$out" | grep -E 'AssertionError|must |^ *the ' | head -3 | sed 's/^/    /'
    fail=1
  fi
}

# M1: drop a branch. A card whose outcome is 'added' would be recorded by the
# server and never acknowledged by the UI.
mutate M1 "remove the 'added' branch" "SO-TC1" "
  const after = before.replace(\"} else if (outcome.action === 'added') {\", '} else if (false) {');
"

# M2: THE REGRESSION. Paste the rule a second time instead of calling it --
# precisely the mistake the extraction exists to prevent.
mutate M2 "duplicate the staged/added rule at a second call site" "SO-TC2" "
  const dup = [
    \"    if (outcome.action === 'staged') { staging.noteStaged(false); }\",
    \"    else if (outcome.action === 'added') { if (onAddSuccess) onAddSuccess(); }\",
  ].join('\n');
  const anchor = '  const applyScanOutcome = (outcome, identified) => {';
  const after = before.replace(anchor, '  const _dupe = (outcome) => {\n' + dup + '\n  };\n\n' + anchor);
"

# M3: let the client decide something reached the collection. Staging is the
# whole safety property Zach chose; firing onAddSuccess outside the server's
# own 'added' outcome quietly breaks it.
mutate M3 "fire onAddSuccess from the staged branch too" "SO-TC3" "
  const after = before.replace(
    \"      staging.noteStaged(false);   // resolved: a printing was chosen\",
    '      staging.noteStaged(false); if (onAddSuccess) onAddSuccess();');
"

# M4: record into the dedupe window from the outcome handler, so a card whose
# scan ERRORED is treated as already seen and silently skipped. (Re-anchored:
# this used to target the name-keyed latch, now deleted in favour of upstream's
# per-card-id time window.)
mutate M4 "arm the dedupe window from the outcome handler" "SO-TC4" "
  const re = /if \(outcome\.action === 'staged'\) \{/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re,
    \"seenIdsRef.current.set(identified, Date.now());\\n    if (outcome.action === 'staged') {\");
"

# M5: route the unidentified path through the identified handler -- the merge
# that looks like tidying and loses the 'Unidentified card' label.
#
# ANCHORED TO THE STATEMENT, NOT THE BARE STRING. Replacing just
# "'Unidentified card'" hits its FIRST occurrence, which is the COMMENT
# explaining this rule ~850 lines earlier -- so the real code was never
# mutated and the test passed for the right reason about the wrong file. That
# is the same comment-trap the test itself had. Mutate the assignment.
mutate M5 "delete the unidentified label" "SO-TC5" "
  const after = before.replace(
    \"const label = clipName || titleText || 'Unidentified card';\",
    'const label = titleText;');
"

printf '\n'
if ! git diff --quiet -- "$TARGET" "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
