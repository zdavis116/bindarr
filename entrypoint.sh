#!/bin/sh
# Runs as root, fixes ownership of the persisted volume, then drops to the
# unprivileged `node` user. A named volume created by an older root-running
# image is root-owned; without this, the non-root process hits EACCES writing
# indexes (see issue #17). The stat guard makes the recursive chown a one-time
# cost: once the top dir is node-owned, later starts skip it.
set -e

mkdir -p /app/database/index /app/database/sets
mkdir -p "${CV_MODEL_DIR:-/app/database/models}" "${CLIENT_SCAN_DIR:-/app/database/models/client-scan}"
if [ "$(stat -c %U /app/database)" != "node" ]; then
  echo "entrypoint: taking ownership of /app/database for node user..."
  chown -R node:node /app/database
fi

# ---------------------------------------------------------------------------
# ON-DEVICE SCANNER ASSETS
#
# The scanner needs ~85 MB of models plus an index built from THIS instance's
# own card_cache. None of it can ship in the image: the models are large and
# externally hosted, and the index is per-installation data.
#
# WITHOUT THIS STEP the scanner is dead on arrival -- /scan-assets/manifest.json
# 404s, the browser loads no models, and every frame silently falls back to the
# server. There is no error message that says so; it just feels slow and never
# improves. That is precisely how this shipped to dev and cost a debugging
# round, so it runs here rather than living in someone's deploy notes.
#
# IDEMPOTENT AND NON-FATAL. Each script skips work that is already done (the
# models are content-hashed, the index is rebuilt only when card_cache has
# changed), so a restart costs seconds. And a failure here must NEVER stop the
# app booting: no network on first start is a temporary problem, and an app
# that refuses to start because a model download failed is worse than one whose
# scanner falls back to the server until the next restart.
#
# DB_PATH MUST REACH THIS SCRIPT. build-scan-index.mjs reads it to find the
# card_cache it builds the title/printing index FROM, and exits with "DB_PATH
# must point at a real database (got: unset)" without it -- verified by running
# it both ways on dev. The models still download when it fails, so
# /scan-assets/ would serve a manifest and three of four files: a half-built
# asset directory, which is worse than none because it looks present.
#
# Plain `gosu node` is correct here. gosu execs directly and PRESERVES the
# environment (that is its documented difference from su), so the Dockerfile's
# `ENV DB_PATH=...` is inherited. Do not "fix" this by adding -E: gosu has no
# such flag and would parse it as the user-spec, failing every container start.
if [ "${SCAN_ASSETS_ON_BOOT:-1}" = "1" ]; then
  echo "entrypoint: preparing on-device scanner assets..."
  gosu node sh -c 'cd /app/backend && node scripts/build-scan-assets.mjs "${CLIENT_SCAN_DIR:-/app/database/models/client-scan}"' \
    || echo "entrypoint: WARNING scanner assets not ready; the scanner will use the server path until the next restart"
fi

exec gosu node "$@"
