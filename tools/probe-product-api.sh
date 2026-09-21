#!/usr/bin/env bash
# Exercise the product import END TO END against the real dev server, as a
# logged-in user. A green unit suite proves my parser reads my own fixtures; it
# cannot prove the route is reachable, authorised, and returns real cards.
#
# READ-ONLY by default: it stops before POSTing anything into the collection.
set -uo pipefail
B=http://127.0.0.1:3002
echo "--- login"
# Auth is a BEARER TOKEN in the response body, not a cookie. -c/-b wrote an
# empty jar and every call came back 401 -- read the real response before
# assuming a session shape.
curl -s -X POST "$B/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"bindarr"}' -o /tmp/pp-login \
  -w "  http %{http_code}\n"
TOKEN=$(python3 -c "import json;print(json.load(open('/tmp/pp-login'))['token'])")
AUTH="Authorization: Bearer $TOKEN"

echo "--- search: precons matching 'sneak'"
curl -s -H "$AUTH" "$B/api/products?q=sneak&kind=precon" -o /tmp/pp-search \
  -w "  http %{http_code}\n"
python3 - <<'PY'
import json
d=json.load(open('/tmp/pp-search'))
print('  groups:', d.get('total'))
for g in (d.get('groups') or [])[:3]:
    print('   ', g['base'], '|', g['kind'], '| editions', len(g['editions']), '|', g['editions'][0]['id'])
open('/tmp/pp-id','w').write((d.get('groups') or [{}])[0].get('editions',[{}])[0].get('id',''))
PY

ID=$(cat /tmp/pp-id)
echo "--- cards for: $ID"
curl -s -H "$AUTH" "$B/api/products/$ID/cards" -o /tmp/pp-cards -w "  http %{http_code}\n"
python3 - <<'PY'
import json
d=json.load(open('/tmp/pp-cards'))
cards=d.get('cards') or []
print('  product     :', (d.get('product') or {}).get('name'))
print('  totalCards  :', d.get('totalCards'))
print('  rows        :', len(cards))
print('  addableCards:', d.get('addableCards'))
print('  missingCount:', d.get('missingCount'))
foil=[c for c in cards if c.get('finish')!='nonfoil']
print('  foil rows   :', [(c['name'],c['finish']) for c in foil])
big=[c for c in cards if c.get('quantity',1)>4]
print('  big counts  :', [(c['quantity'],c['name']) for c in big])
bad=[c for c in cards if not c.get('inCatalogue')]
print('  NOT in cat. :', [c['name'] for c in bad] or 'none')
# The contract that matters: every card is present and quantities add up.
tot=sum(c.get('quantity',1) for c in cards)
print('  SUM(quantity) =', tot, '(matches totalCards)' if tot==d.get('totalCards') else '*** MISMATCH ***')
PY

echo "--- edition twins (Secret Lair)"
curl -s -H "$AUTH" "$B/api/products?q=box%20of%20rocks&kind=secretlair" -o /tmp/pp-twin \
  -w "  http %{http_code}\n"
python3 - <<'PY'
import json
d=json.load(open('/tmp/pp-twin'))
for g in (d.get('groups') or [])[:2]:
    print('  ', g['base'], '->', [e['name'] for e in g['editions']])
PY
echo "--- done (nothing was written)"
