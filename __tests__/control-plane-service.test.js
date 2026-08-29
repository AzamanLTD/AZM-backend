const { hasPermission } = require('../services/controlPlaneService');

describe('controlPlaneService authorization', () => {
  test('legacy ADMIN keeps full compatibility access', async () => {
    const prisma = { $queryRawUnsafe: jest.fn() };
    await expect(hasPermission(prisma, { id: 1, role: 'ADMIN' }, 'anything.manage')).resolves.toBe(true);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('missing staff profile is denied for non-admin users', async () => {
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValueOnce([]) };
    await expect(hasPermission(prisma, { id: 2, role: 'USER' }, 'staff.view')).resolves.toBe(false);
  });

  test('inactive staff profile is denied', async () => {
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValueOnce([{ id: 10, status: 'INACTIVE', authorityClass: 'EMPLOYEE' }]) };
    await expect(hasPermission(prisma, { id: 2, role: 'USER' }, 'staff.view')).resolves.toBe(false);
  });

  test('suspended staff profile is denied', async () => {
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValueOnce([{ id: 10, status: 'SUSPENDED', authorityClass: 'EMPLOYEE' }]) };
    await expect(hasPermission(prisma, { id: 2, role: 'USER' }, 'staff.view')).resolves.toBe(false);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  test('global super admin is granted any permission', async () => {
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValueOnce([{ id: 10, status: 'ACTIVE', authorityClass: 'ADMIN', isGlobalSuperAdmin: true, adminType: 'SUPER_ADMIN' }]) };
    await expect(hasPermission(prisma, { id: 2, role: 'USER' }, 'funds.move')).resolves.toBe(true);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  test('non-global SUPER_ADMIN staff profile is not granted implicit global access', async () => {
    const prisma = { $queryRawUnsafe: jest.fn()
      .mockResolvedValueOnce([{ id: 10, status: 'ACTIVE', authorityClass: 'ADMIN', isGlobalSuperAdmin: false, adminType: 'SUPER_ADMIN' }])
      .mockResolvedValueOnce([{ key: 'staff.view' }]) };
    await expect(hasPermission(prisma, { id: 2, role: 'USER' }, 'funds.move')).resolves.toBe(false);
  });

  test('active staff receives explicitly granted permission', async () => {
    const prisma = { $queryRawUnsafe: jest.fn()
      .mockResolvedValueOnce([{ id: 11, status: 'ACTIVE', authorityClass: 'EMPLOYEE', isGlobalSuperAdmin: false, adminType: null }])
      .mockResolvedValueOnce([{ key: 'disputes.investigate' }]) };
    await expect(hasPermission(prisma, { id: 3, role: 'USER' }, 'disputes.investigate')).resolves.toBe(true);
  });

  test('active staff is denied an ungranted permission', async () => {
    const prisma = { $queryRawUnsafe: jest.fn()
      .mockResolvedValueOnce([{ id: 12, status: 'ACTIVE', authorityClass: 'EMPLOYEE', isGlobalSuperAdmin: false, adminType: null }])
      .mockResolvedValueOnce([{ key: 'disputes.view' }]) };
    await expect(hasPermission(prisma, { id: 4, role: 'USER' }, 'withdrawals.approve')).resolves.toBe(false);
  });
});
