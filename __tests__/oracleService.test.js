const axios = require('axios');
const OracleService = require('../services/oracleService');

jest.mock('axios');

describe('OracleService Kotani rate preference', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv, KOTANI_PROVIDER: 'LIVE', KOTANI_API_TOKEN: 'test-token' };
        axios.get.mockReset();
        axios.post.mockReset();
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    test('extracts direct Kotani rate fields', () => {
        expect(OracleService.extractKotaniRate({ rate: '12.34' })).toBe(12.34);
        expect(OracleService.extractKotaniRate({ data: { exchangeRate: 13.21 } })).toBe(13.21);
    });

    test('extracts a conversion rate when only crypto and fiat amounts are returned', () => {
        expect(OracleService.extractKotaniRate({ cryptoAmount: 2, fiatAmount: 24.8 })).toBe(12.4);
    });

    test('prefers Kotani USDC/GHS over fallback FX data (legacy liveUsdToGhs NOT written)', async () => {
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) {
                return Promise.resolve({ data: { tether: { usd: 1 }, 'usd-coin': { usd: 1 }, dai: { usd: 1 } } });
            }
            if (url.includes('open.er-api.com')) throw new Error('fallback must not be called');
            throw new Error(`unexpected GET URL: ${url}`);
        });
        axios.post.mockImplementation((url, body) => {
            expect(url).toContain('/api/v3/rate/offramp');
            // Documented v3 fiat payout code ('to' is the FIAT code;
            // CGHS is a stablecoin in the `from` enum).
            expect(body).toEqual({ from: 'USDC', to: 'GHS', cryptoAmount: 1 });
            // Documented v3 response envelope: success + echoed pair + value.
            return Promise.resolve({
                data: {
                    success: true,
                    data: { from: 'USDC', to: 'GHS', value: '12.75' },
                },
            });
        });

        const prisma = {
            globalSettings: {
                upsert: jest.fn().mockResolvedValue({}),
            },
        };
        const service = new OracleService(prisma);
        await service.fetchAndUpdateRates();

        expect(prisma.globalSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
            update: expect.objectContaining({
                liveRetailRate: 12.75,
                liveRateSource: 'KOTANI_PAY',
            }),
        }));
        // B fix (lead review 2026-10-17): the USDC/GHS observation must
        // NEVER populate the legacy USD/GHS compatibility field.
        const payload = prisma.globalSettings.upsert.mock.calls[0][0];
        expect(payload.update).not.toHaveProperty('liveUsdToGhs');
        expect(payload.create).not.toHaveProperty('liveUsdToGhs');
    });

    test('fails closed when Kotani is unavailable — no canonical write, no fallback rate', async () => {
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) {
                return Promise.resolve({ data: { tether: { usd: 1 }, 'usd-coin': { usd: 1 }, dai: { usd: 1 } } });
            }
            // The retired FX composite must never be consulted.
            throw new Error(`unexpected GET URL: ${url}`);
        });
        axios.post.mockImplementation((url) => {
            if (url.includes('/api/v3/rate/offramp')) return Promise.reject(new Error('kotani unavailable'));
            throw new Error(`unexpected POST URL: ${url}`);
        });

        const prisma = {
            globalSettings: {
                upsert: jest.fn().mockResolvedValue({}),
                update: jest.fn().mockResolvedValue({}),
            },
        };
        const service = new OracleService(prisma);
        await service.fetchAndUpdateRates();

        // No canonical write of any kind: cached rate, source and every
        // freshness timestamp stay untouched (Kotani-only authority).
        expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
        // At most a supplementary display-only refresh of the stablecoin
        // fields — which can never touch transaction-rate authority.
        expect(prisma.globalSettings.update).toHaveBeenCalledTimes(1);
        const data = prisma.globalSettings.update.mock.calls[0][0].data;
        expect(Object.keys(data).sort()).toEqual(['liveDaiToUsd', 'liveUsdcToUsd', 'liveUsdtToUsd']);
    });
});
