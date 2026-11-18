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

# ── PostgreSQL client selection ─────────────────────────────────────────────
# The drill must talk to the server with a client of the SAME major version. A
# newer pg_dump writes SET statements the server rejects (a PG17 client emits
# `SET transaction_timeout = 0;` and a PG16 server has no such GUC), which fails
# the drill for a tooling reason instead of a backup defect.
#
# ONE ladder, least-invasive option first:
#   1. the client binaries INSIDE the postgres service container: exact parity
#      by construction, and nothing in the archive has to be rewritten.
#   2. an installed host client whose major is <= the server's major.
#   3. the host client on PATH, plus ONE sanitized-stream retry, allowed ONLY for
#      the recognised `unrecognized configuration parameter` mismatch.
# CI with the service container takes (1); a local run without docker takes (2)
# or (3). Measured in CI on 2026-11-07: host client 18.6 against server 16.15,
# which is exactly why (1) exists and why (3) is a fallback and not the norm.
PG_CLIENT_CONTAINER="${PG_CLIENT_CONTAINER:-}"
if [[ -z "$PG_CLIENT_CONTAINER" ]] && command -v docker >/dev/null 2>&1; then
  PG_CLIENT_CONTAINER="$(docker ps --filter "ancestor=${PG_SERVICE_IMAGE:-postgres:16}" --format '{{ .ID }}' 2>/dev/null | head -1)"
fi

