const { seedEscrowTicket } = require('./helpers/factories');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;

if (!hasDb) {
    // eslint-disable-next-line no-console
    console.warn('[escrow-convergence.test] TEST_DATABASE_URL not set — skipping.');
}

describeOrSkip('SmartEscrow concurrent satisfaction convergence', () => {
    let prisma;
    let escrowService;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        escrowService = require('../services/escrowService');
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "SystemProfitFees", "AdminProfitLog" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    test('opposite-party concurrent satisfaction converges with exactly one payout and one release history row', async () => {
        const { payer, payee, escrow } = await seedEscrowTicket(prisma, 'FUNDED');
        const payeeBefore = Number((await prisma.user.findUnique({ where: { id: payee.id } })).availableBalance);

        const call = (userId) => escrowService
            .markSatisfied(prisma, { escrowId: escrow.id, userId })
            .then((result) => ({ ok: true, result }))
            .catch((error) => ({ ok: false, error }));

        const [a, b] = await Promise.all([call(payer.id), call(payee.id)]);
        expect(a.ok).toBe(true);
        expect(b.ok).toBe(true);

        const finalEscrow = await prisma.smartEscrow.findUnique({ where: { id: escrow.id } });
        expect(finalEscrow.status).toBe('SETTLED');
        expect(finalEscrow.payerSatisfied).toBe(true);
        expect(finalEscrow.payeeSatisfied).toBe(true);

        const payeeAfter = await prisma.user.findUnique({ where: { id: payee.id } });
        expect(Number(payeeAfter.availableBalance)).toBeCloseTo(payeeBefore + Number(finalEscrow.amountUsdc), 6);

        const releases = await prisma.transactionHistory.count({
            where: { type: 'TICKET_ESCROW_RELEASE', userId: payee.id }
        });
        expect(releases).toBe(1);
    });
});
