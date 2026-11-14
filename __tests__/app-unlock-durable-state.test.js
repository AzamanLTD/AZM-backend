// __tests__/app-unlock-durable-state.test.js
// =============================================================================
// WP-D: durable security state for app unlock.
//
// PROVES
//   1. A PIN budget is shared by independently constructed service instances
//      (one authoritative store, not one budget per process).
//   2. In production without an authoritative store the service REFUSES with a
//      typed 503 — it does not fall back to a process-local Map, reset the
//      count, or treat the outage as a fresh window.
//   3. A valid TOTP is accepted once and its replay is refused.
//   4. Two simultaneous submissions of the same valid TOTP have exactly one
//      winner.
//   5. The replay claim is DURABLE: a freshly constructed service (a restarted
//      process) still refuses the replay, because the claim is a database row.
//   6. The accepted time window still works at its intended boundaries.
//   7. An unreachable replay authority fails closed.
//   8. Existing PIN semantics (decrement, lockout, clear-on-success) are intact.
//
// WHAT IS NOT PROVEN HERE: Redis' own atomicity. No Redis server is available in
// this environment, so the shared store is a faithful in-process stand-in for
// the two Lua scripts' semantics. The real-Redis gap stays covered by
// app-unlock-redis.integration.test.js, which skips loudly without REDIS_URL.
//
// The durable claim half DOES run against real PostgreSQL.
// =============================================================================

const hasDb = !!process.env.TEST_DATABASE_URL;
const IS_CI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);

if (!hasDb) {
    console.warn('[app-unlock-durable-state] TEST_DATABASE_URL not set — skipping.');
}

// WP-D fail-closed: a missing database in CI must FAIL, not skip to green.
if (!hasDb && IS_CI) {
    test('WP-D CI configuration: TEST_DATABASE_URL must be set', () => {
        throw new Error(
            'TEST_DATABASE_URL is not set in CI. The durable replay-claim proofs cannot run, '
            + 'and a skipped suite must not be reported as a passing build.',
        );
    });
}

