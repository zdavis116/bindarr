#!/usr/bin/env bash
# Mutation-test the rulings guards (RUL-TC*).
#
# Each mutation breaks ONE rule and asserts the intended test goes red. A
# mutation that STILL PASSES means the test is vacuous -- believe it and fix
# the test, do not explain it away.
#
# Runs ONE test file, unlike tools/mutate-pane.sh which runs three and is
# documented as flaky in batch. Fewer moving parts, deterministic result.
#
# Restores with `git checkout`, never a /tmp copy: an earlier harness in this
# repo restored from /tmp, silently reverted a real fix, and measured every
# later mutation against a corrupted baseline.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cache/hermes-node20/node-v20.20.2-linux-x64/bin:$PATH"

TEST=frontend/src/components/cardRulings.test.js
INSP=frontend/src/components/CardInspectorModal.jsx
IMP=backend/src/cardRulings.js
ROUTE=backend/src/routes/collection.js
SRV=backend/src/server.js
EN=frontend/src/locales/en.json

if ! git diff --quiet -- frontend/src backend/src; then
  echo "ABORT: commit your work first — this harness restores with git checkout." >&2
  exit 1
fi

fail=0

mutate() {
  local label="$1" file="$2" from="$3" to="$4" expect="$5"

  # A FAILED ANCHOR MUST ABORT, never fall through to the test: otherwise the
  # suite runs against an UNMUTATED file and reports a false "vacuous".
  if ! grep -qF -- "$from" "$file"; then
    echo "ABORT [$label]: anchor not found in $file" >&2
    fail=1
    return
  fi

  python3 - "$file" "$from" "$to" <<'PY'
import sys, os
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
assert old in src
out = src.replace(old, new, 1)
with open(path, 'w') as f:
    f.write(out)
    f.flush()
    os.fsync(f.fileno())
assert new in open(path).read(), 'the mutation did not land on disk'
PY

  local out
  out=$(node --test "$TEST" 2>&1)
  git checkout -- "$file"

  if echo "$out" | grep -qE "not ok [0-9]+ - ${expect}[:[:space:]]"; then
    echo "PASS [$label]: $expect went red"
  else
    echo "VACUOUS [$label]: $expect stayed green with the rule broken" >&2
    fail=1
  fi
}

# 1. Rulings keyed by printing instead of oracle id -- the same card would
#    disagree with itself between printings.
mutate "key on card id" "$ROUTE" \
  "rulingsFor(card.oracle_id)" "rulingsFor(card.id)" "RUL-TC1"

# 2. An empty download is allowed to wipe every ruling we hold.
mutate "empty import allowed" "$IMP" \
  "if (!staged.accepted) {" "if (false) {" "RUL-TC2"

# 3. A rulings read failure takes the whole card sheet down with it.
mutate "rulings error propagates" "$ROUTE" \
  "const rulings = await cardRulings.rulingsFor(card.oracle_id).catch((error) => {" \
  "const rulings = await cardRulings.rulingsFor(card.oracle_id).then((v) => { const _unused = (error) => {" \
  "RUL-TC3"

# 4. The section renders even with nothing in it -- a control that teaches you
#    to ignore it.
mutate "empty section renders" "$INSP" \
  "deckUse.rulings.length > 0 &&" "true &&" "RUL-TC4"

# 5. Rulings lose their dates, so a 2006 answer reads as current.
mutate "dates dropped" "$INSP" \
  "{r.published_at && (" "{false && (" "RUL-TC5"

# 6. Oldest-first, which buries the current answer under superseded ones.
mutate "oldest first" "$IMP" \
  "ORDER BY published_at DESC" "ORDER BY published_at ASC" "RUL-TC5"

# 7. A flat counted string renders "Rulings (1)".
mutate "flat plural key" "$EN" \
  '"inspector.rulings.one"' '"inspector.rulings"' "RUL-TC6"

# 8. Every run re-downloads, whether or not Scryfall rebuilt the file.
mutate "no skip check" "$IMP" \
  "return { skipped: true, reason: 'already_current', updatedAt: info.updatedAt };" \
  "return { skipped: true, reason: 'x', updatedAt: info.updatedAt };" \
  "RUL-TC7"

# 9. A rulings failure aborts the catalogue refresh that prices depend on.
mutate "rulings failure is fatal" "$SRV" \
  "return cardRulings.refreshRulings({}).catch((err) => {" \
  "return cardRulings.refreshRulings({}).then((err) => {" \
  "RUL-TC8"

if ! git diff --quiet -- frontend/src backend/src; then
  echo "ABORT: tree is dirty after the run — a restore failed." >&2
  git diff --stat -- frontend/src backend/src >&2
  exit 1
fi
echo "--- tree clean, all files restored"
exit $fail
