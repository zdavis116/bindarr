#!/usr/bin/env bash
# MUTATION TEST for cameraFallback.test.js.
#
# Every case guards a failure that leaves the user with NO CAMERA, which is the
# worst outcome this component has. Each mutation restores the original broken
# behaviour and the harness demands the INTENDED case catches it.
set -uo pipefail
cd "$(dirname "$0")/.."

TARGET=frontend/src/components/CameraScanner.jsx
TEST=frontend/src/components/cameraFallback.test.js
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

# M1: THE BUG. Remove the deadline from the first attempt, so a cold camera
# that never starts hangs instead of falling back.
mutate M1 "await getUserMedia with no deadline" "CAM-TC1" "
  const re = /await withDeadline\(navigator\.mediaDevices\.getUserMedia\(constraints\), \d+, '[^']*'\)/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'await navigator.mediaDevices.getUserMedia(constraints)');
"

# M2: leak the abandoned stream, so a slow first attempt leaves the camera held
# and every later attempt fails with NotReadableError.
mutate M2 "never stop the late-resolving stream" "CAM-TC2" "
  const re = /p\.then\(s => s\.getTracks\(\)\.forEach\(t => t\.stop\(\)\)\)\.catch\(\(\) => \{\}\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M3: drop the unconstrained last attempt, so a webcam that cannot do 4032x3024
# gets no camera at all.
mutate M3 "remove the plain video:true fallback" "CAM-TC3" "
  const re = /return navigator\.mediaDevices\.getUserMedia\(\{ video: true, audio: false \}\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'throw err2;');
"

# M4: THE ORIGINAL SIN. Report 'check your permissions' for every failure.
mutate M4 "collapse every camera error to permissions" "CAM-TC4" "
  const re = /: err\?\.name === 'AbortError' \|\| err\?\.name === 'TimeoutError'\n\s*\? 'scan\.errCameraTimeout'[^\n]*\n/;
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
