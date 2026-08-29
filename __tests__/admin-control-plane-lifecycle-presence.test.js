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

describe('admin control-plane lifecycle and presence API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    controlPlaneService.getStaffProfile.mockResolvedValue({ id: 42, userId: 7, status: 'ACTIVE', presence: 'ONLINE', isGlobalSuperAdmin: true });
    controlPlaneService.recordActivity.mockResolvedValue(undefined);
  });

  test('updates the authenticated staff member presence and audits it', async () => {
    const updated = { id: 42, userId: 7, status: 'ACTIVE', presence: 'AWAY' };
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValueOnce([updated]) };

    const res = await request(buildApp(prisma))
      .post('/api/admin/control-plane/me/presence')
      .send({ presence: 'away' });

    expect(res.status).toBe(200);
    expect(res.body.staff).toEqual(updated);
    expect(controlPlaneService.recordActivity).toHaveBeenCalledWith(prisma, expect.objectContaining({
      staffProfileId: 42,
      actorUserId: 7,
      eventType: 'STAFF_PRESENCE_UPDATED',
      targetType: 'STAFF_PROFILE',
      targetId: 42,
    }));
  });

  test('rejects presence updates for inactive staff', async () => {
    controlPlaneService.getStaffProfile.mockResolvedValueOnce({ id: 42, userId: 7, status: 'SUSPENDED', presence: 'OFFLINE' });
    const prisma = { $queryRawUnsafe: jest.fn() };

    const res = await request(buildApp(prisma))
      .post('/api/admin/control-plane/me/presence')
      .send({ presence: 'ONLINE' });

    expect(res.status).toBe(403);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('lists staff presence for staff viewers', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValueOnce([{ id: 42, presence: 'ONLINE', activeDutyCount: 2 }]) };

    const res = await request(buildApp(prisma)).get('/api/admin/control-plane/presence');

    expect(res.status).toBe(200);
    expect(res.body.presence).toHaveLength(1);
    expect(controlPlaneService.hasPermission).toHaveBeenCalledWith(prisma, { id: 7, role: 'USER' }, 'staff.view');
  });

  test('requires staff.manage for lifecycle transitions', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(false);
    const prisma = { $queryRawUnsafe: jest.fn() };

    const res = await request(buildApp(prisma))
      .post('/api/admin/control-plane/staff/9/suspend')
      .send({ reason: 'Policy violation' });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('staff.manage');
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('requires a reason for suspension', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    const prisma = { $queryRawUnsafe: jest.fn() };

    const res = await request(buildApp(prisma))
      .post('/api/admin/control-plane/staff/9/suspend')
      .send({});

    expect(res.status).toBe(400);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('prevents self suspension', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    controlPlaneService.getStaffProfile.mockResolvedValueOnce({ id: 42, userId: 7, status: 'ACTIVE', isGlobalSuperAdmin: true });
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValueOnce([{ id: 42, userId: 7, status: 'ACTIVE', presence: 'ONLINE', isGlobalSuperAdmin: true }]) };

    const res = await request(buildApp(prisma))
      .post('/api/admin/control-plane/staff/42/suspend')
      .send({ reason: 'Testing guard' });

    expect(res.status).toBe(403);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  test('suspends staff, forces offline presence, and audits lifecycle metadata', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    controlPlaneService.getStaffProfile
      .mockResolvedValueOnce({ id: 42, userId: 7, status: 'ACTIVE', isGlobalSuperAdmin: true })
      .mockResolvedValueOnce({ id: 42, userId: 7, status: 'ACTIVE', isGlobalSuperAdmin: true });
    const current = { id: 9, userId: 99, status: 'ACTIVE', presence: 'ONLINE', isGlobalSuperAdmin: false };
    const updated = { ...current, status: 'SUSPENDED', presence: 'OFFLINE' };
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValueOnce([current]).mockResolvedValueOnce([updated]) };

    const res = await request(buildApp(prisma))
      .post('/api/admin/control-plane/staff/9/suspend')
      .send({ reason: 'Security review' });

    expect(res.status).toBe(200);
    expect(res.body.staff.status).toBe('SUSPENDED');
    expect(res.body.staff.presence).toBe('OFFLINE');
    expect(controlPlaneService.recordActivity).toHaveBeenCalledWith(prisma, expect.objectContaining({
      staffProfileId: 9,
      actorUserId: 7,
      eventType: 'STAFF_SUSPENDED',
      metadata: expect.objectContaining({
        beforeStatus: 'ACTIVE',
        afterStatus: 'SUSPENDED',
        beforePresence: 'ONLINE',
        afterPresence: 'OFFLINE',
        reason: 'Security review',
      }),
    }));
  });
});
