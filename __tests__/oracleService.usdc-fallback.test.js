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
    axios.post.mockResolvedValue({ data: {
      success: true,
      data: { from: 'USDC', to: 'GHS', value: '13.11' },
    } });

    const prisma = { globalSettings: { upsert: jest.fn().mockResolvedValue({}) } };
    await new OracleService(prisma).fetchAndUpdateRates();

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/v3/rate/offramp'),
      { from: 'USDC', to: 'GHS', cryptoAmount: 1 },
      expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } }),
    );
    expect(axios.get).not.toHaveBeenCalledWith(
      expect.stringContaining('open.er-api.com'),
      expect.anything(),
    );
    expect(prisma.globalSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        liveRetailRate: 13.11,
        liveUsdcToUsd: 0.9998,
        liveRateSource: 'KOTANI_PAY',
      }),
    }));
    // B fix: the legacy USD/GHS field is never populated with the USDC rate.
    const payload = prisma.globalSettings.upsert.mock.calls[0][0];
    expect(payload.update).not.toHaveProperty('liveUsdToGhs');
    expect(payload.create).not.toHaveProperty('liveUsdToGhs');
  });

  test('writes NO canonical rate when Kotani is unavailable — the FX × CoinGecko composite is retired', async () => {
    // Both supplementary feeds are healthy — their success must not
    // manufacture a transaction rate or refresh freshness.
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

    const prisma = {
      globalSettings: {
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    await new OracleService(prisma).fetchAndUpdateRates();

    // No canonical write: liveRetailRate / liveUsdToGhs / liveRateSource /
    // lastRateSync / lastExternalSync all stay untouched.
    expect(prisma.globalSettings.upsert).not.toHaveBeenCalled();
    // Supplementary display-only refresh touches the stablecoin fields only.
    expect(prisma.globalSettings.update).toHaveBeenCalledTimes(1);
    const data = prisma.globalSettings.update.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual(['liveDaiToUsd', 'liveUsdcToUsd', 'liveUsdtToUsd']);
    expect(data.liveUsdcToUsd).toBeCloseTo(0.9985, 10);
    // The retired FX feed was never even requested.
    const getUrls = axios.get.mock.calls.map(([url]) => String(url));
    expect(getUrls.some((url) => url.includes('open.er-api.com'))).toBe(false);
  });
});
