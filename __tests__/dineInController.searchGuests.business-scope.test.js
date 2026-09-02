describe('dineInController.searchGuests', () => {
    beforeEach(() => jest.resetModules());

    test('searches only customers who have dine-in history with the requesting business', async () => {
        jest.mock('../services/dineInTabService', () => ({}));
        const controller = require('../controllers/dineInController');
        const prisma = {
            businessProfile: { findFirst: jest.fn().mockResolvedValue({ id: 'business-a' }) },
            dineInTab: {
                findMany: jest.fn().mockResolvedValue([
                    { customer: { id: 1, username: 'alice', azamanId: 'AZM-1' } },
                ]),
            },
        };
        const req = { prisma, app: { get: () => prisma }, user: { id: 99 }, query: { query: 'ali' } };
        const json = jest.fn();
        const res = { json, status: jest.fn().mockReturnThis() };

        await controller.searchGuests(req, res);

        expect(prisma.businessProfile.findFirst).toHaveBeenCalledWith({
            where: { userId: 99 },
            select: { id: true },
        });
        expect(prisma.dineInTab.findMany).toHaveBeenCalledWith({
            where: {
                businessProfileId: 'business-a',
                customer: {
                    OR: [
                        { username: { contains: 'ali', mode: 'insensitive' } },
                        { azamanId: { contains: 'ali', mode: 'insensitive' } },
                    ],
                },
            },
            select: { customer: { select: { id: true, username: true, azamanId: true } } },
            distinct: ['customerId'],
            take: 10,
        });
        expect(json).toHaveBeenCalledWith({
            success: true,
            guests: [{ id: 1, username: 'alice', azamanId: 'AZM-1' }],
        });
    });
});
