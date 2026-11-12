// __tests__/p5e-enforced-authority-activation.pg.test.js
// =============================================================================
// §WP-E — THE AUTHORITY BOUNDARY IS PROVED WITH SEPARATED POSTGRESQL ROLES.
//
// Two Prisma clients pointed at the same login prove nothing about privilege
// separation. This suite therefore provisions FOUR DISTINCT ROLES on a real
// PostgreSQL server and drives the real migration and the real installer:
//
//   <sfx>_migrator  LOGIN  — applies prisma/migrations/20261110230000_... as the
//                            intended migration role and initially owns the table
//   <sfx>_owner     NOLOGIN— the dedicated owner the installer re-parents to
//   <sfx>_runtime   LOGIN  — the application runtime role: SELECT only
//   <sfx>_operator  LOGIN  — the separate activation authority: SELECT+INSERT
//
// TEST ORDER IS LOAD-BEARING and is asserted in the names: the gate is checked
// closed before activation, the legacy timestamp is proved inert, then the
// operator activates once, and only then is the gate required to be active. The
// suite is written to run with --runInBand; do not parallelise it against itself.
//
// FAIL CLOSED: a missing TEST_DATABASE_URL fails in CI (never skips to green),
// and a database that cannot create the four roles fails the suite with the
// provisioning requirement instead of passing vacuously.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const enforcement = require('../src/services/authorityActivationEnforcement');
const {
    installAuthorityActivationRoles,
    splitSqlStatements,
} = require('../infra/install-authority-activation-roles');

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const IS_CI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
const run = ADMIN_URL ? describe : describe.skip;

const MIGRATION_SQL = fs.readFileSync(
    path.join(__dirname, '..', 'prisma', 'migrations',
        '20261110230000_p5d_enforced_authority_activation', 'migration.sql'),
    'utf8'
);

if (!ADMIN_URL) {
    console.warn('[p5e] TEST_DATABASE_URL not set — skipping the role-separation proofs.');
}
if (!ADMIN_URL && IS_CI) {
    test('WP-E CI configuration: TEST_DATABASE_URL must be set', () => {
        throw new Error(
            'TEST_DATABASE_URL is not set in CI. The WP-E privilege-separation proofs cannot run, and a '
            + 'skipped suite must never be reported as a passing build.',
        );
    });
}

const SFX = `wpe${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const ROLE = {
    migrator: `${SFX}_migrator`,
    owner: `${SFX}_owner`,
    runtime: `${SFX}_runtime`,
    operator: `${SFX}_operator`,
};
const PASSWORD = `${SFX}${Math.random().toString(36).slice(2)}Aa1!`;

/** Build a connection URL for a role from the admin URL's own coordinates. */
function urlFor(role) {
    const parsed = new URL(ADMIN_URL);
    parsed.username = role;
    parsed.password = PASSWORD;
    return parsed.toString();
}

function q(name) {
    return `"${name.replace(/"/g, '""')}"`;
}

async function createRole(admin, name, { login }) {
    const exists = await admin.$queryRawUnsafe('SELECT 1 AS ok FROM pg_roles WHERE rolname = $1', name);
    if (exists.length > 0) return;
    await admin.$executeRawUnsafe(
        `CREATE ROLE ${q(name)} ${login ? 'LOGIN' : 'NOLOGIN'} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${PASSWORD}'`
    );
}

