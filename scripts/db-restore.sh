#!/usr/bin/env bash
# Restore an encrypted FlowFi backup (produced by scripts/db-backup.sh) into a
# PostgreSQL database. See docs/DISASTER_RECOVERY.md for the full runbook.
#
# Usage:
#   bash scripts/db-restore.sh [options] <backup.tar.gz.enc>
#
# Options:
#   --dry-run       Decrypt and validate the backup, inspect the target database
#                   and report what would happen. Nothing is written.
#   --force         Allow restoring over a NON-EMPTY database. All user schemas
#                   in the target are dropped and replaced by the backup. A
#                   pre-restore snapshot is taken first (see --snapshot-dir).
#   --yes           Skip the interactive confirmation that --force requires.
#                   Needed when --force is used without a TTY (e.g. in CI).
#   --snapshot-dir  Directory for the pre-restore snapshot
#                   (default: $RESTORE_SNAPSHOT_DIR or ./restore-snapshots).
#   -h, --help      Show this help.
#
# Safety guarantees:
#   * A non-empty target database is refused unless --force is given.
#   * The schema wipe (with --force), the SQL restore and the row-count
#     verification all run inside ONE transaction (psql --single-transaction).
#     If any step fails, PostgreSQL rolls everything back and the target is
#     left exactly as it was before the script ran.
#
# Exit codes:
#   0 success (or dry-run completed)    2 usage error
#   1 restore/validation failure        3 refused: target database is not empty
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() { sed -n '2,/^set -euo pipefail$/{/^set -euo/d;s/^# \{0,1\}//;p;}' "${BASH_SOURCE[0]}"; }
die() { echo "db-restore: $*" >&2; exit 1; }

dry_run=false
force=false
assume_yes=false
snapshot_dir="${RESTORE_SNAPSHOT_DIR:-./restore-snapshots}"
backup_file="${BACKUP_FILE:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --force) force=true ;;
    --yes|-y) assume_yes=true ;;
    --snapshot-dir)
      [[ $# -ge 2 ]] || { echo "--snapshot-dir requires a path" >&2; exit 2; }
      snapshot_dir="$2"; shift ;;
    --snapshot-dir=*) snapshot_dir="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    --) shift; [[ $# -gt 0 ]] && backup_file="$1"; break ;;
    -*) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
    *) backup_file="$1" ;;
  esac
  shift
done

: "${DATABASE_URL:?DATABASE_URL must point to the PostgreSQL database to restore into}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be a 32-byte hex key}"
[[ -n "$backup_file" ]] || { echo "Pass the encrypted .tar.gz.enc backup path as an argument or set BACKUP_FILE" >&2; exit 2; }
[[ -f "$backup_file" ]] || die "backup file does not exist: $backup_file"
for tool in psql tar gzip node; do
  command -v "$tool" >/dev/null || die "$tool is required"
done
if [[ "$force" == true && "$dry_run" == false ]]; then
  command -v pg_dump >/dev/null || die "pg_dump is required to take the pre-restore snapshot"
fi

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT
chmod 700 "$work_dir"
node "$SCRIPT_DIR/pg-service.mjs" "$work_dir/pg_service.conf"
export PGSERVICEFILE="$work_dir/pg_service.conf"
export PGSERVICE=flowfi_backup
unset DATABASE_URL

# ── 1. Decrypt and validate the backup (no SQL is sent before this passes) ──
node "$SCRIPT_DIR/backup-crypto.mjs" decrypt < "$backup_file" > "$work_dir/payload.tar.gz"
gzip -t "$work_dir/payload.tar.gz"
mkdir "$work_dir/backup"
tar -xzf "$work_dir/payload.tar.gz" -C "$work_dir/backup"
[[ -s "$work_dir/backup/database.sql" && -f "$work_dir/backup/manifest.tsv" ]] || \
  die "backup archive is missing its dump or integrity manifest"

