// __tests__/wp-h-function-owner-privileges.pg.test.js
// =============================================================================
// §WP-H slice 6 — THE PRE-POISONED FUNCTION OWNER.
//
// Agent 2's finding: pre-create the expected function-owner role with broad
// table grants and a membership in another privilege-bearing role. The installer
// created a narrow role only when it was ABSENT; an existing role came out the
// other side untouched and the install still exited 0, with 1,554 table
// privileges intact.
//
// The activation function is SECURITY DEFINER and owned by that role, so its
// owner's privileges ARE the function's privileges: a poisoned owner can read and
// write tables the activation act must never touch.
//
// This suite pre-poisons the role exactly as described, runs the shipped
// installer, and then measures the catalog rather than trusting the installer.
// =============================================================================
const fs = require('fs');
const path = require('path');

const BASE = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const RUN = Math.random().toString(36).slice(2, 8);
const DB = `azm_wph_fnpoison_${RUN}`;
const PWD = 'wphpass123';
const ROLE = {
    owner: `wphp_owner_${RUN}`,
    fnOwner: `wphp_fnowner_${RUN}`,
    runtime: `wphp_runtime_${RUN}`,
    operator: `wphp_operator_${RUN}`,
    migrator: `wphp_migrator_${RUN}`,
    foreign: `wphp_foreign_${RUN}`,
};
const TABLE = 'public."FiatLiquidityAuthorityActivation"';
const FN = 'public.azm_authority_activate(text,text,text,text,text)';
const DIGEST = 'd'.repeat(64);

const urlFor = (role, db) => {
    const u = new URL(BASE);
    if (role) { u.username = role; u.password = PWD; }
    u.pathname = `/${db}`;
    u.search = '';
    return u.toString();
};

const hasDb = !!BASE;
const run = hasDb ? describe : describe.skip;

