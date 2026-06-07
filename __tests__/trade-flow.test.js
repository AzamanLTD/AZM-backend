// __tests__/trade-flow.test.js
// =============================================================================
// TOCTOU regression guard for completeTrade (B-08).
//
// The H8–H12 audit fixed a double-payout bug by making the PAID->COMPLETED
// flip an atomic conditional update (updateMany WHERE status='PAID'). Only the
// first of two concurrent completeTrade calls should win; the second must see
// count=0 and bail with ALREADY_FINALIZED rather than paying the vendor twice.
//
// This is the single most important invariant in the platform — a regression
// here loses real money. The test needs a real database (atomicity is a DB
// property), so like auth.test.js it SKIPS without TEST_DATABASE_URL.
//
// NOTE: this test is intentionally written against the service contract. The
// exact seed (creating a PAID trade with funded escrow) depends on helpers
// that differ across environments; where a step can't be performed it is
// marked TODO so the harness is honest about coverage rather than asserting a
// fake pass. Wire the seed to your factory/fixtures to fully activate it.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;

if (!hasDb) {
    // eslint-disable-next-line no-console
    console.warn(
        '[trade-flow.test] TEST_DATABASE_URL not set — skipping TOCTOU trade tests. ' +
        'Set it to a disposable Postgres URL to enable them.'
    );
}

describeOrSkip('completeTrade — concurrent finalize is single-winner', () => {
    let prisma;
    let p2pService;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        // Service module shape varies (class vs functions); resolve defensively.
        // eslint-disable-next-line global-require
        p2pService = require('../services/p2p.service');
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    test('two simultaneous completeTrade calls: exactly one succeeds', async () => {
        // ---- SEED (wire to your fixtures) ----------------------------------
        // Create a buyer, a vendor with funded escrow, and a Trade in PAID
        // status whose escrowLockedBalance covers amountCrypto. Capture tradeId
        // and the releasing user's id.
        //
        // const { tradeId, releasedByUserId } = await seedPaidTrade(prisma);
        const seed = null; // TODO: replace with seedPaidTrade(prisma)

        if (!seed) {
            // Be loud, not silently green: fail so this TODO is visible when the
            // DB is present but the fixture isn't wired yet.
            throw new Error(
                'trade-flow seed not wired: implement seedPaidTrade(prisma) to create a ' +
                'PAID trade with funded escrow, then remove this guard.'
            );
        }

        const complete = () =>
            p2pService
                .completeTrade(prisma, { tradeId: seed.tradeId, releasedByUserId: seed.releasedByUserId })
                .then((r) => ({ ok: true, r }))
                .catch((e) => ({ ok: false, e }));

        const [a, b] = await Promise.all([complete(), complete()]);

        const successes = [a, b].filter((x) => x.ok).length;
        expect(successes).toBe(1);

        // The vendor balance must reflect exactly one payout. Re-read and assert
        // against the expected net (amountCrypto - fee) — not double.
        // const vendor = await prisma.user.findUnique({ where: { id: seed.vendorId } });
        // expect(Number(vendor.availableBalance)).toBeCloseTo(seed.expectedVendorBalance, 6);
    });
});
