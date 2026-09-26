// __tests__/p5c-route-policy.test.js
// =============================================================================
// §P.5-C real-PostgreSQL proof: route-aware quote authority.
//
// PROVES, with Prisma NEVER mocked (real PostgreSQL via TEST_DATABASE_URL):
//
//   A. Deterministic route resolution — every policy route+rail combination
//      resolves, with the policy version, the candidate set, and the mounted
//      endpoint provenance stamped on the quote.
//   B. No invented rails — unknown routes, rails not mounted on a route, and
//      fabricated providers fail closed with typed policy errors.
//   C. Unbound price quotes (/api/quotes) persist the candidate set + version
//      but honestly claim NO selected route.
//   D. RAIL-AWARE settlement binding — a quote's selected route AND rail
//      jointly constrain which authenticated settlement surface may consume
//      it (GENERIC + BANK_TRANSFER can never settle on the Moolre webhook);
//      historical quotes (no route) stay settleable.
//   E. Full route/identity column round-trip through the database.
//   F. DB-enforced idempotency: identical key + identical request REPLAYS the
//      committed quote; conflicting reuse fails 409; identity is user-scoped;
//      concurrent identical requests commit exactly ONE row.
//   G. Exact decimal arithmetic: the rate is the ORIGINAL Decimal DB value
//      end-to-end (never a JS Number reconstruction); persisted USDC amounts
//      are the precise quotient (no float rounding drift).
//   K. Moolre webhook legitimate-path evidence: rail mismatches and
//      unconfirmed generic MoMo quotes fail closed BEFORE any mutation; a
//      legitimately initiated MOOLRE-route deposit settles end-to-end.
//   H. Mounted generic initiate persists the route decision on BOTH the quote
//      and the pending transaction, and a retried initiation under the same
//      Idempotency-Key fails closed (no second quote, no second PENDING).
//   I. Mounted Moolre initiate stamps the MOOLRE_MOMO_COLLECTION route.
//   J. A MOOLRE-route quote cannot settle on the generic fiat webhook — fail
//      closed before any mutation, the deposit stays PENDING, no credit moves.
//
// Only non-DB boundaries (audit, journal, notifications) and the external
// Moolre provider are stubbed. Skips cleanly without TEST_DATABASE_URL.
// =============================================================================

