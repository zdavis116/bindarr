#!/usr/bin/env bash
# MUTATION TEST for rarityFilter.test.js.
#
# Every mutation here is a plausible mistake that produces NO ERROR. A filter
# that matches nothing, a filter that changes nothing, counts that shift under
# you -- all of them render fine and look like the feature works until you
# actually use it.
set -uo pipefail
cd "$(dirname "$0")/.."

TEST=frontend/src/components/rarityFilter.test.js
NODE="${NODE:-node}"
TARGETS="frontend/src/components/CollectionList.jsx frontend/src/locales/en.json"

if ! git diff --quiet -- $TARGETS "$TEST"; then
  echo "REFUSING: a target or the test has uncommitted changes. Commit first."
  exit 2
fi

fail=0

mutate() {
  local id="$1" desc="$2" expect="$3" file="$4" js="$5"
  printf '\n=== %s: %s\n' "$id" "$desc"

  if ! $NODE -e "
    const fs = require('fs');
    const p = '$file';
    const before = fs.readFileSync(p, 'utf8');
    $js
    if (after === before) { console.error('ANCHOR FAILED - source unchanged'); process.exit(3); }
    fs.writeFileSync(p, after);
  "; then
    echo "  ABORT: anchor did not match. Not running the test."
    git checkout -- $TARGETS
    fail=1
    return
  fi

  local out rc last
  out="$($NODE "$TEST" 2>&1)"; rc=$?
  git checkout -- $TARGETS

  if [ $rc -eq 0 ]; then
    echo "  STILL PASSED -> the test is VACUOUS. Fix the test, not this script."
    fail=1
    return
  fi
  last="$(echo "$out" | grep '^RUN: ' | tail -1 | sed 's/^RUN: //')"
  if [ "$last" = "$expect" ]; then
    echo "  caught by $expect (the intended case)"
  else
    echo "  failed, but via ${last:-<none>} rather than $expect:"
    echo "$out" | grep -E 'AssertionError' | head -1 | sed 's/^/    /'
    fail=1
  fi
}

# M1: THE OBVIOUS MISTAKE -- copy the neighbouring colour/type line and use
# `every`. Two rarities ticked then matches NOTHING, silently.
mutate M1 "rarity uses every() like its neighbours" "RARITY-TC1" "frontend/src/components/CollectionList.jsx" "
  const re = /rarityFilters\.size === 0 \|\| rarityFilters\.has\(item\.rarity\)/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'rarityFilters.size === 0 || [...rarityFilters].every(r => item.rarity === r)');
"

# M2: leave rarityFilters out of the memo deps. The chips tick, the list never
# recomputes, and nothing errors.
mutate M2 "filter state missing from the list deps" "RARITY-TC2" "frontend/src/components/CollectionList.jsx" "
  const re = /, setFilters, rarityFilters, sortBy\]\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, ', setFilters, sortBy]);');
"

# M3: alphabetical rarities -- Common, Mythic, Rare, Uncommon.
mutate M3 "rarities sorted alphabetically" "RARITY-TC3" "frontend/src/components/CollectionList.jsx" "
  const re = /const RARITY_ORDER = \['Common', 'Uncommon', 'Rare', 'Mythic'\];/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, \"const RARITY_ORDER = ['Common', 'Mythic', 'Rare', 'Uncommon'];\");
"

# M3b: Scryfall's lowercase values. Matches zero rows against card_cache, and
# looks like an empty collection rather than a bug.
mutate M3b "lowercase rarity values" "RARITY-TC3" "frontend/src/components/CollectionList.jsx" "
  const re = /const RARITY_ORDER = \['Common', 'Uncommon', 'Rare', 'Mythic'\];/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, \"const RARITY_ORDER = ['common', 'uncommon', 'rare', 'mythic'];\");
"

# M4: count rows instead of copies, so four Lightning Bolts read as one card
# and the number disagrees with every other total in the app.
mutate M4 "counts rows, not copies" "RARITY-TC4" "frontend/src/components/CollectionList.jsx" "
  const re = /const n = c\.quantity \|\| 1;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'const n = 1;');
"

# M5: Clear-all forgets rarity -- the badge says a filter is active and nothing
# visible turns it off.
mutate M5 "clear-all leaves rarity set" "RARITY-TC5" "frontend/src/components/CollectionList.jsx" "
  const re = / setRarityFilters\(new Set\(\)\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M5b: the i18n key vanishes, so the button reads 'collection.rarities'.
mutate M5b "missing i18n key renders as the key" "RARITY-TC5" "frontend/src/locales/en.json" "
  const j = JSON.parse(before);
  if (!('collection.rarities' in j)) { console.error('anchor missing'); process.exit(3); }
  delete j['collection.rarities'];
  const after = JSON.stringify(j, null, 2) + '\n';
"

printf '\n'
if ! git diff --quiet -- $TARGETS "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
