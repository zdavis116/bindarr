#!/usr/bin/env bash
# Mutation-test the product-import guards. Same contract as the other harnesses:
# restore from GIT (never /tmp), abort on a stale anchor, prove a clean tree.
set -uo pipefail
cd /home/hermes/repos/bindarr || exit 1
export PATH="$HOME/.cache/hermes-node20/node-v20.20.2-linux-x64/bin:$PATH"

SVC=backend/src/services/mtgjsonProducts.js
RT=backend/src/routes/products.js
COL=backend/src/routes/collection.js
TEST=backend/test/products.test.js
FILES="$SVC $RT $COL"

if ! git diff --quiet -- $FILES; then
  echo "REFUSING TO RUN: uncommitted changes in the files under test."
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
open(path, 'w').write(s.replace(old, new))
PY
}

FAILURES=0
# Offline for mutation runs: these guards are all source/logic rules, and
# hitting MTGJSON eight times over would be rude and slow.
expect() {
  local want="$1"
  if PRODUCTS_OFFLINE=1 node $TEST >/tmp/pr-out 2>&1; then
    echo "  !!! STILL PASSED - $want does not guard this"
    FAILURES=$((FAILURES + 1))
  else
    # The suffix letter matters: PR-TC4b is a DIFFERENT guard from PR-TC4, and
    # a pattern of PR-TC[0-9]* silently truncates it to PR-TC4 -- the same
    # too-narrow-regex bug that made the e2e counter under-report three times.
    local got; got=$(grep -o 'PR-TC[0-9]*[a-z]\?' /tmp/pr-out | head -1)
    if [ "$got" = "$want" ]; then echo "  failed as intended: $got"
    else echo "  !!! WRONG TEST: expected $want, got '${got:-<crash>}'"
      FAILURES=$((FAILURES + 1)); fi
  fi
  restore
}

echo "X1: decide finish from the product NAME - the most dangerous bug (expect PR-TC3)"
mutate $SVC '  if (card.isEtched) return '"'"'etched'"'"';
  if (card.isFoil) return '"'"'foil'"'"';
  return '"'"'nonfoil'"'"';' \
  '  if (/foil/i.test(card.name || '"''"')) return '"'"'foil'"'"';
  return '"'"'nonfoil'"'"';' \
  && expect PR-TC3 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "X2: etched loses to foil (expect PR-TC3)"
mutate $SVC '  if (card.isEtched) return '"'"'etched'"'"';' '' \
  && expect PR-TC3 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "X3: drop unknown cards from the confirm list (expect PR-TC4b)"
mutate $RT '      cards: resolved,' '      cards: resolved.filter((c) => c.inCatalogue),' \
  && expect PR-TC4b || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "X4: stop reporting how many are missing (expect PR-TC4)"
mutate $RT '      missingCount: missing.reduce((n, c) => n + c.quantity, 0),' '' \
  && expect PR-TC4 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "X5: write an unknown card into card_cache (expect PR-TC5)"
mutate $RT '    const ids = [...new Set(cards.map((c) => c.scryfallId).filter(Boolean))];' \
  '    await db.run(`INSERT INTO card_cache (id, name) VALUES (?, ?)`, ["x", "y"]);
    const ids = [...new Set(cards.map((c) => c.scryfallId).filter(Boolean))];' \
  && expect PR-TC5 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "X6: add cards straight from the PREVIEW route (expect PR-TC6)"
mutate $RT '    const missing = resolved.filter((c) => !c.inCatalogue);' \
  '    for (const c of resolved) await addCardToCollection(req.user, { card_id: c.scryfallId });
    const missing = resolved.filter((c) => !c.inCatalogue);' \
  && expect PR-TC6 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "X7: trust the client's posted quantity (expect PR-TC8)"
mutate $RT '          quantity: card.quantity,' '          quantity: req.body.quantity || 1,' \
  && expect PR-TC8 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "X8: write collection rows directly instead of reusing the add-path (expect PR-TC9)"
mutate $RT '        const result = await addCardToCollection(req.user, {' \
  '        await db.run(`INSERT INTO collection (user_id) VALUES (?)`, [1]);
        const result = await addCardToCollection(req.user, {' \
  && expect PR-TC9 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "X9: stop exporting the shared add-path (expect PR-TC9)"
mutate $COL 'module.exports.addCardToCollection = addCardToCollection;' '' \
  && expect PR-TC9 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "X10: merge foil and nonfoil into one row (expect PR-TC10)"
mutate $SVC '    const key = `${scryfallId || `name:${c.name}`}|${finish}`;' \
  '    const key = `${scryfallId || `name:${c.name}`}`;' \
  && expect PR-TC10 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "--- baseline (offline, must be all PASS):"
PRODUCTS_OFFLINE=1 node $TEST || FAILURES=$((FAILURES + 1))

echo "--- tree must be clean:"
if git diff --quiet -- $FILES; then echo "restore clean"
else echo "!!! LEFT MUTATED:"; git diff --stat -- $FILES; FAILURES=$((FAILURES + 1)); fi

echo
[ "$FAILURES" -eq 0 ] && echo "ALL MUTATIONS CAUGHT" || echo "PROBLEMS: $FAILURES"
exit $FAILURES
