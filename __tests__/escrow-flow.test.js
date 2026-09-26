// __tests__/escrow-flow.test.js
// =============================================================================
// The most important new financial coverage: the Smart Escrow engine moves real
// USDC. These tests guard fund → satisfy → settle, dispute, and cancel against
// double-release, unauthorized operations, and invalid state transitions.
//
// Atomicity is a database property, so — like auth.test.js and trade-flow.test.js
// — this suite SKIPS unless TEST_DATABASE_URL points at a disposable Postgres.
//
// NOTE: written against the real services/escrowService.js contract:
//   • raiseDispute takes { escrowId, raisedById, reason } (not userId).
//   • cancelEscrow({ escrowId, userId }) is payer-only; DRAFT→EXPIRED,
//     FUNDED→refund.
// =============================================================================

const { seedEscrowTicket } = require('./helpers/factories');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;

if (!hasDb) {
    // eslint-disable-next-line no-console
    console.warn('[escrow-flow.test] TEST_DATABASE_URL not set — skipping escrow tests.');
}

describeOrSkip('SmartEscrow flows', () => {
    let prisma;
    let escrowService;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        // eslint-disable-next-line global-require
        escrowService = require('../services/escrowService');
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    afterEach(async () => {
        // CASCADE from User clears Friendship/Ticket/SmartEscrow/EscrowDispute/
        // TransactionHistory; also reset the profit-fee singleton.
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SystemProfitFees", "AdminProfitLog" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    // ── fund ──────────────────────────────────────────────────────────────────
    describe('fund', () => {
        test('moves payer.availableBalance → escrowLockedBalance, fee → SystemProfitFees', async () => {
            const { payer, escrow } = await seedEscrowTicket(prisma, 'DRAFT');
            const initialAvail = Number(payer.availableBalance); // 200

            await escrowService.fundEscrow(prisma, { escrowId: escrow.id, payerId: payer.id });

            const updated = await prisma.user.findUnique({ where: { id: payer.id } });
            // total debit = amount (50) + fee (0.25)
            expect(Number(updated.availableBalance)).toBeCloseTo(initialAvail - 50.25, 6);
            expect(Number(updated.escrowLockedBalance)).toBeCloseTo(50.0, 6);

            const profit = await prisma.systemProfitFees.findUnique({ where: { id: 1 } });
            expect(Number(profit.balance)).toBeGreaterThan(0);
        });

        test('cannot fund twice (idempotent-safe)', async () => {
            const { payer, escrow } = await seedEscrowTicket(prisma, 'DRAFT');
            await escrowService.fundEscrow(prisma, { escrowId: escrow.id, payerId: payer.id });
            await expect(
                escrowService.fundEscrow(prisma, { escrowId: escrow.id, payerId: payer.id })
            ).rejects.toThrow(/cannot be funded from status FUNDED/i);
        });
    });

    // ── satisfy + settle ────────────────────────────────────────────────────
    describe('satisfy + settle', () => {
        test('both parties markSatisfied → settles, payee receives amountUsdc', async () => {
            const { payer, payee, escrow } = await seedEscrowTicket(prisma, 'FUNDED');
            const payeeBefore = Number((await prisma.user.findUnique({ where: { id: payee.id } })).availableBalance);

            const r1 = await escrowService.markSatisfied(prisma, { escrowId: escrow.id, userId: payer.id });
            expect(r1.settled).toBe(false);

            const r2 = await escrowService.markSatisfied(prisma, { escrowId: escrow.id, userId: payee.id });
            expect(r2.settled).toBe(true);

            const payeeAfter = await prisma.user.findUnique({ where: { id: payee.id } });
            expect(Number(payeeAfter.availableBalance)).toBeCloseTo(payeeBefore + 50.0, 6);
        });

        test('TOCTOU — concurrent same-party satisfy: exactly one succeeds', async () => {
            const { payer, escrow } = await seedEscrowTicket(prisma, 'FUNDED');
            const call = () =>
                escrowService
                    .markSatisfied(prisma, { escrowId: escrow.id, userId: payer.id })
                    .then((r) => ({ ok: true, r }))
                    .catch((e) => ({ ok: false, e }));
            const [a, b] = await Promise.all([call(), call()]);
            expect([a, b].filter((x) => x.ok).length).toBe(1);
        });
    });

    // ── dispute ─────────────────────────────────────────────────────────────
    describe('dispute', () => {
        test('moves funds to disputeEscrowBalance and sets DISPUTED', async () => {
            const { payer, escrow } = await seedEscrowTicket(prisma, 'FUNDED');
            await escrowService.raiseDispute(prisma, {
                escrowId: escrow.id,
                raisedById: payer.id,
                reason: 'Seller did not deliver the promised service after 5 days.',
            });

            const updated = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
            expect(updated.status).toBe('DISPUTED');

            const payerAfter = await prisma.user.findUnique({ where: { id: payer.id } });
            expect(Number(payerAfter.escrowLockedBalance)).toBeCloseTo(0, 6);
            expect(Number(payerAfter.disputeEscrowBalance)).toBeCloseTo(50.0, 6);
        });
    });

    // ── cancel ──────────────────────────────────────────────────────────────
    describe('cancel', () => {
        test('DRAFT cancel moves no funds and marks EXPIRED', async () => {
            const { payer, escrow } = await seedEscrowTicket(prisma, 'DRAFT');
            await escrowService.cancelEscrow(prisma, { escrowId: escrow.id, userId: payer.id });
            const updated = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
            expect(updated.status).toBe('EXPIRED');
        });

        test('FUNDED cancel refunds the payer', async () => {
            const { payer, escrow } = await seedEscrowTicket(prisma, 'FUNDED');
            const before = Number((await prisma.user.findUnique({ where: { id: payer.id } })).availableBalance);
            await escrowService.cancelEscrow(prisma, { escrowId: escrow.id, userId: payer.id });
            const payerAfter = await prisma.user.findUnique({ where: { id: payer.id } });
            expect(Number(payerAfter.availableBalance)).toBeCloseTo(before + 50.0, 6);
            expect(Number(payerAfter.escrowLockedBalance)).toBeCloseTo(0, 6);
        });

        test('payee cannot cancel', async () => {
            const { payee, escrow } = await seedEscrowTicket(prisma, 'FUNDED');
            await expect(
                escrowService.cancelEscrow(prisma, { escrowId: escrow.id, userId: payee.id })
            ).rejects.toThrow(/Only the payer/i);
        });
    });
});
