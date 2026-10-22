#!/bin/sh
set -eu
# Railway mounts volumes as root. Only prepare the directories this app owns.
mkdir -p /data /data/assets
chown node:node /data /data/assets

# Continuous SQLite replication to R2 when LITESTREAM_* are set. An empty
# volume (new host, disaster recovery) restores the latest replica first.
# Litestream covers the database only; image bytes and the full bundle stay
# with the hourly BACKUP_* job. Never run two of these against one volume:
# two Litestream processes corrupt the replica.
if [ -n "${LITESTREAM_ACCESS_KEY_ID:-}" ]; then
  if [ ! -f "$DATABASE_PATH" ]; then
    echo "No local database; restoring from backup if one exists…" >&2
    gosu node litestream restore -config /etc/litestream.yml -if-replica-exists "$DATABASE_PATH"
  fi
  gosu node node dist-ops/check-production.js
  exec gosu node litestream replicate -config /etc/litestream.yml -exec "node dist-server/main.js"
fi

echo "WARNING: continuous backups are NOT configured (LITESTREAM_* unset)." >&2
gosu node node dist-ops/check-production.js
exec gosu node node dist-server/main.js
