// __tests__/r16b-moolre-only-topology.test.js
// =============================================================================
// r16b P0-A proofs — Moolre is the ONLY current external fiat provider.
//
// Proves the production composition, not just the abstraction:
//   1. The production PaymentFailoverService registry contains ONLY the
//      Moolre provider — no direct MTN instance is reachable.
//   2. The historical app-key alias points at the canonical Moolre
//      instance — no production code path receives a direct MTN adapter.
//   3. A TELECEL fiat withdrawal propagates the destination network into
//      the Moolre dispatch payload and rides Moolre channel 6.
//   4. AIRTELTIGO likewise rides channel 7.
//   5. VODAFONE is normalized to TELECEL (legacy compatibility alias).
//   6. The MTN-era ownership identity still resolves for HISTORICAL rows
//      while the production registry cannot reach it.
//   7. Current payout authority metadata names Moolre as the provider.
//   8. The active finance surface exposes NO live MTN settlement callback
//      (the Moolre webhook remains the canonical settlement path).
//   9. An invalid destination network is rejected as request data.
//
// Real-PostgreSQL parts skip unless TEST_DATABASE_URL is set.
// =============================================================================
const hasDb = !!process.env.TEST_DATABASE_URL;

const MoolreDisbursementService = require('../services/moolreDisbursementService');
const MtnDisbursementService = require('../services/mtnDisbursementService');
const ownership = require('../services/payoutProviderOwnership');

function testIf(cond, name, fn) {
    return cond ? test(name, fn) : test.skip(name, fn);
}

// ── 1 + 2: production composition (requires the real baseServices wiring) ──
describe('r16b P0-A: production provider topology is Moolre-only', () => {
    let baseServices;

    beforeAll(() => {
        // baseServices connects the production pool at require time; in CI
        // DATABASE_URL points at the test Postgres. Without a database the
        // composition proofs must not silently pass — they skip there
        // (same contract as the other live suites).
        if (!hasDb) return;
        if (!process.env.DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        baseServices = require('../src/config/baseServices');
    });

    testIf(hasDb, '1: PaymentFailoverService production registry contains ONLY moolre', () => {
        const failover = baseServices.paymentFailoverService;
        expect(failover).toBeTruthy();
        expect(failover.providers.map(p => p.name)).toEqual(['moolre']);

        for (const p of failover.providers) {
            expect(p.instance).toBeInstanceOf(MoolreDisbursementService);
            expect(p.instance).not.toBeInstanceOf(MtnDisbursementService);
        }
    });

    testIf(hasDb, '2: no production code path receives a direct MTN adapter', () => {
        // The historical app-key alias points at the CANONICAL Moolre
        // instance — a direct MTN implementation is unreachable.
        expect(baseServices.mtnDisbursementService).toBeInstanceOf(MoolreDisbursementService);
        expect(baseServices.mtnDisbursementService).not.toBeInstanceOf(MtnDisbursementService);
        expect(baseServices.mtnDisbursementService).toBe(baseServices.paymentFailoverService.providers[0].instance);
    });
});

// ── 6: ownership identity stays historical-only ─────────────────────────────
describe('r16b P0-A: MTN ownership identity is historical-only', () => {
    test('6: the legacy tag still resolves for historical rows but is not a dispatch target', () => {
        // Historical reconciliation must still understand legacy MTN rows.
        expect(ownership.TAG_TO_CANONICAL.mtn).toBe('MTN_MOMO_DISBURSEMENT');
        expect(ownership.CANONICAL_TO_TAG['MTN_MOMO_DISBURSEMENT']).toBe('mtn');
        expect(ownership.KNOWN_CANONICAL_PROVIDERS).toContain('MTN_MOMO_DISBURSEMENT');

        // Current production dispatch authority is Moolre.
        expect(ownership.TAG_TO_CANONICAL.moolre).toBe('MOOLRE_DISBURSEMENT');
        expect(ownership.CANONICAL_TO_TAG['MOOLRE_DISBURSEMENT']).toBe('moolre');
    });
});

// ── 3/4: destination networks are DATA under Moolre (adapter level) ──────────
describe('r16b P0-A: destination networks route through the Moolre adapter', () => {
    test('3: TELECEL dispatch rides Moolre channel 6', async () => {
        const svc = new MoolreDisbursementService(); // MOCK mode in tests
        const out = await svc.initiateTransfer({
            referenceId: 'r16b-tel-1', amountGhs: 20, recipientPhone: '0200000000', network: 'TELECEL',
        });
        expect(out.provider).toBe('MOOLRE_DISBURSEMENT');
        expect(out.status).toBe('PENDING');
        expect(svc._mockTransfers.get('r16b-tel-1').channel).toBe(6);
    });

    test('4: AIRTELTIGO dispatch rides Moolre channel 7', async () => {
        const svc = new MoolreDisbursementService();
        await svc.initiateTransfer({
            referenceId: 'r16b-at-1', amountGhs: 20, recipientPhone: '0270000000', network: 'AIRTELTIGO',
        });
        expect(svc._mockTransfers.get('r16b-at-1').channel).toBe(7);
    });

    test('MTN remains a valid destination network (channel 1), never a provider', async () => {
        const svc = new MoolreDisbursementService();
        await svc.initiateTransfer({
            referenceId: 'r16b-mtn-1', amountGhs: 20, recipientPhone: '0240000000', network: 'MTN',
        });
        expect(svc._mockTransfers.get('r16b-mtn-1').channel).toBe(1);
        expect(svc._mockTransfers.get('r16b-mtn-1').provider).toBe('MOOLRE_DISBURSEMENT');
    });
});

// ── 8: the active finance route has no live MTN settlement surface ───────────
describe('r16b P0-A: finance routes expose no active MTN settlement webhook', () => {
    test('8: the MTN disbursement webhook is NOT mounted; the Moolre webhook is', () => {
        const router = require('../routes/financeRoutes');
        const paths = router.stack
            .map(layer => layer.route && layer.route.path)
            .filter(Boolean);

        expect(paths).not.toContain('/webhook/mtn-disbursement');
        expect(paths).toContain('/webhook/moolre-disbursement');

        // The historical handler remains exported for reconciliation tooling
        // and tests — it is simply no longer a production mutation surface.
        const handlerModule = require('../controllers/fiatSettlementWebhook.controller');
        expect(typeof handlerModule.mtnDisbursementWebhook).toBe('function');
        expect(typeof handlerModule.moolreDisbursementWebhook).toBe('function');
    });
});

// ── 3b/5b/7/9: real-PostgreSQL controller-level proofs ──────────────────────
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r16b-topology] TEST_DATABASE_URL not set — skipping real-DB suite.');

