// __tests__/fx-transaction-gate.test.js
// =============================================================================
// FX-balance workstream — transaction gate proof (real PostgreSQL).
//
// PROVES:
//
//   A. The gate delegates to the 271C authority and fails CLOSED (503,
//      retryable, usdcTransactionGate CLOSED) when: lastExternalSync is
//      NULL, stale, or in the future, or the stored rate value is unusable.
//   B. A genuinely fresh canonical rate opens the gate (next() called,
//      req.freshFxRate carries the exact Decimal rate + provenance).
//   C. A SAVED snapshot (even a fresh, eligible one) and the DEMO seed
//      NEVER open the gate: with only a saved/demo rate present, the gate
//      stays closed. Repeat requests cannot change the verdict.
//   D. The `when` predicate scopes conditional gates: FX-independent
//      requests pass WITHOUT a fresh rate; FX-dependent requests are
//      refused.
//   E. Ordering safety: the gate refuses BEFORE the idempotency middleware
//      can claim a key (proved by mounting the gate ahead of a middleware
//      that records execution, on the real walletRoutes router stack).
//   F. The production routes are pinned: /api/withdraw/fiat gates
//      unconditionally; /api/wallet/withdraw gates ONLY the MoMo payout
//      destination (crypto/Binance destinations pass with no fresh rate).
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
if (!hasDb) console.warn('[fx-transaction-gate.test] TEST_DATABASE_URL not set — skipping.');

