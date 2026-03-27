#!/usr/bin/env bash
# Auto-deploy script — runs on the Pi via cron every 5 minutes.
# Pulls from origin/main, rebuilds, and restarts the service if there are new commits.

set -euo pipefail

REPO_DIR="/joni/joni-pi"
LOG_FILE="$REPO_DIR/logs/deploy.log"
BRANCH="main"

log() {
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" >> "$LOG_FILE"
}

cd "$REPO_DIR"

# Fetch without merging
git fetch origin "$BRANCH" --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0  # Nothing to do — no log noise
fi

log "New commits detected: $LOCAL -> $REMOTE"

git pull origin "$BRANCH" --ff-only --quiet >> "$LOG_FILE" 2>&1

log "Running npm ci"
npm ci --quiet >> "$LOG_FILE" 2>&1

log "Building"
npm run build --quiet >> "$LOG_FILE" 2>&1

log "Restarting service"
systemctl --user restart nanoclaw >> "$LOG_FILE" 2>&1

log "Deploy complete"
