#!/usr/bin/env bash
# Mutation-test the compare sectioning guards. Break each rule, confirm the
# intended test fails, restore from a /tmp copy (never git checkout -- that
# would wipe uncommitted work).
cd /home/hermes/repos/bindarr/frontend || exit 1
export PATH="$HOME/.cache/hermes-node20/node-v20.20.2-linux-x64/bin:$PATH"

CS=src/components/compareSections.js
DLS=src/components/deckListSections.js
DCM=src/components/DeckCompareModal.jsx
EN=src/locales/en.json
cp $CS /tmp/cs.bak; cp $DLS /tmp/dls.bak; cp $DCM /tmp/dcm.bak; cp $EN /tmp/en.bak

# A mutation whose anchor no longer matches must ABORT the run. The first
# version of this script let a failed python edit fall through to `run`, which
# reported "STILL PASSED - test is vacuous" against an UNMUTATED file and then
# copied that file over the backup. Every later mutation was then measured
# against a corrupted baseline. A broken harness that reports confidently is
# worse than no harness.
set -e
trap 'echo "ABORT: a mutation failed to apply - anchors are stale, restoring"; \
      cp /tmp/cs.bak $CS; cp /tmp/dls.bak $DLS; cp /tmp/dcm.bak $DCM; \
      cp /tmp/en.bak $EN' ERR

run() {
  if node src/components/compareSections.test.js >/tmp/o 2>&1; then
    echo "  !!! STILL PASSED - test is vacuous"
  else
    echo "  failed as intended: $(grep -o 'CS-TC[0-9]' /tmp/o | head -1)"
  fi
}

echo "M1: drop the alphabetical sort (expect CS-TC2)"
python3 -c "
p='$CS';s=open(p).read()
old='groupIntoSections(cards, { sort: byName })'
assert old in s
open(p,'w').write(s.replace(old,'groupIntoSections(cards)'))"
run; cp /tmp/cs.bak $CS

echo "M2: sort sections alphabetically instead of Moxfield order (expect CS-TC1)"
python3 -c "
p='$DLS';s=open(p).read()
old=\"const ordered = [...TYPE_ORDER, 'Other'].filter((name) => by.has(name));\"
new=\"const ordered = [...TYPE_ORDER, 'Other'].slice().sort().filter((name) => by.has(name));\"
assert old in s
open(p,'w').write(s.replace(old,new))"
run; cp /tmp/dls.bak $DLS

echo "M3: drop unknown types instead of filing them in Other (expect CS-TC4)"
python3 -c "
p='$DLS';s=open(p).read()
old=\"    if (!by.has(key)) by.set(key, []);\"
new=\"    if (key === 'Other') continue;\"+chr(10)+old
assert old in s
open(p,'w').write(s.replace(old,new,1))"
run; cp /tmp/dls.bak $DLS

echo "M4: count rows instead of physical cards (expect CS-TC6)"
python3 -c "
p='$DLS';s=open(p).read()
old='n + (c.quantity ?? 1)'
assert old in s
open(p,'w').write(s.replace(old,'n + 1'))"
run; cp /tmp/dls.bak $DLS

echo "M5: recompute shared in the UI instead of reading the server flag (expect CS-TC7)"
python3 -c "
p='$DCM';s=open(p).read()
q=chr(39)
old='className={c.shared ? '+q+q+' : '+q+'mpc-differs'+q+'}'
new='className={diff.mine.some((m) => m.oracleId === c.oracleId) ? '+q+q+' : '+q+'mpc-differs'+q+'}'
assert old in s, 'anchor missing'
open(p,'w').write(s.replace(old,new))"
run; cp /tmp/dcm.bak $DCM

echo "M6: THE REAL BUG - lose the Battle section, as the shipped version did (expect CS-TC8)"
python3 -c "
p='$DLS';s=open(p).read()
old=\"'Planeswalker', 'Battle', 'Land'\"
assert old in s
open(p,'w').write(s.replace(old,\"'Planeswalker', 'Land'\"))"
run; cp /tmp/dls.bak $DLS

echo "M6b: filter sections strictly by TYPE_ORDER, deleting unlisted cards (expect CS-TC10)"
python3 -c "
p='$DLS';s=open(p).read()
old='[...ordered, ...unlisted]'
assert old in s
open(p,'w').write(s.replace(old,'ordered'))"
run; cp /tmp/dls.bak \$DLS

echo "M7: revert a section label to the plural form (expect CS-TC9)"
python3 -c "
import json
p='$EN';s=open(p).read()
old='\"mpc.sectionCreature\": \"Creature\"'
assert old in s
open(p,'w').write(s.replace(old,'\"mpc.sectionCreature\": \"Creatures\"'))"
run; cp /tmp/en.bak $EN

echo "--- restored, baseline should be all PASS:"
node src/components/compareSections.test.js
echo "--- files match originals:"
diff -q /tmp/cs.bak $CS && diff -q /tmp/dls.bak $DLS && diff -q /tmp/dcm.bak $DCM \
  && diff -q /tmp/en.bak $EN && echo "restore clean"
