jest.mock('../middleware/authMiddleware', () => ({
  protect: (req, _res, next) => { req.user = { id: 7, role: 'USER' }; next(); },
}));
jest.mock('../services/controlPlaneService', () => ({ hasPermission: jest.fn() }));
jest.mock('../services/escrowService', () => ({}));

const express = require('express');
const request = require('supertest');
const controlPlaneService = require('../services/controlPlaneService');

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.set('logger', { error: jest.fn() });
  app.use('/api/admin/control-plane', require('../routes/adminControlPlaneSummaryRoutes'));
  return app;
}

describe('admin control-plane financial governance snapshot', () => {
  beforeEach(() => jest.clearAllMocks());

  test('requires staff.view and performs no financial reads when unauthorized', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(false);
    const prisma = { systemProfitFees: { findUnique: jest.fn() } };
    const res = await request(buildApp(prisma)).get('/api/admin/control-plane/financial-governance');
    expect(res.status).toBe(403);
    expect(prisma.systemProfitFees.findUnique).not.toHaveBeenCalled();
  });

  test('returns canonical treasury, exception and profit windows without mutation', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    const prisma = {
      systemProfitFees: { findUnique: jest.fn().mockResolvedValue({ balance: 123.45, updatedAt: '2026-08-29T00:00:00Z' }) },
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ pendingTransactions: 2, failedTransactions: 1, frozenDisputeTransactions: 3 }])
        .mockResolvedValueOnce([{ profitLast24h: 10, profitLast7d: 80, profitEventsLast24h: 2, profitEventsLast7d: 8 }])
        .mockResolvedValueOnce([{ source: 'SMART_ESCROW_FEE', amountUsdc: 40, eventCount: 4 }]),
    };
    const res = await request(buildApp(prisma)).get('/api/admin/control-plane/financial-governance');
    expect(res.status).toBe(200);
    expect(res.body.financialGovernance.treasury.balance).toBe(123.45);
    expect(res.body.financialGovernance.transactionExceptions.failedTransactions).toBe(1);
    expect(res.body.financialGovernance.profit.windows.profitLast7d).toBe(80);
    expect(res.body.financialGovernance.policy).toEqual(expect.objectContaining({ readOnly: true, financialMutationsAllowed: false }));
    expect(prisma.systemProfitFees.findUnique).toHaveBeenCalledWith({ where: { id: 1 }, select: { balance: true, updatedAt: true } });
  });
});
