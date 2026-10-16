// __tests__/kotani-only-rate-authority.test.js
// =============================================================================
// Kotani-only USDC/GHS transaction-rate authority (2026-10-16 hardening wave).
//
// Contract under test:
//   1. ONLY a successfully validated Kotani observation may write the
//      transaction-eligible liveRetailRate, the canonical liveRateSource and
//      the freshness timestamps (lastRateSync === lastExternalSync).
//   2. The CoinGecko USDC/USD × external USD/GHS composite is RETIRED as a
//      rate source: it can never write the canonical fields and never
//      refreshes transaction-rate freshness. Stablecoin prices remain cached
//      ONLY on their dedicated, explicitly non-authoritative display fields.
//   3. When Kotani is missing (unconfigured/MOCK), fails, returns malformed
//      data or is stale, new rate-dependent financial quotes FAIL CLOSED at
//      the 271C gate with an explicit unavailable/stale reason. A cached old
//      value must not become fresh because supplementary display APIs
//      succeeded.
//
// Structure:
//   Part 1 (unit, axios mocked at the provider boundary): the five required
//   fail-first proofs, including the oracle->gate hand-off with a simulated
//   post-sync GlobalSettings row.
//   Part 2 (real PostgreSQL, gated on TEST_DATABASE_URL): the same invariants
//   executed against the real GlobalSettings row, the real oracle writer and
//   the real quote-eligibility gate — plus the Kotani recovery path.
// =============================================================================

jest.mock('axios');

const axios = require('axios');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeDbOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[kotani-only-rate-authority] TEST_DATABASE_URL not set — skipping real-PostgreSQL block.');

const OracleService = require('../services/oracleService');
const {
    getFreshServerRateGhsPerUsdc,
    RateUnavailableError,
} = require('../src/services/transactionQuoteService');

// A 429-shaped rejection, as axios would surface from CoinGecko rate limiting.
const coingecko429 = () => {
    const err = new Error('Request failed with status code 429');
    err.response = { status: 429, data: { status: { error_code: 429 } } };
    return Promise.reject(err);
};

const KOTANI_OK = (rate = 12.75) => Promise.resolve({ data: { rate } });
const COINGECKO_OK = (usdcUsd = 0.999) =>
    Promise.resolve({ data: { tether: { usd: 1 }, 'usd-coin': { usd: usdcUsd }, dai: { usd: 1.001 } } });
const FX_OK = (ghs = 13.20) => Promise.resolve({ data: { rates: { GHS: ghs } } });

const mockPrisma = () => ({
    globalSettings: {
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
    },
});

