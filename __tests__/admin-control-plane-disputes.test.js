jest.mock('../middleware/authMiddleware', () => ({
  protect: (req, _res, next) => {
    req.user = { id: 7, role: 'USER' };
    next();
  },
}));

jest.mock('../services/controlPlaneService', () => ({
  hasPermission: jest.fn(),
  getStaffProfile: jest.fn(),
  recordActivity: jest.fn(),
}));

jest.mock('../services/escrowService', () => ({
  assignDisputeToAdmin: jest.fn(),
  resolveDispute: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const controlPlaneService = require('../services/controlPlaneService');
const escrowService = require('../services/escrowService');

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.set('logger', { error: jest.fn() });
  app.use('/api/admin/control-plane', require('../routes/adminControlPlaneSummaryRoutes'));
  return app;
}

describe('admin control-plane unified dispute API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    controlPlaneService.getStaffProfile.mockResolvedValue({ id: 101 });
    controlPlaneService.recordActivity.mockResolvedValue(undefined);
  });

  test('requires dispute-view permission before reading the queue', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(false);
    const prisma = { escrowDispute: { findMany: jest.fn(), count: jest.fn() } };

    const res = await request(buildApp(prisma)).get('/api/admin/control-plane/disputes');

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('staff.dispute.view');
    expect(prisma.escrowDispute.findMany).not.toHaveBeenCalled();
  });

  test('returns bounded paginated disputes with canonical escrow source context', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    const prisma = {
      escrowDispute: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'd1', escrowId: 'e1', raisedById: 9, reason: 'Delivery issue', evidenceUrls: ['https://example.test/evidence'],
          status: 'PENDING', assignedToId: null, ruling: null, rulingNotes: null,
          payerPct: null, payeePct: null, createdAt: '2026-08-29T00:00:00Z', updatedAt: '2026-08-29T00:00:00Z', resolvedAt: null,
        }]),
        count: jest.fn().mockResolvedValue(1),
      },
      smartEscrow: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'e1', ticketId: 't1', payerId: 9, payeeId: 10, amountUsdc: 100, status: 'DISPUTED',
        }]),
      },
    };

    const res = await request(buildApp(prisma))
      .get('/api/admin/control-plane/disputes?page=2&limit=500&status=pending');

    expect(res.status).toBe(200);
    expect(res.body.disputes[0].source).toEqual({ type: 'TICKET_ESCROW', ticketId: 't1' });
    expect(res.body.disputes[0].escrow.amountUsdc).toBe(100);
    expect(res.body.pagination).toEqual({ page: 2, limit: 100, total: 1, totalPages: 1 });
    expect(prisma.escrowDispute.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100, skip: 100, where: { status: 'PENDING' } }));
  });

  test('requires explicit assignment permission and audits assignment', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    escrowService.assignDisputeToAdmin.mockResolvedValue({ dispute: { id: 'd1' }, escrow: { id: 'e1' } });
    const prisma = {};

    const res = await request(buildApp(prisma))
      .post('/api/admin/control-plane/disputes/e1/assign')
      .send({ assignedToId: 42 });

    expect(res.status).toBe(200);
    expect(escrowService.assignDisputeToAdmin).toHaveBeenCalledWith(prisma, {
      escrowId: 'e1', assignedToId: 42, requestingAdminId: 7,
    });
    expect(controlPlaneService.recordActivity).toHaveBeenCalledWith(prisma, expect.objectContaining({
      eventType: 'DISPUTE_ASSIGNED', targetType: 'ESCROW_DISPUTE', targetId: 'e1',
    }));
  });

  test('rejects invalid split resolutions before financial service invocation', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    const prisma = {};

    const res = await request(buildApp(prisma))
      .post('/api/admin/control-plane/disputes/e1/resolve')
      .send({ ruling: 'SPLIT', payerPct: 60, payeePct: 30 });

    expect(res.status).toBe(400);
    expect(escrowService.resolveDispute).not.toHaveBeenCalled();
  });

  test('resolves a dispute through the canonical escrow service and audits the ruling', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    escrowService.resolveDispute.mockResolvedValue({
      dispute: { id: 'd1', status: 'RESOLVED' },
      escrow: { id: 'e1', status: 'RELEASED' },
    });
    const prisma = {};

    const res = await request(buildApp(prisma))
      .post('/api/admin/control-plane/disputes/e1/resolve')
      .send({ ruling: 'FULL_RELEASE', rulingNotes: 'Evidence supports the payee.' });

    expect(res.status).toBe(200);
    expect(escrowService.resolveDispute).toHaveBeenCalledWith(prisma, expect.objectContaining({
      escrowId: 'e1', adminId: 7, ruling: 'FULL_RELEASE',
    }));
    expect(controlPlaneService.recordActivity).toHaveBeenCalledWith(prisma, expect.objectContaining({
      eventType: 'DISPUTE_RESOLVED', targetType: 'ESCROW_DISPUTE', targetId: 'e1',
    }));
  });
});
