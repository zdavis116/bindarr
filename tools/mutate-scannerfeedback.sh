#!/usr/bin/env bash
# MUTATION TEST for scannerFeedback.test.js.
#
# Every case here guards a SILENT failure -- the scanner kept working and only
# the feedback was wrong. That is precisely the class a test suite misses, so
# each mutation restores the original bug verbatim and the harness demands the
# INTENDED case catches it.
set -uo pipefail
cd "$(dirname "$0")/.."

TEST=frontend/src/components/scannerFeedback.test.js
NODE="${NODE:-node}"
TARGETS="frontend/src/App.jsx frontend/src/components/CameraScanner.jsx frontend/src/utils/scannerWiring.js frontend/src/utils/clientScan.js"

if ! git diff --quiet -- $TARGETS "$TEST"; then
  echo "REFUSING: a target or the test has uncommitted changes. Commit first."
  exit 2
fi

fail=0

mutate() {
  local id="$1" desc="$2" expect="$3" file="$4" js="$5"
  printf '\n=== %s: %s\n' "$id" "$desc"

  if ! $NODE -e "
    const fs = require('fs');
    const p = '$file';
    const before = fs.readFileSync(p, 'utf8');
    $js
    if (after === before) { console.error('ANCHOR FAILED - source unchanged'); process.exit(3); }
    fs.writeFileSync(p, after);
  "; then
    echo "  ABORT: anchor did not match. Not running the test."
    git checkout -- $TARGETS
    fail=1
    return
  fi

  local out rc last
  out="$($NODE "$TEST" 2>&1)"; rc=$?
  git checkout -- $TARGETS

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

# M1: THE BUG. Store the bare message again, so a repeated scan of the same
# card sets an identical value and React bails out -- no toast, no re-armed
# timer.
mutate M1 "store the toast as a bare message" "BUG1-TC1" "frontend/src/App.jsx" "
  const re = /setToast\(\{ message, key: toastSeq\.current \}\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'setToast(message);');
"

# M2: drop the set from the staged toast, leaving a name that cannot tell one
# printing from another.
mutate M2 "name-only staged toast" "BUG2-TC1" "frontend/src/components/CameraScanner.jsx" "
  const re = /set: \(outcome\.card\?\.set_id \|\| '\?'\)\.toUpperCase\(\),\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M3: THE BUG. Put the sweeping scan line back on \`loading\`, which now
# toggles every 60ms.
mutate M3 "restore the loading-driven scan line" "BUG3-TC1" "frontend/src/components/CameraScanner.jsx" "
  const re = /\{\/\* The sweeping scan line is removed/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '{loading && <div className=\"scan-line\"></div>}\n                {/* The sweeping scan line is removed');
"

# M4: THE BUG. Clear the hint synchronously, so one disagreeing pass blinks
# the status line off and on.
mutate M4 "clear the hint on every empty pass" "BUG3-TC2" "frontend/src/components/CameraScanner.jsx" "
  const re = /        const next = key \? \(map\[key\] \?\? ''\) : '';/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, \"        if (!key) return setScanStatus('');\n        const next = key ? (map[key] ?? '') : '';\");
"

# M5: THE BUG. Submit crop: null again, so every review row is an empty box.
mutate M5 "submit a staged row with no crop" "BUG4-TC1" "frontend/src/utils/scannerWiring.js" "
  const re = /crop: lastCardCrop\(\),/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'crop: null,');
"

printf '\n'
if ! git diff --quiet -- $TARGETS "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
