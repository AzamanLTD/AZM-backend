# Control Plane Operational Command Center Contract

## Purpose

This document defines the backend contract for the next AZM control-plane phase: turning the existing durable staff model into an operational command center for the CEO/global administrator and delegated staff.

The implementation must use the canonical control-plane tables already on `main`:

- `StaffProfile`
- `ControlDepartment`
- `ControlPermission`
- `ControlDuty`
- `StaffPermissionGrant`
- `StaffDutyAssignment`
- `StaffActivityEvent`

Do not introduce a second `Platform*` control-plane schema.

## Authority model

The global CEO/super-admin is identified by the existing explicit `StaffProfile.isGlobalSuperAdmin` boundary while the profile is active. `adminType = SUPER_ADMIN` alone must never imply global authority.

Delegated administrators and employees receive only explicitly granted permissions and operational duties.

A duty describes responsibility; a permission describes an allowed operation; an assignment describes work actually assigned to a staff member. These concepts must remain separate.

## Operational audit feed

The control plane needs a protected audit/activity feed over `StaffActivityEvent`.

The API should support:

- bounded pagination;
- newest-first ordering;
- event type filtering;
- actor/staff filtering;
- target type and target id filtering;
- start/end time filtering;
- staff/user identity context where available.

The API must require the appropriate audit/activity read permission. The global super-admin may read the complete stream.

Audit responses must not expose passwords, tokens, authentication secrets, or other unnecessary sensitive material stored in event metadata.

## Workforce operations

The operational workforce view should be derived from existing canonical staff data and eventually provide:

- staff identity and status;
- admin/employee type;
- department;
- supervisor;
- presence;
- last active time;
- active duties;
- duty status;
- assignment timestamps;
- operational workload/queue counts where a real underlying work source exists.

Do not manufacture workload numbers. If a product area does not yet have a real work queue, expose the absence of a queue rather than a fake count.

## CEO command-center data

The future command center should be able to aggregate:

### Workforce

- active staff;
- online/away/offline counts;
- recently active staff;
- active duty assignments;
- unassigned operational work;
- overdue/escalated work once real queue sources exist.

### Governance

- recent administrative actions;
- authority changes;
- staff lifecycle changes;
- permission changes;
- duty assignment changes;
- policy changes.

### Finance

Financial totals must come from the existing unified financial/ledger sources. The control plane must not create a parallel financial ledger merely to support dashboard metrics.

### Escrow and disputes

Escrow and dispute information must come from the actual escrow/dispute domain. The control plane should provide operational assignment, investigation, resolution, and audit surfaces around those domain records rather than duplicating escrow state.

## API design requirements

All operational endpoints must:

1. authenticate using the existing authentication middleware;
2. authorize through the canonical `controlPlaneService.hasPermission` path;
3. use parameterized SQL/Prisma operations;
4. enforce bounded pagination and reasonable maximum page sizes;
5. return stable JSON shapes;
6. audit administrative mutations;
7. fail closed when staff authority cannot be established.

## Event/audit requirements

Administrative actions should record, where applicable:

- actor user id;
- actor staff profile id;
- event type;
- target type;
- target id;
- relevant before/after state;
- human-readable reason for sensitive changes;
- timestamp.

Audit metadata should be deliberately scoped. Do not dump complete request bodies or authorization headers into the event stream.

## Smart Escrow integration

Smart Escrow policy remains governed by the existing `GlobalSettings` values and Admin Portal policy surface.

The command center may display current policy and policy-change history, but it must not duplicate the Smart Escrow configuration source of truth.

The lifecycle semantics remain:

- policy is configurable;
- new lifecycle events use the current policy;
- previously calculated lifecycle values are not silently rewritten by later policy changes.

## Dispute integration

The eventual unified escrow-dispute operational API should identify the source/product context of a dispute while sharing common operational fields such as:

- claimant/respondent;
- reason;
- evidence;
- status;
- assigned staff member;
- resolution decision;
- resolution reason;
- financial outcome;
- audit history.

The control plane must not directly invent or bypass the escrow domain's financial state transitions.

## Security invariants

The following must remain true as the command center grows:

- legacy `ADMIN` compatibility remains intact where intentionally supported;
- non-global `SUPER_ADMIN` does not receive an implicit global bypass;
- inactive and suspended staff cannot operate through control-plane permissions;
- delegated staff cannot promote themselves;
- delegated staff cannot create or grant global-super-admin authority;
- protected global-super-admin profiles cannot be modified by delegated operators;
- high-risk financial and dispute actions require explicit permissions;
- sensitive mutations are auditable.

## Delivery sequence

The preferred implementation order is:

```text
Audit/activity API
      ↓
Workforce operational summaries
      ↓
Admin Portal staff/workforce integration
      ↓
Unified escrow dispute operational API
      ↓
Financial governance views/actions
      ↓
CEO command center aggregation
```

Each stage should be independently testable and should use the canonical backend sources of truth.

## Definition of done

A command-center feature is complete only when its backend data contract, authorization, tests, CI, audit behavior, and Admin Portal integration all agree.

A dashboard that renders successfully but uses fake, duplicated, or unauthorized data is not considered complete.
