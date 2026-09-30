#!/usr/bin/env bash
# MUTATION TEST for sidePaneLayout.test.js.
#
# Both bugs this guards were INVISIBLE to every check the project had: no
# error, no failing test, a clean build. They were only ever going to be found
# by Zach looking at the screen. So the mutations restore each one exactly.
set -uo pipefail
cd "$(dirname "$0")/.."

TEST=frontend/src/components/sidePaneLayout.test.js
NODE="${NODE:-node}"
TARGETS="frontend/src/index.css frontend/src/utils/zLayers.js frontend/src/components/CardInspectorModal.jsx frontend/src/components/DeckView.jsx frontend/src/components/DeckCard.jsx"

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

# M1: THE BUG ZACH SAW. Remove the z-index entirely, so the fixed pane stacks
# by document order and the list's sticky headers draw through it.
mutate M1 "pane has no stacking order again" "PANE-TC1" "frontend/src/index.css" "
  const re = /    z-index: 890;\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M2: set it BELOW the list's sticky headers. Present, declared, still drawn
# through -- the version of this fix that looks right and is not.
mutate M2 "pane sits under the list headers" "PANE-TC2" "frontend/src/index.css" "
  const re = /    z-index: 890;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '    z-index: 3;');
"

# M2b: push it ABOVE the app header, so the pane covers the app chrome it is
# positioned beneath. The opposite error, equally visible.
mutate M2b "pane covers the app header" "PANE-TC2" "frontend/src/index.css" "
  const re = /    z-index: 890;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '    z-index: 1400;');
"

# M3: let the registry and the stylesheet drift apart. zLayers stops being the
# source of truth and becomes a comment.
mutate M3 "registry disagrees with the stylesheet" "PANE-TC3" "frontend/src/utils/zLayers.js" "
  const re = /export const Z_SIDE_PANE = 890;/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, 'export const Z_SIDE_PANE = 950;');
"

# M4: THE OTHER BUG ZACH SAW. Drop overflow-wrap, so a long rules line runs
# past the column and clips instead of wrapping.
mutate M4 "rules text stops wrapping" "PANE-TC4" "frontend/src/components/CardInspectorModal.jsx" "
  const re = /                    overflowWrap: 'anywhere',\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M4b: drop minWidth:0, so the box refuses to shrink to its grid track however
# the text wraps -- the subtler half of the same failure.
mutate M4b "text box cannot shrink to its column" "PANE-TC4" "frontend/src/components/CardInspectorModal.jsx" "
  const re = /                    minWidth: 0,\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M5: THE BUG IN THE RED BOX. Go back to position:fixed, so the pane pins to
# the viewport and floats outside its own reserved grid track on a wide window.
mutate M5 "pane leaves its grid track again" "PANE-TC1" "frontend/src/index.css" "
  // SCOPED TO THE PANE'S OWN BLOCK. A bare /    position: sticky;/ matched
  // line 1117 -- an unrelated rule -- so this mutation was editing the wrong
  // declaration and the pane kept its correct value. The test was fine; the
  // MUTATION was vacuous, which is the harder one to notice.
  const i = before.indexOf('.deck-panes-side {');
  if (i < 0) { console.error('anchor missing'); process.exit(3); }
  const j = before.indexOf('\n  }', i);
  const block = before.slice(i, j);
  if (!/\n    position: sticky;/.test(block)) { console.error('anchor missing'); process.exit(3); }
  const after = before.slice(0, i)
    + block.replace('\n    position: sticky;', '\n    position: fixed;')
    + before.slice(j);
"

# M5b: keep sticky but drop the height, restoring the ORIGINAL failure -- the
# pane starts at the document offset and runs past the fold.
mutate M5b "pane has no definite height" "PANE-TC1" "frontend/src/index.css" "
  const re = /    height: calc\(100dvh - var\(--deck-pane-top, 1\.2rem\) - 1\.2rem\);\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '');
"

# M6: ungroup the money figures, so the deck value floats in the middle of the
# header row again.
mutate M6 "deck value floats in the middle" "PANE-TC5" "frontend/src/components/DeckView.jsx" "
  const re = /          <div style=\{\{ display: 'flex', alignItems: 'flex-start', gap: '1\.4rem',\n                        marginLeft: 'auto' \}\}>\n/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '          <div>\n');
"

# M7: a complete deck goes back to showing only the word, throwing away the
# value it already fetched.
mutate M7 "complete deck hides its value" "PANE-TC6" "frontend/src/components/DeckCard.jsx" "
  const m = before.match(/\{deck\.have >= deck\.target\n            \? \([\s\S]*?\n            \)\n            : \(/);
  if (!m) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(m[0], '{deck.have >= deck.target\n            ? t(\'deck.complete\')\n            : (');
"

# M8: drop the inline rule, so the second money figure wraps the footer to two
# lines -- the exact failure that was fixed three times before.
mutate M8 "footer wraps to two lines again" "PANE-TC6" "frontend/src/index.css" "
  const re = /\.deck-row-foot-run \.deck-row-value \{ display: inline !important; \}/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '.deck-row-foot-run .deck-row-value { display: block; }');
"


# M9: THE GAP. Put the savings line back inside the cost block, where its
# ~240px nowrap width sets the block width and shoves the value left.
mutate M9 "savings line widens the money block" "PANE-TC7" "frontend/src/components/DeckView.jsx" "
  const re = /              <\/div>\n            <\/div>\n          \)\}\n          <\/div>/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '              </div>\n              {savings !== null && (<div>{t(\'deck.toFinishCheapest\', { price: formatPrice(cheapest), saved: formatPrice(savings) })}</div>)}\n            </div>\n          )}\n          </div>');
"

# M10: THE BUG. Always show the catalogue results, so a card that IS in the
# deck gets its answer pushed below a list of cards he did not ask for.
mutate M10 "results push the deck list down again" "PANE-TC8" "frontend/src/components/DeckView.jsx" "
  const re = /\(searching \|\| results\.length > 0\) && !deckHasMatch && \(/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '(searching || results.length > 0) && (');
"

# M10b: check only the FILTERED list, so sitting on Missing and typing a card
# he owns still pops the add-a-card results for a card already in the deck.
mutate M10b "match checked against the filtered list" "PANE-TC8" "frontend/src/components/DeckView.jsx" "
  const re = /    return \[\.\.\.deckCards, \.\.\.considering\]\n      \.some/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, '    return shown\n      .some');
"

# M10c: keep saying 'no cards match' while the card sits on another tab --
# the app contradicting itself with the results now suppressed.
mutate M10c "list denies a card that is in the deck" "PANE-TC8" "frontend/src/components/DeckView.jsx" "
  const re = /\(deckHasMatch \? t\('deck\.matchOnAnotherTab'\) : t\('deck\.noCardsMatch'\)\)/;
  if (!re.test(before)) { console.error('anchor missing'); process.exit(3); }
  const after = before.replace(re, \"t('deck.noCardsMatch')\");
"

printf '\n'
if ! git diff --quiet -- $TARGETS "$TEST"; then
  echo "TREE NOT CLEAN after the run - restore failed. Check git status."
  exit 2
fi
echo "tree clean."
[ $fail -eq 0 ] && echo "ALL MUTATIONS CAUGHT BY THE INTENDED CASE" || echo "SOME MUTATIONS NOT CAUGHT - see above"
exit $fail