describeOrSkip('r16b P0-A: fiat withdrawal network propagation (real PostgreSQL)', () => {
    const { PrismaClient } = require('@prisma/client');
    const { seedUser } = require('./helpers/factories');
    const { fiatWithdrawal } = require('../controllers/withdrawalController');

    let prisma;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        prisma = new PrismaClient();
    });

    beforeEach(async () => {
        await prisma.systemFiatPool.upsert({
            where: { id: 1 }, update: { balance: 100_000.0 }, create: { id: 1, balance: 100_000.0 }
        });
        await prisma.systemMasterCrypto.upsert({
            where: { id: 1 }, update: { balance: 0.0 }, create: { id: 1, balance: 0.0 }
        });
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: { liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY' },
            create: { id: 1, liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY' }
        });
    });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "User", "TransactionHistory", "Withdrawal", "ReconciliationException", "AzmSpendLog", "AdminProfitLog", "GlobalSettings", "SystemFiatPool", "SystemProfitFees", "SystemMasterCrypto", "FiatLiquidityReceipt", "FiatProviderEvent" RESTART IDENTITY CASCADE'
        );
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "LedgerTransaction", "JournalEntry", "LedgerAccount", "RestrictedObligation" RESTART IDENTITY CASCADE'
        );
    }, 15000);

    afterAll(async () => { await prisma.$disconnect(); });

    /** Recording dispatcher delegating to a REAL Moolre MOCK instance. */
    function makeRecordingDispatcher() {
        const moolre = new MoolreDisbursementService();
        const captured = [];
        const dispatcher = {
            _provider: 'moolre',
            newReferenceId: () => moolre.newReferenceId(),
            async initiateTransfer(payload) {
                captured.push(payload);
                const out = await moolre.initiateTransfer(payload);
                out._provider = 'moolre';
                out.provider = 'MOOLRE_DISBURSEMENT';
                return out;
            },
            async getTransferStatus(ref) { return moolre.getTransferStatus(ref); },
        };
        return { dispatcher, captured, moolre };
    }

    function makeHarness(dispatcher) {
        const appMap = new Map([
            ['prisma', prisma],
            ['paymentFailoverService', dispatcher],
            ['emitBalanceUpdate', async () => {}],
            ['emailService', null],
            ['smsService', null],
            ['adminAlertService', null],
            ['socketio', null],
            ['azmSpendService', null],
        ]);
        const app = { get: (k) => (appMap.has(k) ? appMap.get(k) : null) };
        const res = {
            statusCode: null, body: null,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; return res; },
        };
        return { app, res };
    }

    async function runWithdrawal(user, dispatcher, network) {
        const { app, res } = makeHarness(dispatcher);
        const req = {
            app, ip: '127.0.0.1', headers: {},
            body: { amount: '50', payoutMethod: 'MTN_MOMO', recipientPhone: '0204556677', network },
            user: { id: user.id, username: 'r16b', createdAt: new Date(Date.now() - 90 * 86400000) },
        };
        await fiatWithdrawal(req, res);
        return res;
    }

    test('3b: a TELECEL withdrawal dispatches through Moolre with the destination network', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { dispatcher, captured, moolre } = makeRecordingDispatcher();

        const res = await runWithdrawal(user, dispatcher, 'TELECEL');
        expect(res.statusCode).toBe(200);

        // The canonical dispatch payload carries the destination network.
        expect(captured.length).toBe(1);
        expect(captured[0].network).toBe('TELECEL');

        // The real Moolre adapter rode the Telecel channel.
        const ref = captured[0].referenceId;
        expect(moolre._mockTransfers.get(ref).channel).toBe(6);

        // The withdrawal mirror records the destination network — not the
        // rail, not a provider name.
        const withdrawal = await prisma.withdrawal.findFirst({ where: { userId: user.id } });
        expect(withdrawal.network).toBe('TELECEL');

        // The durable dispatch-intent evidence carries the network too.
        const evidence = await prisma.fiatProviderEvent.findFirst({
            where: { relatedReference: ref, status: 'DISPATCH_INTENT' },
        });
        expect(evidence).toBeTruthy();
        expect(evidence.raw.network).toBe('TELECEL');
    });

    test('4b: an AIRTELTIGO withdrawal propagates through Moolre', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { dispatcher, captured, moolre } = makeRecordingDispatcher();

        const res = await runWithdrawal(user, dispatcher, 'AIRTELTIGO');
        expect(res.statusCode).toBe(200);

        expect(captured[0].network).toBe('AIRTELTIGO');
        const ref = captured[0].referenceId;
        expect(moolre._mockTransfers.get(ref).channel).toBe(7);
        const withdrawal = await prisma.withdrawal.findFirst({ where: { userId: user.id } });
        expect(withdrawal.network).toBe('AIRTELTIGO');
    });

    test('5b: legacy VODAFONE is normalized to TELECEL', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { dispatcher, captured } = makeRecordingDispatcher();

        const res = await runWithdrawal(user, dispatcher, 'VODAFONE');
        expect(res.statusCode).toBe(200);

        expect(captured[0].network).toBe('TELECEL');
        const withdrawal = await prisma.withdrawal.findFirst({ where: { userId: user.id } });
        expect(withdrawal.network).toBe('TELECEL');
    });

    test('9: an invalid destination network is rejected as request data (400)', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { dispatcher, captured } = makeRecordingDispatcher();

        const res = await runWithdrawal(user, dispatcher, 'DSTV');
        expect(res.statusCode).toBe(400);
        expect(captured.length).toBe(0);

        // No financial state was created by the refused request.
        const withdrawal = await prisma.withdrawal.findFirst({ where: { userId: user.id } });
        expect(withdrawal).toBe(null);
        const fresh = await prisma.user.findUnique({ where: { id: user.id } });
        expect(Number(fresh.availableBalance)).toBe(500);
    });

    test('7: current payout authority metadata names Moolre as the provider', async () => {
        const user = await seedUser(prisma, { availableBalance: 500 });
        const { dispatcher } = makeRecordingDispatcher();

        const res = await runWithdrawal(user, dispatcher, 'TELECEL');
        expect(res.statusCode).toBe(200);

        const canonical = await prisma.transactionHistory.findFirst({
            where: { userId: user.id, type: 'WITHDRAWAL_FIAT' },
        });
        expect(canonical).toBeTruthy();

        // The fiat-reservation ledger entry names the provider explicitly.
        // (JSON-path where-filters need a scalar filter in this Prisma
        // version, so the metadata key is checked application-side.)
        const ledgerEntries = await prisma.ledgerTransaction.findMany({
            where: { reference: canonical.txHash },
        });
        const ledgerEntry = ledgerEntries.find(e => e.metadata && e.metadata.provider);
        expect(ledgerEntry).toBeTruthy();
        expect(ledgerEntry.metadata.provider).toBe('MOOLRE_DISBURSEMENT');
        expect(ledgerEntry.metadata.provider).not.toBe('MTN_MOMO');
    });
});
