#!/usr/bin/env bash
# THE WRITE LANDED ON THE OLD COPY, NOT THE NEW VOLUME?
#
# Two innocent explanations before I conclude the bind mount is broken:
#
#  1. WAL. The row is committed but still in bindarr.db-wal; a reader opening
#     the .db file directly through a DIFFERENT path may not see it, and the
#     old copy check could be a false positive for the same reason.
#  2. The two paths are the SAME FILE. If the bind mount works, /mnt/data/... and
#     /var/lib/... are one inode -- and /var/lib/bindarr-dev.old should be a
#     different one. If .old shares the inode, the mv/bind sequence did not do
#     what I think.
#
# Inodes settle it: they cannot be faked by caching.
set -uo pipefail

echo "=== inodes: which paths are the same file? ==="
for p in /var/lib/bindarr-dev/bindarr.db \
         /mnt/data/bindarr-dev/bindarr.db \
         /var/lib/bindarr-dev.old/bindarr.db; do
  printf "  %-42s dev=%s inode=%s size=%s\n" "$p" \
    "$(stat -c %d "$p" 2>/dev/null)" "$(stat -c %i "$p" 2>/dev/null)" \
    "$(stat -c %s "$p" 2>/dev/null)"
done

echo
echo "=== mounts ==="
grep -E 'bindarr|/mnt/data' /proc/mounts | sed 's/^/  /'

echo
echo "=== which file does the RUNNING process have open? ==="
PID=$(systemctl show -p MainPID --value bindarr-dev)
echo "  pid: $PID"
ls -l /proc/"$PID"/fd 2>/dev/null | grep -E 'bindarr\.db' | awk '{print "  " $NF}' | sort -u | head -5

echo
echo "=== WAL state ==="
for d in /var/lib/bindarr-dev /mnt/data/bindarr-dev /var/lib/bindarr-dev.old; do
  printf "  %-34s db=%s wal=%s\n" "$d" \
    "$(stat -c %s "$d/bindarr.db" 2>/dev/null)" \
    "$(stat -c %s "$d/bindarr.db-wal" 2>/dev/null || echo -)"
done

echo
echo "=== read WITH the WAL, through each path ==="
for d in /var/lib/bindarr-dev /mnt/data/bindarr-dev /var/lib/bindarr-dev.old; do
  n=$(PATH=/opt/node20/bin:$PATH node -e "
    const s=require('/opt/bindarr-dev/backend/node_modules/sqlite3');
    const d=new s.Database('$d/bindarr.db', s.OPEN_READONLY);
    d.get('SELECT COUNT(*) n FROM locations',(e,r)=>{
      console.log(e?'err':r.n); d.close();});
  " 2>/dev/null)
  echo "  $d -> locations=$n"
done
