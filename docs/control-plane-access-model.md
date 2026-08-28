# AZM Control Plane Access Model

## Purpose

The Admin Portal is the platform operations command center. The CEO/global super administrator has global visibility and authority. Delegated administrators and employees receive only the access required for their role and assigned duties.

## Core separation

- **User role**: existing customer/vendor/admin identity classification. Do not replace it.
- **Staff type**: administrator or employee classification for platform operations.
- **Admin type**: SUPER_ADMIN, FINANCE_ADMIN, SUPPORT_ADMIN, COMPLIANCE_ADMIN, READ_ONLY_ADMIN.
- **Employee type**: operational classification such as SUPPORT, ESCROW_SPECIALIST, FINANCE_OPERATIONS, MERCHANT_OPERATIONS, COMPLIANCE_OPERATIONS, TECHNICAL_OPERATIONS.
- **Department**: organizational grouping.
- **Permission**: authorization to perform a capability.
- **Duty**: operational responsibility assigned to a staff member.
- **Assignment**: a concrete duty/case/queue assignment.

Role, permission, duty and assignment must not be conflated.

## CEO authority

The CEO/global super administrator is a durable access designation, not an email/username check scattered through controllers. It has global read visibility and unrestricted administrative authority, subject to the platform's existing financial approval safeguards.

## Workforce

Employees do not need the database `ADMIN` role merely to perform operational duties. Their access is granted through the control-plane staff/access layer. Existing business employees remain separate from platform employees; this model is for AZM platform operations.

## Disputes

Escrow disputes are a unified operational queue. Every dispute carries its source context (retail, ticket, vendor purchase, reservation, transit, etc.), reason, evidence, status, assignee and resolution history. A worker may investigate without necessarily having authority to execute a financial resolution.

## Audit

Access changes, permission grants/revocations, duty assignments, dispute assignments/resolutions and privileged financial actions must be auditable. Financial movements remain in the existing ledger/journal systems; the control plane references those records rather than creating a second money ledger.

## Implementation rule

Build the access model additively around the existing `User` and RBAC code. Do not replace `Role.ADMIN`, do not duplicate the financial ledger, and do not give employees blanket admin access.