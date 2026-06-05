#!/bin/sh
# Ensure the persisted data dir exists and is writable, then run the app.
# On Railway, volumes mount root-owned; this starts as root, fixes ownership,
# and drops to the non-root "node" user (keeping the app non-root).
set -e

# Default DATA_DIR to the Railway volume mount if present, else /app/data.
: "${DATA_DIR:=${RAILWAY_VOLUME_MOUNT_PATH:-/app/data}}"
export DATA_DIR

mkdir -p "$DATA_DIR" 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  if command -v su-exec >/dev/null 2>&1; then
    exec su-exec node "$@"
  fi
fi

exec "$@"
