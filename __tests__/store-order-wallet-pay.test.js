// =============================================================================
// Store orders paid from the wallet (escrow-protected checkout).
//
// In-memory Prisma (helpers/transitPrismaFake), the real escrow and order
// services, the ledger mocked:
//   • escrow-protected checkout is on for a store unless it turned it off
//   • funding holds the price; the store is not paid yet
//   • handing the order over marks the store's side; the buyer's "Got it"
//     then releases the payment and completes the order
//   • with no answer, the store is paid 72h after delivery, not before,
//     never twice, and never when the buyer reported a problem
//   • an order that was never handed over is never released by that sweep
//   • an unpaid order whose payment hold lapses is cancelled, not "refunded"
// Real PostgreSQL (the relation filter, the lock) is store-order-wallet-pay.pg.test.js.
// =============================================================================

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/securityCheck', () => ({ runDoubleCheck: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/ledgerService', () => ({ post: jest.fn().mockResolvedValue({ replayed: false }) }));
jest.mock('../services/webhookEmitter', () => ({ emitWebhookEvent: jest.fn() }));

const { table } = require('./helpers/transitPrismaFake');
const escrowService = require('../services/escrowService');
const orders = require('../services/businessOrderService');

const HOUR = 60 * 60 * 1000;
const HOLD = orders.ORDER_RELEASE_AFTER_DELIVERY_MS;
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

// A buyer (10) with 100 USDC, a store (bp-1, owner 20), and an order made by
// escrow checkout: AWAITING_PAYMENT with a DRAFT escrow of 5 + 0.05 fee.
function makeDb() {
    const db = {
        user: table([
            { id: 10, availableBalance: 100, escrowLockedBalance: 0, disputeEscrowBalance: 0 },
            { id: 20, availableBalance: 0, escrowLockedBalance: 0, disputeEscrowBalance: 0 },
        ]),
        businessProfile: table([{ id: 'bp-1', userId: 20, businessName: 'Kofi Bakery' }]),
        ticket: table([{ id: 't-1', status: 'OPEN', creatorId: 10, counterpartyId: 20 }]),
        smartEscrow: table([{
            id: 'esc-1', ticketId: 't-1', payerId: 10, payeeId: 20, amountUsdc: 5, feeUsdc: 0.05,
            status: 'DRAFT', payerSatisfied: false, payeeSatisfied: false,
            expiresAt: new Date(Date.now() + 24 * HOUR),
        }]),
        businessOrder: table([{
            id: 'ord-1', businessProfileId: 'bp-1', customerId: 10, status: 'AWAITING_PAYMENT',
            orderRef: 'ORD-1', title: 'Bread', escrowId: 'esc-1', ticketId: 't-1', amountUsdc: 5,
        }], (row, key) => (key === 'escrow'
            ? db.smartEscrow.rows.find((e) => e.id === row.escrowId) || null
            : row[key])),
        globalSettings: table([{ id: 1, escrowFundedExpiryDays: 30 }]),
        systemProfitFees: table([{ id: 1, balance: 0 }]),
        transactionHistory: table([]),
        adminProfitLog: table([]),
        ticketMessage: table([]),
        businessNotification: table([]),
        $executeRaw: jest.fn(async () => 1),
    };
    db.$transaction = jest.fn(async (cb) => cb(db));
    return db;
}
const user = (db, id) => db.user.rows.find((u) => u.id === id);
const escrow = (db) => db.smartEscrow.rows[0];
const order = (db) => db.businessOrder.rows[0];

async function paid() {
    const db = makeDb();
    await escrowService.fundEscrow(db, { escrowId: 'esc-1', payerId: 10 });
    await flush();
    return db;
}
async function handedOver() {
    const db = await paid();
    await orders.markDelivered(db, { orderId: 'ord-1', businessProfileId: 'bp-1' });
    await flush();
    return db;
}

describe('escrow-protected checkout is the default', () => {
    test('on unless the store turned it off', () => {
        const { _escrowProtectionAvailable } = require('../services/storefrontRenderService');
        expect(_escrowProtectionAvailable({ businessMeta: null })).toBe(true);
        expect(_escrowProtectionAvailable({ businessMeta: { cuisine: 'local' } })).toBe(true);
        expect(_escrowProtectionAvailable({ businessMeta: { escrowProtection: { enabled: true } } })).toBe(true);
        expect(_escrowProtectionAvailable({ businessMeta: { escrowProtection: { enabled: false } } })).toBe(false);
        expect(_escrowProtectionAvailable({ businessMeta: '{"escrowProtection":{"enabled":false}}' })).toBe(false);
        expect(_escrowProtectionAvailable(null)).toBe(false);
    });
});

