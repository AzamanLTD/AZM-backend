jest.mock('../src/config/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
}));

jest.mock('../services/businessInvoiceService', () => ({
    payInvoice: jest.fn(),
}));

jest.mock('../services/businessReviewService', () => ({
    createReview: jest.fn(),
    listReviews: jest.fn(),
}));

jest.mock('../services/emailService', () => ({
    buildInvoiceEmail: jest.fn(),
    send: jest.fn(),
}));

jest.mock('../services/fiatSettlementService', () => ({
    settleFiatWithdrawal: jest.fn(),
}));

jest.mock('../services/providerSettlementAttemptService', () => ({
    recordProviderSettlementAttempt: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/notificationService', () => jest.fn().mockImplementation(() => ({
    sendNotification: jest.fn().mockResolvedValue(undefined),
})));

const invoiceSvc = require('../services/businessInvoiceService');
const bizNotificationService = require('../services/bizNotificationService');
const AdminAlertService = require('../services/adminAlertService');
const { payInvoice } = require('../controllers/businessInvoiceController');
const { settleFiatWithdrawal } = require('../services/fiatSettlementService');
const { moolreDisbursementWebhook } = require('../controllers/fiatSettlementWebhook.controller');

const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve));
const exactKeys = (value) => Object.keys(value).sort();

const createResponse = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
});

const createApp = (values) => ({
    get: jest.fn((key) => values[key]),
});