(hasDb ? describe : describe.skip)('app unlock durable security state (real PostgreSQL)', () => {
    const bcrypt = require('bcryptjs');
    const speakeasy = require('speakeasy');
    const { PrismaClient } = require('@prisma/client');

    const savedNodeEnv = process.env.NODE_ENV;

    let prisma;
    let AppUnlockService;
    let STATE_UNAVAILABLE_CODE;
    let PIN_MAX_ATTEMPTS;
    let seedUser;

    /**
     * A shared attempt store standing in for Redis: the same object is handed to
     * two service instances, and it implements the semantics of the two Lua
     * scripts (INCR+PEXPIRE-on-first, DEL, GET) against one Map. Any instance
     * that talked to its own memory instead would fail the sharing test.
     */
    function makeSharedStore() {
        const kv = new Map();
        return {
            _kv: kv,
            async eval(script, _numKeys, key, arg) {
                if (script.includes("redis.call('DEL'")) {
                    kv.delete(key);
                    return 1;
                }
                const rec = kv.get(key) || { n: 0, expiresAt: 0 };
                if (rec.expiresAt && Date.now() >= rec.expiresAt) rec.n = 0;
                rec.n += 1;
                rec.expiresAt = Date.now() + Number(arg);
                kv.set(key, rec);
                return rec.n;
            },
            async get(key) {
                const rec = kv.get(key);
                if (!rec) return null;
                if (rec.expiresAt && Date.now() >= rec.expiresAt) return null;
                return String(rec.n);
            },
            async set(key, value) { kv.set(key, { n: Number(value), expiresAt: 0 }); return 'OK'; },
        };
    }

    // Use the repo's own user factory rather than hand-rolling a User row: the
    // schema has required fields this suite has no business restating.
    const userFor = async ({ pin = null, data = {} } = {}) => {
        const pinHash = pin ? await bcrypt.hash(pin, 10) : null;
        return seedUser(prisma, { pinHash, ...data });
    };

    const smsWith = (store) => ({ _redisClient: store || null, isProduction: false });

    const svc = ({ store = null, production = false, prismaClient = prisma } = {}) => {
        process.env.NODE_ENV = production ? 'production' : 'test';
        const service = new AppUnlockService({
            prisma: prismaClient,
            smsService: { ...smsWith(store), isProduction: production },
        });
        process.env.NODE_ENV = savedNodeEnv;
        return service;
    };

    beforeAll(async () => {
        prisma = new PrismaClient();
        ({ AppUnlockService, STATE_UNAVAILABLE_CODE, PIN_MAX_ATTEMPTS } = require('../services/appUnlockService'));
        ({ seedUser } = require('./helpers/factories'));
    });

    beforeEach(async () => {
        await prisma.totpStepClaim.deleteMany({});
    });

    afterAll(async () => {
        process.env.NODE_ENV = savedNodeEnv;
        await prisma.$disconnect();
    });

    // ── 1. one budget, two instances ───────────────────────────────────────
    test('a PIN budget is shared by two independently constructed instances', async () => {
        const store = makeSharedStore();
        const user = await userFor({ pin: '1234' });

        // Two services, as two Express workers would construct them.
        const a = svc({ store });
        const b = svc({ store });

        // Alternate the guesses across instances: a per-process counter would
        // give 2 x PIN_MAX_ATTEMPTS, this must stop at PIN_MAX_ATTEMPTS.
        const codes = [];
        for (let i = 0; i < PIN_MAX_ATTEMPTS * 2; i += 1) {
            const s = i % 2 === 0 ? a : b;
            // eslint-disable-next-line no-await-in-loop
            codes.push((await s.verifyPin(user, '0000')).code);
        }
        expect(codes.filter((c) => c === 'PIN_LOCKED').length).toBeGreaterThan(0);
        expect(codes.slice(0, PIN_MAX_ATTEMPTS).every((c) => c === 'PIN_INVALID' || c === 'PIN_LOCKED')).toBe(true);
        // The first refusal after the budget is spent is the lockout, on
        // whichever instance receives it — from either side.
        expect(codes[PIN_MAX_ATTEMPTS]).toBe('PIN_LOCKED');
    });

    // ── 2. production without a store must refuse, not remember ────────────
    test('production without an authoritative store refuses instead of using process memory', async () => {
        const user = await userFor({ pin: '1234' });
        const dev = svc({ production: false });      // Map path, allowed in dev
        const prod = svc({ production: true });      // no store: must refuse

        // Spend most of a local budget first: if the production path silently
        // reused the Map those counters would carry over.
        for (let i = 0; i < PIN_MAX_ATTEMPTS - 1; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            expect((await dev.verifyPin(user, '0000')).code).toBe('PIN_INVALID');
        }

        const verdict = await prod.verifyPin(user, '1234'); // CORRECT pin
        expect(verdict.ok).toBe(false);
        expect(verdict.code).toBe(STATE_UNAVAILABLE_CODE);
        expect(verdict.status).toBe(503);

        // And the refusal is neither a reset nor a charge: the development
        // budget is still at 4 of 5, so the NEXT failure is the lockout. A
        // silent Map fallback in production would have shown a fresh window
        // here (PIN_INVALID with a full budget) instead.
        const after = await dev.verifyPin(user, '0000');
        expect(after.code).toBe('PIN_LOCKED');
        expect(after.attemptsLeft).toBe(0);
    });

    // ── 3/4. TOTP once, and one winner under concurrency ───────────────────
    test('a valid TOTP unlocks once and its replay is refused', async () => {
        const secret = speakeasy.generateSecret({ length: 20 }).base32;
        const user = await userFor({ data: { isTwoFactorEnabled: true, twoFactorSecret: secret } });
        const service = svc({ store: makeSharedStore() });
        const token = speakeasy.totp({ secret, encoding: 'base32' });

        expect((await service.verifyTotp(user, token)).code).toBe('TOTP_OK');
        const replayed = await service.verifyTotp(user, token);
        expect(replayed.ok).toBe(false);
        expect(replayed.code).toBe('TOTP_REPLAYED');
        expect(replayed.status).toBe(409);
    });

    test('two simultaneous submissions of the same TOTP have exactly one winner', async () => {
        const secret = speakeasy.generateSecret({ length: 20 }).base32;
        const user = await userFor({ data: { isTwoFactorEnabled: true, twoFactorSecret: secret } });
        const service = svc({ store: makeSharedStore() });
        const token = speakeasy.totp({ secret, encoding: 'base32' });

        const results = await Promise.all([
            service.verifyTotp(user, token),
            service.verifyTotp(user, token),
        ]);
        expect(results.filter((r) => r.ok).length).toBe(1);
        expect(results.filter((r) => r.code === 'TOTP_REPLAYED').length).toBe(1);
        expect(await prisma.totpStepClaim.count({ where: { userId: user.id } })).toBe(1);
    });

    // ── 5. durability across a reconstructed service / restart ─────────────
    test('the replay claim survives service reconstruction and a process restart', async () => {
        const secret = speakeasy.generateSecret({ length: 20 }).base32;
        const user = await userFor({ data: { isTwoFactorEnabled: true, twoFactorSecret: secret } });
        const token = speakeasy.totp({ secret, encoding: 'base32' });

        expect((await svc({ store: makeSharedStore() }).verifyTotp(user, token)).code).toBe('TOTP_OK');

        // A brand-new service with a brand-new (empty) cache: only the database
        // knows this code was used. This is the restart case.
        const restarted = svc({ store: makeSharedStore() });
        expect((await restarted.verifyTotp(user, token)).code).toBe('TOTP_REPLAYED');

        // The claim row carries no code and no secret: only the step index.
        const claim = await prisma.totpStepClaim.findFirst({ where: { userId: user.id } });
        expect(Object.keys(claim).sort()).toEqual(['createdAt', 'id', 'step', 'userId']);
        expect(JSON.stringify(claim)).not.toContain(token);
    });

    // ── 6. the window policy still works ───────────────────────────────────
    test('the accepted window still admits the adjacent step and refuses an older one', async () => {
        const secret = speakeasy.generateSecret({ length: 20 }).base32;
        const user = await userFor({ data: { isTwoFactorEnabled: true, twoFactorSecret: secret } });
        const service = svc({ store: makeSharedStore() });

        // A code minted one step ago is inside window:1 and must still work.
        const previous = speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) - 30 });
        expect((await service.verifyTotp(user, previous)).code).toBe('TOTP_OK');

        // Two steps out is outside the policy.
        const tooOld = speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) - 90 });
        const refused = await service.verifyTotp(user, tooOld);
        expect(refused.ok).toBe(false);
        expect(refused.code).toBe('TOTP_INVALID');
    });

    // ── 7. an unreachable replay authority fails closed ────────────────────
    test('an unreachable replay authority refuses instead of accepting the code', async () => {
        const secret = speakeasy.generateSecret({ length: 20 }).base32;
        const user = await userFor({ data: { isTwoFactorEnabled: true, twoFactorSecret: secret } });
        const token = speakeasy.totp({ secret, encoding: 'base32' });

        const broken = svc({
            store: makeSharedStore(),
            prismaClient: {
                totpStepClaim: {
                    deleteMany: async () => ({ count: 0 }),
                    create: async () => { throw new Error('connection terminated'); },
                },
            },
        });
        const verdict = await broken.verifyTotp(user, token);
        expect(verdict.ok).toBe(false);
        expect(verdict.code).toBe(STATE_UNAVAILABLE_CODE);
        expect(verdict.status).toBe(503);
    });

    test('a service with no claim table at all refuses rather than trusting the code', async () => {
        const secret = speakeasy.generateSecret({ length: 20 }).base32;
        const user = await userFor({ data: { isTwoFactorEnabled: true, twoFactorSecret: secret } });
        const token = speakeasy.totp({ secret, encoding: 'base32' });

        const verdict = await svc({ store: makeSharedStore(), prismaClient: {} }).verifyTotp(user, token);
        expect(verdict.code).toBe(STATE_UNAVAILABLE_CODE);
    });

    // ── 8. existing PIN semantics unchanged ────────────────────────────────
    test('PIN decrement, lockout and clear-on-success are unchanged', async () => {
        const user = await userFor({ pin: '1234' });
        const store = makeSharedStore();
        const service = svc({ store });

        const first = await service.verifyPin(user, '0000');
        expect(first).toMatchObject({ ok: false, code: 'PIN_INVALID', status: 401 });
        expect(first.attemptsLeft).toBe(PIN_MAX_ATTEMPTS - 1);

        // A correct PIN inside the budget clears the counter.
        expect((await service.verifyPin(user, '1234')).code).toBe('PIN_OK');
        const afterReset = await service.verifyPin(user, '0000');
        expect(afterReset.attemptsLeft).toBe(PIN_MAX_ATTEMPTS - 1);

        // Exhaust it: the last refusal reports the lockout, not "invalid".
        for (let i = 0; i < PIN_MAX_ATTEMPTS; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await service.verifyPin(user, '0000');
        }
        const locked = await service.verifyPin(user, '1234'); // even the right PIN
        expect(locked.code).toBe('PIN_LOCKED');
        expect(locked.status).toBe(429);
    });
});
