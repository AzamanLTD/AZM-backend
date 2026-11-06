// __tests__/p5d-legacy-under-authority-regime.test.js
// =============================================================================
// §P.5-D MIXED-REGIME OVER-DISPATCH — real-PostgreSQL regression suite.
//
// THE REPRODUCED DEFECT: a legacy 50 USDC withdrawal without a
// FiatLiquidityReservation was dispatched for 650 GHS while
// FiatLiquidityState.availableGhs was 600. The authority reservation had already
// written SystemFiatPool.balance = 600 GHS, but the legacy payout gate compared
// that GHS projection against USDC values (threshold 100 USDC / amount 50 USDC),
// both of which "passed" — so a 600 GHS pool paid out 650 GHS in the wrong unit.
//
// PROVES:
//   A. Flag OFF, genuine legacy row, no reservation: historical behaviour is
//      byte-identical (dispatch, USDC gauge decrement) — nothing regressed.
//   B. Authority mode active, unreserved legacy row: NO provider call; the row
//      is durably parked through the real reconciliation infrastructure with
//      reason LEGACY_ROW_UNDER_AUTHORITY_REGIME and the GHS projection is
//      untouched.
//   C. Authority mode active, authority-backed reservation: the exact reserved
//      GHS is still dispatched.
//   D. Deactivation after activation is refused; the database stays in
//      authority mode even if the Boolean is cleared.
//   E. Mixed multi-row batch: no USDC amount is subtracted from a GHS gauge.
//   F. Activation preflight refuses unresolved legacy withdrawals (pending,
//      approved, in flight and unknown-outcome).
//   G. Activation succeeds once those are resolved, and writes the one-way
//      latch.
//   H. GET /api/finance/fiat-pool-status reports the value and its threshold in
//      the actual unit, with the matching classification.
//
// Requires the payout-reconciliation infrastructure overlay (ReconciliationException);
// the financial-durability lane installs it. The provider adapter is mocked —
// no real provider is contacted. Skips cleanly without TEST_DATABASE_URL.
// =============================================================================

jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[p5d-legacy-under-authority.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('§P.5-D mixed-regime over-dispatch (real PostgreSQL)', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');
    const activation = require('../src/services/fiatLiquidityActivationService');

    const dec = (v) => Number(v === null || v === undefined ? 0 : v.toString());

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        const table = await prisma.$queryRawUnsafe(
            `SELECT to_regclass('public."ReconciliationException"')::text AS name`
        );
        if (!table[0] || !table[0].name) {
            throw new Error('This suite needs the payout-reconciliation infrastructure overlay (ReconciliationException). Run node infra/install-payout-reconciliation-infra.js against the test database.');
        }
    });

    afterAll(async () => {
        if (prisma) {
            await prisma.$executeRawUnsafe('DELETE FROM "AdminProfitLog"');
            await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
            await prisma.$executeRawUnsafe('DELETE FROM "SystemMasterCrypto"');
            await prisma.$executeRawUnsafe('DELETE FROM "SystemFiatPool"');
            await prisma.$executeRawUnsafe('DELETE FROM "SystemProfitFees"');
            // §CROSS-SUITE HYGIENE: activation and the latch are GLOBAL state.
            // Leaving authority mode on for whatever suite runs next changes its
            // money paths (a real lane failure: a BANK refund then took the
            // authority branch and the wallet reconciliation disagreed). Every
            // global this suite touches is restored to the default-off shape.
            await prisma.$executeRawUnsafe('DELETE FROM "Withdrawal"');
            await prisma.$executeRawUnsafe('DELETE FROM "TransactionHistory"');
            await prisma.$executeRawUnsafe('DELETE FROM "FiatLiquidityReservation"');
            await prisma.$executeRawUnsafe('DELETE FROM "FiatProviderEvent"');
            await prisma.$executeRawUnsafe('DELETE FROM "ReconciliationException"');
            await prisma.fiatLiquidityState.upsert({
                where: { id: 1 },
                update: { availableGhs: 0, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0, authorityActivatedAt: null },
                create: { id: 1 },
            });
            await prisma.globalSettings.update({
                where: { id: 1 },
                data: { fiatLiquidityAuthorityEnabled: false, autoPayoutEnabled: false },
            }).catch(() => null);
            await prisma.$disconnect();
        }
    });

    beforeEach(async () => {
        // Hermetic per-test money surface: withdrawals, their canonical rows and
        // every liquidity record — otherwise a dispatched row from a previous
        // test is still an "unresolved legacy withdrawal" and the activation
        // preflight correctly refuses.
        await prisma.$executeRawUnsafe('DELETE FROM "Withdrawal"');
        await prisma.$executeRawUnsafe('DELETE FROM "TransactionHistory"');
        await prisma.$executeRawUnsafe('DELETE FROM "FiatProviderEvent"');
        await prisma.$executeRawUnsafe('DELETE FROM "FiatLiquidityReservation"');
        await prisma.$executeRawUnsafe('DELETE FROM "ReconciliationException"');
        await prisma.fiatLiquidityState.upsert({
            where: { id: 1 },
            // Test-only latch reset: production never clears it.
            update: { availableGhs: 0, reservedGhs: 0, inTransitGhs: 0, paidOutGhs: 0, reconciliationHeldGhs: 0, authorityActivatedAt: null },
            create: { id: 1 },
        });
        await prisma.systemFiatPool.upsert({ where: { id: 1 }, update: { balance: 0 }, create: { id: 1, balance: 0 } });
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { fiatLiquidityAuthorityEnabled: false, autoPayoutEnabled: true, autoPayoutThresholdUsdc: 100, autoPayoutMaxAmountUsdc: 5000, liveRetailRate: 13.42 },
            create: { id: 1, fiatLiquidityAuthorityEnabled: false, autoPayoutEnabled: true, autoPayoutThresholdUsdc: 100, autoPayoutMaxAmountUsdc: 5000, liveRetailRate: 13.42 },
        });
    });

    const settings = () => prisma.globalSettings.findUnique({ where: { id: 1 } });
    const state = () => prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });

    const PayoutBatchWorker = require('../workers/payoutBatchWorker');
    function buildWorker(transfer) {
        const mockTransfer = transfer || jest.fn().mockResolvedValue({
            _provider: 'mtn', provider: 'MTN_MOMO_DISBURSEMENT', status: 'ACCEPTED',
            data: { reference: 'MTN-P5D' }, providerRef: 'MTN-P5D',
        });
        const worker = new PayoutBatchWorker(prisma, null, { initiateTransfer: mockTransfer }, null);
        worker.mtn = { initiateTransfer: mockTransfer };
        const spy = jest.fn().mockResolvedValue(undefined);
        worker.notificationService = { sendNotification: spy };
        return { worker, transfer: mockTransfer };
    }

    /** A genuine legacy pair: Withdrawal + its canonical WITHDRAWAL_FIAT row, no reservation. */
    async function legacyWithdrawal(user, amountUsdc, status = 'PENDING') {
        const created = new Date(Date.now() - 10 * 60_000);
        const th = await prisma.transactionHistory.create({
            data: {
                userId: user.id, type: 'WITHDRAWAL_FIAT', amountUsdc, status: 'PENDING',
                txHash: `legacy-p5d-${user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                createdAt: created,
            },
        });
        const w = await prisma.withdrawal.create({
            data: {
                userId: user.id, amount: amountUsdc, status,
                payoutMethod: 'MTN_MOMO', destination: '0241234567', network: 'MTN',
                transactionHistoryId: th.id, createdAt: created,
            },
        });
        return { withdrawal: w, canonical: th };
    }

    async function reservedWithdrawal(user, amountUsdc, amountGhs) {
        const { withdrawal, canonical } = await legacyWithdrawal(user, amountUsdc);
        await prisma.fiatLiquidityState.update({ where: { id: 1 }, data: { availableGhs: 0 } });
        await prisma.fiatLiquidityReservation.create({
            data: {
                reference: canonical.txHash,
                amountGhs,
                provider: 'MTN_MOMO_DISBURSEMENT',
                rail: 'MOMO',
                status: 'RESERVED',
                relatedTransactionId: String(canonical.id),
            },
        });
        await prisma.fiatLiquidityState.update({
            where: { id: 1 }, data: { reservedGhs: amountGhs },
        });
        return { withdrawal, canonical };
    }

    async function activate() {
        return activation.activateAuthority(prisma, { actor: 'test', reason: 'suite' });
    }

    // ── A. genuinely legacy regime ─────────────────────────────────────────
    test('A. flag OFF, legacy row, no reservation: historical dispatch is unchanged', async () => {
        await prisma.systemFiatPool.update({ where: { id: 1 }, data: { balance: 2000 } });
        const user = await seedUser(prisma, { availableBalance: 500 });
        await legacyWithdrawal(user, 20);
        const { worker, transfer } = buildWorker();

        const results = await worker._processBatch(await settings(), { isManualTrigger: true });
        expect(results.processed).toBe(1);
        expect(results.details.flaggedManualReview).toHaveLength(0);
        expect(transfer).toHaveBeenCalledTimes(1);
        // exact USDC -> GHS conversion at the live rate
        expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ amountGhs: parseFloat((20 * 13.42).toFixed(2)) }));
        expect(results.poolBalance).toBe(2000 - 20);
        expect(await prisma.fiatLiquidityReservation.count()).toBe(0);
    });

    // ── B. the reproduced over-dispatch ────────────────────────────────────
    test('B. authority mode active, unreserved legacy row: no provider call, durably parked', async () => {
        // The exact reported shape: 600 GHS of authority liquidity mirrored into
        // the pool, a 50 USDC legacy row, a 100 USDC threshold.
        await activate();
        await prisma.fiatLiquidityState.update({ where: { id: 1 }, data: { availableGhs: 600 } });
        await prisma.systemFiatPool.update({ where: { id: 1 }, data: { balance: 600 } });
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { withdrawal } = await legacyWithdrawal(user, 50);
        const { worker, transfer } = buildWorker();

        const results = await worker._processBatch(await settings(), { isManualTrigger: true });

        expect(transfer).not.toHaveBeenCalled();
        expect(results.processed).toBe(0);
        expect(results.flagged).toBe(1);
        expect(results.details.flaggedManualReview[0]).toMatchObject({
            id: withdrawal.id, reason: 'LEGACY_ROW_UNDER_AUTHORITY_REGIME',
        });
        // no USDC amount was subtracted from the GHS gauge, and none was read
        expect(results.poolBalance).toBeNull();
        const st = await state();
        expect(dec(st.availableGhs)).toBeCloseTo(600, 2);
        expect(dec(await prisma.systemFiatPool.findUnique({ where: { id: 1 } }).then((p) => p.balance))).toBeCloseTo(600, 2);
        // durable parking through the real reconciliation infrastructure
        const row = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
        expect(row.status).toBe('NEEDS_MANUAL_REVIEW');
        // ReconciliationException is overlay-provisioned (raw table, not a
        // Prisma model), so it is read through SQL exactly as operators do.
        const exceptions = await prisma.$queryRawUnsafe(
            'SELECT "reason", "status", "entityType", "entityId" FROM "ReconciliationException" WHERE "entityType" = $1 AND "entityId" = $2',
            'WITHDRAWAL', String(withdrawal.id)
        );
        expect(exceptions).toHaveLength(1);
        expect(exceptions[0].reason).toBe('LEGACY_ROW_UNDER_AUTHORITY_REGIME');
        expect(exceptions[0].status).toBe('OPEN');
    });

    // ── C. authority-backed rows are untouched ─────────────────────────────
    test('C. authority mode active, reserved row: the exact reserved GHS is dispatched', async () => {
        await activate();
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { canonical } = await reservedWithdrawal(user, 50, 650);
        // headroom for the operational floor only; the reserved 650 is spent
        await prisma.fiatLiquidityState.update({ where: { id: 1 }, data: { availableGhs: 5000 } });
        const { worker, transfer } = buildWorker();

        const results = await worker._processBatch(await settings(), { isManualTrigger: true });
        expect(results.processed).toBe(1);
        expect(transfer).toHaveBeenCalledTimes(1);
        expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ amountGhs: 650 }));
        const rz = await prisma.fiatLiquidityReservation.findUnique({ where: { reference: canonical.txHash } });
        expect(rz.status).toBe('IN_TRANSIT');
        const st = await state();
        // RESERVED -> IN_TRANSIT moves the reserved amount; available untouched
        expect(dec(st.availableGhs)).toBeCloseTo(5000, 2);
        expect(dec(st.inTransitGhs)).toBeCloseTo(650, 2);
    });

    // ── D. the latch is one-way ────────────────────────────────────────────
    test('D. deactivation after activation is refused, and clearing the Boolean cannot restore USDC meaning', async () => {
        const activated = await activate();
        expect(activated.active).toBe(true);
        expect(activated.latched).toBe(true);

        await expect(activation.assertDeactivationAllowed(prisma)).rejects.toMatchObject({
            code: 'P5D_DEACTIVATION_REFUSED',
        });

        // An operator clearing the Boolean is not a supported procedure; even if
        // it happens, the latched database must stay in authority mode.
        await prisma.globalSettings.update({ where: { id: 1 }, data: { fiatLiquidityAuthorityEnabled: false } });
        const mode = await activation.readMode(prisma);
        expect(mode.active).toBe(true);
        expect(mode.authorityUnit).toBe('GHS');

        // …and the worker still refuses a legacy row rather than reinterpreting
        // the GHS projection as USDC.
        await prisma.fiatLiquidityState.update({ where: { id: 1 }, data: { availableGhs: 600 } });
        await prisma.systemFiatPool.update({ where: { id: 1 }, data: { balance: 600 } });
        const user = await seedUser(prisma, { availableBalance: 500 });
        await legacyWithdrawal(user, 50);
        const { worker, transfer } = buildWorker();
        const results = await worker._processBatch(await settings(), { isManualTrigger: true });
        expect(transfer).not.toHaveBeenCalled();
        expect(results.details.flaggedManualReview[0].reason).toBe('LEGACY_ROW_UNDER_AUTHORITY_REGIME');
    });

    // ── E. mixed batch, no cross-unit gauge arithmetic ──────────────────────
    test('E. mixed batch: reserved row dispatches, legacy row parks, no USDC subtracted from the GHS gauge', async () => {
        await activate();
        const reservedUser = await seedUser(prisma, { availableBalance: 800 });
        const legacyUser = await seedUser(prisma, { availableBalance: 800 });
        await reservedWithdrawal(reservedUser, 30, 400);
        await prisma.fiatLiquidityState.update({ where: { id: 1 }, data: { availableGhs: 6000 } });
        await legacyWithdrawal(legacyUser, 50);
        await prisma.systemFiatPool.update({ where: { id: 1 }, data: { balance: 6000 } });
        const { worker, transfer } = buildWorker();

        const results = await worker._processBatch(await settings(), { isManualTrigger: true });
        expect(transfer).toHaveBeenCalledTimes(1);
        expect(results.processed).toBe(1);
        expect(results.flagged).toBe(1);
        expect(results.details.flaggedManualReview[0].reason).toBe('LEGACY_ROW_UNDER_AUTHORITY_REGIME');
        // the legacy gauge was never initialised, so nothing could be subtracted from it
        expect(results.poolBalance).toBeNull();
        const pool = await prisma.systemFiatPool.findUnique({ where: { id: 1 } });
        expect(dec(pool.balance)).toBeCloseTo(6000, 2);
    });

    // ── F. activation preflight refuses unresolved legacy rows ─────────────
    test('F. activation is REFUSED while unresolved legacy withdrawals remain', async () => {
        const user = await seedUser(prisma, { availableBalance: 500, });
        const other = await seedUser(prisma, { availableBalance: 500 });
        const inFlight = await seedUser(prisma, { availableBalance: 500 });
        await legacyWithdrawal(user, 50, 'PENDING');
        await legacyWithdrawal(other, 20, 'APPROVED');
        await legacyWithdrawal(inFlight, 10, 'PROCESSING');

        const preflight = await activation.activationPreflight(prisma);
        expect(preflight.ok).toBe(false);
        const kinds = preflight.blockers.map((b) => b.kind);
        expect(kinds.every((k) => k === 'LEGACY_WITHDRAWAL_UNRESERVED')).toBe(true);
        expect(preflight.blockers.map((b) => b.status).sort()).toEqual(['APPROVED', 'PENDING', 'PROCESSING']);

        await expect(activate()).rejects.toMatchObject({ code: 'P5D_ACTIVATION_BLOCKED' });
        // nothing was written
        const mode = await activation.readMode(prisma);
        expect(mode.active).toBe(false);
        expect(mode.latched).toBe(false);
        const settingsNow = await settings();
        expect(settingsNow.fiatLiquidityAuthorityEnabled).toBe(false);
    });

    test('F2. an unknown-outcome row and an orphan canonical row also block activation', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        await legacyWithdrawal(user, 25, 'UNKNOWN');
        // canonical row with no Withdrawal record and no reservation
        await prisma.transactionHistory.create({
            data: {
                userId: user.id, type: 'WITHDRAWAL_FIAT', amountUsdc: 15, status: 'PENDING',
                txHash: `orphan-canonical-${user.id}-${Date.now()}`,
            },
        });
        const preflight = await activation.activationPreflight(prisma);
        expect(preflight.ok).toBe(false);
        expect(preflight.blockers.map((b) => b.kind)).toEqual(
            expect.arrayContaining(['LEGACY_WITHDRAWAL_UNRESERVED', 'CANONICAL_WITHDRAWAL_WITHOUT_RECORD'])
        );
        await expect(activate()).rejects.toMatchObject({ code: 'P5D_ACTIVATION_BLOCKED' });
    });

    // ── G. activation succeeds once the preconditions hold ────────────────
    test('G. activation succeeds when no unresolved legacy row remains, and writes the latch', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { withdrawal } = await legacyWithdrawal(user, 50);
        // resolve it the way an operator would
        await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: 'NEEDS_MANUAL_REVIEW' } });

        const preflight = await activation.activationPreflight(prisma);
        expect(preflight.ok).toBe(true);
        expect(preflight.advisories.map((a) => a.kind)).toEqual(['LEGACY_WITHDRAWAL_PARKED']);

        const mode = await activate();
        expect(mode.active).toBe(true);
        expect(mode.latched).toBe(true);
        expect(mode.activatedAt).toBeInstanceOf(Date);

        const settingsNow = await settings();
        expect(settingsNow.fiatLiquidityAuthorityEnabled).toBe(true);
        // idempotent: a second activation keeps the original instant
        const again = await activate();
        expect(again.activatedAt.getTime()).toBe(mode.activatedAt.getTime());
    });

    // ── H. the public status endpoint reports the unit ─────────────────────
    test('H. GET /api/finance/fiat-pool-status reports the value and threshold in the actual unit', async () => {
        const financeController = require('../controllers/finance.controller');
        const app = { get: () => prisma };
        const call = () => {
            let payload = null;
            const res = {
                status: () => ({ json: (body) => { payload = body; return body; } }),
            };
            return financeController.getFiatPoolStatus({ app }, res).then(() => payload);
        };

        // legacy: 6000 USDC against the 5000 USDC floor
        await prisma.systemFiatPool.update({ where: { id: 1 }, data: { balance: 6000 } });
        const legacy = await call();
        expect(legacy.data.currency).toBe('USDC');
        expect(legacy.data.thresholdCurrency).toBe('USDC');
        expect(legacy.data.regime).toBe('LEGACY_USDC_POOL');
        expect(legacy.data.threshold).toBe(5000);
        expect(legacy.data.status).toBe('HEALTHY');

        // activated: the same 600 is GHS and must be classified against a GHS floor
        await activate();
        await prisma.fiatLiquidityState.update({ where: { id: 1 }, data: { availableGhs: 600 } });
        await prisma.systemFiatPool.update({ where: { id: 1 }, data: { balance: 600 } });
        const authority = await call();
        expect(authority.data.currency).toBe('GHS');
        expect(authority.data.thresholdCurrency).toBe('GHS');
        expect(authority.data.regime).toBe('GHS_AUTHORITY');
        expect(authority.data.authorityMode).toBe(true);
        // 5000 USDC ≡ 67100 GHS at 13.42 — 600 GHS is CRITICAL, never HEALTHY
        expect(authority.data.threshold).toBe(67100);
        expect(authority.data.status).toBe('CRITICAL');
        // the value itself is reported unchanged and in GHS
        expect(authority.data.balance).toBe(600);
    });
});
