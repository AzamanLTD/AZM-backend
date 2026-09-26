# AZM Control Plane Management Architecture

## Purpose

This document defines the platform-wide administrative and workforce control plane. It is intentionally additive: existing `User.role` values (`USER`, `VENDOR`, `ADMIN`) remain valid, while staff authority is modeled separately.

## Authority model

`User` identifies the person/account. Staff authority is an additional platform-access profile.

```text
User
  -> StaffProfile
       -> authority class (ADMIN | EMPLOYEE)
       -> admin/employee type
       -> department
       -> supervisor
       -> status/presence
       -> permission grants
       -> duty assignments
```

### CEO / global super administrator

The CEO is represented by an explicit global-super-admin authority, never by a username/email special case. This authority has platform-wide read/write/override capability and can manage all staff access.

### Administrators

Initial administrator types remain compatible with the existing RBAC vocabulary:

- `SUPER_ADMIN`
- `FINANCE_ADMIN`
- `SUPPORT_ADMIN`
- `COMPLIANCE_ADMIN`
- `READ_ONLY_ADMIN`

The existing hard-coded permission catalog is the compatibility baseline. Durable assignments should eventually supersede hard-coded role lookup, while preserving legacy `ADMIN` access during migration.

### Employees

Employees are not platform `ADMIN` users merely because they work for AZM. They receive operational duties and only the permissions necessary for those duties.

Examples:

- `ESCROW_SPECIALIST`
- `CUSTOMER_SUPPORT`
- `FINANCE_OPERATIONS`
- `COMPLIANCE_OPERATIONS`
- `MERCHANT_OPERATIONS`
- `TECHNICAL_OPERATIONS`

These are extensible classifications, not a closed list of permissions.

## Core concepts

### Department

Organizational grouping and supervisor boundary.

### Permission

A capability such as `disputes.view`, `disputes.investigate`, `disputes.resolve`, `withdrawals.review`, `withdrawals.approve`, `fees.manage`, `audit.view`, or `audit.export`.

### Duty

Operational responsibility, such as handling escrow disputes or reviewing withdrawals. A duty does not itself grant unrestricted financial authority.

### Assignment

A staff member's assignment to a duty, queue, case, or operational task. Assignments should record who assigned it, when, status, and completion/escalation metadata.

### Presence/activity

Operational state should support `ONLINE`, `AWAY`, `OFFLINE`, plus `lastActiveAt`, current assignment, and workload counters. Presence is informational; it must never be used as an authorization decision.

## Authorization rules

1. Authorization is evaluated server-side.
2. UI visibility is never the security boundary.
3. CEO/global-super-admin is centrally recognized.
4. Legacy `ADMIN` remains backward compatible during migration.
5. Employees cannot gain financial authority solely by receiving an operational duty.
6. Sensitive actions require explicit permissions and, where applicable, the existing multi-step approval workflow.
7. Permission and staff-access changes are themselves audited.
8. Revoked/inactive staff lose staff capabilities immediately on the server.
9. Read-only administrators cannot mutate platform state.
10. No controller should contain a user-specific email/username exception.

## Escrow disputes

Escrow disputes are a platform-wide operational object. Each dispute carries a source/product discriminator so the same workflow can support current and future escrow products.

Required lifecycle:

```text
PENDING
  -> ASSIGNED
  -> UNDER_REVIEW
  -> RESOLVED
```

A dispute must retain:

- source/product type;
- escrow/order/entity reference;
- requester/affected parties;
- reason/category;
- detailed statement;
- evidence;
- assigned staff member;
- investigator/reviewer;
- ruling;
- resolution notes;
- timestamps;
- complete audit/event history.

Resolution authority is permission-based. Investigation and recommendation may be delegated separately from final financial resolution.

## Financial governance

The existing unified ledger remains the financial source of truth. Administrative dashboards must not reconstruct balances by summing application logs.

