'use strict';

/**
 * Shared Redis connection layer.
 *
 * The backend used to open up to ten independent ioredis clients. Two of them
 * disabled TLS certificate verification and some gave up reconnecting
 * permanently after a few attempts. These cases pin the properties that make
 * the single layer correct, without needing a live Redis server.
 */

describe('redis connection layer', () => {
    let mod;

    beforeEach(() => {
        jest.resetModules();
        delete process.env.REDIS_URL;
        mod = require('../src/lib/redisConnection');
    });

    afterEach(async () => {
        const { disconnectAll } = require('../src/lib/redisConnection');
        await disconnectAll();
        delete process.env.REDIS_URL;
    });

    test('returns null when Redis is not configured, so callers keep their fallbacks', () => {
        expect(mod.isConfigured()).toBe(false);
        expect(mod.getRedis()).toBeNull();
        expect(mod.getRedis('cache')).toBeNull();
    });

    test('refuses an Upstash REST URL instead of treating it as a hostname', () => {
        expect(() => mod.normalizeRedisUrl('https://abc.upstash.io'))
            .toThrow(/REST URL/);
        expect(() => mod.normalizeRedisUrl('http://abc.upstash.io'))
            .toThrow(/REST URL/);
    });

    test('rejects anything that is not a redis URL', () => {
        expect(() => mod.normalizeRedisUrl('abc.upstash.io:6379')).toThrow(/redis:\/\//);
        expect(mod.normalizeRedisUrl('')).toBeNull();
    });

    test('accepts rediss:// and redis://', () => {
        expect(mod.normalizeRedisUrl('rediss://default:pw@abc.upstash.io:6379'))
            .toBe('rediss://default:pw@abc.upstash.io:6379');
        expect(mod.normalizeRedisUrl('redis://localhost:6379')).toBe('redis://localhost:6379');
    });

    test('ONE connection per profile — repeated calls share the client', () => {
        process.env.REDIS_URL = 'rediss://default:pw@example.upstash.io:6379';
        const a = mod.getRedis('default');
        const b = mod.getRedis('default');
        expect(a).toBe(b);

        const cache = mod.getRedis('cache');
        expect(cache).not.toBe(a); // separate profile, separate connection
    });

    test('the queue profile keeps maxRetriesPerRequest null for BullMQ', () => {
        expect(mod.PROFILES.queue.maxRetriesPerRequest).toBeNull();
        expect(mod.PROFILES.default.maxRetriesPerRequest).toBe(3);
    });

    test('backoff is bounded, not the ioredis 100ms-forever default', () => {
        const first = mod.retryStrategy(1);
        const fifth = mod.retryStrategy(5);
        expect(first).toBeGreaterThanOrEqual(500);
        expect(fifth).toBeLessThanOrEqual(10_000);
        expect(mod.retryStrategy(31)).toBeNull(); // gives up eventually
    });

    test('status() never exposes the password', () => {
        process.env.REDIS_URL = 'rediss://default:supersecretpassword@example.upstash.io:6379';
        mod.getRedis('default');
        const snapshot = mod.status();
        const serialized = JSON.stringify(snapshot);
        expect(serialized).not.toContain('supersecretpassword');
        expect(snapshot.configured).toBe(true);
        expect(snapshot.profiles.default).toBeDefined();
    });

    test('a REST URL yields no client but does not crash the process', () => {
        process.env.REDIS_URL = 'https://abc.upstash.io';
        expect(mod.getRedis()).toBeNull();
        expect(mod.isConfigured()).toBe(false);
    });
});
