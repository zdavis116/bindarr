#!/bin/sh
# Does entrypoint.sh's scanner-asset step actually work?
#
# There is no Docker on either box, so the image cannot be built here. What CAN
# be verified is the part that was wrong twice: whether the command the
# entrypoint runs passes DB_PATH and CLIENT_SCAN_DIR through to the script.
#
# This fakes `gosu` with a shim on PATH and runs the entrypoint's exact command
# line, so a regression in quoting or environment handling fails HERE rather
# than on a production container start.
set -e
cd "$(dirname "$0")/.."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# gosu shim: drops the user-spec argument and execs the rest, which is gosu's
# behaviour for our purposes (it preserves the environment; that is the whole
# point of the check).
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gosu" <<'SHIM'
#!/bin/sh
# $1 is the user spec; gosu preserves the environment, so just exec the rest.
shift
exec "$@"
SHIM
chmod +x "$TMP/bin/gosu"

# A stand-in for the real script that reports what it received.
mkdir -p "$TMP/app/backend/scripts"
cat > "$TMP/app/backend/scripts/build-scan-assets.mjs" <<'PROBE'
console.log('ARG_OUT=' + (process.argv[2] || '<none>'));
console.log('DB_PATH=' + (process.env.DB_PATH || '<unset>'));
console.log('CLIENT_SCAN_DIR=' + (process.env.CLIENT_SCAN_DIR || '<unset>'));
PROBE

# The entrypoint's asset command, lifted verbatim.
CMD="$(grep -A1 "preparing on-device scanner assets" entrypoint.sh \
  | grep 'gosu node sh -c' | sed 's/^ *//; s/ *\\\\$//')"
echo "command under test:"
echo "  $CMD"
echo

export PATH="$TMP/bin:$PATH"
export DB_PATH=/app/database/bindarr.db
export CLIENT_SCAN_DIR=/app/database/models/client-scan

OUT="$(cd "$TMP" && sed "s#cd /app/backend#cd $TMP/app/backend#" <<EOF | sh
$CMD
EOF
)"
echo "$OUT"
echo

fail=0
echo "$OUT" | grep -q "ARG_OUT=/app/database/models/client-scan" \
  || { echo "FAIL: the output directory argument did not survive"; fail=1; }
echo "$OUT" | grep -q "DB_PATH=/app/database/bindarr.db" \
  || { echo "FAIL: DB_PATH did not reach the script -- the index build will abort"; fail=1; }
echo "$OUT" | grep -q "CLIENT_SCAN_DIR=/app/database/models/client-scan" \
  || { echo "FAIL: CLIENT_SCAN_DIR did not reach the script"; fail=1; }

# And the flag that would break every container start.
if grep -q 'gosu -E' entrypoint.sh; then
  echo "FAIL: 'gosu -E' -- gosu has no -E flag; it parses as the user-spec and"
  echo "      fails every container start. gosu preserves the environment already."
  fail=1
fi

[ $fail -eq 0 ] && echo "PASS: the entrypoint passes DB_PATH, CLIENT_SCAN_DIR and the output path"
exit $fail
