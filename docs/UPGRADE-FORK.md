# Upgrading This Fork from v1.6.1

This fork uses a **clean-database cutover**. It does not migrate, import, or
rewrite the v1.6.1 database. The new deployment starts with
`DB_PATH=/var/lib/bindarr/bindarr-v2.db`; the old database remains available for
rollback and archival.

The commands below assume a systemd service named `bindarr`. Adapt the service,
binary, configuration, and current v1 database paths to the host before running
them. Perform the cutover in a maintenance window.

## 1. Record and stop v1.6.1

1. Record the deployed v1.6.1 binary or image identifier, configuration, service
   definition, and the exact current `DB_PATH`.
2. Stop Bindarr so SQLite is no longer writing to the database:

   ```sh
   sudo systemctl stop bindarr
   sudo systemctl is-active bindarr       # expected: inactive
   ```

3. Confirm no Bindarr process still has the database open. Do not start either
   version until the archive is complete.

## 2. Check and archive the untouched v1 database

Set `V1_DB` to the path recorded from the v1.6.1 configuration. These examples
use `/var/lib/bindarr/bindarr.db` only as a placeholder:

```bash
set -euo pipefail
V1_DB=/var/lib/bindarr/bindarr.db
ARCHIVE_ROOT=/var/backups/bindarr
ARCHIVE="$ARCHIVE_ROOT/v1.6.1-$(date -u +%Y%m%dT%H%M%SZ)"

# The service account can write /var/lib/bindarr, so never place a
# root-written archive beneath that tree. Keep this parent root-only.
sudo install -d -o root -g root -m 0700 "$ARCHIVE_ROOT"
sudo mkdir --mode=0700 "$ARCHIVE"  # intentionally fails if it already exists
sudo chown root:root "$ARCHIVE"
```

Run SQLite's integrity check read-only. The only successful result is `ok`:

```sh
sudo sqlite3 "file:${V1_DB}?mode=ro" 'PRAGMA integrity_check;'
```

If it does not print `ok`, stop and investigate; do not cut over. Archive the
main database and any existing WAL sidecars without changing the originals:

```bash
set -euo pipefail
: "${V1_DB:?set V1_DB in this shell before archiving}"
: "${ARCHIVE:?set ARCHIVE in this shell before archiving}"

DB_BASENAME=$(basename "$V1_DB")
ARCHIVED_FILES=("$ARCHIVE/$DB_BASENAME")
sudo cp --preserve=all "$V1_DB" "${ARCHIVED_FILES[0]}"
for sidecar in "${V1_DB}-wal" "${V1_DB}-shm"; do
  if sudo test -e "$sidecar"; then
    archived_sidecar="$ARCHIVE/$(basename "$sidecar")"
    sudo cp --preserve=all "$sidecar" "$archived_sidecar"
    ARCHIVED_FILES+=("$archived_sidecar")
  fi
done
sudo sha256sum "${ARCHIVED_FILES[@]}" | sudo tee "$ARCHIVE/SHA256SUMS.tmp" >/dev/null
sudo mv "$ARCHIVE/SHA256SUMS.tmp" "$ARCHIVE/SHA256SUMS"
sudo sha256sum --check "$ARCHIVE/SHA256SUMS"
```

Every checksum must report `OK`. The root-only parent and newly-created archive
directory prevent the Bindarr service account from pre-creating archive files or
symlinks that privileged copy/checksum commands could follow.

Keep the original v1 database and sidecars in place and read-only to the upgrade
process. Do not copy their contents into `bindarr-v2.db` and do not run migration
SQL against them.

## 3. Cut over to a fresh v2 database

1. Confirm the new path does not already exist:

   ```sh
   sudo test ! -e /var/lib/bindarr/bindarr-v2.db
   ```

2. Install the fork's binary/image and update its configuration to:

   ```text
   DB_PATH=/var/lib/bindarr/bindarr-v2.db
   ```

3. Ensure the Bindarr service account can write `/var/lib/bindarr`, then start
   the service. Bindarr will initialize the new database through its normal
   startup path:

   ```sh
   sudo systemctl start bindarr
   sudo systemctl status bindarr
   ```

Preserve the generated initial-admin credentials from the startup logs. Do not
replace `bindarr-v2.db` with the archived v1 file.

## 4. Health and smoke checks

Before reopening user traffic:

```sh
curl --fail --silent --show-error http://127.0.0.1:3001/api/health
```

Expect HTTP 200 with `{"status":"ok"}`. Then verify through the normal URL that:

- the sign-in page loads and the fresh admin can sign in;
- the collection starts empty;
- a card can be added and then read back;
- a deck can be created and opened;
- storage/location screens load;
- service logs contain no SQLite or startup errors; and
- a restart returns healthy and preserves the smoke-test data.

## 5. Rollback

If any check fails:

1. Stop the fork before changing files or configuration.
2. Restore the recorded v1.6.1 binary/image, service definition, and
   configuration.
3. Restore `DB_PATH` to the exact old v1 database path. Do **not** point v1.6.1
   at `/var/lib/bindarr/bindarr-v2.db`.
4. Start v1.6.1 and repeat the health check and a read-only application smoke
   check against the old collection.

Leave `bindarr-v2.db` untouched for diagnosis. Rollback is a binary/configuration
and database-path switch; it is not a reverse migration.
