/**
 * §WP-H — AN IDENTITY FINDING MUST NOT HIDE THE STRUCTURAL FACTS.
 *
 * CI on df1998e7 failed the release-chain step "Verify authority boundary" with
 * verdict DRIFT and problems [RUNTIME_IS_SUPERUSER, SESSION_IDENTITY_PRIVILEGED],
 * while the same step on the #405 head reported NOT_PROVISIONED (ok:true) for the
 * same kind of database.
 *
 * The cause was mine: the connection-identity check returned EARLY, so the probe
 * never reached the table-ownership and missing-function checks. The verifier then
 * could not see that the boundary had never been provisioned and called it drift.
 * A real drift signal is worth blocking a release for; a truncated one is not.
 *
 * This is a pure unit test with a stubbed probe, so it asserts the ORDER OF
 * DISCOVERY, which is exactly what broke and what a database-dependent test cannot
 * pin down.
 */
'use strict';

const { inspectEnforcement, PROBLEM } = require('../src/services/authorityActivationEnforcement');

/**
 * A database where: the runtime identity is the superuser login itself (no split),
 * the session login is that same privileged login, the money table exists, and no
 * boundary object was ever installed.
 */
function neverProvisionedSuperuserDb() {
    return {
        $queryRawUnsafe: async (sql) => {
            if (sql.includes('session_user')) {
                return [{
                    runtime_role: 'postgres',
                    session_login: 'postgres',
                    runtime_superuser: true,
                    session_superuser: true,
                    session_createrole: true,
                    session_createdb: true,
                    session_replication: false,
                    session_bypassrls: true,
                    table_exists: true,
                }];
            }
            if (sql.includes('pg_get_userbyid(c.relowner)')) {
                return [{
                    owner: 'postgres',
                    can_select: true, can_insert: true, can_update: true,
                    can_delete: true, can_truncate: true, can_trigger: true,
                    member_of_owner: true,
                }];
            }
            // Neither the guard function nor the activation function exists.
            return [];
        },
    };
}

describe('§WP-H boundary verdict completeness', () => {
    test('a privileged session does not truncate the structural findings', async () => {
        const result = await inspectEnforcement(neverProvisionedSuperuserDb());

        expect(result.established).toBe(false);
        // The identity finding is present...
        expect(result.problems).toContain(PROBLEM.SESSION_IDENTITY_PRIVILEGED);
        // ...AND so are the structural facts that were previously skipped.
        expect(result.problems).toContain(PROBLEM.TRIGGER_FUNCTION_MISSING);
        expect(result.problems).toContain(PROBLEM.ACTIVATION_FUNCTION_MISSING);
        expect(result.problems).toContain(PROBLEM.RUNTIME_OWNS_TABLE);
    });

    test('the release-chain verifier calls that NOT_PROVISIONED, not DRIFT', async () => {
        const { verifyAuthorityBoundary } = require('../infra/verify-authority-boundary');
        const verdict = await verifyAuthorityBoundary(neverProvisionedSuperuserDb(), { strict: false });
        expect(verdict.verdict).toBe('NOT_PROVISIONED');
        expect(verdict.ok).toBe(true);
    });

    test('--strict still refuses to certify a never-provisioned boundary', async () => {
        const { verifyAuthorityBoundary } = require('../infra/verify-authority-boundary');
        const verdict = await verifyAuthorityBoundary(neverProvisionedSuperuserDb(), { strict: true });
        expect(verdict.verdict).toBe('NOT_PROVISIONED_STRICT');
        expect(verdict.ok).toBe(false);
    });
});
