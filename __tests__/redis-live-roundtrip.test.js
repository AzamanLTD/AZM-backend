'use strict';

/**
 * LIVE Redis proofs — a real server, a real TCP/TLS round trip.
 *
 * Everything else in the Redis suite mocks ioredis, which proves logic but not
 * that the layer can talk to an actual Redis. These cases run only when a live
 * endpoint is provided:
 *
 *   REDIS_URL_LIVE   e.g. rediss://default:<password>@<host>:6379   (Upstash)
 *                          redis://127.0.0.1:6399                    (local)
 *   REDIS_TLS_URL    a TLS endpoint whose certificate is NOT publicly
 *                    trusted (self-signed), used to prove verification is ON
 *   REDIS_TLS_CA     path to that endpoint's CA/certificate file
 *
 * With none of them set every case is skipped, so CI is unaffected, and a
 * skipped run is honest about not having talked to a server.
 */

const { execFileSync } = require('child_process');

const LIVE_URL = process.env.REDIS_URL_LIVE || '';
const TLS_URL = process.env.REDIS_TLS_URL || '';
const TLS_CA = process.env.REDIS_TLS_CA || '';

const describeLive = LIVE_URL ? describe : describe.skip;
const describeTls = TLS_URL && TLS_CA ? describe : describe.skip;

if (!LIVE_URL) console.warn('[redis-live] REDIS_URL_LIVE not set — live round-trip cases skipped.');
if (!(TLS_URL && TLS_CA)) console.warn('[redis-live] REDIS_TLS_URL/REDIS_TLS_CA not set — TLS cases skipped.');

describeLive('LIVE Redis — real server round trip', () => {
    let redis;

    beforeAll(() => {
        process.env.REDIS_URL = LIVE_URL;
        redis = require('../src/lib/redisConnection');
    });

    afterAll(async () => {
        if (redis) await redis.disconnectAll();
        delete process.env.REDIS_URL;
    });

    afterEach(async () => {
        if (!redis) return;
        const client = redis.getRedis('otp');
        if (client) await client.del('live:otp:test').catch(() => {});
    });

    test('a real PING succeeds with a measured latency', async () => {
        const result = await redis.ping('default');
        expect(result.ok).toBe(true);
        expect(typeof result.latencyMs).toBe('number');
    });

    test('a value survives disconnectAll and coming back — state is in Redis, not process memory', async () => {
        // This is the production defect in miniature: an in-process Map loses a
        // pending OTP on every spin-down. If the value survives a full client
        // teardown, the state is genuinely remote.
        const first = redis.getRedis('otp');
        await first.set('live:otp:test', '483920', 'EX', 120);
        expect(await first.get('live:otp:test')).toBe('483920');

        await redis.disconnectAll();

        const second = redis.getRedis('otp');
        expect(second).not.toBe(first);
        expect(await second.get('live:otp:test')).toBe('483920');
    });

    test('one client per profile, and profiles are distinct clients', async () => {
        const a = redis.getRedis('default');
        const b = redis.getRedis('default');
        const c = redis.getRedis('cache');
        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });

    test('the queue profile can round-trip under maxRetriesPerRequest: null', async () => {
        const queue = redis.getRedis('queue');
        expect(queue.options.maxRetriesPerRequest).toBeNull();
        await queue.set('live:queue:test', 'ok', 'EX', 60);
        expect(await queue.get('live:queue:test')).toBe('ok');
        await queue.del('live:queue:test');
    });

    test('an Upstash REST URL is refused with an actionable message', () => {
        expect(() => redis.normalizeRedisUrl('https://example.upstash.io'))
            .toThrow(/REST URL/i);
    });

    test('/health status reports the live profile without leaking the URL or password', async () => {
        const client = redis.getRedis('default');
        await client.ping();
        const status = redis.status();
        expect(status.configured).toBe(true);
        expect(status.profiles.default.status).toBe('ready');
        const serialized = JSON.stringify(status);
        expect(serialized).not.toContain('@');
        if (new URL(LIVE_URL).password) {
            expect(serialized).not.toContain(decodeURIComponent(new URL(LIVE_URL).password));
        }
    });
});

describeTls('LIVE Redis over TLS — certificate verification is NOT disabled', () => {
    // The point of these two cases: with `rejectUnauthorized: false` (the
    // defect this branch removed) BOTH would connect. Now the first must fail
    // and the second must succeed only because the CA was explicitly trusted.
    const script = `
        const redis = require(${JSON.stringify(require.resolve('../src/lib/redisConnection'))});
        (async () => {
            const client = redis.getRedis('default');
            let ok = false;
            try { ok = (await client.ping()) === 'PONG'; } catch (e) { ok = false; }
            const detail = client.__azmLastError?.() ?? 'no transport error recorded';
            await redis.disconnectAll();
            if (ok) { console.log('PONG'); process.exit(0); }
            console.error('FAILED ' + detail);
            process.exit(3);
        })();
    `;

    const runNode = (env) => {
        try {
            const out = execFileSync(process.execPath, ['-e', script], {
                env: { ...process.env, REDIS_URL: TLS_URL, ...env },
                encoding: 'utf8',
                timeout: 25000,
            });
            return { code: 0, out };
        } catch (e) {
            return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
        }
    };

    test('a certificate we do not trust is REFUSED (verification is on)', () => {
        const result = runNode({ NODE_EXTRA_CA_CERTS: '' });
        expect(result.code).not.toBe(0);
        expect(result.out).toMatch(/self.signed|unable to verify|certificate/i);
        expect(result.out).not.toContain('PONG');
    });

    test('the same endpoint connects once its CA is explicitly trusted', () => {
        const result = runNode({ NODE_EXTRA_CA_CERTS: TLS_CA });
        expect(result.code).toBe(0);
        expect(result.out).toContain('PONG');
    });
});