run('WP-H function-owner privilege normalisation (real PostgreSQL)', () => {
    const { PrismaClient } = require('@prisma/client');
    let adminPg; let admin; let runtime; let operator;
    let setupError = null; let install = null;
    let poisonedBefore = null; let poisonSnapshot = null;

    const el = (name) => `"${name}"`;
    const {
        EXPECTED_TABLE_PRIVILEGES, EXPECTED_COLUMN_UPDATE,
    } = require('../infra/lib/authority-role-normalisation');

    const directGrantCount = (role) => admin.$queryRawUnsafe(`
        SELECT (
            SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
                 LATERAL aclexplode(c.relacl) a
             WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)
               AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
        ) + (
            SELECT count(*)::int FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid,
                 LATERAL aclexplode(att.attacl) a
             WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1) AND att.attacl IS NOT NULL
        ) + (
            SELECT count(*)::int FROM pg_proc p, LATERAL aclexplode(p.proacl) a
             WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1) AND p.proacl IS NOT NULL
        ) + (
            SELECT count(*)::int FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a
             WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1) AND n.nspacl IS NOT NULL
        ) AS grants`, role);

    const activationCount = async () => (await admin.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TABLE}`))[0].c;

    beforeAll(async () => {
        adminPg = new PrismaClient({ datasources: { db: { url: urlFor(null, 'postgres') } } });
        await adminPg.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${el(DB)} WITH (FORCE)`);
        await adminPg.$executeRawUnsafe(`CREATE DATABASE ${el(DB)}`);
        admin = new PrismaClient({ datasources: { db: { url: urlFor(null, DB) } } });

        for (const [key, name] of Object.entries(ROLE)) {
            const login = ['runtime', 'operator', 'migrator', 'foreign'].includes(key);
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
            `CREATE SEQUENCE "PoisonSequence"`,
        ]) await admin.$executeRawUnsafe(ddl);

        const sql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'migrations',
            '20261110230000_p5d_enforced_authority_activation', 'migration.sql'), 'utf8');
        require('child_process').execFileSync('psql', [urlFor(null, DB), '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], { input: sql });

        await admin.$executeRawUnsafe(`ALTER TABLE ${TABLE} OWNER TO ${el(ROLE.owner)}`);
        await admin.$executeRawUnsafe(
            `ALTER FUNCTION public.azm_authority_activation_immutable() OWNER TO ${el(ROLE.owner)}`);
        await admin.$executeRawUnsafe(
            `GRANT USAGE ON SCHEMA public TO ${el(ROLE.runtime)}, ${el(ROLE.operator)}, ${el(ROLE.migrator)}`);
        await admin.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${el(ROLE.runtime)}`);
        await admin.$executeRawUnsafe(`INSERT INTO "GlobalSettings" ("id") VALUES (1)`);
        await admin.$executeRawUnsafe(`INSERT INTO "FiatLiquidityState" ("id", "availableGhs") VALUES (1, 5000)`);
        await admin.$executeRawUnsafe(`INSERT INTO "SystemFiatPool" ("id", "balance") VALUES (1, 42)`);

        // ── THE POISON ──────────────────────────────────────────────────────
        // Exactly Agent 2's recipe: the role already exists, is over-privileged,
        // can log in, can create roles, inherits, and is a member of a foreign
        // privilege-bearing role.
        const fnO = el(ROLE.fnOwner);
        await admin.$executeRawUnsafe(
            `ALTER ROLE ${fnO} LOGIN PASSWORD '${PWD}' CREATEDB CREATEROLE INHERIT`);
        await admin.$executeRawUnsafe(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${fnO}`);
        await admin.$executeRawUnsafe(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${fnO}`);
        await admin.$executeRawUnsafe(`GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO ${fnO}`);
        await admin.$executeRawUnsafe(`GRANT CREATE, USAGE ON SCHEMA public TO ${fnO}`);
        await admin.$executeRawUnsafe(`GRANT SELECT, UPDATE ON ALL TABLES IN SCHEMA public TO ${el(ROLE.foreign)}`);
        await admin.$executeRawUnsafe(`GRANT ${el(ROLE.foreign)} TO ${fnO}`);
        poisonedBefore = (await directGrantCount(ROLE.fnOwner))[0].grants;
        const [preAttrs] = await admin.$queryRawUnsafe(`
            SELECT rolcanlogin, rolcreatedb, rolcreaterole, rolinherit FROM pg_roles WHERE rolname = $1`,
            ROLE.fnOwner);
        const [preMembers] = await admin.$queryRawUnsafe(`
            SELECT count(*)::int AS c FROM pg_auth_members
             WHERE member = (SELECT oid FROM pg_roles WHERE rolname = $1)`, ROLE.fnOwner);
        poisonSnapshot = { attrs: preAttrs, memberships: preMembers.c };

        runtime = new PrismaClient({ datasources: { db: { url: urlFor(ROLE.runtime, DB) } } });
        operator = new PrismaClient({ datasources: { db: { url: urlFor(ROLE.operator, DB) } } });

        try {
            const { installAuthorityActivationRoles } = require('../infra/install-authority-activation-roles');
            install = await installAuthorityActivationRoles(admin, {
                owner: ROLE.owner, runtime: ROLE.runtime, operator: ROLE.operator,
                functionOwner: ROLE.fnOwner, log: () => {},
            });
        } catch (err) {
            setupError = err.message;
        }
    }, 240000);

    afterAll(async () => {
        for (const c of [runtime, operator, admin, adminPg]) { try { await c.$disconnect(); } catch (_) {} }
        try {
            const cleanup = new PrismaClient({ datasources: { db: { url: urlFor(null, 'postgres') } } });
            await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${el(DB)} WITH (FORCE)`);
            for (const name of Object.values(ROLE)) await cleanup.$executeRawUnsafe(`DROP ROLE IF EXISTS ${el(name)}`);
            await cleanup.$disconnect();
        } catch (_) {}
    }, 60000);

    const t = (name, fn, ms = 30000) => test(name, async () => {
        expect(setupError).toBeNull();
        await fn();
    }, ms);

    t('the poison is real before installation: broad grants, memberships, dangerous attributes', async () => {
        expect(poisonedBefore).toBeGreaterThan(50);
        expect(poisonSnapshot.attrs).toEqual({
            rolcanlogin: true, rolcreatedb: true, rolcreaterole: true, rolinherit: true,
        });
        expect(poisonSnapshot.memberships).toBeGreaterThan(0);
    });

    t('the shipped installer reports success and normalises the existing role', async () => {
        expect(install).toBeTruthy();
        expect(install.problems).toEqual([]);  // diagnostics surface on failure
        expect(install.ok).toBe(true);
        expect(install.functionInstall.normalisation.revokedGrants).toBeGreaterThan(0);
        expect(install.functionInstall.normalisation.revokedMemberships.length).toBeGreaterThan(0);
    });

    t('every role attribute is reconciled, including LOGIN, CREATEDB, CREATEROLE and INHERIT', async () => {
        const [row] = await admin.$queryRawUnsafe(`
            SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit
              FROM pg_roles WHERE rolname = $1`, ROLE.fnOwner);
        expect(row).toEqual({
            rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
            rolreplication: false, rolbypassrls: false, rolinherit: false,
        });
    });

    t('every membership is revoked in both directions, not just the four known role names', async () => {
        const memberships = await admin.$queryRawUnsafe(`
            SELECT g.rolname AS group_role, m.rolname AS member_role
              FROM pg_auth_members am
              JOIN pg_roles g ON g.oid = am.roleid
              JOIN pg_roles m ON m.oid = am.member
             WHERE am.member = (SELECT oid FROM pg_roles WHERE rolname = $1)
                OR am.roleid = (SELECT oid FROM pg_roles WHERE rolname = $1)`, ROLE.fnOwner);
        expect(memberships).toEqual([]);

        const [stillMember] = await admin.$queryRawUnsafe(
            `SELECT pg_has_role($1, $2, 'MEMBER') AS m`, ROLE.fnOwner, ROLE.foreign);
        expect(stillMember.m).toBe(false);
    });

    t('only the exact allowlisted privileges remain, measured from the catalog', async () => {
        const before = poisonedBefore;
        const [after] = await directGrantCount(ROLE.fnOwner);
        expect(after.grants).toBeLessThan(before);

        // Effective privileges over every application relation.
        const relations = await admin.$queryRawUnsafe(`
            SELECT n.nspname || '.' || c.relname AS rel, c.relkind,
                   has_table_privilege($1, c.oid, 'SELECT')   AS s,
                   has_table_privilege($1, c.oid, 'INSERT')   AS i,
                   has_table_privilege($1, c.oid, 'UPDATE')   AS u,
                   has_table_privilege($1, c.oid, 'DELETE')   AS d,
                   has_table_privilege($1, c.oid, 'TRUNCATE') AS t
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r','p','v','m','f','S')
               AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')`, ROLE.fnOwner);

        const observed = {};
        for (const r of relations) {
            const flags = [];
            if (r.s) flags.push('SELECT');
            if (r.i) flags.push('INSERT');
            if (r.u) flags.push('UPDATE');
            if (r.d) flags.push('DELETE');
            if (r.t) flags.push('TRUNCATE');
            if (flags.length) observed[r.rel] = flags.sort();
        }
        for (const [rel, expected] of Object.entries(EXPECTED_TABLE_PRIVILEGES)) {
            expect(observed[rel]).toEqual([...expected].sort());
        }
        // Nothing else, in particular no sequence and no unrelated customer table.
        for (const rel of Object.keys(observed)) {
            if (!EXPECTED_TABLE_PRIVILEGES[rel]) {
                throw new Error(`unexpected privileges on ${rel}: ${observed[rel].join('+')}`);
            }
        }
        const [seq] = await admin.$queryRawUnsafe(
            `SELECT has_sequence_privilege($1, 'public."PoisonSequence"', 'USAGE') AS u,
                    has_sequence_privilege($1, 'public."PoisonSequence"', 'UPDATE') AS w`, ROLE.fnOwner);
        expect(seq).toEqual({ u: false, w: false });

        // Column-level UPDATE is exactly the three columns the activation writes.
        const cols = await admin.$queryRawUnsafe(`
            SELECT n.nspname || '.' || c.relname || '.' || att.attname AS col
              FROM pg_attribute att
              JOIN pg_class c ON c.oid = att.attrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE att.attnum > 0 AND NOT att.attisdropped
               AND c.relkind IN ('r','p')
               AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
               AND has_column_privilege($1, c.oid, att.attname, 'UPDATE')
             ORDER BY 1`, ROLE.fnOwner);
        const expectedCols = Object.entries(EXPECTED_COLUMN_UPDATE)
            .flatMap(([rel, list]) => list.map((c) => `${rel}.${c}`)).sort();
        expect(cols.map((c) => c.col)).toEqual(expectedCols);

        // Schema: USAGE on public, no CREATE.
        const [schema] = await admin.$queryRawUnsafe(
            `SELECT has_schema_privilege($1, 'public', 'USAGE') AS u, has_schema_privilege($1, 'public', 'CREATE') AS c`,
            ROLE.fnOwner);
        expect(schema).toEqual({ u: true, c: false });
    });

    t('the function owner owns nothing except the sanctioned activation function', async () => {
        const owned = await admin.$queryRawUnsafe(`
            SELECT 'relation' AS kind, n.nspname || '.' || c.relname AS object
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)
               AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
            UNION ALL
            SELECT 'routine', n.nspname || '.' || p.proname
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE p.proowner = (SELECT oid FROM pg_roles WHERE rolname = $1)
               AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')`, ROLE.fnOwner);
        expect(owned).toEqual([{ kind: 'routine', object: 'public.azm_authority_activate' }]);
    });

    t('the operator keeps EXECUTE but no direct record-write privilege', async () => {
        const [acl] = await admin.$queryRawUnsafe(
            `SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS op_exec,
                    has_table_privilege($1, $3, 'INSERT')  AS op_insert,
                    has_table_privilege($1, $3, 'UPDATE')  AS op_update,
                    has_table_privilege($1, $3, 'DELETE')  AS op_delete,
                    has_table_privilege($1, $3, 'TRUNCATE') AS op_truncate`,
            ROLE.operator, FN, TABLE);
        expect(acl).toEqual({
            op_exec: true, op_insert: false, op_update: false, op_delete: false, op_truncate: false,
        });
    });

    t('the normalised boundary still activates, and a rolled-back activation leaves nothing', async () => {
        await expect(operator.$transaction(async (tx) => {
            await tx.$queryRawUnsafe(
                'SELECT public.azm_authority_activate($1,$2,$3,$4,$5)',
                ROLE.operator, 'approver-1', 'rollback rehearsal', 'evidence://wp-h/rollback', DIGEST);
            throw new Error('deliberate rollback');
        })).rejects.toThrow(/deliberate rollback/);
        expect(await activationCount()).toBe(0);

        await operator.$queryRawUnsafe(
            'SELECT public.azm_authority_activate($1,$2,$3,$4,$5)',
            ROLE.operator, 'approver-1', 'poisoned-role rehearsal', 'evidence://wp-h/poison', DIGEST);
        expect(await activationCount()).toBe(1);

        const [row] = await admin.$queryRawUnsafe(
            `SELECT s."authorityActivatedAt" IS NOT NULL AS latched, g."fiatLiquidityAuthorityEnabled" AS flag,
                    p."balance"::text AS pool
               FROM "FiatLiquidityState" s, "GlobalSettings" g, "SystemFiatPool" p
              WHERE s."id"=1 AND g."id"=1 AND p."id"=1`);
        expect(row.latched).toBe(true);
        expect(row.flag).toBe(true);
        expect(row.pool).toBe('5000.00');
    }, 60000);

    t('an unexpected owned object fails the install with precise diagnostics', async () => {
        await admin.$executeRawUnsafe(`CREATE TABLE "AttackerOwned" ("id" int)`);
        await admin.$executeRawUnsafe(`ALTER TABLE "AttackerOwned" OWNER TO ${el(ROLE.fnOwner)}`);

        const { installAuthorityActivationFunction } = require('../infra/install-authority-activation-function');
        const report = await installAuthorityActivationFunction(admin, {
            tableOwner: ROLE.owner, functionOwner: ROLE.fnOwner, runtime: ROLE.runtime,
            operator: ROLE.operator, migrator: ROLE.migrator, roleScoped: true, log: () => {},
        });
        expect(report.ok).toBe(false);
        expect(report.problems.join(' ')).toMatch(/owns an unexpected relation: public\.AttackerOwned/);

        await admin.$executeRawUnsafe(`ALTER TABLE "AttackerOwned" OWNER TO ${el(ROLE.migrator)}`);
        await admin.$executeRawUnsafe(`DROP TABLE "AttackerOwned"`);
    }, 60000);
});
