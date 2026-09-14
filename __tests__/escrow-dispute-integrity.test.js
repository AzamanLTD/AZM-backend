// __tests__/escrow-dispute-integrity.test.js
// =============================================================================
// P0 financial-integrity coverage for the SmartEscrow dispute lifecycle.
// These tests intentionally exercise the real PostgreSQL transaction boundary
// rather than mocking Prisma's concurrency semantics.
// =============================================================================

const { seedEscrowTicket } = require('./helpers/factories');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;

if (!hasDb) {
    // eslint-disable-next-line no-console
    console.warn('[escrow-dispute-integrity.test] TEST_DATABASE_URL not set — skipping.');
}

describeOrSkip('SmartEscrow dispute integrity', () => {
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
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SystemProfitFees", "AdminProfitLog" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    describe('raiseDispute', () => {
        test('concurrent participant attempts converge to exactly one dispute', async () => {
            const { payer, payee, escrow } = await seedEscrowTicket(prisma, 'FUNDED');
            const attempt = (raisedById) => escrowService.raiseDispute(prisma, {
                escrowId: escrow.id,
                raisedById,
                reason: `Concurrent dispute from ${raisedById}`,
            });

            const [a, b] = await Promise.allSettled([
                attempt(payer.id),
                attempt(payee.id),
            ]);

            expect([a, b].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
            expect([a, b].filter((r) => r.status === 'rejected')).toHaveLength(1);

            const [storedEscrow, disputes] = await Promise.all([
                prisma.smartEscrow.findUnique({ where: { id: escrow.id } }),
                prisma.escrowDispute.findMany({ where: { escrowId: escrow.id } }),
            ]);
            expect(storedEscrow.status).toBe('DISPUTED');
            expect(disputes).toHaveLength(1);
        });

        test('a second dispute after an open dispute returns the canonical loser state', async () => {
            const { payer, escrow } = await seedEscrowTicket(prisma, 'FUNDED');
            await escrowService.raiseDispute(prisma, {
                escrowId: escrow.id,
                raisedById: payer.id,
                reason: 'Initial dispute',
            });

            await expect(escrowService.raiseDispute(prisma, {
                escrowId: escrow.id,
                raisedById: payer.id,
                reason: 'Duplicate dispute',
            })).rejects.toThrow(/ESCROW_ALREADY_DISPUTED|already disputed/i);

            expect(await prisma.escrowDispute.count({ where: { escrowId: escrow.id } })).toBe(1);
        });

        test('non-participant can never become the dispute actor', async () => {
            const { escrow } = await seedEscrowTicket(prisma, 'FUNDED');
            const outsider = await prisma.user.create({
                data: {
                    username: `outsider_${Date.now()}`,
                    email: `outsider_${Date.now()}@test.com`,
                    password: 'test-password',
                    availableBalance: 0,
                },
            });

            await expect(escrowService.raiseDispute(prisma, {
                escrowId: escrow.id,
                raisedById: outsider.id,
                reason: 'Unauthorized',
            })).rejects.toThrow(/Only a participant/i);
            expect(await prisma.escrowDispute.count({ where: { escrowId: escrow.id } })).toBe(0);
        });
    });

    describe('resolveDispute', () => {
        test('concurrent FULL_RELEASE resolutions pay the payee exactly once', async () => {
            const { payer, payee, escrow } = await seedEscrowTicket(prisma, 'DISPUTED', {
                escrow: { dispute: undefined },
            });
            await prisma.escrowDispute.create({
                data: {
                    escrowId: escrow.id,
                    raisedById: payer.id,
                    reason: 'Disputed transaction',
                },
            });

            const payeeBefore = Number((await prisma.user.findUnique({ where: { id: payee.id } })).availableBalance);
            const resolve = () => escrowService.resolveDispute(prisma, {
                escrowId: escrow.id,
                adminId: payer.id,
                ruling: 'FULL_RELEASE',
                rulingNotes: 'Payee wins',
            });

            const [a, b] = await Promise.allSettled([resolve(), resolve()]);
            expect([a, b].filter((r) => r.status === 'fulfilled')).toHaveLength(1);

            const updatedPayee = await prisma.user.findUnique({ where: { id: payee.id } });
            expect(Number(updatedPayee.availableBalance)).toBeCloseTo(payeeBefore + 50, 6);

            const dispute = await prisma.escrowDispute.findUnique({ where: { escrowId: escrow.id } });
            const updatedEscrow = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
            expect(updatedEscrow.status).toBe('RELEASED');
            expect(dispute.status).toBe('RESOLVED');
        });

        test('concurrent FULL_REFUND resolutions return one canonical outcome and refund once', async () => {
            const { payer, escrow } = await seedEscrowTicket(prisma, 'DISPUTED');
            await prisma.escrowDispute.create({
                data: {
                    escrowId: escrow.id,
                    raisedById: payer.id,
                    reason: 'Refund dispute',
                },
            });

            const payerBefore = Number((await prisma.user.findUnique({ where: { id: payer.id } })).availableBalance);
            const resolve = () => escrowService.resolveDispute(prisma, {
                escrowId: escrow.id,
                adminId: payer.id,
                ruling: 'FULL_REFUND',
            });

            const [a, b] = await Promise.allSettled([resolve(), resolve()]);
            expect([a, b].filter((r) => r.status === 'fulfilled')).toHaveLength(1);

            const updatedPayer = await prisma.user.findUnique({ where: { id: payer.id } });
            expect(Number(updatedPayer.availableBalance)).toBeCloseTo(payerBefore + 50, 6);
            expect(Number(updatedPayer.disputeEscrowBalance)).toBeCloseTo(0, 6);
        });

        test('SPLIT settles the full principal in one transaction', async () => {
            const { payer, payee, escrow } = await seedEscrowTicket(prisma, 'DISPUTED');
            await prisma.escrowDispute.create({
                data: {
                    escrowId: escrow.id,
                    raisedById: payer.id,
                    reason: 'Split dispute',
                },
            });

            const payerBefore = Number((await prisma.user.findUnique({ where: { id: payer.id } })).availableBalance);
            const payeeBefore = Number((await prisma.user.findUnique({ where: { id: payee.id } })).availableBalance);

            await escrowService.resolveDispute(prisma, {
                escrowId: escrow.id,
                adminId: payer.id,
                ruling: 'SPLIT',
                payerPct: 40,
                payeePct: 60,
            });

            const [updatedPayer, updatedPayee, updatedEscrow, dispute] = await Promise.all([
                prisma.user.findUnique({ where: { id: payer.id } }),
                prisma.user.findUnique({ where: { id: payee.id } }),
                prisma.smartEscrow.findUnique({ where: { id: escrow.id } }),
                prisma.escrowDispute.findUnique({ where: { escrowId: escrow.id } }),
            ]);

            expect(Number(updatedPayer.availableBalance)).toBeCloseTo(payerBefore + 20, 6);
            expect(Number(updatedPayee.availableBalance)).toBeCloseTo(payeeBefore + 30, 6);
            expect(Number(updatedPayer.disputeEscrowBalance)).toBeCloseTo(0, 6);
            expect(updatedEscrow.status).toBe('RELEASED');
            expect(dispute.status).toBe('RESOLVED');
        });

        test('financial failure rolls back escrow and dispute transition', async () => {
            const { payer, escrow } = await seedEscrowTicket(prisma, 'DISPUTED');
            await prisma.escrowDispute.create({
                data: {
                    escrowId: escrow.id,
                    raisedById: payer.id,
                    reason: 'Broken balance fixture',
                },
            });
            await prisma.user.update({
                where: { id: payer.id },
                data: { disputeEscrowBalance: 0 },
            });

            await expect(escrowService.resolveDispute(prisma, {
                escrowId: escrow.id,
                adminId: payer.id,
                ruling: 'FULL_REFUND',
            })).rejects.toThrow();

            const [updatedEscrow, dispute, updatedPayer] = await Promise.all([
                prisma.smartEscrow.findUnique({ where: { id: escrow.id } }),
                prisma.escrowDispute.findUnique({ where: { escrowId: escrow.id } }),
                prisma.user.findUnique({ where: { id: payer.id } }),
            ]);
            expect(updatedEscrow.status).toBe('DISPUTED');
            expect(dispute.status).toBe('PENDING');
            expect(Number(updatedPayer.disputeEscrowBalance)).toBe(0);
        });

        test('dispute-state failure rolls back the financial mutation', async () => {
            const { payer, payee, escrow } = await seedEscrowTicket(prisma, 'DISPUTED');
            await prisma.escrowDispute.create({
                data: {
                    escrowId: escrow.id,
                    raisedById: payer.id,
                    reason: 'FK rollback test',
                },
            });
            const payeeBefore = Number((await prisma.user.findUnique({ where: { id: payee.id } })).availableBalance);

            await expect(escrowService.resolveDispute(prisma, {
                escrowId: escrow.id,
                adminId: 2147483647,
                ruling: 'FULL_RELEASE',
            })).rejects.toThrow();

            const [updatedEscrow, dispute, updatedPayer, updatedPayee] = await Promise.all([
                prisma.smartEscrow.findUnique({ where: { id: escrow.id } }),
                prisma.escrowDispute.findUnique({ where: { escrowId: escrow.id } }),
                prisma.user.findUnique({ where: { id: payer.id } }),
                prisma.user.findUnique({ where: { id: payee.id } }),
            ]);
            expect(updatedEscrow.status).toBe('DISPUTED');
            expect(dispute.status).toBe('PENDING');
            expect(Number(updatedPayer.disputeEscrowBalance)).toBeCloseTo(50, 6);
            expect(Number(updatedPayee.availableBalance)).toBeCloseTo(payeeBefore, 6);
        });

        test('terminal replay returns the canonical committed resolution without moving money again', async () => {
            const { payer, payee, escrow } = await seedEscrowTicket(prisma, 'DISPUTED');
            await prisma.escrowDispute.create({
                data: {
                    escrowId: escrow.id,
                    raisedById: payer.id,
                    reason: 'Terminal replay',
                    status: 'RESOLVED',
                    ruling: 'FULL_RELEASE',
                    resolvedAt: new Date(),
                },
            });
            await prisma.smartEscrow.update({
                where: { id: escrow.id },
                data: {
                    status: 'RELEASED',
                    settledAt: new Date(),
                    releaseTxHash: `seed-release-${Date.now()}`,
                },
            });

            const payeeBefore = Number((await prisma.user.findUnique({ where: { id: payee.id } })).availableBalance);
            const result = await expect(escrowService.resolveDispute(prisma, {
                escrowId: escrow.id,
                adminId: payer.id,
                ruling: 'FULL_RELEASE',
            })).resolves.toBeDefined();

            expect(result.value.escrow.status).toBe('RELEASED');
            expect(result.value.dispute.status).toBe('RESOLVED');
            const payeeAfter = Number((await prisma.user.findUnique({ where: { id: payee.id } })).availableBalance);
            expect(payeeAfter).toBeCloseTo(payeeBefore, 6);
        });
    });
});
