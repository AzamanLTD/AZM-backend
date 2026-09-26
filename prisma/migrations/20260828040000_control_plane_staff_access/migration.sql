-- Control Plane: durable staff/admin/employee access model.
-- Additive only: existing User.role values remain unchanged.

CREATE TABLE IF NOT EXISTS "ControlDepartment" (
  "id" SERIAL PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE,
  "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "ControlPermission" (
  "id" SERIAL PRIMARY KEY,
  "key" TEXT NOT NULL UNIQUE,
  "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "ControlDuty" (
  "id" SERIAL PRIMARY KEY,
  "key" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "departmentId" INTEGER REFERENCES "ControlDepartment"("id") ON DELETE SET NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "StaffProfile" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL UNIQUE REFERENCES "User"("id") ON DELETE CASCADE,
  "authorityClass" TEXT NOT NULL CHECK ("authorityClass" IN ('ADMIN', 'EMPLOYEE')),
  "adminType" TEXT,
  "employeeType" TEXT,
  "departmentId" INTEGER REFERENCES "ControlDepartment"("id") ON DELETE SET NULL,
  "supervisorId" INTEGER REFERENCES "StaffProfile"("id") ON DELETE SET NULL,
  "isGlobalSuperAdmin" BOOLEAN NOT NULL DEFAULT FALSE,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'INACTIVE')),
  "presence" TEXT NOT NULL DEFAULT 'OFFLINE' CHECK ("presence" IN ('ONLINE', 'AWAY', 'OFFLINE')),
  "lastActiveAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "StaffProfile_departmentId_idx" ON "StaffProfile"("departmentId");
CREATE INDEX IF NOT EXISTS "StaffProfile_supervisorId_idx" ON "StaffProfile"("supervisorId");
CREATE INDEX IF NOT EXISTS "StaffProfile_status_presence_idx" ON "StaffProfile"("status", "presence");

CREATE TABLE IF NOT EXISTS "StaffPermissionGrant" (
  "id" SERIAL PRIMARY KEY,
  "staffProfileId" INTEGER NOT NULL REFERENCES "StaffProfile"("id") ON DELETE CASCADE,
  "permissionId" INTEGER NOT NULL REFERENCES "ControlPermission"("id") ON DELETE RESTRICT,
  "grantedByUserId" INTEGER REFERENCES "User"("id") ON DELETE SET NULL,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("staffProfileId", "permissionId")
);

CREATE INDEX IF NOT EXISTS "StaffPermissionGrant_permissionId_idx" ON "StaffPermissionGrant"("permissionId");
CREATE INDEX IF NOT EXISTS "StaffPermissionGrant_expiresAt_idx" ON "StaffPermissionGrant"("expiresAt");

CREATE TABLE IF NOT EXISTS "StaffDutyAssignment" (
  "id" SERIAL PRIMARY KEY,
  "staffProfileId" INTEGER NOT NULL REFERENCES "StaffProfile"("id") ON DELETE CASCADE,
  "dutyId" INTEGER NOT NULL REFERENCES "ControlDuty"("id") ON DELETE RESTRICT,
  "assignedByUserId" INTEGER REFERENCES "User"("id") ON DELETE SET NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'REVOKED')),
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "notes" TEXT,
  UNIQUE ("staffProfileId", "dutyId")
);

CREATE INDEX IF NOT EXISTS "StaffDutyAssignment_dutyId_status_idx" ON "StaffDutyAssignment"("dutyId", "status");
CREATE INDEX IF NOT EXISTS "StaffDutyAssignment_staffProfileId_status_idx" ON "StaffDutyAssignment"("staffProfileId", "status");

CREATE TABLE IF NOT EXISTS "StaffActivityEvent" (
  "id" BIGSERIAL PRIMARY KEY,
  "staffProfileId" INTEGER REFERENCES "StaffProfile"("id") ON DELETE SET NULL,
  "actorUserId" INTEGER REFERENCES "User"("id") ON DELETE SET NULL,
  "eventType" TEXT NOT NULL,
  "targetType" TEXT,
  "targetId" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "StaffActivityEvent_staffProfileId_createdAt_idx" ON "StaffActivityEvent"("staffProfileId", "createdAt");
CREATE INDEX IF NOT EXISTS "StaffActivityEvent_eventType_createdAt_idx" ON "StaffActivityEvent"("eventType", "createdAt");
CREATE INDEX IF NOT EXISTS "StaffActivityEvent_targetType_targetId_idx" ON "StaffActivityEvent"("targetType", "targetId");

-- Stable initial vocabulary. Existing hard-coded RBAC remains the compatibility baseline.
INSERT INTO "ControlPermission" ("key", "description") VALUES
  ('staff.view', 'View staff profiles and workforce status'),
  ('staff.manage', 'Create, update, activate, suspend, and deactivate staff profiles'),
  ('staff.permissions.manage', 'Grant and revoke staff permissions'),
  ('staff.duties.manage', 'Assign and revoke operational duties'),
  ('staff.activity.view', 'View staff activity history'),
  ('departments.manage', 'Manage staff departments'),
  ('disputes.view', 'View escrow disputes'),
  ('disputes.investigate', 'Investigate assigned escrow disputes'),
  ('disputes.resolve', 'Resolve escrow disputes'),
  ('withdrawals.review', 'Review withdrawal activity'),
  ('withdrawals.approve', 'Approve withdrawals where policy permits'),
  ('fees.manage', 'Manage platform fee policy'),
  ('audit.view', 'View audit history'),
  ('audit.export', 'Export audit history')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "ControlDuty" ("key", "name", "description") VALUES
  ('ESCROW_DISPUTES', 'Escrow Disputes', 'Investigate and process assigned escrow disputes'),
  ('CUSTOMER_SUPPORT', 'Customer Support', 'Handle customer support and operational cases'),
  ('FINANCE_OPERATIONS', 'Finance Operations', 'Review operational finance queues'),
  ('COMPLIANCE_OPERATIONS', 'Compliance Operations', 'Handle compliance review queues'),
  ('MERCHANT_OPERATIONS', 'Merchant Operations', 'Handle business and merchant operations'),
  ('TECHNICAL_OPERATIONS', 'Technical Operations', 'Handle technical operations and incidents')
ON CONFLICT ("key") DO NOTHING;
