// __tests__/native-ghs-dispatch-outcomes.test.js
// =============================================================================
// P0 (issue #389 section 3): a payout with an UNCERTAIN provider outcome must
// never be refunded. Real PostgreSQL; fake adapters supply the TYPED outcome.
//
// PROVES: only NOT_DISPATCHED / DEFINITIVE_REJECTION reverse; timeouts, resets,
// 5xx, malformed 2xx, duplicate references, provider-status outages and untyped
// exceptions keep the customer's GHS held and park a durable exception.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[native-ghs-dispatch-outcomes] TEST_DATABASE_URL not set — skipping.');

if (hasDb) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    // §P0 GHS amount-risk policy: the gate REFUSES a payout while this policy is
    // absent, partial or malformed, so a suite that exercises the happy path
    // configures one explicitly. The numbers are deliberately far above every
    // fixture amount in this suite so no amount rule fires here.
    process.env.GHS_RISK_AMOUNT_POLICY = process.env.GHS_RISK_AMOUNT_POLICY
        || '{"largeGhs":1000000,"hugeGhs":2000000,"newAccountMinGhs":900000}';
}

maybe = hasDb ? describe : describe.skip;

maybe('native-GHS dispatch outcomes (real PostgreSQL)', () => {
    const { randomUUID } = require('crypto');
    const { PrismaClient, Prisma } = require('@prisma/client');

    let prisma;
    let service;
    let seedUser;

    beforeAll(async () => {
        prisma = new PrismaClient();
        service = require('../src/services/nativeGhsWithdrawalService');
        ({ seedUser } = require('./helpers/factories'));
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    async function settings() {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { nativeGhsWithdrawalEnabled: true, fiatLiquidityAuthorityEnabled: true },
            create: { id: 1, nativeGhsWithdrawalEnabled: true, fiatLiquidityAuthorityEnabled: true },
        });
        await prisma.fiatLiquidityState.upsert({
            where: { id: 1 },
            update: { availableGhs: 100000, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
            create: { id: 1, availableGhs: 100000 },
        });
    }

    async function accepted(amountGhs = '50.00') {
        const user = await seedUser(prisma, { nativeGhsBalance: 200 });
        const reference = randomUUID();
        await service.processNativeGhsWithdrawal(prisma, user.id, {
            amountGhs, destination: '233241234567', network: 'MTN', reference,
        }, { commitOperationClaimInTransaction: async () => {} });
        return { user, reference };
    }

    const ghs = async (userId) => {
        const u = await prisma.user.findUnique({ where: { id: userId }, select: { nativeGhsBalance: true } });
        return new Prisma.Decimal(u.nativeGhsBalance).toFixed(2);
    };
    const exceptionOf = async (reference) => {
        const row = await prisma.transactionHistory.findUnique({ where: { txHash: reference }, select: { metadata: true } });
        return row?.metadata?.dispatchException || null;
    };
    const thrower = (outcome, message = 'provider failure') => ({
        initiateTransfer: async () => {
            const err = new Error(message);
            if (outcome !== undefined) { err.outcome = outcome; }
            err.code = 'PROVIDER_CALL_FAILED';
            throw err;
        },
    });

    test('NOT_DISPATCHED reverses exactly once and restores GHS', async () => {
        await settings();
        const { user, reference } = await accepted();
        const out = await service.dispatchNativeGhsWithdrawal(prisma, {
            reference, amountGhsExact: '50.00', destination: '233241234567', dispatcher: thrower('NOT_DISPATCHED'),
        });
        expect(out.outcome).toBe('NOT_DISPATCHED');
        expect(out.reversed).toBe(true);
        expect(await ghs(user.id)).toBe('200.00');
        const tx = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(tx.status).toBe('FAILED');
    });

    test('DEFINITIVE_REJECTION reverses exactly once (second call cannot double-refund)', async () => {
        await settings();
        const { user, reference } = await accepted();
        await service.dispatchNativeGhsWithdrawal(prisma, {
            reference, amountGhsExact: '50.00', destination: '233241234567', dispatcher: thrower('DEFINITIVE_REJECTION'),
        });
        const again = await service.dispatchNativeGhsWithdrawal(prisma, {
            reference, amountGhsExact: '50.00', destination: '233241234567', dispatcher: thrower('DEFINITIVE_REJECTION'),
        });
        expect(again.dispatched).toBe(false);
        expect(again.outcome).toBeUndefined(); // claim already lost: no provider call at all
        expect(await ghs(user.id)).toBe('200.00');
    });

    test('UNKNOWN_OUTCOME keeps funds held, parks evidence, never refunds', async () => {
        await settings();
        const { user, reference } = await accepted();
        const out = await service.dispatchNativeGhsWithdrawal(prisma, {
            reference, amountGhsExact: '50.00', destination: '233241234567', dispatcher: thrower('UNKNOWN_OUTCOME'),
        });
        expect(out.reason).toBe('PROVIDER_OUTCOME_UNCERTAIN');
        expect(out.refunded).toBe(false);
        expect(await ghs(user.id)).toBe('150.00');
        const exc = await exceptionOf(reference);
        expect(exc.code).toBe('PROVIDER_OUTCOME_UNCERTAIN');
        expect(exc.refunded).toBe(false);
        expect(exc.resolution).toBe('STATUS_LOOKUP_ORIGINAL_REFERENCE');
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: (await prisma.transactionHistory.findUnique({ where: { txHash: reference } })).id } });
        expect(mirror.status).toBe('DISPATCHING'); // held, not FAILED
    });

    test('DUPLICATE_REFERENCE parks for status lookup without a new transfer or refund', async () => {
        await settings();
        const { user, reference } = await accepted();
        const out = await service.dispatchNativeGhsWithdrawal(prisma, {
            reference, amountGhsExact: '50.00', destination: '233241234567', dispatcher: thrower('DUPLICATE_REFERENCE'),
        });
        expect(out.reason).toBe('PROVIDER_OUTCOME_UNCERTAIN');
        expect(await ghs(user.id)).toBe('150.00');
        const exc = await exceptionOf(reference);
        expect(exc.code).toBe('PROVIDER_DUPLICATE_REFERENCE');
        expect(exc.reference).toBe(reference);
    });

    test('UNTYPED exception defaults to uncertainty: no refund', async () => {
        await settings();
        const { user, reference } = await accepted();
        const out = await service.dispatchNativeGhsWithdrawal(prisma, {
            reference, amountGhsExact: '50.00', destination: '233241234567', dispatcher: thrower(undefined, 'socket hang up'),
        });
        expect(out.outcome).toBe('UNKNOWN_OUTCOME');
        expect(out.refunded).toBe(false);
        expect(await ghs(user.id)).toBe('150.00');
    });

    test.each([
        ['timeout after possible transmission', 'ETIMEDOUT'],
        ['socket reset after possible transmission', 'ECONNRESET'],
        ['provider 5xx', 'E5XX'],
        ['malformed 2xx after possible acceptance', 'EBADRESPONSE'],
        ['provider status lookup outage', 'ESTATUSLOOKUP'],
    ])('%s is untyped => held, never reversed', async (_label, code) => {
        await settings();
        const { user, reference } = await accepted();
        const dispatcher = {
            initiateTransfer: async () => {
                const err = new Error(`transport:${code}`);
                err.code = code;
                throw err;
            },
        };
        const out = await service.dispatchNativeGhsWithdrawal(prisma, {
            reference, amountGhsExact: '50.00', destination: '233241234567', dispatcher,
        });
        expect(out.refunded).toBe(false);
        expect(await ghs(user.id)).toBe('150.00');
        const tx = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(tx.status).toBe('PENDING');
        const res = await prisma.fiatLiquidityReservation.findUnique({ where: { reference } });
        expect(['RESERVED', 'IN_TRANSIT']).toContain(res.status);
    });

    test('classifier ignores message substrings and unknown typed values', () => {
        const e1 = new Error('duplicate reference: NOT_DISPATCHED');
        expect(service.classifyProviderOutcome(e1)).toBe('UNKNOWN_OUTCOME');
        expect(service.classifyProviderOutcome({ outcome: 'SOMETHING_NEW' })).toBe('UNKNOWN_OUTCOME');
        expect(service.classifyProviderOutcome({ providerOutcome: 'definitive_rejection' })).toBe('DEFINITIVE_REJECTION');
        expect(service.classifyProviderOutcome(null)).toBe('UNKNOWN_OUTCOME');
    });
});
