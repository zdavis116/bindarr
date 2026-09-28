#!/usr/bin/env bash
# MUTATION TEST for incrementalStaging.test.js.
#
# Two classes of failure here and they are not equal. Losing the optimisation
# is slow. Losing the COUNTS is a correctness bug that reaches the collection:
# `unresolved` gates Add All, so a partial count could let a commit through
# with unreviewed rows in it.
set -uo pipefail
cd "$(dirname "$0")/.."

TEST=frontend/src/components/incrementalStaging.test.js
NODE="${NODE:-node}"
TARGETS="backend/src/routes/collection.js frontend/src/components/scanStaging.js frontend/src/components/DesktopScanLayout.jsx"

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

# M1: THE ORIGINAL BUG. Put the full refresh back on the per-scan path.
mutate M1 "per-scan effect refetches the whole list" "INCR-TC1" "frontend/src/components/DesktopScanLayout.jsx" "
  const re = /if \(lastScanned\) staging\.refreshSince\(\)\.then\(setState\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'if (lastScanned) sync();');
"

# M2: THE DANGEROUS ONE. Count only the returned page, so a partial response
# reports 'unresolved: 0' and Add All unlocks while unreviewed rows remain.
mutate M2 "counts describe the page, not the session" "INCR-TC2" "backend/src/routes/collection.js" "
  const re = /unresolved: totals \? \(totals\.unresolved \|\| 0\) : rows\.filter\(r => !r\.card_id\)\.length,/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'unresolved: rows.filter(r => !r.card_id).length,');
"

# M3: replace instead of append, so the table shows only the newest row.
mutate M3 "increment replaces the list" "INCR-TC3" "frontend/src/components/scanStaging.js" "
  const re = /entries = entries\.concat\(fresh\.filter\(e => !seen\.has\(e\.id\)\)\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'entries = fresh;');
"

# M4: trust the client's `since` unvalidated, so junk no longer degrades to
# the full list.
mutate M4 "since is used unvalidated" "INCR-TC4" "backend/src/routes/collection.js" "
  const re = /const since = Number\.isSafeInteger\(sinceRaw\) && sinceRaw > 0 \? sinceRaw : null;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'const since = sinceRaw;');
"

# M5: make a MUTATION incremental too, so an edited row never updates on screen.
mutate M5 "updateEntry stops reconciling" "INCR-TC5" "frontend/src/components/scanStaging.js" "
  const m = before.match(/async function updateEntry\([\s\S]{0,900}?\n  \}/);
  if (!m) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(m[0], m[0].replace('await refresh();', ''));
"

printf '\n'
if ! git diff --quiet -- $TARGETS "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
