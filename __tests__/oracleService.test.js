const axios = require('axios');
const OracleService = require('../services/oracleService');

jest.mock('axios');

describe('OracleService Kotani rate preference', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv, KOTANI_PROVIDER: 'LIVE', KOTANI_API_KEY: 'test-key' };
        axios.get.mockReset();
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

    test('prefers Kotani USDC/CGHS over fallback FX data', async () => {
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) {
                return Promise.resolve({ data: { tether: { usd: 1 }, 'usd-coin': { usd: 1 }, dai: { usd: 1 } } });
            }
            if (url.includes('/rate/USDC/CGHS')) return Promise.resolve({ data: { rate: 12.75 } });
            if (url.includes('open.er-api.com')) throw new Error('fallback must not be called');
            throw new Error(`unexpected URL: ${url}`);
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
                liveUsdToGhs: 12.75,
                liveRetailRate: 12.75,
                liveRateSource: 'KOTANI_PAY',
            }),
        }));
    });

    test('falls back to open FX when Kotani is unavailable', async () => {
        axios.get.mockImplementation((url) => {
            if (url.includes('coingecko')) {
                return Promise.resolve({ data: { tether: { usd: 1 }, 'usd-coin': { usd: 1 }, dai: { usd: 1 } } });
            }
            if (url.includes('/rate/USDC/CGHS')) return Promise.reject(new Error('kotani unavailable'));
            if (url.includes('open.er-api.com')) return Promise.resolve({ data: { rates: { GHS: 12.11 } } });
            throw new Error(`unexpected URL: ${url}`);
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
                liveUsdToGhs: 12.11,
                liveRetailRate: 12.11,
                liveRateSource: 'FALLBACK_FX',
            }),
        }));
    });
});
