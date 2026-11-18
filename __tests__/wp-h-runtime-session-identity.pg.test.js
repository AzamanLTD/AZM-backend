/**
 * §WP-H B3 — THE RUNTIME BOUNDARY IS THE CONNECTION, NOT THE MASK.
 *
 * `current_user` is whatever SET ROLE last assumed. A superuser login that
 * assumes the restricted runtime role passes every current_user privilege check
 * while still holding a connection that can RESET ROLE at any instant. These are
 * real PostgreSQL logins, not stubs: roles are created, connected as, and the
 * inspector is asked whether it can prove the boundary.
 */
const { PrismaClient } = require('@prisma/client');
const { inspectEnforcement } = require('../src/services/authorityActivationEnforcement');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const RUNTIME = 'wph_runtime_probe';
const OTHER = 'wph_privileged_probe';

const ADMIN_PASSWORD = (DB_URL.match(/\/\/[^:]+:([^@]+)@/) || [])[1];
const urlFor = (user) => DB_URL.replace(/\/\/([^:]+):([^@]+)@/, `//${user}:${ADMIN_PASSWORD}@`);

describe('§WP-H runtime session identity (real PostgreSQL logins)', () => {
    let admin;
    let runtimeClient;
    let privilegedClient;
    let tableName;

    beforeAll(async () => {
        if (!DB_URL) throw new Error('TEST_DATABASE_URL or DATABASE_URL is required');
        admin = new PrismaClient({ datasources: { db: { url: DB_URL } } });
        await admin.$connect();

        // A CREATEROLE login is "privileged" for this proof without being a
        // superuser, so the test exercises the privilege check rather than
        // tripping the superuser rule first.
        await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RUNTIME}`);
        await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${OTHER}`);
        await admin.$executeRawUnsafe(`CREATE ROLE ${RUNTIME} LOGIN PASSWORD '${ADMIN_PASSWORD}'`);
        await admin.$executeRawUnsafe(`CREATE ROLE ${OTHER} LOGIN CREATEROLE PASSWORD '${ADMIN_PASSWORD}'`);
        // The privileged login can assume the runtime role: this is exactly the
        // masquerade a role membership makes possible in production, and the
        // reason current_user alone can never prove the boundary.
        await admin.$executeRawUnsafe(`GRANT ${RUNTIME} TO ${OTHER}`);

        const [t] = await admin.$queryRawUnsafe(
            `SELECT to_regclass('public."FiatLiquidityActivation"')::text AS name`);
        tableName = t && t.name ? t.name : null;

        runtimeClient = new PrismaClient({ datasources: { db: { url: urlFor(RUNTIME) } } });
        privilegedClient = new PrismaClient({ datasources: { db: { url: urlFor(OTHER) } } });
        await Promise.all([runtimeClient.$connect(), privilegedClient.$connect()]);
    }, 60000);

    afterAll(async () => {
        await Promise.allSettled([
            runtimeClient && runtimeClient.$disconnect(),
            privilegedClient && privilegedClient.$disconnect(),
        ]);
        try {
            await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RUNTIME}`);
            await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${OTHER}`);
        } catch (_) { /* best effort */ }
        await admin.$disconnect();
    });

    test('the authenticated runtime login is accepted as its own identity', async () => {
        const res = await inspectEnforcement(runtimeClient);
        const [who] = await runtimeClient.$queryRawUnsafe(
            'SELECT session_user AS s, current_user AS c');
        expect(who.s).toBe(RUNTIME);
        expect(who.c).toBe(RUNTIME);
        // The probe must have got far enough to name both identities.
        expect(res.diagnostics.sessionLogin).toBe(RUNTIME);
        expect(res.diagnostics.runtimeRole).toBe(RUNTIME);
        // Whatever else it finds about this ad-hoc role, the identity itself is
        // not the reason for a refusal.
        expect(res.problems).not.toContain('RUNTIME_IDENTITY_ASSUMED');
        expect(res.problems).not.toContain('SESSION_IDENTITY_PRIVILEGED');
        expect(res.problems).not.toContain('SESSION_IDENTITY_UNPROVABLE');
    }, 60000);

    test('a privileged login that SET ROLE runtime is refused: the session identity is not the runtime identity', async () => {
        await privilegedClient.$executeRawUnsafe(`SET ROLE ${RUNTIME}`);
        try {
            const [who] = await privilegedClient.$queryRawUnsafe(
                'SELECT session_user AS s, current_user AS c');
            // The mask is exactly the situation the old probe could not see.
            expect(who.c).toBe(RUNTIME);
            expect(who.s).toBe(OTHER);

            const res = await inspectEnforcement(privilegedClient);
            expect(res.established).toBe(false);
            expect(res.problems).toContain('RUNTIME_IDENTITY_ASSUMED');
        } finally {
            await privilegedClient.$executeRawUnsafe('RESET ROLE');
        }
    }, 60000);

    test('after RESET ROLE the privileged login is refused by its own identity, not accepted as runtime', async () => {
        const [who] = await privilegedClient.$queryRawUnsafe(
            'SELECT session_user AS s, current_user AS c');
        expect(who.s).toBe(OTHER);
        expect(who.c).toBe(OTHER);

        const res = await inspectEnforcement(privilegedClient);
        expect(res.established).toBe(false);
        // Identity now agrees (no mask), so the refusal must come from the
        // LACK OF PRIVILEGE TO RUN AN ECONOMIC BOUNDARY, not from the mask rule.
        expect(res.problems).not.toContain('RUNTIME_IDENTITY_ASSUMED');
        expect(res.problems.length).toBeGreaterThan(0);
    }, 60000);
});
