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
| Legacy migration **tranche 1** — per-endpoint effective-role permission gates (`requireEffectivePermission`) on the consolidated command center's money/privilege mutations | `middleware/requireEffectivePermission.js`, wired in `routes/adminRoutes.js` and `routes/financeRoutes.js` |
| Legacy migration **tranche 2** — remaining `adminRoutes` mutations + reads: fee-profile CRUD, platform settings, risk tiers, trade-account approvals, dispute/escrow-dispute resolution, business KYB, business suspend/delete, chat injection, the `/profits/liquidate` alias, and the admin read surfaces | `middleware/requireEffectivePermission.js`, wired in `routes/adminRoutes.js` |

Tranche 1 covers exactly these operations (endpoint → required catalog
permission, OR-composed where noted):

| Endpoint | Required permission |
| --- | --- |
| `POST /api/admin/users/:id/credit` (manual balance credit) | `fees.manage` (the established `MANUAL_BALANCE_ADJUST` mapping) |
| `POST /api/admin/withdrawals/:id/reject` | `withdrawals.approve` (finalize authority, mirroring hardened `approveWithdrawal`) |
| `POST /api/admin/withdrawals/:id/resolve-review` | `withdrawals.approve` |
| `POST /api/admin/payouts/batch-process` | `withdrawals.approve` (disbursement trigger) |
| `PUT /api/admin/payouts/settings` | `withdrawals.approve` |
| `POST /api/finance/admin/liquidate-profits` | `fees.manage` (profit-fee pool management) |
| `POST /api/admin/disputes/force-release` | `disputes.resolve` |
| `POST /api/admin/disputes/force-cancel` | `disputes.resolve` |
| `POST /api/admin/users/:id/ban` | `users.ban` **or** `users.unban` at the route; the handler narrows to the action-specific permission |
| `POST /api/admin/kyc/approve` | `users.kyc_approve` |
| `POST /api/admin/kyc/reject` | `users.kyc_reject` |
| `POST /api/admin/users/:id/role` | `users.role_change` — a RESERVED permission granted to no specialized role: primary-role changes (including elevation to ADMIN) stay SUPER_ADMIN/legacy-ADMIN only |

The gates run BEFORE the financial idempotency claim on the credit route, so
a denied credit never mints a claim and never touches economics. All gates
fail closed (no live row, deleted, banned, demoted or unresolvable → 403),
resolve the acting role from `AdminRoleAssignment` + the live `User` row, and
never consult the JWT role claim.

Tranche 2 covers exactly these operations (same conventions):

| Endpoint | Required permission |
| --- | --- |
| `POST /api/admin/profits/liquidate` | `fees.manage` — tranche-1 completeness: an ungated alias of the finance liquidation route |
| `POST /api/admin/fee-profiles`, `PUT /api/admin/fee-profiles/:id`, `DELETE /api/admin/fee-profiles/:id` | `fees.manage` |
| `GET /api/admin/fee-profiles`, `GET /api/admin/fee-profiles/resolve` | `fees.manage` |
| `GET /api/admin/profit-breakdown` | `fees.manage` |
| `PUT /api/admin/settings`, `GET /api/admin/settings` | `platform.settings` — RESERVED |
| `PUT /api/admin/version-gate`, `GET /api/admin/version-gate` | `platform.settings` — RESERVED |
| `POST /api/admin/users/:id/risk-tier` | `users.risk_tier` — RESERVED |
| `POST /api/admin/trade-accounts/:id/approve`, `POST /api/admin/trade-accounts/:id/reject` | `trades.account_approve` — RESERVED |
| `GET /api/admin/trade-accounts/pending` | `trades.view` |
| `POST /api/admin/disputes/:tradeId/resolve` | `disputes.resolve` |
| `POST /api/admin/escrow-disputes/:id/assign`, `POST /api/admin/escrow-disputes/:id/resolve` | `disputes.resolve` |
| `POST /api/admin/chat/inject` | `messages.inject` — RESERVED |
| `POST /api/admin/business-kyb/:documentId/review`, `POST /api/admin/business-kyb/:bizId/approve` | `users.kyc_approve` |
| `POST /api/admin/business-kyb/:bizId/reject` | `users.kyc_reject` |
| `POST /api/admin/businesses/:bizId/suspend`, `POST /api/admin/businesses/:bizId/unsuspend`, `DELETE /api/admin/businesses/:bizId`, `DELETE /api/admin/ad-posts/:id` | `business.manage` — RESERVED |
| `GET /api/admin/users`, `GET /api/admin/users/:id/detail` | `users.view` |
| `GET /api/admin/kyc/pending` | `users.view` |
| `GET /api/admin/business-kyb` | `users.view` |
| `GET /api/admin/withdrawals/pending` | `withdrawals.review` |
| `GET /api/admin/payouts/settings`, `GET /api/admin/payouts/needs-review` | `withdrawals.review` |
| `GET /api/admin/trades/live` | `trades.view` |
| `GET /api/admin/disputes`, `GET /api/admin/disputes/resolutions`, `GET /api/admin/escrow-disputes` | `disputes.view` |
| `GET /api/admin/audit-log`, `GET /api/admin/audit-log/general` | `audit.view` |
| `GET /api/admin/stats`, `GET /api/admin/system-health` | `reports.view` |

