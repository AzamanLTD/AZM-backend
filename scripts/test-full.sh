#!/usr/bin/env bash
# §WP-H §8 — the complete backend suite against a disposable, reproducible stack.
#
# What this does, in order (the same order the approved release path uses):
#   1. brings up PostgreSQL 15 and Redis in Docker (disposable, no host state);
#   2. creates the databases the suites need;
#   3. bootstraps the greenfield baseline exactly as CI does (prisma db push);
#   4. runs the REAL release chain (`npm run release` — every installer in
#      package.json order) under the release target guard, which refuses any
#      target that is not explicitly declared disposable;
#   5. runs the full jest suite serially (--runInBand is the CI contract);
#   6. tears the stack down, always.
#
# It deliberately does NOT replace the release chain with db push: db push only
# establishes the greenfield baseline; every convergence installer still runs.
set -euo pipefail

cd "$(dirname "$0")/.."

PG_PORT="${AZM_TEST_PG_PORT:-55432}"
REDIS_PORT="${AZM_TEST_REDIS_PORT:-56379}"
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/azm_test?schema=public"
SAVED_ACCOUNTS_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/azm_saved_service_accounts_test?schema=public"

compose() { docker compose "$@"; }

cleanup() {
  echo "[test-full] tearing down"
  compose --profile tls --profile api down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[test-full] starting postgres and redis"
if [ "${AZM_TEST_REDIS_TLS:-0}" = "1" ]; then
  compose --profile tls up -d postgres redis-tls
else
  compose up -d postgres redis
fi

echo "[test-full] waiting for postgres"
for i in $(seq 1 60); do
  if compose exec -T postgres pg_isready -U postgres -d azm_test >/dev/null 2>&1; then break; fi
  if [ "$i" = "60" ]; then echo "[test-full] postgres did not become ready" >&2; exit 1; fi
  sleep 1
done

echo "[test-full] creating databases"
if ! compose exec -T postgres psql -U postgres -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='azm_saved_service_accounts_test'" | grep -q 1; then
  compose exec -T postgres createdb -U postgres azm_saved_service_accounts_test
fi

export DATABASE_URL TEST_DATABASE_URL="$DATABASE_URL"
export SAVED_ACCOUNTS_TEST_DATABASE_URL="$SAVED_ACCOUNTS_URL"
export AZM_RELEASE_TARGET_POLICY=disposable-postgres
export NODE_ENV=test

echo "[test-full] bootstrapping greenfield baseline (CI-identical)"
npx prisma db push --accept-data-loss

echo "[test-full] running the release chain (installers in package.json order)"
npm run release

echo "[test-full] running the full suite (serial)"
npm test

echo "[test-full] PASS"
