jest.mock('../middleware/authMiddleware', () => ({
  protect: (req, _res, next) => {
    req.user = { id: 7, role: 'ADMIN' };
    next();
  },
}));

const express = require('express');
const request = require('supertest');
const controlPlaneService = require('../services/controlPlaneService');

jest.mock('../services/controlPlaneService', () => ({
  hasPermission: jest.fn(),
  getStaffProfile: jest.fn(),
  recordActivity: jest.fn(),
}));

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.set('logger', { error: jest.fn() });
  app.use('/api/admin/reconciliation', require('../routes/adminReconciliationRoutes'));
  return app;
}

describe('admin reconciliation exception claim API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    controlPlaneService.hasPermission.mockResolvedValue(true);
    controlPlaneService.getStaffProfile.mockResolvedValue({ id: 42 });
  });

  test('requires staff.manage permission', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(false);
    const prisma = { $queryRawUnsafe: jest.fn() };
    const res = await request(buildApp(prisma)).post('/api/admin/reconciliation/exceptions/ex-1/claim');
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('staff.manage');
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('claims an open exception and records an audit event', async () => {
    const claimed = {
      id: 'ex-1', entityType: 'WITHDRAWAL', entityId: 'w-1', status: 'OPEN',
      details: { claim: { staffProfileId: 42, actorUserId: 7 } },
    };
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValue([claimed]) };
    const res = await request(buildApp(prisma)).post('/api/admin/reconciliation/exceptions/ex-1/claim');
    expect(res.status).toBe(200);
    expect(res.body.exception.id).toBe('ex-1');
    const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain("CURRENT_TIMESTAMP + INTERVAL '15 minutes'");
    expect(sql).toContain("'claim'");
    expect(params).toEqual(['ex-1', 42, 7]);
    expect(controlPlaneService.recordActivity).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ eventType: 'RECONCILIATION_EXCEPTION_CLAIMED', targetId: 'ex-1' })
    );
  });

  test('returns conflict when another active operator owns the lease', async () => {
    const prisma = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'ex-1', status: 'OPEN', details: { claim: { actorUserId: 99 } } }]),
    };
    const res = await request(buildApp(prisma)).post('/api/admin/reconciliation/exceptions/ex-1/claim');
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('currently claimed');
  });

  test('release only permits the owner, unless the lease has expired', async () => {
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValue([]) };
    const res = await request(buildApp(prisma)).post('/api/admin/reconciliation/exceptions/ex-1/release');
    expect(res.status).toBe(409);
    const [sql] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain("'expiresAt'");
    expect(sql).toContain("'actorUserId'");
  });

  test('resolution cannot bypass another active claim', async () => {
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValue([]) };
    const res = await request(buildApp(prisma))
      .post('/api/admin/reconciliation/exceptions/ex-1/resolve')
      .send({ reason: 'Reviewed and resolved' });
    expect(res.status).toBe(409);
    const [sql] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain("'actorUserId'");
    expect(sql).toContain("'expiresAt'");
  });
});
