const access = require('../services/platformAccessService');

describe('platformAccessService', () => {
  test('defines only supported administrator types', () => {
    expect([...access.ADMIN_TYPES]).toEqual(expect.arrayContaining([
      'SUPER_ADMIN',
      'FINANCE_ADMIN',
      'SUPPORT_ADMIN',
      'COMPLIANCE_ADMIN',
      'READ_ONLY_ADMIN',
    ]));
    expect(access.ADMIN_TYPES.has('EMPLOYEE')).toBe(false);
  });

  test('defines distinct staff types', () => {
    expect(access.STAFF_TYPES.has('ADMIN')).toBe(true);
    expect(access.STAFF_TYPES.has('EMPLOYEE')).toBe(true);
  });

  test('rejects invalid staff type before database access', async () => {
    const prisma = { $queryRawUnsafe: jest.fn() };
    await expect(access.upsertStaffProfile(prisma, {
      userId: 1,
      staffType: 'OWNER',
    })).rejects.toThrow('invalid staffType');
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('rejects a CEO profile unless it is SUPER_ADMIN', async () => {
    const prisma = { $queryRawUnsafe: jest.fn() };
    await expect(access.upsertStaffProfile(prisma, {
      userId: 1,
      staffType: 'ADMIN',
      adminType: 'FINANCE_ADMIN',
      isCeo: true,
    })).rejects.toThrow('CEO must be SUPER_ADMIN');
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('CEO and SUPER_ADMIN have implicit permission without a permission row', async () => {
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValueOnce([{
        id: 'staff-1', status: 'ACTIVE', isCeo: true, adminType: 'SUPER_ADMIN',
      }]),
    };
    await expect(access.hasPermission(prisma, 1, 'finance.manage')).resolves.toBe(true);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  test('inactive staff cannot exercise permissions', async () => {
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValueOnce([{
        id: 'staff-1', status: 'SUSPENDED', isCeo: false, adminType: 'FINANCE_ADMIN',
      }]),
    };
    await expect(access.hasPermission(prisma, 1, 'finance.view')).resolves.toBe(false);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });
});
