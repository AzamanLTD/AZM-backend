const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[p2p-accept-ping-lifecycle] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('P2P accept-ping lifecycle integrity (real PostgreSQL)', () => {
    let prisma, p2pService;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        p2pService = require('../services/p2p.service');
    });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "Trade", "Ad", "TransactionHistory", "AdminProfitLog", "SystemProfitFees", "AuditLog" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    test('acceptPing tops up normally while the trade remains PENDING_PAYMENT', async () => {
        const vendor = await prisma.user.create({
            data: { username: `ping_vendor_${Date.now()}`, email: `ping_vendor_${Date.now()}@test.local`, password: 'test_password', role: 'VENDOR', availableBalance: 100 }
        });
        const buyer = await prisma.user.create({
            data: { username: `ping_buyer_${Date.now()}`, email: `ping_buyer_${Date.now()}@test.local`, password: 'test_password', role: 'USER' }
        });
        const trade = await prisma.trade.create({
            data: {
                userId: buyer.id,
                vendorId: vendor.id,
                type: 'SELL',
                crypto: 'USDT',
                amountCrypto: 50,
                amountFiat: 775,
                currency: 'GHS',
                rate: 15.5,
                paymentMethod: 'Bank Transfer',
                status: 'PENDING_PAYMENT',
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            }
        });

        const result = await p2pService.acceptPing(prisma, {
            tradeId: trade.id,
            vendorId: vendor.id,
            topUpAmount: 25,
        });

        const finalVendor = await prisma.user.findUnique({ where: { id: vendor.id } });
        const finalTrade = await prisma.trade.findUnique({ where: { id: trade.id } });
        expect(result.newAvailableBalance).toBeCloseTo(75, 6);
        expect(result.newVendorUnallocatedBalance).toBeCloseTo(25, 6);
        expect(Number(finalVendor.availableBalance)).toBeCloseTo(75, 6);
        expect(Number(finalVendor.vendorUnallocatedBalance)).toBeCloseTo(25, 6);
        expect(finalTrade.status).toBe('PENDING_PAYMENT');
    });

    test('terminal transition that wins the trade lock prevents a late top-up', async () => {
        const vendor = await prisma.user.create({
            data: { username: `ping_vendor_${Date.now()}`, email: `ping_vendor_${Date.now()}@test.local`, password: 'test_password', role: 'VENDOR', availableBalance: 100 }
        });
        const buyer = await prisma.user.create({
            data: { username: `ping_buyer_${Date.now()}`, email: `ping_buyer_${Date.now()}@test.local`, password: 'test_password', role: 'USER' }
        });
        const trade = await prisma.trade.create({
            data: {
                userId: buyer.id,
                vendorId: vendor.id,
                type: 'SELL',
                crypto: 'USDT',
                amountCrypto: 50,
                amountFiat: 775,
                currency: 'GHS',
                rate: 15.5,
                paymentMethod: 'Bank Transfer',
                status: 'PENDING_PAYMENT',
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            }
        });

        const terminal = prisma.$transaction(async (tx) => {
            await tx.$queryRawUnsafe(
                'SELECT 1 AS locked FROM "Trade" WHERE id = $1 AND status = $2::"TradeStatus" FOR UPDATE',
                trade.id,
                'PENDING_PAYMENT'
            );
            await tx.$executeRawUnsafe('SELECT pg_sleep(0.2)');
            await tx.trade.update({ where: { id: trade.id }, data: { status: 'CANCELLED' } });
        });

        const accept = p2pService.acceptPing(prisma, {
            tradeId: trade.id,
            vendorId: vendor.id,
            topUpAmount: 25,
        }).then(() => ({ ok: true })).catch((error) => ({ ok: false, error }));

        const terminalResult = await terminal.then(() => ({ ok: true })).catch((error) => ({ ok: false, error }));
        const acceptResult = await accept;

        expect(terminalResult.ok).toBe(true);
        expect(acceptResult.ok).toBe(false);
        expect(acceptResult.error.message).toContain('no longer pending payment');

        const finalVendor = await prisma.user.findUnique({ where: { id: vendor.id } });
        const finalTrade = await prisma.trade.findUnique({ where: { id: trade.id } });
        expect(finalTrade.status).toBe('CANCELLED');
        expect(Number(finalVendor.availableBalance)).toBeCloseTo(100, 6);
        expect(Number(finalVendor.vendorUnallocatedBalance)).toBeCloseTo(0, 6);
    });

    test('when the top-up wins first, a concurrent terminal claim cannot overwrite the trade', async () => {
        const vendor = await prisma.user.create({
            data: { username: `ping_vendor_${Date.now()}`, email: `ping_vendor_${Date.now()}@test.local`, password: 'test_password', role: 'VENDOR', availableBalance: 100 }
        });
        const buyer = await prisma.user.create({
            data: { username: `ping_buyer_${Date.now()}`, email: `ping_buyer_${Date.now()}@test.local`, password: 'test_password', role: 'USER' }
        });
        const trade = await prisma.trade.create({
            data: {
                userId: buyer.id,
                vendorId: vendor.id,
                type: 'SELL',
                crypto: 'USDT',
                amountCrypto: 50,
                amountFiat: 775,
                currency: 'GHS',
                rate: 15.5,
                paymentMethod: 'Bank Transfer',
                status: 'PENDING_PAYMENT',
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            }
        });

        const outcomes = await Promise.all([
            p2pService.acceptPing(prisma, { tradeId: trade.id, vendorId: vendor.id, topUpAmount: 25 })
                .then((result) => ({ ok: true, result })),
            prisma.$transaction(async (tx) => {
                const claimed = await tx.trade.updateMany({
                    where: { id: trade.id, status: 'PENDING_PAYMENT' },
                    data: { status: 'CANCELLED' },
                });
                return { ok: claimed.count === 1 };
            }),
        ]);

        const finalVendor = await prisma.user.findUnique({ where: { id: vendor.id } });
        const finalTrade = await prisma.trade.findUnique({ where: { id: trade.id } });
        const toppedUp = outcomes.some((o) => o.ok === true && o.result?.newAvailableBalance !== undefined);
        expect(finalTrade.status === 'CANCELLED' || finalTrade.status === 'PENDING_PAYMENT').toBe(true);
        if (finalTrade.status === 'CANCELLED') {
            expect(Number(finalVendor.availableBalance)).toBeCloseTo(100, 6);
            expect(Number(finalVendor.vendorUnallocatedBalance)).toBeCloseTo(0, 6);
        } else {
            expect(Number(finalVendor.availableBalance)).toBeCloseTo(75, 6);
            expect(Number(finalVendor.vendorUnallocatedBalance)).toBeCloseTo(25, 6);
        }
        expect(toppedUp || finalTrade.status === 'CANCELLED').toBe(true);
    });
});
