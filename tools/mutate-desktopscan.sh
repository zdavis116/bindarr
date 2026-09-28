#!/usr/bin/env bash
# MUTATION TEST for desktopScanLayout.test.js.
#
# These guards protect a 1:1 transcription of an artifact Zach approved. The
# failure they exist to catch is silent: the build drifts from the mockup, the
# component still renders, and nobody notices until he does. Each mutation
# introduces a plausible drift and the harness demands the INTENDED case
# catches it.
set -uo pipefail
cd "$(dirname "$0")/.."

TEST=frontend/src/components/desktopScanLayout.test.js
NODE="${NODE:-node}"
TARGETS="frontend/src/components/DesktopScanLayout.jsx frontend/src/styles/desktop-scanner.css frontend/src/locales/en.json"

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

# M1: make the camera column a FRACTION. This is variant A's rejected
# behaviour: the camera grows on a wide monitor and eats the table.
mutate M1 "camera column becomes a fraction" "DSK-TC1" "frontend/src/styles/desktop-scanner.css" "
  const re = /grid-template-columns: 520px minmax\(0, 1fr\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'grid-template-columns: 1fr minmax(0, 1fr);');
"

# M2: drop a column the approved mockup has.
mutate M2 "remove the When column" "DSK-TC2" "frontend/src/components/DesktopScanLayout.jsx" "
  const re = /<th style=\{\{ width: 80 \}\}>\{t\('scan\.colWhen'\)\}<\/th>\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M2b: THE SILENT i18n FAILURE. Remove a key from en.json, so the column header
# renders as the literal text 'scan.colSet' on screen. Nothing throws.
mutate M2b "delete an i18n key so the header renders its own key" "DSK-TC2" "frontend/src/locales/en.json" "
  const j = JSON.parse(before);
  if (!('scan.colSet' in j)) { console.error('anchor missing'); process.exit(3); }
  delete j['scan.colSet'];
  const after = JSON.stringify(j, null, 2) + '\n';
"

# M3: THE CLASSIC PORT FAILURE. Markup survives a port because it is copied;
# interactions get re-implemented, so they are what goes missing. Here the
# quantity control renders and does nothing.
mutate M3 "quantity buttons stop calling staging" "DSK-TC3" "frontend/src/components/DesktopScanLayout.jsx" "
  const re = /await staging\.updateEntry\(entry\.id, \{ quantity \}\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M4: drop a feature the MOCKUP never showed but the phone has. A short demo
# does not exercise weak matches; silence is not permission to remove one.
mutate M4 "drop the weak-match warning" "DSK-TC4" "frontend/src/components/DesktopScanLayout.jsx" "
  const re = /const isWeak = !isUnresolved && isWeakMatch\(e\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'const isWeak = false;');
"

# M5: THE EXPLICIT INSTRUCTION. Move a rule outside the desktop media query, so
# it reaches the phone -- 'don't touch the phone layout'.
mutate M5 "a CSS rule escapes the desktop breakpoint" "DSK-TC5" "frontend/src/styles/desktop-scanner.css" "
  const after = before + '\n.dsk-table td { padding: 2rem; }\n';
"

# M6: remove the landing flash, the cue that ties 'I scanned that' to 'that row'.
mutate M6 "no flash when a row lands" "DSK-TC6" "frontend/src/styles/desktop-scanner.css" "
  const re = /animation: dsk-land 0\.8s ease-out;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

printf '\n'
if ! git diff --quiet -- $TARGETS "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
