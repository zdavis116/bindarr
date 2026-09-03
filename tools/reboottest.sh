#!/usr/bin/env bash
# DOES THE BIND MOUNT SURVIVE A REBOOT?
#
# This is the step that decides whether the old copy can be deleted. If the
# fstab entry is wrong, a reboot serves the EMPTY /var/lib/bindarr-dev and the
# app starts with no data -- and with the old copy gone there would be nothing
# to fall back to but last night's archive.
#
# Testing it now, while the rollback copy still exists.
set -euo pipefail

echo "=== fstab entry ==="
grep bindarr /etc/fstab | sed 's/^/  /' || echo "  NO ENTRY -- would not survive"

echo
echo "=== simulating: unmount and remount from fstab alone ==="
systemctl stop bindarr-dev
umount /var/lib/bindarr-dev
echo "  unmounted; directory now shows $(ls /var/lib/bindarr-dev | wc -l) entries (expect 0)"

mount /var/lib/bindarr-dev
mountpoint -q /var/lib/bindarr-dev && echo "  remounted from fstab: yes" || { echo "  FSTAB REMOUNT FAILED"; exit 1; }
echo "  directory now shows $(ls /var/lib/bindarr-dev | wc -l) entries"

echo
echo "=== data present after the remount ==="
PATH=/opt/node20/bin:$PATH node -e "
const s=require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const d=new s.Database('/var/lib/bindarr-dev/bindarr.db', s.OPEN_READONLY);
d.get('SELECT (SELECT COUNT(*) FROM collection) c,(SELECT COUNT(*) FROM card_cache) k',
 (e,r)=>{console.log('  collection='+r.c+' cards='+r.k); d.close();});
"
echo "  scandump images: $(find /var/lib/bindarr-dev/scandump -name '*.jpg' | wc -l)"

systemctl start bindarr-dev
sleep 6
echo "  service: $(systemctl is-active bindarr-dev)  HTTP $(curl -s -o /dev/null -w '%{http_code}' http://localhost:3002/)"
