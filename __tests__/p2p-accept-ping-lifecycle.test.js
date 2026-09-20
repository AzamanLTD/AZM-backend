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
            'TRUNCATE TABLE "User", "Trade", "Ad", "TransactionHistory", "AdminProfitLog", "SystemProfitFees", "AuditLog", "LedgerTransaction", "LedgerAccount", "JournalEntry" RESTART IDENTITY CASCADE'
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
            // Hold the trade lock long enough to PROVE the late top-up
            // blocks on it. (The entry read may or may not still observe
            // PENDING_PAYMENT — either way the in-tx guard must refuse.)
            await tx.$executeRawUnsafe('SELECT pg_sleep(1)');
            await tx.trade.update({ where: { id: trade.id }, data: { status: 'CANCELLED' } });
        });

        // Deterministically lose the lock race: wait until the terminal
        // transaction is observed INSIDE its sleep (the trade row lock is
        // provably held) before firing the accept-ping. Without this gate the
        // accept tx could acquire the lock first and the terminal update
        // would simply overwrite the topped-up trade — a different race
        // outcome the test does not describe.
        const deadline = Date.now() + 5000;
        for (;;) {
            const sleeping = await prisma.$queryRawUnsafe(
                `SELECT 1 FROM pg_stat_activity
                  WHERE state = 'active'
                    AND query LIKE '%pg_sleep(1)%'
                    -- exclude THIS poll's own query text, which also contains
                    -- the pg_sleep(1) pattern string (it would self-match and
                    -- break the gate open before the terminal lock is held)
                    AND query NOT LIKE '%pg_stat_activity%'
                  LIMIT 1`
            );
            if (sleeping.length > 0 || Date.now() > deadline) break;
            await new Promise((r) => setTimeout(r, 25));
        }

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

        // Both sides race for real — no sleeps, no ordering hints. Whichever
        // transaction takes the trade row lock first, the database must
        // serialize them into exactly one consistent outcome:
        //   - terminal claim wins: acceptPing observes the terminal status
        //     under the lock and refuses; vendor balances are untouched.
        //   - top-up wins: the debit commits under the lock and the terminal
        //     CAS claim then observes PENDING_PAYMENT and cancels; vendor
        //     balances reflect the committed top-up.
        const outcomes = await Promise.all([
            p2pService.acceptPing(prisma, { tradeId: trade.id, vendorId: vendor.id, topUpAmount: 25 })
                .then((result) => ({ ok: true, result }))
                .catch((error) => ({ ok: false, error })),
            prisma.$transaction(async (tx) => {
                const claimed = await tx.trade.updateMany({
                    where: { id: trade.id, status: 'PENDING_PAYMENT' },
                    data: { status: 'CANCELLED' },
                });
                return { claimed: claimed.count === 1 };
            }),
        ]);
        const toppedUp = outcomes[0].ok === true;
        const claim = outcomes[1];

        const finalVendor = await prisma.user.findUnique({ where: { id: vendor.id } });
        const finalTrade = await prisma.trade.findUnique({ where: { id: trade.id } });

        // The CAS claim observes PENDING_PAYMENT in both serializations.
        expect(claim.claimed).toBe(true);
        expect(finalTrade.status).toBe('CANCELLED');

        if (toppedUp) {
            expect(outcomes[0].result.newAvailableBalance).toBeCloseTo(75, 6);
            expect(outcomes[0].result.newVendorUnallocatedBalance).toBeCloseTo(25, 6);
            expect(Number(finalVendor.availableBalance)).toBeCloseTo(75, 6);
            expect(Number(finalVendor.vendorUnallocatedBalance)).toBeCloseTo(25, 6);
        } else {
            // The concurrent cancel can commit either before or after the
            // top-up's entry read — both guards are fail-closed and leave the
            // vendor's balances untouched, so either message is correct:
            //   entry guard  → "trade status is CANCELLED."
            //   in-tx guard → "no longer pending payment."
            expect(outcomes[0].error.message).toMatch(
                /no longer pending payment|trade status is CANCELLED/
            );
            expect(Number(finalVendor.availableBalance)).toBeCloseTo(100, 6);
            expect(Number(finalVendor.vendorUnallocatedBalance)).toBeCloseTo(0, 6);
        }
    });
});
