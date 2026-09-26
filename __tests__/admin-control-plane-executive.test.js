jest.mock('../middleware/authMiddleware', () => ({
  protect: (req, _res, next) => {
    req.user = { id: 7, role: 'USER' };
    next();
  },
}));

jest.mock('../services/controlPlaneService', () => ({
  hasPermission: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const controlPlaneService = require('../services/controlPlaneService');

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.set('logger', { error: jest.fn() });
  app.use('/api/admin/control-plane', require('../routes/adminControlPlaneExecutiveRoutes'));
  return app;
}

describe('admin control-plane executive summary', () => {
  beforeEach(() => jest.clearAllMocks());

  test('requires staff.view permission', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(false);
    const prisma = {};
    const res = await request(buildApp(prisma)).get('/api/admin/control-plane/executive-summary');
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('staff.view');
  });

  test('aggregates canonical workforce, dispute, treasury, transaction and profit sources', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    const prisma = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ totalStaff: 10, activeStaff: 8, onlineStaff: 5, activeAdmins: 2 }])
        .mockResolvedValueOnce([{ exceptionCount: 3, pendingCount: 1, failedCount: 1, frozenDisputeCount: 1 }])
        .mockResolvedValueOnce([{ last24h: 12, last7d: 90 }]),
      escrowDispute: {
        groupBy: jest.fn().mockResolvedValue([
          { status: 'PENDING', _count: { _all: 2 } },
          { status: 'RESOLVED', _count: { _all: 5 } },
        ]),
      },
      systemProfitFees: {
        findUnique: jest.fn().mockResolvedValue({ balance: 250, updatedAt: '2026-08-29T00:00:00Z' }),
      },
    };

    const res = await request(buildApp(prisma)).get('/api/admin/control-plane/executive-summary');

    expect(res.status).toBe(200);
    expect(res.body.executiveSummary.workforce.activeStaff).toBe(8);
    expect(res.body.executiveSummary.disputes.open).toBe(2);
    expect(res.body.executiveSummary.treasury.balance).toBe(250);
    expect(res.body.executiveSummary.financialExceptions.exceptionCount).toBe(3);
    expect(res.body.executiveSummary.profit.last7d).toBe(90);
    expect(res.body.executiveSummary.policy.readOnly).toBe(true);
    expect(res.body.executiveSummary.policy.financialMutationsAllowed).toBe(false);
  });
});