run('WP-E — database-enforced, append-only authority activation', () => {
    let admin;
    let migrator;
    let runtime;
    let operator;
    let sessionOperator = null;
    let activationRecord = null;

    beforeAll(async () => {
        admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });

        // ── provisioning preconditions: fail loudly, never pass vacuously ────
        const [who] = await admin.$queryRawUnsafe(
            `SELECT current_user AS role,
                    (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
                    (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) AS can_create_role`
        );
        if (who.is_superuser !== true && who.can_create_role !== true) {
            throw new Error(
                `WP-E requires a database principal that may CREATE ROLE and re-own the activation table; `
                + `"${who.role}" has neither. Provision a role-provisioning principal for this suite — `
                + `skipping would report an unproved boundary as passing.`
            );
        }

        // The migration role must be able to create objects in `public`.
        // Credentials are the deployment's business, not the migration's: this
        // suite provisions the login roles itself, exactly as a DBA would.
        await createRole(admin, ROLE.migrator, { login: true });
        await createRole(admin, ROLE.runtime, { login: true });
        await createRole(admin, ROLE.operator, { login: true });
        await admin.$executeRawUnsafe(`GRANT CREATE, USAGE ON SCHEMA public TO ${q(ROLE.migrator)}`);
        await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${q(ROLE.migrator)}`);

        // Clean slate: this suite owns the activation record's lifecycle.
        await admin.$executeRawUnsafe('DROP TABLE IF EXISTS "FiatLiquidityAuthorityActivation" CASCADE');
        await admin.$executeRawUnsafe('DROP FUNCTION IF EXISTS azm_authority_activation_immutable() CASCADE');

        // ── the REAL migration, run as the migration role ───────────────────
        migrator = new PrismaClient({ datasources: { db: { url: urlFor(ROLE.migrator) } } });
        for (const statement of splitSqlStatements(MIGRATION_SQL)) {
            // eslint-disable-next-line no-await-in-loop
            await migrator.$executeRawUnsafe(statement);
        }
        const [created] = await admin.$queryRawUnsafe(
            `SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c
              WHERE c.oid = to_regclass('public."FiatLiquidityAuthorityActivation"')`
        );
        expect(created.owner).toBe(ROLE.migrator); // migration role owns it first

        // ── the controlled provisioning step (roles + ownership + grants) ────
        const report = await installAuthorityActivationRoles(admin, {
            owner: ROLE.owner,
            runtime: ROLE.runtime,
            operator: ROLE.operator,
        });
        expect(report.problems).toEqual([]);
        expect(report.ok).toBe(true);
        expect(report.privileges.runtime).toMatchObject({
            select: true, insert: false, update: false, delete: false, truncate: false, trigger: false,
        });
        expect(report.privileges.operator).toMatchObject({
            // §WP-H: the operator no longer INSERTs the record directly; its write
            // path is EXECUTE on public.azm_authority_activate().
            select: true, insert: false, update: false, delete: false, truncate: false,
        });

        runtime = new PrismaClient({ datasources: { db: { url: urlFor(ROLE.runtime) } } });
        operator = new PrismaClient({ datasources: { db: { url: urlFor(ROLE.operator) } } });
    }, 120000);

    afterAll(async () => {
        try {
            for (const client of [runtime, operator, migrator]) {
                if (client) await client.$disconnect();
            }
            if (admin) {
                await admin.$executeRawUnsafe('DROP TABLE IF EXISTS "FiatLiquidityAuthorityActivation" CASCADE');
                await admin.$executeRawUnsafe('DROP FUNCTION IF EXISTS azm_authority_activation_immutable() CASCADE');
                for (const role of [ROLE.runtime, ROLE.operator, ROLE.migrator, ROLE.owner]) {
                    await admin.$executeRawUnsafe(`DROP OWNED BY ${q(role)} CASCADE`).catch(() => {});
                    await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${q(role)}`).catch(() => {});
                }
                // Leave the legacy latch exactly as this suite found it.
                await admin.$executeRawUnsafe('UPDATE "FiatLiquidityState" SET "authorityActivatedAt" = NULL WHERE "id" = 1').catch(() => {});
                await admin.$executeRawUnsafe('UPDATE "GlobalSettings" SET "fiatLiquidityAuthorityEnabled" = false WHERE "id" = 1').catch(() => {});
                await admin.$disconnect();
            }
        } catch (_) { /* cleanup is best effort; a failure here must not mask a proof */ }
    });

    // ── 1. the runtime role can read the activation state ───────────────────
    test('1. the runtime role can SELECT the activation record', async () => {
        const rows = await runtime.$queryRawUnsafe('SELECT count(*)::int AS n FROM "FiatLiquidityAuthorityActivation"');
        expect(rows[0].n).toBe(0);
        expect(await enforcement.readActivationRecord(runtime)).toBeNull();
    });

    // ── 2-5. no DML, in any form ────────────────────────────────────────────
    test('2. the runtime role cannot INSERT', async () => {
        await expect(runtime.$executeRawUnsafe(
            `INSERT INTO "FiatLiquidityAuthorityActivation" ("id","activatedBy","approvedBy","evidenceReference","evidenceDigest")
             VALUES (1,'runtime','runtime','runtime-self-activation','${'a'.repeat(64)}')`
        )).rejects.toThrow(/permission denied|insufficient_privilege/i);
        const rows = await admin.$queryRawUnsafe('SELECT count(*)::int AS n FROM "FiatLiquidityAuthorityActivation"');
        expect(rows[0].n).toBe(0);
    });

    test('3. the runtime role cannot UPDATE', async () => {
        await expect(runtime.$executeRawUnsafe(
            `UPDATE "FiatLiquidityAuthorityActivation" SET "approvedBy" = 'runtime' WHERE "id" = 1`
        )).rejects.toThrow(/permission denied|insufficient_privilege/i);
    });

    test('4. the runtime role cannot DELETE', async () => {
        await expect(runtime.$executeRawUnsafe('DELETE FROM "FiatLiquidityAuthorityActivation"')).rejects.toThrow(
            /permission denied|insufficient_privilege/i
        );
    });

    test('5. the runtime role cannot TRUNCATE', async () => {
        await expect(runtime.$executeRawUnsafe('TRUNCATE TABLE "FiatLiquidityAuthorityActivation"')).rejects.toThrow(
            /permission denied|must be owner|insufficient_privilege/i
        );
    });

    // ── 6. no DDL, and the immutability triggers cannot be switched off ─────
    test('6. the runtime role cannot alter, drop, or disable the triggers on the table', async () => {
        await expect(runtime.$executeRawUnsafe('ALTER TABLE "FiatLiquidityAuthorityActivation" DISABLE TRIGGER ALL'))
            .rejects.toThrow(/permission denied|must be owner/i);
        await expect(runtime.$executeRawUnsafe('DROP TRIGGER "FiatLiquidityAuthorityActivation_no_update" ON "FiatLiquidityAuthorityActivation"'))
            .rejects.toThrow(/permission denied|must be owner/i);
        await expect(runtime.$executeRawUnsafe(`ALTER TABLE "FiatLiquidityAuthorityActivation" OWNER TO ${q(ROLE.runtime)}`))
            .rejects.toThrow(/permission denied|must be owner/i);
        await expect(runtime.$executeRawUnsafe('DROP TABLE "FiatLiquidityAuthorityActivation"')).rejects.toThrow(
            /permission denied|must be owner/i
        );
        // The table and all three triggers survived every attempt.
        const triggers = await admin.$queryRawUnsafe(
            `SELECT tgname FROM pg_trigger WHERE tgrelid = to_regclass('public."FiatLiquidityAuthorityActivation"') AND NOT tgisinternal ORDER BY tgname`
        );
        expect(triggers.map((t) => t.tgname).sort()).toEqual([
            'FiatLiquidityAuthorityActivation_no_delete',
            'FiatLiquidityAuthorityActivation_no_truncate',
            'FiatLiquidityAuthorityActivation_no_update',
        ]);
    });

    // ── 7. no privilege escalation by role assumption ───────────────────────
    test('7. the runtime role cannot SET ROLE to the owner or the operator', async () => {
        await expect(runtime.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE ${q(ROLE.owner)}`);
        })).rejects.toThrow(/permission denied/i);

        await expect(runtime.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE ${q(ROLE.operator)}`);
        })).rejects.toThrow(/permission denied/i);

        const [membership] = await admin.$queryRawUnsafe(
            `SELECT pg_has_role($1, $2, 'MEMBER') AS owner_member,
                    pg_has_role($1, $3, 'MEMBER') AS operator_member`,
            ROLE.runtime, ROLE.owner, ROLE.operator
        );
        expect(membership.owner_member).toBe(false);
        expect(membership.operator_member).toBe(false);
    });

    // ── 11. application code reports INACTIVE before activation ─────────────
    test('11. the gate reports inactive while no activation record exists', async () => {
        const gate = await enforcement.readEnforcedAuthority(runtime);
        expect(gate.enforcedActive).toBe(false);
        expect(gate.enforcementEstablished).toBe(true); // separation IS established
        expect(gate.reason).toBe(enforcement.REASON.NOT_ACTIVATED);
        expect(gate.problems).toEqual([]);
    });

    // ── 14. a legacy mutable timestamp is not an activation authority ───────
    test('14. a legacy authorityActivatedAt timestamp does not activate the gate', async () => {
        await admin.$executeRawUnsafe(
            `INSERT INTO "FiatLiquidityState" ("id","availableGhs","reservedGhs","inTransitGhs","paidOutGhs","reconciliationHeldGhs","updatedAt","authorityActivatedAt")
             VALUES (1,0,0,0,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
             ON CONFLICT ("id") DO UPDATE SET "authorityActivatedAt" = CURRENT_TIMESTAMP`
        );
        await admin.$executeRawUnsafe(
            `INSERT INTO "GlobalSettings" ("id","fiatLiquidityAuthorityEnabled","updatedAt") VALUES (1,true,CURRENT_TIMESTAMP)
             ON CONFLICT ("id") DO UPDATE SET "fiatLiquidityAuthorityEnabled" = true`
        ).catch(async () => {
            await admin.$executeRawUnsafe('UPDATE "GlobalSettings" SET "fiatLiquidityAuthorityEnabled" = true WHERE "id" = 1');
        });

        const gate = await enforcement.readEnforcedAuthority(runtime);
        expect(gate.enforcedActive).toBe(false);
        expect(gate.reason).toBe(enforcement.REASON.NOT_ACTIVATED);
        expect(gate.activation).toBeNull();

        // assertEnforcedAuthority refuses rather than falling back to the latch
        await expect(enforcement.assertEnforcedAuthority(runtime)).rejects.toMatchObject({
            code: 'AUTHORITY_ENFORCEMENT_UNAVAILABLE',
            statusCode: 503,
        });

        await admin.$executeRawUnsafe('UPDATE "FiatLiquidityState" SET "authorityActivatedAt" = NULL WHERE "id" = 1');
    });

    // ── 8. the one permitted activation ─────────────────────────────────────
    test('8. the activation role performs the one permitted activation', async () => {
        // §WP-H: the operator no longer INSERTs the record. The sanctioned path is
        // the SECURITY DEFINER function, which writes the record, the latch, the
        // flag, the projection and the audit row in one transaction.
        const [session] = await operator.$queryRawUnsafe('SELECT session_user AS s');
        await operator.$queryRawUnsafe(
            `SELECT public.azm_authority_activate($1,$2,$3,$4,$5)`,
            session.s, 'human-approver', 'p5e permitted activation', 'EXT-EVIDENCE-0001', 'b'.repeat(64),
        );
        sessionOperator = session.s;
        activationRecord = await enforcement.readActivationRecord(operator);
        expect(activationRecord.id).toBe(1);
        expect(activationRecord.approvedBy).toBe('human-approver');
        expect(String(activationRecord.evidenceDigest)).toBe('b'.repeat(64));
        expect(activationRecord.activatedAt).toBeInstanceOf(Date);
    });

    // ── 10. one activation only: it cannot be replaced ──────────────────────
    test('10. a second activation cannot replace the first', async () => {
        // The function refuses a second activation; the direct INSERT route is gone
        // (the operator holds no INSERT), so this is the only reachable path.
        await expect(operator.$queryRawUnsafe(
            `SELECT public.azm_authority_activate($1,'second','second','EXT-EVIDENCE-0002',$2)`,
            sessionOperator, 'c'.repeat(64)
        )).rejects.toThrow(/ALREADY_ACTIVATED|already exists|23505/i);
        await expect(operator.$executeRawUnsafe(
            `INSERT INTO "FiatLiquidityAuthorityActivation" ("id","activatedBy","approvedBy","evidenceReference","evidenceDigest")
             VALUES (2,'second','second','EXT-EVIDENCE-0002','${'c'.repeat(64)}')`
        )).rejects.toThrow(/permission denied|insufficient_privilege|42501/i);

        const rows = await admin.$queryRawUnsafe('SELECT count(*)::int AS n FROM "FiatLiquidityAuthorityActivation"');
        expect(rows[0].n).toBe(1);
        const after = await enforcement.readActivationRecord(operator);
        expect(after.evidenceReference).toBe('EXT-EVIDENCE-0001');
        expect(String(after.evidenceDigest)).toBe('b'.repeat(64));
    });

    // ── 9. the activation role cannot rewrite or delete what it recorded ────
    test('9. the activation role cannot UPDATE or DELETE the record it created', async () => {
        await expect(operator.$executeRawUnsafe(
            `UPDATE "FiatLiquidityAuthorityActivation" SET "approvedBy" = 'someone-else' WHERE "id" = 1`
        )).rejects.toThrow(/permission denied|insufficient_privilege/i);

        await expect(operator.$executeRawUnsafe('DELETE FROM "FiatLiquidityAuthorityActivation" WHERE "id" = 1'))
            .rejects.toThrow(/permission denied|insufficient_privilege/i);

        await expect(operator.$executeRawUnsafe('TRUNCATE TABLE "FiatLiquidityAuthorityActivation"'))
            .rejects.toThrow(/permission denied|must be owner/i);

        const after = await enforcement.readActivationRecord(operator);
        expect(after.approvedBy).toBe('human-approver');
    });

    // ── 12. the gate reports active only with the record AND the checks ─────
    test('12. the gate reports active only after activation with enforcement observed', async () => {
        const gate = await enforcement.readEnforcedAuthority(runtime);
        expect(gate.enforcementEstablished).toBe(true);
        expect(gate.problems).toEqual([]);
        expect(gate.reason).toBe(enforcement.REASON.ACTIVE);
        expect(gate.enforcedActive).toBe(true);
        expect(gate.activation.evidenceReference).toBe('EXT-EVIDENCE-0001');

        const asserted = await enforcement.assertEnforcedAuthority(runtime);
        expect(asserted.enforcedActive).toBe(true);
    });

    // ── 15. a role/configuration mismatch cannot produce a false active ─────
    test('15. a runtime role that could mutate the record reports INACTIVE, not active', async () => {
        // (a) a superuser connection: ownership and privilege checks cannot be
        //     satisfied by definition, so the gate must stay closed.
        const asAdmin = await enforcement.readEnforcedAuthority(admin);
        expect(asAdmin.enforcedActive).toBe(false);
        expect(asAdmin.reason).toBe(enforcement.REASON.ENFORCEMENT_UNAVAILABLE);
        expect(asAdmin.problems).toContain(enforcement.PROBLEM.RUNTIME_IS_SUPERUSER);

        // (b) a runtime role that is granted INSERT — the exact weakening this
        //     work package forbids — must also close the gate.
        await admin.$executeRawUnsafe(`GRANT INSERT ON TABLE "FiatLiquidityAuthorityActivation" TO ${q(ROLE.runtime)}`);
        try {
            const weakened = await enforcement.readEnforcedAuthority(runtime);
            expect(weakened.enforcedActive).toBe(false);
            expect(weakened.problems).toContain(enforcement.PROBLEM.RUNTIME_CAN_INSERT);
        } finally {
            await admin.$executeRawUnsafe(`REVOKE INSERT ON TABLE "FiatLiquidityAuthorityActivation" FROM ${q(ROLE.runtime)}`);
        }

        // (c) restoring least privilege restores the verdict.
        const restored = await enforcement.readEnforcedAuthority(runtime);
        expect(restored.enforcedActive).toBe(true);
    });

    // ── 13. fail closed when the record is absent or unreadable ─────────────
    test('13. the gate fails closed when the activation table is absent or unreadable', async () => {
        await admin.$executeRawUnsafe('ALTER TABLE "FiatLiquidityAuthorityActivation" RENAME TO "FiatLiquidityAuthorityActivation_hidden"');
        try {
            const missing = await enforcement.readEnforcedAuthority(runtime);
            expect(missing.enforcedActive).toBe(false);
            expect(missing.reason).toBe(enforcement.REASON.TABLE_MISSING);
            await expect(enforcement.assertEnforcedAuthority(runtime)).rejects.toMatchObject({
                code: 'AUTHORITY_ENFORCEMENT_UNAVAILABLE',
            });
        } finally {
            await admin.$executeRawUnsafe('ALTER TABLE "FiatLiquidityAuthorityActivation_hidden" RENAME TO "FiatLiquidityAuthorityActivation"');
        }

        await admin.$executeRawUnsafe(`REVOKE SELECT ON TABLE "FiatLiquidityAuthorityActivation" FROM ${q(ROLE.runtime)}`);
        try {
            const unreadable = await enforcement.readEnforcedAuthority(runtime);
            expect(unreadable.enforcedActive).toBe(false);
            expect(unreadable.problems.some((p) => p.startsWith('RUNTIME_CANNOT_READ') || p.startsWith('ENFORCEMENT_PROBE_FAILED'))).toBe(true);
        } finally {
            await admin.$executeRawUnsafe(`GRANT SELECT ON TABLE "FiatLiquidityAuthorityActivation" TO ${q(ROLE.runtime)}`);
        }

        expect((await enforcement.readEnforcedAuthority(runtime)).enforcedActive).toBe(true);
    });
});
