// __tests__/force-cancel-audit-atomicity.test.js
// =============================================================================
// P0 regression (issue #252) — Admin War Room forceCancel audit atomicity.
//
// Pre-fix defect: forceCancel committed the DISPUTED -> CANCELLED claim, the
// escrow refund and the ADMIN_INTERVENTION message in ONE transaction, then
// sent the HTTP response, and only THEN wrote the FORCE_CANCEL_TRADE audit
// row through the fire-and-forget audit() helper (which intentionally
// swallows failures). A failed audit write therefore left a committed
// financial cancellation without its mandatory audit evidence.
//
// Post-fix invariants proven here:
//   [unit] audit() strict mode ({ throwOnError: true }) propagates failures;
//          default fire-and-forget behavior is unchanged for legacy callers.
//   [unit] E. forceCancel passes the TRANSACTION client to audit — a
//          regression guard against reintroducing a root-client audit.
//   [unit] Audit failure inside the transaction → 500, no post-commit
//          socket/balance side effects, no success response.
//   [real PostgreSQL]
//     A. Successful SELL cancellation: trade CANCELLED, exact escrow refund
//        to vendor unallocated balance, exactly one ADMIN_INTERVENTION
//        message, exactly one FORCE_CANCEL_TRADE audit row, post-commit
//        realtime still emitted, HTTP 200.
//     A2. Successful BUY cancellation: buyer escrow restored to
//         availableBalance (both directions covered).
//     B.  Injected AuditLog failure (DB trigger) rolls EVERYTHING back:
//         trade stays DISPUTED, balances unchanged, no message, no audit
//         row, no post-commit socket/balance effects, error response.
//     C.  Two concurrent forceCancel attempts: exactly one refund, exactly
//         one audit row, loser receives the 409 concurrency response.
// =============================================================================
const { PrismaClient } = require('@prisma/client');
const adminController = require('../controllers/adminController');
const { audit } = require('../utils/audit');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[force-cancel-audit-atomicity] TEST_DATABASE_URL not set — skipping real-DB suite.');

// ── shared req/res harness ──────────────────────────────────────────────────
const makeRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
};

const makeReq = (prisma, io, emitBalanceUpdate, { tradeId, adminNotes, userId = 1, username = 'warroom_admin' }) => ({
    app: { get: (key) => {
        if (key === 'prisma') return prisma;
        if (key === 'socketio') return io;
        if (key === 'emitBalanceUpdate') return emitBalanceUpdate;
        return undefined;
    } },
    body: { tradeId, adminNotes },
    user: { id: userId, username },
    ip: '127.0.0.1'
});

// ── unit: strict audit mode ───────────────────────────────────────────────────
describe('audit() strict mode', () => {
    const payload = {
        actorId: 1, actorName: 'admin', action: 'FORCE_CANCEL_TRADE',
        targetType: 'TRADE', targetId: '42', metadata: { k: 'v' }, ipAddress: '127.0.0.1'
    };

    test('default fire-and-forget swallows AuditLog failures (legacy callers unchanged)', async () => {
        const prisma = { auditLog: { create: jest.fn().mockRejectedValue(new Error('db down')) } };
        await expect(audit(prisma, payload)).resolves.toBeUndefined();
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ action: 'FORCE_CANCEL_TRADE', targetId: '42' })
        });
    });

    test('strict mode propagates the failure to abort the caller transaction', async () => {
        const boom = new Error('audit unavailable');
        const tx = { auditLog: { create: jest.fn().mockRejectedValue(boom) } };
        await expect(audit(tx, payload, { throwOnError: true })).rejects.toBe(boom);
    });

    test('strict mode writes through the transaction client it is given', async () => {
        const tx = { auditLog: { create: jest.fn().mockResolvedValue({}) } };
        await audit(tx, payload, { throwOnError: true });
        expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                actorId: 1,
                actorName: 'admin',
                action: 'FORCE_CANCEL_TRADE',
                targetType: 'TRADE',
                targetId: '42',
                metadata: { k: 'v' },
                ipAddress: '127.0.0.1'
            })
        });
    });
});

