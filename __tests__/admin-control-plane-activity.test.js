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
  getStaffProfile: jest.fn(),
  recordActivity: jest.fn(),
}));

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.set('logger', { error: jest.fn() });
  app.use('/api/admin/control-plane', require('../routes/adminControlPlaneRoutes'));
  return app;
}

describe('admin control-plane audit activity API', () => {
  beforeEach(() => jest.clearAllMocks());

  test('requires the audit permission', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(false);
    const prisma = { $queryRawUnsafe: jest.fn() };

    const res = await request(buildApp(prisma)).get('/api/admin/control-plane/activity');

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('staff.activity.view');
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('rejects unbounded or invalid pagination', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    const prisma = { $queryRawUnsafe: jest.fn() };

    const res = await request(buildApp(prisma)).get('/api/admin/control-plane/activity?limit=101');

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('between 1 and 100');
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('rejects invalid date ranges', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    const prisma = { $queryRawUnsafe: jest.fn() };

    const res = await request(buildApp(prisma)).get('/api/admin/control-plane/activity?startAt=not-a-date');

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('valid date');
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('lists filtered activity with bounded pagination and sanitized metadata', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    const rows = [
      {
        id: 10,
        staffProfileId: 42,
        actorUserId: 7,
        eventType: 'STAFF_SUSPENDED',
        targetType: 'STAFF_PROFILE',
        targetId: '42',
        metadata: {
          reason: 'Security review',
          password: 'should-not-leak',
          nested: { accessToken: 'also-hidden', safe: true },
        },
        createdAt: new Date('2026-08-29T04:00:00.000Z'),
        actorUsername: 'admin',
        actorEmail: 'admin@example.com',
        staffUsername: 'employee',
        staffEmail: 'employee@example.com',
      },
    ];
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValue(rows) };

    const res = await request(buildApp(prisma)).get(
      '/api/admin/control-plane/activity?staffId=42&eventType=STAFF_SUSPENDED&targetType=STAFF_PROFILE&limit=20&page=2'
    );

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].metadata).toEqual({ reason: 'Security review', nested: { safe: true } });
    expect(res.body.pagination).toEqual({ page: 2, limit: 20, hasMore: false, nextPage: null });
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('ORDER BY ae."createdAt" DESC, ae.id DESC');
    expect(sql).toContain('LIMIT $4 OFFSET $5');
    expect(params).toEqual([42, 'STAFF_SUSPENDED', 'STAFF_PROFILE', 21, 20]);
  });

  test('fetches a staff activity history without exposing sensitive metadata', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    const rows = [{ id: 1, eventType: 'STAFF_PROFILE_UPDATED', metadata: { secret: 'x', fields: ['status'] } }];
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValue(rows) };

    const res = await request(buildApp(prisma)).get('/api/admin/control-plane/staff/42/activity');

    expect(res.status).toBe(200);
    expect(res.body.events[0].metadata).toEqual({ fields: ['status'] });
  });
});
