# r26 — Module 01 Authorization Hardening: Final Report

**Date:** 2026-09-22 · **Branch:** `module01/auth-hardening` (amends PR #298) · **Portal:** PR #105 (amended)

## Scope

The r26 review of the Module 01 permissions work (PR #298 / #105) required a
mandatory hardening pass before merge: close the vocabulary/role-template split
residuals, remove the trusting-client business-context resolution, and lock the
OWNER role at the service boundary. This is that pass.

## Changes

### 1. Authoritative business-context resolution (middleware/requirePermission.js)
- `resolveBusinessContext` no longer trusts client-supplied
  `businessProfileId`/role headers as evidence of ownership. Context is resolved
  from the database: an authenticated `BusinessAccess`/`BusinessEmployee` row
  binding the caller to the business, with the stored role as the authority.
- Fail closed: no resolvable context means no permission check passes and no
  scoped write proceeds.

### 2. Service-boundary OWNER lock (services/businessOS/employeeService.js)
- `addEmployee` refuses the `OWNER` role: ownership is provisioned at business
  creation, never granted through the employee API.
- Generic `updateEmployee` refuses the protected fields:
  - `permissions` → must go through `updatePermissions` (the
    `employees.permissions` authority), which now REQUIRES an authenticated
    actor context (fail closed), refuses wildcard grants to non-owners, refuses
    unknown keys, and enforces a delegation ceiling (an actor may only mint
    grants they hold; preserving existing grants is allowed).
  - `status` → must go through `updateStatus` (the `employees.terminate`
    authority). Suspend/termination is never a generic field edit.
- `role` changes on the generic path remain, but OWNER can never be minted.

### 3. Route guards (routes/businessOSRoutes.js)
- ~130 catalog-key guards across management routes; each route declares the
  exact canonical permission it requires (single-key or explicit sets).
- PATCH `/employees/me` and PATCH `/employees/:id/status` split from the
  generic employee PATCH so status transitions are gated on
  `employees.terminate`.
- Guard vocabulary is the canonical catalog (config/permissionTemplates.js),
  not legacy underscore strings.

### 4. Catalog (config/permissionTemplates.js)
- `ALL_PERMISSION_KEYS` is the single authoritative vocabulary; role
  templates reference only catalog rows. Vocabulary and templates no longer
  drift.

### 5. Tests
- `__tests__/module01-authorization-hardening.test.js` — real-PostgreSQL
  proofs for six P0 boundaries: trusting-context refusal, OWNER mint refusal,
  wildcard grant refusal, delegation ceiling, status-authority separation,
  permission-authority separation (actor-context fail-closed included).
- `__tests__/module01-route-coverage.test.js` — executable drift test: every
  `requirePermission`-bearing route in the business OS router must declare a
  catalog key; a route whose guard vocabulary drifts from the catalog fails
  the suite.
- Updated `business-os.test.js` to the new contract: the generic update path
  now refuses `status`/`permissions`; the tests assert BOTH the refusal and the
  dedicated authority path (`updateStatus` / `updatePermissions` with actor).
  This is a contract update, not a weakening: the refused behavior is the
  point of the hardening.
- Updated catalog/scope/permission-middleware suites to the authoritative
  context model.

## Verification (all green, 2026-09-22)

| Gate | Result |
|---|---|
| Full backend battery (`jest --runInBand`, real PostgreSQL) | **272 suites / 2327 tests passed** |
| Financial-durability lane (production commit mode, `synchronous_commit=on`) | **32 suites / 320 tests passed** |
| Route-coverage drift test | executable, green in full battery |
| Commit-mode guard | `on` before and after durability run |

Environmental notes for reproduction: the battery requires a JWT_SECRET of at
least 32 characters (server bootstrap fatals below 32, by design), a fresh
`azm_test` (drop, `prisma db push`), the full overlay chain, and `npx prisma
generate` after overlay application. Three suites fail with a stale generated
client (`PrismaClientValidationError` on custody `errorClass` queries) — that
is a client-generation issue, not a code defect.

## Portal (PR #105)
- OWNER removed from the employee role selector (cannot be minted from UI).
- Employees page wired to the real backend contract: status changes go to the
  dedicated status route; permission editing goes through the permission
  authority; UI hides paths the backend refuses.
- `usePermission` aligned with the canonical dotted-key vocabulary.
- Portal verification: production build, unit battery, and Playwright
  evidence suites green (see PR #105 checks).

## Residual / follow-ups
- Delegation ceiling audit across remaining modules (booking, transit) — same
  pattern, tracked for the next audit brief.
- Rate-limiter persistence and Helmet.js remain open TODOs from the standing
  security list (out of scope for this brief).
