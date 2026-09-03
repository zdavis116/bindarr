#!/usr/bin/env bash
# THE SERVICE IS STILL WRITING TO THE OLD DIRECTORY.
#
# The bind mount is CORRECT: /var/lib/bindarr-dev and /mnt/data/bindarr-dev are
# the same inode (1048586 on device 1798), and the old copy is a different file
# (132771 on 1793). Nothing wrong with the mount.
#
# The problem is the PROCESS. Its open file descriptors point at
# /var/lib/bindarr-dev.old/bindarr.db -- because the cutover script started the
# service, and only THEN did the mv/bind swap. A process holds the inode it
# opened; renaming the directory underneath it changes nothing.
#
# So every write since the cutover has gone to the old copy, which is why the
# test row appeared there. Live data is currently accumulating on the disk I am
# about to delete.
#
# FIX: stop the service, fold the WAL, re-copy the (now newer) old data onto the
# new volume, restart so it opens the bind-mounted path.
set -euo pipefail

SVC=bindarr-dev
OLD=/var/lib/bindarr-dev.old
NEW=/mnt/data/bindarr-dev
LIVE=/var/lib/bindarr-dev

echo "=== stopping $SVC so nothing is writing ==="
systemctl stop "$SVC"
sleep 2
systemctl is-active "$SVC" | sed 's/^/  status: /' || true

echo
echo "=== folding the WAL into the old database ==="
PATH=/opt/node20/bin:$PATH node -e "
const s=require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const d=new s.Database('$OLD/bindarr.db', s.OPEN_READWRITE);
d.run('PRAGMA wal_checkpoint(TRUNCATE)',(e)=>{
  if(e){console.error('  checkpoint failed: '+e.message);process.exit(1);}
  console.log('  checkpoint ok'); d.close();});
"

echo
echo "=== re-copying the authoritative data onto the new volume ==="
# The old directory is now the newer one -- it took every write since the
# cutover. Copy it over the new volume's contents, then verify.
rsync -a --delete "$OLD/" "$NEW/" 2>/dev/null || cp -a "$OLD/." "$NEW/"

SRC_N=$(find "$OLD" -type f | wc -l)
DST_N=$(find "$NEW" -type f | wc -l)
SRC_B=$(du -sb "$OLD" | cut -f1)
DST_B=$(du -sb "$NEW" | cut -f1)
echo "  files: $SRC_N -> $DST_N"
echo "  bytes: $SRC_B -> $DST_B"
[ "$SRC_N" = "$DST_N" ] || { echo "  FILE COUNT MISMATCH -- not restarting"; exit 1; }
[ "$SRC_B" = "$DST_B" ] || { echo "  BYTE COUNT MISMATCH -- not restarting"; exit 1; }

echo
echo "=== integrity of the copy the service will now open ==="
PATH=/opt/node20/bin:$PATH node -e "
const s=require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const d=new s.Database('$LIVE/bindarr.db', s.OPEN_READONLY);
d.get('PRAGMA integrity_check',(e,r)=>{
  console.log('  integrity: '+(r?Object.values(r)[0]:e.message));
  d.get('SELECT (SELECT COUNT(*) FROM collection) c,(SELECT COUNT(*) FROM locations) l',(e2,r2)=>{
    console.log('  collection='+r2.c+' locations='+r2.l); d.close();});
});
"

echo
echo "=== starting the service ==="
systemctl start "$SVC"
sleep 6
systemctl is-active "$SVC" | sed 's/^/  status: /'

echo
echo "=== which files does it have open NOW? ==="
PID=$(systemctl show -p MainPID --value "$SVC")
ls -l /proc/"$PID"/fd 2>/dev/null | grep -oE '/[^ ]*bindarr\.db[^ ]*' | sort -u | sed 's/^/  /'
