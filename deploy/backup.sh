#!/usr/bin/env bash
set -euo pipefail
umask 077
# Run as root. A GitHub backup repository must already be checked out and authenticated.
# Required: BACKUP_REPO=/srv/private-yonote-backup
app_dir=${APP_DIR:-/opt/yonote}
data_dir=${DATA_DIR:-/var/lib/yonote}
backup_repo=${BACKUP_REPO:?Set BACKUP_REPO to a dedicated private Git checkout}
[[ -d "$backup_repo/.git" ]] || { echo 'BACKUP_REPO must be an existing Git checkout'; exit 1; }
exec 9>/run/lock/yonote-backup.lock
flock -n 9 || exit 0
target=$(mktemp -d "$backup_repo/.snapshot.XXXXXX")
trap 'rm -rf -- "$target"' EXIT
# Briefly stop writes so the database and content-addressed files form one consistent set.
was_running=0
if systemctl is-active --quiet yonote; then
  was_running=1
  systemctl stop yonote
fi
restore_service() { if [[ "$was_running" == 1 ]]; then systemctl start yonote; fi; }
trap 'restore_service; rm -rf -- "$target"' EXIT
"$app_dir/yonote" -data "$data_dir" -backup "$target/yonote.db"
cp -a "$data_dir/blobs" "$target/blobs"
restore_service
was_running=0
mkdir -p "$backup_repo/latest"
rsync -a --delete "$target/" "$backup_repo/latest/"
git -C "$backup_repo" add -- latest
if ! git -C "$backup_repo" diff --cached --quiet; then
  git -C "$backup_repo" commit -m "Backup $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git -C "$backup_repo" push
fi
