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

# Prisma DATABASE_URL values may contain ?schema=..., which Prisma accepts but
# PostgreSQL's native CLI tools reject. Keep the application URL untouched and
# normalize only the URL passed to psql/pg_dump/pg_restore.
normalize_pg_cli_url() {
  node - "$1" <<'NODE'
const value = process.argv[2];
const url = new URL(value);
url.searchParams.delete('schema');
process.stdout.write(url.toString());
NODE
}

PG_CLI_URL="$(normalize_pg_cli_url "$DATABASE_URL")"
PG_ADMIN_CLI_URL="$(normalize_pg_cli_url "$PG_ADMIN_URL")"

# ── client/server major-version agreement ────────────────────────────────────
# A pg_dump NEWER than the server emits GUCs the server has never heard of. PG17
# clients write `SET transaction_timeout = 0` into the archive, and restoring
# that archive into a PG16 server dies with
#   pg_restore: error: unrecognized configuration parameter "transaction_timeout"
# which says nothing about the backup's integrity — it is a tooling mismatch and
# it fails the drill for the wrong reason. Pick the installed client whose major
# version matches the server, and never one that is newer than the server.
pick_pg_bin() {
  local tool="$1"
  local server_num
  server_num="$(psql "$PG_ADMIN_CLI_URL" -tAc 'SHOW server_version_num' 2>/dev/null | tr -d '[:space:]')"
  if [[ ! "$server_num" =~ ^[0-9]+$ ]]; then
    command -v "$tool"
    return 0
  fi
  local server_major=$((server_num / 10000))
  local candidate
  for candidate in $(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -rV); do
    local major
    major="$(basename "$(dirname "$candidate")")"
    [[ "$major" =~ ^[0-9]+$ ]] || continue
    (( major <= server_major )) || continue
    if [[ -x "$candidate/$tool" ]]; then
      printf '%s\n' "$candidate/$tool"
      return 0
    fi
  done
  command -v "$tool"
}

PG_DUMP_BIN="$(pick_pg_bin pg_dump)"
PG_RESTORE_BIN="$(pick_pg_bin pg_restore)"
printf '[recovery-drill] clients: %s / %s (server %s)\n' \
  "$("$PG_DUMP_BIN" --version)" "$("$PG_RESTORE_BIN" --version)" \
  "$(psql "$PG_ADMIN_CLI_URL" -tAc 'SHOW server_version' 2>/dev/null | tr -d '[:space:]')"

cleanup() {
  set +e
  psql "$PG_CLI_URL" -v ON_ERROR_STOP=1 -c 'DROP SCHEMA IF EXISTS backup_drill CASCADE;' >/dev/null 2>&1
  psql "$PG_ADMIN_CLI_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DRILL_DB\";" >/dev/null 2>&1
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
psql "$PG_CLI_URL" -v ON_ERROR_STOP=1 <<'SQL'
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
"$PG_DUMP_BIN" \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$BACKUP_FILE" \
  "$PG_CLI_URL"

printf '[recovery-drill] validating archive\n'
"$PG_RESTORE_BIN" --list "$BACKUP_FILE" >/dev/null

printf '[recovery-drill] creating disposable restore database %s\n' "$DRILL_DB"
psql "$PG_ADMIN_CLI_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DRILL_DB\";"

RESTORE_URL="$(node - "$PG_ADMIN_CLI_URL" "$DRILL_DB" <<'NODE'
const base = new URL(process.argv[2]);
const db = process.argv[3];
base.pathname = `/${db}`;
process.stdout.write(base.toString());
NODE
)"

printf '[recovery-drill] restoring archive\n'
# Attempt 1: the native custom-format restore.
if ! "$PG_RESTORE_BIN" --exit-on-error --no-owner --no-acl \
      --dbname="$RESTORE_URL" "$BACKUP_FILE" >"$WORK_DIR/restore.log" 2>&1; then
  if grep -q 'unrecognized configuration parameter' "$WORK_DIR/restore.log"; then
    # A newer dump client wrote GUCs this server does not have (PG17 archives
    # carry `SET transaction_timeout = 0`). That is a tool mismatch, not a bad
    # backup, so re-run the SAME archive through a sanitized SQL stream instead
    # of failing the drill for it. Session GUCs fall back to server defaults;
    # everything the drill actually proves (full schema, sentinel row, inventory)
    # is still restored and re-verified below.
    printf '[recovery-drill] client/server GUC mismatch — restoring through a sanitized stream\n'
    psql "$PG_ADMIN_CLI_URL" -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$DRILL_DB\";" \
      -c "CREATE DATABASE \"$DRILL_DB\";"
    "$PG_RESTORE_BIN" --no-owner --no-acl --file=- "$BACKUP_FILE" 2>/dev/null \
      | sed -E '/^SET [A-Za-z_]+ = /d' \
      | psql "$RESTORE_URL" -v ON_ERROR_STOP=1 >/dev/null
  else
    cat "$WORK_DIR/restore.log" >&2
    exit 1
  fi
fi

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
