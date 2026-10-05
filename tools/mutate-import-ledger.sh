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
SVC=backend/src/services/mtgjsonProducts.js
UI=frontend/src/components/ProductImportModal.jsx
CSS=frontend/src/index.css
TEST=backend/test/e2e/import_ledger.test.js
FILES="$DB $RT $SVC $UI $CSS"

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
    #
    # ACCEPT ANY of the expected ids: a mutation can legitimately trip more than
    # one guard, and the FIRST to fail is whichever runs earlier. Nesting a
    # third .pp-markbtn trips IL-TC11 (which counts the buttons) before IL-TC12
    # (which checks nesting) -- both are correct, and demanding one exact id
    # reports a working guard as broken.
    local got; got=$(grep -o 'FAIL: IL-TC[0-9]*' /tmp/il-out | head -1 | sed 's/FAIL: //')
    case " $want " in
      *" $got "*) echo "  failed as intended: $got" ;;
      *) echo "  !!! WRONG TEST: expected $want, got '${got:-<crash>}'"
         FAILURES=$((FAILURES + 1)) ;;
    esac
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
#
# NOTE: a tempting mutation here is to typo `kind: 'order',` -- do NOT add it
# back. mutate() replaces the FIRST occurrence, and the first one in this file
# is the legitimate `kind: 'order'` in the GET /orders/:id/cards RESPONSE, not
# the descriptor. That mutation breaks an unrelated line, IL-TC4 correctly stays
# green, and the harness reports a vacuous test that is not vacuous. The two
# mutations below remove each descriptor outright, which is the real case.

# Drop the orders descriptor ENTIRELY.
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
echo "=== mark-added mutations ==="

# NOTE: the dedupe / mark-gate / marking-writes-cards mutations that lived here
# are GONE, along with the feature. Hand-marking was removed at Zach's request,
# so their anchors went stale and every one of them ABORTED -- a harness full of
# mutations for deleted code reports problems that are not problems and buries
# the real ones. The replacements for the removed state are further down
# ("manual-mark route still writes rows", "unmark removed along with mark").

# A button inside a button is unnested by the browser: rendered, in the DOM,
# and NOT clickable. The exact reachability failure this project keeps hitting.
#
# The anchor is the EDITION row's button, because the product row's unmark is
# now conditional and the Package icon it used to sit beside moved.
try "mark button nested inside the row button" "IL-TC11 IL-TC12" "$UI" \
  "                        <Package size={15} className=\"pp-picon\" />
                      </button>" \
  "                        <Package size={15} className=\"pp-picon\" />
                        <button className=\"pp-markbtn\">x</button>
                      </button>"

echo
echo "=== added-to-top sort mutations ==="

# THE BUG ZACH FOUND. Sort by date only, with the added-first rule removed:
# the limit then cuts an added product that ranks low by release date.
#
# NOTE: appending a second sort AFTER the slice does NOT reproduce it -- the
# correct sort still ran, so the head is already right and the test rightly
# stays green. The mutation has to REMOVE the added-first comparison.
try "added-first comparison removed from the sort" IL-TC14 "$SVC" \
  "    const aa = isAdded(a), ba = isAdded(b);
    if (aa !== ba) return aa ? -1 : 1;" \
  ""

# Added products beyond the cut get dropped entirely. Only bites when MORE
# than `limit` products are added, which is why IL-TC14 tests that case.
try "added products past the cut are discarded" IL-TC14 "$SVC" \
  "  return { total: groups.length, groups: [...addedPastCut, ...head] };" \
  "  return { total: groups.length, groups: head };"

# The route stops telling the search what is in the ledger, so nothing is added.
try "route stops passing addedIds" IL-TC14 "$RT" \
  "      addedIds: new Set(ledgerRows.map((r) => r.product_id))," \
  ""

echo
echo "=== per-card (partial order) mutations ==="

# No per-card rows: "did I already take this card?" becomes unanswerable.
try "import stops recording which cards" IL-TC15 "$RT" \
  "        \`INSERT INTO import_ledger_cards
           (ledger_id, user_id, product_id, scryfall_id, quantity)
         VALUES (?, ?, ?, ?, ?)\`," \
  "        \`INSERT INTO import_ledger (user_id, kind, product_name, source)
         VALUES (?, ?, ?, 'import')\`,"

# The order screen stops flagging what already came in.
try "orders screen stops flagging taken cards" IL-TC16 "$RT" \
  "    const resolved = await flagAlreadyImported(
      await flagAgainstCatalogue(cards), req.user.id, String(order.id));" \
  "    const resolved = await flagAgainstCatalogue(cards);"

# A LABEL WITHOUT THE DEFAULT is the actual double-add: the seven received
# cards stay ticked and Add re-imports all ten.
try "already-received cards stay ticked" IL-TC16 "$UI" \
  "      setExcluded(new Set((body.cards || [])" \
  "      setExcluded(new Set([].concat(body.cards || [])" 

# Select all hands the double-add straight back.
try "Select all re-ticks received cards" IL-TC16 "$UI" \
  "              <button type=\"button\" onClick={() => setExcluded(new Set(addable
                .filter((c) => c.alreadyAdded >= c.quantity)
                .map((c) => c.scryfallId)))}>" \
  "              <button type=\"button\" onClick={() => setExcluded(new Set())}>"

# Removing the BUTTON but leaving the ROUTE writing rows is the half-measure:
# the hand-made write stays reachable.
try "manual-mark route still writes rows" IL-TC10 "$RT" \
  "  res.status(410).json({
    error: 'Marking a product as added by hand is no longer supported. Import it instead.',
    code: 'MANUAL_LEDGER_REMOVED',
  });" \
  "  await db.run(\`INSERT INTO import_ledger (user_id, kind, product_name, source)
     VALUES (?, 'precon', ?, 'manual')\`, [req.user.id, req.body.product_name]);
  res.status(201).json({ ok: true });"

# Unmark must survive the removal, or a mis-marked row is permanent.
try "unmark removed along with mark" IL-TC11 "$UI" \
  "                      {g.editions.length === 1 && entry?.source === 'manual' && (" \
  "                      {false && ("

# A verified import must still have no control at all.
try "verified imports become unmarkable" IL-TC11 "$UI" \
  "                              {edEntry?.source === 'manual' && (" \
  "                              {true && ("

echo
echo "=== badge colour mutations ==="

# The muted grey variant comes back: his own marks fade out again.
try "manual badges go grey again" IL-TC17 "$CSS" \
  "  color: #7ddc9a; background: rgba(125,220,154,0.13);
  border: 1px solid rgba(125,220,154,0.34); }" \
  "  color: #7ddc9a; background: rgba(125,220,154,0.13);
  border: 1px solid rgba(125,220,154,0.34); }
.pp-added.manual { color: var(--text-muted); }"

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