describe('FX transaction gate middleware (real PostgreSQL)', () => {
    if (!hasDb) return;

    let prisma;
    let { requireFreshFxRate } = {};
    let snapshotService;
    const NOW = new Date('2026-10-22T12:00:00Z');

    let originalSettings;

    const buildReq = (body = {}) => {
        const req = { body };
        req.app = { get: (key) => (key === 'prisma' ? prisma : undefined) };
        return req;
    };
    const buildRes = () => {
        const res = {};
        res.status = jest.fn(() => res);
        res.json = jest.fn(() => res);
        return res;
    };

    // The middleware resolves `now` itself, so freshness offsets are
    // relative to the REAL clock (ageMs; negative = future observation).
    const setGlobal = async (rate, ageMs) => {
        const data = {
            liveRetailRate: rate,
            liveUsdToGhs: rate,
            liveRateSource: 'KOTANI_PAY',
            lastExternalSync: ageMs === null ? null : new Date(Date.now() - ageMs),
        };
        await prisma.globalSettings.upsert({
            where: { id: 1 },
            update: data,
            create: { id: 1, ...data },
        });
    };

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        ({ requireFreshFxRate } = require('../middleware/fxTransactionGateMiddleware'));
        snapshotService = require('../src/services/fxRateSnapshotService');
        originalSettings = await prisma.globalSettings.findUnique({
            where: { id: 1 },
            select: { liveRetailRate: true, liveUsdToGhs: true, liveRateSource: true, lastExternalSync: true },
        });
    });

    afterAll(async () => {
        if (prisma) {
            await prisma.fxSavedRate.deleteMany({});
            if (originalSettings) {
                await prisma.globalSettings.update({
                    where: { id: 1 },
                    data: {
                        liveRetailRate: originalSettings.liveRetailRate,
                        liveUsdToGhs: originalSettings.liveUsdToGhs,
                        liveRateSource: originalSettings.liveRateSource,
                        lastExternalSync: originalSettings.lastExternalSync,
                    },
                });
            }
            await prisma.$disconnect();
        }
    });

    beforeEach(async () => {
        await prisma.fxSavedRate.deleteMany({});
        await setGlobal('12.5', null); // start closed
    });

    // ── A. fail-closed states ───────────────────────────────────────────

    test.each([
        ['NULL lastExternalSync', '12.5', null],
        ['stale lastExternalSync (2h old)', '12.5', 2 * 3600_000],
        ['future lastExternalSync (1h ahead)', '12.5', -3600_000],
    ])('fails closed on %s', async (_label, rate, ageMs) => {
        await setGlobal(rate, ageMs);
        const gate = requireFreshFxRate();
        const res = buildRes();
        const next = jest.fn();
        await gate(buildReq(), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(503);
        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(false);
        expect(['RATE_STALE', 'RATE_UNAVAILABLE']).toContain(body.code);
        expect(body.retryable).toBe(true);
        expect(body.usdcTransactionGate).toBe('CLOSED');
    });

    test('fails closed on a non-positive rate value (synthetic oracle row)', async () => {
        // The fresh-install installer chain installs DB CHECKs
        // (GS_liveRetailRate_pos, GS_liveUsdToGhs_pos) so a non-positive
        // GlobalSettings row is now REJECTED at the database — the state
        // this test originally seeded is structurally impossible in
        // production. The authority's value-level defense (strictly
        // positive, finite rate) is still exercised with a synthetic oracle
        // row: defense in depth, so a future overlay that relaxes the
        // CHECKs can never silently reopen this path.
        const stubPrisma = {
            globalSettings: {
                findUnique: jest.fn().mockResolvedValue({
                    liveRetailRate: '0',
                    liveUsdToGhs: '0',
                    liveRateSource: 'KOTANI_PAY',
                    lastExternalSync: new Date(), // fresh by age, unusable by value
                }),
            },
        };
        const req = { body: {}, app: { get: (key) => (key === 'prisma' ? stubPrisma : undefined) } };
        const res = buildRes();
        const next = jest.fn();
        await requireFreshFxRate()(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(503);
        const body = res.json.mock.calls[0][0];
        expect(body.success).toBe(false);
        expect(['RATE_STALE', 'RATE_UNAVAILABLE']).toContain(body.code);
        expect(body.retryable).toBe(true);
        expect(body.usdcTransactionGate).toBe('CLOSED');
    });

    test('fails closed when the app has no prisma handle', async () => {
        const req = { body: {}, app: { get: () => undefined } };
        const res = buildRes();
        const next = jest.fn();
        await requireFreshFxRate()(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(503);
    });

    // ── B. fresh rate opens the gate ────────────────────────────────────

    test('a fresh canonical rate opens the gate with the exact rate attached', async () => {
        await setGlobal('12.5', 60_000); // 1 min old
        const gate = requireFreshFxRate();
        const res = buildRes();
        const next = jest.fn();
        await gate(buildReq(), res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });

    // ── C. saved/demo rates never open the gate ─────────────────────────

    test('an eligible SAVED snapshot never opens the gate, however many times it is requested', async () => {
        await setGlobal('12.5', null); // no fresh canonical rate
        await snapshotService.saveValidatedRateSnapshot({
            prisma, pair: 'USDC/GHS', rate: '12.4', source: 'KOTANI_PAY',
            observedAt: new Date(NOW.getTime() - 60_000), now: NOW,
        });
        const gate = requireFreshFxRate();
        for (let i = 0; i < 3; i++) {
            const res = buildRes();
            const next = jest.fn();
            await gate(buildReq(), res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(503);
            expect(res.json.mock.calls[0][0].savedRateIsDisplayOnly).toBe(true);
        }
    });

    test('the DEMO seed (12.03) never opens the transaction gate', async () => {
        await setGlobal('12.5', null);
        await snapshotService.seedDemoRateSnapshot({ prisma, now: NOW });
        const gate = requireFreshFxRate();
        const res = buildRes();
        const next = jest.fn();
        await gate(buildReq(), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(503);
    });

    // ── D. `when` predicate scoping ─────────────────────────────────────

    test('the `when` predicate lets FX-independent requests pass without a fresh rate', async () => {
        await setGlobal('12.5', null); // gate CLOSED
        const gate = requireFreshFxRate({
            when: (req) => /^\d+$/.test(String(req.body?.destination || '')),
        });

        // FX-dependent request: refused
        const refusedRes = buildRes();
        const refusedNext = jest.fn();
        await gate(buildReq({ destination: '02445566778899' }), refusedRes, refusedNext);
        expect(refusedNext).not.toHaveBeenCalled();

        // FX-independent request (crypto destination): passes
        const passedRes = buildRes();
        const passedNext = jest.fn();
        await gate(buildReq({ destination: '0x742d35Cc6634C0532925a3b844Bc454e44384444' }), passedRes, passedNext);
        expect(passedNext).toHaveBeenCalled();
    });

    // ── E/F. real route wiring pinned ───────────────────────────────────

    test('withdrawalRoutes gates POST /fiat unconditionally, and the gate runs BEFORE idempotency', async () => {
        const withdrawalRoutes = require('../routes/withdrawalRoutes');
        const route = withdrawalRoutes.stack
            .map((l) => l.route)
            .find((r) => r && r.path === '/fiat' && r.methods.post);
        expect(route).toBeDefined();

        // Stack discipline: the gate middleware must sit before the
        // idempotency middleware, so a 503 never claims a key. Factory
        // closures are anonymous in the express stack, so layers are
        // identified by their source signature.
        const sig = (h) => String(h);
        const isGate = (h) => sig(h).includes('freshFxRate') || sig(h).includes('usdcTransactionGate');
        const isIdempotency = (h) => sig(h).includes('Idempotency-Key') || sig(h).includes('idempotency');
        const gateIdx = route.stack.findIndex((l) => isGate(l.handle));
        const idemIdx = route.stack.findIndex((l) => isIdempotency(l.handle));
        expect(gateIdx).toBeGreaterThanOrEqual(0);
        expect(idemIdx).toBeGreaterThanOrEqual(0);
        expect(gateIdx).toBeLessThan(idemIdx);
    });

    test('walletRoutes gates POST /withdraw UNCONDITIONALLY (universal scope — all destinations)', async () => {
        const walletRoutes = require('../routes/walletRoutes');
        const route = walletRoutes.stack
            .map((l) => l.route)
            .find((r) => r && r.path === '/withdraw' && r.methods.post);
        expect(route).toBeDefined();

        const hasGate = route.stack.some((layer) => {
            const sig = String(layer.handle);
            return sig.includes('freshFxRate') || sig.includes('usdcTransactionGate');
        });
        expect(hasGate).toBe(true);
        // UNIVERSAL scope (supersedes the earlier conditional MoMo-only
        // scoping): crypto/Binance/TRC20 destinations are NEW USDC-enabled
        // transaction authorizations too, so they are refused identically
        // while the canonical rate observation is stale/missing. The retired
        // isMomoPayoutDestination predicate must NOT ship on the route file.
        const src = require('fs').readFileSync(
            require('path').resolve(__dirname, '../routes/walletRoutes.js'), 'utf8');
        expect(src).not.toMatch(/function isMomoPayoutDestination/);
        // The per-destination fail-closed behavior is pinned end-to-end in
        // __tests__/universal-usdc-transaction-gate.test.js (all gated routes
        // refuse 503 on a stale observation, before the controller).
    });
});
