# RBAC Super Admin Bootstrap — Operational Runbook

This is the controlled, one-time mechanism for designating the **initial
Super Admin** for the admin RBAC system. Ongoing role management is done
through the authenticated HTTP endpoints (see below) once a Super Admin
exists; this CLI exists only to solve the chicken-and-egg problem of a
fresh deployment that has no authoritative Super Admin designation yet.

It is deliberately **not** an HTTP endpoint: there is no unauthenticated or
generally available web backdoor to bootstrap roles.

## Prerequisites

- Operator shell access to an environment that can reach the production
  database.
- The `DATABASE_URL` for the target environment (from your usual secret
  store — the script never logs it).
- The numeric user id of an **existing, active `ADMIN` account** (primary
  `User.role = ADMIN`, not deleted, not banned). The script never infers
  or auto-selects an account: you must pass the explicit id.

## Exact command

```bash
DATABASE_URL="<production database url>" \
  node scripts/bootstrapSuperAdmin.js --user-id <ADMIN_USER_ID> --confirm
```

- `--user-id` — explicit target account id. Required.
- `--confirm` — deliberate confirmation flag. Without it the script prints
  usage and exits without touching the database.

Exit codes: `0` success (or idempotent no-op), `2` bad usage / missing
confirmation, `3` target ineligible (missing / banned / not an ADMIN
account), `4` a Super Admin already exists.

## What it does

1. Takes the same transaction-scoped advisory lock used by the HTTP
   role-management endpoints, so it cannot race an in-flight role change.
2. Verifies the target exists, is not deleted, is not banned, and has
   primary role `ADMIN` — otherwise it refuses and writes nothing.
3. Refuses if **any** active Super Admin designation already exists
   (prevents duplicate or conflicting initial bootstraps). The only
   exception is re-running against the *same* already-bootstrapped
   account, which is an idempotent no-op that writes nothing.
4. In one transaction: creates the `AdminRoleAssignment`
   (`role = SUPER_ADMIN`) and records an audit event
   (`RBAC_BOOTSTRAP_SUPER_ADMIN`, actor `operator-cli`) with the old/new
   effective roles.
5. Prints the result. It never logs credentials, tokens, or secrets.

## After bootstrapping

Manage roles through the existing `/api/admin/rbac` surface
(authenticated as the bootstrapped Super Admin):

| Operation | Endpoint |
| --- | --- |
| List admins + effective roles | `GET /api/admin/rbac/admins` |
| Assign / change a role | `POST /api/admin/rbac/admins/:id/role` (body: `{ "role": "FINANCE_ADMIN" }`) |
| Fully deprovision an admin | `POST /api/admin/rbac/admins/:id/deprovision` |

Valid role names are exactly the server-side catalog:
`SUPER_ADMIN`, `FINANCE_ADMIN`, `SUPPORT_ADMIN`, `COMPLIANCE_ADMIN`,
`READ_ONLY_ADMIN`.

## Revocation semantics (important)

- Assigning `READ_ONLY_ADMIN` keeps the account administrative. Within
  the **enforced flows** listed below it is restricted to the catalog's
  read-only permission set — but see the next section: legacy claim-based
  endpoints do **not** honor this restriction until they are migrated.
- **Full deprovision** (`POST /admins/:id/deprovision`) removes the
  specialized assignment, sets the primary role to `USER`, and bumps
  `tokenVersion` so every outstanding token is rejected — all in one
  transaction.
- There is intentionally **no** endpoint that deletes a role assignment
  alone: with the primary role still `ADMIN`, bare assignment removal
  would fall back to *legacy full admin* in the effective-role resolver —
  an escalation, not a revocation.
- No mutation may leave the platform with zero active Super Admins; the
  API refuses such changes (`RBAC_SUPER_ADMIN_LOCKOUT`), and no
  administrator can target themselves.

## ⚠️ Scope of enforcement — READ BEFORE ASSIGNING ANY SPECIALIZED ROLE

Specialized-role enforcement is **partial, not platform-wide**.

Effective-role enforcement applies **only** to flows that explicitly resolve
the acting admin's role from authoritative database state
(`AdminRoleAssignment` + primary `User.role`) at the moment of authorization.
Those enforced flows are exactly:

| Enforced flow | Where |
| --- | --- |
| Multi-step approval lifecycle (`createApprovalRequest`, `approveRequest`, `rejectRequest`) | `controllers/adminRbacController.js` |
| `approveWithdrawal` — acting role and re-derivation of every recorded participant | `controllers/adminController.js` |
| Role provisioning (`GET /admins`, `POST /admins/:id/role`, `POST /admins/:id/deprovision`) | `controllers/adminRoleAdminController.js` |

Operational consequences:

- **`READ_ONLY_ADMIN`, `FINANCE_ADMIN`, `SUPPORT_ADMIN` and
  `COMPLIANCE_ADMIN` must NOT be treated as globally least-privilege
  identities** until the legacy admin endpoint migration is complete. A
  specialized designation restricts only the enforced flows listed above.
- On the unenforced surfaces below, authorization still checks the **JWT
  role claim / primary `User.role`** — an account demoted to
  `READ_ONLY_ADMIN` retains whatever those endpoints grant to its primary
  `ADMIN` role. Only **full deprovision** removes that access.
- The role catalog **does not automatically secure an endpoint** simply
  because a permission is listed there. A permission binds only where code
  explicitly calls the effective-role resolver or
  `checkAdminPermission`/`requireAdminPermission`.

### Legacy surfaces still OUTSIDE authoritative specialized-role enforcement

Route files gated only by `protect` + `isAdmin`-style claim checks (no
effective-role resolution). This inventory is maintained and versioned with
this runbook, and a regression test
(`__tests__/r272-bootstrap-runbook-doc-contract.test.js`) fails if it drifts
from the codebase:

- `routes/adminChatRoutes.js`
- `routes/adminDineInRoutes.js`
- `routes/adminRoutes.js`
- `routes/adminStatsRoutes.js`
- `routes/adminStorefrontRoutes.js`
- `routes/adminSusuRoutes.js`
- `routes/adminWarRoomRoutes.js`
- `routes/aiRoutes.js`
- `routes/businessOSKioskRoutes.js`
- `routes/businessOSRoutes.js`
- `routes/changelogRoutes.js`
- `routes/creditScoreRoutes.js`
- `routes/custodyRoutes.js`
- `routes/financeRoutes.js`
- `routes/fraudRoutes.js`
- `routes/journalRoutes.js`
- `routes/kycRoutes.js`
- `routes/liabilityContractRoutes.js`
- `routes/notificationRoutes.js`
- `routes/proofOfReservesRoutes.js`
- `routes/proofOfResidencyRoutes.js`
- `routes/qrRoutes.js`
- `routes/tradeRoutes.js`
- `routes/vendorStatsRoutes.js`
- `routes/warRoomRoutes.js`

Controller handlers gated by `requireAdminPermission`, which reads the JWT
role claim (inside `controllers/adminRbacController.js`):

- `listApprovals` (`audit.view`)
- `exportAuditLog` (`audit.export`)
- `getSusuHealthDashboard` (`susu.health`)

Migrating this legacy surface to authoritative effective-role enforcement is
a **separately tracked task** — it is deliberately out of scope for this
branch. Do not assume it has happened; check this inventory and its
accompanying test.