// ── unit: forceCancel audit wiring (mocked transaction) ────────────────────────
describe('forceCancel audit wiring (mocked transaction)', () => {
    test('E. strict audit runs on the TRANSACTION client, never the root client', async () => {
        const rootAuditCreate = jest.fn().mockResolvedValue({});
        const txAuditCreate = jest.fn().mockResolvedValue({});
        const io = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
        const emitBalanceUpdate = jest.fn();

        const trade = { id: 77, status: 'DISPUTED', type: 'SELL', amountCrypto: 2, userId: 11, vendorId: 22 };
        const tx = {
            trade: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
            user: { update: jest.fn().mockResolvedValue({}) },
            conversation: { findUnique: jest.fn().mockResolvedValue({ id: 'conv-1' }) },
            message: { create: jest.fn().mockResolvedValue({}) },
            auditLog: { create: txAuditCreate }
        };
        const prisma = {
            trade: { findUnique: jest.fn().mockResolvedValue(trade) },
            auditLog: { create: rootAuditCreate },
            $transaction: jest.fn(async (fn) => fn(tx))
        };

        const res = makeRes();
        await adminController.forceCancel(
            makeReq(prisma, io, emitBalanceUpdate, { tradeId: 77 }),
            res
        );

        expect(txAuditCreate).toHaveBeenCalledTimes(1);
        expect(txAuditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'FORCE_CANCEL_TRADE' }) });
        expect(rootAuditCreate).not.toHaveBeenCalled(); // regression guard: no post-commit root-client audit
        expect(res.status).toHaveBeenCalledWith(200);
    });

    test('audit failure inside the transaction → 500, no post-commit side effects', async () => {
        const tx = {
            trade: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
            user: { update: jest.fn().mockResolvedValue({}) },
            conversation: { findUnique: jest.fn().mockResolvedValue({ id: 'conv-1' }) },
            message: { create: jest.fn().mockResolvedValue({}) },
            auditLog: { create: jest.fn().mockRejectedValue(new Error('audit unavailable')) }
        };
        const io = { to: jest.fn() };
        const emitBalanceUpdate = jest.fn();
        const prisma = {
            trade: { findUnique: jest.fn().mockResolvedValue({ id: 78, status: 'DISPUTED', type: 'SELL', amountCrypto: 2, userId: 11, vendorId: 22 }) },
            $transaction: jest.fn(async (fn) => fn(tx))
        };

        const res = makeRes();
        await adminController.forceCancel(
            makeReq(prisma, io, emitBalanceUpdate, { tradeId: 78 }),
            res
        );

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
        expect(io.to).not.toHaveBeenCalled();             // no trade_update / notifications
        expect(emitBalanceUpdate).not.toHaveBeenCalled(); // no balance pushes
    });
});

