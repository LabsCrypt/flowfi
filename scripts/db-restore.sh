#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
: "${DATABASE_URL:?DATABASE_URL must point to the empty PostgreSQL database to restore}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be a 32-byte hex key}"

backup_file="${1:-${BACKUP_FILE:-}}"
: "${backup_file:?Pass the encrypted .tar.gz.enc backup path as an argument or set BACKUP_FILE}"
[[ -f "$backup_file" ]] || { echo "Backup file does not exist: $backup_file" >&2; exit 1; }
command -v psql >/dev/null || { echo "psql is required" >&2; exit 1; }
command -v tar >/dev/null || { echo "tar is required" >&2; exit 1; }
command -v gzip >/dev/null || { echo "gzip is required" >&2; exit 1; }

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT
chmod 700 "$work_dir"
node "$SCRIPT_DIR/pg-service.mjs" "$work_dir/pg_service.conf"
export PGSERVICEFILE="$work_dir/pg_service.conf"
export PGSERVICE=flowfi_backup
unset DATABASE_URL

# Authentication is checked before any SQL is sent to PostgreSQL.
node "$SCRIPT_DIR/backup-crypto.mjs" decrypt < "$backup_file" > "$work_dir/payload.tar.gz"
gzip -t "$work_dir/payload.tar.gz"
tar -xzf "$work_dir/payload.tar.gz" -C "$work_dir"
[[ -s "$work_dir/database.sql" && -f "$work_dir/manifest.tsv" ]] || {
  echo "Backup archive is missing its dump or integrity manifest" >&2
  exit 1
}

psql -X -v ON_ERROR_STOP=1 -f "$work_dir/database.sql"

while IFS=$'\t' read -r table expected; do
  [[ -n "$table" ]] || continue
  actual="$(psql -XAt -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM $table")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'Row count mismatch for %s: backup=%s restored=%s\n' "$table" "$expected" "$actual" >&2
    exit 1
  fi
done < "$work_dir/manifest.tsv"
echo "Restore completed and all recorded public table row counts matched."