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

TESTS="frontend/src/components/inspectorPane.test.js frontend/src/components/cardAvailability.test.js frontend/src/components/cardInspectorLayout.test.js"

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

  # MATCH THE TEST NAME AS A PREFIX, with no clever boundary.
  #
  # This check has now mis-reported TWICE, each time claiming a genuinely
  # failing test still passed -- which is the dangerous direction, because it
  # argues for retiring a test that works.
  #
  #   1. `^not ok` missed the INDENTED nested subtest lines of a multi-file run.
  #   2. `$expect(:|\b)` failed on names followed by ':' -- \b after "TC2"
  #      before ':' is not the boundary it looks like, and grep -E's handling
  #      made the alternation unreliable.
  #
  # A plain fixed-string search for "not ok N - <name>" has no such edge: the
  # name is unique and the prefix is exact.
  if echo "$out" | grep -qE "not ok [0-9]+ - ${expect}[:[:space:]]"; then
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

# 9. The pane loses its positioning context, so the absolute close button
#    resolves against the VIEWPORT and flies to the page corner.
mutate "pane loses position:relative" "$CSS" \
  "    position: relative;
    grid-template-columns: 120px minmax(0, 1fr);" \
  "    grid-template-columns: 120px minmax(0, 1fr);" \
  "CIL-TC6"

# 10. The MODAL's close row goes absolute -- the bug Zach reported twice, where
#     the X followed the panel off-screen.
mutate "modal close row goes absolute" "$CSS" \
  "  justify-content: flex-end;
  flex: 0 0 auto;" \
  "  position: absolute;
  flex: 0 0 auto;" \
  "CIL-TC6"

# 11. THE BUG ZACH HIT ON HIS PHONE: the footer rule goes back to being
#     desktop-only, so the modal loses its anchoring entirely.
mutate "footer scoped to desktop again" "$CSS" \
  "
.ci-footer-acts {
  position: sticky;" \
  "
.card-inspector-inline .ci-footer-acts {
  position: sticky;" \
  "PANE-TC8"

# 12. The stray stock caption comes back as a floating div.
mutate "stock caption floats again" "$INSP" \
  "                              + (thisPrinting.price_available_qty > 0" \
  "                              + (false" \
  "PANE-TC8b"

if ! git diff --quiet -- frontend/src; then
  echo "ABORT: tree is dirty after the run — a restore failed." >&2
  git diff --stat -- frontend/src >&2
  exit 2
fi

echo "--- tree clean, all files restored"
exit $fail
