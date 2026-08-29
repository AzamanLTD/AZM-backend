jest.mock('../middleware/authMiddleware', () => ({
  protect: (req, _res, next) => {
    req.user = { id: 7, role: 'USER' };
    next();
  },
}));

const express = require('express');
const request = require('supertest');
const controlPlaneService = require('../services/controlPlaneService');

jest.mock('../services/controlPlaneService', () => ({
  hasPermission: jest.fn(),
}));

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.set('logger', { error: jest.fn() });
  app.use('/api/admin/control-plane', require('../routes/adminControlPlaneSummaryRoutes'));
  return app;
}

describe('admin control-plane workforce summary API', () => {
  beforeEach(() => jest.clearAllMocks());

  test('requires staff.view permission', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(false);
    const prisma = { $queryRawUnsafe: jest.fn() };

    const res = await request(buildApp(prisma)).get('/api/admin/control-plane/summary');

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('staff.view');
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('returns aggregated staff, department, activity, and duty signals', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    const prisma = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{
          totalStaff: 12,
          activeStaff: 9,
          suspendedStaff: 2,
          inactiveStaff: 1,
          onlineStaff: 5,
          awayStaff: 2,
          offlineStaff: 2,
          activeAdmins: 3,
          activeEmployees: 6,
        }])
        .mockResolvedValueOnce([
          { id: 1, name: 'Operations', isActive: true, staffCount: 6, activeStaff: 5, onlineStaff: 3 },
          { id: 2, name: 'Support', isActive: true, staffCount: 4, activeStaff: 3, onlineStaff: 1 },
        ])
        .mockResolvedValueOnce([{ totalEvents: 50, eventsLast24h: 8, eventsLast7d: 31 }])
        .mockResolvedValueOnce([{ totalDuties: 14, activeDuties: 4, completedDuties: 8, pendingDuties: 2 }]),
    };

    const res = await request(buildApp(prisma)).get('/api/admin/control-plane/summary');

    expect(res.status).toBe(200);
    expect(res.body.summary.staff.activeStaff).toBe(9);
    expect(res.body.summary.departments).toHaveLength(2);
    expect(res.body.summary.activity.eventsLast24h).toBe(8);
    expect(res.body.summary.duties.activeDuties).toBe(4);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(4);
  });
});
