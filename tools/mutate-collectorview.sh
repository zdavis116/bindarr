#!/usr/bin/env bash
# MUTATION TEST for collectorView.test.js.
#
# The dangerous failures here are all WRONG NUMBERS, not crashes. A completion
# bar that counts foils twice, or divides by a stale total, renders perfectly
# and tells Zach something false about the cards on his shelf. That is worse
# than no feature.
set -uo pipefail
cd "$(dirname "$0")/.."

TEST=frontend/src/components/collectorView.test.js
NODE="${NODE:-node}"
TARGETS="backend/src/routes/collection.js frontend/src/components/CollectorView.jsx frontend/src/components/CollectionList.jsx frontend/src/locales/en.json"

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

# M1: count every ROW instead of distinct numbers. A foil and a non-foil of the
# same card would each advance the bar -- "foil doesn't count as long as I have
# 1 card for that set and number combo".
mutate M1 "foils count twice toward the set" "COLL-TC1" "backend/src/routes/collection.js" "
  const re = /COUNT\(DISTINCT c\.number\)            AS owned/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'COUNT(c.number)                     AS owned');
"

# M1b: include token sets, which he explicitly excluded.
mutate M1b "token sets are counted" "COLL-TC1" "backend/src/routes/collection.js" "
  const re = /\n          AND s\.series != 'token'/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M1c: drop the range check, so a Secret Lair numbered #7102 counts toward a
# 2678-card set and the bar sails past 100%.
mutate M1c "out-of-range promos count" "COLL-TC1" "backend/src/routes/collection.js" "
  const re = /\n          AND CAST\(c\.number AS INTEGER\) BETWEEN 1 AND s\.total/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M2: remove the clamp. With a stale denominator this renders 670%, which is
# exactly what the stale sets table would have produced this morning.
mutate M2 "percentage is not clamped" "COLL-TC2" "backend/src/routes/collection.js" "
  const re = /Math\.min\(100, Math\.round\(\(r\.owned \/ r\.total\) \* 1000\) \/ 10\)/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'Math.round((r.owned / r.total) * 1000) / 10');
"

# M3: compute completion in the browser from the collection array -- 4,968 rows
# grouped on a phone's main thread, for a number SQL produces in one pass.
mutate M3 "completion computed client-side" "COLL-TC3" "frontend/src/components/CollectorView.jsx" "
  const re = /const res = await fetch\('\/api\/set-completion'\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'const res = await fetch(\'/api/collection\');');
"

# M4: remove the third view button, leaving the branch unreachable -- the
# control-renders-but-cannot-be-reached failure this project keeps producing.
mutate M4 "no collector button in the switcher" "COLL-TC4" "frontend/src/components/CollectionList.jsx" "
  const re = /\{ m: 'collector', Icon: Library, label: t\('collection\.collectorView'\) \}\]/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, ']');
"

# M5: put the collector branch AFTER the empty-state check, so filtering to
# something with no matches hides the progress bars entirely.
mutate M5 "card filters can hide set progress" "COLL-TC5" "frontend/src/components/CollectionList.jsx" "
  const m = before.match(/\) : viewMode === 'collector' \? \(\n([\s\S]*?)<CollectorView \/>\n      /);
  if (!m) { console.error('anchor missing'); process.exit(3); }
  const block = m[0];
  let after = before.replace(block, ') : ');
  // Re-insert it after the empty-state branch instead.
  after = after.replace(/\) : viewMode === 'gallery' \? \(/, block.replace(') : ', ') : ') + ') : viewMode === \'gallery\' ? (');
"

# M6: delete a string, so the screen renders 'collector.filterSets' at the user.
mutate M6 "a missing i18n key renders as the key" "COLL-TC6" "frontend/src/locales/en.json" "
  const j = JSON.parse(before);
  if (!('collector.filterSets' in j)) { console.error('anchor missing'); process.exit(3); }
  delete j['collector.filterSets'];
  const after = JSON.stringify(j, null, 2) + '\n';
"

printf '\n'
if ! git diff --quiet -- $TARGETS "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
