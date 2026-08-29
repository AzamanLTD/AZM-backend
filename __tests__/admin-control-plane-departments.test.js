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

describe('admin control-plane departments API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    controlPlaneService.getStaffProfile.mockResolvedValue({ id: 42, status: 'ACTIVE', isGlobalSuperAdmin: true });
    controlPlaneService.recordActivity.mockResolvedValue(undefined);
  });

  test('lists departments with staff counts for staff viewers', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValueOnce([
        { id: 1, name: 'Escrow', description: 'Dispute operations', isActive: true, staffCount: 3 },
      ]),
    };

    const res = await request(buildApp(prisma)).get('/api/admin/control-plane/departments');

    expect(res.status).toBe(200);
    expect(res.body.departments).toHaveLength(1);
    expect(controlPlaneService.hasPermission).toHaveBeenCalledWith(prisma, { id: 7, role: 'USER' }, 'staff.view');
  });

  test('requires departments.manage to create departments', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(false);
    const prisma = { $queryRawUnsafe: jest.fn() };

    const res = await request(buildApp(prisma))
      .post('/api/admin/control-plane/departments')
      .send({ name: 'Escrow Operations' });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('departments.manage');
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('creates and audits a valid department', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    const created = { id: 9, name: 'Escrow Operations', description: 'Dispute owners', isActive: true };
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValueOnce([created]) };

    const res = await request(buildApp(prisma))
      .post('/api/admin/control-plane/departments')
      .send({ name: '  Escrow Operations  ', description: 'Dispute owners' });

    expect(res.status).toBe(201);
    expect(res.body.department).toEqual(created);
    expect(controlPlaneService.recordActivity).toHaveBeenCalledWith(prisma, expect.objectContaining({
      staffProfileId: 42,
      actorUserId: 7,
      eventType: 'DEPARTMENT_CREATED',
      targetType: 'CONTROL_DEPARTMENT',
      targetId: 9,
    }));
  });

  test('rejects department updates without fields', async () => {
    controlPlaneService.hasPermission.mockResolvedValue(true);
    const prisma = { $queryRawUnsafe: jest.fn() };

    const res = await request(buildApp(prisma))
      .patch('/api/admin/control-plane/departments/1')
      .send({});

    expect(res.status).toBe(400);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
