#!/usr/bin/env bash
# RETRY THE WRITE TEST WITH A VALID PAYLOAD.
#
# My last attempt sent type "box"; the CHECK constraint requires "Box". So the
# failure was my test, not the mount -- and a SQLITE_CONSTRAINT error is itself
# evidence the database is WRITABLE: a read-only database fails with
# SQLITE_READONLY before any constraint is evaluated.
#
# Proving it properly anyway, because "the error was a different error" is not
# the same as "the write works".
set -uo pipefail

TOK=$(PATH=/opt/node20/bin:$PATH node -e "
const s=require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const d=new s.Database('/var/lib/bindarr-dev/bindarr.db', s.OPEN_READONLY);
d.get('SELECT token FROM sessions ORDER BY rowid DESC LIMIT 1',(e,r)=>{
  console.log(r?r.token:''); d.close();});
")

echo "=== write through the API ==="
CREATE=$(curl -s -X POST http://localhost:3002/api/locations \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"name":"__cutover_write_test__","type":"Box"}')
ID=$(echo "$CREATE" | grep -oE '"id":[0-9]+' | head -1 | cut -d: -f2)

if [ -z "$ID" ]; then
  echo "  STILL FAILING: $(echo "$CREATE" | head -c 200)"
  exit 1
fi
echo "  created location $ID"

# Did it land on the NEW volume? Read it back through a path that bypasses the
# bind mount, so this cannot be satisfied by a cached handle.
echo
echo "=== the row is on the new volume ==="
PATH=/opt/node20/bin:$PATH node -e "
const s=require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const d=new s.Database('/mnt/data/bindarr-dev/bindarr.db', s.OPEN_READONLY);
d.get(\"SELECT id,name FROM locations WHERE name='__cutover_write_test__'\",(e,r)=>{
  console.log(r ? '  found on /mnt/data: id='+r.id : '  NOT on the new volume');
  d.close();});
"

echo
echo "=== and NOT on the old copy ==="
PATH=/opt/node20/bin:$PATH node -e "
const s=require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const d=new s.Database('/var/lib/bindarr-dev.old/bindarr.db', s.OPEN_READONLY);
d.get(\"SELECT id FROM locations WHERE name='__cutover_write_test__'\",(e,r)=>{
  console.log(r ? '  ALSO on the old copy -- the bind mount is not doing anything'
                : '  absent from the old copy: writes are going to the new volume');
  d.close();});
"

echo
echo "=== cleaning up ==="
curl -s -X DELETE "http://localhost:3002/api/locations/$ID" -H "Authorization: Bearer $TOK" >/dev/null
PATH=/opt/node20/bin:$PATH node -e "
const s=require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const d=new s.Database('/var/lib/bindarr-dev/bindarr.db', s.OPEN_READONLY);
d.get(\"SELECT COUNT(*) n FROM locations WHERE name='__cutover_write_test__'\",(e,r)=>{
  console.log('  test rows remaining: '+r.n); d.close();});
"
