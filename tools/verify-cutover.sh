#!/usr/bin/env bash
# VERIFY THE CUTOVER ACTUALLY WORKED.
#
# "service: active" only proves the process started. ProtectSystem=strict means
# a wrong path fails on the first WRITE, not at startup -- so the thing to
# check is that the app can write, and that it is writing to the new volume
# rather than a stale copy.
set -uo pipefail

echo "=== where the data now lives ==="
df -h /mnt/data /var/lib/bindarr-dev 2>/dev/null | grep -v Filesystem | sed 's/^/  /'
mountpoint -q /var/lib/bindarr-dev && echo "  bind mount: active" || echo "  BIND MOUNT MISSING"

echo
echo "=== root filesystem now ==="
df -h / | tail -1 | sed 's/^/  /'

echo
echo "=== the app is serving ==="
printf '  HTTP %s\n' "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3002/)"

echo
echo "=== can it WRITE? (the failure ProtectSystem=strict would cause) ==="
BEFORE=$(stat -c %Y /var/lib/bindarr-dev/bindarr.db 2>/dev/null)
TOK=$(PATH=/opt/node20/bin:$PATH node -e "
const s=require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const d=new s.Database('/var/lib/bindarr-dev/bindarr.db', s.OPEN_READONLY);
d.get('SELECT token FROM sessions ORDER BY rowid DESC LIMIT 1',(e,r)=>{
  console.log(r?r.token:''); d.close();});
")
# A real write through the API: create then delete a location.
CREATE=$(curl -s -X POST http://localhost:3002/api/locations \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"name":"__cutover_write_test__","type":"box"}')
ID=$(echo "$CREATE" | grep -oE '"id":[0-9]+' | head -1 | cut -d: -f2)
if [ -n "$ID" ]; then
  echo "  write succeeded (created location $ID)"
  curl -s -X DELETE "http://localhost:3002/api/locations/$ID" \
    -H "Authorization: Bearer $TOK" >/dev/null
  echo "  cleaned up"
else
  echo "  WRITE FAILED: $(echo "$CREATE" | head -c 160)"
fi

echo
echo "=== is the write landing on the NEW volume? ==="
AFTER=$(stat -c %Y /var/lib/bindarr-dev/bindarr.db 2>/dev/null)
NEWV=$(stat -c %Y /mnt/data/bindarr-dev/bindarr.db 2>/dev/null)
OLDV=$(stat -c %Y /var/lib/bindarr-dev.old/bindarr.db 2>/dev/null)
echo "  live db mtime changed: $([ "$BEFORE" != "$AFTER" ] && echo yes || echo 'no (may be WAL-buffered)')"
echo "  new volume copy mtime == live: $([ "$NEWV" = "$AFTER" ] && echo yes || echo NO)"
echo "  old copy untouched:            $([ "$OLDV" != "$AFTER" ] && echo yes || echo 'same file?!')"

echo
echo "=== data intact ==="
PATH=/opt/node20/bin:$PATH node -e "
const s=require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const d=new s.Database('/var/lib/bindarr-dev/bindarr.db', s.OPEN_READONLY);
d.get('SELECT (SELECT COUNT(*) FROM collection) c,(SELECT COUNT(*) FROM decks) d,(SELECT COUNT(*) FROM deck_cards) dc,(SELECT COUNT(*) FROM card_cache) k',
 (e,r)=>{console.log('  collection='+r.c+' decks='+r.d+' deck_cards='+r.dc+' cards='+r.k);d.close();});
"
echo "  scandump images: $(find /var/lib/bindarr-dev/scandump -name '*.jpg' 2>/dev/null | wc -l)"

echo
echo "=== rollback copy still present ==="
du -sh /var/lib/bindarr-dev.old 2>/dev/null | sed 's/^/  /'
