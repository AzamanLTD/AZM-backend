const axios = require('axios');
const OracleService = require('../services/oracleService');

jest.mock('axios');

describe('OracleService USDC/GHS fallback precision', () => {
  beforeEach(() => {
    process.env = {
      ...process.env,
      KOTANI_PROVIDER: 'LIVE',
      KOTANI_API_TOKEN: 'test-token',
    };
    axios.get.mockReset();
    axios.post.mockReset();
  });

  test('uses direct Kotani USDC/GHS without calling the fallback provider', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('coingecko')) {
        return Promise.resolve({ data: { tether: { usd: 1 }, 'usd-coin': { usd: 0.9998 }, dai: { usd: 1 } } });
      }
      throw new Error(`unexpected GET URL: ${url}`);
    });
    axios.post.mockResolvedValue({ data: { rate: 13.11 } });

    const prisma = { globalSettings: { upsert: jest.fn().mockResolvedValue({}) } };
    await new OracleService(prisma).fetchAndUpdateRates();

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/v3/rate/offramp'),
      { from: 'USDC', to: 'CGHS', cryptoAmount: 1 },
      expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } }),
    );
    expect(axios.get).not.toHaveBeenCalledWith(
      expect.stringContaining('open.er-api.com'),
      expect.anything(),
    );
    expect(prisma.globalSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        liveUsdToGhs: 13.11,
        liveRetailRate: 13.11,
        liveUsdcToUsd: 0.9998,
        liveRateSource: 'KOTANI_PAY',
      }),
    }));
  });

  test('derives USDC/GHS from USD/GHS × USDC/USD when Kotani is unavailable', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('coingecko')) {
        return Promise.resolve({ data: { tether: { usd: 1 }, 'usd-coin': { usd: 0.9985 }, dai: { usd: 1 } } });
      }
      if (url.includes('open.er-api.com')) {
        return Promise.resolve({ data: { rates: { GHS: 13.20 } } });
      }
      throw new Error(`unexpected GET URL: ${url}`);
    });
    axios.post.mockRejectedValue(new Error('Kotani unavailable'));

    const prisma = { globalSettings: { upsert: jest.fn().mockResolvedValue({}) } };
    await new OracleService(prisma).fetchAndUpdateRates();

    expect(prisma.globalSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        liveUsdToGhs: 13.20,
        liveRetailRate: 13.1802,
        liveUsdcToUsd: 0.9985,
        liveRateSource: 'FALLBACK_FX',
      }),
    }));
  });
});
