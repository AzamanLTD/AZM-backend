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

// Documented v3 envelope (https://documentation.kotanipay.com/v3/api-reference/rates/offramp-rate):
// { success: true, data: { from, to, value: "<rate>", ... } }. Every mock
// below uses this exact shape so the tests mirror what Kotani actually sends.
const KOTANI_OK = (rate = 12.75, from = 'USDC', to = 'GHS') => Promise.resolve({
    data: { success: true, data: { from, to, value: String(rate) } },
});
const COINGECKO_OK = (usdcUsd = 0.999) =>
    Promise.resolve({ data: { tether: { usd: 1 }, 'usd-coin': { usd: usdcUsd }, dai: { usd: 1.001 } } });
const FX_OK = (ghs = 13.20) => Promise.resolve({ data: { rates: { GHS: ghs } } });

const mockPrisma = () => ({
    globalSettings: {
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
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
            // B fix: the legacy USD/GHS field is never populated with the
            // USDC/GHS observation.
            expect(payload.liveUsdToGhs).toBeUndefined();
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

    // ── A2 HARDENING (2026-10-17): documented v3 envelope, fail-closed
    // pair validation, and the correct fiat payout code. Docs:
    // https://documentation.kotanipay.com/v3/api-reference/rates/offramp-rate

    test('A2-a. extractKotaniRate parses the DOCUMENTED v3 envelope (data.value as a string)', () => {
        const v3 = { success: true, message: 'Available exchange rate.',
            data: { from: 'USDC', to: 'GHS', value: '15.53', fiatAmount: 15.53, cryptoAmount: 1 } };
        expect(OracleService.extractKotaniRate(v3)).toBe(15.53);
        // success:false with a payload is still a failure — fail closed.
        expect(OracleService.extractKotaniRate({ success: false, message: 'Invalid API Key', data: {} })).toBeNull();
        expect(OracleService.extractKotaniRate({ success: false, data: { value: '15.53' } })).toBeNull();
    });

    test('A2-b. kotaniPairMatches validates the echoed pair EXACTLY — no C-prefix equivalence (fix C)', () => {
        const echo = (from, to) => ({ success: true, data: { from, to, value: '1' } });
        expect(OracleService.kotaniPairMatches(echo('USDC', 'GHS'), 'USDC', 'GHS')).toBe(true);
        // Exact match is case-insensitive and trimmed only.
        expect(OracleService.kotaniPairMatches(echo(' usdc ', 'ghs'), 'USDC', 'GHS')).toBe(true);
        // CGHS is a DIFFERENT instrument: a stablecoin listed in the
        // provider `from` enum, not the fiat code for a cedi offramp.
        // Related codes are NOT the same instrument — a CGHS echo for a GHS
        // request must be rejected (fix C: no "equivalent code" laundering).
        expect(OracleService.kotaniPairMatches(echo('USDC', 'CGHS'), 'USDC', 'GHS')).toBe(false);
        expect(OracleService.kotaniPairMatches(echo('USDC', 'GHS'), 'USDC', 'CGHS')).toBe(false);
        expect(OracleService.kotaniPairMatches(echo('USDC', 'KES'), 'USDC', 'GHS')).toBe(false);
        expect(OracleService.kotaniPairMatches(echo('USDT', 'GHS'), 'USDC', 'GHS')).toBe(false);
        // A response with no pair echo at all is an unvalidated observation.
        expect(OracleService.kotaniPairMatches({ data: { value: '15.53' } }, 'USDC', 'GHS')).toBe(false);
        expect(OracleService.kotaniPairMatches({}, 'USDC', 'GHS')).toBe(false);
    });

    test('A2-c. the fetch request uses the documented fiat payout code (to=GHS, POST body)', async () => {
        let seenBody = null;
        axios.post.mockImplementation((url, body) => {
            expect(url).toContain('/api/v3/rate/offramp');
            seenBody = body;
            return KOTANI_OK(12.75);
        });
        axios.get.mockImplementation(() => Promise.reject(new Error('unexpected GET')));

        await new OracleService(mockPrisma()).fetchAndUpdateRates();

        expect(seenBody).toEqual({ from: 'USDC', to: 'GHS', cryptoAmount: 1 });
    });

    test('A2-d. a foreign-pair echo fails closed with a distinct, greppable error — no canonical write', async () => {
        axios.post.mockResolvedValue({ data: {
            success: true, data: { from: 'USDC', to: 'KES', value: '129.47' },
        } });
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return COINGECKO_OK();
            throw new Error(`unexpected GET ${url}`);
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
    });

    test('A2-e. success:false fails closed with KOTANI_RATE_REJECTED — no canonical write', async () => {
        axios.post.mockResolvedValue({ data: { success: false, message: 'Invalid API Key', data: {} } });
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return COINGECKO_OK();
            throw new Error(`unexpected GET ${url}`);
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
    });

    test('A2-f. an envelope with NO success declaration fails closed too (fix D: explicit success required)', async () => {
        // A payload that merely contains a rate but never declares success
        // is not the documented v3 response — treat it as unvalidated.
        axios.post.mockResolvedValue({ data: { data: { from: 'USDC', to: 'GHS', value: '15.53' } } });
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return COINGECKO_OK();
            throw new Error(`unexpected GET ${url}`);
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
    });

    test('B-unit-1. a successful canonical write NEVER touches the legacy liveUsdToGhs field (fix B)', async () => {
        axios.post.mockImplementation(() => KOTANI_OK(12.75));
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return COINGECKO_OK(0.999);
            throw new Error(`unexpected GET ${url}`);
        });

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        expect(prisma.globalSettings.upsert).toHaveBeenCalledTimes(1);
        const payload = prisma.globalSettings.upsert.mock.calls[0][0];
        expect(payload.update).toEqual(expect.objectContaining({
            liveRetailRate: 12.75,
            liveRateSource: 'KOTANI_PAY',
        }));
        expect(payload.update).not.toHaveProperty('liveUsdToGhs');
        expect(payload.create).not.toHaveProperty('liveUsdToGhs');
    });

    test('B-unit-2. the gateway MOCK anchor derives from the canonical liveRetailRate, never the legacy field (fix B)', async () => {
        const GatewayService = require('../services/gatewayService');
        process.env.KOTANI_PROVIDER = 'MOCK';
        delete process.env.KOTANI_API_KEY;
        const prisma = mockPrisma();
        prisma.globalSettings.findUnique.mockResolvedValue({
            liveRetailRate: 14.10,
            liveUsdToGhs: 11.02, // deliberately different legacy value
        });

        const rates = await new GatewayService(prisma).fetchOfframpRates();

        expect(rates.source).toBe('MOCK');
        expect(rates.retailRate).toBeCloseTo(14.10, 6);
        expect(rates.retailRate).not.toBeCloseTo(11.02, 6);
    });

    // ── A3 HARDENING (2026-10-17): gateway LIVE fetch uses the documented
    // POST + v3 envelope and FAILS CLOSED (null, never a MOCK fallback).

    test('A3-a. gateway LIVE fetch: documented POST body + v3 envelope; one rate, spread 0', async () => {
        const GatewayService = require('../services/gatewayService');
        process.env.KOTANI_PROVIDER = 'LIVE';
        process.env.KOTANI_API_KEY = 'test-key';
        axios.post.mockImplementation((url, body) => {
            expect(url).toContain('/api/v3/rate/offramp');
            expect(body).toEqual({ from: 'USDC', to: 'GHS', cryptoAmount: 1 });
            return Promise.resolve({ data: {
                success: true, data: { from: 'USDC', to: 'GHS', value: '12.90' },
            } });
        });

        const rates = await new GatewayService(mockPrisma()).fetchOfframpRates();

        expect(rates.source).toBe('LIVE');
        expect(rates.retailRate).toBe(12.90);
        expect(rates.corporateRate).toBe(12.90);
        expect(rates.spread).toBe(0); // no fabricated corporate spread from a one-rate envelope
        delete process.env.KOTANI_API_KEY;
    });

    test('A3-b. gateway LIVE failure FAILS CLOSED: null, never a silent MOCK fallback rate', async () => {
        const GatewayService = require('../services/gatewayService');
        process.env.KOTANI_PROVIDER = 'LIVE';
        process.env.KOTANI_API_KEY = 'test-key';
        axios.post.mockRejectedValue(new Error('kotani LIVE outage'));

        const rates = await new GatewayService(mockPrisma()).fetchOfframpRates();

        expect(rates).toBeNull(); // the war-room OTC quote 503s instead of trading at a MOCK rate
        delete process.env.KOTANI_API_KEY;
    });

    test('A3-c. gateway LIVE fetch with a foreign pair or success:false also fails closed', async () => {
        const GatewayService = require('../services/gatewayService');
        process.env.KOTANI_PROVIDER = 'LIVE';
        process.env.KOTANI_API_KEY = 'test-key';
        axios.post.mockResolvedValue({ data: {
            success: true, data: { from: 'USDC', to: 'KES', value: '129.47' },
        } });
        expect(await new GatewayService(mockPrisma()).fetchOfframpRates()).toBeNull();

        axios.post.mockResolvedValue({ data: { success: false, message: 'Invalid API Key', data: {} } });
        expect(await new GatewayService(mockPrisma()).fetchOfframpRates()).toBeNull();
        delete process.env.KOTANI_API_KEY;
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
// ── SANDBOX-FALLBACK HARDENING (review follow-up) ─────────────────────────
//
// The two ways a deployment can end up WITHOUT a working Kotani source
// must be distinguishable at a glance, and the default-sandbox endpoint
// must be visible, never silent:
//   Risk A — KOTANI_PROVIDER != LIVE (or a placeholder token) disables the
//     canonical source BY CONFIGURATION. That state must be named loudly
//     at startup and tagged differently from a LIVE outage, because it is
//     a deployment mistake, not a provider incident.
//   Risk B — the DEFAULT base URL is the SANDBOX endpoint. A LIVE provider
//     with KOTANI_API_BASE_URL unset must surface that it is running
//     against the default sandbox endpoint (legitimate during onboarding,
//     but explicit, never silent).
describe('Kotani config audit — sandbox-fallback hardening (unit)', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.KOTANI_PROVIDER;
        delete process.env.KOTANI_API_TOKEN;
        delete process.env.KOTANI_API_KEY;
        delete process.env.KOTANI_API_BASE_URL;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    test('A1. provider not LIVE: DISABLED BY CONFIGURATION, audit names the env to set', () => {
        process.env.KOTANI_PROVIDER = 'MOCK';
        const cfg = new OracleService(mockPrisma()).kotaniConfigState();
        expect(cfg.armed).toBe(false);
        expect(cfg.state).toBe('CONFIG_DISABLED');
        expect(cfg.detail).toContain('KOTANI_PROVIDER');
        expect(cfg.detail).toContain('DISABLED BY CONFIGURATION');
    });

    test('A2. unset provider defaults to MOCK and is CONFIG_DISABLED too', () => {
        const cfg = new OracleService(mockPrisma()).kotaniConfigState();
        expect(cfg.armed).toBe(false);
        expect(cfg.state).toBe('CONFIG_DISABLED');
    });

    test('A3. LIVE provider with a missing or placeholder token: MISSING_TOKEN, not armed', () => {
        process.env.KOTANI_PROVIDER = 'LIVE';
        const missing = new OracleService(mockPrisma()).kotaniConfigState();
        expect(missing.armed).toBe(false);
        expect(missing.state).toBe('MISSING_TOKEN');

        process.env.KOTANI_API_TOKEN = 'mock-key';
        const placeholder = new OracleService(mockPrisma()).kotaniConfigState();
        expect(placeholder.armed).toBe(false);
        expect(placeholder.state).toBe('MISSING_TOKEN');
    });

    test('B1. LIVE + token but NO base URL OUTSIDE production: armed for ONBOARDING on the default sandbox, loudly named', () => {
        // Jest runs with NODE_ENV=test — the non-production branch.
        process.env.KOTANI_PROVIDER = 'LIVE';
        process.env.KOTANI_API_TOKEN = 'onboarding-token';
        const cfg = new OracleService(mockPrisma()).kotaniConfigState();
        expect(cfg.armed).toBe(true);
        expect(cfg.state).toBe('ARMED_ONBOARDING_SANDBOX');
        expect(cfg.baseUrlExplicit).toBe(false);
        expect(cfg.baseUrl).toBe('https://sandbox-api.kotanipay.io/api/v3');
        expect(cfg.detail).toContain('ONBOARDING SANDBOX');
    });

    test('B2. LIVE + token + explicit base URL: armed, explicit, no sandbox mention', () => {
        process.env.KOTANI_PROVIDER = 'LIVE';
        process.env.KOTANI_API_TOKEN = 'onboarding-token';
        process.env.KOTANI_API_BASE_URL = 'https://api.kotanipay.io/api/v3/';
        const cfg = new OracleService(mockPrisma()).kotaniConfigState();
        expect(cfg.armed).toBe(true);
        expect(cfg.baseUrlExplicit).toBe(true);
        expect(cfg.baseUrl).toBe('https://api.kotanipay.io/api/v3'); // trailing slash stripped
        expect(cfg.detail).not.toContain('SANDBOX');
    });

    test('C1. a DISABLED deployment makes NO Kotani request and the fail-closed path still writes nothing canonical', async () => {
        process.env.KOTANI_PROVIDER = 'MOCK';
        axios.post.mockReset();
        axios.get.mockReset();

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        expect(axios.post).not.toHaveBeenCalled(); // no Kotani attempt
        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled(); // no canonical write
        // At most the supplementary display refresh (its own axios calls
        // may or may not succeed — irrelevant to the canonical contract).
    });
});

describe('Production endpoint policy — a sandbox endpoint can never be the production rate source (fix A)', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        process.env.NODE_ENV = 'production';
        process.env.KOTANI_PROVIDER = 'LIVE';
        process.env.KOTANI_API_TOKEN = 'real-prod-token';
        delete process.env.KOTANI_API_BASE_URL;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    test('P1. LIVE + token but NO endpoint in production: NOT armed — the sandbox default is not a production source', () => {
        const cfg = new OracleService(mockPrisma()).kotaniConfigState();
        expect(cfg.armed).toBe(false);
        expect(cfg.state).toBe('MISSING_ENDPOINT');
        expect(cfg.baseUrl).toBeNull();
        expect(cfg.detail).toContain('FAILS CLOSED');
    });

    test('P2. an EXPLICIT sandbox endpoint in production: rejected by policy, NOT armed', () => {
        process.env.KOTANI_API_BASE_URL = 'https://sandbox-api.kotanipay.io/api/v3';
        const cfg = new OracleService(mockPrisma()).kotaniConfigState();
        expect(cfg.armed).toBe(false);
        expect(cfg.state).toBe('SANDBOX_ENDPOINT_REJECTED');
        expect(cfg.baseUrl).toBeNull();
        expect(cfg.detail).toContain('REJECTED BY POLICY');
    });

    test('P2-b. sandbox-shaped hosts in other spellings are rejected too', () => {
        process.env.KOTANI_API_BASE_URL = 'https://sandbox.kotanipay.io/api/v3';
        expect(new OracleService(mockPrisma()).kotaniConfigState().state).toBe('SANDBOX_ENDPOINT_REJECTED');
        process.env.KOTANI_API_BASE_URL = 'https://api.kotanipay.io/sandbox/api/v3';
        expect(new OracleService(mockPrisma()).kotaniConfigState().state).toBe('SANDBOX_ENDPOINT_REJECTED');
    });

    // §1 (review follow-up 2026-10-18): an explicit production endpoint is
    // necessary but NOT sufficient. Production arming additionally requires
    // an https:// endpoint on a host Kotani has verified at onboarding. The
    // allowlist ships EMPTY, so production fails CLOSED for every host
    // until the verified hostname is added in services/oracleService.js.
    test('P3. an explicit production endpoint NOT on the verified host allowlist: NOT armed (fail-closed until onboarding)', () => {
        process.env.KOTANI_API_BASE_URL = 'https://api.kotanipay.io/api/v3';
        const cfg = new OracleService(mockPrisma()).kotaniConfigState();
        expect(cfg.armed).toBe(false);
        expect(cfg.state).toBe('UNVERIFIED_PRODUCTION_HOST');
        expect(cfg.baseUrl).toBeNull();
        expect(cfg.detail).toContain('verified production host allowlist');
        expect(cfg.detail).toContain('fails CLOSED');
    });

    test('P3-b. a NON-HTTPS endpoint in production is rejected by policy even when not a sandbox host', () => {
        process.env.KOTANI_API_BASE_URL = 'http://api.kotanipay.io/api/v3';
        const cfg = new OracleService(mockPrisma()).kotaniConfigState();
        expect(cfg.armed).toBe(false);
        expect(cfg.state).toBe('NON_HTTPS_ENDPOINT_REJECTED');
        expect(cfg.detail).toContain('NOT an https:// endpoint');
    });

    test('P3-c. an unparseable endpoint URL in production is rejected by policy', () => {
        process.env.KOTANI_API_BASE_URL = 'not-a-url';
        const cfg = new OracleService(mockPrisma()).kotaniConfigState();
        expect(cfg.armed).toBe(false);
        expect(cfg.state).toBe('INVALID_ENDPOINT');
    });

    test('P3-d. a host ON the verified allowlist over https: armed (simulated onboarding confirmation)', () => {
        const { KOTANI_VERIFIED_PRODUCTION_HOSTS } = require('../services/oracleService');
        const len = KOTANI_VERIFIED_PRODUCTION_HOSTS.length;
        KOTANI_VERIFIED_PRODUCTION_HOSTS.push('api.kotanipay.io'); // simulate the onboarding-verified host
        try {
            process.env.KOTANI_API_BASE_URL = 'https://api.kotanipay.io/api/v3';
            const cfg = new OracleService(mockPrisma()).kotaniConfigState();
            expect(cfg.armed).toBe(true);
            expect(cfg.state).toBe('ARMED');
            expect(cfg.baseUrlExplicit).toBe(true);
            expect(cfg.baseUrl).toBe('https://api.kotanipay.io/api/v3');
            expect(cfg.detail).toContain('https-only policy satisfied');
        } finally {
            KOTANI_VERIFIED_PRODUCTION_HOSTS.length = len; // restore the empty allowlist exactly
        }
        // And the restored (empty) allowlist fails closed again:
        expect(new OracleService(mockPrisma()).kotaniConfigState().state).toBe('UNVERIFIED_PRODUCTION_HOST');
    });

    test('P3-e. a lookalike host (typosquat) is NOT armed even when the real host is verified', () => {
        const { KOTANI_VERIFIED_PRODUCTION_HOSTS } = require('../services/oracleService');
        const len = KOTANI_VERIFIED_PRODUCTION_HOSTS.length;
        KOTANI_VERIFIED_PRODUCTION_HOSTS.push('api.kotanipay.io');
        try {
            process.env.KOTANI_API_BASE_URL = 'https://api-kotanipay.io/api/v3';
            expect(new OracleService(mockPrisma()).kotaniConfigState().state).toBe('UNVERIFIED_PRODUCTION_HOST');
        } finally {
            KOTANI_VERIFIED_PRODUCTION_HOSTS.length = len;
        }
    });

    test('P4. missing or placeholder token in production: MISSING_TOKEN before any endpoint decision', () => {
        delete process.env.KOTANI_API_TOKEN;
        delete process.env.KOTANI_API_KEY;
        expect(new OracleService(mockPrisma()).kotaniConfigState().state).toBe('MISSING_TOKEN');
        process.env.KOTANI_API_TOKEN = 'mock-key';
        expect(new OracleService(mockPrisma()).kotaniConfigState().state).toBe('MISSING_TOKEN');
    });

    test('P5. MOCK/disabled configuration in production: CONFIG_DISABLED, no request, no canonical write', async () => {
        process.env.KOTANI_PROVIDER = 'MOCK';
        axios.post.mockReset();
        axios.get.mockReset();

        const cfg = new OracleService(mockPrisma()).kotaniConfigState();
        expect(cfg.armed).toBe(false);
        expect(cfg.state).toBe('CONFIG_DISABLED');

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();
        expect(axios.post).not.toHaveBeenCalled();
        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
    });

    test('P6. a MISSING_ENDPOINT production deployment makes NO Kotani request and writes nothing canonical', async () => {
        axios.post.mockReset();
        axios.get.mockReset();

        const prisma = mockPrisma();
        await new OracleService(prisma).fetchAndUpdateRates();

        expect(axios.post).not.toHaveBeenCalled();
        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
    });
});

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

    test('DB-B: a successful Kotani observation updates ONLY the canonical fields — liveUsdToGhs is preserved untouched (fix B)', async () => {
        await seedKotaniRow({
            liveUsdToGhs: 13.10,       // legacy USD/GHS value — must survive
            liveRetailRate: 13.42,
        });

        axios.get.mockReset();
        axios.post.mockReset();
        axios.post.mockImplementation(() => KOTANI_OK(12.75));
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) return COINGECKO_OK(0.999);
            throw new Error(`unexpected GET ${url}`);
        });
        process.env.KOTANI_PROVIDER = 'LIVE';
        process.env.KOTANI_API_TOKEN = 'test-token';

        await new OracleService(prisma).fetchAndUpdateRates();

        const row = await getSettings();
        // The canonical USDC/GHS transaction rate moves to the observation.
        expect(Number(row.liveRetailRate)).toBeCloseTo(12.75, 8);
        expect(row.liveRateSource).toBe('KOTANI_PAY');
        // The legacy USD/GHS compatibility field is NOT refreshed and NOT
        // populated with the USDC/GHS value: it keeps its own prior value.
        expect(Number(row.liveUsdToGhs)).toBeCloseTo(13.10, 8);
        expect(Number(row.liveUsdToGhs)).not.toBeCloseTo(12.75, 8);
        // Quote eligibility comes from the canonical field + freshness.
        const rate = await getFreshServerRateGhsPerUsdc({ prisma, maxAgeSeconds: 1800 });
        expect(rate.rateGhsPerUsdc).toBeCloseTo(12.75, 8);
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
