// §WP-H A — ADVERSARIAL MATRIX FOR THE RUNTIME BOUNDARY ATTESTATION.
//
// Every case here mutates a REAL PostgreSQL catalog through a superuser, then
// asks the runtime (logged in as the actual runtime role) whether it still
// believes the boundary is enforced. The point is that the attestation is a
// RUNTIME survey, not a record of installer success: each mutation is applied
// AFTER provisioning, exactly as later drift would be.
//
// Each case also REVERTS and re-asserts a clean boundary, so the suite cannot
// pass by refusing everything.
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const RUN = Math.random().toString(36).slice(2, 8);
const DB = `azm_wph_attest_${RUN}`;
const PWD = 'wphpass123';
const ROLE = {
    owner: `wpatt_owner_${RUN}`,
    fnOwner: `wpatt_fnowner_${RUN}`,
    runtime: `wpatt_runtime_${RUN}`,
    operator: `wpatt_operator_${RUN}`,
    foreign: `wpatt_foreign_${RUN}`,
    chain: `wpatt_chain_${RUN}`,
};
const TABLE = 'public."FiatLiquidityAuthorityActivation"';
const TRIGGER_FN = 'public.azm_authority_activation_immutable()';
const ACTIVATE_FN = 'public.azm_authority_activate(text,text,text,text,text)';

const urlFor = (role, db) => {
    const u = new URL(BASE);
    if (role) { u.username = role; u.password = PWD; }
    u.pathname = `/${db}`;
    u.search = '';
    return u.toString();
};

const hasDb = !!BASE;
const run = hasDb ? describe : describe.skip;

