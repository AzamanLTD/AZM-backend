'use strict';

jest.mock('../services/marketplace/dineInService', () => {
    return jest.fn().mockImplementation(() => ({
        confirmAndPay: jest.fn(),
        getTab: jest.fn(),
        confirmTab: jest.fn(),
    }));
});

jest.mock('../services/dineInTabMutationService', () => ({
    addItem: jest.fn(),
    addCustomerItem: jest.fn(),
    removeItem: jest.fn(),
}));

jest.mock('../services/bizNotificationService', () => ({
    notifyDineInEvent: jest.fn().mockResolvedValue(null),
}));

describe('dine-in payment durable replay convergence', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    test('returns successful replay when payment errors after invoice payment and tab closure committed', async () => {
        const DineInService = require('../services/marketplace/dineInService');
        const instance = DineInService.mock.results[0]?.value;
        instance.confirmAndPay.mockRejectedValue(new Error('socket timeout'));
        instance.getTab.mockResolvedValue({
            id: 'tab-1',
            customerId: 7,
            status: 'CLOSED',
            businessProfileId: 'biz-1',
            invoice: {
                id: 'invoice-1',
                status: 'PAID',
                payTxHash: 'INV_PAY_invoice-1',
                billTotalUsdc: 20,
                tipUsdc: 2,
                customerPaidUsdc: 22.33,
                feeUsdc: 0.33,
                customerCoveredFee: true,
            },
        });

        const adapter = require('../services/dineInTabService');
        const result = await adapter.confirmAndPay({ marker: 'prisma' }, {
            tabId: 'tab-1',
            customerId: 7,
            tipUsdc: 2,
            io: null,
        });

        expect(result).toMatchObject({
            tab: { id: 'tab-1', status: 'CLOSED' },
            invoice: { id: 'invoice-1', status: 'PAID', payTxHash: 'INV_PAY_invoice-1' },
            payment: {
                customerPays: 22.33,
                fee: 0.33,
                alreadyPaid: true,
            },
        });
        expect(instance.confirmTab).not.toHaveBeenCalled();
    });

    test('does not convert another customer\'s paid tab into a successful replay', async () => {
        const DineInService = require('../services/marketplace/dineInService');
        const instance = DineInService.mock.results[0]?.value;
        instance.confirmAndPay.mockRejectedValue(new Error('socket timeout'));
        instance.getTab.mockResolvedValue({
            id: 'tab-2',
            customerId: 99,
            status: 'CLOSED',
            invoice: {
                id: 'invoice-2',
                status: 'PAID',
                payTxHash: 'INV_PAY_invoice-2',
                billTotalUsdc: 10,
                tipUsdc: 0,
                customerPaidUsdc: 10,
                feeUsdc: 0,
                customerCoveredFee: false,
            },
        });

        const adapter = require('../services/dineInTabService');
        const originalError = new Error('socket timeout');
        instance.confirmAndPay.mockRejectedValueOnce(originalError);

        await expect(adapter.confirmAndPay({ marker: 'prisma' }, {
            tabId: 'tab-2',
            customerId: 7,
            io: null,
        })).rejects.toBe(originalError);
        expect(instance.confirmTab).not.toHaveBeenCalled();
    });
});
