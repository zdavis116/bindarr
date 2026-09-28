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
mutate M1 "await each rung with no deadline" "CAM-TC1" "
  const re = /await withDeadline\(attempt, CAMERA_ATTEMPT_MS, rung\.name\)/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'await attempt');
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
# M3: THE BUG ZACH HIT SECOND. Stop remembering the winning rung, so every
# camera open pays for the failed attempts again.
mutate M3 "never remember the rung that worked" "CAM-TC3" "
  const re = /\} else if \(usedRung !== remembered\) \{\n\s*localStorage\.setItem\(LADDER_KEY, String\(usedRung\)\);\n\s*\}/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '}');
"

# M5: put the deadline back to a value the user actually notices, so two failed
# rungs cost ~12s of dead preview.
mutate M5 "restore a 6s per-attempt deadline" "CAM-TC5" "
  const re = /const CAMERA_ATTEMPT_MS = \d+;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'const CAMERA_ATTEMPT_MS = 6000;');
"

# M4: THE ORIGINAL SIN. Report 'check your permissions' for every failure.
mutate M4 "collapse every camera error to permissions" "CAM-TC4" "
  const re = /: err\?\.name === 'AbortError' \|\| err\?\.name === 'TimeoutError'\n\s*\? 'scan\.errCameraTimeout'[^\n]*\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M6: THE 640x480 BUG. Collapse the ladder back to "everything, then nothing",
# so a 4K camera that cannot start at 4K falls through to the browser default.
mutate M6 "remove the intermediate resolution rungs" "CAM-TC6" "
  const re = /\{ name: '1440p'[\s\S]*?\{ name: '720p'[^\n]*\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M7: stop checking what the camera ACTUALLY returned, so a silently-negotiated
# 640x480 gets remembered as if it were a success.
mutate M7 "never read back the negotiated frame size" "CAM-TC7" "
  const re = /const settings = mediaStream\.getVideoTracks\(\)\[0\]\?\.getSettings\?\.\(\) \|\| \{\};/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'const settings = {};');
"

printf '\n'
if ! git diff --quiet -- "$TARGET" "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