describe('Kotani-only transaction-rate authority (unit proofs)', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv, KOTANI_PROVIDER: 'LIVE', KOTANI_API_TOKEN: 'test-token' };
        axios.get.mockReset();
        axios.post.mockReset();
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    test('1. a valid Kotani rate is canonical even when CoinGecko returns 429', async () => {
        axios.post.mockImplementation((url) => {
            expect(url).toContain('/api/v3/rate/offramp');
            return KOTANI_OK(12.75);
        });
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return coingecko429();
            throw new Error(`unexpected GET ${url}`); // the retired FX feed must never be consulted
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        expect(prisma.globalSettings.upsert).toHaveBeenCalledTimes(1);
        const { update, create } = prisma.globalSettings.upsert.mock.calls[0][0];
        for (const payload of [update, create]) {
            expect(payload.liveRetailRate).toBe(12.75);
            expect(payload.liveUsdToGhs).toBe(12.75);
            expect(payload.liveRateSource).toBe('KOTANI_PAY');
            expect(payload.lastRateSync).toBeInstanceOf(Date);
            expect(payload.lastExternalSync).toBe(payload.lastRateSync); // one observation, both fields
        }
        // CoinGecko was down: no stablecoin fields in the canonical write —
        // prior display values preserved, never fabricated.
        expect(update.liveUsdtToUsd).toBeUndefined();
        expect(update.liveUsdcToUsd).toBeUndefined();
        expect(update.liveDaiToUsd).toBeUndefined();
    });

    test('2. Kotani failure with BOTH fallback feeds healthy: no canonical write, no quote eligibility', async () => {
        axios.post.mockRejectedValue(new Error('Kotani unavailable'));
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return COINGECKO_OK(0.9985);
            if (url.includes('open.er-api.com')) return FX_OK(13.20); // healthy — and irrelevant
            throw new Error(`unexpected GET ${url}`);
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        // No canonical write of any kind.
        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
        // At most the supplementary display-only refresh.
        expect(prisma.globalSettings.update).toHaveBeenCalledTimes(1);
        const data = prisma.globalSettings.update.mock.calls[0][0].data;
        expect(Object.keys(data).sort()).toEqual(['liveDaiToUsd', 'liveUsdcToUsd', 'liveUsdtToUsd']);
        expect(data.liveUsdcToUsd).toBeCloseTo(0.9985, 10);

        // The retired FX feed was never even requested.
        const getUrls = axios.get.mock.calls.map(([url]) => String(url));
        expect(getUrls.some((url) => url.includes('open.er-api.com'))).toBe(false);

        // Quote eligibility on the post-sync state: the last genuine Kotani
        // observation is now beyond the freshness window, and the successful
        // supplementary refresh did NOT advance the clock. The gate must fail
        // closed with the explicit stale reason.
        const staleKotaniRow = {
            liveRetailRate: 13.42,
            liveUsdToGhs: 13.42,
            liveRateSource: 'KOTANI_PAY',
            // 45 minutes old — the supplementary success above must not
            // have moved this timestamp.
            lastExternalSync: new Date(Date.now() - 45 * 60 * 1000),
        };
        const gatePrisma = {
            globalSettings: { findUnique: jest.fn().mockResolvedValue(staleKotaniRow) },
        };
        await expect(
            getFreshServerRateGhsPerUsdc({ prisma: gatePrisma, maxAgeSeconds: 1800 })
        ).rejects.toMatchObject({ name: 'RateUnavailableError', code: 'RATE_STALE' });
    });

    test('3. a stale Kotani observation blocks new rate-dependent quotes (gate fails closed)', async () => {
        const row = {
            liveRetailRate: 13.42,
            liveUsdToGhs: 13.42,
            liveRateSource: 'KOTANI_PAY',
            lastExternalSync: new Date(Date.now() - 1801 * 1000), // 1801s > 1800s max
        };
        const prisma = { globalSettings: { findUnique: jest.fn().mockResolvedValue(row) } };

        await expect(
            getFreshServerRateGhsPerUsdc({ prisma, maxAgeSeconds: 1800 })
        ).rejects.toMatchObject({ name: 'RateUnavailableError', code: 'RATE_STALE' });

        // And the fresh boundary on the SAME cached value still resolves —
        // staleness (not the value itself) is what blocks the quote.
        const freshRow = { ...row, lastExternalSync: new Date(Date.now() - 60 * 1000) };
        prisma.globalSettings.findUnique.mockResolvedValue(freshRow);
        const rate = await getFreshServerRateGhsPerUsdc({ prisma, maxAgeSeconds: 1800 });
        expect(rate.rateGhsPerUsdc).toBeCloseTo(13.42, 10);
        expect(rate.rateSource).toBe('KOTANI_PAY');
        expect(rate.rateAsOf.getTime()).toBe(freshRow.lastExternalSync.getTime());
    });

    test('4. a supplementary feed update does NOT advance transaction-rate freshness', async () => {
        axios.post.mockRejectedValue(new Error('Kotani unavailable'));
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return COINGECKO_OK(0.9985);
            throw new Error(`unexpected GET ${url}`);
        });

        const prisma = mockPrisma();
        // Two consecutive syncs — repeated supplementary success must never
        // accumulate into a freshness advance.
        await new OracleService(prisma).fetchAndUpdateRates();
        await new OracleService(prisma).fetchAndUpdateRates();

        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
        expect(prisma.globalSettings.update).toHaveBeenCalledTimes(2);
        for (const call of prisma.globalSettings.update.mock.calls) {
            const data = call[0].data;
            // The display-only payload can never carry a canonical key.
            expect(Object.keys(data).sort()).toEqual(['liveDaiToUsd', 'liveUsdcToUsd', 'liveUsdtToUsd']);
            expect(data.lastExternalSync).toBeUndefined();
            expect(data.lastRateSync).toBeUndefined();
            expect(data.liveRetailRate).toBeUndefined();
            expect(data.liveRateSource).toBeUndefined();
        }
    });

    test('5. the documented Kotani response shapes still parse (existing contract regression)', () => {
        // Restates the long-standing extractKotaniRate response-shape
        // contract — it must remain green under the Kotani-only authority.
        expect(OracleService.extractKotaniRate({ rate: '12.34' })).toBe(12.34);
        expect(OracleService.extractKotaniRate({ exchangeRate: 13.21 })).toBe(13.21);
        expect(OracleService.extractKotaniRate({ data: { rate: '12.05' } })).toBe(12.05);
        expect(OracleService.extractKotaniRate({ data: { exchangeRate: 12.9 } })).toBe(12.9);
        expect(OracleService.extractKotaniRate({ result: { rate: 12.5 } })).toBe(12.5);
        expect(OracleService.extractKotaniRate({ cryptoAmount: 2, fiatAmount: 24.8 })).toBe(12.4);
        // Malformed / unusable observations are rejected — never guessed.
        expect(OracleService.extractKotaniRate({})).toBeNull();
        expect(OracleService.extractKotaniRate({ rate: -1 })).toBeNull();
        expect(OracleService.extractKotaniRate({ rate: 'not-a-number' })).toBeNull();
    });

    test('a malformed Kotani response fails closed exactly like an outage (no canonical write)', async () => {
        axios.post.mockResolvedValue({ data: { unexpected: 'shape' } }); // no usable rate field
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return COINGECKO_OK();
            throw new Error(`unexpected GET ${url}`);
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
        expect(prisma.globalSettings.update).toHaveBeenCalledTimes(1);
    });

    test('unconfigured (MOCK) Kotani mode performs no canonical write — Kotani missing means no rate', async () => {
        delete process.env.KOTANI_PROVIDER; // default MOCK — credentials not yet obtained
        delete process.env.KOTANI_API_TOKEN;
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return COINGECKO_OK();
            throw new Error(`unexpected GET ${url}`);
        });
        axios.post.mockImplementation(() => Promise.reject(new Error('must not be called')));

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        expect(axios.post).not.toHaveBeenCalled();
        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
        expect(prisma.globalSettings.update).toHaveBeenCalledTimes(1);
    });

    test('RateUnavailableError is exported with its typed codes for explicit fail-closed reasons', () => {
        expect(RateUnavailableError).toBeDefined();
        const err = new RateUnavailableError('msg', 'RATE_STALE');
        expect(err.code).toBe('RATE_STALE');
        expect(err.statusCode).toBe(503);
    });
});

