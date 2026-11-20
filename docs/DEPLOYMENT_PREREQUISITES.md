# Deployment prerequisites and environment contract

This is the contract a deployment must satisfy before the service is considered
ready. It is the same contract `make test-full` exercises locally.

## Runtime

- **Node.js 24.x** (`package.json` engines, `.nvmrc`). The Docker image pins
  `node:24-bookworm-slim`.
- **PostgreSQL 15** major. Production is a managed Neon branch; the test stack
  runs `postgres:15` in Docker.
- **Redis** optional. When `REDIS_REQUIRED=1`, readiness is gated by it.

## Required environment

| variable | required | contract |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://` URL. The release chain refuses a target it cannot identify unless `AZM_RELEASE_TARGET_POLICY` declares it disposable. |
| `NODE_ENV` | yes | `production` in production. |
| `PORT` | no | Defaults to the platform value; the image exposes 10000. |
| `ENCRYPTION_KEY` | production | 32-byte key (64 hex or 44-char base64). Field-level AES-256-GCM for KYC identifiers and standalone payment-request share tokens. Without it, KYC refuses and LINK requests return 503. |
| `PUBLIC_APP_URL` | production | Canonical https **origin only** (no path/query/fragment) used to mint share URLs. Never derived from the Host header. |
| `CORS_ORIGINS` | production | Exact deployed origins; never a wildcard in production. |
| `REDIS_URL` | no | Connection string for the shared Redis layer. TLS is decided by the shared policy, not by sniffing the scheme. |
| `REDIS_REQUIRED` | no | `1` makes `/readyz` fail when Redis is unreachable. Unset means a Redis outage degrades features but does not remove the fleet. |
| `STEP_UP_ENFORCEMENT` | no | `off` unless action-bound step-up is being rolled out. Gates are no-ops while off. |
| `AZM_RELEASE_TARGET_POLICY` | release only | `disposable-postgres` on a disposable test target. Production runs the approved release path. |
| `RENDER`, `RENDER_SERVICE_ID`, `RENDER_GIT_BRANCH`, `RENDER_GIT_COMMIT` | platform | **Identity signals, not authorization.** The release chain requires a signed deployment authorization; a forged environment tuple is refused (proved in `__tests__/release-target-guard-adversarial.test.js`). |

## Database identities (separate privileges)

| identity | privileges | used by |
|---|---|---|
| migration / overlay | DDL on the schema | the approved release chain only (`npm run release`) |
| application runtime | no unrestricted DDL | the API process |
| provider reconciler | minimal read + witness insert | reconciliation workers |
| operator activation | `EXECUTE` on the activation function only | the operator activation path |

The runtime identity must never be able to `SET ROLE` to the owner of the
authority table, write the activation record, or invoke the activation function.
`src/services/authorityActivationEnforcement.js` proves this at runtime from the
PostgreSQL catalogs and returns UNKNOWN when it cannot.

## Health endpoints

- `GET /healthz` — liveness. No dependencies. 200 while the process runs.
- `GET /readyz` — readiness. 200 only when the database answers; Redis is
  reported and gates readiness only when `REDIS_REQUIRED=1`.
- `GET /health` — legacy aggregate (version gate, stats). Kept for clients.

## Reproducible test stack

```bash
make test-full        # postgres + redis, release chain, full suite
make test-full-tls    # adds the TLS-only Redis listener
make docker-build     # builds the multi-stage API image
```

`make test-full` boots disposable services, bootstraps the greenfield baseline
exactly as CI does, runs the **real** release chain (every installer, in
`package.json` order) under the release target guard, runs the full suite
serially, and tears everything down. It does not replace the release chain with
`prisma db push`; db push only establishes the greenfield baseline.