pick_pg_bin() {
  local tool="$1"
  local server_num
  server_num="$(psql "$PG_ADMIN_CLI_URL" -tAc 'SHOW server_version_num' 2>/dev/null | tr -d '[:space:]')"
  if [[ ! "$server_num" =~ ^[0-9]+$ ]]; then
    command -v "$tool"
    return 0
  fi
  local server_major=$((server_num / 10000))
  local candidate major
  for candidate in $(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -rV); do
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

SERVER_VERSION="$(psql "$PG_ADMIN_CLI_URL" -tAc 'SHOW server_version' 2>/dev/null | tr -d '[:space:]')"
if [[ -n "$PG_CLIENT_CONTAINER" ]]; then
  PG_CLIENT_MODE=container
  ARCHIVE_REF="/tmp/azm-drill-$$.dump"
  printf '[recovery-drill] clients: inside container %s (server %s)\n' "$PG_CLIENT_CONTAINER" "$SERVER_VERSION"
else
  PG_CLIENT_MODE=host
  # Overridable for the drill's own failure-path tests; never set in CI.
  PG_DUMP_BIN="${PG_DUMP_BIN:-$(pick_pg_bin pg_dump)}"
  PG_RESTORE_BIN="${PG_RESTORE_BIN:-$(pick_pg_bin pg_restore)}"
  printf '[recovery-drill] clients: %s / %s (server %s)\n' \
    "$("$PG_DUMP_BIN" --version)" "$("$PG_RESTORE_BIN" --version)" "$SERVER_VERSION"
fi

drill_dump() {
  if [[ "$PG_CLIENT_MODE" == container ]]; then
    docker exec "$PG_CLIENT_CONTAINER" pg_dump \
      --format=custom --no-owner --no-acl "$PG_CLI_URL" > "$BACKUP_FILE"
    docker cp "$BACKUP_FILE" "$PG_CLIENT_CONTAINER:$ARCHIVE_REF" >/dev/null
  else
    "$PG_DUMP_BIN" --format=custom --no-owner --no-acl --file="$BACKUP_FILE" "$PG_CLI_URL"
  fi
}

drill_archive_list() {
  if [[ "$PG_CLIENT_MODE" == container ]]; then
    docker exec "$PG_CLIENT_CONTAINER" pg_restore --list "$ARCHIVE_REF" >/dev/null
  else
    "$PG_RESTORE_BIN" --list "$BACKUP_FILE" >/dev/null
  fi
}

drill_restore_native() {
  if [[ "$PG_CLIENT_MODE" == container ]]; then
    docker exec "$PG_CLIENT_CONTAINER" pg_restore \
      --exit-on-error --no-owner --no-acl --dbname="$RESTORE_URL" "$ARCHIVE_REF"
    docker exec "$PG_CLIENT_CONTAINER" rm -f "$ARCHIVE_REF" >/dev/null 2>&1 || true
  else
    "$PG_RESTORE_BIN" --exit-on-error --no-owner --no-acl --dbname="$RESTORE_URL" "$BACKUP_FILE"
  fi
}

drill_restore_sanitized() {
  if [[ "$PG_CLIENT_MODE" == container ]]; then
    docker exec "$PG_CLIENT_CONTAINER" pg_restore --no-owner --no-acl --file=- "$ARCHIVE_REF" 2>/dev/null \
      | sed -E '/^SET [A-Za-z_]+ = /d' \
      | psql "$RESTORE_URL" -v ON_ERROR_STOP=1 >/dev/null
  else
    "$PG_RESTORE_BIN" --no-owner --no-acl --file=- "$BACKUP_FILE" 2>/dev/null \
      | sed -E '/^SET [A-Za-z_]+ = /d' \
      | psql "$RESTORE_URL" -v ON_ERROR_STOP=1 >/dev/null
  fi
}

# ── schema inventory ────────────────────────────────────────────────────────
# Every non-system relation the source database holds, one per line, tagged with
# its relation kind. Captured before the backup and compared after the restore:
# a `table_count < 1` check proves almost nothing, because a restore that lands
# one table has "succeeded" by that measure. Any relation the source had and the
# restore lacks fails the drill.
relation_inventory() {
  psql "$1" -v ON_ERROR_STOP=1 -tA <<'SQL'
SELECT c.relkind::text || ' ' || n.nspname || '.' || c.relname
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_temp%'
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY 1;
SQL
}

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
# Source inventory BEFORE the backup, so the restore can be compared to it.
relation_inventory "$PG_CLI_URL" > "$WORK_DIR/source_inventory.txt"
if [[ ! -s "$WORK_DIR/source_inventory.txt" ]]; then
  echo '[recovery-drill] FAILED: source inventory is empty, nothing to prove' >&2
  exit 1
fi
printf '[recovery-drill] source schema inventory: %s relations\n' "$(wc -l < "$WORK_DIR/source_inventory.txt" | tr -d '[:space:]')"

printf '[recovery-drill] creating custom-format logical backup\n'
drill_dump

printf '[recovery-drill] validating archive\n'
drill_archive_list

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
if ! drill_restore_native >"$WORK_DIR/restore.log" 2>&1; then
  if grep -q 'unrecognized configuration parameter' "$WORK_DIR/restore.log"; then
    # A newer dump client wrote a GUC this server does not have. That is a tool
    # mismatch, not a bad backup, so the SAME archive is replayed through a
    # sanitized SQL stream. Only this one recognised error is tolerated: any
    # other failure, and any failure of the sanitized replay itself, exits
    # non-zero below. Session GUCs fall back to server defaults; the full schema,
    # the sentinel row and the inventory comparison are still verified afterwards.
    printf '[recovery-drill] client/server GUC mismatch — replaying through a sanitized stream\n'
    psql "$PG_ADMIN_CLI_URL" -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$DRILL_DB\";" \
      -c "CREATE DATABASE \"$DRILL_DB\";"
    if ! drill_restore_sanitized >>"$WORK_DIR/restore.log" 2>&1; then
      echo '[recovery-drill] FAILED: sanitized replay did not complete' >&2
      cat "$WORK_DIR/restore.log" >&2
      exit 1
    fi
  else
    echo '[recovery-drill] FAILED: restore failed for a reason other than the recognised GUC mismatch' >&2
    cat "$WORK_DIR/restore.log" >&2
    exit 1
  fi
fi

# The inventory comparison: every relation the source had must be present, with
# the same kind. This is what proves the complete schema was restored rather
# than a single table.
relation_inventory "$RESTORE_URL" > "$WORK_DIR/restored_inventory.txt"
if ! diff -u "$WORK_DIR/source_inventory.txt" "$WORK_DIR/restored_inventory.txt" > "$WORK_DIR/inventory.diff"; then
  echo '[recovery-drill] FAILED: restored schema inventory differs from the source inventory' >&2
  sed -E 's/^/  /' "$WORK_DIR/inventory.diff" >&2
  exit 1
fi
printf '[recovery-drill] restored schema inventory matches the source exactly (%s relations)\n' \
  "$(wc -l < "$WORK_DIR/restored_inventory.txt" | tr -d '[:space:]')"

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
