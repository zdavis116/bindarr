#!/usr/bin/env bash
# Mutation-test the compare sectioning guards: break each rule, confirm the
# intended test fails, restore, move on.
#
# RESTORE COMES FROM GIT, NOT /tmp.
#
# The first version copied the sources to /tmp and restored from there. When one
# mutation's anchor went stale, the python edit failed, the test ran against an
# UNMUTATED file, reported "STILL PASSED - test is vacuous", and then copied
# that file over the backup -- so every later mutation was measured against a
# corrupted baseline, and a real fix of mine got silently reverted. Restoring
# from the index cannot drift, and `git diff --quiet` at the end proves it.
#
# PRECONDITION: a clean working tree for the files under test. The script
# refuses to run otherwise, because it cannot tell your edits from its own.
set -uo pipefail
cd /home/hermes/repos/bindarr || exit 1
export PATH="$HOME/.cache/hermes-node20/node-v20.20.2-linux-x64/bin:$PATH"

CS=frontend/src/components/compareSections.js
DLS=frontend/src/components/deckListSections.js
DCM=frontend/src/components/DeckCompareModal.jsx
EN=frontend/src/locales/en.json
TEST=frontend/src/components/compareSections.test.js
FILES="$CS $DLS $DCM $EN"

if ! git diff --quiet -- $FILES; then
  echo "REFUSING TO RUN: uncommitted changes in the files under test."
  echo "Commit or stash them first -- this script restores with git checkout"
  echo "and would destroy your work."
  git diff --stat -- $FILES
  exit 1
fi

restore() { git checkout -- $FILES; }

# Apply a python replacement, ABORTING if the anchor is stale. A mutation that
# does not apply must never be measured: it looks like a passing test.
mutate() {
  local file="$1" old="$2" new="$3"
  python3 - "$file" "$old" "$new" <<'PY' || return 1
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if old not in s:
    sys.stderr.write('STALE ANCHOR: %r not found in %s\n' % (old[:60], path))
    sys.exit(1)
open(path, 'w').write(s.replace(old, new))
PY
}

expect() {
  local want="$1"
  if node $TEST >/tmp/mut-out 2>&1; then
    echo "  !!! STILL PASSED - $want does not actually guard this"
    FAILURES=$((FAILURES + 1))
  else
    local got
    got=$(grep -o 'CS-TC[0-9]*' /tmp/mut-out | head -1)
    if [ "$got" = "$want" ]; then
      echo "  failed as intended: $got"
    else
      echo "  !!! WRONG TEST FAILED: expected $want, got '${got:-<crash>}'"
      FAILURES=$((FAILURES + 1))
    fi
  fi
  restore
}

# Some mutations are caught by more than one guard; the earliest one fires.
# That is fine -- what matters is that the failure is CAUGHT and named, not
# which assertion gets there first.
expect_any() {
  local want="$1"
  if node $TEST >/tmp/mut-out 2>&1; then
    echo "  !!! STILL PASSED - nothing guards this"
    FAILURES=$((FAILURES + 1))
  else
    local got
    got=$(grep -o 'CS-TC[0-9]*' /tmp/mut-out | head -1)
    if [[ " $want " == *" $got "* ]]; then
      echo "  failed as intended: $got"
    else
      echo "  !!! WRONG TEST FAILED: expected one of [$want], got '${got:-<crash>}'"
      FAILURES=$((FAILURES + 1))
    fi
  fi
  restore
}

FAILURES=0

echo "M1: drop the alphabetical sort (expect CS-TC2)"
mutate $CS 'groupIntoSections(cards, { sort: byName })' 'groupIntoSections(cards)' \
  && expect CS-TC2 || { echo "  ABORT: anchor stale"; FAILURES=$((FAILURES+1)); restore; }

echo "M2: sort sections alphabetically instead of Moxfield order (expect CS-TC1)"
mutate $DLS "  return [...TYPE_ORDER, 'Other']" "  return [...TYPE_ORDER, 'Other'].slice().sort()" \
  && expect CS-TC1 || { echo "  ABORT: anchor stale"; FAILURES=$((FAILURES+1)); restore; }

echo "M3: drop unknown types instead of filing them in Other (expect CS-TC4)"
mutate $DLS '    if (!by.has(key)) by.set(key, []);' \
  "    if (key === 'Other') continue;
    if (!by.has(key)) by.set(key, []);" \
  && expect CS-TC4 || { echo "  ABORT: anchor stale"; FAILURES=$((FAILURES+1)); restore; }

echo "M4: count rows instead of physical cards (expect CS-TC6)"
mutate $DLS 'n + (c.quantity ?? 1)' 'n + 1' \
  && expect CS-TC6 || { echo "  ABORT: anchor stale"; FAILURES=$((FAILURES+1)); restore; }

echo "M5: recompute shared in the UI instead of reading the server flag (expect CS-TC7)"
mutate $DCM "className={c.shared ? '' : 'mpc-differs'}" \
  "className={diff.mine.some((m) => m.oracleId === c.oracleId) ? '' : 'mpc-differs'}" \
  && expect CS-TC7 || { echo "  ABORT: anchor stale"; FAILURES=$((FAILURES+1)); restore; }

echo "M6: lose the Battle section, as the shipped version did (expect CS-TC8)"
mutate $DLS "'Planeswalker', 'Battle', 'Land'" "'Planeswalker', 'Land'" \
  && expect CS-TC8 || { echo "  ABORT: anchor stale"; FAILURES=$((FAILURES+1)); restore; }

echo "M6b: emit a section name nothing renders, deleting those cards (expect CS-TC10)"
# The failure CS-TC10 exists for: sectionForCard returns a name that is not in
# [...TYPE_ORDER, 'Other'], so groupIntoSections filters those cards away and
# the user silently loses them.
mutate $DLS "return CARD_TYPES.find((ty) => line.includes(ty)) || 'Other';" \
  "return CARD_TYPES.find((ty) => line.includes(ty)) || 'Misc';" \
  && expect_any "CS-TC4 CS-TC10" || { echo "  ABORT: anchor stale"; FAILURES=$((FAILURES+1)); restore; }

echo "M7: revert a section label to the plural form (expect CS-TC9)"
mutate $EN '"mpc.sectionCreature": "Creature"' '"mpc.sectionCreature": "Creatures"' \
  && expect CS-TC9 || { echo "  ABORT: anchor stale"; FAILURES=$((FAILURES+1)); restore; }

echo "--- baseline (must be all PASS):"
node $TEST || FAILURES=$((FAILURES + 1))

echo "--- working tree must be clean again:"
if git diff --quiet -- $FILES; then
  echo "restore clean"
else
  echo "!!! FILES LEFT MUTATED:"; git diff --stat -- $FILES; FAILURES=$((FAILURES + 1))
fi

echo
[ "$FAILURES" -eq 0 ] && echo "ALL MUTATIONS CAUGHT" || echo "PROBLEMS: $FAILURES"
exit $FAILURES
