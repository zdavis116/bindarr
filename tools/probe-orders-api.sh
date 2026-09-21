#!/usr/bin/env bash
# Exercise the Mana Pool orders endpoints on the real dev server.
#
# The check that matters most here is the NEGATIVE one: with no credentials
# stored, "not connected" must be distinguishable from "you have no orders".
# They are different problems with different fixes, and the wrong message sends
# Zach looking in entirely the wrong place.
#
# READ-ONLY. Nothing is written to the collection.
set -uo pipefail
B=http://127.0.0.1:3002
TOKEN=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"bindarr"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
AUTH="Authorization: Bearer $TOKEN"

echo "=== settings: before any credentials"
curl -s -H "$AUTH" "$B/api/settings/manapool" -o /tmp/mo-s -w "  http %{http_code}\n"
python3 -c "
import json; d=json.load(open('/tmp/mo-s'))
print('  connected:', d.get('connected'), '| email:', repr(d.get('email')), '| hint:', repr(d.get('tokenHint')))
print('  token echoed back?', 'token' in d, '<- must be False')"

echo
echo "=== orders list with NO credentials (must be 'not connected', NOT empty)"
curl -s -H "$AUTH" "$B/api/products/orders/list" -o /tmp/mo-l -w "  http %{http_code}\n"
python3 -c "
import json; d=json.load(open('/tmp/mo-l'))
print('  connected:', d.get('connected'))
print('  reason   :', d.get('reason'))
print('  orders   :', len(d.get('orders') or []))
ok = d.get('connected') is False and d.get('reason')
print('  VERDICT:', 'not-connected is distinguishable' if ok else '*** looks like an empty history ***')"

echo
echo "=== the route is REACHABLE (not shadowed by /:id/cards)"
python3 -c "
import json; d=json.load(open('/tmp/mo-l'))
# If /:id/cards had swallowed this, the body would be a product error about a
# product literally named 'orders' instead of an orders response.
bad = 'not in the catalogue' in json.dumps(d)
print('  VERDICT:', '*** SHADOWED by the precon route ***' if bad else 'reaches the orders handler')"

echo
echo "=== a bad token must be rejected on save"
curl -s -H "$AUTH" -H 'Content-Type: application/json' -X PUT \
  "$B/api/settings/manapool" -d '{"email":"a@b.com","token":"not-a-real-token"}' \
  -o /tmp/mo-bad -w "  http %{http_code}\n"
python3 -c "
import json; d=json.load(open('/tmp/mo-bad'))
print('  error:', d.get('error'))"

echo
echo "=== half-filled credentials must be refused"
curl -s -H "$AUTH" -H 'Content-Type: application/json' -X PUT \
  "$B/api/settings/manapool" -d '{"email":"a@b.com","token":""}' \
  -o /tmp/mo-half -w "  http %{http_code}\n"
python3 -c "
import json; d=json.load(open('/tmp/mo-half'))
print('  error:', d.get('error'))"

echo
echo "=== still not connected afterwards (nothing was saved)"
curl -s -H "$AUTH" "$B/api/settings/manapool" | python3 -c "
import json,sys; d=json.load(sys.stdin)
print('  connected:', d.get('connected'), '<- must be False')"
