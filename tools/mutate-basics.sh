#!/usr/bin/env bash
# Mutation-test the basic-land grouping rules.
#
# Each mutation breaks ONE rule and asserts the intended test — and only that
# test — goes red. A mutation that STILL PASSES means the test is vacuous.
#
# Restores with `git checkout`, never a /tmp copy: a previous harness restored
# from /tmp, silently reverted a real fix, and measured every later mutation
# against a corrupted baseline.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cache/hermes-node20/node-v20.20.2-linux-x64/bin:$PATH"

TEST=frontend/src/components/collectionFilters.test.js

# REFUSE TO RUN ON A DIRTY TREE. The restore is `git checkout`, so uncommitted
# work in these files would be destroyed by a harness that did not create it.
if ! git diff --quiet -- frontend/src; then
  echo "ABORT: uncommitted changes under frontend/src. Commit first." >&2
  exit 2
fi

fail=0

mutate() {
  local label="$1" file="$2" from="$3" to="$4" expect="$5"

  # A FAILED ANCHOR MUST ABORT THIS MUTATION, never fall through to the test:
  # otherwise the suite runs against an UNMUTATED file and reports "still
  # passed — test is vacuous" about code that was never changed.
  if ! grep -qF -- "$from" "$file"; then
    echo "ABORT [$label]: anchor not found in $file" >&2
    fail=1
    return
  fi
  python3 - "$file" "$from" "$to" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
assert old in src
open(path, 'w').write(src.replace(old, new, 1))
PY

  local out
  out=$(node --test "$TEST" 2>&1)
  git checkout -- "$file"

  if echo "$out" | grep -q "^not ok .*$expect"; then
    echo "PASS [$label]: $expect went red"
  else
    echo "VACUOUS [$label]: $expect stayed green with the rule broken" >&2
    fail=1
  fi
}

UTIL=frontend/src/utils/basicLands.js
LIST=frontend/src/components/CollectionList.jsx
TILE=frontend/src/components/CardTile.jsx

# 1. Basics stop pooling -> the whole point of the change.
mutate "no pooling" "$UTIL" \
  "if (isBasicLand(card)) return \`basic|\${card?.name || ''}\`;" \
  "" \
  "GRP-TC6"

# 2. Pool ALL basics together instead of by name -> Mountain + Island merge.
mutate "pool by type not name" "$UTIL" \
  "return \`basic|\${card?.name || ''}\`;" \
  "return 'basic';" \
  "GRP-TC7"

# 3. Widen the prefix to catch snow lands -> a card that cannot be substituted.
mutate "snow counts as basic" "$UTIL" \
  "return String(typeLine || '').startsWith(BASIC_LAND_PREFIX);" \
  "return String(typeLine || '').includes('Land —');" \
  "GRP-TC8b"

# 4. Non-basics start pooling -> a foil Sol Ring merges with a non-foil.
mutate "everything pools" "$UTIL" \
  "return [card?.card_id, card?.condition || '', card?.printing || ''].join('|');" \
  "return String(card?.name || '');" \
  "GRP-TC2"

# 5. The component goes back to its own inline key -> the drift this prevents.
mutate "inline key returns" "$LIST" \
  "const key = collectionGroupKey(card);" \
  "const key = [card.card_id, card.condition || '', card.printing || ''].join('|');" \
  "GRP-TC5"

# 6/7. Each surface re-prints a set code for basics. Both are checked because
# fixing only the reported one leaves the other stating something false.
mutate "list row shows set" "$LIST" \
  "{isBasicLand(card)" \
  "{false" \
  "GRP-TC9"

mutate "grid tile shows set" "$TILE" \
  "{isBasicLand(card) ? '' :" \
  "{false ? '' :" \
  "GRP-TC9"

INSP=frontend/src/components/CardInspectorModal.jsx
DECK=frontend/src/components/DeckView.jsx

# 8. The inspector HEADER re-prints the set beside the pooled owned count --
#    the surface Zach had to report a fourth time.
mutate "inspector header shows set" "$INSP" \
  "{isBasicLand ? '' : card.set_name}" \
  "{card.set_name}" \
  "GRP-TC9"

# 9. ...and the collector number alone, which would leave "• #395 • Common".
mutate "inspector header shows number" "$INSP" \
  "{!isBasicLand && cardNumber ?" \
  "{cardNumber ?" \
  "GRP-TC10"

# 10. The deck view regresses to its own inline copy of the rule -- the exact
#     duplication that made this take four rounds.
mutate "deck view inlines the rule" "$DECK" \
  "{!isBasicLand(card) && (" \
  "{!String(card.type_line || '').startsWith('Basic Land') && (" \
  "GRP-TC9"

# THE TREE MUST BE CLEAN AT THE END. If a restore failed, every number above is
# suspect and the next run starts from a corrupted baseline.
if ! git diff --quiet -- frontend/src; then
  echo "ABORT: tree is dirty after the run — a restore failed." >&2
  git diff --stat -- frontend/src >&2
  exit 2
fi

echo "--- tree clean, all files restored"
exit $fail
