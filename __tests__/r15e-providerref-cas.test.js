// __tests__/r15e-providerref-cas.test.js
// =============================================================================
// r15 R15-E — providerRef enrichment is an atomic CAS (real PostgreSQL)
//
// THE DEFECT: fiatSettlementService enriched the authoritative settlement
// record's providerRef with read-check-write (findUnique → if null →
// update). Two concurrent callbacks both observed providerRef null, both
// passed the check, and the LAST unconditional write silently replaced the
// FIRST provider's identity — contradictory provider evidence destroyed.
//
// THE FIX (pinned here): conditional updateMany (txHash + providerRef: null)
// is the claim. The first identity wins; losers converge by re-reading the
// committed row; no call ever overwrites an existing providerRef.
// =============================================================================

const { PrismaClient } = require('@prisma/client');
const { seedUser } = require('./helpers/factories');
const { enrichProviderReference } = require('../services/fiatSettlementService');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r15e-providerref-cas] TEST_DATABASE_URL not set — skipping real-DB suite.');

describeOrSkip('r15 R15-E: providerRef enrichment CAS (real PostgreSQL)', () => {
    let prisma;
    let userId;

    beforeAll(() => { prisma = new PrismaClient(); });
    afterAll(async () => { await prisma.$disconnect(); });

    beforeEach(async () => {
        const user = await seedUser(prisma, {});
        userId = user.id;
    });

    afterEach(async () => {
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "User", "TransactionHistory" RESTART IDENTITY CASCADE');
    });

    const seedPending = async (reference) => prisma.transactionHistory.create({
        data: {
            userId,
            txHash: reference,
            type: 'WITHDRAWAL_FIAT',
            status: 'PENDING',
            amountUsdc: -50,
        },
    });

    test('single enrichment claims the null providerRef exactly once', async () => {
        const t = await seedPending('r15e-1');
        const out = await enrichProviderReference(prisma, 'r15e-1', t, 'PROV-A');
        expect(out.providerRef).toBe('PROV-A');
        const row = await prisma.transactionHistory.findUnique({ where: { txHash: 'r15e-1' } });
        expect(row.providerRef).toBe('PROV-A');
    });

    test('CONCURRENT contradictory enrichments: the FIRST identity survives, the last write NEVER replaces it', async () => {
        const t = await seedPending('r15e-2');
        const stale = await prisma.transactionHistory.findUnique({ where: { txHash: 'r15e-2' } });

        const results = await Promise.all([
            enrichProviderReference(prisma, 'r15e-2', stale, 'PROV-A'),
            enrichProviderReference(prisma, 'r15e-2', stale, 'PROV-B'),
        ]);

        const row = await prisma.transactionHistory.findUnique({ where: { txHash: 'r15e-2' } });
        // Exactly one identity — never both, never a mixed overwrite.
        expect(row.providerRef).toMatch(/^PROV-[AB]$/);
        // Both callers converge on the SAME authoritative row — no caller ever
        // observes a stale or contradictory view.
        for (const r of results) {
            expect(r.providerRef).toBe(row.providerRef);
        }
        // A stale snapshot with providerRef already set short-circuits (no write).
        const again = await enrichProviderReference(prisma, 'r15e-2', results[0], 'PROV-C');
        expect(again.providerRef).toBe(row.providerRef);
        const after = await prisma.transactionHistory.findUnique({ where: { txHash: 'r15e-2' } });
        expect(after.providerRef).toBe(row.providerRef);
    });

    test('a pre-existing providerRef is never overwritten by a later contradictory callback', async () => {
        await seedPending('r15e-3');
        await prisma.transactionHistory.updateMany({
            where: { txHash: 'r15e-3' },
            data: { providerRef: 'AUTHORITATIVE' },
        });
        const current = await prisma.transactionHistory.findUnique({ where: { txHash: 'r15e-3' } });

        const out = await enrichProviderReference(prisma, 'r15e-3', current, 'LATE-CALLBACK');

        const row = await prisma.transactionHistory.findUnique({ where: { txHash: 'r15e-3' } });
        expect(row.providerRef).toBe('AUTHORITATIVE');
        expect(out.providerRef).toBe('AUTHORITATIVE');
    });
});
