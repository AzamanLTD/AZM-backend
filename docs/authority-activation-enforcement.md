# Database-enforced authority activation (§WP-E)

The GHS liquidity authority's one-way latch was a code convention, not a
boundary. This document describes the boundary that replaces it: an
append-only activation record owned by a role the application runtime cannot
become, with the runtime's own privileges verified at read time.

**Current status: the mechanism exists and is proved locally. It is NOT
database-enforced in production.** The deployed topology cannot establish the
required role separation without an infrastructure change (see
[Hosting feasibility](#hosting-feasibility)), so the gate stays closed there and
the application reports it closed. No financial behaviour depends on this gate
yet, so nothing else changes. Do not describe the latch as
database-enforced in production until the provisioning below has actually run.

## 1. What was wrong

`FiatLiquidityState.authorityActivatedAt` is a nullable column on a table owned
by the application's own PostgreSQL role.

- The application role owns the table, so it can `UPDATE ... SET "authorityActivatedAt" = NULL`,
  `DELETE` the row, `TRUNCATE` the table, `DROP` it, or grant itself and others
  anything it likes. Ownership defeats revoked privileges.
- Migration `20261107000000_p5d_authority_latch` added only the column: no
  trigger, no CHECK, no ownership or grant separation. The one-way property was
  enforced by `fiatLiquidityActivationService` refusing to write NULL.
- In the earlier disposable database the table owner and the application
  connection role were the same role, so "one-way" held only as long as the
  application chose to honour it.

A code convention is not a security boundary when the same role can rewrite the
state the convention protects.

## 2. What replaces it

`FiatLiquidityAuthorityActivation` — a separate, append-only record:

| Property | Enforcement |
| --- | --- |
| One-time activation | `PRIMARY KEY (id)` plus `CHECK (id = 1)`; a second activation cannot insert, and cannot arrive as `id = 2` |
| Immutable | `BEFORE UPDATE` / `BEFORE DELETE` triggers raise `insufficient_privilege` |
| Undeletable in bulk | `BEFORE TRUNCATE ... FOR EACH STATEMENT` trigger raises |
| Not runtime-writable | Table owned by a dedicated `NOLOGIN` role; runtime role holds `SELECT` only |
| Named control decision | `activatedBy`, `approvedBy`, `evidenceReference`, `evidenceDigest` are all `NOT NULL` and non-blank |

Migration: `prisma/migrations/20261110230000_p5d_enforced_authority_activation/migration.sql`.

The migration deliberately does **not** create roles and does **not** change
ownership: a migration cannot know the deployment's runtime role name, and
guessing it would be worse than refusing. Applied alone it leaves the table with
the migrating role, and the runtime gate reports itself unavailable.

## 3. Role model

| Role | Login | Privileges on the record | Purpose |
| --- | --- | --- | --- |
| `<owner>` (e.g. `azm_authority_owner`) | No | owner, full | Owns the table and the trigger function. No connection can authenticate as it, so the owner cannot be "used" by anyone. |
| `<migrator>` | Yes (deploy-time only) | none after handover | Runs the migration, then hands ownership to `<owner>` |
| `<runtime>` (e.g. `azm_app_runtime`) | Yes | `SELECT` | The application. Cannot insert, update, delete, truncate, create triggers, alter, drop, or `SET ROLE` to the owner. |
| `<operator>` (e.g. `azm_authority_operator`) | Yes, credential held outside the application | `SELECT`, `INSERT` | The separate activation authority. Cannot update or delete what it recorded. Not a member of `<runtime>`, and `<runtime>` is not a member of it. |

Provisioning (a controlled DBA step, never reachable from the application):

```bash
# as a role that may CREATE ROLE and re-own the table
node infra/install-authority-activation-roles.js \
  --owner azm_authority_owner \
  --runtime azm_app_runtime \
  --operator azm_authority_operator
```

It creates missing roles, applies the migration, transfers ownership of the
table and the trigger function to `<owner>`, applies least-privilege grants, and
then **verifies** the boundary, exiting non-zero if any forbidden privilege
survives. It never sets a password: credentials belong to the deployment's
credential authority. `--dry-run` prints what it would do.

## 4. Runtime gate

`src/services/authorityActivationEnforcement.js`:

- `readEnforcedAuthority(db)` → `{ enforcedActive, enforcementEstablished, reason, activation, problems, diagnostics }`
- `assertEnforcedAuthority(db)` → throws `AuthorityEnforcementUnavailable`
  (`code: AUTHORITY_ENFORCEMENT_UNAVAILABLE`, HTTP 503 shape) when the gate is not open.

It asks the catalog what the current role may actually do, every time:

| Observation | Result |
| --- | --- |
| Role is a superuser | closed (`RUNTIME_IS_SUPERUSER`) |
| Role owns the table | closed (`RUNTIME_OWNS_TABLE`) |
| Role is a member of the owner (`pg_has_role ... 'MEMBER'`) | closed (`RUNTIME_CAN_SET_ROLE_TO_OWNER`) |
| Role holds `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`/`TRIGGER` | closed, one problem code per privilege |
| Role lacks `SELECT` | closed (`RUNTIME_CANNOT_READ`) |
| Any of the three triggers missing or not enabled | closed |
| Trigger function owned by the runtime role | closed |
| Table absent | closed (`TABLE_MISSING`) |
| Any probe error, or the record unreadable | closed |
| All checks pass and a record exists | `enforcedActive: true`, `reason: ACTIVE` |
| All checks pass, no record | closed (`NOT_ACTIVATED`) |

Fail-closed means **closed**, never "assume active". The module never reads
`FiatLiquidityState.authorityActivatedAt`, so a legacy timestamp cannot open
this gate — and a pre-existing latch is not copied into the new record. A
timestamp written by an application role is not independent evidence.

`readMode()` (what `SystemFiatPool.balance` MEANS) is unchanged and stays
monotone `flag || latched`. This gate adds a narrower authority; it never widens
what the regime permits, and nothing financial consumes it yet.

Client-facing messages carry no database, role or privilege detail; the codes
live on `AuthorityEnforcementUnavailable.problems` for server-side logging.

## 5. Activation runbook

```bash
AUTHORITY_ACTIVATION_DATABASE_URL="postgresql://azm_authority_operator:...@host/db" \
node scripts/p5d-authority-activate-enforced.js activate \
  --activated-by  "ops:jdoe" \
  --approved-by   "cfo:kmenash" \
  --evidence-reference "TREASURY-RECON-2026-11-003" \
  --evidence-digest  "<sha256 of the reviewed reconciliation pack>"
```

The script refuses unless: the connection is the narrow operator role (not a
superuser, `SELECT`+`INSERT` and no `UPDATE`/`DELETE`/`TRUNCATE`); no record
exists; every option is present and well formed. After inserting, it proves the
record is append-only from that same connection (an `UPDATE` and a `DELETE` are
attempted inside rolled-back transactions and must be refused) and reports
`CRITICAL` if either succeeded.

`AUTHORITY_ACTIVATION_DATABASE_URL` is never read by the application server.

**An activation row is a control decision, not proof of money.** It records who
decided and what they reviewed. It does not prove that customer funds, GHS
assets, treasury receipts or provider settlements exist. Real activation
requires separately verified external evidence and a named approver; a
caller-supplied reference or an application-generated provider event is not
evidence, and the row must never be presented as one.

## 6. Hosting feasibility

Facts from the repository (no production resources were accessed):

- `render.yaml` declares one web service with `preDeployCommand: npm run release`
  and `startCommand: npm start`.
- `npm run release` is a chain of `infra/install-*.js` overlay installers — i.e.
  the DDL/migration authority — and it authenticates with the same
  `DATABASE_URL` the server uses at runtime.
- `prisma/schema.prisma` declares a single `url = env("DATABASE_URL")`; there is
  no `directUrl` and no second connection string in the blueprint.

So the deployed role is simultaneously the migration authority and the runtime.
Ownership separation therefore **cannot** be established from the current
configuration, and the gate reports `RUNTIME_OWNS_TABLE` (or
`RUNTIME_IS_SUPERUSER`) and stays closed. Nothing is weakened to accommodate
that.

Required configuration change (not applied here — it is an infrastructure and
credential decision, and it also requires granting the new runtime role
`SELECT`/DML on every other table it must use):

1. Create the three roles as in §3, with passwords set by the credential
   authority.
2. Point the Render **runtime** `DATABASE_URL` at `<runtime>`.
3. Add a separate migration connection (e.g. `MIGRATION_DATABASE_URL`) used by
   `preDeployCommand` / `npm run release`, and have that chain run
   `infra/install-authority-activation-roles.js` only *after* the DBA has created
   the roles.
4. Keep the operator credential out of Render entirely: activation is performed
   from a controlled workstation or CI job with database access, never from the
   application.

Until steps 1-4 have run against a given database, that database's enforced
authority is **not** database-enforced and the gate stays closed.

## 7. Proof

`__tests__/p5e-enforced-authority-activation.pg.test.js` provisions four real
PostgreSQL roles, applies the migration as the migration role, runs the
installer, and then drives every attempt from the actual role connection. It
fails closed: a missing `TEST_DATABASE_URL` fails in CI, and a principal that
cannot create roles fails the suite with the provisioning requirement instead of
skipping to green.

Covered: runtime `SELECT`; runtime `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`
refused; `ALTER`/`DROP`/`DISABLE TRIGGER`/`OWNER TO` refused; `SET ROLE` to
owner or operator refused; operator activates exactly once; a second activation
cannot replace the first (both as a duplicate `id = 1` and as `id = 2`);
operator cannot `UPDATE`/`DELETE`/`TRUNCATE`; the gate is closed before
activation and active only after; a legacy timestamp leaves it closed; a
superuser connection and a runtime role granted `INSERT` both report closed; a
missing table and a revoked `SELECT` both fail closed.
