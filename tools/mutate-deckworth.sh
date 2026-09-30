#!/usr/bin/env bash
# MUTATION TEST for deckWorth.test.js.
#
# The failures here are wrong NUMBERS, not crashes. A worth total built from
# the buying price renders perfectly and understates Doctor Doom by $36 while
# calling itself a TCGplayer figure. That is worse than an error.
set -uo pipefail
cd "$(dirname "$0")/.."

TEST=frontend/src/components/deckWorth.test.js
NODE="${NODE:-node}"
TARGETS="frontend/src/components/DeckView.jsx backend/src/utils/deckIdentity.js frontend/src/locales/en.json"

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

# M1: THE WHOLE POINT. Price the worth at the BUYING source -- $165.47 instead
# of $201.95 on Doctor Doom, labelled as a TCGplayer value.
mutate M1 "worth priced at the buying source" "DW-TC2" "frontend/src/components/DeckView.jsx" "
  const re = /c\.value_price \?\? c\.price_trend \?\? 0/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'c.price_trend ?? 0');
"

# M1b: the reverse -- cost the MISSING cards at the valuation source, the
# figure Zach explicitly said not to lose.
mutate M1b "cost to finish priced at the selling source" "DW-TC2" "frontend/src/components/DeckView.jsx" "
  const re = /\(c\.quantity_missing \|\| 0\) \* \(c\.price_trend \|\| 0\)/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '(c.quantity_missing || 0) * (c.value_price || 0)');
"

# M2: drop the second join, so both prices collapse to one source and the two
# figures silently agree again.
mutate M2 "one join for both prices" "DW-TC1" "backend/src/utils/deckIdentity.js" "
  const re = /     LEFT JOIN source_prices vp\n            ON vp\.card_id = cc\.id AND vp\.source = '\\\$\{valueShop\}'\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M2b: compute value_price but never send it, so the screen falls back to the
# buy price with no error anywhere.
mutate M2b "value_price not returned to the client" "DW-TC1" "backend/src/utils/deckIdentity.js" "
  const re = /      value_price: entry\.value_price,\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M3: count OWNED copies rather than available ones, so a card lent to another
# deck is counted twice across his decks.
mutate M3 "worth double-counts lent cards" "DW-TC3" "frontend/src/components/DeckView.jsx" "
  const re = /      const have = Math\.min\(c\.quantity \|\| 0, c\.quantity_available \|\| 0\);/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '      const have = c.quantity || 0;');
"

# M4: label the partial figure as the full deck value, so an unfinished deck
# claims a worth it does not have.
mutate M4 "partial worth labelled as full deck value" "DW-TC4" "frontend/src/components/DeckView.jsx" "
  const re = /\{counts\.missing > 0 \? t\('deck\.worthOwned'\) : t\('deck\.worth'\)\}/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, \"{t('deck.worth')}\");
"

# M5: search the WHOLE deck regardless of tab, so filtering inside Missing
# silently shows cards he already owns.
mutate M5 "deck search ignores the selected tab" "DW-TC5" "frontend/src/components/DeckView.jsx" "
  const re = /    return byTab\.filter\(c =>/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '    return deckCards.filter(c =>');
"

# M6: say the deck is empty when a search matches nothing.
mutate M6 "empty search reads as an empty deck" "DW-TC6" "frontend/src/components/DeckView.jsx" "
  const re = /          \{deckSearch\.trim\(\) \? t\('deck\.noCardsMatch'\)\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '          {');
"

# M6b: delete a string, so the screen renders 'deck.worthOwned' at the user.
mutate M6b "a missing i18n key renders as the key" "DW-TC6" "frontend/src/locales/en.json" "
  const j = JSON.parse(before);
  if (!('deck.worthOwned' in j)) { console.error('anchor missing'); process.exit(3); }
  delete j['deck.worthOwned'];
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