run('WP-H boundary attestation — adversarial (real PostgreSQL)', () => {
    const { PrismaClient } = require('@prisma/client');
    const el = (n) => `"${n}"`;

    let admin; let adminPg; let runtime; let inspectEnforcement;
    let setupError = null;

/** The canonical three guards, straight from the shipped migration. */
    const healGuards = async () => {
        const guards = [
            ['FiatLiquidityAuthorityActivation_no_update', 'BEFORE UPDATE ON', 'FOR EACH ROW'],
            ['FiatLiquidityAuthorityActivation_no_delete', 'BEFORE DELETE ON', 'FOR EACH ROW'],
            ['FiatLiquidityAuthorityActivation_no_truncate', 'BEFORE TRUNCATE ON', 'FOR EACH STATEMENT'],
        ];
        for (const [name, timing, scope] of guards) {
            await admin.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${name}" ON ${TABLE}`);
            await admin.$executeRawUnsafe(
                `CREATE TRIGGER "${name}" ${timing} ${TABLE} ${scope} EXECUTE FUNCTION ${TRIGGER_FN}`);
        }
    };

    const problemsNow = async () => {
        const result = await inspectEnforcement(runtime);
        return { result, problems: (result && result.problems) || [] };
    };

    beforeAll(async () => {
        process.env.AUTHORITY_OWNER_ROLE = ROLE.owner;
        process.env.AUTHORITY_RUNTIME_ROLE = ROLE.runtime;
        process.env.AUTHORITY_OPERATOR_ROLE = ROLE.operator;
        process.env.AUTHORITY_FN_OWNER_ROLE = ROLE.fnOwner;

        adminPg = new PrismaClient({ datasources: { db: { url: urlFor(null, 'postgres') } } });
        await adminPg.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${el(DB)} WITH (FORCE)`);
        await adminPg.$executeRawUnsafe(`CREATE DATABASE ${el(DB)}`);
        admin = new PrismaClient({ datasources: { db: { url: urlFor(null, DB) } } });

        for (const [key, name] of Object.entries(ROLE)) {
            const login = ['runtime', 'operator', 'foreign', 'chain'].includes(key);
            await admin.$executeRawUnsafe(
                `CREATE ROLE ${el(name)} ${login ? 'LOGIN' : 'NOLOGIN'} PASSWORD '${PWD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
        }
        for (const ddl of [
            `CREATE TABLE "GlobalSettings" ("id" int PRIMARY KEY, "fiatLiquidityAuthorityEnabled" boolean NOT NULL DEFAULT false)`,
            `CREATE TABLE "FiatLiquidityState" ("id" int PRIMARY KEY, "authorityActivatedAt" timestamp, "availableGhs" numeric(20,2) NOT NULL DEFAULT 0, "reservedGhs" numeric(20,2) NOT NULL DEFAULT 0, "inTransitGhs" numeric(20,2) NOT NULL DEFAULT 0, "paidOutGhs" numeric(20,2) NOT NULL DEFAULT 0, "reconciliationHeldGhs" numeric(20,2) NOT NULL DEFAULT 0)`,
            `CREATE TABLE "SystemFiatPool" ("id" int PRIMARY KEY, "balance" numeric(20,2) NOT NULL DEFAULT 0)`,
            `CREATE TABLE "Withdrawal" ("id" serial PRIMARY KEY, "status" text, "payoutMethod" text, "amount" numeric(20,2), "settlementCurrency" text, "transactionHistoryId" int)`,
            `CREATE TABLE "TransactionHistory" ("id" serial PRIMARY KEY, "type" text, "status" text, "txHash" text)`,
            `CREATE TABLE "FiatLiquidityReservation" ("id" serial PRIMARY KEY, "reference" text, "relatedTransactionId" int)`,
            `CREATE TABLE "AdminSettingsAuditLog" ("id" text PRIMARY KEY, "adminId" int NOT NULL, "adminName" text, "action" text NOT NULL, "targetType" text NOT NULL, "targetId" text, "changes" jsonb NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now())`,
            `CREATE TABLE "CustomerBankAccount" ("id" serial PRIMARY KEY, "userId" int, "accountNumber" text, "bankName" text)`,
        ]) await admin.$executeRawUnsafe(ddl);

        const sql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'migrations',
            '20261110230000_p5d_enforced_authority_activation', 'migration.sql'), 'utf8');
        require('child_process').execFileSync('psql', [urlFor(null, DB), '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], { input: sql });

        await admin.$executeRawUnsafe(`ALTER TABLE ${TABLE} OWNER TO ${el(ROLE.owner)}`);
        await admin.$executeRawUnsafe(`ALTER FUNCTION ${TRIGGER_FN} OWNER TO ${el(ROLE.owner)}`);
        await admin.$executeRawUnsafe(
            `GRANT USAGE ON SCHEMA public TO ${el(ROLE.runtime)}, ${el(ROLE.operator)}`);
        await admin.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${el(ROLE.runtime)}`);
        await admin.$executeRawUnsafe(`INSERT INTO "GlobalSettings" ("id") VALUES (1)`);
        await admin.$executeRawUnsafe(`INSERT INTO "FiatLiquidityState" ("id", "availableGhs") VALUES (1, 5000)`);
        await admin.$executeRawUnsafe(`INSERT INTO "SystemFiatPool" ("id", "balance") VALUES (1, 42)`);

        runtime = new PrismaClient({ datasources: { db: { url: urlFor(ROLE.runtime, DB) } } });

        try {
            const { installAuthorityActivationRoles } = require('../infra/install-authority-activation-roles');
            await installAuthorityActivationRoles(admin, {
                owner: ROLE.owner,
                runtime: ROLE.runtime,
                operator: ROLE.operator,
                functionOwner: ROLE.fnOwner,
                log: () => {},
            });
            ({ inspectEnforcement } = require('../src/services/authorityActivationEnforcement'));
            await healGuards();
        } catch (err) {
            setupError = err.message;
        }
    }, 240000);

    afterAll(async () => {
        for (const c of [runtime, admin, adminPg]) { try { await c.$disconnect(); } catch (_) {} }
        try {
            const cleanup = new PrismaClient({ datasources: { db: { url: urlFor(null, 'postgres') } } });
            await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${el(DB)} WITH (FORCE)`);
            for (const name of Object.values(ROLE)) await cleanup.$executeRawUnsafe(`DROP ROLE IF EXISTS ${el(name)}`);
            await cleanup.$disconnect();
        } catch (_) {}
    }, 60000);


    

    const t = (name, fn, ms = 60000) => test(name, async () => {
        expect(setupError).toBeNull();
        await fn();
    }, ms);

    /**
     * Apply a mutation, require the gate to see it, revert, require clean again.
     * `expectProblem` is a substring; the whole matrix is asserted the same way
     * so no case can pass by silently producing a different refusal.
     */
    const mutates = (label, apply, expectProblem, revert) => t(`${label} → refused`, async () => {
        await apply();
        try {
            const { result, problems } = await problemsNow();
            expect(result.established).toBe(false);
            expect(problems.some((p) => String(p).includes(expectProblem))).toBe(true);
        } finally {
            await revert();
            await healGuards();
        }
        const after = await problemsNow();
        expect(after.problems).toEqual([]);
        expect(after.result.established).toBe(true);
    });

    t('the provisioned boundary is established, with no findings', async () => {
        const { result, problems } = await problemsNow();
        expect(problems).toEqual([]);
        expect(result.established).toBe(true);
    });

    // ── owner role attributes ────────────────────────────────────────────────
    for (const attr of ['LOGIN', 'SUPERUSER', 'CREATEDB', 'CREATEROLE', 'REPLICATION', 'BYPASSRLS', 'INHERIT']) {
        mutates(
            `owner role gains ${attr}`,
            () => admin.$executeRawUnsafe(`ALTER ROLE ${el(ROLE.owner)} ${attr}`),
            `ROLE_ATTRIBUTE_UNSAFE:owner:${attr}`,
            () => admin.$executeRawUnsafe(`ALTER ROLE ${el(ROLE.owner)} NO${attr}`),
        );
    }

    // ── memberships, including the indirect path ─────────────────────────────
    mutates(
        'a role is granted the owner directly',
        () => admin.$executeRawUnsafe(`GRANT ${el(ROLE.owner)} TO ${el(ROLE.foreign)}`),
        `ROLE_HAS_MEMBER:owner:${ROLE.foreign}`,
        () => admin.$executeRawUnsafe(`REVOKE ${el(ROLE.owner)} FROM ${el(ROLE.foreign)}`),
    );

    mutates(
        'the owner is reachable INDIRECTLY through a chain',
        async () => {
            await admin.$executeRawUnsafe(`GRANT ${el(ROLE.owner)} TO ${el(ROLE.chain)}`);
            await admin.$executeRawUnsafe(`GRANT ${el(ROLE.chain)} TO ${el(ROLE.foreign)}`);
        },
        `ROLE_HAS_MEMBER:owner:${ROLE.foreign}`,
        async () => {
            await admin.$executeRawUnsafe(`REVOKE ${el(ROLE.chain)} FROM ${el(ROLE.foreign)}`);
            await admin.$executeRawUnsafe(`REVOKE ${el(ROLE.owner)} FROM ${el(ROLE.chain)}`);
        },
    );

    mutates(
        'the function owner is granted to another role',
        () => admin.$executeRawUnsafe(`GRANT ${el(ROLE.fnOwner)} TO ${el(ROLE.foreign)}`),
        `ROLE_HAS_MEMBER:functionOwner:${ROLE.foreign}`,
        () => admin.$executeRawUnsafe(`REVOKE ${el(ROLE.fnOwner)} FROM ${el(ROLE.foreign)}`),
    );

    // ── trigger function ownership ───────────────────────────────────────────
    mutates(
        'the trigger function is re-owned to the runtime',
        () => admin.$executeRawUnsafe(`ALTER FUNCTION ${TRIGGER_FN} OWNER TO ${el(ROLE.runtime)}`),
        'TRIGGER_FUNCTION_OWNER_NOT_TABLE_OWNER',
        () => admin.$executeRawUnsafe(`ALTER FUNCTION ${TRIGGER_FN} OWNER TO ${el(ROLE.owner)}`),
    );

    // ── trigger bindings ─────────────────────────────────────────────────────
    mutates(
        'the delete guard becomes an AFTER trigger',
        async () => {
            await admin.$executeRawUnsafe(`DROP TRIGGER "FiatLiquidityAuthorityActivation_no_delete" ON ${TABLE}`);
            await admin.$executeRawUnsafe(
                `CREATE TRIGGER "FiatLiquidityAuthorityActivation_no_delete" AFTER DELETE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION ${TRIGGER_FN}`);
        },
        'TRIGGER_BINDING_DRIFT:FiatLiquidityAuthorityActivation_no_delete:timing-or-scope',
        async () => {
            await admin.$executeRawUnsafe(`DROP TRIGGER "FiatLiquidityAuthorityActivation_no_delete" ON ${TABLE}`);
            await admin.$executeRawUnsafe(
                `CREATE TRIGGER "FiatLiquidityAuthorityActivation_no_delete" BEFORE DELETE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION ${TRIGGER_FN}`);
        },
    );

    // TRUNCATE triggers cannot be row-level at all, so the scope mutation is the
    // TIMING: an AFTER guard fires once the statement has already committed its
    // effect, which is not the guard this boundary relies on.
    mutates(
        'the truncate guard is moved to AFTER',
        async () => {
            await admin.$executeRawUnsafe(`DROP TRIGGER "FiatLiquidityAuthorityActivation_no_truncate" ON ${TABLE}`);
            await admin.$executeRawUnsafe(
                `CREATE TRIGGER "FiatLiquidityAuthorityActivation_no_truncate" AFTER TRUNCATE ON ${TABLE} FOR EACH STATEMENT EXECUTE FUNCTION ${TRIGGER_FN}`);
        },
        'TRIGGER_BINDING_DRIFT:FiatLiquidityAuthorityActivation_no_truncate:timing-or-scope',
        async () => {
            await admin.$executeRawUnsafe(`DROP TRIGGER "FiatLiquidityAuthorityActivation_no_truncate" ON ${TABLE}`);
            await admin.$executeRawUnsafe(
                `CREATE TRIGGER "FiatLiquidityAuthorityActivation_no_truncate" BEFORE TRUNCATE ON ${TABLE} FOR EACH STATEMENT EXECUTE FUNCTION ${TRIGGER_FN}`);
        },
    );

    mutates(
        'a guard is re-bound to a DIFFERENT function of the same name shape',
        async () => {
            await admin.$executeRawUnsafe(
                `CREATE OR REPLACE FUNCTION public.azm_evil_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$`);
            await admin.$executeRawUnsafe(`ALTER FUNCTION public.azm_evil_guard() OWNER TO ${el(ROLE.owner)}`);
            await admin.$executeRawUnsafe(`DROP TRIGGER "FiatLiquidityAuthorityActivation_no_update" ON ${TABLE}`);
            await admin.$executeRawUnsafe(
                `CREATE TRIGGER "FiatLiquidityAuthorityActivation_no_update" BEFORE UPDATE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION public.azm_evil_guard()`);
        },
        'TRIGGER_BINDING_DRIFT:FiatLiquidityAuthorityActivation_no_update:wrong-function',
        async () => {
            await admin.$executeRawUnsafe(`DROP TRIGGER "FiatLiquidityAuthorityActivation_no_update" ON ${TABLE}`);
            await admin.$executeRawUnsafe(
                `CREATE TRIGGER "FiatLiquidityAuthorityActivation_no_update" BEFORE UPDATE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION ${TRIGGER_FN}`);
            await admin.$executeRawUnsafe(`DROP FUNCTION public.azm_evil_guard()`);
        },
    );

    mutates(
        'a guard is disabled',
        () => admin.$executeRawUnsafe(`ALTER TABLE ${TABLE} DISABLE TRIGGER "FiatLiquidityAuthorityActivation_no_update"`),
        'TRIGGER_BINDING_DRIFT:FiatLiquidityAuthorityActivation_no_update:not-enabled',
        () => admin.$executeRawUnsafe(`ALTER TABLE ${TABLE} ENABLE TRIGGER "FiatLiquidityAuthorityActivation_no_update"`),
    );

    mutates(
        'a guard is dropped',
        () => admin.$executeRawUnsafe(`DROP TRIGGER "FiatLiquidityAuthorityActivation_no_delete" ON ${TABLE}`),
        'TRIGGER_BINDING_DRIFT:FiatLiquidityAuthorityActivation_no_delete:missing',
        () => admin.$executeRawUnsafe(
            `CREATE TRIGGER "FiatLiquidityAuthorityActivation_no_delete" BEFORE DELETE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION ${TRIGGER_FN}`),
    );

    // ── ACLs: table, column and PUBLIC (OID 0) ───────────────────────────────
    mutates(
        'a column-level write grant is added for the runtime',
        () => admin.$executeRawUnsafe(`GRANT UPDATE ("evidenceDigest") ON ${TABLE} TO ${el(ROLE.runtime)}`),
        'COLUMN_ACL_EXPOSED:evidenceDigest',
        () => admin.$executeRawUnsafe(`REVOKE UPDATE ("evidenceDigest") ON ${TABLE} FROM ${el(ROLE.runtime)}`),
    );

    mutates(
        'PUBLIC is granted insert on the record',
        () => admin.$executeRawUnsafe(`GRANT INSERT ON ${TABLE} TO PUBLIC`),
        'PUBLIC_HAS_RECORD_PRIVILEGE',
        () => admin.$executeRawUnsafe(`REVOKE INSERT ON ${TABLE} FROM PUBLIC`),
    );

    mutates(
        'the operator is granted DML on the record',
        () => admin.$executeRawUnsafe(`GRANT INSERT ON ${TABLE} TO ${el(ROLE.operator)}`),
        `NON_OWNER_CAN_WRITE_ACTIVATION_RECORD:${ROLE.operator}:a`,
        () => admin.$executeRawUnsafe(`REVOKE INSERT ON ${TABLE} FROM ${el(ROLE.operator)}`),
    );

    mutates(
        'the function owner is granted more than its exact insert',
        () => admin.$executeRawUnsafe(`GRANT UPDATE ON ${TABLE} TO ${el(ROLE.fnOwner)}`),
        `RECORD_WRITER_PRIVILEGE_TOO_BROAD:${ROLE.fnOwner}`,
        () => admin.$executeRawUnsafe(`REVOKE UPDATE ON ${TABLE} FROM ${el(ROLE.fnOwner)}`),
    );

    mutates(
        'an unrelated role is granted read on the record',
        () => admin.$executeRawUnsafe(`GRANT SELECT ON ${TABLE} TO ${el(ROLE.foreign)}`),
        `RECORD_ACL_FOREIGN_GRANTEE:${ROLE.foreign}`,
        () => admin.$executeRawUnsafe(`REVOKE SELECT ON ${TABLE} FROM ${el(ROLE.foreign)}`),
    );

    // ── activation function EXECUTE ──────────────────────────────────────────
    mutates(
        'EXECUTE is granted to the runtime',
        () => admin.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION ${ACTIVATE_FN} TO ${el(ROLE.runtime)}`),
        'ACTIVATION_FUNCTION_EXECUTE_TO_RUNTIME',
        () => admin.$executeRawUnsafe(`REVOKE EXECUTE ON FUNCTION ${ACTIVATE_FN} FROM ${el(ROLE.runtime)}`),
    );

    mutates(
        'EXECUTE is granted to an unrelated role',
        () => admin.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION ${ACTIVATE_FN} TO ${el(ROLE.foreign)}`),
        // TWO non-owner EXECUTE identities is an ambiguous boundary: the attestation
        // must refuse rather than pick the one that happens to look right.
        `ACTIVATION_FUNCTION_EXECUTE_AMBIGUOUS:${ROLE.operator},${ROLE.foreign}`,
        () => admin.$executeRawUnsafe(`REVOKE EXECUTE ON FUNCTION ${ACTIVATE_FN} FROM ${el(ROLE.foreign)}`),
    );

    mutates(
        'EXECUTE is granted to PUBLIC',
        () => admin.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION ${ACTIVATE_FN} TO PUBLIC`),
        'PUBLIC_CAN_EXECUTE_ACTIVATION_FUNCTION',
        () => admin.$executeRawUnsafe(`REVOKE EXECUTE ON FUNCTION ${ACTIVATE_FN} FROM PUBLIC`),
    );

    // ── activation function search_path ──────────────────────────────────────
    // The activation function is SECURITY DEFINER: it writes the protected record
    // as its owner. Its body resolves names through search_path, so an unpinned
    // path lets any role that can create a schema shadow those names and run code
    // as the owner. The probe demands EXACTLY pg_catalog. Neither case below was
    // attacked by any suite before: the check existed with no adversarial test.
    mutates(
        'the activation function search_path is reset (unpinned)',
        () => admin.$executeRawUnsafe(`ALTER FUNCTION ${ACTIVATE_FN} RESET search_path`),
        'ACTIVATION_FUNCTION_SEARCH_PATH_UNPINNED',
        () => admin.$executeRawUnsafe(`ALTER FUNCTION ${ACTIVATE_FN} SET search_path = pg_catalog`),
    );

    mutates(
        'the activation function search_path is pinned to public,pg_catalog',
        () => admin.$executeRawUnsafe(`ALTER FUNCTION ${ACTIVATE_FN} SET search_path = public, pg_catalog`),
        // "contains pg_catalog" is not enough: a leading writable schema still wins
        // name resolution, so the check must require EXACTLY pg_catalog.
        'ACTIVATION_FUNCTION_SEARCH_PATH_UNPINNED',
        () => admin.$executeRawUnsafe(`ALTER FUNCTION ${ACTIVATE_FN} SET search_path = pg_catalog`),
    );

    mutates(
        'the configured operator loses EXECUTE',
        () => admin.$executeRawUnsafe(`REVOKE EXECUTE ON FUNCTION ${ACTIVATE_FN} FROM ${el(ROLE.operator)}`),
        `ACTIVATION_FUNCTION_EXECUTE_GRANTEE_NOT_OPERATOR:none-granted`,
        () => admin.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION ${ACTIVATE_FN} TO ${el(ROLE.operator)}`),
    );
});
