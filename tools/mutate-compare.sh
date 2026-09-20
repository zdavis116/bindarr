#!/usr/bin/env bash
# Mutation-test the compare sectioning guards: break each rule, confirm the
# intended test fails, restore from a /tmp copy (never git checkout -- that
# would wipe uncommitted work).
cd /home/hermes/repos/bindarr/frontend || exit 1
export PATH="$HOME/.cache/hermes-node20/node-v20.20.2-linux-x64/bin:$PATH"

CS=src/components/compareSections.js
DCM=src/components/DeckCompareModal.jsx
cp $CS /tmp/cs.bak
cp $DCM /tmp/dcm.bak

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
open(p,'w').write(s.replace('cards: bucket.sort(byName)','cards: bucket'))"
run; cp /tmp/cs.bak $CS

echo "M2: sort sections by name instead of deck view order (expect CS-TC1)"
python3 -c "
p='$CS';s=open(p).read()
old=\"for (const title of [...TYPE_SECTIONS, 'Other'])\"
new=\"for (const title of [...TYPE_SECTIONS, 'Other'].slice().sort())\"
assert old in s
open(p,'w').write(s.replace(old,new))"
run; cp /tmp/cs.bak $CS

echo "M3: drop unknown types instead of filing them in Other (expect CS-TC4)"
python3 -c "
p='$CS';s=open(p).read()
old='    const key = sectionForTypeLine(card.typeLine);'
new=old+chr(10)+\"    if (key === 'Other') continue;\"
assert old in s
open(p,'w').write(s.replace(old,new,1))"
run; cp /tmp/cs.bak $CS

echo "M4: count rows instead of physical cards (expect CS-TC6)"
python3 -c "
p='$CS';s=open(p).read()
old='sum + (c.quantity || 1)'
assert old in s
open(p,'w').write(s.replace(old,'sum + 1'))"
run; cp /tmp/cs.bak $CS

echo "M5: recompute shared in the UI instead of reading the server flag (expect CS-TC7)"
python3 -c "
p='$DCM';s=open(p).read()
old=chr(34)+'className={c.shared ? '+chr(39)+chr(39)+' : '+chr(39)+'mpc-differs'+chr(39)+'}'+chr(34)
old=old.strip(chr(34))
new='className={diff.mine.some((m) => m.oracleId === c.oracleId) ? '+chr(39)+chr(39)+' : '+chr(39)+'mpc-differs'+chr(39)+'}'
assert old in s, 'anchor missing'
open(p,'w').write(s.replace(old,new))"
run; cp /tmp/dcm.bak $DCM

echo "--- restored, baseline should be all PASS:"
node src/components/compareSections.test.js
echo "--- files match originals:"
diff -q /tmp/cs.bak $CS && diff -q /tmp/dcm.bak $DCM && echo "restore clean"
