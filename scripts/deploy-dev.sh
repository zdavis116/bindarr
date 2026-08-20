#!/usr/bin/env bash
# Bindarr dev deploy. Runs ON the bindarr LXC, not over SSH from elsewhere.
#
# WHY THIS EXISTS
# Deploys were driven over Tailscale SSH from a remote session. Tailscale SSH
# re-auth expired four times in one day, and each time the deploy died at the
# connection with no output -- which looked identical to "still running". Twice
# that led to reporting a deploy as live when the box was still on the old
# commit.
#
# Running the deploy locally removes the SSH session from the critical path: a
# dropped connection can no longer leave a half-finished deploy, and the script
# can be run by hand when nobody is around to babysit it.
#
# USAGE
#   /opt/bindarr-dev/deploy.sh              # deploy origin/main
#   /opt/bindarr-dev/deploy.sh <ref>        # deploy a specific ref
#
# It is deliberately noisy and deliberately fails loudly.

set -euo pipefail

REPO=/opt/bindarr-dev
SERVICE=bindarr-dev.service
RUN_USER=bindarr-dev
NODE_BIN=/opt/node20/bin
REF="${1:-origin/main}"

export PATH="$NODE_BIN:$PATH"

say() { printf '\n=== %s ===\n' "$*"; }
die() { printf '\nDEPLOY FAILED: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "node not on PATH (expected $NODE_BIN)"
command -v git  >/dev/null || die "git not on PATH"
[ -d "$REPO/.git" ]        || die "$REPO is not a git checkout"

cd "$REPO"

BEFORE="$(git rev-parse --short HEAD)"
say "before: $BEFORE  $(git log -1 --format=%s)"

say "fetching"
git fetch -q origin || die "git fetch failed"
git reset --hard -q "$REF" || die "git reset to $REF failed"

TARGET="$(git rev-parse --short HEAD)"
say "target: $TARGET  $(git log -1 --format=%s)"

# Only reinstall backend deps when they actually changed. npm ci plus the
# sqlite3 source rebuild is the slow part of a deploy, and reinstalling it for a
# frontend-only change wastes several minutes for no benefit.
if [ "$BEFORE" != "$TARGET" ] && ! git diff --quiet "$BEFORE" "$TARGET" -- backend/package-lock.json backend/package.json; then
  say "backend deps changed -- reinstalling"
  ( cd backend && npm ci --onnxruntime-node-install=skip ) || die "backend npm ci failed"
  ( cd backend && npm rebuild sqlite3 --build-from-source ) || die "sqlite3 rebuild failed"
else
  say "backend deps unchanged -- skipping npm ci"
fi

if [ "$BEFORE" != "$TARGET" ] && ! git diff --quiet "$BEFORE" "$TARGET" -- frontend/package-lock.json frontend/package.json; then
  say "frontend deps changed -- reinstalling"
  ( cd frontend && npm ci ) || die "frontend npm ci failed"
else
  say "frontend deps unchanged -- skipping npm ci"
fi

say "building frontend"
( cd frontend && npm run build ) || die "frontend build failed"

chown -R "$RUN_USER:$RUN_USER" "$REPO"

say "restarting $SERVICE"
systemctl restart "$SERVICE" || die "systemctl restart failed"

# Give the service time to bind its port and run startup migrations before
# asserting anything about it. A restart returning 0 only means systemd accepted
# the request.
sleep 15

# VERIFY BY OBSERVATION, NOT INFERENCE.
# Every check below reads actual state. "The command exited 0" is not evidence
# that the deploy landed -- that assumption is exactly what let silent failures
# be reported as successes.
say "VERIFY"

RUNNING="$(git rev-parse --short HEAD)"
echo "running commit : $RUNNING  $(git log -1 --format=%s)"
[ "$RUNNING" = "$TARGET" ] || die "HEAD is $RUNNING, expected $TARGET"

ACTIVE="$(systemctl is-active "$SERVICE" || true)"
echo "dev service    : $ACTIVE"
[ "$ACTIVE" = "active" ] || die "$SERVICE is $ACTIVE"

# Production lives on a DIFFERENT machine now (the bindarr LXC). This check was
# written when dev and prod shared a box, where a dev deploy could plausibly
# disturb prod. On the dedicated dev box bindarr.service does not exist, so
# asserting it is active reported a perfectly good deploy as FAILED - the same
# "tool lies about its own state" defect this project blocks merges over, and
# the fastest way to teach someone to ignore their own alarms.
#
# So: only assert prod health when prod is actually installed here.
if systemctl list-unit-files bindarr.service >/dev/null 2>&1 && \
   systemctl cat bindarr.service >/dev/null 2>&1; then
  PROD="$(systemctl is-active bindarr.service || true)"
  echo "prod service   : $PROD"
  [ "$PROD" = "active" ] || die "production service is $PROD -- it must never be disturbed by a dev deploy"
else
  echo "prod service   : not on this host (production runs on the bindarr LXC)"
fi

CODE="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/ || true)"
echo "dev http       : $CODE"
[ "$CODE" = "200" ] || die "dev instance returned HTTP $CODE"

echo "frontend build : $(date -r frontend/dist/index.html '+%Y-%m-%d %H:%M:%S')"

say "DEPLOY OK -- $RUNNING is live on :3002"
