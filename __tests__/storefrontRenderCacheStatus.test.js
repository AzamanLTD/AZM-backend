'use strict';

const { isRedisReady } = require('../services/storefrontRenderService');

describe('storefront render Redis cache readiness', () => {
  test('accepts ioredis ready state', () => {
    expect(isRedisReady({ status: 'ready' })).toBe(true);
  });

  test('accepts connect state during connection transition', () => {
    expect(isRedisReady({ status: 'connect' })).toBe(true);
  });

  test('does not treat waiting, reconnecting, or closed clients as ready', () => {
    expect(isRedisReady({ status: 'wait' })).toBe(false);
    expect(isRedisReady({ status: 'reconnecting' })).toBe(false);
    expect(isRedisReady({ status: 'close' })).toBe(false);
    expect(isRedisReady(null)).toBe(false);
  });
});
