#!/usr/bin/env bash
# MUTATION TEST for scannerRefs.test.js.
#
# These guards exist because a ref that is declared, passed to the loop and
# never assigned is invisible to the compiler, the linter AND the test suite.
# Each mutation reproduces a wiring gap that actually shipped, and the harness
# demands the INTENDED case catches it.
set -uo pipefail
cd "$(dirname "$0")/.."

TARGET=frontend/src/components/CameraScanner.jsx
TEST=frontend/src/components/scannerRefs.test.js
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

# M1: THE BUG THAT SHIPPED. Call the loader and throw its answer away, so the
# on-device reader never turns on and every frame goes to the server.
mutate M1 "call loadClientScan fire-and-forget" "WIRE-TC1" "
  const re = /const attempt = \(\) => loadClientScan\(\)[\s\S]*?\}\)\.catch\(\(\) => \{\}\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'const attempt = () => loadClientScan();');
"

# M2: never start the loop -- a camera that previews and scans nothing.
mutate M2 "never start the auto loop" "WIRE-TC2" "
  const re = /scannerRef\.current\.setAutoRunning\(\s*\n\s*true,/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'scannerRef.current.setAutoRunning(\n      false,');
"

# M3: leave aliveRef false, so isStale() is true on every pass and nothing is
# ever staged even though scans run.
mutate M3 "never mark the component alive" "WIRE-TC3" "
  const re = /aliveRef\.current = true;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M4: let the scanner capture the first render's applyScanOutcome for ever.
mutate M4 "stop refreshing applyScanOutcomeRef" "WIRE-TC4" "
  const re = /applyScanOutcomeRef\.current = applyScanOutcome;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

printf '\n'
if ! git diff --quiet -- "$TARGET" "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