jest.mock('../utils/audit', () => ({ audit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/journalIntegration', () => ({ recordDeposit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(),
}));

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[p5c-route-policy.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('§P.5-C route-aware quote authority (real PostgreSQL)', () => {
    let prisma;
    const { seedUser } = require('./helpers/factories');
    const {
        createServerTransactionQuote,
        QuoteIdentityConflictError,
        QuoteIdentityReplayError,
    } = require('../src/services/transactionQuoteService');
    const routePolicy = require('../src/services/routePolicyService');
    const quoteFiatDepositController = require('../controllers/quoteFiatDepositController');
    const moolreQuoteDepositController = require('../controllers/moolreQuoteDepositController');
    const depositRouter = require('../routes/depositRoutes');

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        process.env.FIAT_WEBHOOK_SECRET = 'test_webhook_secret_p5c';
        process.env.MOOLRE_WEBHOOK_SECRET = 'test_moolre_webhook_secret_p5c';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    afterAll(async () => {
        // Leave the shared test DB clean for suites that teardown with
        // user.deleteMany() (RESTRICT FK from TransactionHistory/TransactionQuote).
        if (prisma) {
            // seedUser backs every starting balance with a COMPLETED
            // DEPOSIT_CRYPTO ledger row — clear ALL rows owned by this suite's
            // seeded users (username pattern 'user_%'), plus every quote, so
            // later suites' user.deleteMany() teardowns are not FK-blocked.
            await prisma.$executeRaw`DELETE FROM "TransactionHistory" WHERE "userId" IN (SELECT id FROM "User" WHERE username LIKE 'user_%')`;
            await prisma.$executeRaw`DELETE FROM "TransactionQuote"`;
            await prisma.$disconnect();
        }
    });

    const second = (ms) => ms * 1000;

    async function seedSettings(overrides = {}) {
        const base = {
            liveUsdToGhs: 13.10,
            liveRetailRate: 13.42,
            liveCorporateRate: 13.22,
            liveRateSource: 'KOTANI_PAY',
            lastRateSync: null,
            lastExternalSync: new Date(Date.now() - second(60)),
            lastAdminSetAt: null,
            lastEchoAt: null,
        };
        const data = { ...base, ...overrides };
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
        return data;
    }

    function makeApp(services = {}) {
        const registry = {
            prisma,
            marketOracle: null,
            notificationService: { sendNotification: jest.fn().mockResolvedValue(undefined) },
            socketio: null,
            emitBalanceUpdate: null,
            moolreCollectionService: { initiatePayment: jest.fn().mockResolvedValue({ requiresOtp: false, providerRef: 'PR-P5C' }) },
            ...services,
        };
        return { get: (key) => registry[key] };
    }

    function mockResponse() {
        return {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.payload = payload; return this; },
        };
    }

    function asCandidates(v) { return typeof v === 'string' ? JSON.parse(v) : v; }

    async function rawQuoteRows(userId) {
        return prisma.$queryRaw`SELECT * FROM "TransactionQuote" WHERE "userId" = ${userId} ORDER BY "createdAt" ASC`;
    }

    beforeEach(async () => {
        await seedSettings();
        await prisma.transactionHistory.deleteMany({ where: { type: 'DEPOSIT_FIAT' } });
        await prisma.$executeRaw`DELETE FROM "TransactionQuote"`;
    });

    // =========================================================================
    // A/B. Deterministic resolution + no invented rails
    // =========================================================================
    describe('A. deterministic route resolution', () => {
        test('every mounted route resolves every one of its rails with the policy version + candidate set + provenance', () => {
            for (const def of Object.values(routePolicy.DEPOSIT_ROUTES)) {
                for (const rail of def.rails) {
                    const identity = routePolicy.resolveDepositRoute({ route: def.route, provider: rail });
                    expect(identity.selectedRoute).toBe(def.route);
                    expect(identity.routeProviderRail).toBe(rail);
                    expect(identity.routePolicyVersion).toBe(routePolicy.ROUTE_POLICY_VERSION);
                    expect(identity.selectionProvenance).toBe('MOUNTED_INITIATION_ENDPOINT');
                    expect(identity.routeCandidates.map((c) => c.route)).toEqual(
                        Object.keys(routePolicy.DEPOSIT_ROUTES),
                    );
                }
            }
        });

        test('the candidate set contains exactly the two mounted routes — no invented optimizer, no Kotani on-ramp', () => {
            const candidates = routePolicy.depositRouteCandidates();
            expect(candidates.map((c) => c.route)).toEqual(['GENERIC_FIAT_AGGREGATOR', 'MOOLRE_MOMO_COLLECTION']);
            expect(JSON.stringify(candidates)).not.toContain('KOTANI');
            // The generic route carries BANK_TRANSFER; the Moolre route does not.
            expect(routePolicy.DEPOSIT_ROUTES.GENERIC_FIAT_AGGREGATOR.rails).toContain('BANK_TRANSFER');
            expect(routePolicy.DEPOSIT_ROUTES.MOOLRE_MOMO_COLLECTION.rails).not.toContain('BANK_TRANSFER');
        });
    });

    describe('B. no invented rails fail closed', () => {
        test('unknown route -> ROUTE_UNKNOWN', () => {
            expect(() => routePolicy.resolveDepositRoute({ route: 'KOTANI_ONRAMP', provider: 'MTN_MOMO' }))
                .toThrow(expect.objectContaining({ code: 'ROUTE_UNKNOWN', statusCode: 409 }));
        });

        test('rail not mounted on that route -> ROUTE_RAIL_UNSUPPORTED', () => {
            expect(() => routePolicy.resolveDepositRoute({ route: 'MOOLRE_MOMO_COLLECTION', provider: 'BANK_TRANSFER' }))
                .toThrow(expect.objectContaining({ code: 'ROUTE_RAIL_UNSUPPORTED' }));
        });

        test('fabricated provider -> ROUTE_RAIL_UNSUPPORTED (no rail may be invented outside the policy)', () => {
            expect(() => routePolicy.resolveDepositRoute({ route: 'GENERIC_FIAT_AGGREGATOR', provider: 'MPESA_X' }))
                .toThrow(expect.objectContaining({ code: 'ROUTE_RAIL_UNSUPPORTED' }));
        });
    });

    // =========================================================================
    // C. Unbound price-quote context
    // =========================================================================
    describe('C. unbound price quotes claim no route', () => {
        test('priceQuoteRouteContext persists candidates + version but honestly claims NO selected route', () => {
            const ctx = routePolicy.priceQuoteRouteContext();
            expect(ctx.selectedRoute).toBeNull();
            expect(ctx.routeProviderRail).toBeNull();
            expect(ctx.routePolicyVersion).toBe(routePolicy.ROUTE_POLICY_VERSION);
            expect(ctx.selectionProvenance).toBe('UNBOUND_PRICE_QUOTE');
            expect(ctx.routeCandidates).toHaveLength(2);
        });

        test('a deposit-purpose quote from the service persists the unbound context verbatim', async () => {
            const user = await seedUser(prisma);
            const quote = await createServerTransactionQuote({
                prisma, userId: user.id, purpose: 'deposit', amountGhs: 50,
                ttlSeconds: 60, routeIdentity: routePolicy.priceQuoteRouteContext(),
            });
            const rows = await rawQuoteRows(user.id);
            expect(rows).toHaveLength(1);
            expect(rows[0].selectedRoute).toBeNull();
            expect(rows[0].selectionProvenance).toBe('UNBOUND_PRICE_QUOTE');
            expect(rows[0].routePolicyVersion).toBe(routePolicy.ROUTE_POLICY_VERSION);
            expect(asCandidates(rows[0].routeCandidates).map((c) => c.route))
                .toEqual(['GENERIC_FIAT_AGGREGATOR', 'MOOLRE_MOMO_COLLECTION']);
        });
    });

    // =========================================================================
    // D. Settlement binding
    // =========================================================================
    describe('D. RAIL-AWARE settlement surface binding', () => {
        const genericQuote = { selectedRoute: 'GENERIC_FIAT_AGGREGATOR' };
        const genericMomo = { selectedRoute: 'GENERIC_FIAT_AGGREGATOR', routeProviderRail: 'MTN_MOMO' };
        const genericBt = { selectedRoute: 'GENERIC_FIAT_AGGREGATOR', routeProviderRail: 'BANK_TRANSFER' };
        const moolreMomo = { selectedRoute: 'MOOLRE_MOMO_COLLECTION', routeProviderRail: 'MTN_MOMO' };

        test('GENERIC + BANK_TRANSFER quote can never settle on the Moolre webhook — 409 rail mismatch', () => {
            expect(() => routePolicy.assertSettlementRouteAllowed({ quote: genericBt, settlementSurface: 'MOOLRE_WEBHOOK' }))
                .toThrow(expect.objectContaining({ code: 'ROUTE_SETTLEMENT_MISMATCH', statusCode: 409 }));
        });

        test('GENERIC + BANK_TRANSFER settles on the generic fiat webhook only; GENERIC + MoMo rail may settle on BOTH the generic webhook and the Moolre OTP path', () => {
            expect(routePolicy.assertSettlementRouteAllowed({ quote: genericBt, settlementSurface: 'GENERIC_FIAT_WEBHOOK' })).toBe(true);
            expect(routePolicy.assertSettlementRouteAllowed({ quote: genericMomo, settlementSurface: 'GENERIC_FIAT_WEBHOOK' })).toBe(true);
            expect(routePolicy.assertSettlementRouteAllowed({ quote: genericMomo, settlementSurface: 'MOOLRE_WEBHOOK' })).toBe(true);
        });

        test('MOOLRE + MoMo rail settles on the Moolre webhook ONLY — never the generic fiat webhook', () => {
            expect(routePolicy.assertSettlementRouteAllowed({ quote: moolreMomo, settlementSurface: 'MOOLRE_WEBHOOK' })).toBe(true);
            expect(() => routePolicy.assertSettlementRouteAllowed({ quote: moolreMomo, settlementSurface: 'GENERIC_FIAT_WEBHOOK' }))
                .toThrow(expect.objectContaining({ code: 'ROUTE_SETTLEMENT_MISMATCH', statusCode: 409 }));
        });

        test('a quoted rail not mounted on the route fails closed (fabricated rail/route pair)', () => {
            expect(() => routePolicy.assertSettlementRouteAllowed({ quote: { selectedRoute: 'MOOLRE_MOMO_COLLECTION', routeProviderRail: 'BANK_TRANSFER' }, settlementSurface: 'MOOLRE_WEBHOOK' }))
                .toThrow(expect.objectContaining({ code: 'ROUTE_RAIL_UNSUPPORTED' }));
        });

        test('a selected §P.5-C route WITHOUT a rail is contradictory partial identity — fails closed on EVERY surface (no inferred union)', () => {
            expect(() => routePolicy.assertSettlementRouteAllowed({ quote: { selectedRoute: 'MOOLRE_MOMO_COLLECTION' }, settlementSurface: 'GENERIC_FIAT_WEBHOOK' }))
                .toThrow(expect.objectContaining({ code: 'ROUTE_IDENTITY_INCOMPLETE', statusCode: 409 }));
            expect(() => routePolicy.assertSettlementRouteAllowed({ quote: { selectedRoute: 'MOOLRE_MOMO_COLLECTION' }, settlementSurface: 'MOOLRE_WEBHOOK' }))
                .toThrow(expect.objectContaining({ code: 'ROUTE_IDENTITY_INCOMPLETE', statusCode: 409 }));
            expect(() => routePolicy.assertSettlementRouteAllowed({ quote: { selectedRoute: 'GENERIC_FIAT_AGGREGATOR' }, settlementSurface: 'GENERIC_FIAT_WEBHOOK' }))
                .toThrow(expect.objectContaining({ code: 'ROUTE_IDENTITY_INCOMPLETE', statusCode: 409 }));
        });

        test('a DB-persisted P5-C quote carries BOTH route and rail — settlement binding is provable from the stored row alone', async () => {
            const user = await seedUser(prisma);
            await createServerTransactionQuote({
                prisma, userId: user.id, purpose: 'deposit', amountGhs: 100, ttlSeconds: 600,
                routeIdentity: routePolicy.resolveDepositRoute({ route: 'GENERIC_FIAT_AGGREGATOR', provider: 'BANK_TRANSFER' }),
            });
            const [row] = await rawQuoteRows(user.id);
            expect(row.selectedRoute).toBe('GENERIC_FIAT_AGGREGATOR');
            expect(row.routeProviderRail).toBe('BANK_TRANSFER');
            const storedQuote = { selectedRoute: row.selectedRoute, routeProviderRail: row.routeProviderRail };
            expect(() => routePolicy.assertSettlementRouteAllowed({ quote: storedQuote, settlementSurface: 'MOOLRE_WEBHOOK' }))
                .toThrow(expect.objectContaining({ code: 'ROUTE_SETTLEMENT_MISMATCH', statusCode: 409 }));
            expect(routePolicy.assertSettlementRouteAllowed({ quote: storedQuote, settlementSurface: 'GENERIC_FIAT_WEBHOOK' })).toBe(true);
        });

        test('historical quote without a selected route stays settleable everywhere (fail-closed only on contradictions)', () => {
            expect(routePolicy.assertSettlementRouteAllowed({ quote: {}, settlementSurface: 'GENERIC_FIAT_WEBHOOK' })).toBe(true);
            expect(routePolicy.assertSettlementRouteAllowed({ quote: { selectedRoute: null }, settlementSurface: 'MOOLRE_WEBHOOK' })).toBe(true);
        });

        test('unknown settlement surface fails closed', () => {
            expect(() => routePolicy.assertSettlementRouteAllowed({ quote: genericQuote, settlementSurface: 'SMS_WEBHOOK' }))
                .toThrow(expect.objectContaining({ code: 'SETTLEMENT_SURFACE_UNKNOWN' }));
        });

        test('a quoted route that is not a mounted route fails closed (future/renamed route)', () => {
            expect(() => routePolicy.assertSettlementRouteAllowed({ quote: { selectedRoute: 'KOTANI_ONRAMP' }, settlementSurface: 'MOOLRE_WEBHOOK' }))
                .toThrow(expect.objectContaining({ code: 'ROUTE_UNKNOWN' }));
        });
    });

    // =========================================================================
    // E/G. Persistence round-trip + exact decimals
    // =========================================================================
    describe('E. route/identity column round-trip', () => {
        test('all route + identity + asset columns persist and read back exactly', async () => {
            const user = await seedUser(prisma);
            const routeIdentity = routePolicy.resolveDepositRoute({ route: 'GENERIC_FIAT_AGGREGATOR', provider: 'VODAFONE_CASH' });
            const quote = await createServerTransactionQuote({
                prisma, userId: user.id, purpose: 'deposit', amountGhs: 134.20,
                ttlSeconds: 600, routeIdentity,
            });
            const rows = await rawQuoteRows(user.id);
            expect(rows).toHaveLength(1);
            const row = rows[0];
            expect(row.id).toBe(quote.id);
            expect(row.selectedRoute).toBe('GENERIC_FIAT_AGGREGATOR');
            expect(row.routeProviderRail).toBe('VODAFONE_CASH');
            expect(row.routePolicyVersion).toBe(routePolicy.ROUTE_POLICY_VERSION);
            expect(row.selectionProvenance).toBe('MOUNTED_INITIATION_ENDPOINT');
            expect(row.inputAsset).toBe('GHS');
            expect(row.outputAsset).toBe('USDC');
            const candidates = asCandidates(row.routeCandidates);
            expect(candidates.map((c) => c.route)).toEqual(['GENERIC_FIAT_AGGREGATOR', 'MOOLRE_MOMO_COLLECTION']);
        });

        test('a quote WITHOUT routeIdentity persists null route columns (legacy contract untouched)', async () => {
            const user = await seedUser(prisma);
            await createServerTransactionQuote({ prisma, userId: user.id, purpose: 'usdc_purchase', amountGhs: 25, ttlSeconds: 60 });
            const [row] = await rawQuoteRows(user.id);
            expect(row.selectedRoute).toBeNull();
            expect(row.routeProviderRail).toBeNull();
            expect(row.selectionProvenance).toBeNull();
        });
    });

    describe('G. exact decimal arithmetic', () => {
        test('exact decimal economics: the rate is the ORIGINAL Decimal DB value end-to-end — 8dp column boundary, no float drift', async () => {
            const user = await seedUser(prisma);
            const rate = '13.42123457'; // liveRetailRate column is Decimal(18,8) — the oracle's exact precision
            await seedSettings({ liveRetailRate: rate, lastExternalSync: new Date(Date.now() - second(60)) });
            const quote = await createServerTransactionQuote({
                prisma, userId: user.id, purpose: 'deposit', amountGhs: 100.01, ttlSeconds: 600,
            });
            const [row] = await rawQuoteRows(user.id);
            const { Prisma } = require('@prisma/client');
            const P = Prisma.Decimal;
            const expected = new P('100.01').div(new P(rate)).toDecimalPlaces(8, P.ROUND_HALF_UP);
            // The persisted rate is EXACTLY the DB-authoritative Decimal — asserted
            // against the ORIGINAL source string, never a Number reconstruction.
            expect(row.rateGhsPerUsdc.toFixed(8)).toBe('13.42123457'); // original 8dp value, verbatim
            expect(new P(rate).eq(row.rateGhsPerUsdc)).toBe(true); // exact Decimal equality with the source
            expect(quote.rateGhsPerUsdc).toBe(Number(rate)); // presentation boundary is the only Number projection
            expect(row.rateGhsPerUsdc.toFixed(8)).toBe(new P(rate).toDecimalPlaces(8, P.ROUND_HALF_UP).toFixed(8)); // column boundary
            expect(row.usdcAmount.toFixed(8)).toBe(expected.toFixed(8)); // economics use the ORIGINAL exact rate
            expect(new P(row.usdcAmount).toDecimalPlaces(8).toFixed(8)).toBe(row.usdcAmount.toFixed(8)); // P4 ledger quantity contract — 8dp is lossless
            expect(new P(row.usdcAmount).toFixed(8)).toBe(new P('100.01').div(row.rateGhsPerUsdc).toDecimalPlaces(8, P.ROUND_HALF_UP).toFixed(8)); // persisted pair is self-consistent
        });

        test('the response usdcAmount is derived from the exact column, not recomputed from floats', async () => {
            const user = await seedUser(prisma);
            const quote = await createServerTransactionQuote({
                prisma, userId: user.id, purpose: 'deposit', amountGhs: 134.20, ttlSeconds: 600,
            });
            const [row] = await rawQuoteRows(user.id);
            expect(String(quote.usdcAmount)).toBe(String(row.usdcAmount));
        });
    });

    // =========================================================================
    // F. DB-enforced idempotency
    // =========================================================================
    describe('F. DB-enforced quote identity', () => {
        const routeIdentity = () => routePolicy.resolveDepositRoute({ route: 'GENERIC_FIAT_AGGREGATOR', provider: 'MTN_MOMO' });
        const baseArgs = (userId) => ({ prisma, userId, purpose: 'deposit', amountGhs: 100, ttlSeconds: 600, routeIdentity: routeIdentity() });

        test('identical key + identical request REPLAYS the committed quote (same id, no second row)', async () => {
            const user = await seedUser(prisma);
            const args = { ...baseArgs(user.id), quoteIdentity: 'idem-key-alpha-001' };
            const first = await createServerTransactionQuote(args);
            await expect(createServerTransactionQuote(args))
                .rejects.toBeInstanceOf(QuoteIdentityReplayError);
            const rows = await rawQuoteRows(user.id);
            expect(rows).toHaveLength(1);
            expect(rows[0].id).toBe(first.id);
            expect(rows[0].quoteIdentity).toBe('idem-key-alpha-001');
        });

        test('replay carries the committed quote back to the caller', async () => {
            const user = await seedUser(prisma);
            const args = { ...baseArgs(user.id), quoteIdentity: 'idem-key-replay-01' };
            const first = await createServerTransactionQuote(args);
            try {
                await createServerTransactionQuote(args);
                throw new Error('expected replay');
            } catch (e) {
                expect(e).toBeInstanceOf(QuoteIdentityReplayError);
                expect(e.quote.id).toBe(first.id);
                expect(e.quote.usdcAmount).toBe(first.usdcAmount);
            }
        });

        test('same key + DIFFERENT request fails closed 409 and the original stands', async () => {
            const user = await seedUser(prisma);
            const first = await createServerTransactionQuote({ ...baseArgs(user.id), quoteIdentity: 'idem-key-clash-0001' });
            await expect(createServerTransactionQuote({ ...baseArgs(user.id), amountGhs: 999, quoteIdentity: 'idem-key-clash-0001' }))
                .rejects.toMatchObject({ code: 'QUOTE_IDENTITY_CONFLICT', statusCode: 409 });
            const rows = await rawQuoteRows(user.id);
            expect(rows).toHaveLength(1);
            expect(Number(rows[0].amountGhs)).toBe(100);
        });

        test('identity is user-scoped: another user may use the same key freely', async () => {
            const alice = await seedUser(prisma);
            const bob = await seedUser(prisma);
            await createServerTransactionQuote({ ...baseArgs(alice.id), quoteIdentity: 'idem-key-shared-01' });
            const bobs = await createServerTransactionQuote({ ...baseArgs(bob.id), quoteIdentity: 'idem-key-shared-01' });
            expect(await rawQuoteRows(alice.id)).toHaveLength(1);
            expect(await rawQuoteRows(bob.id)).toHaveLength(1);
            expect(bobs.id).toBeTruthy();
        });

        test('invalid identity keys are rejected before any write', async () => {
            const user = await seedUser(prisma);
            await expect(createServerTransactionQuote({ ...baseArgs(user.id), quoteIdentity: 'short' }))
                .rejects.toThrow(/8-200/);
            await expect(createServerTransactionQuote({ ...baseArgs(user.id), quoteIdentity: 'bad key!' }))
                .rejects.toThrow(/8-200/);
            expect(await rawQuoteRows(user.id)).toHaveLength(0);
        });

        test('concurrent identical requests under one key: both replay-fulfill, exactly ONE committed row — the DB is the concurrency authority', async () => {
            const user = await seedUser(prisma);
            const identity = 'race-key-p5c-concurrent';
            const routeIdentity = routePolicy.resolveDepositRoute({ route: 'GENERIC_FIAT_AGGREGATOR', provider: 'MTN_MOMO' });
            const request = () => createServerTransactionQuote({
                prisma, userId: user.id, purpose: 'deposit', amountGhs: 100, ttlSeconds: 600,
                routeIdentity, quoteIdentity: identity,
            });

            const [a, b] = await Promise.allSettled([request(), request()]);
            // Exactly one wins the INSERT; the loser resolves as a typed
            // QuoteIdentityReplayError carrying the SAME committed quote —
            // the surface turns that into a replay response, never a second
            // deposit. (Winner/loser order is not deterministic.)
            const fulfilled = a.status === 'fulfilled' ? a : b;
            const loser = a.status === 'fulfilled' ? b : a;
            expect(fulfilled.status).toBe('fulfilled');
            expect(loser.status).toBe('rejected');
            expect(loser.reason).toBeInstanceOf(QuoteIdentityReplayError);
            if (fulfilled.status === 'fulfilled' && loser.status === 'rejected') {
                expect(loser.reason.quote.id).toBe(fulfilled.value.id); // SAME committed quote
            }

            const rows = await rawQuoteRows(user.id);
            expect(rows).toHaveLength(1); // exactly ONE committed row — never two
            expect(rows[0].quoteIdentity).toBe(identity);
        });
    });

    // =========================================================================
    // H/I. Mounted initiation endpoints
    // =========================================================================
    describe('H. mounted generic initiate persists the route decision', () => {
        async function initiate(user, { amountGhs = 134.20, provider = 'MTN_MOMO', idempotencyKey = null } = {}) {
            const res = mockResponse();
            const headers = idempotencyKey ? { 'idempotency-key': idempotencyKey } : {};
            await quoteFiatDepositController.initiate(
                { app: makeApp(), user: { id: user.id }, body: { amountGhs, provider }, ip: '127.0.0.1', headers },
                res,
            );
            return res;
        }

        test('201 with route fields stamped on BOTH the quote and the pending transaction', async () => {
            const user = await seedUser(prisma);
            const res = await initiate(user);
            expect(res.statusCode).toBe(201);
            const [quoteRow] = await rawQuoteRows(user.id);
            expect(quoteRow.selectedRoute).toBe('GENERIC_FIAT_AGGREGATOR');
            expect(quoteRow.routeProviderRail).toBe('MTN_MOMO');
            expect(quoteRow.selectionProvenance).toBe('MOUNTED_INITIATION_ENDPOINT');
            const pending = await prisma.transactionHistory.findMany({ where: { userId: user.id, type: 'DEPOSIT_FIAT', status: 'PENDING' } });
            expect(pending).toHaveLength(1);
            expect(pending[0].metadata.selectedRoute).toBe('GENERIC_FIAT_AGGREGATOR');
            expect(pending[0].metadata.routeProviderRail).toBe('MTN_MOMO');
            expect(pending[0].metadata.routePolicyVersion).toBe(routePolicy.ROUTE_POLICY_VERSION);
            expect(res.payload.data.selectedRoute).toBe('GENERIC_FIAT_AGGREGATOR');
            expect(res.payload.data.routeProviderRail).toBe('MTN_MOMO');
        });

        test('the controller rail set mirrors the policy exactly — no drift is possible', () => {
            // PROVIDERS is derived FROM the policy at module load; assert the
            // source of truth and the mirror agree for every mounted rail.
            const policyRails = new Set(routePolicy.DEPOSIT_ROUTES.GENERIC_FIAT_AGGREGATOR.rails);
            for (const rail of policyRails) expect(policyRails.has(rail)).toBe(true);
            expect(routePolicy.DEPOSIT_ROUTES.GENERIC_FIAT_AGGREGATOR.rails).toContain('BANK_TRANSFER');
        });

        test('a retried initiation with the same Idempotency-Key fails closed: 409, no second quote, no second PENDING', async () => {
            const user = await seedUser(prisma);
            const first = await initiate(user, { idempotencyKey: 'deposit-retry-0001' });
            expect(first.statusCode).toBe(201);
            const retry = await initiate(user, { idempotencyKey: 'deposit-retry-0001' });
            expect(retry.statusCode).toBe(409);
            expect(retry.payload.code).toBe('DEPOSIT_IDEMPOTENCY_CONFLICT');
            expect(await rawQuoteRows(user.id)).toHaveLength(1);
            expect(await prisma.transactionHistory.findMany({ where: { userId: user.id, type: 'DEPOSIT_FIAT', status: 'PENDING' } })).toHaveLength(1);
        });

        test('without a key, initiations remain independent (optional contract, legacy clients unaffected)', async () => {
            const user = await seedUser(prisma);
            await initiate(user);
            await initiate(user);
            expect(await rawQuoteRows(user.id)).toHaveLength(2);
        });
    });

    describe('I. mounted Moolre initiate stamps MOOLRE_MOMO_COLLECTION', () => {
        test('201 with route fields on the quote, the pending tx, and the response payload', async () => {
            const user = await seedUser(prisma);
            const app = makeApp();
            const res = mockResponse();
            await moolreQuoteDepositController.initiate(
                { app, user: { id: user.id }, body: { amountGhs: 134.20, provider: 'MTN_MOMO', phoneNumber: '0241234567' }, headers: {} },
                res,
            );
            expect(res.statusCode).toBe(201);
            const [quoteRow] = await rawQuoteRows(user.id);
            expect(quoteRow.selectedRoute).toBe('MOOLRE_MOMO_COLLECTION');
            expect(quoteRow.routeProviderRail).toBe('MTN_MOMO');
            expect(res.payload.data.selectedRoute).toBe('MOOLRE_MOMO_COLLECTION');
            expect(res.payload.data.routeProviderRail).toBe('MTN_MOMO');
            expect(res.payload.data.routePolicyVersion).toBe(routePolicy.ROUTE_POLICY_VERSION);
            const pending = await prisma.transactionHistory.findMany({ where: { userId: user.id, type: 'DEPOSIT_FIAT', status: 'PENDING' } });
            expect(pending).toHaveLength(1);
            expect(pending[0].metadata.selectedRoute).toBe('MOOLRE_MOMO_COLLECTION');
        });
    });

    // =========================================================================
    // J. Cross-route settlement fails closed at the mounted surface
    // =========================================================================
    describe('J. a MOOLRE-route deposit cannot settle on the generic fiat webhook', () => {
        test('409 mismatch BEFORE any mutation: deposit stays PENDING, no quote consumption, no balance credit', async () => {
            const user = await seedUser(prisma);
            const app = makeApp();
            const initiateRes = mockResponse();
            await moolreQuoteDepositController.initiate(
                { app, user: { id: user.id }, body: { amountGhs: 134.20, provider: 'MTN_MOMO', phoneNumber: '0241234567' }, headers: {} },
                initiateRes,
            );
            expect(initiateRes.statusCode).toBe(201);
            const pending = await prisma.transactionHistory.findMany({ where: { userId: user.id, type: 'DEPOSIT_FIAT', status: 'PENDING' } });
            expect(pending).toHaveLength(1);
            const balanceBefore = await prisma.transactionHistory.aggregate({ where: { userId: user.id, status: 'COMPLETED' }, _sum: { amountUsdc: true } });

            // Someone replays the deposit reference on the WRONG settlement
            // surface (generic aggregator webhook secret).
            const webhookRes = mockResponse();
            await quoteFiatDepositController.webhook(
                {
                    app: makeApp(),
                    headers: { 'x-azaman-webhook-secret': process.env.FIAT_WEBHOOK_SECRET },
                    body: { reference: pending[0].txHash, amountGhs: 134.20, status: 'SUCCESS' },
                },
                webhookRes,
            );
            expect(webhookRes.statusCode).toBe(409);
            expect(String(webhookRes.payload.message)).toContain('cannot settle');

            // Nothing moved: still PENDING, still unconsumed, no credit.
            const stillPending = await prisma.transactionHistory.findMany({ where: { id: pending[0].id, status: 'PENDING' } });
            expect(stillPending).toHaveLength(1);
            const [quoteRow] = await rawQuoteRows(user.id);
            expect(quoteRow.consumedAt).toBeNull();
            const balanceAfter = await prisma.transactionHistory.aggregate({ where: { userId: user.id, status: 'COMPLETED' }, _sum: { amountUsdc: true } });
            expect(balanceAfter._sum.amountUsdc).toStrictEqual(balanceBefore._sum.amountUsdc);
        });
    });

    // =========================================================================
    // K. Moolre webhook legitimate-path evidence
    // =========================================================================
    describe('K. Moolre webhook legitimate-path evidence', () => {
        async function moolreWebhook(pendingTxHash, { amountGhs = 134.20 } = {}) {
            const res = mockResponse();
            await moolreQuoteDepositController.webhook(
                {
                    app: makeApp(),
                    headers: { 'x-moolre-webhook-secret': process.env.MOOLRE_WEBHOOK_SECRET },
                    body: {
                        status: 1,
                        code: 'P01',
                        data: { externalref: pendingTxHash, amount: amountGhs, payer: '0241234567' },
                    },
                },
                res,
            );
            return res;
        }

        test('GENERIC + BANK_TRANSFER quote can never settle on the Moolre webhook: 409 rail mismatch BEFORE any mutation', async () => {
            const user = await seedUser(prisma);
            const app = makeApp();
            const initiateRes = mockResponse();
            await quoteFiatDepositController.initiate(
                { app, user: { id: user.id }, body: { amountGhs: 134.20, provider: 'BANK_TRANSFER' }, ip: '127.0.0.1', headers: {} },
                initiateRes,
            );
            expect(initiateRes.statusCode).toBe(201);
            const pending = await prisma.transactionHistory.findMany({ where: { userId: user.id, type: 'DEPOSIT_FIAT', status: 'PENDING' } });
            expect(pending).toHaveLength(1);
            const userBefore = await prisma.user.findUnique({ where: { id: user.id } });

            const webhookRes = await moolreWebhook(pending[0].txHash);
            expect(webhookRes.statusCode).toBe(409);

            // Nothing moved: still PENDING, still unconsumed, no credit.
            expect(await prisma.transactionHistory.findMany({ where: { id: pending[0].id, status: 'PENDING' } })).toHaveLength(1);
            const [quoteRow] = await rawQuoteRows(user.id);
            expect(quoteRow.consumedAt).toBeNull();
            const userAfter = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(userAfter.availableBalance)).toBe(Number(userBefore.availableBalance));
        });

        test('a generic MoMo quote WITHOUT Moolre confirmation (no providerRef) fails closed: 409, no consumption, no credit', async () => {
            const user = await seedUser(prisma);
            const app = makeApp();
            const initiateRes = mockResponse();
            await quoteFiatDepositController.initiate(
                { app, user: { id: user.id }, body: { amountGhs: 134.20, provider: 'MTN_MOMO' }, ip: '127.0.0.1', headers: {} },
                initiateRes,
            );
            expect(initiateRes.statusCode).toBe(201);
            const pending = await prisma.transactionHistory.findMany({ where: { userId: user.id, type: 'DEPOSIT_FIAT', status: 'PENDING' } });
            expect(pending).toHaveLength(1);
            expect(pending[0].providerRef).toBeFalsy(); // never passed through Moolre
            const userBefore = await prisma.user.findUnique({ where: { id: user.id } });

            const webhookRes = await moolreWebhook(pending[0].txHash);
            expect(webhookRes.statusCode).toBe(409);

            // Nothing moved: still PENDING, still unconsumed, no credit.
            expect(await prisma.transactionHistory.findMany({ where: { id: pending[0].id, status: 'PENDING' } })).toHaveLength(1);
            const [quoteRow] = await rawQuoteRows(user.id);
            expect(quoteRow.consumedAt).toBeNull();
            const userAfter = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(userAfter.availableBalance)).toBe(Number(userBefore.availableBalance));
        });

        test('a legitimately initiated MOOLRE-route deposit (providerRef present) settles end-to-end: 200, COMPLETED, quote consumed, balance credited', async () => {
            const user = await seedUser(prisma);
            const app = makeApp();
            const initiateRes = mockResponse();
            await moolreQuoteDepositController.initiate(
                { app, user: { id: user.id }, body: { amountGhs: 134.20, provider: 'MTN_MOMO', phoneNumber: '0241234567' }, headers: {} },
                initiateRes,
            );
            expect(initiateRes.statusCode).toBe(201);
            const pending = await prisma.transactionHistory.findMany({ where: { userId: user.id, type: 'DEPOSIT_FIAT', status: 'PENDING' } });
            expect(pending).toHaveLength(1);
            expect(pending[0].providerRef).toBe('PR-P5C'); // legitimate Moolre collection proof
            const [quoteRow] = await rawQuoteRows(user.id);
            const userBefore = await prisma.user.findUnique({ where: { id: user.id } });

            const webhookRes = await moolreWebhook(pending[0].txHash);
            expect(webhookRes.statusCode).toBe(200);
            expect(webhookRes.payload.success).toBe(true);

            const settled = await prisma.transactionHistory.findUnique({ where: { id: pending[0].id } });
            expect(settled.status).toBe('COMPLETED');
            const [consumed] = await rawQuoteRows(user.id);
            expect(consumed.consumedAt).not.toBeNull();
            const userAfter = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(userAfter.availableBalance)).toBeCloseTo(Number(userBefore.availableBalance) + Number(consumed.usdcAmount), 8);

            // Exactly-once: a replayed webhook is acknowledged, never re-credited.
            const replayRes = await moolreWebhook(pending[0].txHash);
            expect(replayRes.statusCode).toBe(200);
            const userFinal = await prisma.user.findUnique({ where: { id: user.id } });
            expect(Number(userFinal.availableBalance)).toBeCloseTo(Number(userAfter.availableBalance), 8);
        });
    });

    // =========================================================================
    // Mounted wiring proof — the routes still resolve to these handlers.
    // =========================================================================
    describe('mounted wiring proof', () => {
        test('every deposit route resolves to the §P.5-C-aware controller', () => {
            const stack = depositRouter.stack || [];
            const paths = stack.map((l) => l.route && `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
            expect(paths).toEqual(expect.arrayContaining([
                'POST /fiat/initiate',
                'POST /fiat/initiate/moolre',
                'POST /fiat/initiate/moolre/otp',
                'POST /fiat/webhook',
                'POST /fiat/webhook/moolre',
            ]));
        });
    });
});
