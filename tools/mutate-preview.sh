#!/usr/bin/env bash
# Mutation-test the card preview guards. Same contract as mutate-compare.sh:
# restore from git, abort on a stale anchor, prove the tree is clean at the end.
set -uo pipefail
cd /home/hermes/repos/bindarr || exit 1
export PATH="$HOME/.cache/hermes-node20/node-v20.20.2-linux-x64/bin:$PATH"

POS=frontend/src/components/cardPreviewPosition.js
PRE=frontend/src/components/CardPreview.jsx
DCM=frontend/src/components/DeckCompareModal.jsx
CSS=frontend/src/index.css
TEST=frontend/src/components/cardPreview.test.js
FILES="$POS $PRE $DCM $CSS"

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
expect() {
  local want="$1"
  if node $TEST >/tmp/cp-out 2>&1; then
    echo "  !!! STILL PASSED - $want does not guard this"
    FAILURES=$((FAILURES + 1))
  else
    local got; got=$(grep -o 'CP-TC[0-9]*' /tmp/cp-out | head -1)
    if [ "$got" = "$want" ]; then echo "  failed as intended: $got"
    else echo "  !!! WRONG TEST: expected $want, got '${got:-<crash>}'"
      FAILURES=$((FAILURES + 1)); fi
  fi
  restore
}

echo "P1: drop the vertical clamp - card runs past the fold (expect CP-TC1)"
mutate $POS '  top = Math.max(EDGE, Math.min(top, vh - CARD_H - EDGE));' '' \
  && expect CP-TC1 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "P2: drop the horizontal clamp (expect CP-TC1)"
mutate $POS '  left = Math.max(EDGE, Math.min(left, vw - CARD_W - EDGE));' '' \
  && expect CP-TC1 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "P3: centre the preview ON the row instead of beside it (expect CP-TC2)"
mutate $POS '  let left = roomRight >= CARD_W + GAP + EDGE' \
  '  let left = anchorRect.left; if (false) left = roomRight >= CARD_W + GAP + EDGE' \
  && expect CP-TC2 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "P4: always open to the right, never flip (expect CP-TC3)"
mutate $POS '    : anchorRect.left - CARD_W - GAP;' '    : anchorRect.right + GAP;' \
  && expect CP-TC3 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "P5: make the name a span again - hover only, unreachable by tap (expect CP-TC5)"
mutate $DCM 'className="mpc-name mpc-name-btn"' 'className="mpc-name"' \
  && expect CP-TC5 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "P6: strip the keyboard focus ring (expect CP-TC5)"
mutate $CSS '  outline: 2px solid var(--accent-blue); outline-offset: 2px; border-radius: 3px;' \
  '  outline: none;' \
  && expect CP-TC5 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "P7: render inline instead of a portal - the column clips it (expect CP-TC6)"
mutate $PRE '  return createPortal(' '  return (' \
  && expect CP-TC6 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "P8: let the preview eat pointer events (expect CP-TC6)"
mutate $CSS '  pointer-events: none;
  filter: drop-shadow(0 10px 24px rgba(0,0,0,0.6));' \
  '  filter: drop-shadow(0 10px 24px rgba(0,0,0,0.6));' \
  && expect CP-TC6 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "--- baseline (must be all PASS):"
node $TEST || FAILURES=$((FAILURES + 1))

echo "--- tree must be clean:"
if git diff --quiet -- $FILES; then echo "restore clean"
else echo "!!! LEFT MUTATED:"; git diff --stat -- $FILES; FAILURES=$((FAILURES + 1)); fi

echo
[ "$FAILURES" -eq 0 ] && echo "ALL MUTATIONS CAUGHT" || echo "PROBLEMS: $FAILURES"
exit $FAILURES
