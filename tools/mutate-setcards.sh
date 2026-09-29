#!/usr/bin/env bash
# MUTATION TEST for setCardsView.test.js.
#
# The worst failure here is silent data corruption: opening a card he does NOT
# own with an entry_id that belongs to a different card, then saving. M4 and
# M4b cover that. The rest are "the feature quietly does nothing".
set -uo pipefail
cd "$(dirname "$0")/.."

TEST=frontend/src/components/setCardsView.test.js
NODE="${NODE:-node}"
TARGETS="backend/src/routes/collection.js frontend/src/components/SetCardsView.jsx frontend/src/components/CollectorView.jsx frontend/src/components/CollectionList.jsx frontend/src/styles/collector-view.css"

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

# M1: inner join, so only owned cards come back. The screen renders perfectly
# and shows nothing missing -- the feature silently does not exist.
mutate M1 "only owned cards are returned" "SET-TC1" "backend/src/routes/collection.js" "
  const re = /         LEFT JOIN \(\n              SELECT col\.card_id/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '         JOIN (\n              SELECT col.card_id');
"

# M2: drop the set-code validation, so the path segment reaches the lookup
# unchecked.
mutate M2 "set code is not validated" "SET-TC2" "backend/src/routes/collection.js" "
  const re = /    if \(!\/\^\[a-z0-9\]\{1,10\}\\\$\/\.test\(code\)\) \{[\s\S]*?\n    \}\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M3: HIDE missing cards instead of greying them. He asked to see the whole
# set; this turns it back into the collection view he already had.
mutate M3 "missing cards are hidden" "SET-TC3" "frontend/src/styles/collector-view.css" "
  const re = /\.sc-card\.missing img \{ filter: grayscale\(1\) brightness\(0\.45\); \}/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '.sc-card.missing { display: none; }');
"

# M4: DATA CORRUPTION. Hand every card an entry_id, including ones he does not
# own -- so saving a missing card PUTs through an id belonging to another card.
mutate M4 "unowned cards carry an entry id" "SET-TC4" "frontend/src/components/CollectionList.jsx" "
  const re = /            entry_id: c\.owned \? c\.entry_id : undefined,/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '            entry_id: c.entry_id,');
"

# M4b: DATA CORRUPTION, one surface only. Drop readOnly from the phone modal
# and keep it on the desktop pane -- the guard holds where I tested and fails
# where he actually scans. This is the shape of the desktop/phone bugs that
# keep happening in this project.
mutate M4b "phone modal loses the read-only guard" "SET-TC4" "frontend/src/components/CollectionList.jsx" "
  const idx = before.lastIndexOf('readOnly={!!inspectorCard.__readOnly}');
  if (idx < 0) { console.error('anchor missing'); process.exit(3); }
  const after = before.slice(0, idx) + before.slice(idx + 'readOnly={!!inspectorCard.__readOnly}'.length);
"

# M5: render every card at once. 461 <img> elements for a viewport showing a
# dozen -- the 3.35s phone stall the gallery already solved.
mutate M5 "all cards rendered at once" "SET-TC5" "frontend/src/components/SetCardsView.jsx" "
  const re = /const visible = shown\.slice\(0, limit\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'const visible = shown;');
"

# M5b: never reset the page when the filter changes, so switching to 'missing
# only' inherits a limit from the longer list.
mutate M5b "page size survives a filter change" "SET-TC5" "frontend/src/components/SetCardsView.jsx" "
  const re = /  useEffect\(\(\) => \{ setLimit\(PAGE\); \}, \[q, onlyMissing\]\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M6: the set row stops opening anything -- the feature is unreachable, the
# control-renders-but-does-nothing failure this project keeps producing.
mutate M6 "set rows no longer open" "SET-TC6" "frontend/src/components/CollectorView.jsx" "
  const re = /            onClick=\{\(\) => setOpenSet\(s\.code\.toLowerCase\(\)\)\}\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M6b: remove the button resets, so every set row silently restyles itself.
mutate M6b "cv-row loses its button resets" "SET-TC6" "frontend/src/styles/collector-view.css" "
  const re = /  display: block;\n  width: 100%;\n  text-align: left;\n  font: inherit;\n  cursor: pointer;\n/;
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
