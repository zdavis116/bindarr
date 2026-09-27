#!/usr/bin/env bash
# MUTATION TEST for scanOrder.test.js.
#
# This file guards DELETIONS, which is the easiest kind of rule to assert
# vacuously: every check is a `!regex.test(code)`, and a regex with a typo
# never matches anything, so the guard passes for ever while the thing it
# forbids sits in the file. Each mutation puts the forbidden thing back and
# proves the intended case notices.
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
    echo "$out" | grep -E 'AssertionError|must |is back' | head -2 | sed 's/^/    /'
    fail=1
  fi
}

# M1: bring back the ImageCapture shutter -- a full still (~0.3-1s on iOS) on
# every scan, which is the single biggest thing that made this feel slow.
mutate M1 "reinstate takeStillPhoto" "FAST-TC1" "
  const anchor = '    setCaptureSource(\'video\');';
  if (!before.includes(anchor)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(anchor, '    const still = await takeStillPhoto(video);\n' + anchor);
"

# M2: re-encode the frame on the main thread instead of reusing the one the
# reader already drew. Blocks the UI on every scan that falls back.
mutate M2 "re-encode the upload with toDataURL" "FAST-TC2" "
  const anchor = 'const blob = await lastFrameJpeg();';
  if (!before.includes(anchor)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(anchor,
    \"const _c = document.createElement('canvas');\n          const _d = _c.toDataURL('image/jpeg', 0.9);\n          \" + anchor);
"

# M3: drop the early return so a proven card falls through and uploads anyway.
mutate M3 "let a proven card fall through to the upload" "FAST-TC3" "
  const anchor = '      applyScanOutcome(outcome, identified);';
  if (!before.includes(anchor)) { console.error('anchor missing'); process.exit(3); }
  const i = before.indexOf(anchor);
  const j = before.indexOf('\n      return;\n    }', i);
  if (j < 0) { console.error('return anchor missing'); process.exit(3); }
  const after = before.slice(0, j) + '\n    }' + before.slice(j + '\n      return;\n    }'.length);
"

# M4: crop before the read again -- cornelius then sees a picture of a crop,
# and three canvas draws per tick come back.
mutate M4 "crop the frame before handing it to the reader" "FAST-TC4" "
  const anchor = 'dev = await readOnDevice(video, sw, sh,';
  if (!before.includes(anchor)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(anchor,
    'const framedCanvas = cropGuideRegion(video);\n        dev = await readOnDevice(framedCanvas, sw, sh,');
"

# M5: restore the server-era retry gap.
mutate M5 "restore the 350ms rejected-frame gap" "FAST-TC5" "
  const after = before.replace('const SCAN_RETRY_REJECTED_MS = 60;', 'const SCAN_RETRY_REJECTED_MS = 350;');
"

# M6: THE EXPENSIVE ONE. Put the second ONNX detector back, competing with the
# scan's own models for the single wasm thread.
mutate M6 "reinstate the YOLO detector loop" "FAST-TC6" "
  const anchor = '    loadClientScan();';
  if (!before.includes(anchor)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(anchor, '    initCardDetector();\n' + anchor);
"

# M7: THE BUG ZACH HIT. Drop the early return, so "no card on an auto pass"
# falls through to the upload -- an empty mat JPEG'd and sent every 60ms,
# answered "No confident match" instantly and for ever.
mutate M7 "let a no-card auto pass fall through to the upload" "FAST-TC7" "
  const anchor = '        if (!deviceCard) {';
  if (!before.includes(anchor)) { console.error('anchor missing'); process.exit(3); }
  const i = before.indexOf(anchor);
  const j = before.indexOf('\n        }', i);
  if (j < 0) { console.error('block end missing'); process.exit(3); }
  const after = before.slice(0, i) + '        if (false) {' + before.slice(i + anchor.length);
"

# M8: report a reader that never ran as a failed card match -- the message that
# disguised a broken loader as a scanner that could not recognise anything.
mutate M8 "blame the card when the reader never ran" "FAST-TC8" "
  const anchor = \"setScanStatus('Scanner is still loading — try again in a moment.');\";
  if (!before.includes(anchor)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(anchor,
    \"setScanStatus('No confident match. Try again or search manually.');\");
"

printf '\n'
if ! git diff --quiet -- "$TARGET" "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
