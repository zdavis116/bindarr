#!/usr/bin/env bash
# Mutation-test the detail-pane rules (PANE-TC*, AV-TC4*).
#
# Each mutation breaks ONE rule and asserts the intended test goes red. A
# mutation that STILL PASSES means the test is vacuous — believe it and fix the
# test, do not explain it away.
#
# Restores with `git checkout`, never a /tmp copy: an earlier harness restored
# from /tmp, silently reverted a real fix, and measured every later mutation
# against a corrupted baseline.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cache/hermes-node20/node-v20.20.2-linux-x64/bin:$PATH"

TESTS="frontend/src/components/inspectorPane.test.js frontend/src/components/cardAvailability.test.js"

if ! git diff --quiet -- frontend/src; then
  echo "ABORT: uncommitted changes under frontend/src. Commit first." >&2
  exit 2
fi

fail=0

mutate() {
  local label="$1" file="$2" from="$3" to="$4" expect="$5"

  # A FAILED ANCHOR MUST ABORT, never fall through to the test — otherwise the
  # suite runs against an UNMUTATED file and reports a false "vacuous".
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
  out=$(node --test $TESTS 2>&1)
  git checkout -- "$file"

  if echo "$out" | grep -q "^not ok .*$expect"; then
    echo "PASS [$label]: $expect went red"
  else
    echo "VACUOUS [$label]: $expect stayed green with the rule broken" >&2
    fail=1
  fi
}

INSP=frontend/src/components/CardInspectorModal.jsx
DECK=frontend/src/components/DeckView.jsx
COLL=frontend/src/components/CollectionList.jsx
CSS=frontend/src/index.css

# 1. The close button goes back to being modal-only — unreachable on desktop.
mutate "close is modal-only again" "$INSP" \
  "{(!inline || onClose) && (" \
  "{!inline && (" \
  "PANE-TC1"

# 2. The deck view's no-op close handler returns. This is the ORIGINAL bug.
mutate "deck close is a no-op" "$DECK" \
  "onClose={() => { setSelectedCardId(null); setDetailDismissed(true); }}" \
  "onClose={() => {}}" \
  "PANE-TC2"

# 3. Dismissal is dropped, so the commander fallback reopens the closed pane.
mutate "commander reopens closed pane" "$DECK" \
  "    if (detailDismissed) return null;" \
  "" \
  "PANE-TC3"

# 4. A tap site bypasses the shared toggle.
mutate "collection tap bypasses toggle" "$COLL" \
  "                openInspector(card);" \
  "                setInspectorCard(card);" \
  "PANE-TC4"

# 5. The flip button goes back onto the artwork.
mutate "flip back on the art" "$INSP" \
  "                onClick={() => setShowBack(v => !v)}" \
  "                onClick={() => setShowBackOnArt(v => !v)}" \
  "PANE-TC5"

# 6. Other printings defaults OPEN — the thing that pushed Edit Card off-screen.
mutate "printings default open" "$INSP" \
  '<details className="ci-printings">' \
  '<details className="ci-printings" open>' \
  "PANE-TC6"

# 7. The scroll cap becomes a fixed pixel height measured on one screen.
mutate "px cap instead of vh" "$CSS" \
  "    max-height: 28vh;" \
  "    max-height: 240px;" \
  "PANE-TC7"

# 8. The availability row goes back to being conditional — Zach's complaint.
mutate "availability row conditional again" "$INSP" \
  "                    [t('inspector.availableToUse')," \
  "                    ...(thisPrintingCommitted > 0 ? [[t('inspector.availableToUse')," \
  "AV-TC4"

if ! git diff --quiet -- frontend/src; then
  echo "ABORT: tree is dirty after the run — a restore failed." >&2
  git diff --stat -- frontend/src >&2
  exit 2
fi

echo "--- tree clean, all files restored"
exit $fail
