#!/usr/bin/env bash
# Mutation-test the deck-view fixes. Same contract as the other harnesses:
# restore from GIT (never /tmp), abort on a stale anchor, prove a clean tree.
set -uo pipefail
cd /home/hermes/repos/bindarr || exit 1
export PATH="$HOME/.cache/hermes-node20/node-v20.20.2-linux-x64/bin:$PATH"

DV=frontend/src/components/DeckView.jsx
CL=frontend/src/components/CollectionList.jsx
CI=frontend/src/components/CardInspectorModal.jsx
CSS=frontend/src/index.css
SY=backend/src/utils/moxfieldSync.js
TEST=frontend/src/components/deckViewFixes.test.js
FILES="$DV $CL $CI $CSS $SY"

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
open(path, 'w').write(s.replace(old, new, 1))
PY
}

FAILURES=0
expect() {
  local want="$1"
  if node $TEST >/tmp/dv-out 2>&1; then
    echo "  !!! STILL PASSED - $want does not guard this"
    FAILURES=$((FAILURES + 1))
  else
    # Read the FAILING guard, not the first id printed: passing tests print
    # their id before the failing one throws.
    local got; got=$(grep -vE '^PASS:' /tmp/dv-out \
      | grep -oE 'DV-TC[0-9]+[a-z]?' | head -1)
    if [ "$got" = "$want" ]; then echo "  failed as intended: $got"
    else echo "  !!! WRONG TEST: expected $want, got '${got:-<crash>}'"
      FAILURES=$((FAILURES + 1)); fi
  fi
  restore
}

echo "M1: put back the page offset in DeckView (expect DV-TC1)"
mutate $DV '      const raw = el.getBoundingClientRect().top;
      const top = Math.min(Math.max(raw, 0), window.innerHeight * 0.6);' \
  '      const top = el.getBoundingClientRect().top + window.scrollY;' \
  && expect DV-TC1 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "M2: put back the page offset in CollectionList (expect DV-TC1)"
mutate $CL '      const raw = el.getBoundingClientRect().top;
      const top = Math.min(Math.max(raw, 0), window.innerHeight * 0.6);' \
  '      const top = el.getBoundingClientRect().top + window.scrollY;' \
  && expect DV-TC1 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "M3: drop the clamp, keeping the viewport offset (expect DV-TC1)"
mutate $DV '      const top = Math.min(Math.max(raw, 0), window.innerHeight * 0.6);' \
  '      const top = raw;' \
  && expect DV-TC1 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "M4: remove the min-height floor from the deck pane (expect DV-TC2)"
mutate $CSS '    height: calc(100vh - var(--pane-top, 17rem) - 1rem);
    min-height: 18rem;
    overflow: hidden;
  }' \
  '    height: calc(100vh - var(--pane-top, 17rem) - 1rem);
    overflow: hidden;
  }' \
  && expect DV-TC2 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "M5: commit the switch on tap again, with no confirm (expect DV-TC3)"
mutate $CI '                              onClick={() => (deckCardId
                                ? setConfirmRepoint(pr)' \
  '                              onClick={() => (deckCardId
                                ? assignPrintingToDeck(pr)' \
  && expect DV-TC3 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "M6: stop warning that copies are in another deck (expect DV-TC3)"
mutate $CI "                {t('inspector.confirmInUse', { count: spoken })}" \
  "                {String(spoken)}" \
  && expect DV-TC3 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "M7: drop the confirm from the INLINE pane only (expect DV-TC4)"
mutate $CI '        {panelBody}
        {repointConfirm}' \
  '        {panelBody}' \
  && expect DV-TC4 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "M8: stop writing the deck name on sync (expect DV-TC5)"
mutate $SY '                        moxfield_updated_at = ?,
                        name = COALESCE(?, name)' \
  '                        moxfield_updated_at = ?' \
  && expect DV-TC5 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "M9: assign the name bare, so a missing name blanks it (expect DV-TC5)"
mutate $SY '                        name = COALESCE(?, name)' \
  '                        name = ?,' \
  && expect DV-TC5 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "M10: drop the see-changes toggle (expect DV-TC6)"
mutate $DV '              onClick={() => setRepointDetail(v => !v)}' \
  '              onClick={() => {}}' \
  && expect DV-TC6 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "M11: detail drops the FROM printing (expect DV-TC6)"
mutate $DV "                      {\`\${String(c.wants?.set_id || '').toUpperCase()} #\${c.wants?.number}\`}" \
  "                      {''}" \
  && expect DV-TC6 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "M12: detail stops warning about copies in other decks (expect DV-TC6)"
mutate $DV "                        {t('deck.repointInUse', { count: spoken })}" \
  '                        {String(spoken)}' \
  && expect DV-TC6 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "M13: detail reads the WRONG ownership field (expect DV-TC7)"
mutate $DV '                const owned = to?.quantity_owned ?? 0;' \
  '                const owned = to?.owned_qty ?? 0;' \
  && expect DV-TC7 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "M14: detail uses its own markup instead of the drift panel's (expect DV-TC6)"
mutate $DV '                  <div className="mfx-row" key={c.deck_card_id}>' \
  '                  <div className="rp-own-row" key={c.deck_card_id}>' \
  && expect DV-TC6 || { echo "  ABORT: stale anchor"; FAILURES=$((FAILURES+1)); restore; }

echo "--- baseline (must be all PASS):"
node $TEST || FAILURES=$((FAILURES + 1))

echo "--- tree must be clean:"
if git diff --quiet -- $FILES; then echo "restore clean"
else echo "!!! LEFT MUTATED:"; git diff --stat -- $FILES; FAILURES=$((FAILURES + 1)); fi

echo
[ "$FAILURES" -eq 0 ] && echo "ALL MUTATIONS CAUGHT" || echo "PROBLEMS: $FAILURES"
exit $FAILURES
