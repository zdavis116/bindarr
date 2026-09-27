#!/usr/bin/env bash
# MUTATION TEST for fastScanLoop.test.js.
#
# This file guards a TRANSCRIPTION, and the failure mode is subtle: an
# assertion can look precise while matching something that was never at risk.
# Each mutation reintroduces a bug this port actually shipped, and the harness
# demands that the INTENDED case is the one that fails.
#
# Same three rules as the other harnesses here: restore with git checkout,
# ABORT on a failed anchor rather than testing an unmutated file, and assert a
# clean tree at the end.
set -uo pipefail
cd "$(dirname "$0")/.."

TARGET=frontend/src/utils/fastScanLoop.js
TEST=frontend/src/utils/fastScanLoop.test.js
NODE="${NODE:-node}"

if ! git diff --quiet -- "$TARGET" "$TEST"; then
  echo "REFUSING: $TARGET or $TEST has uncommitted changes. Commit first."
  exit 2
fi

fail=0

mutate() {
  local id="$1" desc="$2" expect="$3" js="$4"
  printf '\n=== %s: %s\n' "$id" "$desc"

  if ! $NODE -e "
    const fs = require('fs');
    const p = '$TARGET';
    const before = fs.readFileSync(p, 'utf8');
    $js
    if (after === before) { console.error('ANCHOR FAILED - source unchanged'); process.exit(3); }
    fs.writeFileSync(p, after);
  "; then
    echo "  ABORT: anchor did not match. Not running the test."
    git checkout -- "$TARGET"
    fail=1
    return
  fi

  local out rc last
  out="$($NODE "$TEST" 2>&1)"; rc=$?
  git checkout -- "$TARGET"

  if [ $rc -eq 0 ]; then
    echo "  STILL PASSED -> the test is VACUOUS. Fix the test, not this script."
    fail=1
    return
  fi
  last="$(echo "$out" | grep '^RUN: ' | tail -1 | sed 's/^RUN: //')"
  if [ "$last" = "$expect" ]; then
    echo "  caught by $expect (the intended case)"
  else
    echo "  failed, but via ${last:-<none>} rather than $expect:"
    echo "$out" | grep -E 'AssertionError' | head -1 | sed 's/^/    /'
    fail=1
  fi
}

# M1: put the upload before the backoff, defeating the backoff entirely -- the
# same unresolvable card re-uploaded every 60ms for ever.
mutate M1 "move the upload ahead of the backoff hold" "FID-TC1" "
  const re = /else if \(autoPass && !serverAllowed\(/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'else if (false && autoPass && !serverAllowed(');
"

# M2: THE BUG THAT CAUSED THE DUPLICATES. Key the dedupe on a name instead of
# the card id, so two paths write keys that can never match.
mutate M2 "key the dedupe on a name instead of card.id" "FID-TC2" "
  const re = /const last = seenIdsRef\.current\.get\(h\.card\.id\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'const last = seenIdsRef.current.get(h.title);');
"

# M3: stop clearing the streak on an empty frame, so a NEW card inherits the
# previous card's backoff and is held back.
#
# Targets the NO-CARD BRANCH specifically. The first version deleted the first
# bare `failStreakRef.current = null` it found and the test stayed green,
# because the same assignment also appears in setAutoRunning's reset -- the
# vacuous guard this harness exists to catch.
mutate M3 "never clear the fail streak on an empty frame" "FID-TC3" "
  const re = /(!local\?\.candidates\?\.length\) \{ why = 'no-card'; )failStreakRef\.current = null; /;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '\$1');
"

# M4: paint a progress hint before the work, which no early return can clear --
# the 'stuck on Initializing scanner' bug.
mutate M4 "set a hint before the scan decision" "FID-TC4" "
  const re = /const t0 = performance\.now\(\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, \"onHint('working');\n    const t0 = performance.now();\");
"

# M5: release busy only on the success path, so one early return wedges the
# scanner with no way back except restarting the camera.
mutate M5 "release the busy flag outside finally" "FID-TC5" "
  const re = /\} finally \{/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '} if (false) {');
"

# M6: drift a constant. 'About right' is not a transcription.
mutate M6 "change the dedupe window away from upstream's" "FID-TC6" "
  const re = /export const SEEN_CARD_MS = 4000;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'export const SEEN_CARD_MS = 1500;');
"

printf '\n'
if ! git diff --quiet -- "$TARGET" "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
