#!/usr/bin/env bash
# FINISH THE CUTOVER.
#
# The mismatch was mine, not corruption: rsync is not installed, so the script
# fell back to `cp -a`, which copies but never DELETES. Checkpointing the old
# database removed its -wal and -shm; the new volume still held the stale pair
# from the first copy. 801 vs 799 files, and the two extra were exactly those.
#
# Stale WAL/shm files beside a checkpointed database are not harmless -- SQLite
# would try to recover from a WAL that no longer matches its database. They must
# be removed, not tolerated.
#
# The service is currently STOPPED, so nothing is writing while this runs.
set -euo pipefail

SVC=bindarr-dev
OLD=/var/lib/bindarr-dev.old
NEW=/mnt/data/bindarr-dev
LIVE=/var/lib/bindarr-dev

systemctl is-active "$SVC" >/dev/null 2>&1 && { echo "service is running; stop it first"; exit 1; }

echo "=== removing stale WAL/shm from the new volume ==="
for f in bindarr.db-wal bindarr.db-shm; do
  if [ -e "$NEW/$f" ] && [ ! -e "$OLD/$f" ]; then
    rm -f "$NEW/$f"
    echo "  removed $f (checkpointed away on the source)"
  fi
done

echo
echo "=== re-verifying the copy ==="
SRC_N=$(find "$OLD" -type f | wc -l); DST_N=$(find "$NEW" -type f | wc -l)
SRC_B=$(du -sb "$OLD" | cut -f1);      DST_B=$(du -sb "$NEW" | cut -f1)
echo "  files: $SRC_N -> $DST_N"
echo "  bytes: $SRC_B -> $DST_B"
[ "$SRC_N" = "$DST_N" ] || { echo "  STILL MISMATCHED -- stopping"; exit 1; }
[ "$SRC_B" = "$DST_B" ] || { echo "  BYTE MISMATCH -- stopping"; exit 1; }

echo
echo "=== integrity of the database the service will open ==="
PATH=/opt/node20/bin:$PATH node -e "
const s=require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const d=new s.Database('$LIVE/bindarr.db', s.OPEN_READONLY);
d.get('PRAGMA integrity_check',(e,r)=>{
  const v = r ? Object.values(r)[0] : 'ERR '+e.message;
  console.log('  integrity: '+v);
  if (v !== 'ok') process.exit(1);
  d.get('SELECT (SELECT COUNT(*) FROM collection) c,(SELECT COUNT(*) FROM decks) dk,(SELECT COUNT(*) FROM deck_cards) dc,(SELECT COUNT(*) FROM card_cache) k,(SELECT COUNT(*) FROM locations) l',
   (e2,r2)=>{console.log('  collection='+r2.c+' decks='+r2.dk+' deck_cards='+r2.dc+' cards='+r2.k+' locations='+r2.l); d.close();});
});
"

echo
echo "=== starting the service ==="
systemctl start "$SVC"
sleep 6
systemctl is-active "$SVC" | sed 's/^/  status: /'
printf '  HTTP %s\n' "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3002/)"

echo
echo "=== the process must now hold the NEW volume open ==="
PID=$(systemctl show -p MainPID --value "$SVC")
OPEN=$(ls -l /proc/"$PID"/fd 2>/dev/null | grep -oE '/[^ ]*bindarr\.db[^ ]*' | sort -u)
echo "$OPEN" | sed 's/^/  /'
if echo "$OPEN" | grep -q '\.old'; then
  echo "  STILL ON THE OLD COPY -- do not delete anything"
  exit 1
fi
echo "  correct: no .old paths held open"
