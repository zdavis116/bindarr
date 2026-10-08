#!/usr/bin/env bash
# Mutation harness for the paste-a-list feature.
#
# Rules this harness obeys, all three load-bearing (see the bindarr skill):
#   1. Restore with `git checkout`, never a /tmp copy. Refuse to run dirty.
#   2. A failed anchor ABORTS that mutation -- never falls through to the test,
#      which would measure an UNMUTATED file and call a sound test vacuous.
#   3. Assert the tree is clean at the end.
set -uo pipefail
cd "$(dirname "$0")/.."

PARSER=backend/src/utils/decklistParser.js
ROUTE=backend/src/routes/importExport.js
UI=frontend/src/components/ImportModal.jsx
EN=frontend/src/locales/en.json
TEST=backend/test/e2e/paste_list.test.js

if ! git diff --quiet -- "$PARSER" "$ROUTE" "$UI" "$EN"; then
  echo "ABORT: files under test have uncommitted changes. Commit first."
  exit 1
fi

pass=0; fail=0

mutate() {
  local label="$1" file="$2" py="$3"
  printf '\n=== %s ===\n' "$label"
  if ! python3 -c "$py"; then
    echo "  ANCHOR FAILED -- mutation not applied, ABORTING this case"
    git checkout -- "$file"
    fail=$((fail+1))
    return
  fi
  if node "$TEST" >/tmp/mut.out 2>&1; then
    echo "  STILL PASSED -- the test is VACUOUS"
    grep -E '^PASS' /tmp/mut.out | tail -5
    fail=$((fail+1))
  else
    echo "  caught by: $(grep -E '^FAIL' /tmp/mut.out | head -2)"
    pass=$((pass+1))
  fi
  git checkout -- "$file"
}

# 1. Collector numbers become digits-only -> both PLST lines die.
mutate "numbers digits-only (kills PLST 2X2-169 / AKH-4)" "$PARSER" "
import io
p='$PARSER'; s=io.open(p,encoding='utf8').read()
old=r'const NUMBER = String.raw\`[A-Za-z0-9\\u2605][A-Za-z0-9\\u2605/.\\-]*\`;'
new=r'const NUMBER = String.raw\`[0-9]+\`;'
assert old in s, 'anchor'
io.open(p,'w',encoding='utf8').write(s.replace(old,new,1))
"

# 2. Etched collapses into foil -> a separately priced printing is mislabelled.
mutate "etched collapses into foil" "$PARSER" "
import io
p='$PARSER'; s=io.open(p,encoding='utf8').read()
old=\"  if (/\\\\*e\\\\*|\\\\*etched\\\\*/.test(t)) return 'etched';\"
assert old in s, 'anchor'
io.open(p,'w',encoding='utf8').write(s.replace(old,'',1))
"

# 3. Unparseable lines are dropped silently instead of reported.
mutate "skipped lines dropped silently" "$PARSER" "
import io
p='$PARSER'; s=io.open(p,encoding='utf8').read()
old='      skipped.push({ line: i + 1, text: line });'
assert old in s, 'anchor'
io.open(p,'w',encoding='utf8').write(s.replace(old,'',1))
"

# 4. The name stops being lazy -> a comma'd name truncates.
mutate "greedy name match" "$PARSER" "
import io
p='$PARSER'; s=io.open(p,encoding='utf8').read()
old=r'String.raw\`(?<name>.+?)\s+\` +'
new=r'String.raw\`(?<name>.+)\s+\` +'
assert old in s, 'anchor'
io.open(p,'w',encoding='utf8').write(s.replace(old,new,1))
"

# 5. The route stops parsing the pasted text.
mutate "route ignores posted text" "$ROUTE" "
import io
p='$ROUTE'; s=io.open(p,encoding='utf8').read()
old='    const parsed = parseDecklist(text);'
new='    const parsed = { rows: [], skipped: [] };'
assert old in s, 'anchor'
io.open(p,'w',encoding='utf8').write(s.replace(old,new,1))
"

# 6. The UI posts client-parsed rows on commit instead of the text.
mutate "commit posts rows, not the text" "$UI" "
import io
p='$UI'; s=io.open(p,encoding='utf8').read()
old='''      const body = pasteMode
        ? { text: pasteText, resolutions: choices }
        : { rows, format: 'manabox', resolutions: choices };'''
new=\"      const body = { rows, format: 'manabox', resolutions: choices };\"
assert old in s, 'anchor'
io.open(p,'w',encoding='utf8').write(s.replace(old,new,1))
"

# 7. One locale loses a key -> t() would render the raw dotted key.
mutate "a locale loses import.pasteHint" "frontend/src/locales/ru.json" "
import json, io
p='frontend/src/locales/ru.json'
d=json.load(io.open(p,encoding='utf8'))
assert 'import.pasteHint' in d, 'anchor'
del d['import.pasteHint']
io.open(p,'w',encoding='utf8').write(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
"

printf '\n==========================================\n'
printf 'mutations caught: %s   vacuous/aborted: %s\n' "$pass" "$fail"
if git diff --quiet; then
  echo 'tree clean'
else
  echo 'TREE DIRTY AFTER RUN -- restore failed:'
  git status --porcelain
  exit 1
fi
[ "$fail" -eq 0 ] || exit 1
