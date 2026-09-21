#!/usr/bin/env bash
# TIME THE REAL REQUEST, since the database work is only ~25ms and the wait is
# 30-60 seconds. Something between the route and SQLite is the cost, and
# guessing which would be how I end up optimising the wrong thing twice.
set -uo pipefail
B=http://127.0.0.1:3002
TOKEN=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"bindarr"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
AUTH="Authorization: Bearer $TOKEN"
ID=SneakAttack_ZNC

echo "--- resolve (MTGJSON fetch + card_cache lookup)"
curl -s -H "$AUTH" "$B/api/products/$ID/cards" -o /tmp/pt-cards \
  -w "  total %{time_total}s\n"

echo "--- resolve AGAIN (catalogue now cached)"
curl -s -H "$AUTH" "$B/api/products/$ID/cards" -o /tmp/pt-cards \
  -w "  total %{time_total}s\n"

python3 -c "
import json
d=json.load(open('/tmp/pt-cards'))
ids=[c['scryfallId'] for c in d['cards'] if c['inCatalogue']]
json.dump({'scryfall_ids':ids}, open('/tmp/pt-body','w'))
print('  rows to add:', len(ids))"

echo "--- ADD (the slow one)"
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -X POST "$B/api/products/$ID/add" -d @/tmp/pt-body -o /tmp/pt-res \
  -w "  total %{time_total}s\n"
python3 -c "
import json
d=json.load(open('/tmp/pt-res'))
print('  ', d.get('message'), '| rows', d.get('addedRows'))"

echo "--- undo: remove exactly what this just added"
node -e "
const s=require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const db=new s.Database('/var/lib/bindarr-dev/bindarr.db');
const ids=JSON.parse(require('fs').readFileSync('/tmp/pt-res','utf8')).added||[];
" 2>/dev/null || true
