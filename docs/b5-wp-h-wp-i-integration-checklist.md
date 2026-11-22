# WP-H + WP-I integration checklist (not yet executed)

Nothing is merged into #405 by this document. It is the preparation for the
union of `feat/wp-h-payout-authority-closure`, `wp-i/observation-closure` and the
current #405 history.

## Preconditions before any merge

- [ ] WP-I two-session production-writer race proven on its own head.
- [ ] WP-I repeated-backfill evidence proven on its own head.
- [ ] WP-H head green on its exact SHA (Test Suite + financial-durability).
- [ ] No branch has moved since the evidence was recorded.

## Shared files and planned resolution

| file | both branches touch it | resolution owner |
|---|---|---|
| `package.json` / `package-lock.json` | yes — dependency overrides and Prisma pins | Agent 1, single deliberate resolution |
| `infra/install-fiat-liquidity-overlay.js` | yes — WP-I observation wallet column | Agent 4 owns the WP-I change; Agent 1 merges it unchanged |
| `infra/install-wp-i-observation-wallet-overlay.js` | WP-I only | Agent 4 |
| `scripts/test-full.sh`, `Dockerfile`, `docker-compose.yml` | WP-H only | Agent 1 |
| `scripts/step-up-route-inventory.js`, `docs/b5-*` | WP-H only | Agent 1 |
| `.github/workflows/test.yml` (audit job) | WP-H introduced the strict gate; both branches now need it | Agent 1 |

## Dependency reconciliation (decided, then verified)

- Final target: `@prisma/client` 6.19.2, `prisma` CLI 6.19.2, `@prisma/config`
  6.19.2, `effect` 3.22.1 via the scoped override.
- WP-H pins the Prisma pair exactly at 6.19.2. WP-I resolves the CLI/config to
  6.19.3. The merge must take WP-H's exact pins, not either lockfile wholesale.
- Keep the scoped `@prisma/config` → `effect@3.22.1` override and the strict
  `npm audit --omit=dev --audit-level=low` gate. No advisory exception.

## Installer ordering

Preserve the order in `package.json`'s release chain and in the CI bootstrap.
The WP-I observation wallet overlay runs after the fiat liquidity overlay, which
is what the chain segment 15 registration requires. Do not reorder to resolve a
merge conflict; resolve by keeping both edits in their existing positions.

## Verification of the combined tree

- [ ] `npm ci`
- [ ] `npm ls @prisma/client prisma @prisma/config effect --all`
- [ ] `npm audit --omit=dev --audit-level=low`
- [ ] `npx prisma validate` and `npx prisma generate`
- [ ] Money Core typecheck and tests
- [ ] release-chain installer ordering test
- [ ] WP-H targeted PostgreSQL suites (authority, claim, races, boundary, roles)
- [ ] WP-I targeted suites (observation, reconciliation, backfill)
- [ ] full Test Suite
- [ ] financial-durability
