#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
: "${DATABASE_URL:?DATABASE_URL must point to the PostgreSQL database to back up}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be a 32-byte hex key}"
: "${BACKUP_S3_URI:?Set BACKUP_S3_URI to an s3://bucket/prefix destination}"


if [[ ! "$BACKUP_S3_URI" =~ ^s3://[^/]+(/[^/]*)?$ ]]; then
  echo "BACKUP_S3_URI must be an s3://bucket/optional-prefix URI" >&2
  exit 2
fi
command -v pg_dump >/dev/null || { echo "pg_dump is required" >&2; exit 1; }
command -v psql >/dev/null || { echo "psql is required" >&2; exit 1; }
command -v aws >/dev/null || { echo "AWS CLI is required" >&2; exit 1; }

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT
chmod 700 "$work_dir"
node "$SCRIPT_DIR/pg-service.mjs" "$work_dir/pg_service.conf"
export PGSERVICEFILE="$work_dir/pg_service.conf"
export PGSERVICE=flowfi_backup
unset DATABASE_URL

# Record exact pre-backup row counts so a recovery can validate every public table.
psql -XAt -v ON_ERROR_STOP=1 \
  -c "SELECT quote_ident(schemaname) || '.' || quote_ident(tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename" \
  > "$work_dir/tables.txt"
: > "$work_dir/manifest.tsv"
while IFS= read -r table; do
  [[ -n "$table" ]] || continue
  count="$(psql -XAt -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM $table")"
  printf '%s\t%s\n' "$table" "$count" >> "$work_dir/manifest.tsv"
done < "$work_dir/tables.txt"

pg_dump --no-owner --no-acl --format=plain > "$work_dir/database.sql"
archive="$work_dir/flowfi.tar.gz.enc"
tar -C "$work_dir" -cf - database.sql manifest.tsv | gzip -c | \
  node "$SCRIPT_DIR/backup-crypto.mjs" encrypt > "$archive"

filename="flowfi-$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_RUN_ID:-$$}.tar.gz.enc"
destination="${BACKUP_S3_URI%/}/$filename"
aws s3 cp "$archive" "$destination" \
  --only-show-errors \
  --tagging 'flowfi-backup-retention=30d' \
  --content-type application/octet-stream
printf 'Encrypted backup uploaded: %s\n' "$destination"