// __tests__/r271d-oracle-source-isolation.test.js
// =============================================================================
// §271 oracle per-source isolation (issue #271 recommendation D) — unit proof.
//
// The oracle composes THREE independent external sources. Failure isolation
// is a hard contract:
//
//   Kotani (direct USDC/GHS)  — the ONLY canonical transaction-rate source;
//                                success writes KOTANI_PAY.
//   CoinGecko (stablecoin USD) — supplementary DISPLAY-ONLY; failure NEVER
//                                blocks the canonical write (Kotani path),
//                                and alone it can NEVER produce a retail
//                                write or refresh any freshness timestamp.
//   open.er-api (USD/GHS FX)  — RETIRED. The FX × CoinGecko composite is
//                                no longer consulted at all: it must never
//                                write liveRetailRate/liveRateSource or
//                                refresh canonical freshness.
//
// Consequences proven (Kotani-only authority, 2026-10-16 hardening wave):
//   A. Kotani success + CoinGecko failure → canonical write proceeds
//      (KOTANI_PAY), stablecoin fields preserved (absent from the update).
//   B. Kotani failure + supplementary feeds succeeding → NO canonical
//      write; at most a stablecoin DISPLAY-ONLY update whose keys can
//      never touch liveRetailRate / liveRateSource / freshness.
//   C. Any supplementary failure → NOTHING is written at all.
//   D. Total failure writes NOTHING.
//   E. Every successful canonical write stamps
//      lastRateSync === lastExternalSync (one observation, both freshness
//      fields — the 271B contract).
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
        globalSettings: {
            upsert: jest.fn().mockResolvedValue({}),
            update: jest.fn().mockResolvedValue({}),
        },
    });

    const COINGECKO_OK = () =>
        Promise.resolve({ data: { tether: { usd: 1 }, 'usd-coin': { usd: 0.999 }, dai: { usd: 1.001 } } });
    // Documented v3 envelope (https://documentation.kotanipay.com/v3/api-reference/rates/offramp-rate):
// { success: true, data: { from, to, value: "<rate>", ... } }. Every mock
// below uses this exact shape so the tests mirror what Kotani actually sends.
const KOTANI_OK = (rate = 12.75, from = 'USDC', to = 'GHS') => Promise.resolve({
    data: { success: true, data: { from, to, value: String(rate) } },
});

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

    test('B: Kotani failure + supplementary feeds succeeding writes NO canonical rate — display-only update only', async () => {
        axios.post.mockImplementation((url) => {
            if (url.includes('/api/v3/rate/offramp')) return Promise.reject(new Error('kotani down'));
            throw new Error(`unexpected POST ${url}`);
        });
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return COINGECKO_OK();
            // The retired FX composite must never even be consulted.
            throw new Error(`unexpected GET ${url}`);
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        // NO canonical write of any kind — the cached rate, its source and
        // every freshness timestamp stay untouched.
        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
        // The stablecoin observations land ONLY on the dedicated
        // display-only fields — the update payload can never touch
        // liveRetailRate / liveUsdToGhs / liveRateSource / timestamps.
        expect(prisma.globalSettings.update).toHaveBeenCalledTimes(1);
        const data = prisma.globalSettings.update.mock.calls[0][0].data;
        expect(Object.keys(data).sort()).toEqual(['liveDaiToUsd', 'liveUsdcToUsd', 'liveUsdtToUsd']);
        expect(data.liveUsdcToUsd).toBeCloseTo(0.999, 10);
        expect(prisma.globalSettings.update.mock.calls[0][0].where).toEqual({ id: 1 });
    });

    test('C1: supplementary failure (CoinGecko down) writes NOTHING at all', async () => {
        axios.post.mockRejectedValue(new Error('kotani down'));
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return Promise.reject(new Error('coingecko down'));
            throw new Error(`unexpected GET ${url}`);
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        // No Kotani observation and no supplementary observation — nothing
        // is written; the cached rate and every freshness timestamp stay
        // untouched.
        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
        expect(prisma.globalSettings.update).not.toHaveBeenCalled();
    });

    test('C2: Kotani failure + CoinGecko success — display-only update, and the retired FX feed is never consulted', async () => {
        axios.post.mockRejectedValue(new Error('kotani down'));
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return COINGECKO_OK();
            throw new Error(`unexpected GET ${url}`);
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
        // Stablecoin display fields still refresh (supplementary,
        // non-authoritative), with no canonical keys in the payload.
        expect(prisma.globalSettings.update).toHaveBeenCalledTimes(1);
        const data = prisma.globalSettings.update.mock.calls[0][0].data;
        expect(Object.keys(data).sort()).toEqual(['liveDaiToUsd', 'liveUsdcToUsd', 'liveUsdtToUsd']);
        // The retired FX feed was never even requested.
        const getUrls = axios.get.mock.calls.map(([url]) => String(url));
        expect(getUrls.some((url) => url.includes('open.er-api.com'))).toBe(false);
    });

    test('C3: a malformed stablecoin observation (zero USDC/USD) writes NOTHING', async () => {
        axios.post.mockRejectedValue(new Error('kotani down'));
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) {
                return Promise.resolve({ data: { tether: { usd: 1 }, 'usd-coin': { usd: 0 }, dai: { usd: 1 } } });
            }
            throw new Error(`unexpected GET ${url}`);
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        // A malformed supplementary observation is discarded entirely.
        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
        expect(prisma.globalSettings.update).not.toHaveBeenCalled();
    });

    test('D: total external failure writes NOTHING (cached rate + timestamps preserved)', async () => {
        axios.post.mockRejectedValue(new Error('kotani down'));
        axios.get.mockRejectedValue(new Error('all providers down'));

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
        expect(prisma.globalSettings.update).not.toHaveBeenCalled();
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
