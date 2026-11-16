'use strict';

/**
 * Production must not talk to Redis in the clear.
 *
 * Grounded in a measured constraint, not a preference: the Redis Cloud free
 * Essentials plan cannot enable TLS at all (API answers
 * FIXED_DATABASE_ENABLE_TLS_NOT_SUPPORTED_IN_REQUESTED_PLAN, verified
 * 2026-11-14). So a free-tier endpoint hands out redis:// and the password plus
 * every key would cross the public internet unencrypted.
 *
 * The guard refuses in production, which makes the endpoint read as
 * "not configured" — so the OTP store fails closed with OTP_STORE_UNAVAILABLE
 * rather than writing codes through an unencrypted link. Non-production is
 * deliberately untouched so local runs and CI keep working.
 */

const ENV_KEYS = ['NODE_ENV', 'REDIS_URL', 'REDIS_ALLOW_PLAINTEXT'];

const loggerCalls = [];
jest.mock('../src/config/logger', () => ({
    info: (...a) => loggerCalls.push(['info', a]),
    warn: (...a) => loggerCalls.push(['warn', a]),
    error: (...a) => loggerCalls.push(['error', a]),
    debug: () => {},
}));

const PLAINTEXT = 'redis://default:secret@cache.internal:6379';
const SECURE = 'rediss://default:secret@cache.internal:6379';

function freshRedis(env = {}) {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, env);
    let mod;
    jest.isolateModules(() => {
        mod = require('../src/lib/redisConnection');
    });
    return mod;
}

describe('plaintext Redis is refused in production', () => {
    beforeEach(() => { loggerCalls.length = 0; });

    test('redis:// is rejected outright in production', () => {
        const redis = freshRedis({ NODE_ENV: 'production', REDIS_URL: PLAINTEXT });
        expect(() => redis.normalizeRedisUrl(PLAINTEXT)).toThrow(/refusing plaintext redis:\/\//);
    });

    test('and the endpoint then reads as NOT configured, so callers fail closed', () => {
        const redis = freshRedis({ NODE_ENV: 'production', REDIS_URL: PLAINTEXT });
        expect(redis.isConfigured()).toBe(false);
        expect(redis.getRedis('otp')).toBeNull();
        // The reason must be recorded, not swallowed.
        const logged = loggerCalls.some(([level]) => level === 'error');
        expect(logged).toBe(true);
    });

    test('rediss:// is accepted in production', () => {
        const redis = freshRedis({ NODE_ENV: 'production', REDIS_URL: SECURE });
        expect(redis.isConfigured()).toBe(true);
        expect(redis.normalizeRedisUrl(SECURE)).toBe(SECURE);
    });

    test('a private-network endpoint can opt in explicitly, and it is logged as a warning', () => {
        const redis = freshRedis({
            NODE_ENV: 'production',
            REDIS_URL: PLAINTEXT,
            REDIS_ALLOW_PLAINTEXT: 'true',
        });
        expect(redis.isConfigured()).toBe(true);
        expect(() => redis.normalizeRedisUrl(PLAINTEXT)).not.toThrow();
        const warned = loggerCalls.some(([level, args]) =>
            level === 'warn' && JSON.stringify(args).includes('UNENCRYPTED'));
        expect(warned).toBe(true);
    });

    test('the opt-in is not inferred from the hostname or any other field', () => {
        // A host that "looks private" still refuses without the explicit variable.
        const redis = freshRedis({ NODE_ENV: 'production', REDIS_URL: 'redis://10.0.0.5:6379' });
        expect(redis.isConfigured()).toBe(false);
    });

    test('development and test keep working with redis://', () => {
        for (const env of ['development', 'test']) {
            const redis = freshRedis({ NODE_ENV: env, REDIS_URL: PLAINTEXT });
            expect(redis.isConfigured()).toBe(true);
        }
    });

    test('the REST-URL refusal still fires first, and is unchanged', () => {
        const redis = freshRedis({ NODE_ENV: 'production' });
        expect(() => redis.normalizeRedisUrl('https://example.upstash.io'))
            .toThrow(/REST URL/);
    });
});
