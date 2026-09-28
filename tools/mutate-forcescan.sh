#!/usr/bin/env bash
# MUTATION TEST for forceScan.test.js.
#
# The failure this guards is invisible: a force button that runs an ordinary
# AUTO pass still renders, still fires, still hits both gates -- so it appears
# to do nothing and nothing errors. That is the same shape as every other bug
# in this scanner's history.
set -uo pipefail
cd "$(dirname "$0")/.."

TEST=frontend/src/components/forceScan.test.js
NODE="${NODE:-node}"
TARGETS="frontend/src/components/CameraScanner.jsx frontend/src/components/DesktopScanLayout.jsx frontend/src/styles/desktop-scanner.css frontend/src/utils/fastScanLoop.js frontend/src/locales/en.json"

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

# M1: apply the stillness gate to EVERY pass, so forcing cannot get past
# "printing is moving" -- the exact symptom reported.
mutate M1 "stillness gate applies to every pass" "FORCE-TC1" "frontend/src/utils/fastScanLoop.js" "
  const re = /requireStill: autoPass/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'requireStill: true');
"

# M2: apply the 4s dedupe window to manual passes too, so a genuine second copy
# of the same card still cannot be staged back to back.
mutate M2 "dedupe window applies to manual passes" "FORCE-TC1" "frontend/src/utils/fastScanLoop.js" "
  const re = /if \(!autoPass\) return true;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M3: THE SILENT ONE. Make the desktop force button an AUTO pass. It renders,
# it fires, it hits both gates, and it looks broken for no visible reason.
mutate M3 "desktop force button becomes an auto pass" "FORCE-TC2" "frontend/src/components/CameraScanner.jsx" "
  const re = /onForceScan=\{\(\) => handleCaptureRef\.current\?\.\(false\)\}/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'onForceScan={() => handleCaptureRef.current?.(true)}');
"

# M4: remove the visible phone button, leaving only the undiscoverable
# tap-anywhere target -- the state that made Zach ask for a feature he had.
mutate M4 "phone keeps only the invisible tap target" "FORCE-TC3" "frontend/src/components/CameraScanner.jsx" "
  const re = /\{t\('scan\.forceScan'\)\}/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '{null}');
"

# M5: centre the desktop button so it covers the status pill -- hiding the
# message that explains why the scan was refused.
mutate M5 "force button covers the status message" "FORCE-TC4" "frontend/src/styles/desktop-scanner.css" "
  const re = /(\.dsk-force \{[\s\S]*?)    right: 0\.7rem;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '\$1    left: 50%;');
"

printf '\n'
if ! git diff --quiet -- $TARGETS "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
