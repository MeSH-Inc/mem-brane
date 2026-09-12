#!/bin/sh
set -eu
# Railway mounts volumes as root. Only prepare the directories this app owns.
mkdir -p /data /data/assets
chown node:node /data /data/assets
gosu node node dist-ops/check-production.js
exec gosu node node dist-server/main.js