RESERVED permissions (`platform.settings`, `users.risk_tier`,
`trades.account_approve`, `business.manage`, `messages.inject`) are granted
to NO specialized role: those operations are SUPER_ADMIN/legacy-ADMIN only
until a separate, reviewed policy change (registry in
`controllers/adminRbacController.js`).

Tranche-2 exclusions (explicit, tracked for later tranches): the 2FA
self-service routes act on the requester's own account; `GET /businesses` and
the marketplace-business reads move with the businessOS family in tranche 4;
`GET /payment-providers/health` is a non-mutating diagnostic.

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

> **Migration in progress (tranches 1 and 2 landed):** the two files below
> carry per-endpoint authoritative gates on their tranche-1 and tranche-2
> operations (see the enforced-flows table above) — `routes/adminRoutes.js`
> and `routes/financeRoutes.js`. What remains ungated inside them is now
> narrow and enumerated: the 2FA self-service routes, `GET /businesses`, the
> marketplace-business reads, and `GET /payment-providers/health` (all in
> `adminRoutes.js`). Every other file in this inventory is still claim-gated
> only. The files stay listed here because the router-level claim gate
> remains their outer boundary; the authoritative enforcement inside them is
> per-endpoint, not file-wide.

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
a **separately tracked task** — tranche 1 (above) has landed; the remaining
surface is tracked in explicit follow-up tranches so nothing disappears from
scope. Planned migration order (highest risk first):

- **Tranche 2 — LANDED (this revision):** remaining adminRoutes mutations +
  reads: fee-profile CRUD, platform settings (`PUT /settings`, `PUT
  /version-gate`, risk tiers), trade-account approve/reject, dispute and
  escrow-dispute assign/resolve, business KYB review/approve/reject, business
  suspend/unsuspend/delete, ad-post delete, chat injection, the
  `/profits/liquidate` alias, and the read surfaces (`GET /users`, `GET
  /withdrawals/pending`, stats and the rest per the tranche-2 table above).
- **Tranche 3 — financial surveillance routes:** `adminSusuRoutes`,
  `custodyRoutes`, `tradeRoutes`, `fraudRoutes`, `creditScoreRoutes`,
  `proofOfReservesRoutes`, `kycRoutes`, `liabilityContractRoutes`,
  `warRoomRoutes`, `adminWarRoomRoutes`, `journalRoutes`.
- **Tranche 4 — operational/back-office routes:** the `businessOSRoutes`
  family (`businessOSRoutes`, `businessOSKioskRoutes`), `adminStorefrontRoutes`,
  `adminDineInRoutes`, `adminChatRoutes`, `adminStatsRoutes`, `aiRoutes`,
  `changelogRoutes`, `notificationRoutes`, `qrRoutes`, `vendorStatsRoutes`,
  `proofOfResidencyRoutes`.
- **Tranche 5 — the three claim-gated RBAC controller handlers**
  (`listApprovals`, `exportAuditLog`, `getSusuHealthDashboard`) in
  `controllers/adminRbacController.js`.

Do not assume a tranche has happened until it is listed in the enforced-flows
table; check this inventory and its accompanying test.