describe('paying a store order from the wallet', () => {
    test('funding holds the price; the store is not paid yet', async () => {
        const db = await paid();
        expect(escrow(db).status).toBe('FUNDED');
        expect(user(db, 10).availableBalance).toBeCloseTo(100 - 5.05, 9);
        expect(user(db, 10).escrowLockedBalance).toBeCloseTo(5, 9);
        expect(user(db, 20).availableBalance).toBe(0);
        expect(order(db).status).toBe('PAID');
    });

    test('handing it over marks the store\'s side, and pays nothing yet', async () => {
        const db = await handedOver();
        expect(order(db).status).toBe('DELIVERED');
        expect(order(db).deliveredAt).toBeInstanceOf(Date);
        expect(escrow(db).payeeSatisfied).toBe(true);
        expect(escrow(db).status).toBe('PENDING_SETTLEMENT');
        expect(user(db, 20).availableBalance).toBe(0);
    });

    test('the buyer\'s "Got it" releases the payment and completes the order', async () => {
        const db = await handedOver();
        const out = await escrowService.markSatisfied(db, { escrowId: 'esc-1', userId: 10 });
        await flush();
        expect(out.settled).toBe(true);
        expect(escrow(db).status).toBe('SETTLED');
        expect(user(db, 20).availableBalance).toBeCloseTo(5, 9);
        expect(user(db, 10).escrowLockedBalance).toBeCloseTo(0, 9);
        expect(order(db).status).toBe('COMPLETED');
    });

    test('the delivery time is written once', async () => {
        const db = await handedOver();
        const first = order(db).deliveredAt;
        await expect(orders.markDelivered(db, { orderId: 'ord-1', businessProfileId: 'bp-1' }))
            .rejects.toThrow(/PAID status/);
        expect(order(db).deliveredAt).toBe(first);
    });
});

describe('release after delivery', () => {
    test('the store is paid 72h after handing over, not before, and once', async () => {
        const db = await handedOver();
        const at = order(db).deliveredAt.getTime();

        const early = await orders.releaseDeliveredOrders(db, { now: at + HOLD - 60 * 1000 });
        expect(early.released).toBe(0);
        expect(user(db, 20).availableBalance).toBe(0);

        const due = await orders.releaseDeliveredOrders(db, { now: at + HOLD });
        expect(due.released).toBe(1);
        expect(due.releasedOrders).toEqual(['ord-1']);
        expect(escrow(db).status).toBe('SETTLED');
        expect(order(db).status).toBe('COMPLETED');
        expect(user(db, 20).availableBalance).toBeCloseTo(5, 9);
        expect(user(db, 10).escrowLockedBalance).toBeCloseTo(0, 9);
        expect(db.$executeRaw).toHaveBeenCalled();

        const again = await orders.releaseDeliveredOrders(db, { now: at + 2 * HOLD });
        expect(again.released).toBe(0);
        expect(user(db, 20).availableBalance).toBeCloseTo(5, 9);
    });

    test('a reported problem is never released by the sweep', async () => {
        const db = await handedOver();
        escrow(db).status = 'DISPUTED';
        const out = await orders.releaseDeliveredOrders(db, { now: Date.now() + 10 * HOLD });
        expect(out.released).toBe(0);
        expect(user(db, 20).availableBalance).toBe(0);
        expect(order(db).status).toBe('DELIVERED');
    });

    test('an order never handed over is not released, however old', async () => {
        const db = await paid();
        order(db).deliveredAt = new Date(Date.now() - 30 * 24 * HOUR); // stale field, status still PAID
        const out = await orders.releaseDeliveredOrders(db, { now: Date.now() + 10 * HOLD });
        expect(out.released).toBe(0);
        expect(escrow(db).status).toBe('FUNDED');
    });

    test('the worker runs it and tells both sides', async () => {
        const db = await handedOver();
        const sendNotification = jest.fn().mockResolvedValue(undefined);
        const EscrowExpiryWorker = require('../workers/escrowExpiryWorker');
        const Worker = EscrowExpiryWorker.EscrowExpiryWorker || EscrowExpiryWorker;
        const worker = new Worker(db, null, { sendNotification }, {});
        db.businessOrder.rows[0].businessProfile = { userId: 20, businessName: 'Kofi Bakery' };
        await worker._releaseDeliveredOrders(new Date(Date.now() + HOLD + HOUR));
        expect(user(db, 20).availableBalance).toBeCloseTo(5, 9);
        expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 10, title: 'Order complete' }));
        expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 20, title: 'Payment released' }));
    });
});

describe('an unpaid order', () => {
    test('whose payment hold lapses is cancelled with the escrow, in one commit', async () => {
        const db = makeDb();
        escrow(db).expiresAt = new Date(Date.now() - 1000);
        const EscrowExpiryWorker = require('../workers/escrowExpiryWorker');
        const Worker = EscrowExpiryWorker.EscrowExpiryWorker || EscrowExpiryWorker;
        await new Worker(db, null, null, {})._expireUnfunded(new Date());
        expect(escrow(db).status).toBe('EXPIRED');
        expect(order(db).status).toBe('CANCELLED');
        expect(order(db).cancelledAt).toBeInstanceOf(Date);
        expect(user(db, 10).availableBalance).toBe(100);
    });

    test('an expired escrow cancels an unpaid order but refunds a paid one', async () => {
        const db = makeDb();
        escrow(db).status = 'EXPIRED';
        await orders.updateOrderStatusFromEscrow(db, 'esc-1', 'EXPIRED');
        expect(order(db).status).toBe('CANCELLED');

        const paidDb = makeDb();
        order(paidDb).status = 'PAID';
        await orders.updateOrderStatusFromEscrow(paidDb, 'esc-1', 'EXPIRED');
        expect(order(paidDb).status).toBe('REFUNDED');
    });
});
