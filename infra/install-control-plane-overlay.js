const logger = require('../src/config/logger');

const PERMISSIONS = [
  ['perm_view_platform', 'platform.view', 'View platform-wide operational data'],
  ['perm_view_finance', 'finance.view', 'View financial flows, balances and profit data'],
  ['perm_manage_finance', 'finance.manage', 'Perform authorized financial operations'],
  ['perm_view_withdrawals', 'withdrawals.view', 'View withdrawal activity'],
  ['perm_approve_withdrawals', 'withdrawals.approve', 'Approve authorized withdrawals'],
  ['perm_view_disputes', 'disputes.view', 'View escrow disputes'],
  ['perm_investigate_disputes', 'disputes.investigate', 'Investigate assigned escrow disputes'],
  ['perm_resolve_disputes', 'disputes.resolve', 'Resolve escrow disputes where authorized'],
  ['perm_view_audit', 'audit.view', 'View platform audit events'],
  ['perm_manage_admins', 'access.manage_admins', 'Manage delegated administrators'],
  ['perm_manage_employees', 'workforce.manage', 'Manage platform employees and duties'],
  ['perm_view_workforce', 'workforce.view', 'View workforce presence and workload'],
  ['perm_manage_settings', 'settings.manage', 'Change platform configuration'],
  ['perm_view_users', 'users.view', 'View user/account operational data'],
  ['perm_manage_users', 'users.manage', 'Perform authorized user administration'],
];

const DUTIES = [
  ['duty_support', 'support', 'Customer Support', 'Handle customer support cases and escalations', 'SUPPORT'],
  ['duty_escrow_disputes', 'escrow_disputes', 'Escrow Dispute Resolution', 'Investigate and resolve assigned escrow disputes', 'ESCROW'],
  ['duty_finance_ops', 'finance_operations', 'Finance Operations', 'Review financial operations, reconciliations and exceptions', 'FINANCE'],
  ['duty_withdrawals', 'withdrawals', 'Withdrawal Operations', 'Review and process authorized withdrawals', 'FINANCE'],
  ['duty_merchant_ops', 'merchant_operations', 'Merchant Operations', 'Handle merchant/store operational issues', 'MERCHANTS'],
  ['duty_compliance', 'compliance', 'Compliance Operations', 'Handle compliance reviews and escalations', 'COMPLIANCE'],
  ['duty_technical_ops', 'technical_operations', 'Technical Operations', 'Monitor application/system operational issues', 'TECHNICAL'],
];

