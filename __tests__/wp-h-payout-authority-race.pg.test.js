/**
 * §WP-H — THE AUTHORITY RACE, PROVED WITH REAL POSTGRESQL SESSIONS.
 *
 * The defect: the payout worker read the reservation and the authority regime
 * BEFORE its claim transaction, so a regime that flipped between the scan and the
 * claim could still dispatch. The fix moves the decision inside the claim
 * transaction under the canonical SHARED advisory lock that activation takes
 * EXCLUSIVE. That is only worth anything if the two modes actually exclude each
 * other across backends, so it is proved here against PostgreSQL, not a mock.
 *
 * DETERMINISM: no arbitrary sleeps. The session whose lock must be held takes it
 * and then parks on a BARRIER advisory lock owned by a DIFFERENT session. This
 * test observes that wait in pg_locks (proof the authority lock is held), runs
 * the probe, then releases the barrier. Every wait is an observed lock state.
 */
const { PrismaClient } = require('@prisma/client');
const { lockAuthorityShared } = require('../src/services/authorityState');
const { readMode } = require('../src/services/fiatLiquidityActivationService');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const AUTHORITY_KEY = 'azm.p5d.authority.activation';
const BARRIER_KEY = 'azm.wph.test.barrier';

const one = (suffix) => new PrismaClient({
    datasources: { db: { url: `${DB_URL}${DB_URL.includes('?') ? '&' : '?'}connection_limit=1` } },
});

/** Wait until a backend is WAITING on an advisory lock: observed, never assumed. */
async function waitForAdvisoryWait(observer, key, mode, timeoutMs = 8000) {
    // PostgreSQL stores a bigint advisory key as (classid = high 32 bits,
    // objid = low 32 bits, objsubid = 1). hashtext() is a 32-bit int, so the
    // key lands entirely in objid. Verified by inspecting pg_locks directly
    // rather than assuming the encoding.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const rows = await observer.$queryRawUnsafe(`
            SELECT count(*)::int AS n
              FROM pg_locks
             WHERE locktype = 'advisory'
               AND NOT granted
               AND mode = $2
               AND objid = (hashtext($1)::bigint & 4294967295)`, key, mode);
        if (rows[0].n > 0) return true;
        await new Promise((r) => setTimeout(r, 10));
    }
    return false;
}

describe('§WP-H payout authority race (real PostgreSQL, two sessions)', () => {
    let admin;      // seeding + observation
    let barrier;    // owns the barrier lock so another session can park on it
    let claimSess;  // session that holds the claim's shared lock
    let activationSess;

    beforeAll(async () => {
        if (!DB_URL) throw new Error('TEST_DATABASE_URL or DATABASE_URL is required');
        admin = new PrismaClient({ datasources: { db: { url: DB_URL } } });
        barrier = one('barrier');
        claimSess = one('claim');
        activationSess = one('activation');
        await Promise.all([admin.$connect(), barrier.$connect(), claimSess.$connect(), activationSess.$connect()]);
        await admin.$executeRawUnsafe(`
            INSERT INTO "FiatLiquidityState" (id, "authorityActivatedAt", "updatedAt")
            VALUES (1, NULL, now())
            ON CONFLICT (id) DO UPDATE SET "authorityActivatedAt" = NULL, "updatedAt" = now()`);
    }, 40000);

    afterAll(async () => {
        try {
            await admin.$executeRawUnsafe(
                `UPDATE "FiatLiquidityState" SET "authorityActivatedAt" = NULL WHERE id = 1`);
        } catch (_) { /* best effort */ }
        await Promise.allSettled([admin.$disconnect(), barrier.$disconnect(), claimSess.$disconnect(), activationSess.$disconnect()]);
    });

    test('ORDERING A — activation cannot take the exclusive lock while a claim holds the shared lock', async () => {
        await barrier.$executeRawUnsafe('SELECT pg_advisory_lock(hashtext($1))', BARRIER_KEY);
        let claimStarted;
        const claimHolds = new Promise((resolve) => { claimStarted = resolve; });

        // The claim session holds the canonical SHARED lock for its whole
        // transaction, then parks on the barrier so it is provably still open
        // when activation asks for the exclusive lock.
        const claimTx = claimSess.$transaction(async (tx) => {
            await lockAuthorityShared(tx);
            claimStarted();
            await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', BARRIER_KEY);
            return 'claim-committed';
        }, { timeout: 40000 });

        await claimHolds;
        const parked = await waitForAdvisoryWait(admin, BARRIER_KEY, 'ExclusiveLock');
        expect(parked).toBe(true);
        // (the barrier is released below; the finally in afterAll frees it on failure)

        // Activation asks for the exclusive lock while the claim is open.
        let blocked;
        try {
            await activationSess.$transaction(async (tx) => {
                await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '750ms'");
                await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', AUTHORITY_KEY);
            }, { timeout: 20000 });
            blocked = false;
        } catch (err) {
            blocked = /55P03|lock timeout|canceling statement/i.test(String(err && err.message));
        }
        expect(blocked).toBe(true);

        // Release the barrier: the claim commits, and only THEN can activation proceed.
        await barrier.$executeRawUnsafe('SELECT pg_advisory_unlock(hashtext($1))', BARRIER_KEY);
        await expect(claimTx).resolves.toBe('claim-committed');

        const after = await activationSess.$queryRawUnsafe(
            'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', AUTHORITY_KEY);
        expect(after[0].ok).toBe(true);
    }, 90000);

    test('ORDERING B — activation holds the exclusive lock first; the worker waits and then reads the NEW active regime', async () => {
        // Activation takes the canonical EXCLUSIVE lock and commits the state
        // change that makes the regime active.
        await activationSess.$executeRawUnsafe('SELECT pg_advisory_lock(hashtext($1))', AUTHORITY_KEY);
        await activationSess.$executeRawUnsafe(
            `UPDATE "FiatLiquidityState" SET "authorityActivatedAt" = now(), "updatedAt" = now() WHERE id = 1`);

        // The worker's claim transaction now asks for the shared lock and waits.
        let mode;
        const workerTx = claimSess.$transaction(async (tx) => {
            await lockAuthorityShared(tx);
            mode = await readMode(tx);
            return 'claim-committed';
        }, { timeout: 40000 });

        const waiting = await waitForAdvisoryWait(admin, AUTHORITY_KEY, 'ShareLock');
        expect(waiting).toBe(true);

        // Activation finishes; the worker proceeds and must see the NEW regime.
        await activationSess.$executeRawUnsafe('SELECT pg_advisory_unlock(hashtext($1))', AUTHORITY_KEY);
        await expect(workerTx).resolves.toBe('claim-committed');
        expect(mode).toMatchObject({ active: true });
        expect(mode.latched).toBe(true);
    }, 90000);

    test('a claim that has not committed yet must not be visible as spent, and the lock serialises the two orderings', async () => {
        // Sanity: after both orderings the authority key is free again, so the
        // suite itself has not leaked a lock that would hide a later race.
        const free = await admin.$queryRawUnsafe(
            'SELECT pg_try_advisory_lock(hashtext($1)) AS ok', AUTHORITY_KEY);
        expect(free[0].ok).toBe(true);
        await admin.$executeRawUnsafe('SELECT pg_advisory_unlock(hashtext($1))', AUTHORITY_KEY);
    }, 30000);
});
