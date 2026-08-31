#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL must point at the disposable source database}"
: "${PG_ADMIN_URL:?PG_ADMIN_URL must point at an administrative PostgreSQL connection for the disposable drill database}"

if [[ "${BACKUP_DRILL_ALLOW_MUTATION:-0}" != "1" ]]; then
  echo "Refusing to mutate the source database without BACKUP_DRILL_ALLOW_MUTATION=1" >&2
  exit 2
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/azaman-db-recovery-XXXXXX")"
BACKUP_FILE="${BACKUP_FILE:-$WORK_DIR/backup.dump}"
DRILL_DB="${DRILL_DB:-azm_backup_drill_$$}"
KEEP_BACKUP="${KEEP_BACKUP:-0}"

cleanup() {
  set +e
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'DROP SCHEMA IF EXISTS backup_drill CASCADE;' >/dev/null 2>&1
  psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DRILL_DB\";" >/dev/null 2>&1
  if [[ "$KEEP_BACKUP" != "1" ]]; then
    rm -rf "$WORK_DIR"
  else
    echo "Backup retained at $BACKUP_FILE"
    rmdir "$WORK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "$BACKUP_FILE" != "$WORK_DIR/backup.dump" && -e "$BACKUP_FILE" ]]; then
  echo "Backup target already exists: $BACKUP_FILE" >&2
  exit 3
fi

export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"

printf '[recovery-drill] creating sentinel data in disposable source database\n'
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS backup_drill;
CREATE TABLE backup_drill.sentinel (
  id integer PRIMARY KEY,
  marker text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
TRUNCATE backup_drill.sentinel;
INSERT INTO backup_drill.sentinel (id, marker) VALUES (1, 'azaman-backup-restore-drill');
SQL

printf '[recovery-drill] creating custom-format logical backup\n'
pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$BACKUP_FILE" \
  "$DATABASE_URL"

printf '[recovery-drill] validating archive\n'
pg_restore --list "$BACKUP_FILE" >/dev/null

printf '[recovery-drill] creating disposable restore database %s\n' "$DRILL_DB"
psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DRILL_DB\";"

RESTORE_URL="$(python3 - "$PG_ADMIN_URL" "$DRILL_DB" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit

base, db = sys.argv[1:]
parts = urlsplit(base)
print(urlunsplit((parts.scheme, parts.netloc, '/' + db, parts.query, parts.fragment)))
PY
)"

printf '[recovery-drill] restoring archive\n'
pg_restore \
  --exit-on-error \
  --no-owner \
  --no-acl \
  --dbname="$RESTORE_URL" \
  "$BACKUP_FILE"

printf '[recovery-drill] verifying restored sentinel and schema inventory\n'
psql "$RESTORE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  marker text;
  table_count integer;
BEGIN
  SELECT s.marker INTO marker
  FROM backup_drill.sentinel AS s
  WHERE s.id = 1;

  IF marker IS DISTINCT FROM 'azaman-backup-restore-drill' THEN
    RAISE EXCEPTION 'backup restore sentinel mismatch: %', marker;
  END IF;

  SELECT count(*) INTO table_count
  FROM information_schema.tables
  WHERE table_schema NOT IN ('pg_catalog', 'information_schema');

  IF table_count < 1 THEN
    RAISE EXCEPTION 'restored database contains no application tables';
  END IF;
END $$;
SQL

printf '[recovery-drill] SUCCESS — logical backup restored into disposable database %s\n' "$DRILL_DB"