# Validate the manifest strictly: its contents are interpolated into SQL below.
manifest_tables=0
manifest_rows=0
while IFS=$'\t' read -r table expected; do
  [[ -n "$table" ]] || continue
  [[ "$table" =~ ^[A-Za-z0-9_\"]+\.[A-Za-z0-9_\"]+$ && "$expected" =~ ^[0-9]+$ ]] || \
    die "backup manifest contains an invalid entry: $table"
  manifest_tables=$((manifest_tables + 1))
  manifest_rows=$((manifest_rows + expected))
done < "$work_dir/backup/manifest.tsv"

# ── 2. Inspect the target database ──
target="$(psql -XAt -v ON_ERROR_STOP=1 -c "SELECT current_database() || ' on ' || coalesce(inet_server_addr()::text, 'local socket')")"

# User-created objects that would collide with the dump: relations, sequences,
# views, user types and functions outside the system schemas. Objects owned by
# extensions (e.g. plpgsql) are ignored.
existing_objects="$(psql -XAt -v ON_ERROR_STOP=1 <<'SQL'
WITH user_ns AS (
  SELECT oid FROM pg_namespace
  WHERE nspname NOT IN ('pg_catalog', 'information_schema')
    AND nspname NOT LIKE 'pg\_toast%' AND nspname NOT LIKE 'pg\_temp%'
), ext_owned AS (
  SELECT objid FROM pg_depend WHERE deptype = 'e'
)
SELECT
  (SELECT count(*) FROM pg_class c
     WHERE c.relnamespace IN (SELECT oid FROM user_ns)
       AND c.relkind IN ('r','p','v','m','S','f')
       AND c.oid NOT IN (SELECT objid FROM ext_owned))
+ (SELECT count(*) FROM pg_type t
     WHERE t.typnamespace IN (SELECT oid FROM user_ns)
       AND t.typtype IN ('e','d','c') AND t.typrelid = 0
       AND t.oid NOT IN (SELECT objid FROM ext_owned))
+ (SELECT count(*) FROM pg_proc p
     WHERE p.pronamespace IN (SELECT oid FROM user_ns)
       AND p.oid NOT IN (SELECT objid FROM ext_owned));
SQL
)"
[[ "$existing_objects" =~ ^[0-9]+$ ]] || die "could not inspect the target database"

if [[ "$existing_objects" -eq 0 ]]; then
  plan="restore into the empty database"
elif [[ "$force" == true ]]; then
  plan="take a pre-restore snapshot, DROP all user schemas, then restore (--force)"
else
  plan="REFUSE: the database is not empty (re-run with --force to replace it)"
fi

cat <<EOF
Backup:   $backup_file ($manifest_tables tables, $manifest_rows rows recorded)
Target:   $target
Contents: $existing_objects existing user object(s)
Plan:     $plan
EOF

if [[ "$dry_run" == true ]]; then
  echo "Dry run: backup decrypted and validated; no changes were made."
  [[ "$existing_objects" -eq 0 || "$force" == true ]] || exit 3
  exit 0
fi

if [[ "$existing_objects" -ne 0 && "$force" != true ]]; then
  echo "Refusing to restore over a non-empty database. Restore into a freshly" >&2
  echo "provisioned database, or pass --force to replace its contents." >&2
  exit 3
fi

# ── 3. Forced restore: confirm and snapshot the current contents first ──
if [[ "$existing_objects" -ne 0 ]]; then
  if [[ "$assume_yes" != true ]]; then
    [[ -t 0 ]] || die "--force requires interactive confirmation; pass --yes to skip it"
    db_name="${target%% on *}"
    read -r -p "This will DELETE all data in '$db_name'. Type the database name to continue: " reply
    [[ "$reply" == "$db_name" ]] || die "confirmation did not match; aborting without changes"
  fi

  # The snapshot uses the same encrypted format as db-backup.sh, so it can be
  # restored with this script: db-restore.sh --force <snapshot>.
  mkdir -p "$snapshot_dir"
  snap="$work_dir/snapshot"
  mkdir "$snap"
  psql -XAt -v ON_ERROR_STOP=1 \
    -c "SELECT quote_ident(schemaname) || '.' || quote_ident(tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename" \
    > "$snap/tables.txt"
  : > "$snap/manifest.tsv"
  while IFS= read -r table; do
    [[ -n "$table" ]] || continue
    count="$(psql -XAt -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM $table")"
    printf '%s\t%s\n' "$table" "$count" >> "$snap/manifest.tsv"
  done < "$snap/tables.txt"
  pg_dump --no-owner --no-acl --format=plain > "$snap/database.sql"
  snapshot_file="${snapshot_dir%/}/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz.enc"
  tar -C "$snap" -cf - database.sql manifest.tsv | gzip -c | \
    node "$SCRIPT_DIR/backup-crypto.mjs" encrypt > "$snapshot_file"
  echo "Pre-restore snapshot written: $snapshot_file"
fi

# ── 4. Restore + verify in a single transaction ──
plan_sql="$work_dir/restore.sql"
{
  echo '\set ON_ERROR_STOP on'
  if [[ "$existing_objects" -ne 0 ]]; then
    # Drop every user schema (and everything in it), then recreate an empty
    # public schema for the dump to populate.
    cat <<'SQL'
DO $wipe$
DECLARE s text;
BEGIN
  FOR s IN
    SELECT nspname FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema')
      AND nspname NOT LIKE 'pg\_%'
  LOOP
    EXECUTE format('DROP SCHEMA %I CASCADE', s);
  END LOOP;
  CREATE SCHEMA public;
END
$wipe$;
SQL
  fi
  printf '\\i %s\n' "$work_dir/backup/database.sql"
  # Row-count checks run inside the transaction, so a mismatch rolls back the
  # whole restore instead of leaving unverified data behind.
  while IFS=$'\t' read -r table expected; do
    [[ -n "$table" ]] || continue
    cat <<SQL
DO \$verify\$
DECLARE actual bigint;
BEGIN
  SELECT count(*) INTO actual FROM $table;
  IF actual <> $expected THEN
    RAISE EXCEPTION 'Row count mismatch for %: backup=% restored=%', '$table', $expected, actual;
  END IF;
END
\$verify\$;
SQL
  done < "$work_dir/backup/manifest.tsv"
} > "$plan_sql"

if ! psql -X --single-transaction -v ON_ERROR_STOP=1 -q -f "$plan_sql" > "$work_dir/psql.log" 2>&1; then
  cat "$work_dir/psql.log" >&2
  echo "Restore FAILED and was rolled back: the target database is unchanged." >&2
  [[ -n "${snapshot_file:-}" ]] && echo "A pre-restore snapshot is also available: $snapshot_file" >&2
  exit 1
fi
echo "Restore completed and all $manifest_tables recorded public table row counts matched."
