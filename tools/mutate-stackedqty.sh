#!/usr/bin/env bash
# MUTATION TEST for stackedQuantity.test.js.
#
# Two classes of failure here and they are not equal:
#   - the edit silently does nothing (the reported bug)
#   - the edit deletes the WRONG rows, or rows it should not touch at all
#
# The second is destructive and silent. These mutations cover both.
set -uo pipefail
cd "$(dirname "$0")/.."

TEST=frontend/src/components/stackedQuantity.test.js
NODE="${NODE:-node}"
TARGETS="frontend/src/components/CardInspectorModal.jsx frontend/src/components/CollectionList.jsx backend/src/routes/collection.js"

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

# M1: THE ORIGINAL BUG. Remove the branch from handleSave, so a stacked
# quantity edit falls through to a PUT that sets a row already at 1 -- HTTP
# 200, no change.
mutate M1 "stacked edit falls back to the no-op PUT" "QTY-TC2" "frontend/src/components/CardInspectorModal.jsx" "
  const re = /      const memberIds = Array\.isArray\(card\?\.member_ids\) \? card\.member_ids : null;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '      const memberIds = null;');
"

# M1b: THE MISTAKE I ACTUALLY MADE. Move the whole branch into
# handleQuickToggle, which the Save button never calls. The code exists, reads
# correctly, and is dead -- which is exactly what shipped and did not fix the
# bug.
mutate M1b "fix moved into the toggle handler (dead code)" "QTY-TC2" "frontend/src/components/CardInspectorModal.jsx" "
  const m = before.match(/      \/\/ LOWERING A STACKED TILE[\s\S]*?\n      \}\n\n/);
  if (!m) { console.error('anchor missing'); process.exit(3); }
  let after = before.replace(m[0], '');
  const tog = after.indexOf('const handleQuickToggle = async (field, value) => {');
  if (tog < 0) { console.error('handleQuickToggle missing'); process.exit(3); }
  const insertAt = after.indexOf('\n', tog) + 1;
  after = after.slice(0, insertAt) + m[0] + after.slice(insertAt);
"

# M2: DESTRUCTIVE. Drop the stackSize > 1 guard, so a single-row tile deletes
# its only row when the user sets a quantity -- the card disappears.
mutate M2 "single-row tiles get deleted too" "QTY-TC3" "frontend/src/components/CardInspectorModal.jsx" "
  const re = /stackSize && stackSize > 1 && Number\.isFinite\(wanted\)/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'stackSize && Number.isFinite(wanted)');
"

# M2b: DESTRUCTIVE. Drop the direction check, so RAISING a quantity (2 -> 3)
# takes the delete path and slice() removes rows instead of adding any.
mutate M2b "raising a quantity deletes rows" "QTY-TC2" "frontend/src/components/CardInspectorModal.jsx" "
  const re = /&& wanted >= 1 && wanted < stackSize\) \{/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '\&\& wanted >= 1) {');
"

# M3: DESTRUCTIVE AND SUBTLE. Keep the wrong end of the stack -- slice(0,
# wanted) deletes the OLDEST rows, throwing away the purchase price and
# storage slot the user set up and keeping the newest bare row.
mutate M3 "deletes the oldest rows instead of the newest" "QTY-TC2" "frontend/src/components/CardInspectorModal.jsx" "
  const re = /const doomed = memberIds\.slice\(wanted\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'const doomed = memberIds.slice(0, wanted);');
"

# M4: return early after the delete, so the rows are gone but the shared save
# never runs -- no reload, and the tile keeps showing the old number over rows
# that no longer exist. The reported bug, now with data loss behind it.
mutate M4 "delete returns early, skipping the reload" "QTY-TC5" "frontend/src/components/CardInspectorModal.jsx" "
  const re = /        \/\/ Fall through: the surviving row still needs the other fields this/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '        return;\n        // Fall through: the surviving row still needs the other fields this');
"

# M5: hard-delete instead of trashing, so a quantity edit destroys a card with
# no undo.
mutate M5 "removal is not recoverable" "QTY-TC4" "backend/src/routes/collection.js" "
  const re = /const \{ batchId, moved \} = await trashEntries\(ids, req\.user\.id\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'const { batchId, moved } = { batchId: null, moved: ids.length };');
"

# M6: stop the collection screen tracking member rows, so the tile has no
# handle on the copies it represents.
mutate M6 "tiles no longer track their rows" "QTY-TC1" "frontend/src/components/CollectionList.jsx" "
  const re = /          member_ids: \[card\.entry_id \|\| card\.id\]/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '          member_ids: []');
"

printf '\n'
if ! git diff --quiet -- $TARGETS "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