async function installControlPlaneOverlay(prisma) {
  const errors = [];
  let ok = 0;
  let failed = 0;

  const statements = [
    `CREATE TABLE IF NOT EXISTS "PlatformStaffProfile" ("id" TEXT NOT NULL,"userId" INTEGER NOT NULL,"staffType" TEXT NOT NULL,"adminType" TEXT,"employeeType" TEXT,"department" TEXT,"title" TEXT,"isCeo" BOOLEAN NOT NULL DEFAULT FALSE,"status" TEXT NOT NULL DEFAULT 'ACTIVE',"lastActiveAt" TIMESTAMP(3),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,CONSTRAINT "PlatformStaffProfile_pkey" PRIMARY KEY ("id"),CONSTRAINT "PlatformStaffProfile_userId_key" UNIQUE ("userId"))`,
    `CREATE INDEX IF NOT EXISTS "PlatformStaffProfile_staffType_status_idx" ON "PlatformStaffProfile" ("staffType","status")`,
    `CREATE INDEX IF NOT EXISTS "PlatformStaffProfile_department_status_idx" ON "PlatformStaffProfile" ("department","status")`,
    `CREATE INDEX IF NOT EXISTS "PlatformStaffProfile_lastActiveAt_idx" ON "PlatformStaffProfile" ("lastActiveAt")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PlatformStaffProfile_single_ceo_idx" ON "PlatformStaffProfile" ("isCeo") WHERE "isCeo" = TRUE`,
    `CREATE TABLE IF NOT EXISTS "PlatformPermission" ("id" TEXT NOT NULL,"key" TEXT NOT NULL,"description" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "PlatformPermission_pkey" PRIMARY KEY ("id"),CONSTRAINT "PlatformPermission_key_key" UNIQUE ("key"))`,
    `CREATE TABLE IF NOT EXISTS "PlatformStaffPermission" ("id" TEXT NOT NULL,"staffProfileId" TEXT NOT NULL,"permissionId" TEXT NOT NULL,"grantedByUserId" INTEGER,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "PlatformStaffPermission_pkey" PRIMARY KEY ("id"),CONSTRAINT "PlatformStaffPermission_staff_permission_key" UNIQUE ("staffProfileId","permissionId"))`,
    `CREATE INDEX IF NOT EXISTS "PlatformStaffPermission_staff_idx" ON "PlatformStaffPermission" ("staffProfileId")`,
    `CREATE INDEX IF NOT EXISTS "PlatformStaffPermission_permission_idx" ON "PlatformStaffPermission" ("permissionId")`,
    `CREATE TABLE IF NOT EXISTS "PlatformDuty" ("id" TEXT NOT NULL,"key" TEXT NOT NULL,"name" TEXT NOT NULL,"description" TEXT,"department" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "PlatformDuty_pkey" PRIMARY KEY ("id"),CONSTRAINT "PlatformDuty_key_key" UNIQUE ("key"))`,
    `CREATE TABLE IF NOT EXISTS "PlatformStaffDuty" ("id" TEXT NOT NULL,"staffProfileId" TEXT NOT NULL,"dutyId" TEXT NOT NULL,"assignedByUserId" INTEGER,"assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"endedAt" TIMESTAMP(3),CONSTRAINT "PlatformStaffDuty_pkey" PRIMARY KEY ("id"),CONSTRAINT "PlatformStaffDuty_staff_duty_key" UNIQUE ("staffProfileId","dutyId"))`,
    `CREATE INDEX IF NOT EXISTS "PlatformStaffDuty_staff_idx" ON "PlatformStaffDuty" ("staffProfileId")`,
    `CREATE INDEX IF NOT EXISTS "PlatformStaffDuty_duty_idx" ON "PlatformStaffDuty" ("dutyId")`,
    `CREATE INDEX IF NOT EXISTS "PlatformStaffDuty_active_idx" ON "PlatformStaffDuty" ("endedAt")`,
    `CREATE TABLE IF NOT EXISTS "PlatformAuditEvent" ("id" TEXT NOT NULL,"actorUserId" INTEGER,"action" TEXT NOT NULL,"targetType" TEXT,"targetId" TEXT,"metadata" JSONB NOT NULL DEFAULT '{}',"ipAddress" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "PlatformAuditEvent_pkey" PRIMARY KEY ("id"))`,
    `CREATE INDEX IF NOT EXISTS "PlatformAuditEvent_actor_created_idx" ON "PlatformAuditEvent" ("actorUserId","createdAt" DESC)`,
    `CREATE INDEX IF NOT EXISTS "PlatformAuditEvent_action_created_idx" ON "PlatformAuditEvent" ("action","createdAt" DESC)`,
    `CREATE INDEX IF NOT EXISTS "PlatformAuditEvent_target_idx" ON "PlatformAuditEvent" ("targetType","targetId")`,
    `CREATE INDEX IF NOT EXISTS "PlatformAuditEvent_created_idx" ON "PlatformAuditEvent" ("createdAt" DESC)`,
  ];

  for (const sql of statements) {
    try {
      await prisma.$executeRawUnsafe(sql);
      ok += 1;
    } catch (error) {
      if (/already exists/i.test(error.message || '')) continue;
      failed += 1;
      errors.push(error.message);
      logger.warn(`[controlPlaneOverlay] statement failed: ${error.message}`);
    }
  }

  for (const [id, key, description] of PERMISSIONS) {
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "PlatformPermission" ("id","key","description") VALUES ($1,$2,$3) ON CONFLICT ("key") DO NOTHING`,
        id, key, description
      );
      ok += 1;
    } catch (error) {
      failed += 1;
      errors.push(error.message);
    }
  }

  for (const [id, key, name, description, department] of DUTIES) {
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "PlatformDuty" ("id","key","name","description","department") VALUES ($1,$2,$3,$4,$5) ON CONFLICT ("key") DO NOTHING`,
        id, key, name, description, department
      );
      ok += 1;
    } catch (error) {
      failed += 1;
      errors.push(error.message);
    }
  }

  return { ok, failed, errors };
}

module.exports = { installControlPlaneOverlay, PERMISSIONS, DUTIES };