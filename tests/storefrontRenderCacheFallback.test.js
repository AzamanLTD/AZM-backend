const mockRedisClient = {
  status: 'ready',
  on: jest.fn(),
  get: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
};

jest.mock('ioredis', () => jest.fn(() => mockRedisClient));

function loadRenderService() {
  jest.resetModules();
  process.env.REDIS_URL = 'redis://cache.test:6379';
  return require('../services/storefrontRenderService');
}

describe('storefront render cache fallback', () => {
  const originalRedisUrl = process.env.REDIS_URL;

  beforeEach(() => {
    mockRedisClient.status = 'ready';
    mockRedisClient.on.mockReset();
    mockRedisClient.get.mockReset();
    mockRedisClient.setex.mockReset();
    mockRedisClient.del.mockReset();
  });

  afterAll(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  });

  test('stores a memory fallback when a ready Redis client rejects a write', async () => {
    mockRedisClient.setex.mockRejectedValueOnce(new Error('redis write unavailable'));
    const service = loadRenderService();

    await service._setCached('storefront:render:biz-1', { version: 7 }, 30);

    expect(service._memoryCache.get('storefront:render:biz-1')?.value).toEqual({ version: 7 });
  });

  test('reads the memory fallback when a ready Redis client rejects a read', async () => {
    mockRedisClient.setex.mockRejectedValueOnce(new Error('redis write unavailable'));
    mockRedisClient.get.mockRejectedValueOnce(new Error('redis read unavailable'));
    const service = loadRenderService();

    await service._setCached('storefront:render:biz-2', { version: 8 }, 30);
    const cached = await service._getCached('storefront:render:biz-2');

    expect(cached).toEqual({ version: 8 });
  });

  test('does not populate process memory when Redis succeeds', async () => {
    mockRedisClient.setex.mockResolvedValueOnce('OK');
    const service = loadRenderService();

    await service._setCached('storefront:render:biz-3', { version: 9 }, 30);

    expect(service._memoryCache.has('storefront:render:biz-3')).toBe(false);
  });
});
