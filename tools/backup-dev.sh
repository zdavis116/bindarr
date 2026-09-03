#!/usr/bin/env bash
# ARCHIVE THE DEV DATABASE BEFORE ANYTHING DESTRUCTIVE.
#
# Backs up and verifies only. Deletes nothing, moves nothing, service stays up.
# Its job is to make every later step reversible.
#
# The archive lives OUTSIDE any directory the bindarr-dev service account can
# write. /var/backups is root-owned; /var/lib/bindarr-dev is not -- a
# compromised service could otherwise pre-create symlinks there and have root
# follow them.
set -euo pipefail

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="/var/backups/bindarr-dev/${STAMP}"
SRC="/var/lib/bindarr-dev"

: "${SRC:?}"; : "${ARCHIVE:?}"

install -d -o root -g root -m 0700 /var/backups/bindarr-dev

# No -p: creation MUST fail if the directory exists. A timestamp is not a
# security boundary, and reusing an archive dir would mix two runs.
mkdir -m 0700 "$ARCHIVE"
echo "archive: $ARCHIVE"

echo "checkpointing and backing up the live database..."
PATH=/opt/node20/bin:$PATH node /tmp/backup.cjs "$SRC/bindarr.db" "$ARCHIVE/bindarr.db" \
  | sed 's/^/  /'

# The three stale backups are about to be deleted. Archive them first: they are
# the only copies, and "old and not needed" is my judgement, not a fact.
for f in bindarr.db.pre-merge bindarr.db.pre-s4 pre-migration-backup.db; do
  [ -f "$SRC/$f" ] && cp -n "$SRC/$f" "$ARCHIVE/$f"
done

# MANIFEST, atomically. Hash an EXPLICIT list, never a glob -- a rerun would
# otherwise fold the previous manifest into its own checksum. Written to .tmp
# and renamed only after the whole pipeline succeeds, so a partial manifest can
# never look complete.
cd "$ARCHIVE"
# The list lives OUTSIDE the archive: written inside, `find` picks it up as an
# archive file, hashes it, and then --check fails looking for scaffolding that
# was cleaned up. Scaffolding is not an artifact.
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
find . -maxdepth 1 -type f ! -name 'SHA256SUMS*' -printf '%P\n' | sort > "$LIST"
xargs -a "$LIST" sha256sum > SHA256SUMS.tmp
mv SHA256SUMS.tmp SHA256SUMS

echo -n "manifest verification: "
if sha256sum --check --status SHA256SUMS; then
  echo "ALL OK"
else
  echo "FAILED -- do not proceed"; exit 1
fi

echo
ls -lh "$ARCHIVE" | awk 'NR>1 {printf "  %6s  %s\n", $5, $9}'
echo "total: $(du -sh "$ARCHIVE" | cut -f1)"
echo "ARCHIVE_PATH=$ARCHIVE"
