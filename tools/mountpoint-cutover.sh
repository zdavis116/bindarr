#!/usr/bin/env bash
# ATTACH A 100G MOUNTPOINT TO AN LXC AND MOVE ITS DATA DIRECTORY ONTO IT.
#
# Runs on the PROXMOX HOST. Takes the container id, the data path to move, and
# the service to stop.
#
#   usage: mountpoint-cutover.sh <ctid> <service> <datadir>
#
# WHY THE CONTAINER MUST STOP: pct set writes the mountpoint into the config,
# and a live SQLite database must not be copied while a service writes to it.
# The stop is the shortest possible: config change, start, copy, swap.
#
# ROLLBACK: the original data is left in place under <datadir>.old until it is
# explicitly removed. Reverting is `pct set <ctid> --delete mpN`, restore the
# directory name, restart. The new volume is additive; nothing is destroyed.
set -euo pipefail

CTID="${1:?usage: mountpoint-cutover.sh <ctid> <service> <datadir>}"
SVC="${2:?service name}"
DATADIR="${3:?data directory to move}"
SIZE="${SIZE:-100}"
MP="${MP:-/mnt/data}"

echo "=== container $CTID: $SVC, moving $DATADIR ==="

# Refuse if a mountpoint already exists -- rerunning must not silently add a
# second volume or clobber an existing one.
if pct config "$CTID" | grep -qE '^mp[0-9]+:'; then
  echo "REFUSING: container $CTID already has a mountpoint:"
  pct config "$CTID" | grep -E '^mp[0-9]+:' | sed 's/^/  /'
  exit 1
fi

echo "stopping $SVC inside the container..."
pct exec "$CTID" -- systemctl stop "$SVC"

echo "stopping container $CTID..."
pct stop "$CTID"
for _ in $(seq 1 30); do
  [ "$(pct status "$CTID" | awk '{print $2}')" = "stopped" ] && break
  sleep 1
done
[ "$(pct status "$CTID" | awk '{print $2}')" = "stopped" ] || { echo "did not stop"; exit 1; }

echo "attaching ${SIZE}G at $MP..."
pct set "$CTID" -mp0 "data:${SIZE},mp=${MP},backup=1"

echo "starting container..."
pct start "$CTID"
for _ in $(seq 1 60); do
  pct exec "$CTID" -- true 2>/dev/null && break
  sleep 1
done

echo "verifying the new volume is mounted and writable..."
pct exec "$CTID" -- df -h "$MP" | tail -1 | sed 's/^/  /'
pct exec "$CTID" -- touch "$MP/.write-test"
pct exec "$CTID" -- rm -f "$MP/.write-test"
echo "  writable: yes"

# COPY, then swap by rename. Copying to the final name and deleting the
# original in one step would leave no state to roll back to if the copy is
# incomplete.
TARGET="$MP/$(basename "$DATADIR")"
echo "copying $DATADIR -> $TARGET ..."
pct exec "$CTID" -- cp -a "$DATADIR" "$TARGET"

echo "comparing source and copy..."
SRC_N=$(pct exec "$CTID" -- sh -c "find '$DATADIR' -type f | wc -l")
DST_N=$(pct exec "$CTID" -- sh -c "find '$TARGET' -type f | wc -l")
SRC_B=$(pct exec "$CTID" -- sh -c "du -sb '$DATADIR' | cut -f1")
DST_B=$(pct exec "$CTID" -- sh -c "du -sb '$TARGET' | cut -f1")
echo "  files: $SRC_N -> $DST_N"
echo "  bytes: $SRC_B -> $DST_B"
[ "$SRC_N" = "$DST_N" ] || { echo "FILE COUNT MISMATCH -- not swapping"; exit 1; }
[ "$SRC_B" = "$DST_B" ] || { echo "BYTE COUNT MISMATCH -- not swapping"; exit 1; }

# SWAP BY BIND MOUNT, NOT SYMLINK.
#
# The unit has ProtectSystem=strict with ReadWritePaths=/var/lib/bindarr-dev.
# systemd bind-mounts those paths read-write at start; a symlink would leave
# the REAL directory outside the writable set, so the service would start
# cleanly and fail on the first write.
#
# A bind mount keeps the path identical, so the unit, the env file and every
# deploy script stay correct and there is no second source of truth about where
# the data lives.
echo "swapping by bind mount..."
pct exec "$CTID" -- mv "$DATADIR" "${DATADIR}.old"
pct exec "$CTID" -- mkdir -p "$DATADIR"
pct exec "$CTID" -- mount --bind "$TARGET" "$DATADIR"

# Persist it, or the next container reboot silently serves the EMPTY directory
# and the app starts with no data.
FSTAB_LINE="$TARGET $DATADIR none bind 0 0"
pct exec "$CTID" -- sh -c "grep -qF '$TARGET $DATADIR' /etc/fstab || echo '$FSTAB_LINE' >> /etc/fstab"
echo "  fstab entry added (survives reboot)"

echo "verifying the bind mount serves the copied data..."
pct exec "$CTID" -- sh -c "mountpoint -q '$DATADIR' && echo '  bind mount active'"
pct exec "$CTID" -- sh -c "ls '$DATADIR' | head -3 | sed 's/^/    /'"

echo "starting $SVC..."
pct exec "$CTID" -- systemctl start "$SVC"
sleep 6
pct exec "$CTID" -- systemctl is-active "$SVC" | sed 's/^/  service: /'

echo
echo "DONE. Original data preserved at ${DATADIR}.old inside the container."
echo "Rollback: systemctl stop $SVC; umount $DATADIR; rmdir $DATADIR;"
echo "          mv ${DATADIR}.old $DATADIR; remove the fstab line; systemctl start $SVC"
