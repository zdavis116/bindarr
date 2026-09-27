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
  const anchor = 'local = await readOnDevice(video, sw, sh,';
  if (!before.includes(anchor)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(anchor,
    'const framedCanvas = cropGuideRegion(video);\n      local = await readOnDevice(framedCanvas, sw, sh,');
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

# M7: drop needsServer's guard, so a proven card is never hydrated and every
# frame -- proven or not -- goes to the server. (Re-anchored: this used to
# target the no-card early return, which FAST-TC11 has since removed.)
mutate M7 "stop letting needsServer gate the hydrate" "FAST-TC7" "
  const re = /if \(!needsServer\(local, \{ autoPass: !isManual \}\)\) \{/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'if (false) {');
"

# M8: report a reader that never ran as a failed card match -- the message that
# disguised a broken loader as a scanner that could not recognise anything.
mutate M8 "blame the card when the reader never ran" "FAST-TC8" "
  const anchor = \"setScanStatus('Scanner is still loading — try again in a moment.');\";
  if (!before.includes(anchor)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(anchor,
    \"setScanStatus('No confident match. Try again or search manually.');\");
"

# M9: THE BUG. Announce 'Initializing scanner...' on every pass including auto,
# where the no-card early return leaves it on screen for ever.
#
# Anchored with a REGEX rather than a quoted literal: the mutation body is bash
# inside a JS string, so a literal containing both quote kinds needs three
# levels of escaping and silently produced a syntax error the first time -- the
# harness correctly ABORTED rather than testing an unmutated file.
mutate M9 "set the progress message on auto passes too" "FAST-TC9" "
  const re = /if \(isManual\) (setScanStatus\('Initializing scanner)/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '\$1');
"

# M10: let the hold path return without reporting anything, so whatever the
# previous pass wrote stays on screen. (Re-anchored: this used to target the
# no-card return, which FAST-TC11 has since removed entirely.)
mutate M10 "hold path returns without a status" "FAST-TC10" "
  const re = /\n\s*setScanStatus\(t\('scan\.holdSteady'\)\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M11: THE BUG. Replace upstream's backoff hold with a bare "the phone did not
# prove it" return, so an unproven card never reaches the server and the UI can
# only ever say "waiting for a card".
mutate M11 "return whenever the phone did not prove a card" "FAST-TC11" "
  const re = /if \(!deviceCard && !isManual && !serverAllowed\(failStreakRef\.current, Date\.now\(\), local\)\) \{/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'if (!deviceCard) {');
"

# M12: keep the gate, remove the sensor. serverAllowed() with a streak that is
# never built always returns true -- the backoff silently never engages.
mutate M12 "stop maintaining the fail streak" "FAST-TC12" "
  const re = /failStreakRef\.current = nextFailStreak\(/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'const _unused = nextFailStreakDisabled = (');
"

printf '\n'
if ! git diff --quiet -- "$TARGET" "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
