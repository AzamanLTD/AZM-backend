// __tests__/rate-provenance-truthfulness.test.js
// =============================================================================
// Real-PostgreSQL proof of the PR 271B (issue #271) truthful rate
// provenance/freshness contract:
//
//   lastRateSync    = timestamp of the most recent successful EXTERNAL
//                     market-rate observation.
//   lastExternalSync= canonical freshness field; identical to lastRateSync
//                     for the same genuine observation.
//
// Echoes (MOCK gateway), cached copies, and manual admin overrides must NEVER
// refresh external freshness — they record their own provenance
// (lastEchoAt / lastAdminSetAt) instead.
//
// This suite NEVER mocks Prisma — every assertion executes against real
// PostgreSQL (TEST_DATABASE_URL). External provider calls (CoinGecko,
// open.er-api.com, Kotani) are mocked at the axios boundary so the writers'
// success/failure paths are deterministic. Skips cleanly when
// TEST_DATABASE_URL is not set, matching the repo's DB-gated convention.
//
// Coverage (brief sections A–I):
//   A. Oracle success stamps lastRateSync + lastExternalSync (same observation)
//   B. Oracle failure leaves rate + both timestamps untouched
//   C. MOCK echo preserves retail/source/freshness; only lastEchoAt advances
//   D. Gateway LIVE stamps as external; LIVE failure → MOCK fallback must NOT
//   E. Admin override records manual provenance, never external freshness
//   F. Mixed writer sequence: external timestamp survives echo + admin + failure
//   G. Quote snapshot inherits the TRUE external observation timestamp
//   H. API read-models expose the new provenance fields additively
//   I. Historical-null rows (no provenance recorded) are safe everywhere
// =============================================================================

