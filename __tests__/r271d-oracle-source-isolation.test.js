// __tests__/r271d-oracle-source-isolation.test.js
// =============================================================================
// §271 oracle per-source isolation (issue #271 recommendation D) — unit proof.
//
// The oracle composes THREE independent external sources. Failure isolation
// is a hard contract:
//
//   Kotani (direct USDC/GHS)  — canonical; success writes KOTANI_PAY.
//   CoinGecko (stablecoin USD) — supplementary; failure NEVER blocks the
//                                canonical write (Kotani path), and alone it
//                                can NEVER produce a retail write.
//   open.er-api (USD/GHS FX)  — fallback leg of the composite; quotes USD,
//                                never USDC — the raw FX rate must NEVER
//                                reach liveRetailRate (a depeg would
//                                misprice every USDC conversion).
//
// Consequences proven:
//   A. Kotani success + CoinGecko failure → write proceeds (KOTANI_PAY),
//      stablecoin fields preserved (absent from the update).
//   B. Kotani failure + both composite legs succeed → FALLBACK_FX write
//      with retail = FX × USDC/USD (USDC/GHS, never raw USD/GHS).
//   C. Any PARTIAL composite (only one leg usable) writes NOTHING — the
//      cached rate and every freshness timestamp stay untouched.
//   D. Total failure writes NOTHING.
//   E. Every successful write stamps lastRateSync === lastExternalSync
//      (one observation, both freshness fields — the 271B contract).
//
// axios is mocked at the provider boundary; the prisma upsert is a jest spy
// (the DB-level writer contracts live in rate-provenance-truthfulness.test.js).
// =============================================================================

const axios = require('axios');
const OracleService = require('../services/oracleService');

jest.mock('axios');

describe('271D oracle per-source isolation', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv, KOTANI_PROVIDER: 'LIVE', KOTANI_API_TOKEN: 'test-token' };
        axios.get.mockReset();
        axios.post.mockReset();
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    const mockPrisma = () => ({
        globalSettings: { upsert: jest.fn().mockResolvedValue({}) },
    });

    const COINGECKO_OK = () =>
        Promise.resolve({ data: { tether: { usd: 1 }, 'usd-coin': { usd: 0.999 }, dai: { usd: 1.001 } } });
    const FX_OK = (ghs = 12.50) => Promise.resolve({ data: { rates: { GHS: ghs } } });
    const KOTANI_OK = (rate = 12.75) => Promise.resolve({ data: { rate } });

    test('A: Kotani success + CoinGecko failure still writes the canonical observation', async () => {
        axios.post.mockImplementation((url) => {
            if (url.includes('/api/v3/rate/offramp')) return KOTANI_OK(12.75);
            throw new Error(`unexpected POST ${url}`);
        });
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return Promise.reject(new Error('coingecko down'));
            throw new Error(`unexpected GET ${url}`); // FX must not even be consulted
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        expect(prisma.globalSettings.upsert).toHaveBeenCalledTimes(1);
        const update = prisma.globalSettings.upsert.mock.calls[0][0].update;
        expect(update.liveRetailRate).toBe(12.75);
        expect(update.liveRateSource).toBe('KOTANI_PAY');
        // Supplementary source failed: the stablecoin fields are ABSENT from
        // the update — prior values preserved, never clobbered or fabricated.
        expect(update.liveUsdtToUsd).toBeUndefined();
        expect(update.liveUsdcToUsd).toBeUndefined();
        expect(update.liveDaiToUsd).toBeUndefined();
    });

    test('B: Kotani failure + both composite legs succeed writes FALLBACK_FX as USDC/GHS (never raw USD/GHS)', async () => {
        axios.post.mockImplementation((url) => {
            if (url.includes('/api/v3/rate/offramp')) return Promise.reject(new Error('kotani down'));
            throw new Error(`unexpected POST ${url}`);
        });
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return COINGECKO_OK();
            if (url.includes('open.er-api.com')) return FX_OK(12.50);
            throw new Error(`unexpected GET ${url}`);
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        expect(prisma.globalSettings.upsert).toHaveBeenCalledTimes(1);
        const update = prisma.globalSettings.upsert.mock.calls[0][0].update;
        expect(update.liveRateSource).toBe('FALLBACK_FX');
        // retail = FX(USD/GHS) × USDC/USD — a USDC/GHS observation
        expect(update.liveRetailRate).toBeCloseTo(12.50 * 0.999, 10);
        // the legacy USD/GHS field carries the raw FX quote for API consumers
        expect(update.liveUsdToGhs).toBe(12.50);
        // never the raw FX quote on the retail field
        expect(update.liveRetailRate).not.toBe(12.50);
        // composite write carries the stablecoin observations
        expect(update.liveUsdcToUsd).toBeCloseTo(0.999, 10);
    });

    test('C1: partial composite (CoinGecko down, FX up) writes NOTHING', async () => {
        axios.post.mockRejectedValue(new Error('kotani down'));
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return Promise.reject(new Error('coingecko down'));
            if (url.includes('open.er-api.com')) return FX_OK(12.50);
            throw new Error(`unexpected GET ${url}`);
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        // Raw USD/GHS alone is NOT a retail observation — nothing is written,
        // the cached rate and every freshness timestamp stay untouched.
        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
    });

    test('C2: partial composite (FX down, CoinGecko up) writes NOTHING', async () => {
        axios.post.mockRejectedValue(new Error('kotani down'));
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return COINGECKO_OK();
            if (url.includes('open.er-api.com')) return Promise.reject(new Error('fx down'));
            throw new Error(`unexpected GET ${url}`);
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
    });

    test('C3: a zero USDC/USD price is an incomplete composite — NOTHING is written', async () => {
        axios.post.mockRejectedValue(new Error('kotani down'));
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) {
                return Promise.resolve({ data: { tether: { usd: 1 }, 'usd-coin': { usd: 0 }, dai: { usd: 1 } } });
            }
            if (url.includes('open.er-api.com')) return FX_OK(12.50);
            throw new Error(`unexpected GET ${url}`);
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        // A depeg-shaped observation must never multiply into liveRetailRate.
        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
    });

    test('D: total external failure writes NOTHING (cached rate + timestamps preserved)', async () => {
        axios.post.mockRejectedValue(new Error('kotani down'));
        axios.get.mockRejectedValue(new Error('all providers down'));

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
    });

    test('E: every successful write stamps lastRateSync === lastExternalSync (one observation)', async () => {
        axios.post.mockImplementation((url) => {
            if (url.includes('/api/v3/rate/offramp')) return KOTANI_OK(12.75);
            throw new Error(`unexpected POST ${url}`);
        });
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return COINGECKO_OK();
            throw new Error(`unexpected GET ${url}`);
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        const update = prisma.globalSettings.upsert.mock.calls[0][0].update;
        expect(update.lastRateSync).toBeInstanceOf(Date);
        expect(update.lastExternalSync).toBe(update.lastRateSync);
    });
});
