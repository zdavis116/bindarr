#!/usr/bin/env bash
# MUTATION TEST for scanOrder.test.js.
#
# This file guards an ORDERING, which is the easiest kind of rule to assert
# vacuously: every positional check is two indexOf calls, and an indexOf that
# misses returns -1, which is happily "less than" everything. A guard that
# cannot fail would report a fast scanner while the slow order was back.
#
# Same three rules as tools/mutate-scanoutcome.sh: restore with git checkout,
# abort on a failed anchor, assert a clean tree at the end.
set -uo pipefail
cd "$(dirname "$0")/.."

TARGET=frontend/src/components/CameraScanner.jsx
TEST=frontend/src/components/scanOrder.test.js
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
    echo "  ABORT: anchor did not match. Not running the test (it would measure an unmutated file)."
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
  # Each case prints `RUN: <id>` before asserting, so the last id announced is
  # the one that threw. Grepping for a PASS line cannot work: assert throws, so
  # the failing case never prints one.
  last="$(echo "$out" | grep '^RUN: ' | tail -1 | sed 's/^RUN: //')"
  if [ "$last" = "$expect" ]; then
    echo "  caught by $expect (the intended case)"
  else
    echo "  failed, but via ${last:-<none>} rather than $expect:"
    echo "$out" | grep -E 'AssertionError|must ' | head -2 | sed 's/^/    /'
    fail=1
  fi
}

# M1: THE REGRESSION. Move the still back in front of the read -- the exact
# shape this branch started with, and the one Zach noticed as "way slower".
mutate M1 "take the ImageCapture still before the on-device read" "FAST-TC1" "
  const still = 'const still = await takeStillPhoto(video);';
  const anchor = '    let deviceCard = null;';
  if (!before.includes(still) || !before.includes(anchor)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(still, '').replace(anchor, still + '\n' + anchor);
"

# M2: encode the upload JPEG up front again. Blocks the main thread on every
# scan, including the ~93% that never upload.
mutate M2 "hoist the main-thread JPEG encode above the read" "FAST-TC2" "
  const enc = \"const imageData = up.toDataURL('image/jpeg', SCAN_UPLOAD_Q);\";
  const anchor = '    let deviceCard = null;';
  if (!before.includes(enc) || !before.includes(anchor)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(enc, \"const imageData = '';\")
    .replace(anchor, \"    const _x = up_unused;\" + enc.replace('up.', 'up_unused.') + '\n' + anchor);
"

# M3: drop the early return, so a proven card falls through and uploads anyway.
# The scan then costs MORE than before this feature existed.
mutate M3 "let a proven card fall through to the upload" "FAST-TC3" "
  const anchor = '      applyScanOutcome(outcome, identified);';
  if (!before.includes(anchor)) { console.error('anchor missing'); process.exit(3); }
  const i = before.indexOf(anchor);
  const j = before.indexOf('\n      return;\n    }', i);
  if (j < 0) { console.error('return anchor missing'); process.exit(3); }
  const after = before.slice(0, j) + '\n    }' + before.slice(j + '\n      return;\n    }'.length);
"

# M4: feed the reader a still-derived canvas instead of the live preview.
# Looks more correct (better pixels!), and silently restores the slow order
# while every ordering assertion stays green -- which is exactly why FAST-TC4
# checks the ARGUMENT NAME rather than a position.
mutate M4 "feed readOnDevice a still-derived canvas" "FAST-TC4" "
  const read = 'const dev = await readOnDevice(framedCanvas, framedCanvas.width, framedCanvas.height,';
  if (!before.includes(read)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(read,
    'const stillCanvas = framedCanvas;\n        const dev = await readOnDevice(stillCanvas, stillCanvas.width, stillCanvas.height,');
"

# M5: restore the server-era retry gap.
mutate M5 "restore the 350ms rejected-frame gap" "FAST-TC5" "
  const after = before.replace('const SCAN_RETRY_REJECTED_MS = 60;', 'const SCAN_RETRY_REJECTED_MS = 350;');
"

printf '\n'
if ! git diff --quiet -- "$TARGET" "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
