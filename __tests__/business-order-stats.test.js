jest.mock('../services/webhookEmitter', () => ({ emitWebhookEvent: jest.fn() }));

const { getBusinessStats } = require('../services/businessOrderService');

describe('businessOrderService.getBusinessStats', () => {
    afterEach(() => jest.useRealTimers());

    test('returns a complete 30-day revenue series independently of order-list pagination', async () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-09-03T15:30:00.000Z'));

        const prisma = {
            businessOrder: {
                count: jest.fn().mockResolvedValue(0),
                aggregate: jest.fn().mockResolvedValue({ _sum: { amountUsdc: '123.45' } }),
                findMany: jest.fn().mockResolvedValue([]),
            },
            businessInvoice: {
                count: jest.fn()
                    .mockResolvedValueOnce(7)
                    .mockResolvedValueOnce(4),
                aggregate: jest.fn().mockResolvedValue({ _sum: { billTotalUsdc: '91.25' } }),
            },
            $queryRaw: jest.fn().mockResolvedValue([
                { date: new Date('2026-08-05T00:00:00.000Z'), revenue: '4.25' },
                { date: new Date('2026-09-03T00:00:00.000Z'), revenue: '6.25' },
            ]),
        };

        const stats = await getBusinessStats(prisma, { businessProfileId: 'biz-1' });

        expect(stats.totalRevenue).toBeCloseTo(123.45);
        expect(stats.revenueByDay).toHaveLength(30);
        expect(stats.revenueByDay[0]).toMatchObject({ date: '2026-08-05', label: 'Aug 5', revenue: 4.25 });
        expect(stats.revenueByDay.at(-1)).toMatchObject({ date: '2026-09-03', label: 'Sep 3', revenue: 6.25 });
        expect(stats.revenueByDay.filter((day) => day.revenue === 0)).toHaveLength(28);
        expect(stats.invoiceStats).toEqual({ sent: 7, paid: 4, paidRevenue: 91.25 });
        expect(prisma.businessInvoice.count).toHaveBeenNthCalledWith(1, { where: { businessProfileId: 'biz-1', status: 'SENT' } });
        expect(prisma.businessInvoice.count).toHaveBeenNthCalledWith(2, { where: { businessProfileId: 'biz-1', status: 'PAID' } });
        expect(prisma.businessInvoice.aggregate).toHaveBeenCalledWith({
            where: { businessProfileId: 'biz-1', status: 'PAID' },
            _sum: { billTotalUsdc: true },
        });
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });
});