describe('final realtime event contracts', () => {
    beforeEach(() => jest.clearAllMocks());

    describe('invoice_paid', () => {
        test('targets payer and business owner with the exact committed payload', async () => {
            let paymentCommitted = false;
            const customerEmit = jest.fn((event) => {
                expect(paymentCommitted).toBe(true);
                expect(event).toBe('invoice_paid');
            });
            const businessEmit = jest.fn((event) => {
                expect(paymentCommitted).toBe(true);
                expect(event).toBe('invoice_paid');
            });
            const io = {
                to: jest.fn((room) => ({
                    emit: room === 'user_101' ? customerEmit : businessEmit,
                })),
            };
            invoiceSvc.payInvoice.mockImplementation(async () => {
                paymentCommitted = true;
                return {
                    invoice: {
                        id: 'invoice-1',
                        invoiceRef: 'INV-260901-TEST',
                        businessProfile: { userId: 202, businessName: 'Test Business' },
                    },
                    customerPays: 31.5,
                    businessReceives: 30,
                    fee: 1.5,
                    alreadyPaid: false,
                };
            });

            await payInvoice({
                user: { id: 101 },
                body: { tipUsdc: 0, customerNote: null, customerCoveredFee: false },
                params: { invoiceId: 'invoice-1' },
                app: createApp({ prisma: {}, socketio: io, emitBalanceUpdate: null }),
            }, createResponse());
            await flushMicrotasks();

            expect(io.to).toHaveBeenNthCalledWith(1, 'user_101');
            expect(io.to).toHaveBeenNthCalledWith(2, 'user_202');
            const customerPayload = customerEmit.mock.calls[0][1];
            expect(exactKeys(customerPayload)).toEqual([
                'businessReceives',
                'customerPaidUsdc',
                'fee',
                'invoiceId',
                'invoiceRef',
            ]);
            expect(customerPayload).toEqual({
                invoiceId: 'invoice-1',
                invoiceRef: 'INV-260901-TEST',
                customerPaidUsdc: 31.5,
                businessReceives: 30,
                fee: 1.5,
            });
            expect(businessEmit).toHaveBeenCalledWith('invoice_paid', customerPayload);
        });

        test('does not emit on an idempotent replay', async () => {
            const io = { to: jest.fn(() => ({ emit: jest.fn() })) };
            invoiceSvc.payInvoice.mockResolvedValue({
                invoice: { id: 'invoice-2' },
                customerPays: 20,
                alreadyPaid: true,
            });

            await payInvoice({
                user: { id: 101 }, body: {}, params: { invoiceId: 'invoice-2' },
                app: createApp({ prisma: {}, socketio: io }),
            }, createResponse());
            await flushMicrotasks();

            expect(io.to).not.toHaveBeenCalled();
        });
    });

    describe('biz_notification', () => {
        test('persists the canonical notification before emitting the user-scoped signal', async () => {
            let notificationCommitted = false;
            const emit = jest.fn((event, payload) => {
                expect(notificationCommitted).toBe(true);
                expect(event).toBe('biz_notification');
                expect(exactKeys(payload)).toEqual([
                    'businessProfileId', 'createdAt', 'escrowId', 'notificationId',
                    'orderId', 'orderRef', 'ticketId', 'type',
                ]);
            });
            bizNotificationService.setSocketIO({ to: jest.fn(() => ({ emit })) });

            const notification = {
                id: 'notification-1', businessProfileId: 'business-1',
                type: 'ORDER_SETTLED', createdAt: new Date('2026-09-01T06:00:00.000Z'),
                metadata: null,
            };
            const order = {
                id: 'order-1', businessProfileId: 'business-1', productId: 'product-1',
                ticketId: 'ticket-1', title: 'Test Order', amountUsdc: 42,
                orderRef: 'ORD-01', businessProfile: { userId: 303 },
            };
            const prisma = {
                businessOrder: { findFirst: jest.fn().mockResolvedValue(order) },
                businessNotification: { create: jest.fn(async () => {
                    notificationCommitted = true;
                    return notification;
                }) },
            };

            const result = await bizNotificationService.notifyOrderEvent(prisma, {
                escrowId: 'escrow-1', type: 'ORDER_SETTLED',
            });

            expect(result.notification).toEqual(notification);
            expect(emit).toHaveBeenCalledWith('biz_notification', {
                notificationId: 'notification-1',
                businessProfileId: 'business-1',
                type: 'ORDER_SETTLED',
                orderId: 'order-1', orderRef: 'ORD-01', ticketId: 'ticket-1',
                escrowId: null,
                createdAt: notification.createdAt,
            });
        });

        test('returns the failed notification result without emitting when persistence fails', async () => {
            const emit = jest.fn();
            bizNotificationService.setSocketIO({ to: jest.fn(() => ({ emit })) });
            const order = {
                id: 'order-2', businessProfileId: 'business-2', ticketId: 'ticket-2',
                orderRef: 'ORD-02', amountUsdc: 10, businessProfile: { userId: 404 },
            };
            const prisma = {
                businessOrder: { findFirst: jest.fn().mockResolvedValue(order) },
                businessNotification: { create: jest.fn().mockRejectedValue(new Error('DB_WRITE_FAILED')) },
            };

            const result = await bizNotificationService.notifyOrderEvent(prisma, {
                escrowId: 'escrow-2', type: 'ORDER_SETTLED',
            });

            expect(result).toEqual({ notification: null, order });
            expect(emit).not.toHaveBeenCalled();
        });
    });

    describe('withdrawal admin_alert topology', () => {
        test('withdrawal settlement emits user projections plus admin_spy admin_alert with exact payload', async () => {
            process.env.MOOLRE_WEBHOOK_SECRET = 'contract-secret';
            settleFiatWithdrawal.mockResolvedValue({
                changed: true, userId: 505, reference: 'withdrawal-contract-1',
                status: 'COMPLETED', providerTxId: 'provider-tx-1',
            });

            const userEmit = jest.fn();
            const adminEmit = jest.fn();
            const io = {
                to: jest.fn((room) => ({ emit: room === 'admin_spy' ? adminEmit : userEmit })),
            };
            await moolreDisbursementWebhook({
                headers: { 'x-moolre-webhook-secret': 'contract-secret' },
                body: { externalref: 'withdrawal-contract-1', txstatus: 1 },
                app: createApp({ prisma: {}, socketio: io, emitBalanceUpdate: null }),
            }, createResponse());

            expect(io.to).toHaveBeenNthCalledWith(1, 'user_505');
            expect(io.to).toHaveBeenNthCalledWith(2, 'user_505');
            expect(io.to).toHaveBeenNthCalledWith(3, 'admin_spy');

            expect(exactKeys(adminEmit.mock.calls[0][1])).toEqual([
                'changed', 'providerTxId', 'reference', 'status', 'timestamp', 'type',
            ]);
            expect(adminEmit).toHaveBeenCalledWith('admin_alert', expect.objectContaining({
                type: 'WITHDRAWAL_SETTLED', reference: 'withdrawal-contract-1',
                status: 'COMPLETED', providerTxId: 'provider-tx-1', changed: true,
            }));
            expect(userEmit).toHaveBeenCalledWith('withdrawal_progress', expect.objectContaining({
                reference: 'withdrawal-contract-1', status: 'COMPLETED', pct: 100,
            }));
            expect(userEmit).toHaveBeenCalledWith('withdrawal_settled', expect.objectContaining({
                reference: 'withdrawal-contract-1', status: 'COMPLETED', providerTxId: 'provider-tx-1', changed: true,
            }));
        });
    });

    describe('adminAlertService room boundary', () => {
        test('generic operational admin alerts retain the canonical admin_spy_room destination', () => {
            const io = { to: jest.fn(() => ({ emit: jest.fn() })) };
            const service = new AdminAlertService({ io });
            service.emit('LARGE_WITHDRAWAL_PENDING', {
                withdrawalId: 'withdrawal-1', userId: 505, amount: 900,
            });
            expect(io.to).toHaveBeenCalledWith('admin_spy_room');
        });
    });
});
