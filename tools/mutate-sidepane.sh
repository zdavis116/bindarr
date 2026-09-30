#!/usr/bin/env bash
# MUTATION TEST for sidePaneLayout.test.js.
#
# Both bugs this guards were INVISIBLE to every check the project had: no
# error, no failing test, a clean build. They were only ever going to be found
# by Zach looking at the screen. So the mutations restore each one exactly.
set -uo pipefail
cd "$(dirname "$0")/.."

TEST=frontend/src/components/sidePaneLayout.test.js
NODE="${NODE:-node}"
TARGETS="frontend/src/index.css frontend/src/utils/zLayers.js frontend/src/components/CardInspectorModal.jsx frontend/src/components/DeckView.jsx"

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

# M1: THE BUG ZACH SAW. Remove the z-index entirely, so the fixed pane stacks
# by document order and the list's sticky headers draw through it.
mutate M1 "pane has no stacking order again" "PANE-TC1" "frontend/src/index.css" "
  const re = /    z-index: 890;\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M2: set it BELOW the list's sticky headers. Present, declared, still drawn
# through -- the version of this fix that looks right and is not.
mutate M2 "pane sits under the list headers" "PANE-TC2" "frontend/src/index.css" "
  const re = /    z-index: 890;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '    z-index: 3;');
"

# M2b: push it ABOVE the app header, so the pane covers the app chrome it is
# positioned beneath. The opposite error, equally visible.
mutate M2b "pane covers the app header" "PANE-TC2" "frontend/src/index.css" "
  const re = /    z-index: 890;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '    z-index: 1400;');
"

# M3: let the registry and the stylesheet drift apart. zLayers stops being the
# source of truth and becomes a comment.
mutate M3 "registry disagrees with the stylesheet" "PANE-TC3" "frontend/src/utils/zLayers.js" "
  const re = /export const Z_SIDE_PANE = 890;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'export const Z_SIDE_PANE = 950;');
"

# M4: THE OTHER BUG ZACH SAW. Drop overflow-wrap, so a long rules line runs
# past the column and clips instead of wrapping.
mutate M4 "rules text stops wrapping" "PANE-TC4" "frontend/src/components/CardInspectorModal.jsx" "
  const re = /                    overflowWrap: 'anywhere',\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M4b: drop minWidth:0, so the box refuses to shrink to its grid track however
# the text wraps -- the subtler half of the same failure.
mutate M4b "text box cannot shrink to its column" "PANE-TC4" "frontend/src/components/CardInspectorModal.jsx" "
  const re = /                    minWidth: 0,\n/;
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
