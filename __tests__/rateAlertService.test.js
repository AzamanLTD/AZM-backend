const RateAlertService = require('../services/rateAlertService');

describe('RateAlertService', () => {
  test('new alerts default to the canonical USDC_GHS pair', async () => {
    const prisma = {
      rateAlert: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'a1', ratePair: 'USDC_GHS' }),
      },
    };
    const service = new RateAlertService(prisma, {});

    await service.createAlert(7, { targetRate: 13.5, direction: 'above' });

    expect(prisma.rateAlert.create).toHaveBeenCalledWith({
      data: {
        userId: 7,
        targetRate: 13.5,
        direction: 'ABOVE',
        ratePair: 'USDC_GHS',
        note: null,
      },
    });
  });

  test('explicit legacy USD_GHS alerts remain supported', async () => {
    const prisma = {
      rateAlert: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'legacy', ratePair: 'USD_GHS' }),
      },
    };
    const service = new RateAlertService(prisma, {});

    await service.createAlert(7, {
      targetRate: 13,
      direction: 'BELOW',
      ratePair: 'USD_GHS',
    });

    expect(prisma.rateAlert.create).toHaveBeenCalledWith({
      data: {
        userId: 7,
        targetRate: 13,
        direction: 'BELOW',
        ratePair: 'USD_GHS',
        note: null,
      },
    });
  });

  test('canonical checks evaluate both canonical and legacy rows', async () => {
    const above = { id: 'above', userId: 1, targetRate: 13, note: null, ratePair: 'USDC_GHS', direction: 'ABOVE' };
    const below = { id: 'below', userId: 2, targetRate: 13, note: null, ratePair: 'USD_GHS', direction: 'BELOW' };
    const prisma = {
      rateAlert: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([above])
          .mockResolvedValueOnce([below]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const notifications = [];
    const notificationService = {
      sendNotification: jest.fn(async (payload) => notifications.push(payload)),
    };
    const service = new RateAlertService(prisma, notificationService);

    await service.checkAlerts(13, 'USDC_GHS');
    await new Promise((resolve) => setImmediate(resolve));

    expect(prisma.rateAlert.findMany).toHaveBeenCalledTimes(2);
    for (const call of prisma.rateAlert.findMany.mock.calls) {
      expect(call[0].where.ratePair.in).toEqual(['USDC_GHS', 'USD_GHS']);
    }
    expect(prisma.rateAlert.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['above', 'below'] }, isTriggered: false, isActive: true },
      data: expect.objectContaining({
        isTriggered: true,
        triggeredRate: 13,
        isActive: false,
      }),
    }));
    expect(notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        body: expect.stringContaining('USDC/GHS is now 13.00'),
      }),
      expect.objectContaining({
        body: expect.stringContaining('below target of 13.00'),
      }),
    ]));
  });

  test('rejects unsupported pair names for new alerts', async () => {
    const prisma = {
      rateAlert: { count: jest.fn().mockResolvedValue(0) },
    };
    const service = new RateAlertService(prisma, {});

    await expect(service.createAlert(7, { targetRate: 13, ratePair: 'EUR_GHS' }))
      .rejects.toThrow('ratePair must be USDC_GHS');
  });
});