// =============================================================================
// Part 2 — real PostgreSQL proofs
// =============================================================================
describeDbOrSkip('Kotani-only transaction-rate authority (real PostgreSQL)', () => {
    let prisma;

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    const getSettings = () => prisma.globalSettings.findUnique({ where: { id: 1 } });

    async function seedKotaniRow(overrides = {}) {
        const base = {
            liveUsdToGhs: 13.10,
            liveRetailRate: 13.42,
            liveCorporateRate: 13.22,
            liveRateSource: 'KOTANI_PAY',
            liveUsdtToUsd: 1.0,
            liveUsdcToUsd: 1.0,
            liveDaiToUsd: 1.0,
            lastRateSync: new Date('2026-10-16T10:00:00.000Z'),
            lastExternalSync: new Date('2026-10-16T10:00:00.000Z'),
            lastAdminSetAt: null,
            lastEchoAt: null,
        };
        const data = { ...base, ...overrides };
        await prisma.globalSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
        return getSettings();
    }

    const kotaniDown = () => {
        axios.get.mockReset();
        axios.post.mockReset();
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return COINGECKO_OK(0.9985);
            if (url.includes('open.er-api.com')) return FX_OK(13.20); // healthy, must be ignored
            throw new Error(`unexpected GET ${url}`);
        });
        axios.post.mockRejectedValue(new Error('kotani down'));
        process.env.KOTANI_PROVIDER = 'LIVE';
        process.env.KOTANI_API_TOKEN = 'test-token';
    };

    test('DB-1: Kotani outage with healthy supplementary feeds leaves the canonical row byte-identical; quotes fail closed', async () => {
        const staleTs = new Date(Date.now() - 45 * 60 * 1000); // beyond the 1800s window
        await seedKotaniRow({ lastRateSync: staleTs, lastExternalSync: staleTs });
        const before = await getSettings();

        kotaniDown();
        await new OracleService(prisma).fetchAndUpdateRates();

        const after = await getSettings();
        // Canonical fields untouched.
        expect(Number(after.liveRetailRate)).toBe(Number(before.liveRetailRate));
        expect(Number(after.liveUsdToGhs)).toBe(Number(before.liveUsdToGhs));
        expect(after.liveRateSource).toBe('KOTANI_PAY');
        expect(after.lastExternalSync.getTime()).toBe(staleTs.getTime());
        expect(after.lastRateSync.getTime()).toBe(staleTs.getTime());
        // Supplementary display data DID refresh (non-authoritative).
        expect(Number(after.liveUsdcToUsd)).toBeCloseTo(0.9985, 6);

        // The real gate fails closed on the stale row despite the fresh
        // supplementary display data.
        await expect(
            getFreshServerRateGhsPerUsdc({ prisma, maxAgeSeconds: 1800 })
        ).rejects.toMatchObject({ name: 'RateUnavailableError', code: 'RATE_STALE' });
    });

    test('DB-2: a fresh Kotani observation is the only thing that restores quote eligibility', async () => {
        const staleTs = new Date(Date.now() - 45 * 60 * 1000);
        await seedKotaniRow({ lastRateSync: staleTs, lastExternalSync: staleTs });

        axios.get.mockReset();
        axios.post.mockReset();
        axios.post.mockImplementation((url) => {
            expect(url).toContain('/api/v3/rate/offramp');
            return KOTANI_OK(12.75);
        });
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return COINGECKO_OK(0.999);
            throw new Error(`unexpected GET ${url}`);
        });
        process.env.KOTANI_PROVIDER = 'LIVE';
        process.env.KOTANI_API_TOKEN = 'test-token';

        await new OracleService(prisma).fetchAndUpdateRates();

        const row = await getSettings();
        expect(Number(row.liveRetailRate)).toBeCloseTo(12.75, 8);
        expect(row.liveRateSource).toBe('KOTANI_PAY');
        expect(row.lastRateSync.getTime()).toBe(row.lastExternalSync.getTime());
        expect(row.lastExternalSync.getTime()).toBeGreaterThan(staleTs.getTime());

        const rate = await getFreshServerRateGhsPerUsdc({ prisma, maxAgeSeconds: 1800 });
        expect(rate.rateGhsPerUsdc).toBeCloseTo(12.75, 8);
        expect(rate.rateSource).toBe('KOTANI_PAY');
        expect(rate.rateAsOf.getTime()).toBe(row.lastExternalSync.getTime());
    });

    test('DB-3: repeated Kotani outages never advance freshness — the clock only moves on a real Kotani observation', async () => {
        const staleTs = new Date(Date.now() - 45 * 60 * 1000);
        await seedKotaniRow({ lastRateSync: staleTs, lastExternalSync: staleTs });

        kotaniDown();
        await new OracleService(prisma).fetchAndUpdateRates();
        await new OracleService(prisma).fetchAndUpdateRates();

        const row = await getSettings();
        expect(row.lastExternalSync.getTime()).toBe(staleTs.getTime());
        expect(row.lastRateSync.getTime()).toBe(staleTs.getTime());
        await expect(
            getFreshServerRateGhsPerUsdc({ prisma, maxAgeSeconds: 1800 })
        ).rejects.toMatchObject({ code: 'RATE_STALE' });
    });
});
