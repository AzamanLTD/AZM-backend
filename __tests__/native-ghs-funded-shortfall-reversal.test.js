// __tests__/native-ghs-funded-shortfall-reversal.test.js
// =============================================================================
// Issue #389 P0 remediation: the FUNDED (mixed USDC+GHS) payout reversal.
//
// TWO DEFECTS, both reproduced here against a real PostgreSQL instance:
//   (1) the reversal posted its ASSET_CONVERSION under the FUNDING conversion
//       identity, and the ledger enforces uniqueness of conversionIdentity —
//       so every mixed-funded reversal threw and the refund rolled back with it;
//   (2) the reversal credited the FULL debit back to nativeGhsBalance but never
//       removed the USDC-funded shortfall from it, so a customer who started
//       with GHS 20.00 ended up with GHS 50.00 (and the GHS liability ledger no
//       longer agreed with the projection).
//
// PROVES: the reversal is the exact inverse of the funding conversion under its
// OWN durable identity, the GHS and USDC projections each agree with their
// ledger liability account afterwards, the payout debit nets to zero, the
// reservation is released exactly once, both rows reach a consistent FAILED
// state, and a second reversal changes nothing.
//
// Also covers: non-zero recorded fee (refund the RECORDED debit), the two
// concurrent-reversal and admin-vs-worker races, injected failures at every
// step of the boundary, malformed funding evidence, the zero-USDC rounding
// boundary, and MoMo fee-policy isolation from the bank rail.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[native-ghs-funded-shortfall-reversal] TEST_DATABASE_URL not set — skipping.');

if (hasDb) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
    process.env.GHS_RISK_AMOUNT_POLICY = process.env.GHS_RISK_AMOUNT_POLICY
        || '{"largeGhs":1000000,"hugeGhs":2000000,"newAccountMinGhs":900000}';
}

