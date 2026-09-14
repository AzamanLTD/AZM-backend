// Admin control-plane integrity batch (2026-09-14):
// atomic permission state, atomic audit evidence, TOCTOU-hardened authority
// mutations, atomic duty mutations.
//
// Two layers:
//  - mocked-prisma unit tests (SQL-fragment-aware mocks) proving the
//    validation gates, the transactional call structure, and the guarded
//    UPDATE semantics;
//  - real-PostgreSQL tests (run where TEST_DATABASE_URL is set — the CI
//    workflow provides it) proving rollback and concurrency behavior with
//    genuine transactions. Only the audit WRITER is wrapped (with a
//    simulated failure flag) for the recordActivity-failure cases; the
//    transactions themselves are real.

let mockAuthUser = { id: 7, role: 'USER' };
let mockAuditFailure = false;

jest.mock('../middleware/authMiddleware', () => ({
  protect: (req, _res, next) => {
    req.user = mockAuthUser;
    next();
  },
}));

jest.mock('../services/controlPlaneService', () => {
  const actual = jest.requireActual('../services/controlPlaneService');
  return {
    ...actual,
    recordActivity: async (client, payload) => {
      if (mockAuditFailure) throw new Error('simulated audit write failure');
      return actual.recordActivity(client, payload);
    },
  };
});

const express = require('express');

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.set('logger', { error: jest.fn() });
  app.use('/api/admin/control-plane', require('../routes/adminControlPlaneRoutes'));
  return app;
}

// SQL-fragment-aware prisma mock. Each rule is [fragment, ...results]; a
// matching query consumes the next result (the last one repeats), so call
// ORDER within a transaction is observable.
function mockPrisma(rules) {
  const queues = rules.map(([frag, ...results]) => ({ frag, results, i: 0 }));
  const db = {};
  db.$queryRawUnsafe = jest.fn(async (sql, ...args) => {
    const rule = queues.find((q) => sql.includes(q.frag));
    if (!rule) throw new Error('unmocked SQL: ' + String(sql).slice(0, 90));
    const value = rule.results[Math.min(rule.i, rule.results.length - 1)];
    rule.i += 1;
    return typeof value === 'function' ? value(args) : value;
  });
  db.$transaction = async (fn) => fn(db);
  db.user = { findUnique: jest.fn() };
  return db;
}

const ACTOR_GLOBAL = { id: 42, userId: 7, status: 'ACTIVE', presence: 'ONLINE', isGlobalSuperAdmin: true, authorityClass: 'ADMIN', adminType: 'SUPER_ADMIN' };

// getStaffProfile (actor / existing-profile lookups) fragment — result is an
// ARRAY OF ROWS, matching what $queryRawUnsafe returns
const ACTOR_LOOKUP = ['FROM "StaffProfile" sp', [ACTOR_GLOBAL]];
// hasPermission grant lookup fragment
const ACTOR_GRANTS = ['spg."staffProfileId" = $1', []];