jest.mock('axios');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[rate-provenance-truthfulness.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('Rate provenance truthfulness (real PostgreSQL) — issue #271 / PR 271B', () => {
    let prisma;
    let adminUser;
    const axios = require('axios');
    const { seedUser } = require('./helpers/factories');

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        adminUser = await seedUser(prisma, { role: 'ADMIN' });
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    // ---- helpers -------------------------------------------------------------

    const getSettings = () => prisma.globalSettings.findUnique({ where: { id: 1 } });

    async function seedSettings(overrides = {}) {
        const base = {
            liveUsdToGhs: 13.10,
            liveRetailRate: 13.42,
            liveCorporateRate: 13.22,
            liveRateSource: 'KOTANI_PAY',
            lastRateSync: new Date('2026-09-17T10:00:00.000Z'),
            lastExternalSync: new Date('2026-09-17T10:00:00.000Z'),
            lastAdminSetAt: null,
            lastEchoAt: null,
        };
        const data = { ...base, ...overrides };
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
        return getSettings();
    }

    function mockRequest(body = {}) {
        return {
            app: { get: () => prisma },
            user: { id: adminUser.id, username: adminUser.username },
            body,
        };
    }

    function mockResponse() {
        return {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.payload = payload; return this; },
        };
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function makeOracle(externalRate = 12.75) {
        axios.get.mockReset();
        axios.post.mockReset();
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) {
                return Promise.resolve({ data: { tether: { usd: 1 }, 'usd-coin': { usd: 1 }, dai: { usd: 1 } } });
            }
            if (url.includes('open.er-api.com')) {
                return Promise.resolve({ data: { rates: { GHS: 12.60 } } });
            }
            return Promise.reject(new Error(`unexpected GET ${url}`));
        });
        axios.post.mockImplementation(() => Promise.resolve({ data: { rate: externalRate } }));
        process.env.KOTANI_PROVIDER = 'LIVE';
        process.env.KOTANI_API_TOKEN = 'test-token';
        const OracleService = require('../services/oracleService');
        return new OracleService(prisma);
    }

    function makeFailingOracle() {
        axios.get.mockReset();
        axios.post.mockReset();
        axios.get.mockRejectedValue(new Error('all providers down'));
        axios.post.mockRejectedValue(new Error('kotani down'));
        process.env.KOTANI_PROVIDER = 'LIVE';
        process.env.KOTANI_API_TOKEN = 'test-token';
        const OracleService = require('../services/oracleService');
        return new OracleService(prisma);
    }

    function makeGatewayMock() {
        axios.get.mockReset();
        axios.post.mockReset();
        delete process.env.KOTANI_PROVIDER;
        delete process.env.KOTANI_API_KEY;
        delete process.env.KOTANI_API_TOKEN;
        const GatewayService = require('../services/gatewayService');
        return new GatewayService(prisma);
    }

    function makeGatewayLive({ succeed = true } = {}) {
        axios.get.mockReset();
        axios.post.mockReset();
        process.env.KOTANI_PROVIDER = 'LIVE';
        process.env.KOTANI_API_KEY = 'test-key';
        axios.get.mockImplementation(() => {
            if (!succeed) return Promise.reject(new Error('kotani LIVE outage'));
            return Promise.resolve({ data: { rate: '12.90', corporateRate: '12.70' } });
        });
        const GatewayService = require('../services/gatewayService');
        return new GatewayService(prisma);
    }

    // ---- A. Oracle success ---------------------------------------------------

    test('A. oracle success stamps lastRateSync AND lastExternalSync with the same observation', async () => {
        await seedSettings({
            liveRetailRate: 13.42,
            lastRateSync: new Date('2026-09-17T10:00:00.000Z'),
            lastExternalSync: new Date('2026-09-17T10:00:00.000Z'),
        });

        const before = Date.now();
        await makeOracle(12.75).fetchAndUpdateRates();
        const after = Date.now();

        const row = await getSettings();
        expect(Number(row.liveRetailRate)).toBe(12.75);
        expect(row.liveRateSource).toBe('KOTANI_PAY');
        expect(row.lastRateSync).not.toBeNull();
        expect(row.lastExternalSync).not.toBeNull();
        // Same observation → identical timestamps (issue #271 contract).
        expect(row.lastRateSync.getTime()).toBe(row.lastExternalSync.getTime());
        // The observation is genuinely fresh.
        expect(row.lastExternalSync.getTime()).toBeGreaterThanOrEqual(before - 5);
        expect(row.lastExternalSync.getTime()).toBeLessThanOrEqual(after + 5);
    });

    // ---- B. Oracle failure ---------------------------------------------------

    test('B. oracle failure preserves the cached rate and touches NEITHER timestamp', async () => {
        const prior = await seedSettings({ liveRetailRate: 13.42, liveRateSource: 'KOTANI_PAY' });

        await makeFailingOracle().fetchAndUpdateRates();

        const row = await getSettings();
        expect(Number(row.liveRetailRate)).toBe(13.42);
        expect(row.liveRateSource).toBe('KOTANI_PAY');
        expect(row.lastRateSync.getTime()).toBe(prior.lastRateSync.getTime());
        expect(row.lastExternalSync.getTime()).toBe(prior.lastExternalSync.getTime());
    });

    // ---- C. MOCK echo --------------------------------------------------------

    test('C. MOCK echo preserves retail/source/freshness; only lastEchoAt advances', async () => {
        // liveUsdToGhs deliberately differs from liveRetailRate: the old bug
        // echoed the headline rate over the USDC-adjusted retail rate.
        const prior = await seedSettings({
            liveUsdToGhs: 13.10,
            liveRetailRate: 13.42,
            liveRateSource: 'KOTANI_PAY',
            lastEchoAt: null,
        });

        await makeGatewayMock().syncRatesToGlobalSettings();

        const row = await getSettings();
        expect(Number(row.liveRetailRate)).toBe(13.42); // NOT overwritten by the echo
        expect(Number(row.liveUsdToGhs)).toBe(13.10);    // NOT overwritten either
        expect(row.liveRateSource).toBe('KOTANI_PAY');  // source preserved
        expect(row.lastRateSync.getTime()).toBe(prior.lastRateSync.getTime());
        expect(row.lastExternalSync.getTime()).toBe(prior.lastExternalSync.getTime());
        expect(row.lastEchoAt).not.toBeNull();           // the echo records itself
        expect(row.lastEchoAt.getTime()).toBeGreaterThan(prior.lastRateSync.getTime());
        // Corporate rate derives from the canonical retail snapshot.
        expect(Number(row.liveCorporateRate)).toBeCloseTo(13.42 * 0.985, 6);
    });

    // ---- D. Gateway LIVE -----------------------------------------------------

    test('D1. gateway LIVE success is an external observation and stamps both freshness fields', async () => {
        await seedSettings({ liveRetailRate: 13.42, lastEchoAt: null });

        const before = Date.now();
        await makeGatewayLive({ succeed: true }).syncRatesToGlobalSettings();
        const after = Date.now();

        const row = await getSettings();
        expect(Number(row.liveRetailRate)).toBe(12.90);
        expect(Number(row.liveCorporateRate)).toBe(12.70);
        expect(Number(row.liveUsdToGhs)).toBe(12.90);
        expect(row.liveRateSource).toBe('LIVE');
        expect(row.lastRateSync.getTime()).toBe(row.lastExternalSync.getTime());
        expect(row.lastExternalSync.getTime()).toBeGreaterThanOrEqual(before - 5);
        expect(row.lastExternalSync.getTime()).toBeLessThanOrEqual(after + 5);
    });

    test('D2. gateway LIVE failure falling back to MOCK must NOT stamp freshness', async () => {
        const prior = await seedSettings({
            liveRetailRate: 13.42,
            liveRateSource: 'KOTANI_PAY',
            lastEchoAt: null,
        });

        const rates = await makeGatewayLive({ succeed: false }).syncRatesToGlobalSettings();
        expect(rates.source).toBe('MOCK'); // fetchOfframpRates fell back to MOCK

        const row = await getSettings();
        expect(Number(row.liveRetailRate)).toBe(13.42);           // untouched
        expect(row.liveRateSource).toBe('KOTANI_PAY');            // untouched
        expect(row.lastRateSync.getTime()).toBe(prior.lastRateSync.getTime());
        expect(row.lastExternalSync.getTime()).toBe(prior.lastExternalSync.getTime());
        expect(row.lastEchoAt).not.toBeNull();                    // echo recorded, freshness not
    });

    // ---- E. Admin override ---------------------------------------------------

    test('E. admin override records manual provenance and never external freshness', async () => {
        const prior = await seedSettings({ liveRetailRate: 13.42, lastAdminSetAt: null });
        const { updateSettings } = require('../controllers/adminSettingsController');

        const res = mockRequest({ liveUsdToGhs: 14.50 });
        const out = mockResponse();
        await updateSettings(res, out);

        expect(out.statusCode).toBe(200);

        const row = await getSettings();
        expect(Number(row.liveUsdToGhs)).toBe(14.50);
        expect(row.lastRateSync.getTime()).toBe(prior.lastRateSync.getTime());          // external freshness unmoved
        expect(row.lastExternalSync.getTime()).toBe(prior.lastExternalSync.getTime());  // canonical freshness unmoved
        expect(row.lastAdminSetAt).not.toBeNull();                                     // manual provenance recorded
        expect(row.lastAdminSetAt.getTime()).toBeGreaterThan(prior.lastRateSync.getTime());
        expect(row.liveRateSource).toBe('AZM_ADMIN_OVERRIDE');                         // labeled, not a second rate source

        // Audit log preserved (old/new values still recorded).
        const log = await prisma.adminSettingsAuditLog.findFirst({
            where: { adminId: adminUser.id, action: 'UPDATE_SETTINGS' },
            orderBy: { createdAt: 'desc' },
        });
        expect(log).not.toBeNull();
        expect(log.changes.liveUsdToGhs).toEqual({ old: 13.10, new: 14.50 });
        expect(log.changes.lastAdminSetAt).toBeDefined();
    });

    // ---- F. Mixed writer sequence ---------------------------------------------

    test('F. mixed sequence: the external timestamp survives echo + admin + oracle failure', async () => {
        await seedSettings({ liveRetailRate: 13.42, lastEchoAt: null, lastAdminSetAt: null });

        // 1. oracle success — the only genuine external observation
        await makeOracle(12.75).fetchAndUpdateRates();
        const afterOracle = await getSettings();
        const externalTs = afterOracle.lastExternalSync.getTime();
        expect(afterOracle.lastRateSync.getTime()).toBe(externalTs);

        await sleep(40);

        // 2. MOCK echo
        await makeGatewayMock().syncRatesToGlobalSettings();
        let row = await getSettings();
        expect(row.lastExternalSync.getTime()).toBe(externalTs);
        expect(row.lastRateSync.getTime()).toBe(externalTs);

        await sleep(40);

        // 3. admin override
        const { updateSettings } = require('../controllers/adminSettingsController');
        await updateSettings(mockRequest({ liveUsdToGhs: 15.00 }), mockResponse());
        row = await getSettings();
        expect(row.lastExternalSync.getTime()).toBe(externalTs); // still the oracle success time
        expect(row.lastRateSync.getTime()).toBe(externalTs);
        expect(row.lastAdminSetAt.getTime()).toBeGreaterThan(externalTs);
        expect(row.liveRateSource).toBe('AZM_ADMIN_OVERRIDE');

        await sleep(40);

        // 4. oracle failure — no fake fresh timestamp
        await makeFailingOracle().fetchAndUpdateRates();
        row = await getSettings();
        expect(row.lastExternalSync.getTime()).toBe(externalTs);
        expect(row.lastRateSync.getTime()).toBe(externalTs);
        expect(Number(row.liveUsdToGhs)).toBe(15.00);   // cached value preserved
        expect(row.liveRateSource).toBe('AZM_ADMIN_OVERRIDE');
    });

    // ---- G. Quote snapshot ----------------------------------------------------

    test('G. a fresh TransactionQuote snapshots the TRUE external observation timestamp', async () => {
        await seedSettings({ liveRetailRate: 13.42, liveUsdToGhs: 13.10, lastExternalSync: null });

        const { getServerRateGhsPerUsdc, createServerTransactionQuote } = require('../src/services/transactionQuoteService');

        // Pre-271B historical row: no external provenance recorded → honest
        // fallback to the legacy field, never a fabricated fresh timestamp.
        const legacyTs = new Date('2026-09-01T09:15:00.000Z');
        await seedSettings({ lastExternalSync: null, lastRateSync: legacyTs });
        const legacy = await getServerRateGhsPerUsdc({ prisma });
        expect(legacy.rateGhsPerUsdc).toBe(13.42);
        expect(legacy.rateAsOf.getTime()).toBe(legacyTs.getTime());

        // A genuine external observation now exists.
        await makeOracle(12.75).fetchAndUpdateRates();
        const externalRow = await getSettings();

        const rate = await getServerRateGhsPerUsdc({ prisma });
        expect(rate.rateSource).toBe('KOTANI_PAY');
        expect(rate.rateAsOf.getTime()).toBe(externalRow.lastExternalSync.getTime());

        // And a persisted quote carries the same true timestamp.
        const user = await seedUser(prisma);
        const quote = await createServerTransactionQuote({
            prisma, userId: user.id, purpose: 'deposit', amountGhs: 134.20, feeGhs: 0, ttlSeconds: 600,
        });
        expect(new Date(quote.rateAsOf).getTime()).toBe(externalRow.lastExternalSync.getTime());
        expect(quote.rateSource).toBe('KOTANI_PAY');

        const persisted = await prisma.$queryRaw`SELECT "rateAsOf", "rateSource" FROM "TransactionQuote" WHERE "id" = ${quote.id}::uuid`;
        expect(persisted).toHaveLength(1);
        expect(new Date(persisted[0].rateAsOf).getTime()).toBe(externalRow.lastExternalSync.getTime());
        expect(persisted[0].rateSource).toBe('KOTANI_PAY');
    });

    // ---- H. API exposure -------------------------------------------------------

    test('H. /api/oracle/rates + yellowcard-rate + admin settings GET expose the new provenance additively', async () => {
        await seedSettings({
            liveRetailRate: 13.42,
            lastExternalSync: new Date('2026-09-17T10:30:00.000Z'),
            lastAdminSetAt: new Date('2026-09-17T10:35:00.000Z'),
            lastEchoAt: new Date('2026-09-17T10:40:00.000Z'),
        });

        const express = require('express');
        const request = require('supertest');
        const app = express();
        app.set('prisma', prisma);
        app.use('/api/oracle', require('../routes/oracleRoutes'));

        const ratesRes = await request(app).get('/api/oracle/rates').expect(200);
        expect(ratesRes.body.success).toBe(true);
        expect(ratesRes.body.data.lastSync).not.toBeNull();                     // compat field kept
        expect(new Date(ratesRes.body.data.lastExternalSync).toISOString()).toBe('2026-09-17T10:30:00.000Z');
        expect(new Date(ratesRes.body.data.lastAdminSetAt).toISOString()).toBe('2026-09-17T10:35:00.000Z');
        expect(new Date(ratesRes.body.data.lastEchoAt).toISOString()).toBe('2026-09-17T10:40:00.000Z');

        const yellowRes = await request(app).get('/api/oracle/yellowcard-rate').expect(200);
        expect(yellowRes.body.success).toBe(true);
        expect(yellowRes.body.lastSync).not.toBeNull();                         // compat field kept
        expect(new Date(yellowRes.body.lastExternalSync).toISOString()).toBe('2026-09-17T10:30:00.000Z');
        expect(new Date(yellowRes.body.lastAdminSetAt).toISOString()).toBe('2026-09-17T10:35:00.000Z');
        expect(new Date(yellowRes.body.lastEchoAt).toISOString()).toBe('2026-09-17T10:40:00.000Z');

        const { getSettings: adminGetSettings } = require('../controllers/adminSettingsController');
        const out = mockResponse();
        await adminGetSettings(mockRequest(), out);
        expect(out.statusCode).toBe(200);
        expect(out.payload.settings.lastRateSync).toBeDefined();                // compat field kept
        expect(new Date(out.payload.settings.lastExternalSync).toISOString()).toBe('2026-09-17T10:30:00.000Z');
        expect(new Date(out.payload.settings.lastAdminSetAt).toISOString()).toBe('2026-09-17T10:35:00.000Z');
        expect(new Date(out.payload.settings.lastEchoAt).toISOString()).toBe('2026-09-17T10:40:00.000Z');
    });

    // ---- I. Historical-null safety ---------------------------------------------

    test('I. a pre-271B row (all provenance NULL) is safe for every affected reader', async () => {
        await seedSettings({
            liveRetailRate: 13.42,
            liveUsdToGhs: 13.10,
            lastRateSync: new Date('2026-09-16T08:00:00.000Z'),
            lastExternalSync: null,
            lastAdminSetAt: null,
            lastEchoAt: null,
        });

        // Quote snapshot service must not throw; it honestly falls back to the
        // legacy field rather than fabricating a fresh timestamp.
        const { getServerRateGhsPerUsdc } = require('../src/services/transactionQuoteService');
        const rate = await getServerRateGhsPerUsdc({ prisma });
        expect(rate.rateGhsPerUsdc).toBe(13.42);
        expect(rate.rateAsOf.getTime()).toBe(new Date('2026-09-16T08:00:00.000Z').getTime());

        // Public oracle endpoints expose NULL provenance honestly.
        const express = require('express');
        const request = require('supertest');
        const app = express();
        app.set('prisma', prisma);
        app.use('/api/oracle', require('../routes/oracleRoutes'));

        const ratesRes = await request(app).get('/api/oracle/rates').expect(200);
        expect(ratesRes.body.data.lastExternalSync).toBeNull();
        expect(ratesRes.body.data.lastAdminSetAt).toBeNull();
        expect(ratesRes.body.data.lastEchoAt).toBeNull();
        expect(ratesRes.body.data.lastSync).not.toBeNull(); // legacy field still readable

        const yellowRes = await request(app).get('/api/oracle/yellowcard-rate').expect(200);
        expect(yellowRes.body.lastExternalSync).toBeNull();
        expect(yellowRes.body.lastAdminSetAt).toBeNull();
        expect(yellowRes.body.lastEchoAt).toBeNull();

        // Admin settings GET does not throw on null provenance.
        const { getSettings: adminGetSettings } = require('../controllers/adminSettingsController');
        const out = mockResponse();
        await adminGetSettings(mockRequest(), out);
        expect(out.statusCode).toBe(200);
        expect(out.payload.settings.lastExternalSync).toBeNull();

        // The MOCK echo also handles a NULL-provenance row safely.
        await makeGatewayMock().syncRatesToGlobalSettings();
        const row = await getSettings();
        expect(row.lastEchoAt).not.toBeNull();
        expect(row.lastExternalSync).toBeNull(); // echo still never fabricates freshness
    });
});