(hasDb ? describe : describe.skip)('native-GHS funded shortfall reversal (real PostgreSQL)', () => {
    const { randomUUID } = require('crypto');
    const express = require('express');
    const request = require('supertest');
    const jwt = require('jsonwebtoken');
    const { PrismaClient, Prisma } = require('@prisma/client');

    const svc = require('../src/services/nativeGhsWithdrawalService');
    const ledger = require('../services/ledgerService');
    const ghsWallet = require('../src/services/nativeGhsWalletService');

    let prisma;
    let seedUser;
    let TEST_PASSWORD;

    const RATE = 12.5;
    const DEST = '233241234567';
    const FUNDING_KEY = (ref) => `ledger:wallet:withdrawal-ghs-funding:${ref}`;
    const FUNDING_REVERSAL_KEY = (ref) => `ledger:reversal:withdrawal-ghs-funding:${ref}`;
    const PAYOUT_KEY = (ref) => `ledger:wallet:withdrawal-ghs:${ref}`;
    const PAYOUT_REVERSAL_KEY = (ref) => `ledger:reversal:withdrawal-ghs:${ref}`;

    // Deterministic failure injection. The reversal runs inside an interactive
    // transaction, so its writes go through the TRANSACTION client: a delegate
    // spy cannot see them and Prisma 6 has no $use. A client EXTENSION does see
    // transaction queries, so the extended client is what the injected run uses.
    const injection = { target: null };
    let xprisma;

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ seedUser, TEST_PASSWORD } = require('./helpers/factories'));
        xprisma = prisma.$extends({
            query: {
                user: {
                    async updateMany({ args, query }) {
                        if (injection.target === 'projection' && args?.data?.nativeGhsBalance?.decrement) {
                            injection.target = null;
                            return { count: 0 };
                        }
                        return query(args);
                    },
                },
                transactionHistory: {
                    async updateMany({ args, query }) {
                        if (injection.target === 'canonical') {
                            injection.target = null;
                            return { count: 0 };
                        }
                        return query(args);
                    },
                },
            },
        });
    });
    afterAll(async () => { if (prisma) await prisma.$disconnect(); });
    beforeEach(() => {
        process.env.GHS_RISK_AMOUNT_POLICY = '{"largeGhs":1000000,"hugeGhs":2000000,"newAccountMinGhs":900000}';
    });
    afterEach(() => { jest.restoreAllMocks(); });

    async function setSettings() {
        const data = {
            liveRetailRate: RATE, liveUsdToGhs: RATE, liveRateSource: 'KOTANI_PAY',
            lastExternalSync: new Date(), fiatLiquidityAuthorityEnabled: true,
            modelBSettlementEnabled: false, nativeGhsSettlementEnabled: false,
            nativeGhsWithdrawalEnabled: true,
        };
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
        await prisma.fiatLiquidityState.upsert({
            where: { id: 1 },
            update: { availableGhs: 100000, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0 },
            create: { id: 1, availableGhs: 100000 },
        });
    }

    function buildApp() {
        const app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.set('logger', { error: () => {}, warn: () => {}, info: () => {} });
        app.set('emitBalanceUpdate', () => {});
        app.use((req, res, next) => { req.io = { to: () => ({ emit: () => {} }), emit: () => {} }; next(); });
        app.use('/api/withdraw', require('../routes/withdrawalRoutes'));
        return app;
    }

    const tokenFor = (user) => jwt.sign({ id: user.id, role: 'USER' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const auth = (r, user) => r.set('Authorization', `Bearer ${tokenFor(user)}`);

    async function mintShortfallQuote(user, amountGhs = '50.00') {
        const res = await auth(request(buildApp()).post('/api/withdraw/ghs/quote'), user)
            .set('Idempotency-Key', randomUUID())
            .send({ destination: DEST, network: 'MTN', amountGhs });
        expect(res.status).toBe(200);
        return res.body.quote;
    }

    async function balancesOf(userId) {
        const u = await prisma.user.findUnique({
            where: { id: userId },
            select: { nativeGhsBalance: true, availableBalance: true },
        });
        return {
            ghs: new Prisma.Decimal(u.nativeGhsBalance).toFixed(2),
            ghsExact: new Prisma.Decimal(u.nativeGhsBalance).toFixed(8),
            usdc: new Prisma.Decimal(u.availableBalance).toFixed(8),
        };
    }

    /** The representative mixed-funded payout: GHS 20.00, USDC 1000.00, GHS 50.00 out. */
    async function acceptMixedPayout({ reference = `GHST-${randomUUID()}`, amountGhs = '50.00', ghs = 20, usdc = 1000 } = {}) {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 0, availableBalance: 0 });
        // Seed BOTH balances through the ledger so the fixture is
        // ledger-complete: a projection the ledger never saw would make every
        // invariant assertion below meaningless.
        await prisma.$transaction(async (tx) => {
            await ghsWallet.creditNativeGhs({
                tx,
                userId: user.id,
                amountGhs: new Prisma.Decimal(ghs).toFixed(2),
                idempotencyKey: `test:seed:ghs:${user.id}`,
                description: 'test seed GHS',
            });
        });
        await prisma.$transaction(async (tx) => {
            const amount = new Prisma.Decimal(usdc).toFixed(8);
            await ledger.post(tx, {
                idempotencyKey: `test:seed:usdc:${user.id}`,
                entryType: 'DEPOSIT',
                description: 'test seed USDC',
                lines: [
                    { account: 'equity:treasury', debit: amount },
                    { account: `user:${user.id}:liability`, credit: amount },
                ],
            });
            await tx.user.update({
                where: { id: user.id },
                data: { availableBalance: { increment: new Prisma.Decimal(amount) } },
            });
        });
        const quote = await mintShortfallQuote(user, amountGhs);
        const facts = await svc.processNativeGhsWithdrawal(prisma, user.id, {
            amountGhs,
            destination: DEST,
            network: 'MTN',
            reference,
            quoteId: quote.quoteId,
        });
        return { user, quote, facts, reference };
    }

    const definitiveRejection = () => ({
        initiateTransfer: jest.fn(async () => {
            const err = new Error('provider refused the payout');
            err.providerOutcome = 'DEFINITIVE_REJECTION';
            throw err;
        }),
    });

    async function dispatchDefinitiveFailure(reference, amountGhsExact = '50.00') {
        return svc.dispatchNativeGhsWithdrawal(prisma, {
            reference,
            amountGhsExact,
            destination: DEST,
            network: 'MTN',
            dispatcher: definitiveRejection(),
        });
    }

    async function postingOf(idempotencyKey) {
        const row = await prisma.ledgerTransaction.findUnique({
            where: { idempotencyKey },
            include: { journalEntries: { orderBy: { lineNumber: 'asc' } } },
        });
        return row;
    }

    function netByAccount(posting) {
        const net = {};
        for (const e of posting?.journalEntries || []) {
            const cur = net[e.account] || { debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0) };
            net[e.account] = {
                debit: cur.debit.plus(new Prisma.Decimal(e.debit)),
                credit: cur.credit.plus(new Prisma.Decimal(e.credit)),
            };
        }
        return net;
    }

    // ── 1. THE P0: exact inverse reversal of a funded shortfall ─────────────
    test('funded shortfall reversal restores the customer exactly, once, and nets the payout to zero', async () => {
        const { user, quote, reference } = await acceptMixedPayout();

        // the acceptance really did fund a 30.00 shortfall from USDC
        expect(quote.shortfallGhs).toBe('30.00');
        const afterAccept = await balancesOf(user.id);
        expect(afterAccept.ghs).toBe('0.00');
        expect(new Prisma.Decimal(afterAccept.usdc).equals(new Prisma.Decimal('997.6'))).toBe(true);

        const funding = await postingOf(FUNDING_KEY(reference));
        expect(funding).toBeTruthy();
        expect(funding.conversionIdentity).toBe(`withdrawal-ghs-funding:${reference}`);
        const fundingNet = netByAccount(funding);

        const result = await dispatchDefinitiveFailure(reference);
        expect(result.reason).toBe('PROVIDER_REJECTED');
        expect(result.reversed).toBe(true);

        // ── balances: GHS 20.00 (NOT 50.00), USDC 1000.00 ──────────────────
        const after = await balancesOf(user.id);
        expect(after.ghs).toBe('20.00');
        expect(after.usdc).toBe('1000.00000000');

        // ── both projections agree with their own ledger liability account ──
        const ghsRecon = await ghsWallet.ghsWalletReconciliation({ db: prisma, userId: user.id });
        expect(ghsRecon.reconciled).toBe(true);
        expect(ghsRecon.projectionExact.toFixed(2)).toBe('20.00');
        expect(ghsRecon.ledgerLiabilityExact.toFixed(2)).toBe('20.00');
        const usdcLiability = await ledger.accountBalance(prisma, `user:${user.id}:liability`);
        // the USDC liability is a credit-normal account: balance is positive owed
        expect(new Prisma.Decimal(usdcLiability.balance).toFixed(8)).toBe('1000.00000000');

        // ── the original funding conversion is untouched ────────────────────
        const fundingAfter = await postingOf(FUNDING_KEY(reference));
        expect(fundingAfter.id).toBe(funding.id);
        expect(fundingAfter.conversionIdentity).toBe(`withdrawal-ghs-funding:${reference}`);
        expect(fundingAfter.postingHash).toBe(funding.postingHash);
        expect(fundingAfter.journalEntries).toHaveLength(funding.journalEntries.length);

        // ── the reversal conversion exists EXACTLY once, under its own id ───
        const reversals = await prisma.ledgerTransaction.findMany({
            where: { reference, entryType: 'ASSET_CONVERSION' },
            include: { journalEntries: true },
        });
        const fundingReversal = reversals.find((r) => r.idempotencyKey === FUNDING_REVERSAL_KEY(reference));
        expect(fundingReversal).toBeTruthy();
        expect(fundingReversal.conversionIdentity).toBe(`withdrawal-ghs-funding-reversal:${reference}`);
        expect(fundingReversal.conversionIdentity).not.toBe(funding.conversionIdentity);
        expect(reversals.filter((r) => r.idempotencyKey === FUNDING_REVERSAL_KEY(reference))).toHaveLength(1);

        // ── it is the exact inverse, asset by asset ─────────────────────────
        const reversalNet = netByAccount(fundingReversal);
        for (const account of Object.keys(fundingNet)) {
            const forward = fundingNet[account].debit.minus(fundingNet[account].credit);
            const backward = reversalNet[account].debit.minus(reversalNet[account].credit);
            expect(backward.plus(forward).isZero()).toBe(true);
        }
        expect(reversalNet[`user:${user.id}:liability`].credit.toFixed(8)).toBe('2.40000000'); // 30.00 / 12.5
        expect(reversalNet[`ghs:user:${user.id}:liability`].debit.toFixed(2)).toBe('30.00');

        // ── audit evidence links back to the funding exchange ───────────────
        const reversalMeta = fundingReversal.metadata || {};
        expect(reversalMeta.reversal).toBe(true);
        expect(reversalMeta.reversesConversionIdentity).toBe(`withdrawal-ghs-funding:${reference}`);
        expect(reversalMeta.originalFundingLedgerKey).toBe(FUNDING_KEY(reference));
        expect(String(reversalMeta.reversalReason)).toContain('provider_rejected');
        expect(reversalMeta.shortfallGhs).toBe('30.00');
        expect(reversalMeta.usdcRestoredExact).toBe('2.40000000');
        expect(reversalMeta.quoteId).toBe(String(quote.quoteId));

        // ── the payout debit and its reversal net to zero for the customer ──
        const payout = await postingOf(PAYOUT_KEY(reference));
        const payoutReversal = await postingOf(PAYOUT_REVERSAL_KEY(reference));
        expect(payout).toBeTruthy();
        expect(payoutReversal).toBeTruthy();
        const payoutNet = netByAccount(payout);
        const payoutReversalNet = netByAccount(payoutReversal);
        const wallet = `ghs:user:${user.id}:liability`;
        const forward = payoutNet[wallet].debit.minus(payoutNet[wallet].credit);
        const backward = payoutReversalNet[wallet].debit.minus(payoutReversalNet[wallet].credit);
        expect(backward.plus(forward).isZero()).toBe(true);
        expect(forward.toFixed(2)).toBe('50.00');

        // ── the reservation was released exactly once ──────────────────────
        const reservation = await prisma.fiatLiquidityReservation.findUnique({ where: { reference } });
        expect(reservation.status).toBe('RELEASED');
        expect(reservation.releasedAt).toBeTruthy();

        // ── canonical + mirror agree on a terminal FAILED state ─────────────
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonical.status).toBe('FAILED');
        const mirror = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } });
        expect(mirror.status).toBe('FAILED');
        expect(canonical.metadata.nativeGhsWithdrawalReversal).toBeTruthy();
        expect(String(canonical.metadata.nativeGhsWithdrawalReversal.reason)).toContain('provider_rejected');

        // ── a second reversal changes nothing at all ────────────────────────
        const before = {
            balances: await balancesOf(user.id),
            ledgerRows: await prisma.ledgerTransaction.count({ where: { reference } }),
            journalRows: await prisma.journalEntry.count({ where: { reference } }),
            mirror: (await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } })).status,
        };
        const again = await svc.reverseNativeGhsWithdrawal(prisma, { reference, reason: 'replay' });
        expect(again.reversed).toBe(false);
        expect(again.reason).toBe('NOT_REVERSIBLE_IN_STATE');
        const afterSecond = {
            balances: await balancesOf(user.id),
            ledgerRows: await prisma.ledgerTransaction.count({ where: { reference } }),
            journalRows: await prisma.journalEntry.count({ where: { reference } }),
            mirror: (await prisma.withdrawal.findFirst({ where: { transactionHistoryId: canonical.id } })).status,
        };
        expect(afterSecond).toEqual(before);
    });

    // ── 2. recorded fee is refunded, not recomputed ─────────────────────────
    test('the refund is the RECORDED debit including a non-zero fee, and the shortfall still comes out', async () => {
        const { user, reference } = await acceptMixedPayout();
        // §P1-3 policy forbids charging a non-zero fee today, so the fee
        // evidence is written onto the row the way a future approved policy
        // would record it. The reversal must read it, never recompute it.
        const row = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        await prisma.transactionHistory.update({
            where: { id: row.id },
            data: { metadata: { ...(row.metadata || {}), feeGhs: '1.50' } },
        });
        process.env.BANK_PAYOUT_FEE_GHS = ''; // must not influence the reversal

        const result = await svc.reverseNativeGhsWithdrawal(prisma, { reference, reason: 'recorded_fee_check' });
        expect(result.reversed).toBe(true);
        expect(result.refundGhs).toBe('51.50');
        expect(result.fundingReversal.shortfallGhs).toBe('30.00');
        // 0.00 after acceptance + 51.50 refund − 30.00 shortfall reversed = 21.50
        const after = await balancesOf(user.id);
        expect(after.ghs).toBe('21.50');
        expect(after.usdc).toBe('1000.00000000');
        const recon = await ghsWallet.ghsWalletReconciliation({ db: prisma, userId: user.id });
        expect(recon.reconciled).toBe(true);
    });

    // ── 3. concurrency: two simultaneous reversals refund once ──────────────
    test('two simultaneous reversals produce exactly one refund', async () => {
        const { user, reference } = await acceptMixedPayout();
        const [a, b] = await Promise.all([
            svc.reverseNativeGhsWithdrawal(prisma, { reference, reason: 'race_a' }),
            svc.reverseNativeGhsWithdrawal(prisma, { reference, reason: 'race_b' }),
        ]);
        expect([a.reversed, b.reversed].filter(Boolean)).toHaveLength(1);
        const after = await balancesOf(user.id);
        expect(after.ghs).toBe('20.00');
        expect(after.usdc).toBe('1000.00000000');
        expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: FUNDING_REVERSAL_KEY(reference) } })).toBe(1);
        const recon = await ghsWallet.ghsWalletReconciliation({ db: prisma, userId: user.id });
        expect(recon.reconciled).toBe(true);
    });

    // ── 4. non-reversible terminal state ────────────────────────────────────
    test('a payout that already settled is never refunded', async () => {
        const { user, reference } = await acceptMixedPayout();
        const row = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        await prisma.withdrawal.updateMany({ where: { transactionHistoryId: row.id }, data: { status: 'COMPLETED' } });
        const before = await balancesOf(user.id);
        const result = await svc.reverseNativeGhsWithdrawal(prisma, { reference, reason: 'should_refuse' });
        expect(result.reversed).toBe(false);
        expect(result.reason).toBe('ALREADY_PAID_OR_COMPLETED');
        expect(await balancesOf(user.id)).toEqual(before);
        expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: FUNDING_REVERSAL_KEY(reference) } })).toBe(0);
    });

    // ── 5. injected failures leave NO partial refund ────────────────────────
    describe('injected failures roll the whole boundary back', () => {
        async function expectNoPartial(user, reference) {
            const b = await balancesOf(user.id);
            expect(b.ghs).toBe('0.00'); // still debited, still not refunded
            expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: FUNDING_REVERSAL_KEY(reference) } })).toBe(0);
            expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: PAYOUT_REVERSAL_KEY(reference) } })).toBe(0);
            const reservation = await prisma.fiatLiquidityReservation.findUnique({ where: { reference } });
            expect(reservation.status).toBe('RESERVED');
            const row = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
            expect(row.status).toBe('PENDING'); // never told the customer a refund happened
            expect(row.metadata?.nativeGhsWithdrawalReversal).toBeUndefined();
            const recon = await ghsWallet.ghsWalletReconciliation({ db: prisma, userId: user.id });
            expect(recon.reconciled).toBe(true);
        }

        test('ledger identity conflict refuses without moving money', async () => {
            const { user, reference } = await acceptMixedPayout();
            // occupy the reversal identity with a DIFFERENT posting
            await prisma.ledgerTransaction.create({
                data: {
                    idempotencyKey: FUNDING_REVERSAL_KEY(reference),
                    entryType: 'ASSET_CONVERSION',
                    description: 'squatter',
                    postingHash: 'x'.repeat(64),
                    conversionIdentity: `withdrawal-ghs-funding-reversal:${reference}`,
                    reference,
                },
            });
            await expect(svc.reverseNativeGhsWithdrawal(prisma, { reference, reason: 'conflict' })).rejects.toBeTruthy();
            const b = await balancesOf(user.id);
            expect(b.ghs).toBe('0.00');
            expect(b.usdc).toBe('997.60000000');
            const row = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
            expect(row.status).toBe('PENDING');
        });

        test('a failure while correcting the GHS projection rolls the whole boundary back', async () => {
            const { user, reference } = await acceptMixedPayout();
            injection.target = 'projection';
            await expect(svc.reverseNativeGhsWithdrawal(xprisma, { reference, reason: 'projection' }))
                .rejects.toMatchObject({ code: 'NATIVE_GHS_FUNDING_REVERSAL_PROJECTION_FAILED' });
            expect(injection.target).toBeNull(); // the guard really was reached
            const b = await balancesOf(user.id);
            expect(b.ghs).toBe('0.00'); // refund rolled back with it
            expect(b.usdc).toBe('997.60000000'); // USDC restore rolled back too
            const row = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
            expect(row.status).toBe('PENDING');
            expect(row.metadata?.nativeGhsWithdrawalReversal).toBeUndefined();
            expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: FUNDING_REVERSAL_KEY(reference) } })).toBe(0);
            expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: PAYOUT_REVERSAL_KEY(reference) } })).toBe(0);
            const reservation = await prisma.fiatLiquidityReservation.findUnique({ where: { reference } });
            expect(reservation.status).toBe('RESERVED');
            const recon = await ghsWallet.ghsWalletReconciliation({ db: prisma, userId: user.id });
            expect(recon.reconciled).toBe(true);
        });

        test('an unknown reservation refuses the reversal', async () => {
            const { user, reference } = await acceptMixedPayout();
            await prisma.fiatLiquidityReservation.delete({ where: { reference } });
            await expect(svc.reverseNativeGhsWithdrawal(prisma, { reference, reason: 'no_reservation' })).rejects.toBeTruthy();
            const b = await balancesOf(user.id);
            expect(b.ghs).toBe('0.00');
            expect(b.usdc).toBe('997.60000000');
        });

        test('canonical terminal-state CAS that claims nothing rolls everything back', async () => {
            const { user, reference } = await acceptMixedPayout();
            injection.target = 'canonical';
            await expect(svc.reverseNativeGhsWithdrawal(xprisma, { reference, reason: 'cas' }))
                .rejects.toMatchObject({ code: 'NATIVE_GHS_REVERSAL_RACED' });
            expect(injection.target).toBeNull();
            const b = await balancesOf(user.id);
            expect(b.ghs).toBe('0.00');
            expect(b.usdc).toBe('997.60000000');
            expect((await prisma.transactionHistory.findUnique({ where: { txHash: reference } })).status).toBe('PENDING');
            expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: FUNDING_REVERSAL_KEY(reference) } })).toBe(0);
            expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: PAYOUT_REVERSAL_KEY(reference) } })).toBe(0);
            const reservation = await prisma.fiatLiquidityReservation.findUnique({ where: { reference } });
            expect(reservation.status).toBe('RESERVED');
        });
    });

    // ── 6. funding evidence is evidence, not instruction ────────────────────
    describe('malformed funding evidence refuses safely and leaves durable evidence', () => {
        const cases = [
            ['missing shortfall', { shortfallGhs: null }],
            ['zero shortfall', { shortfallGhs: '0.00' }],
            ['negative shortfall', { shortfallGhs: '-30.00' }],
            ['sub-pesewa shortfall', { shortfallGhs: '30.001' }],
            ['missing usdc debit', { usdcDebitedExact: null }],
            ['zero usdc debit', { usdcDebitedExact: '0.00000000' }],
            ['missing rate', { rateGhsPerUsdcExact: null }],
            ['zero rate', { rateGhsPerUsdcExact: '0.00000000' }],
            ['missing quote reference', { quoteId: null }],
            ['shortfall beyond the refund', { shortfallGhs: '60.00' }],
            ['inconsistent rate/amount', { rateGhsPerUsdcExact: '99.00000000' }],
            ['unrecognised mode', { mode: 'SOMETHING_ELSE' }],
        ];

        test.each(cases)('%s', async (_label, patch) => {
            const { user, reference } = await acceptMixedPayout();
            const row = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
            const funding = { ...(row.metadata.funding || {}), ...patch };
            for (const [k, v] of Object.entries(patch)) {
                if (v === null) delete funding[k];
            }
            await prisma.transactionHistory.update({
                where: { id: row.id },
                data: { metadata: { ...(row.metadata || {}), funding } },
            });

            await expect(svc.reverseNativeGhsWithdrawal(prisma, { reference, reason: 'bad_evidence' }))
                .rejects.toMatchObject({ code: 'NATIVE_GHS_FUNDING_EVIDENCE_INVALID' });

            const b = await balancesOf(user.id);
            expect(b.ghs).toBe('0.00');
            expect(b.usdc).toBe('997.60000000');
            const after = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
            expect(after.status).toBe('PENDING');
            expect(after.metadata?.nativeGhsWithdrawalReversal).toBeUndefined();
            // durable, out-of-transaction reconciliation evidence
            // the queue lives outside the generated client (raw-SQL authority)
            const exceptions = await prisma.$queryRawUnsafe(
                'SELECT "reason" FROM "ReconciliationException" WHERE "reference" = $1',
                reference
            );
            expect(exceptions.some((e) => e.reason === 'NATIVE_GHS_FUNDING_EVIDENCE_INVALID')).toBe(true);
            const recon = await ghsWallet.ghsWalletReconciliation({ db: prisma, userId: user.id });
            expect(recon.reconciled).toBe(true);
        });
    });

    // ── 7. §5 zero-USDC rounding boundary ───────────────────────────────────
    test('a shortfall whose USDC debit rounds to zero is refused before any funding', async () => {
        await setSettings();
        // 0.001 GHS at a huge rate is still a positive GHS shortfall, but the
        // 8dp USDC quotient rounds to zero — that must never fund it.
        await prisma.globalSettings.update({ where: { id: 1 }, data: { liveRetailRate: 100000000, liveUsdToGhs: 100000000 } });
        const user = await seedUser(prisma, { nativeGhsBalance: 0, availableBalance: 1000 });
        const before = await balancesOf(user.id);
        const reference = `GHST-ZERO-${randomUUID()}`;

        let quote = null;
        try {
            quote = await mintShortfallQuote(user, '0.01');
        } catch (_) { /* the quote authority may refuse it first — also safe */ }

        if (quote) {
            await expect(svc.processNativeGhsWithdrawal(prisma, user.id, {
                amountGhs: '0.01',
                destination: DEST,
                network: 'MTN',
                reference,
                quoteId: quote.quoteId,
            })).rejects.toBeTruthy();
            expect(await balancesOf(user.id)).toEqual(before);
            expect(await prisma.ledgerTransaction.count({ where: { reference } })).toBe(0);
        } else {
            expect(await balancesOf(user.id)).toEqual(before);
        }
    });

    // ── 8. §6 MoMo fee policy is isolated from the bank rail ────────────────
    test('BANK_PAYOUT_FEE_GHS does not move the MoMo shortfall plan or its quote', async () => {
        await setSettings();
        const user = await seedUser(prisma, { nativeGhsBalance: 20, availableBalance: 1000 });

        const baseline = await mintShortfallQuote(user, '50.00');
        const planOf = (q) => ({ shortfall: q.shortfallGhs, usdc: q.usdcAmount, rate: q.rateGhsPerUsdc });

        for (const value of ['', '0', '7.25', 'not-a-number']) {
            if (value === '') delete process.env.BANK_PAYOUT_FEE_GHS;
            else process.env.BANK_PAYOUT_FEE_GHS = value;
            const q = await mintShortfallQuote(user, '50.00');
            expect(planOf(q)).toEqual(planOf(baseline));
            expect(q.shortfallGhs).toBe('30.00');
        }
        delete process.env.BANK_PAYOUT_FEE_GHS;
        // and the service's own per-rail policy agreement
        expect(svc.momoPayoutFeePolicy().feeGhs).toBe('0.00');
        expect(svc.momoPayoutFeePolicy().code).toBe('ZERO_FEE_V1');
    });

    // ── 9. §7 provider echo binding on the bank dispatch observation ────────
    describe('bank dispatch observation binds the provider echo', () => {
        const AMOUNT = '410.00';
        const evaluate = (outbound) => svc.evaluateBankDispatchObservation(
            outbound,
            { reference: 'AZM-REF-1', amountGhsExact: AMOUNT }
        );

        test('the evaluator is exported for consumer-side assertions', () => {
            expect(typeof svc.evaluateBankDispatchObservation).toBe('function');
        });

        test('a missing provider echo is parked, never accepted', () => {
            const v = evaluate({ provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', status: 'PENDING', amountGhsExact: AMOUNT, referenceId: 'AZM-REF-1', providerRef: 'p1' });
            expect(v.decision).toBe('PARKED');
            expect(v.reason).toBe('PROVIDER_ECHO_MISSING');
        });

        test('a mismatching provider echo is parked and never adopted', () => {
            const v = evaluate({ provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', status: 'PENDING', amountGhsExact: AMOUNT, referenceId: 'AZM-REF-1', externalId: 'SOMEONE-ELSE', providerRef: 'p1' });
            expect(v.decision).toBe('PARKED');
            expect(v.reason).toBe('PROVIDER_ECHO_MISMATCH');
            expect(v.observedExternalId).toBe('SOMEONE-ELSE');
        });

        test('a matching echo is accepted as an observation, with the exact amount', () => {
            const v = evaluate({
                provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', status: 'PENDING', amountGhsExact: AMOUNT,
                referenceId: 'AZM-REF-1', externalId: 'AZM-REF-1', providerRef: 'p1',
                providerStatusRaw: '1', feeAmount: '2.00', providerFee: '1.00',
            });
            expect(v.decision).toBe('ACCEPTED');
            expect(v.providerEchoAtInitiation).toBe('AZM-REF-1');
            expect(v.amountGhsExact).toBe(AMOUNT);
            // individual fee facts are retained verbatim, never summed
            expect(v.providerFeeFacts).toEqual({ feeAmount: '2.00', providerFee: '1.00' });
            expect(JSON.stringify(v.providerFeeFacts)).not.toContain('3.00');
        });

        test('a missing amount is parked', () => {
            const v = evaluate({ provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', status: 'PENDING', referenceId: 'AZM-REF-1', externalId: 'AZM-REF-1' });
            expect(v.decision).toBe('PARKED');
            expect(v.reason).toBe('DISPATCH_AMOUNT_MISSING');
        });

        test('a mismatching amount is parked', () => {
            const v = evaluate({ provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', status: 'PENDING', amountGhsExact: '409.99', referenceId: 'AZM-REF-1', externalId: 'AZM-REF-1' });
            expect(v.decision).toBe('PARKED');
            expect(v.reason).toBe('DISPATCH_AMOUNT_MISMATCH');
        });

        test('UNRESOLVED stays unresolved and terminal-at-initiation stays parked', () => {
            const unresolved = evaluate({ provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', status: 'UNRESOLVED', reason: 'TIMEOUT', referenceId: 'AZM-REF-1' });
            expect(unresolved.decision).toBe('UNRESOLVED');
            const terminal = evaluate({ provider: 'MOOLRE_DISBURSEMENT', rail: 'BANK', status: 'FAILED', amountGhsExact: AMOUNT, referenceId: 'AZM-REF-1', externalId: 'AZM-REF-1' });
            expect(terminal.decision).toBe('PARKED');
            expect(terminal.reason).toBe('DISPATCH_TERMINAL_AT_INITIATION');
        });
    });
});