The command center should link financial views to immutable ledger entries and existing transaction/profit classifications, including Smart Escrow fees.

Configuration values such as:

- Smart Escrow fee percentage;
- escrow draft expiry hours;
- escrow funded expiry days;

belong to platform policy and are managed through the Admin Portal. Changes must be validated, authorized, audited, and applied prospectively unless an explicit migration says otherwise.

## CEO command center requirements

The CEO dashboard should eventually provide drill-down visibility into:

- users and businesses;
- transactions and ledger movement;
- platform revenue/profit;
- withdrawals and failed withdrawals;
- escrow balances/lifecycle;
- open and resolved disputes;
- system events and errors;
- audit events;
- administrators and employees;
- online/away/offline staff;
- duties, queues, workloads and current assignments;
- configuration changes and policy history.

A dashboard metric must link to the underlying records where practical. Summary numbers alone are insufficient for financial investigation.

## Proposed management API surface

All endpoints must enforce permissions server-side.

### Staff

- `GET /api/admin/staff`
- `GET /api/admin/staff/:id`
- `POST /api/admin/staff`
- `PATCH /api/admin/staff/:id`
- `POST /api/admin/staff/:id/deactivate`
- `POST /api/admin/staff/:id/reactivate`
- `GET /api/admin/staff/:id/activity`

### Departments

- `GET /api/admin/departments`
- `POST /api/admin/departments`
- `PATCH /api/admin/departments/:id`

### Duties

- `GET /api/admin/duties`
- `POST /api/admin/duties`
- `PATCH /api/admin/duties/:id`
- `POST /api/admin/staff/:id/duties`
- `DELETE /api/admin/staff/:id/duties/:dutyId`

### Permissions

- `GET /api/admin/permissions`
- `GET /api/admin/staff/:id/permissions`
- `PUT /api/admin/staff/:id/permissions`

Permission grants should be explicit and auditable. Avoid a mutable JSON blob as the sole source of authorization truth.

### Disputes

- `GET /api/admin/escrow-disputes`
- `GET /api/admin/escrow-disputes/:id`
- `POST /api/admin/escrow-disputes/:id/assign`
- `POST /api/admin/escrow-disputes/:id/start-review`
- `POST /api/admin/escrow-disputes/:id/resolve`

Resolution must enforce the appropriate dispute-resolution and financial permissions and write an audit event.

## Admin Portal integration

The existing Admin Portal already contains global settings, Smart Escrow Policy, profits, withdrawals, audit logs, War Room, and Escrow Disputes routes. The management layer should add workforce functionality without duplicating those existing surfaces.

The existing Smart Escrow Policy page already exposes the three required global controls:

- `smartEscrowFeePct`
- `escrowDraftExpiryHours`
- `escrowFundedExpiryDays`

and displays change history. This page should remain the authoritative UI for those controls; the backend remains authoritative for validation and enforcement.

Future workforce routes should include:

- Staff / Employees
- Departments
- Duties & Assignments
- Roles & Permissions
- Staff Activity

The CEO command center should aggregate existing dashboard APIs plus the new staff/dispute/financial drill-down APIs.

## Implementation sequence

1. Add durable staff/organization/access tables with foreign keys to `User`.
2. Add centralized authorization service and middleware.
3. Migrate existing specialized admin roles to durable access profiles.
4. Add staff management APIs.
5. Add presence/activity and assignment APIs.
6. Extend dispute assignment/resolution around the existing Smart Escrow dispute records.
7. Add CEO command-center aggregation endpoints.
8. Add Admin Portal workforce UI.
9. Add comprehensive authorization, tenant-boundary, audit, and financial regression tests.
10. Run full backend and Admin Portal CI before each merge.

## Non-goals

- Do not replace the unified ledger.
- Do not create a second escrow engine.
- Do not create product-specific dispute systems.
- Do not grant employees the legacy global `ADMIN` privilege merely to make the UI work.
- Do not encode the CEO identity as a magic email/username condition.
