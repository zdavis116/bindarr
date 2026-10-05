#!/usr/bin/env bash
# Mutation-test the import ledger guards. Same contract as mutate-preview.sh:
# restore from git, ABORT on a stale anchor, prove the tree is clean at the end.
#
# The point of this feature is that "did I add this precon?" gets a truthful
# answer. Every guard below protects a way that answer could silently become a
# lie while the import itself keeps working.
set -uo pipefail
cd /home/hermes/repos/bindarr || exit 1
export PATH="$HOME/.cache/hermes-node20/node-v20.20.2-linux-x64/bin:$PATH"

DB=backend/src/db.js
RT=backend/src/routes/products.js
TEST=backend/test/e2e/import_ledger.test.js
FILES="$DB $RT"

if ! git diff --quiet -- $FILES; then
  echo "REFUSING TO RUN: uncommitted changes in the files under test."
  echo "Commit first -- this harness restores with 'git checkout' and would"
  echo "destroy work it did not create."
  git diff --stat -- $FILES
  exit 1
fi

restore() { git checkout -- $FILES; }

mutate() {
  python3 - "$1" "$2" "$3" <<'PY' || return 1
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if old not in s:
    sys.stderr.write('STALE ANCHOR: %r not in %s\n' % (old[:70], path))
    sys.exit(1)
open(path, 'w').write(s.replace(old, new, 1))
PY
}

FAILURES=0
expect() {
  local want="$1"
  if node $TEST >/tmp/il-out 2>&1; then
    echo "  !!! STILL PASSED - $want does not guard this (VACUOUS TEST)"
    FAILURES=$((FAILURES + 1))
  else
    # Match the FAIL line only. An earlier version grepped the whole output and
    # always found "PASS: IL-TC1" first, reporting WRONG TEST for every
    # correctly-failing guard. The harness must not lie about the harness.
    local got; got=$(grep -o 'FAIL: IL-TC[0-9]*' /tmp/il-out | head -1 | sed 's/FAIL: //')
    if [ "$got" = "$want" ]; then echo "  failed as intended: $got"
    else echo "  !!! WRONG TEST: expected $want, got '${got:-<crash>}'"
      FAILURES=$((FAILURES + 1)); fi
  fi
  restore
}

# A FAILED ANCHOR MUST ABORT THIS MUTATION, never fall through to the test --
# otherwise the test runs against an UNMUTATED file, prints "still passed", and
# we conclude the guard is vacuous when actually the edit never happened.
try() {
  local desc="$1" want="$2" file="$3" old="$4" new="$5"
  echo "- $desc"
  if ! mutate "$file" "$old" "$new"; then
    echo "  !!! ABORTED: stale anchor, mutation not applied, test NOT run"
    FAILURES=$((FAILURES + 1)); restore; return
  fi
  expect "$want"
}

echo "=== import ledger mutations ==="

# The whole feature: stop recording imports. The import still works, the user
# still gets their cards -- and the history silently stops growing.
try "adder no longer records the import" IL-TC3 "$RT" \
  "ledger = await recordImport(user, descriptor, added);" \
  "// ledger = await recordImport(user, descriptor, added);"

# Record it, but AFTER the transaction. A rolled-back import would still be
# logged as having happened.
try "recordImport moved outside the transaction" IL-TC3 "$RT" \
  "    ledger = await recordImport(user, descriptor, added);
  }, { timeoutMs: 120000 });" \
  "  }, { timeoutMs: 120000 });
  ledger = await recordImport(user, descriptor, added);"

# Fix one caller, forget the other -- the exact shape of the repoint bug.
try "orders path stops passing a descriptor" IL-TC4 "$RT" \
  "kind: 'order'," \
  "kindTYPO: 'order',"

# The stronger version: drop the orders descriptor ENTIRELY. The first guard
# matched /kind:\s*'order'/ against the whole file and survived the mutation
# above, because an unrelated `kind: 'order'` elsewhere satisfied it.
try "orders descriptor removed entirely" IL-TC4 "$RT" \
  "const { added, failed, ledger } = await addCardsInOneTransaction(req.user, chosen, {
      kind: 'order',
      productId: String(order.id),
      productName: \`Order \${order.orderNumber}\`,
      setCode: null,
    });" \
  "const { added, failed, ledger } = await addCardsInOneTransaction(req.user, chosen);"

# And the precon side of the same rule.
try "precon descriptor removed entirely" IL-TC4 "$RT" \
  "      {
        kind: product.kind,
        productId: product.id,
        productName: product.name,
        setCode: product.setCode,
      },
" \
  ""

# Log an import that added nothing: answers "did I add this?" with YES for a
# product he does not own.
try "empty imports get logged anyway" IL-TC5 "$RT" \
  "if (!cardsAdded) return null;" \
  "if (false) return null;"

# Collapse his memory into a system record.
try "source constraint dropped" IL-TC2 "$DB" \
  "source TEXT NOT NULL DEFAULT 'import' CHECK(source IN ('import', 'manual'))," \
  "source TEXT NOT NULL DEFAULT 'import',"

# The UI blind spot: route declared after /:id/cards, so GET /ledger is
# swallowed and the feature is 0% reachable while every other test passes.
try "ledger routes declared after the parameterised ones" IL-TC8 "$RT" \
  "router.get('/ledger', async (req, res) => {" \
  "router.get('/zledger', async (req, res) => {"

# Deleting history must never delete cardboard.
try "delete entry also deletes the cards" IL-TC9 "$RT" \
  "      \`DELETE FROM import_ledger WHERE id = ? AND user_id = ?\`," \
  "      \`DELETE FROM collection WHERE id = ? AND user_id = ?\`,"

echo
# THE HARNESS MUST NOT LIE. An earlier version of this pattern silently reverted
# a real fix by restoring from /tmp copies.
if git diff --quiet -- $FILES; then
  echo "tree clean: all mutations restored"
else
  echo "!!! TREE DIRTY AFTER RUN -- a mutation was not restored"
  git diff --stat -- $FILES
  FAILURES=$((FAILURES + 1))
fi

echo "=== $( [ $FAILURES -eq 0 ] && echo 'ALL GUARDS PROVEN' || echo "$FAILURES PROBLEM(S)" ) ==="
exit $FAILURES
