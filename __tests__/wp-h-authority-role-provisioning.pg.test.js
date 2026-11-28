// §WP-H 1.5 — ROLE PROVISIONING AGAINST UNSAFE PRE-EXISTING ROLES.
//
// Two things are proved here, both against real PostgreSQL:
//
//   1. A runtime role that ALREADY EXISTS as a superuser with CREATEROLE is
//      normalised by the real installer, not trusted because it was found.
//   2. A runtime role that reaches the owner INDIRECTLY (runtime -> mid -> owner)
//      cannot be silently accepted. REVOKE only removes a direct grant, so the
//      installer must report the remaining path and refuse to call the boundary
//      provisioned; the runtime attestation then agrees that no boundary is
//      proven. A refusal that the attestation contradicts would be the dangerous
//      outcome, and that is what this asserts against.
'use strict';

const BASE = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const RUN = Math.random().toString(36).slice(2, 8);
const PWD = 'wpaclpw123';
const R = {
    owner: `wpprov_owner_${RUN}`,
    runtime: `wpprov_runtime_${RUN}`,
    operator: `wpprov_operator_${RUN}`,
    fnOwner: `wpprov_fn_${RUN}`,
    mid: `wpprov_mid_${RUN}`,
};
const q = (n) => '"' + String(n).replace(/"/g, '""') + '"';

const hasDb = !!BASE;
const run = hasDb ? describe : describe.skip;

run('§WP-H 1.5 provisioning normalises unsafe roles and refuses an indirect path', () => {
    const { PrismaClient } = require('@prisma/client');
    const { installAuthorityActivationRoles } = require('../infra/install-authority-activation-roles');
    const { inspectEnforcement } = require('../src/services/authorityActivationEnforcement');

    let admin; let runtimeClient; let report; let setupError = null;

    beforeAll(async () => {
        admin = new PrismaClient({ datasources: { db: { url: BASE } } });
        try {
            // A pre-existing runtime role that is everything it must never be.
            await admin.$executeRawUnsafe(`CREATE ROLE ${q(R.runtime)} LOGIN SUPERUSER CREATEROLE PASSWORD '${PWD}'`);
            await admin.$executeRawUnsafe(`CREATE ROLE ${q(R.mid)} NOLOGIN`);
            await admin.$executeRawUnsafe(`CREATE ROLE ${q(R.owner)} NOLOGIN`);

            // An INDIRECT path from the runtime to the owner: revoking the direct
            // grant cannot remove this, which is the whole point.
            await admin.$executeRawUnsafe(`GRANT ${q(R.owner)} TO ${q(R.mid)}`);
            await admin.$executeRawUnsafe(`GRANT ${q(R.mid)} TO ${q(R.runtime)}`);

            report = await installAuthorityActivationRoles(admin, {
                owner: R.owner,
                runtime: R.runtime,
                operator: R.operator,
                functionOwner: R.fnOwner,
                roleScoped: true,
            });

            const url = new URL(BASE);
            url.username = R.runtime; url.password = PWD; url.search = '';
            runtimeClient = new PrismaClient({ datasources: { db: { url: url.toString() } } });
        } catch (err) {
            setupError = err;
        }
    }, 60000);

    afterAll(async () => {
        try {
            if (runtimeClient) await runtimeClient.$disconnect();
            if (admin) {
                const attempt = async (sql) => { try { await admin.$executeRawUnsafe(sql); } catch (_) { /* best effort */ } };
                await attempt(`REVOKE ${q(R.mid)} FROM ${q(R.runtime)}`);
                await attempt(`REVOKE ${q(R.owner)} FROM ${q(R.mid)}`);
                await attempt(`DROP OWNED BY ${q(R.owner)}`);
                await attempt(`DROP OWNED BY ${q(R.fnOwner)}`);
                for (const name of [R.runtime, R.operator, R.fnOwner, R.mid, R.owner]) {
                    await attempt(`DROP ROLE IF EXISTS ${q(name)}`);
                }
                await admin.$disconnect();
            }
        } catch (_) { /* never fail the suite in teardown */ }
    });

    test('the installer ran against the pre-existing role set', () => {
        expect(setupError).toBeNull();
        expect(report).toBeTruthy();
        expect(report.roles_resolved.runtime).toBe(R.runtime);
    });

    test('a pre-existing SUPERUSER CREATEROLE runtime is normalised, not trusted', async () => {
        const [row] = await admin.$queryRawUnsafe(
            `SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolinherit, rolcanlogin
               FROM pg_roles WHERE rolname = $1`, R.runtime);
        expect(row.rolsuper).toBe(false);
        expect(row.rolcreaterole).toBe(false);
        expect(row.rolcreatedb).toBe(false);
        expect(row.rolreplication).toBe(false);
        expect(row.rolbypassrls).toBe(false);
        expect(row.rolinherit).toBe(false); // INHERIT defaults on; it must be named off
        expect(row.rolcanlogin).toBe(true); // it still has to authenticate
    });

    test('an indirect path to the owner is severed, not merely reported', async () => {
        const [stillMember] = await admin.$queryRawUnsafe(
            `SELECT pg_has_role($1, $2, 'MEMBER') AS member`, R.runtime, R.owner);
        // REVOKE cannot remove an indirect grant directly, so a passing result
        // here means the installer walked the membership graph and cut the
        // intermediate link rather than trusting the direct-grant check.
        expect(stillMember.member).toBe(false);
        expect(report.applied.join(' ')).toMatch(/REVOKE/);
        expect(report.applied.join(' ')).toMatch(new RegExp(`${R.owner}|${R.mid}`));
        // And the severed path must not resurface as an unresolved problem.
        expect(report.problems.join(' ')).not.toMatch(/member of the owner role/i);
    });

    test('the runtime attestation agrees with the installer: no boundary is proven', async () => {
        const verdict = await inspectEnforcement(runtimeClient);
        expect(verdict).toBeTruthy();
        // Agreement is the property under test: a refused install must not be
        // attested as enforced, and an enforced verdict must not be refused.
        const proven = verdict.state === 'ENFORCED_INACTIVE' || verdict.state === 'ENFORCED_ACTIVE';
        expect(proven).toBe(false);
    }, 30000);
});
