// __tests__/wp-h-operator-activation.pg.test.js
// =============================================================================
// §WP-H — the sanctioned activation path, proved with REAL PostgreSQL logins.
//
// Every role here authenticates with its own credential. No SET ROLE, anywhere:
// a SET ROLE test proves the statements run, not that the boundary holds.
//
// The provisioning is done by the shipped installers (they are what a DBA runs),
// so the grant matrix asserted below is the one the release chain actually
// produces, not a matrix invented for the test.
// =============================================================================
const fs = require('fs');
const path = require('path');

const BASE = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const RUN = Math.random().toString(36).slice(2, 8);
const DB = `azm_wph_act_${RUN}`;
const PWD = 'wphpass123';
const ROLE = {
    owner: `wph_owner_${RUN}`,
    fnOwner: `wph_fnowner_${RUN}`,
    runtime: `wph_runtime_${RUN}`,
    operator: `wph_operator_${RUN}`,
    migrator: `wph_migrator_${RUN}`,
};
const FN = 'public.azm_authority_activate(text,text,text,text,text,text[],text[])';
const TABLE = 'public."FiatLiquidityAuthorityActivation"';
const DIGEST = 'a'.repeat(64);

const urlFor = (role, db) => {
    const u = new URL(BASE);
    if (role) { u.username = role; u.password = PWD; }
    u.pathname = `/${db}`;
    u.search = '';
    return u.toString();
};

const hasDb = !!BASE;
const run = hasDb ? describe : describe.skip;

