#!/bin/bash
# hub/deploy-backup.sh runs on trommi-hub (piped over ssh by .github/workflows/deploy.yml) before the hub restarts.
# An online SQLite copy (VACUUM INTO, inside the running hub container: consistent, no stop), gzipped into
# /srv/trommi/backups/hub-<stamp>.db.gz; attachments mirrored incrementally to backups/attachments/.
# Kept: the 7 newest copies, plus the newest copy of each of the last 7 days.
set -euo pipefail
cd /srv/trommi
mkdir -p backups
if [ -f data/hub.db ] && [ -n "$(docker compose ps -q hub 2>/dev/null)" ]; then
  rm -f data/backup-tmp.db
  # The Rust hub's image (hub-rs/Dockerfile) has no node: its binary makes the same VACUUM INTO copy.
  if docker compose exec -T hub /trommi-hub --version >/dev/null 2>&1; then
    docker compose exec -T hub /trommi-hub backup /data/backup-tmp.db
  else
    docker compose exec -T hub node -e "new (require('node:sqlite').DatabaseSync)('/data/hub.db').exec(\"VACUUM INTO '/data/backup-tmp.db'\")"
  fi
  stamp=$(date -u +%Y%m%d-%H%M%S)
  gzip -1 -c data/backup-tmp.db > "backups/hub-$stamp.db.gz.part" && mv "backups/hub-$stamp.db.gz.part" "backups/hub-$stamp.db.gz"
  rm -f data/backup-tmp.db
  if [ -d data/attachments ]; then
    if command -v rsync >/dev/null; then rsync -a --delete data/attachments/ backups/attachments/; else mkdir -p backups/attachments && cp -a -u data/attachments/. backups/attachments/; fi
  fi
  echo "backup: backups/hub-$stamp.db.gz ($(du -h "backups/hub-$stamp.db.gz" | cut -f1))"
else
  echo "backup: no running hub with a hub.db, nothing to copy"
fi
# Retention: 7 newest, plus the newest of each of the last 7 days; older tars of the old scheme go too.
keep=$( { ls -1t backups/hub-*.db.gz 2>/dev/null | head -n 7
          for d in 0 1 2 3 4 5 6; do day=$(date -u -d "-$d day" +%Y%m%d); ls -1t backups/hub-$day-*.db.gz 2>/dev/null | head -n 1; done; } | sort -u )
for f in backups/hub-*.db.gz; do [ -e "$f" ] || continue; echo "$keep" | grep -qx "$f" || rm -f "$f"; done
ls -1t backups/data-*.tgz 2>/dev/null | tail -n +3 | xargs -r rm -f