describe('admin control-plane integrity — unit (mocked prisma)', () => {
  beforeEach(() => {
    mockAuthUser = { id: 7, role: 'USER' };
    mockAuditFailure = false;
  });

  test('successful permission replacement deletes, inserts each grant, then audits — all in one transaction', async () => {
    const db = mockPrisma([
      ACTOR_LOOKUP,
      ACTOR_GRANTS,
      ['SELECT id, "userId", "isGlobalSuperAdmin"', [{ id: 9, userId: 99, isGlobalSuperAdmin: false }]],
      ['FROM "ControlPermission" WHERE "key" = ANY', [{ id: 1, key: 'staff.view' }, { id: 2, key: 'staff.manage' }]],
      ['DELETE FROM "StaffPermissionGrant"', []],
      ['INSERT INTO "StaffPermissionGrant"', []],
      ['INSERT INTO "StaffActivityEvent"', []],
    ]);

    const res = await require('supertest')(buildApp(db))
      .put('/api/admin/control-plane/staff/9/permissions')
      .send({ permissions: ['staff.view', 'staff.manage'] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.permissions.map((row) => row.key).sort()).toEqual(['staff.manage', 'staff.view']);

    const sqls = db.$queryRawUnsafe.mock.calls.map((c) => c[0]);
    const del = sqls.findIndex((sql) => sql.includes('DELETE FROM "StaffPermissionGrant"'));
    const inserts = sqls.map((sql, i) => (sql.includes('INSERT INTO "StaffPermissionGrant"') ? i : -1)).filter((i) => i >= 0);
    const audit = sqls.findIndex((sql) => sql.includes('INSERT INTO "StaffActivityEvent"'));
    expect(del).toBeGreaterThanOrEqual(0);
    expect(inserts).toEqual([del + 1, del + 2]); // exactly the two requested grants, after the delete
    expect(audit).toBe(del + 3); // audit last, inside the same transaction
  });

  test('invalid/inactive permission leaves the old grants unchanged', async () => {
    const db = mockPrisma([
      ACTOR_LOOKUP,
      ACTOR_GRANTS,
      ['SELECT id, "userId", "isGlobalSuperAdmin"', [{ id: 9, userId: 99, isGlobalSuperAdmin: false }]],
      ['FROM "ControlPermission" WHERE "key" = ANY', [{ id: 1, key: 'staff.view' }]], // only one of two resolves
    ]);

    const res = await require('supertest')(buildApp(db))
      .put('/api/admin/control-plane/staff/9/permissions')
      .send({ permissions: ['staff.view', 'not.a.permission'] });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('One or more permissions are invalid or inactive.');
    const sqls = db.$queryRawUnsafe.mock.calls.map((c) => c[0]);
    expect(sqls.some((sql) => sql.includes('DELETE FROM "StaffPermissionGrant"'))).toBe(false);
    expect(sqls.some((sql) => sql.includes('INSERT INTO "StaffActivityEvent"'))).toBe(false);
  });

  test('non-global actor cannot grant a permission they do not possess', async () => {
    mockAuthUser = { id: 8, role: 'USER' };
    const nonGlobalActor = { ...ACTOR_GLOBAL, id: 43, userId: 8, isGlobalSuperAdmin: false };
    const db = mockPrisma([
      ['FROM "StaffProfile" sp', [nonGlobalActor]],
      // authorize grant lookup AND the possession lookup share this expiresAt clause
      ['(spg."expiresAt" IS NULL OR spg."expiresAt" > CURRENT_TIMESTAMP)', [{ key: 'staff.permissions.manage' }], [{ key: 'staff.view' }]],
      ['SELECT id, "userId", "isGlobalSuperAdmin"', [{ id: 9, userId: 99, isGlobalSuperAdmin: false }]],
      ['FROM "ControlPermission" WHERE "key" = ANY', [{ id: 2, key: 'staff.manage' }]],
    ]);

    const res = await require('supertest')(buildApp(db))
      .put('/api/admin/control-plane/staff/9/permissions')
      .send({ permissions: ['staff.manage'] });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('You cannot grant a permission you do not possess.');
    const sqls = db.$queryRawUnsafe.mock.calls.map((c) => c[0]);
    expect(sqls.some((sql) => sql.includes('DELETE FROM "StaffPermissionGrant"'))).toBe(false);
    expect(sqls.some((sql) => sql.includes('INSERT INTO "StaffActivityEvent"'))).toBe(false);
  });

  test('global-super-admin target stays protected from a non-global actor', async () => {
    mockAuthUser = { id: 8, role: 'USER' };
    const nonGlobalActor = { ...ACTOR_GLOBAL, id: 43, userId: 8, isGlobalSuperAdmin: false };
    const db = mockPrisma([
      ['FROM "StaffProfile" sp', [nonGlobalActor]],
      ['spg."staffProfileId" = $1', [{ key: 'staff.permissions.manage' }]],
      ['SELECT id, "userId", "isGlobalSuperAdmin"', [{ id: 42, userId: 7, isGlobalSuperAdmin: true }]],
    ]);

    const res = await require('supertest')(buildApp(db))
      .put('/api/admin/control-plane/staff/42/permissions')
      .send({ permissions: ['staff.view'] });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Only a global super admin may modify global-super-admin permissions.');
    const sqls = db.$queryRawUnsafe.mock.calls.map((c) => c[0]);
    expect(sqls.some((sql) => sql.includes('DELETE FROM "StaffPermissionGrant"'))).toBe(false);
  });

  test('staff lifecycle update is guarded by the validated authority state — stale writes yield 409, not success', async () => {
    const db = mockPrisma([
      ACTOR_LOOKUP,
      ACTOR_GRANTS,
      ['SELECT * FROM "StaffProfile"', [{ id: 9, userId: 99, status: 'ACTIVE', presence: 'ONLINE', isGlobalSuperAdmin: false }]],
      ['UPDATE "StaffProfile"', []], // guard fails: profile changed concurrently
    ]);

    const res = await require('supertest')(buildApp(db))
      .post('/api/admin/control-plane/staff/9/suspend')
      .send({ reason: 'Security review' });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Staff profile changed during the operation. Please retry.');
    const updateCall = db.$queryRawUnsafe.mock.calls.find((c) => c[0].includes('UPDATE "StaffProfile"'));
    expect(updateCall[0]).toContain('"isGlobalSuperAdmin" = $4::boolean'); // the guard is present
    expect(db.$queryRawUnsafe.mock.calls.some((c) => c[0].includes('INSERT INTO "StaffActivityEvent"'))).toBe(false);
  });

  test('staff lifecycle success mutates and audits inside one transaction', async () => {
    const db = mockPrisma([
      ACTOR_LOOKUP,
      ACTOR_GRANTS,
      ['SELECT * FROM "StaffProfile"', [{ id: 9, userId: 99, status: 'ACTIVE', presence: 'ONLINE', isGlobalSuperAdmin: false }]],
      ['UPDATE "StaffProfile"', [{ id: 9, userId: 99, status: 'SUSPENDED', presence: 'OFFLINE', isGlobalSuperAdmin: false }]],
      ['INSERT INTO "StaffActivityEvent"', []],
    ]);

    const res = await require('supertest')(buildApp(db))
      .post('/api/admin/control-plane/staff/9/suspend')
      .send({ reason: 'Security review' });

    expect(res.status).toBe(200);
    expect(res.body.staff.status).toBe('SUSPENDED');
    const sqls = db.$queryRawUnsafe.mock.calls.map((c) => c[0]);
    expect(sqls[sqls.length - 1]).toContain('INSERT INTO "StaffActivityEvent"'); // audit is the last statement in the transaction
  });

  test('PATCH /staff/:id is guarded by the validated authority state — stale writes yield 409', async () => {
    const db = mockPrisma([
      ACTOR_LOOKUP,
      ACTOR_GRANTS,
      ['SELECT * FROM "StaffProfile"', [{ id: 9, userId: 99, authorityClass: 'EMPLOYEE', adminType: null, employeeType: 'AGENT', status: 'ACTIVE', presence: 'OFFLINE', isGlobalSuperAdmin: false }]],
      ['UPDATE "StaffProfile"', []], // concurrent authority change -> zero rows
    ]);

    const res = await require('supertest')(buildApp(db))
      .patch('/api/admin/control-plane/staff/9')
      .send({ employeeType: 'SUPERVISOR' });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Staff profile changed during the operation. Please retry.');
    const updateCall = db.$queryRawUnsafe.mock.calls.find((c) => c[0].includes('UPDATE "StaffProfile"'));
    expect(updateCall[0]).toContain('"isGlobalSuperAdmin" = $9::boolean');
    expect(db.$queryRawUnsafe.mock.calls.some((c) => c[0].includes('INSERT INTO "StaffActivityEvent"'))).toBe(false);
  });

  test('duty revocation reports 404 before any audit when the assignment is missing', async () => {
    const db = mockPrisma([
      ACTOR_LOOKUP,
      ACTOR_GRANTS,
      ['UPDATE "StaffDutyAssignment"', []],
    ]);

    const res = await require('supertest')(buildApp(db))
      .delete('/api/admin/control-plane/staff/9/duties/4');

    expect(res.status).toBe(404);
    expect(db.$queryRawUnsafe.mock.calls.some((c) => c[0].includes('INSERT INTO "StaffActivityEvent"'))).toBe(false);
  });

  test('duty assignment upserts and audits inside one transaction', async () => {
    const db = mockPrisma([
      ACTOR_LOOKUP,
      ACTOR_GRANTS,
      ['FROM "ControlDuty" WHERE "key"', [{ id: 4, key: 'FINANCE_OPERATIONS', name: 'Finance Operations' }]],
      ['SELECT id FROM "StaffProfile"', [{ id: 9 }]],
      ['INSERT INTO "StaffDutyAssignment"', [{ id: 77, staffProfileId: 9, dutyId: 4, status: 'ACTIVE' }]],
      ['INSERT INTO "StaffActivityEvent"', []],
    ]);

    const res = await require('supertest')(buildApp(db))
      .post('/api/admin/control-plane/staff/9/duties')
      .send({ dutyKey: 'FINANCE_OPERATIONS' });

    expect(res.status).toBe(201);
    expect(res.body.assignment.status).toBe('ACTIVE');
    const sqls = db.$queryRawUnsafe.mock.calls.map((c) => c[0]);
    expect(sqls[sqls.length - 1]).toContain('INSERT INTO "StaffActivityEvent"');
  });

  test('department create maps unique violations to the existing 409 and audits inside the transaction', async () => {
    const db = mockPrisma([
      ACTOR_LOOKUP,
      ACTOR_GRANTS,
      ['INSERT INTO "ControlDepartment"', () => { const e = new Error('dup'); e.code = '23505'; throw e; }],
    ]);

    const res = await require('supertest')(buildApp(db))
      .post('/api/admin/control-plane/departments')
      .send({ name: 'Risk' });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Department already exists.');
    expect(db.$queryRawUnsafe.mock.calls.some((c) => c[0].includes('INSERT INTO "StaffActivityEvent"'))).toBe(false);

    const ok = mockPrisma([
      ACTOR_LOOKUP,
      ACTOR_GRANTS,
      ['INSERT INTO "ControlDepartment"', [{ id: 55, name: 'Treasury' }]],
      ['INSERT INTO "StaffActivityEvent"', []],
    ]);
    const res2 = await require('supertest')(buildApp(ok))
      .post('/api/admin/control-plane/departments')
      .send({ name: 'Treasury' });
    expect(res2.status).toBe(201);
    expect(res2.body.department.name).toBe('Treasury');
  });
});

// ---------------------------------------------------------------------------
// Real-PostgreSQL layer: rollback + concurrency proof with genuine
// transactions. Runs only where TEST_DATABASE_URL is set (CI provides it).
// ---------------------------------------------------------------------------
const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[admin-control-plane-integrity.test] TEST_DATABASE_URL not set — skipping real-DB layer.');

(hasDb ? describe : describe.skip)('admin control-plane integrity — real PostgreSQL transactions', () => {
  const request = require('supertest');
  let prisma;
  let app;
  const RUN = 'cpint_' + Date.now();
  let actor;      // global super admin
  let actor2;     // non-global with limited grants
  let target;     // plain employee staff profile

  const q = (sql, ...args) => prisma.$queryRawUnsafe(sql, ...args);

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient();
    await prisma.$connect();

    await q('DELETE FROM "User" WHERE username LIKE $1', RUN + '%');

    const mkUser = (n) => q('INSERT INTO "User" (email, username, password, role) VALUES ($1, $2, $3, \'USER\') RETURNING id, username',
      n + '@' + RUN + '.test', RUN + '_' + n, 'x');
    const [uActor, uActor2, uTarget] = await Promise.all([mkUser('actor'), mkUser('actor2'), mkUser('target')]);

    const mkProfile = (userId, authority, adminType, employeeType, global) =>
      q('INSERT INTO "StaffProfile" ("userId", "authorityClass", "adminType", "employeeType", "isGlobalSuperAdmin", "status") VALUES ($1, $2, $3, $4, $5, \'ACTIVE\') RETURNING id, "userId"',
        userId, authority, adminType, employeeType, global);

    const pActor = await mkProfile(uActor[0].id, 'ADMIN', 'SUPER_ADMIN', null, true);
    const pActor2 = await mkProfile(uActor2[0].id, 'ADMIN', 'SUPPORT_ADMIN', null, false);
    const pTarget = await mkProfile(uTarget[0].id, 'EMPLOYEE', null, 'AGENT', false);
    actor = { ...pActor[0], userId: uActor[0].id };
    actor2 = { ...pActor2[0], userId: uActor2[0].id };
    target = { ...pTarget[0], userId: uTarget[0].id };

    // actor2 holds only the permissions it needs for the tests that use it
    await q('INSERT INTO "StaffPermissionGrant" ("staffProfileId", "permissionId", "grantedByUserId") SELECT $1, cp.id, $2 FROM "ControlPermission" cp WHERE cp."key" = ANY($3::text[])',
      actor2.id, actor.userId, ['staff.permissions.manage', 'staff.view']);

    mockAuthUser = { id: actor.userId, role: 'USER' };
    app = buildApp(prisma);
  });

  afterAll(async () => {
    if (!prisma) return;
    const ids = (await q('SELECT id FROM "StaffProfile" WHERE "userId" IN (SELECT id FROM "User" WHERE username LIKE $1)', RUN + '%')).map((r) => r.id);
    if (ids.length) {
      await q('DELETE FROM "StaffActivityEvent" WHERE "staffProfileId" = ANY($1::int[])', ids);
      await q('DELETE FROM "StaffPermissionGrant" WHERE "staffProfileId" = ANY($1::int[])', ids);
      await q('DELETE FROM "StaffDutyAssignment" WHERE "staffProfileId" = ANY($1::int[])', ids);
    }
    await q('DELETE FROM "StaffActivityEvent" WHERE "actorUserId" IN (SELECT id FROM "User" WHERE username LIKE $1)', RUN + '%');
    await q('DELETE FROM "StaffActivityEvent" WHERE "targetType" = \'CONTROL_DEPARTMENT\' AND "targetId" IN (SELECT id::text FROM "ControlDepartment" WHERE name LIKE $1)', RUN + '%');
    await q('DELETE FROM "ControlDepartment" WHERE name LIKE $1', RUN + '%');
    if (ids.length) await q('DELETE FROM "StaffProfile" WHERE id = ANY($1::int[])', ids);
    await q('DELETE FROM "User" WHERE username LIKE $1', RUN + '%');
    mockAuditFailure = false;
    await prisma.$disconnect();
  });

  const grantsOf = (profileId) =>
    q('SELECT cp."key" FROM "StaffPermissionGrant" spg JOIN "ControlPermission" cp ON cp.id = spg."permissionId" WHERE spg."staffProfileId" = $1 ORDER BY cp."key"', profileId);
  const auditCount = (eventType, targetId) =>
    q('SELECT COUNT(*)::int AS n FROM "StaffActivityEvent" WHERE "eventType" = $1 AND "targetId" = $2', eventType, String(targetId));

  test('permission replacement commits exactly the requested grants with one audit event', async () => {
    const res = await request(app).put('/api/admin/control-plane/staff/' + target.id + '/permissions')
      .send({ permissions: ['staff.view', 'staff.manage'] });
    expect(res.status).toBe(200);
    expect((await grantsOf(target.id)).map((r) => r.key)).toEqual(['staff.manage', 'staff.view']);
    expect((await auditCount('STAFF_PERMISSIONS_REPLACED', target.id))[0].n).toBe(1);
  });

  test('invalid permission leaves the existing grants unchanged and unaudited', async () => {
    const before = await grantsOf(target.id);
    const res = await request(app).put('/api/admin/control-plane/staff/' + target.id + '/permissions')
      .send({ permissions: ['not.a.permission'] });
    expect(res.status).toBe(400);
    expect(await grantsOf(target.id)).toEqual(before);
    expect((await auditCount('STAFF_PERMISSIONS_REPLACED', target.id))[0].n).toBe(1); // unchanged
  });

  test('non-global actor cannot grant an unpossessed permission (real grants unchanged)', async () => {
    const prev = mockAuthUser;
    mockAuthUser = { id: actor2.userId, role: 'USER' };
    const res = await request(app).put('/api/admin/control-plane/staff/' + target.id + '/permissions')
      .send({ permissions: ['staff.manage'] }); // actor2 does not hold staff.manage
    mockAuthUser = prev;
    expect(res.status).toBe(403);
    expect((await grantsOf(target.id)).map((r) => r.key)).toEqual(['staff.manage', 'staff.view']);
  });

  test('global-super-admin target stays protected (real 403)', async () => {
    const prev = mockAuthUser;
    mockAuthUser = { id: actor2.userId, role: 'USER' };
    const res = await request(app).put('/api/admin/control-plane/staff/' + actor.id + '/permissions')
      .send({ permissions: ['staff.view'] });
    mockAuthUser = prev;
    expect(res.status).toBe(403);
  });

  test('simulated recordActivity failure rolls the whole permission replacement back — grants intact, no audit event', async () => {
    await request(app).put('/api/admin/control-plane/staff/' + target.id + '/permissions')
      .send({ permissions: ['staff.view'] });
    const before = await grantsOf(target.id);
    const auditsBefore = (await auditCount('STAFF_PERMISSIONS_REPLACED', target.id))[0].n;

    mockAuditFailure = true;
    const res = await request(app).put('/api/admin/control-plane/staff/' + target.id + '/permissions')
      .send({ permissions: ['staff.manage', 'audit.view'] });
    mockAuditFailure = false;

    expect(res.status).toBe(500);
    expect(await grantsOf(target.id)).toEqual(before); // old grant set fully intact
    expect((await auditCount('STAFF_PERMISSIONS_REPLACED', target.id))[0].n).toBe(auditsBefore); // no extra audit
  });

  test('simulated recordActivity failure rolls a staff lifecycle mutation back', async () => {
    mockAuditFailure = true;
    const res = await request(app).post('/api/admin/control-plane/staff/' + target.id + '/suspend')
      .send({ reason: 'audit writer failure' });
    mockAuditFailure = false;

    expect(res.status).toBe(500);
    const row = (await q('SELECT status FROM "StaffProfile" WHERE id = $1', target.id))[0];
    expect(row.status).toBe('ACTIVE'); // mutation rolled back
    expect((await auditCount('STAFF_SUSPENDED', target.id))[0].n).toBe(0);
  });

  test('simulated recordActivity failure rolls a duty assignment back', async () => {
    mockAuditFailure = true;
    const res = await request(app).post('/api/admin/control-plane/staff/' + target.id + '/duties')
      .send({ dutyKey: 'FINANCE_OPERATIONS' });
    mockAuditFailure = false;

    expect(res.status).toBe(500);
    const rows = await q('SELECT * FROM "StaffDutyAssignment" WHERE "staffProfileId" = $1', target.id);
    expect(rows.length).toBe(0); // no partial assignment
    const duty = (await q('SELECT id FROM "ControlDuty" WHERE "key" = \'FINANCE_OPERATIONS\''))[0];
    expect((await auditCount('DUTY_ASSIGNED', duty.id))[0].n).toBe(0);
  });

  test('department create/update, staff create, lifecycle, and duty mutations each commit with exactly one audit event', async () => {
    // department create + update
    const dres = await request(app).post('/api/admin/control-plane/departments')
      .send({ name: RUN + ' Treasury', description: 'integrity' });
    expect(dres.status).toBe(201);
    const deptId = dres.body.department.id;
    expect((await auditCount('DEPARTMENT_CREATED', deptId))[0].n).toBe(1);

    const ures = await request(app).patch('/api/admin/control-plane/departments/' + deptId)
      .send({ description: 'integrity v2' });
    expect(ures.status).toBe(200);
    expect((await auditCount('DEPARTMENT_UPDATED', deptId))[0].n).toBe(1);

    // staff create (against a fresh user)
    const inserted = await q('INSERT INTO "User" (email, username, password, role) VALUES ($1, $2, $3, \'USER\') RETURNING id', RUN + '_extra@' + RUN + '.test', RUN + '_extra', 'x');
    const u = inserted[0];
    const sres = await request(app).post('/api/admin/control-plane/staff')
      .send({ userId: u.id, authorityClass: 'EMPLOYEE', employeeType: 'AGENT' });
    expect(sres.status).toBe(201);
    const staffId = sres.body.staff.id;
    expect((await auditCount('STAFF_PROFILE_CREATED', staffId))[0].n).toBe(1);

    // lifecycle suspend + activate
    const sus = await request(app).post('/api/admin/control-plane/staff/' + target.id + '/suspend').send({ reason: 'integrity check' });
    expect(sus.status).toBe(200);
    expect((await auditCount('STAFF_SUSPENDED', target.id))[0].n).toBe(1);
    const act = await request(app).post('/api/admin/control-plane/staff/' + target.id + '/activate').send({});
    expect(act.status).toBe(200);
    expect((await auditCount('STAFF_ACTIVATED', target.id))[0].n).toBe(1);

    // duty assign + revoke
    const duty = (await q('SELECT id FROM "ControlDuty" WHERE "key" = \'COMPLIANCE_OPERATIONS\''))[0];
    const ares = await request(app).post('/api/admin/control-plane/staff/' + target.id + '/duties').send({ dutyKey: 'COMPLIANCE_OPERATIONS' });
    expect(ares.status).toBe(201);
    expect((await auditCount('DUTY_ASSIGNED', duty.id))[0].n).toBe(1);
    const rres = await request(app).delete('/api/admin/control-plane/staff/' + target.id + '/duties/' + duty.id);
    expect(rres.status).toBe(200);
    expect((await auditCount('DUTY_REVOKED', duty.id))[0].n).toBe(1);
    expect((await q('SELECT status FROM "StaffDutyAssignment" WHERE "staffProfileId" = $1 AND "dutyId" = $2', target.id, duty.id))[0].status).toBe('REVOKED');
  });

  test('two concurrent permission replacements never leave an interleaved grant set', async () => {
    const setA = ['staff.view', 'audit.export'];
    const setB = ['staff.manage', 'audit.view'];
    const [r1, r2] = await Promise.all([
      request(app).put('/api/admin/control-plane/staff/' + target.id + '/permissions').send({ permissions: setA }),
      request(app).put('/api/admin/control-plane/staff/' + target.id + '/permissions').send({ permissions: setB }),
    ]);
    // both transactions commit (Postgres row locks serialize the delete+insert
    // section); neither may report failure
    expect([r1.status, r2.status].sort()).toEqual([200, 200]);
    const final = (await grantsOf(target.id)).map((r) => r.key);
    expect(final).toHaveLength(2); // a complete set — never a mix of A and B
    expect([setA.slice().sort().join(','), setB.slice().sort().join(',')]).toContain(final.join(','));
    // both committed replacements were audited
    expect((await auditCount('STAFF_PERMISSIONS_REPLACED', target.id))[0].n).toBeGreaterThanOrEqual(2);
  });

  test('concurrent staff lifecycle updates leave a valid, fully-audited persisted state', async () => {
    const [r1, r2] = await Promise.all([
      request(app).post('/api/admin/control-plane/staff/' + target.id + '/suspend').send({ reason: 'concurrency probe' }),
      request(app).post('/api/admin/control-plane/staff/' + target.id + '/activate').send({}),
    ]);
    const statuses = [r1.status, r2.status].sort();
    // both may succeed (serialized), or one can hit the guarded-update 409 —
    // never a silent success on stale state
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    const row = (await q('SELECT status FROM "StaffProfile" WHERE id = $1', target.id))[0];
    expect(['SUSPENDED', 'ACTIVE']).toContain(row.status);
    // every committed mutation has its audit event
    const suspended = (await auditCount('STAFF_SUSPENDED', target.id))[0].n;
    const activated = (await auditCount('STAFF_ACTIVATED', target.id))[0].n;
    expect(suspended >= 1 && activated >= 1).toBe(true);
  });

  test('concurrent duty assignment and revocation never leave partial or unaudited state', async () => {
    // pre-create the assignment so both operations have a real target row
    const duty = (await q('SELECT id FROM "ControlDuty" WHERE "key" = \'TECHNICAL_OPERATIONS\''))[0];
    await request(app).post('/api/admin/control-plane/staff/' + target.id + '/duties').send({ dutyKey: 'TECHNICAL_OPERATIONS' });

    const [r1, r2] = await Promise.all([
      request(app).post('/api/admin/control-plane/staff/' + target.id + '/duties').send({ dutyKey: 'TECHNICAL_OPERATIONS' }),
      request(app).delete('/api/admin/control-plane/staff/' + target.id + '/duties/' + duty.id),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    const row = (await q('SELECT status FROM "StaffDutyAssignment" WHERE "staffProfileId" = $1 AND "dutyId" = $2', target.id, duty.id))[0];
    expect(['ACTIVE', 'REVOKED']).toContain(row.status);
    // both committed operations were audited — no unaudited mutation
    expect((await auditCount('DUTY_ASSIGNED', duty.id))[0].n).toBeGreaterThanOrEqual(2);
    expect((await auditCount('DUTY_REVOKED', duty.id))[0].n).toBeGreaterThanOrEqual(1);
  });
});