run('WP-H operator-only activation (real PostgreSQL logins)', () => {
    const { PrismaClient } = require('@prisma/client');
    let adminPg; let admin; let runtime; let operator; let migrator; let fnSetupOk = null; let setupError = null;

    const el = (name) => `"${name}"`;

    beforeAll(async () => {
        adminPg = new PrismaClient({ datasources: { db: { url: urlFor(null, 'postgres') } } });
        await adminPg.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${el(DB)} WITH (FORCE)`);
        await adminPg.$executeRawUnsafe(`CREATE DATABASE ${el(DB)}`);
        admin = new PrismaClient({ datasources: { db: { url: urlFor(null, DB) } } });

        for (const [key, name] of Object.entries(ROLE)) {
            const login = ['runtime', 'operator', 'migrator'].includes(key);
            await admin.$executeRawUnsafe(
                `CREATE ROLE ${el(name)} ${login ? 'LOGIN' : 'NOLOGIN'} PASSWORD '${PWD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`
            );
        }

        // Minimal shape of the tables the activation touches, then the shipped DDL.
        for (const ddl of [
            `CREATE TABLE "GlobalSettings" ("id" int PRIMARY KEY, "fiatLiquidityAuthorityEnabled" boolean NOT NULL DEFAULT false)`,
            `CREATE TABLE "FiatLiquidityState" ("id" int PRIMARY KEY, "authorityActivatedAt" timestamp, "availableGhs" numeric(20,2) NOT NULL DEFAULT 0, "reservedGhs" numeric(20,2) NOT NULL DEFAULT 0, "inTransitGhs" numeric(20,2) NOT NULL DEFAULT 0, "paidOutGhs" numeric(20,2) NOT NULL DEFAULT 0, "reconciliationHeldGhs" numeric(20,2) NOT NULL DEFAULT 0)`,
            `CREATE TABLE "SystemFiatPool" ("id" int PRIMARY KEY, "balance" numeric(20,2) NOT NULL DEFAULT 0)`,
            `CREATE TABLE "Withdrawal" ("id" serial PRIMARY KEY, "status" text, "payoutMethod" text, "amount" numeric(20,2), "settlementCurrency" text, "transactionHistoryId" int)`,
            `CREATE TABLE "TransactionHistory" ("id" serial PRIMARY KEY, "type" text, "status" text, "txHash" text)`,
            `CREATE TABLE "FiatLiquidityReservation" ("id" serial PRIMARY KEY, "reference" text, "relatedTransactionId" int)`,
            `CREATE TABLE "AdminSettingsAuditLog" ("id" text PRIMARY KEY, "adminId" int NOT NULL, "adminName" text, "action" text NOT NULL, "targetType" text NOT NULL, "targetId" text, "changes" jsonb NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now())`,
        ]) await admin.$executeRawUnsafe(ddl);

        // The protected record + immutable triggers, exactly as shipped.
        const sql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'migrations',
            '20261110230000_p5d_enforced_authority_activation', 'migration.sql'), 'utf8');
        require('child_process').execFileSync('psql', [urlFor(null, DB), '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], { input: sql });

        await admin.$executeRawUnsafe(`ALTER TABLE ${TABLE} OWNER TO ${el(ROLE.owner)}`);
        await admin.$executeRawUnsafe(
            `ALTER FUNCTION public.azm_authority_activation_immutable() OWNER TO ${el(ROLE.owner)}`);
        await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${el(ROLE.runtime)}, ${el(ROLE.operator)}, ${el(ROLE.migrator)}`);
        await admin.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${el(ROLE.runtime)}`);
        await admin.$executeRawUnsafe(`INSERT INTO "GlobalSettings" ("id") VALUES (1)`);
        await admin.$executeRawUnsafe(`INSERT INTO "FiatLiquidityState" ("id", "availableGhs") VALUES (1, 5000)`);
        await admin.$executeRawUnsafe(`INSERT INTO "SystemFiatPool" ("id", "balance") VALUES (1, 42)`);

        runtime = new PrismaClient({ datasources: { db: { url: urlFor(ROLE.runtime, DB) } } });
        operator = new PrismaClient({ datasources: { db: { url: urlFor(ROLE.operator, DB) } } });
        migrator = new PrismaClient({ datasources: { db: { url: urlFor(ROLE.migrator, DB) } } });

        try {
            const { installAuthorityActivationRoles } = require('../infra/install-authority-activation-roles');
            const report = await installAuthorityActivationRoles(admin, {
                owner: ROLE.owner, runtime: ROLE.runtime, operator: ROLE.operator,
                functionOwner: ROLE.fnOwner, log: () => {},
            });
            fnSetupOk = report.ok;
            setupError = report.ok ? null : report.problems;
        } catch (err) {
            fnSetupOk = false;
            setupError = err.message;
        }
    }, 120000);

    afterAll(async () => {
        for (const c of [runtime, operator, migrator, admin, adminPg]) { try { await c.$disconnect(); } catch (_) {} }
        try {
            const cleanup = new PrismaClient({ datasources: { db: { url: urlFor(null, 'postgres') } } });
            await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${el(DB)} WITH (FORCE)`);
            for (const name of Object.values(ROLE)) await cleanup.$executeRawUnsafe(`DROP ROLE IF EXISTS ${el(name)}`);
            await cleanup.$disconnect();
        } catch (_) {}
    }, 60000);

    const activate = (client, over = {}) => client.$queryRawUnsafe(
        `SELECT public.azm_authority_activate($1,$2,$3,$4,$5,$6::text[],$7::text[]) AS result`,
        over.operator || ROLE.operator, over.approver || 'approver-1', over.reason || 'month-end activation',
        over.ref || 'evidence://wp-h/1', over.digest || DIGEST,
        over.blocking || ['PENDING', 'PROCESSING'], over.parked || ['RECONCILIATION_REQUIRED']);

    const recordCount = async () => (await admin.$queryRawUnsafe(`SELECT count(*)::int AS c FROM ${TABLE}`))[0].c;
    const latch = async () => (await admin.$queryRawUnsafe(
        `SELECT s."authorityActivatedAt" AS at, g."fiatLiquidityAuthorityEnabled" AS flag, p."balance"::text AS pool, s."availableGhs"::text AS ghs
           FROM "FiatLiquidityState" s, "GlobalSettings" g, "SystemFiatPool" p WHERE s."id"=1 AND g."id"=1 AND p."id"=1`))[0];

    const t = (name, fn, ms = 30000) => test(name, async () => {
        expect(setupError).toBeNull();
        await fn();
    }, ms);

    t('the shipped installer provisions a sound function: SECURITY DEFINER, NOLOGIN owner, pinned search_path, operator-only EXECUTE', async () => {
        expect(fnSetupOk).toBe(true);
        const [fn] = await admin.$queryRawUnsafe(`
            SELECT p.prosecdef AS secdef, p.proconfig AS config, r.rolname AS owner, r.rolcanlogin AS owner_login
              FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = $1::regprocedure`, FN);
        expect(fn.secdef).toBe(true);
        expect(fn.owner).toBe(ROLE.fnOwner);
        expect(fn.owner_login).toBe(false);
        expect((fn.config || []).join(',')).toContain('search_path=pg_catalog');
        const [acl] = await admin.$queryRawUnsafe(
            `SELECT has_function_privilege($1,$3::regprocedure,'EXECUTE') AS op,
                    has_function_privilege($2,$3::regprocedure,'EXECUTE') AS rt`, ROLE.operator, ROLE.runtime, FN);
        expect(acl.op).toBe(true);
        expect(acl.rt).toBe(false);
    });

    t('the grant matrix is what the catalog says: operator has EXECUTE and no direct write, function owner inserts but never mutates', async () => {
        const [op] = await admin.$queryRawUnsafe(
            `SELECT has_table_privilege($1,$3,'INSERT') AS i, has_table_privilege($1,$3,'UPDATE') AS u,
                    has_table_privilege($1,$3,'DELETE') AS d, has_table_privilege($1,$3,'TRUNCATE') AS t`,
            ROLE.operator, null, TABLE).catch(() => [{}]);
        const [opRow] = await admin.$queryRawUnsafe(
            `SELECT has_table_privilege($1, $2, 'INSERT') AS i, has_table_privilege($1, $2, 'UPDATE') AS u,
                    has_table_privilege($1, $2, 'DELETE') AS d, has_table_privilege($1, $2, 'TRUNCATE') AS t`,
            ROLE.operator, TABLE);
        expect(opRow.i).toBe(false);
        expect(opRow.u).toBe(false);
        expect(opRow.d).toBe(false);
        expect(opRow.t).toBe(false);
        const [fo] = await admin.$queryRawUnsafe(
            `SELECT has_table_privilege($1, $2, 'INSERT') AS i, has_table_privilege($1, $2, 'UPDATE') AS u,
                    has_table_privilege($1, $2, 'DELETE') AS d, has_table_privilege($1, $2, 'TRUNCATE') AS t,
                    (SELECT rolcanlogin FROM pg_roles WHERE rolname = $1) AS login`,
            ROLE.fnOwner, TABLE);
        expect(fo.i).toBe(true);
        expect(fo.u).toBe(false);
        expect(fo.d).toBe(false);
        expect(fo.t).toBe(false);
        expect(fo.login).toBe(false);
    });

    t('the operator cannot write the record directly, only through the function', async () => {
        await expect(operator.$executeRawUnsafe(
            `INSERT INTO ${TABLE} ("id","activatedBy","approvedBy","evidenceReference","evidenceDigest") VALUES (1,'x','y','z',repeat('a',64))`
        )).rejects.toThrow(/permission denied|42501/i);
        expect(await recordCount()).toBe(0);
    });

    t('a non-operator login cannot execute the function', async () => {
        await expect(migrator.$queryRawUnsafe(
            `SELECT public.azm_authority_activate($1,'a','r','e',$2,ARRAY['PENDING'],ARRAY['X'])`,
            ROLE.migrator, DIGEST
        )).rejects.toThrow(/permission denied|42501/i);
        expect(await recordCount()).toBe(0);
    });

    t('the runtime role can read but cannot mutate the record or its triggers', async () => {
        await expect(runtime.$executeRawUnsafe(`SELECT count(*) FROM ${TABLE}`)).resolves.toBeDefined();
        for (const stmt of [
            `INSERT INTO ${TABLE} ("id","activatedBy","approvedBy","evidenceReference","evidenceDigest") VALUES (1,'x','y','z',repeat('a',64))`,
            `UPDATE ${TABLE} SET "approvedBy" = 'x' WHERE "id" = 1`,
            `DELETE FROM ${TABLE} WHERE "id" = 1`,
            `TRUNCATE ${TABLE}`,
            `ALTER TABLE ${TABLE} DISABLE TRIGGER ALL`,
        ]) await expect(runtime.$executeRawUnsafe(stmt)).rejects.toThrow(/permission denied|must be owner|42501/i);
    });

    t('the function owner is not reachable from any login', async () => {
        const [m] = await admin.$queryRawUnsafe(
            `SELECT pg_has_role($1,$4,'MEMBER') AS a, pg_has_role($2,$4,'MEMBER') AS b, pg_has_role($3,$4,'MEMBER') AS c`,
            ROLE.runtime, ROLE.operator, ROLE.migrator, ROLE.fnOwner);
        expect(m.a).toBe(false); expect(m.b).toBe(false); expect(m.c).toBe(false);
    });

    t('malformed input is refused inside the database, before anything is written', async () => {
        await expect(activate(operator, { digest: 'not-a-digest' })).rejects.toThrow(/DIGEST_INVALID/);
        await expect(activate(operator, { approver: '   ' })).rejects.toThrow(/EVIDENCE_INCOMPLETE/);
        await expect(activate(operator, { operator: 'someone-else' })).rejects.toThrow(/OPERATOR_MISMATCH/);
        await expect(activate(operator, { blocking: [] })).rejects.toThrow(/PREFLIGHT_STATUSES_INVALID/);
        expect(await recordCount()).toBe(0);
    });

    t('an unresolved legacy withdrawal blocks activation and changes nothing', async () => {
        await admin.$executeRawUnsafe(
            `INSERT INTO "Withdrawal" ("status","payoutMethod","amount","settlementCurrency") VALUES ('PENDING','MTN_MOMO',50,NULL)`);
        await expect(activate(operator)).rejects.toThrow(/ACTIVATION_BLOCKED/);
        expect(await recordCount()).toBe(0);
        const state = await latch();
        expect(state.flag).toBe(false);
        await admin.$executeRawUnsafe(`DELETE FROM "Withdrawal"`);
    });

    t('a projection failure rolls the protected record and the latch back', async () => {
        await admin.$executeRawUnsafe(`REVOKE UPDATE ("balance") ON "SystemFiatPool" FROM ${el(ROLE.fnOwner)}`);
        await expect(activate(operator)).rejects.toThrow(/permission denied|42501/i);
        expect(await recordCount()).toBe(0);
        expect((await latch()).flag).toBe(false);
        await admin.$executeRawUnsafe(`GRANT UPDATE ("balance") ON "SystemFiatPool" TO ${el(ROLE.fnOwner)}`);
    });

    t('an audit failure rolls the entire activation back', async () => {
        await admin.$executeRawUnsafe(`REVOKE INSERT ON "AdminSettingsAuditLog" FROM ${el(ROLE.fnOwner)}`);
        await expect(activate(operator)).rejects.toThrow(/permission denied|42501/i);
        expect(await recordCount()).toBe(0);
        expect((await latch()).flag).toBe(false);
        await admin.$executeRawUnsafe(`GRANT INSERT ON "AdminSettingsAuditLog" TO ${el(ROLE.fnOwner)}`);
    });

    t('the CLI calls the sanctioned function and does not insert the record itself', async () => {
        const cli = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'p5d-authority-activate-enforced.js'), 'utf8');
        expect(cli).toContain('public.azm_authority_activate(');
        expect(cli).not.toMatch(/INSERT INTO \$\{enforcement\.QUALIFIED_TABLE\}/);
    });

    t('two concurrent activations yield exactly one winner', async () => {
        const other = new PrismaClient({ datasources: { db: { url: urlFor(ROLE.operator, DB) } } });
        try {
            const results = await Promise.allSettled([activate(operator), activate(other)]);
            expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
            expect(await recordCount()).toBe(1);
        } finally { await other.$disconnect(); }
    }, 60000);

    t('the activation committed atomically: record, latch, flag, projection and audit together', async () => {
        const state = await latch();
        expect(state.flag).toBe(true);
        expect(state.at).not.toBeNull();
        expect(state.pool).toBe(state.ghs);       // projection synced to GHS, not the stale USDC 42
        const [audit] = await admin.$queryRawUnsafe(
            `SELECT count(*)::int AS c FROM "AdminSettingsAuditLog" WHERE "action" = 'P5D_AUTHORITY_ACTIVATED'`);
        expect(audit.c).toBe(1);
    });

    t('a second activation is refused by the function, not only by the CLI', async () => {
        await expect(activate(operator)).rejects.toThrow(/ALREADY_ACTIVATED|already exists/);
        expect(await recordCount()).toBe(1);
    });

    t('an economic shared-lock transaction and activation serialise on the same key', async () => {
        // activation already happened, so this proves the LOCK, using the shared side.
        let release;
        const held = new Promise((r) => { release = r; });
        const reader = runtime.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock_shared(hashtext($1))`, 'azm.p5d.authority.activation');
            await held;
            return 'read';
        }, { timeout: 30000 });
        await new Promise((r) => setTimeout(r, 150));
        const [blocked] = await admin.$queryRawUnsafe(
            `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got`, 'azm.p5d.authority.activation');
        expect(blocked.got).toBe(false);
        release();
        await reader;
    }, 60000);

    // The upgrade path (a pre-set legacy latch with an inert sentinel projection)
    // is proved in __tests__/p5e-enforced-authority-activation.pg.test.js test 8,
    // which activates exactly that state and asserts the projection is synchronised.
    // It cannot run here: this suite activates for real once, and the protected
    // record is append-only by design.
});
