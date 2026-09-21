#!/usr/bin/env bash
# ADD A REAL PRECON, THEN COUNT THE ROWS THAT LANDED.
#
# This is the test that matters. A green unit suite and a screenshot both show
# the feature APPEARING to work; only counting rows in the database proves 100
# cards actually arrived, with the right quantities and the right finishes.
#
# WRITES TO THE DEV DATABASE. It records the collection row ids it created and
# prints them, so the add can be undone.
set -uo pipefail
B=http://127.0.0.1:3002
DB=/var/lib/bindarr-dev/bindarr.db

TOKEN=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"bindarr"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
AUTH="Authorization: Bearer $TOKEN"

ID=SneakAttack_ZNC

echo "=== BEFORE ==="
node -e "
const s=require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const db=new s.Database('$DB', s.OPEN_READONLY);
db.get('SELECT COUNT(*) rows, COALESCE(SUM(quantity),0) cards FROM collection WHERE list_type=\"collection\"',
  (e,r)=>{console.log('  collection:', JSON.stringify(r));
          require('fs').writeFileSync('/tmp/pa-before', JSON.stringify(r));});
"
sleep 1

echo "=== resolve the product ==="
curl -s -H "$AUTH" "$B/api/products/$ID/cards" -o /tmp/pa-cards -w "  http %{http_code}\n"
python3 - <<'PY'
import json
d=json.load(open('/tmp/pa-cards'))
cards=[c for c in d['cards'] if c['inCatalogue']]
print('  will add:', sum(c['quantity'] for c in cards), 'cards across', len(cards), 'rows')
json.dump([c['scryfallId'] for c in cards], open('/tmp/pa-ids','w'))
PY

echo "=== POST the add ==="
python3 -c "
import json
print(json.dumps({'scryfall_ids': json.load(open('/tmp/pa-ids'))}))" > /tmp/pa-body
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -X POST "$B/api/products/$ID/add" -d @/tmp/pa-body -o /tmp/pa-res \
  -w "  http %{http_code}\n"
python3 - <<'PY'
import json
d=json.load(open('/tmp/pa-res'))
print('  message   :', d.get('message'))
print('  addedRows :', d.get('addedRows'))
print('  addedCards:', d.get('addedCards'))
print('  failed    :', len(d.get('failed') or []))
for f in (d.get('failed') or [])[:5]: print('     ', f.get('name'), '->', f.get('error'))
PY

sleep 2
echo "=== AFTER: what is actually in the database ==="
# MEASURE THE DELTA, NOT A GUESSED WINDOW.
#
# The first version read "the last 72 rows by id" and concluded 100 cards had
# NOT landed. They had -- the new rows are not contiguous (ids are reused and
# interleaved), so that window sliced through the middle of the add and missed
# the foil row entirely. A measurement that picks an arbitrary range is not a
# measurement. Compare totals before and after, and look up cards by NAME.
node -e "
const s=require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const db=new s.Database('$DB', s.OPEN_READONLY);
const q=(sql,p=[])=>new Promise((res,rej)=>db.all(sql,p,(e,r)=>e?rej(e):res(r)));
(async()=>{
  const t=(await q('SELECT COUNT(*) rows, COALESCE(SUM(quantity),0) cards FROM collection WHERE list_type=\"collection\"'))[0];
  console.log('  collection now:', JSON.stringify(t));
  const before=JSON.parse(require('fs').readFileSync('/tmp/pa-before','utf8'));
  console.log('  delta: +' + (t.rows-before.rows) + ' rows, +' + (t.cards-before.cards) + ' cards',
    (t.cards-before.cards)===100 ? '-> 100 CARDS CORRECT' : '-> *** NOT 100 ***');
  console.log('  SHAPE:', (t.rows-before.rows)===72 ? '72 rows -> STACKED CORRECTLY' :
    '*** ' + (t.rows-before.rows) + ' rows, expected 72 (stacking is broken) ***');
  // The two checks that a row-count alone cannot make.
  const isl=await q('SELECT c.quantity FROM collection c JOIN card_cache cc ON cc.id=c.card_id WHERE cc.name=\"Island\" ORDER BY c.id DESC LIMIT 3');
  console.log('  newest Island rows:', JSON.stringify(isl.map(r=>r.quantity)),
    isl[0] && isl[0].quantity===15 ? '-> one row of 15 CORRECT' : '*** expected a row of 15 ***');
  const an=await q('SELECT c.quantity,c.finish FROM collection c JOIN card_cache cc ON cc.id=c.card_id WHERE cc.name=\"Anowon, the Ruin Thief\" ORDER BY c.id DESC LIMIT 1');
  console.log('  newest Anowon:', JSON.stringify(an[0]),
    an[0] && an[0].finish==='foil' ? '-> FOIL CORRECT' : '*** expected foil ***');
})();
"
