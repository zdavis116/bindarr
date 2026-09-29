#!/usr/bin/env bash
# MUTATION TEST for priceContexts.test.js.
#
# Almost every failure here is a WRONG NUMBER, not a crash. A deck costed at
# TCGplayer market instead of Mana Pool renders perfectly and overstates the
# bill -- his Omnipresence alone is $42.15 vs $15.00. That is worse than an
# error, because nothing looks broken.
set -uo pipefail
cd "$(dirname "$0")/.."

TEST=backend/test/priceContexts.test.js
NODE="${NODE:-node}"
TARGETS="backend/src/utils/priceHelpers.js backend/src/routes/decks.js backend/src/routes/collection.js backend/src/routes/stats.js backend/src/routes/importExport.js backend/src/utils/deckIdentity.js backend/src/routes/settings.js backend/src/db.js"

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

# M1: give the context a default. Every call site that forgets the argument
# then silently gets a valuation price, including the shopping lists.
mutate M1 "context silently defaults" "PRICE-TC1" "backend/src/utils/priceHelpers.js" "
  const re = /async function selectedShop\(database, context\) \{\n  if \(!PRICE_CONTEXTS\.includes\(context\)\) \{[\s\S]*?\n  \}/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'async function selectedShop(database, context = \'valuation\') {');
"

# M2: THE COSTLY ONE. Cost a shopping list at the valuation source. Mana Pool
# is cheaper on 96.5% of cards, so every buy list is overstated.
mutate M2 "shopping list priced at the selling source" "PRICE-TC3" "backend/src/routes/decks.js" "
  const re = /    const buyShop = await selectedShop\(db, 'buying'\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '    const buyShop = await selectedShop(db, \'valuation\');');
"

# M2b: the reverse -- value his collection at the discount shop, understating
# what he could sell it for.
mutate M2b "collection valued at the buying source" "PRICE-TC2" "backend/src/routes/collection.js" "
  const re = /selectedShop\(db, 'valuation'\)/g;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(/selectedShop\(db, 'valuation'\)/g, \"selectedShop(db, 'buying')\");
"

# M3: missing_cost goes back to the valuation price -- the split exists in the
# joins but does not reach the number he reads.
mutate M3 "missing_cost uses the valuation price" "PRICE-TC3" "backend/src/routes/decks.js" "
  const re = /SUM\(\(r\.quantity - r\.owned_here\) \* r\.buy_price\)/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'SUM((r.quantity - r.owned_here) * r.price_trend)');
"

# M4: THE BUG I SHIPPED. Drop buy_price from the resolved CTE. The join is
# still there, the column is still produced, and the deck list returns 500.
mutate M4 "buy_price not carried through resolved" "PRICE-TC4" "backend/src/routes/decks.js" "
  const re = /          r\.buy_price,\n          MIN\(r\.quantity/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '          MIN(r.quantity');
"

# M4b: one join for both prices, so the two figures silently agree again.
mutate M4b "both prices share one join" "PRICE-TC4" "backend/src/routes/decks.js" "
  const re = /        LEFT JOIN source_prices bp\n               ON bp\.card_id = dcc\.id AND bp\.source = '\\\$\{buyShop\}'\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M5: make scryfall emit no join at all. Every query that selects the mp_*
# columns then fails, because those columns stop existing.
mutate M5 "scryfall emits no join" "PRICE-TC5" "backend/src/utils/priceHelpers.js" "
  const re = /  if \(sourceId === 'scryfall'\) \{[\s\S]*?\n  \}\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M6: do not clear the cache on write, so his choice appears not to work for
# five seconds -- long enough to tap it again and doubt it.
mutate M6 "setting does not take effect immediately" "PRICE-TC6" "backend/src/routes/settings.js" "
  const m = before.match(/router\.put\('\/valuation-source'[\s\S]*?\n\}\);/);
  if (!m) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(m[0], m[0].replace('priceHelpers.clearShopCache();', ''));
"

# M6b: reuse the existing column for both settings, so choosing a valuation
# source silently rewrites his buying choice.
mutate M6b "one column for both settings" "PRICE-TC6" "backend/src/db.js" "
  const re = /    await run\(\`ALTER TABLE app_settings ADD COLUMN valuation_price_source TEXT\`\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

printf '\n'
if ! git diff --quiet -- $TARGETS "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
