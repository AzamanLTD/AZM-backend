const { BusinessGroupService } = require('../services/businessOS/businessGroupService');

describe('BusinessGroupService tenant isolation', () => {
  test('requires the requested group to belong to the calling owner', async () => {
    const prisma = {
      businessGroup: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      businessProfile: {
        findMany: jest.fn(),
      },
    };

    const service = new BusinessGroupService(prisma);
    const result = await service.getGroupStats(101, 'group-owned-by-202');

    expect(prisma.businessGroup.findFirst).toHaveBeenCalledWith({
      where: { id: 'group-owned-by-202', ownerUserId: 101 },
      select: { id: true },
    });
    expect(prisma.businessProfile.findMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      totalRevenue: 0,
      totalOrders: 0,
      totalEmployees: 0,
      avgRating: 0,
      businesses: [],
    });
  });

  test('scopes group businesses to the calling owner after group ownership is verified', async () => {
    const prisma = {
      businessGroup: {
        findFirst: jest.fn().mockResolvedValue({ id: 'group-101' }),
      },
      businessProfile: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const service = new BusinessGroupService(prisma);
    await service.getGroupStats(101, 'group-101');

    expect(prisma.businessProfile.findMany).toHaveBeenCalledWith({
      where: { groupId: 'group-101', userId: 101 },
      select: { id: true, businessName: true, category: true, address: true,
                totalVolume: true, totalEscrows: true, completedEscrows: true,
                averageRating: true, reviewCount: true },
    });
  });
});
