// __tests__/r18-orphan-adoption-claim.test.js
// =============================================================================
// r18 — DURABLE OWNERSHIP CLAIM on orphan-canonical adoption (real PostgreSQL).
//
// The r17 guards confined the guessed amount±5s fallback to GENUINELY ORPHAN
// canonical rows, but the fallback still had a race: two concurrent
// mirror-only withdrawals could both observe the same orphan canonical
// before either bridge claim committed. One caller would win the durable
// bridge while the loser kept using the canonical it had selected — the
// payout worker could proceed toward provider dispatch, the admin rejection
// could reverse the reservation, the reconciler could settle/reverse, all
// under a canonical another mirror had just durably claimed.
//
// r18 makes adoption a REAL ownership claim on the existing unique partial
// index ("Withdrawal_transactionHistoryId_key"): exactly one concurrent
// caller per canonical can commit the bridge claim; a loser NEVER receives
// the canonical row and falls into its existing missing/ambiguous/
// manual-review path.
//
// Proves against REAL PostgreSQL (concurrent Promise.all invocation):
//   S1. claim service: two concurrent claims on one orphan → exactly one
//       winner; the loser is reported with the durable owner.
//   S2. payout worker: concurrent fallback resolution → exactly one caller
//       receives the canonical (the other is ambiguous → manual review);
//       at batch level, only the bridge winner reaches the provider
//       dispatch boundary — one dispatch, one flag, one bridge.
//   S3. admin rejection: two concurrent rejections of two mirror rows
//       sharing one orphan canonical → exactly ONE canonical reversal
//       (owner only); the loser refunds through its own legacy mirror path
//       and never touches the canonical; no double refund.
//   S4. reconciliation worker: concurrent fallback resolution → exactly
//       one owner; the loser records ORPHAN_ADOPTION_CLAIM_LOST.
//   S5. positive control: a genuinely orphan legacy canonical is still
//       adopted EXACTLY ONCE (the second claimant always loses).
//   S6. same-row concurrent claims converge on the durable bridge (both
//       callers truthfully observe their own row as owner; the row's own
//       state machine still guards the action).
//
// SKIPS unless TEST_DATABASE_URL is set.
// =============================================================================
const { seedUser } = require('./helpers/factories');
const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r18-orphan-adoption-claim] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('r18: durable orphan-adoption ownership claim', () => {
    let prisma, controller, withdrawalBridge;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        controller = require('../controllers/adminController');
        withdrawalBridge = require('../services/withdrawalBridgeService');
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "Withdrawal", "TransactionHistory", "GlobalSettings", "SystemProfitFees", "SystemFiatPool", "SystemMasterCrypto", "AdminProfitLog", "FiatProviderEvent", "ReconciliationException", "FiatLiquidityReceipt" RESTART IDENTITY CASCADE'
        );
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount", "RestrictedObligation" RESTART IDENTITY CASCADE');
    }, 15000);

    // ── fixtures ──────────────────────────────────────────────────────────
    const mkReq = (admin, body, params) => ({
        user: admin,
        body,
        params: params || {},
        app: {
            get: (k) => {
                if (k === 'prisma') return prisma;
                if (k === 'notificationService') return { sendNotification: async () => ({}) };
                if (k === 'emitBalanceUpdate') return async () => {};
                if (k === 'socketio') return { to: () => ({ emit: async () => {} }) };
                return null;
            },
        },
        ip: '127.0.0.1',
    });
    const mkRes = () => {
        const res = {};
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (payload) => { res.payload = payload; return res; };
        return res;
    };
    async function reject(admin, withdrawalId, reason = 'r18 race rejection') {
        const res = mkRes();
        await controller.rejectWithdrawal(mkReq(admin, { reason }, { id: String(withdrawalId) }), res);
        return res;
    }

    async function seedFinanceEnv() {
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: 15, liveUsdToGhs: 15 },
            create: { id: 1, liveRetailRate: 15, liveUsdToGhs: 15 }
        });
        await prisma.systemFiatPool.upsert({ where: { id: 1 }, update: { balance: 100000 }, create: { id: 1, balance: 100000 } });
        await prisma.systemMasterCrypto.upsert({ where: { id: 1 }, update: { balance: 100000 }, create: { id: 1, balance: 100000 } });
        await prisma.systemProfitFees.upsert({ where: { id: 1 }, update: { balance: 0 }, create: { id: 1, balance: 0 } });
    }

    async function seedBareMirrorRow(user, amount) {
        const rows = await prisma.$queryRawUnsafe(
            'INSERT INTO "Withdrawal" ("userId", "amount", "payoutMethod", "network", "destination", "status", "createdAt", "updatedAt") ' +
            'VALUES ($1, $2, $3, $4, $5, \'PENDING\', now(), now()) RETURNING "id"',
            user.id, amount, 'MOMO', 'MOMO', '0240000000'
        );
        return await prisma.withdrawal.findUnique({ where: { id: rows[0].id } });
    }

    async function seedOrphanCanonical(user, amount, reference) {
        const restrictedObligations = require('../services/restrictedObligationService');
        await prisma.transactionHistory.create({
            data: {
                userId: user.id,
                type: 'WITHDRAWAL_FIAT',
                amountUsdc: amount,
                feeUsdc: 0,
                txHash: reference,
                status: 'PENDING',
                metadata: { ledgerReserved: true, status: 'PENDING' },
            },
        });
        await prisma.$transaction(async (tx) => {
            await restrictedObligations.createForPendingWithdrawal(tx, {
                sourceType: 'PENDING_FIAT_WITHDRAWAL',
                reference: `withdrawal:fiat:${reference}`,
                userId: user.id,
                amount,
                asset: 'USDC',
                sourceEntity: 'transactionHistory',
                sourceEntityId: reference,
            });
        });
    }

    /** Two mirror-only rows created BEFORE the canonical exists (the insert
     *  trigger cannot link them retroactively — the genuine legacy race
     *  fixture), then one genuinely orphan canonical within the ±5s window
     *  of BOTH mirrors. */
    async function seedRaceFixture(amount = 40) {
        const user = await seedUser(prisma, { availableBalance: 500 });
        await seedFinanceEnv();
        const m1 = await seedBareMirrorRow(user, amount);
        const m2 = await seedBareMirrorRow(user, amount);
        const reference = `ORPHAN_RACE_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        await seedOrphanCanonical(user, amount, reference);
        const canonical = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        return { user, m1, m2, canonical, reference };
    }

    const bridgedCount = async (canonicalId) =>
        (await prisma.$queryRawUnsafe(
            'SELECT COUNT(*)::int AS n FROM "Withdrawal" WHERE "transactionHistoryId" = $1',
            canonicalId
        ))[0].n;

    // ── S1: the claim itself is exclusive ────────────────────────────────
    test('S1: two concurrent claims on one orphan — exactly one winner, loser reported with the durable owner', async () => {
        const { m1, m2, canonical } = await seedRaceFixture();

        const [c1, c2] = await Promise.all([
            withdrawalBridge.claimOrphanCanonical(prisma, m1.id, canonical.id),
            withdrawalBridge.claimOrphanCanonical(prisma, m2.id, canonical.id),
        ]);

        const winners = [c1, c2].filter((c) => c.won);
        expect(winners).toHaveLength(1);
        const loser = [c1, c2].find((c) => !c.won);
        expect(loser.reason).toBe('CLAIM_LOST_OTHER_WITHDRAWAL');
        const winnerId = c1.won ? m1.id : m2.id;
        expect(String(loser.owner)).toBe(String(winnerId));

        expect(await bridgedCount(canonical.id)).toBe(1);
    });

    test('S1b: a sequential second claimant after adoption always loses', async () => {
        const { m1, m2, canonical } = await seedRaceFixture();

        const first = await withdrawalBridge.claimOrphanCanonical(prisma, m1.id, canonical.id);
        const second = await withdrawalBridge.claimOrphanCanonical(prisma, m2.id, canonical.id);

        expect(first.won).toBe(true);
        expect(second.won).toBe(false);
        expect(second.reason).toBe('CLAIM_LOST_OTHER_WITHDRAWAL');
        expect(String(second.owner)).toBe(String(m1.id));
        expect(await bridgedCount(canonical.id)).toBe(1);
    });

    // ── S2: payout worker — dispatch boundary is bridge-winner-only ──────
    test('S2a: concurrent fallback resolution — exactly one caller receives the canonical, the other is refused', async () => {
        const PayoutBatchWorker = require('../workers/payoutBatchWorker');
        const { m1, m2, canonical, reference } = await seedRaceFixture();

        const worker = new PayoutBatchWorker(prisma, null, { initiateTransfer: async () => { throw new Error('must not dispatch'); } }, null);
        const [r1, r2] = await Promise.all([
            worker._findCanonicalTransaction(m1),
            worker._findCanonicalTransaction(m2),
        ]);

        const rows = [r1, r2].filter((r) => r.row);
        expect(rows).toHaveLength(1);
        expect(rows[0].row.txHash).toBe(reference);
        const refused = [r1, r2].find((r) => !r.row);
        // Either interleaving refuses fail-closed: the loser either saw the
        // orphan and lost the durable claim (ambiguous → manual review), or
        // already sees the winner's committed bridge and resolves to zero
        // candidates (missing reference → manual review). It NEVER receives
        // the canonical row either way.
        expect(refused.row).toBeNull();
        expect([true, false]).toContain(refused.ambiguous);

        expect(await bridgedCount(canonical.id)).toBe(1);
        const ownerRow = [r1, r2].findIndex((r) => r.row) === 0 ? m1 : m2;
        const owner = await prisma.withdrawal.findUnique({ where: { id: ownerRow.id } });
        expect(owner.transactionHistoryId).toBe(canonical.id);
    });

    test('S2b: one batch over both mirrors — only the bridge winner reaches the provider dispatch boundary', async () => {
        const PayoutBatchWorker = require('../workers/payoutBatchWorker');
        const { canonical, reference } = await seedRaceFixture();

        const dispatches = [];
        const worker = new PayoutBatchWorker(prisma, null, {
            initiateTransfer: async (payload) => {
                dispatches.push(payload);
                return { _provider: 'mtn', provider: 'MTN_MOMO_DISBURSEMENT', status: 'ACCEPTED' };
            },
        }, null);

        const result = await worker._processBatch(
            { autoPayoutEnabled: true, autoPayoutMaxAmountUsdc: 200, autoPayoutThresholdUsdc: 500 },
            { isManualTrigger: true }
        );

        // Exactly ONE provider dispatch — under the winner's canonical.
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0].referenceId).toBe(reference);
        // The loser never dispatched: it is flagged for manual review.
        expect(result.flagged).toBe(1);
        expect(result.processed).toBe(1);
        expect(result.details?.flaggedManualReview?.[0]?.reason).toBe('MISSING_TRANSACTION_REFERENCE');
        // Exactly one mirror holds the durable bridge.
        expect(await bridgedCount(canonical.id)).toBe(1);
        const statuses = await prisma.withdrawal.findMany({ select: { status: true } });
        expect(statuses.filter((s) => s.status === 'NEEDS_MANUAL_REVIEW')).toHaveLength(1);
    });

    // ── S3: admin rejection — only the owner reverses the canonical ──────
    test('S3: two concurrent rejections sharing one orphan canonical — exactly one canonical reversal, the loser never touches it', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const { user, m1, m2, canonical, reference } = await seedRaceFixture();

        const [res1, res2] = await Promise.all([
            reject(admin, m1.id),
            reject(admin, m2.id),
        ]);

        // Both rejections are honest outcomes (no 5xx from an unhandled
        // unique violation).
        expect([200, 409]).toContain(res1.statusCode);
        expect([200, 409]).toContain(res2.statusCode);
        const canonicalPath = [res1, res2].filter((r) => r.payload?.message?.includes('canonical reversal state machine'));
        const legacyPath = [res1, res2].filter((r) => (r.payload?.message?.includes('Funds refunded.') && !r.payload?.message?.includes('canonical reversal state machine')));
        expect(canonicalPath).toHaveLength(1);
        expect(legacyPath).toHaveLength(1);

        // The canonical reservation moved EXACTLY ONCE — only the durable
        // owner reversed it.
        const canonicalAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonicalAfter.status).toBe('FAILED');
        const fiatObl = await prisma.restrictedObligation.findUnique({ where: { reference: `withdrawal:fiat:${reference}` } });
        expect(fiatObl.status).toBe('CANCELLED');

        // Exactly one mirror holds the bridge: the one whose rejection took
        // the canonical path.
        expect(await bridgedCount(canonical.id)).toBe(1);
        const bridged = await prisma.withdrawal.findFirst({ where: { transactionHistoryId: { not: null } } });
        const ownerRes = bridged.id === m1.id ? res1 : res2;
        expect(ownerRes.payload.data.canonicalReference).toBe(reference);

        // No double refund: each mirror refunded exactly its own amount —
        // one through the canonical reversal, one through its legacy path.
        const fresh = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(fresh.availableBalance)).toBeCloseTo(500 + 40 + 40, 5);

        // Idempotency preserved: re-rejecting either finalized mirror refuses.
        const again = await reject(admin, bridged.id);
        expect([400, 409]).toContain(again.statusCode);
    });

    // ── S4: reconciliation worker converges on the durable owner ────────
    test('S4: concurrent reconciliation resolution — exactly one owner, the loser records ORPHAN_ADOPTION_CLAIM_LOST', async () => {
        const WithdrawalReconciliationWorker = require('../workers/withdrawalReconciliationWorker');
        const { m1, m2, canonical, reference } = await seedRaceFixture();

        const worker = new WithdrawalReconciliationWorker(prisma, null, {}, null, null);
        const [r1, r2] = await Promise.all([
            worker._findCanonicalTransaction(m1),
            worker._findCanonicalTransaction(m2),
        ]);

        const owners = [r1, r2].filter((r) => r.row);
        expect(owners).toHaveLength(1);
        expect(owners[0].row.txHash).toBe(reference);
        const refused = [r1, r2].find((r) => !r.row);
        expect(refused.row).toBeNull();

        // The loser's miss is durably recorded for operator attention.
        const exceptions = await prisma.$queryRawUnsafe(
            'SELECT "reason" FROM "ReconciliationException" WHERE "entityId" = $1',
            String(refused === r1 ? m1.id : m2.id)
        );
        expect(exceptions.some((e) => e.reason === 'ORPHAN_ADOPTION_CLAIM_LOST')).toBe(true);

        // The canonical is associated with exactly one withdrawal.
        expect(await bridgedCount(canonical.id)).toBe(1);
    });

    // ── S5: positive control — adoption still happens, exactly once ───────
    test('S5: a genuinely orphan legacy canonical is still adopted EXACTLY ONCE', async () => {
        const admin = await seedUser(prisma, { role: 'ADMIN' });
        const { m1, m2, canonical, reference } = await seedRaceFixture();

        // Single caller: adoption succeeds end-to-end (canonical reversed).
        const res = await reject(admin, m1.id);
        expect(res.statusCode).toBe(200);
        const canonicalAfter = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        expect(canonicalAfter.status).toBe('FAILED');
        const m1After = await prisma.withdrawal.findUnique({ where: { id: m1.id } });
        expect(m1After.transactionHistoryId).toBe(canonical.id);

        // A later claimant can NEVER adopt the same canonical again.
        const second = await withdrawalBridge.claimOrphanCanonical(prisma, m2.id, canonical.id);
        expect(second.won).toBe(false);
        expect(await bridgedCount(canonical.id)).toBe(1);
    });

    // ── S6: same-row concurrent claims converge ───────────────────────────
    test('S6: concurrent claims by the SAME mirror row converge on the durable bridge — no phantom exclusivity', async () => {
        const { m1, canonical } = await seedRaceFixture();

        const [a, b] = await Promise.all([
            withdrawalBridge.claimOrphanCanonical(prisma, m1.id, canonical.id),
            withdrawalBridge.claimOrphanCanonical(prisma, m1.id, canonical.id),
        ]);

        // Both callers truthfully observe their own row as the durable
        // owner (the row IS the owner); the row's own state machine still
        // guards the action downstream.
        expect(a.won).toBe(true);
        expect(b.won).toBe(true);
        expect(await bridgedCount(canonical.id)).toBe(1);
    });
});