// ── real PostgreSQL proofs ─────────────────────────────────────────────────────
describeOrSkip('forceCancel audit atomicity (real PostgreSQL)', () => {
    let prisma;

    beforeAll(() => { prisma = new PrismaClient(); });
    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    afterEach(async () => {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS azm_test_fail_audit ON "AuditLog"');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS azm_test_fail_audit()');
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "Trade", "Conversation", "Message", "AuditLog" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    const seedDisputedTrade = async ({ type }) => {
        const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        const buyer = await prisma.user.create({
            data: {
                username: `buyer_${suffix}`,
                email: `buyer_${suffix}@test.com`,
                password: 'x',
                azamanId: `AZM-B-${suffix}`,
                availableBalance: 0,
                escrowLockedBalance: type === 'BUY' ? 40 : 0,
                disputeEscrowBalance: 0
            }
        });
        const vendor = await prisma.user.create({
            data: {
                username: `vendor_${suffix}`,
                email: `vendor_${suffix}@test.com`,
                password: 'x',
                azamanId: `AZM-V-${suffix}`,
                availableBalance: 0,
                escrowLockedBalance: type === 'SELL' ? 40 : 0,
                vendorUnallocatedBalance: 10,
                disputeEscrowBalance: 0
            }
        });
        const trade = await prisma.trade.create({
            data: {
                crypto: 'BTC',
                amountCrypto: 40,
                amountFiat: 500,
                type,
                status: 'DISPUTED',
                userId: buyer.id,
                vendorId: vendor.id,
                expiresAt: new Date(Date.now() + 3_600_000)
            }
        });
        return { buyer, vendor, trade };
    };

    const freshBalances = ({ id }) =>
        prisma.user.findUnique({
            where: { id },
            select: { availableBalance: true, escrowLockedBalance: true, vendorUnallocatedBalance: true }
        });

    const auditRows = (tradeId) =>
        prisma.auditLog.findMany({ where: { action: 'FORCE_CANCEL_TRADE', targetId: String(tradeId) } });

    const interventionMessages = (tradeId) =>
        prisma.message.findMany({ where: { tradeId, messageType: 'ADMIN_INTERVENTION' } });

    const injectAuditFailure = async () => {
        await prisma.$executeRawUnsafe(
            'CREATE OR REPLACE FUNCTION azm_test_fail_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION \'injected audit failure\'; END; $$ LANGUAGE plpgsql'
        );
        await prisma.$executeRawUnsafe(
            'CREATE TRIGGER azm_test_fail_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION azm_test_fail_audit()'
        );
    };

    test('A. successful SELL cancellation commits refund + message + audit atomically', async () => {
        const { vendor, trade } = await seedDisputedTrade({ type: 'SELL' });
        const before = await freshBalances(vendor);

        const io = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
        const emitBalanceUpdate = jest.fn();
        const res = makeRes();
        await adminController.forceCancel(
            makeReq(prisma, io, emitBalanceUpdate, { tradeId: trade.id, adminNotes: 'refund buyer' }),
            res
        );

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Force Cancel Successful.' });

        const afterTrade = await prisma.trade.findUnique({ where: { id: trade.id } });
        expect(afterTrade.status).toBe('CANCELLED');

        const after = await freshBalances(vendor);
        expect(Number(after.escrowLockedBalance)).toBe(Number(before.escrowLockedBalance) - 40);
        expect(Number(after.vendorUnallocatedBalance)).toBe(Number(before.vendorUnallocatedBalance) + 40);

        expect(await interventionMessages(trade.id)).toHaveLength(1);
        expect(await auditRows(trade.id)).toHaveLength(1);

        // post-commit realtime still occurs
        expect(emitBalanceUpdate).toHaveBeenCalledTimes(2);
        expect(io.to).toHaveBeenCalledWith(`trade_${trade.id}`);
    });

    test('A2. successful BUY cancellation restores buyer escrow to availableBalance', async () => {
        const { buyer, trade } = await seedDisputedTrade({ type: 'BUY' });
        const before = await freshBalances(buyer);

        const res = makeRes();
        await adminController.forceCancel(
            makeReq(prisma, { to: jest.fn().mockReturnThis(), emit: jest.fn() }, jest.fn(), { tradeId: trade.id }),
            res
        );

        expect(res.status).toHaveBeenCalledWith(200);
        const after = await freshBalances(buyer);
        expect(Number(after.escrowLockedBalance)).toBe(Number(before.escrowLockedBalance) - 40);
        expect(Number(after.availableBalance)).toBe(Number(before.availableBalance) + 40);
        expect(await auditRows(trade.id)).toHaveLength(1);
        expect((await prisma.trade.findUnique({ where: { id: trade.id } })).status).toBe('CANCELLED');
    });

    test('B. injected AuditLog failure rolls back the ENTIRE cancellation', async () => {
        const { vendor, trade } = await seedDisputedTrade({ type: 'SELL' });
        const beforeVendor = await freshBalances(vendor);
        await injectAuditFailure();

        const io = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
        const emitBalanceUpdate = jest.fn();
        const res = makeRes();
        await adminController.forceCancel(
            makeReq(prisma, io, emitBalanceUpdate, { tradeId: trade.id, adminNotes: 'must fail' }),
            res
        );

        // error, never false success
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));

        // financial reversal fully rolled back
        const tradeRow = await prisma.trade.findUnique({ where: { id: trade.id } });
        expect(tradeRow.status).toBe('DISPUTED');

        const afterVendor = await freshBalances(vendor);
        expect(Number(afterVendor.escrowLockedBalance)).toBe(Number(beforeVendor.escrowLockedBalance));
        expect(Number(afterVendor.vendorUnallocatedBalance)).toBe(Number(beforeVendor.vendorUnallocatedBalance));

        // no ADMIN_INTERVENTION message, no audit row
        expect(await interventionMessages(trade.id)).toHaveLength(0);
        expect(await auditRows(trade.id)).toHaveLength(0);

        // no post-commit socket/balance side effects for a rolled-back attempt
        expect(emitBalanceUpdate).not.toHaveBeenCalled();
        expect(io.to).not.toHaveBeenCalled();
    });

    test('C. concurrent forceCancel: one refund, one audit row, deterministic 409 loser', async () => {
        const { vendor, trade } = await seedDisputedTrade({ type: 'SELL' });
        const before = await freshBalances(vendor);

        const io = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
        const emitBalanceUpdate = jest.fn();
        const [res1, res2] = [makeRes(), makeRes()];
        await Promise.all([
            adminController.forceCancel(makeReq(prisma, io, emitBalanceUpdate, { tradeId: trade.id }), res1),
            adminController.forceCancel(makeReq(prisma, io, emitBalanceUpdate, { tradeId: trade.id }), res2)
        ]);

        const statuses = [res1.status.mock.calls[0][0], res2.status.mock.calls[0][0]].sort();
        expect(statuses).toEqual([200, 409]);

        const after = await freshBalances(vendor);
        expect(Number(after.escrowLockedBalance)).toBe(Number(before.escrowLockedBalance) - 40); // refunded ONCE
        expect(Number(after.vendorUnallocatedBalance)).toBe(Number(before.vendorUnallocatedBalance) + 40);
        expect(await auditRows(trade.id)).toHaveLength(1);      // exactly one audit row
        expect(await interventionMessages(trade.id)).toHaveLength(1);
        expect((await prisma.trade.findUnique({ where: { id: trade.id } })).status).toBe('CANCELLED');
    });
});
