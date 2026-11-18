// __tests__/wp-h-trigger-integrity.pg.test.js
// =============================================================================
// §WP-H slice 6 — THE TRIGGER FUNCTION BODY, NOT ITS IDENTITY.
//
// Agent 2's finding, reproduced here against a real PostgreSQL: replace the body
// of public.azm_authority_activation_immutable() in place. CREATE OR REPLACE
// keeps the OID, the name, the owner and the trigger wiring, so every metadata
// check the earlier slice made still passes — and an UPDATE against the
// protected record then succeeds.
//
// The test proves the whole attack, in order:
//   1. the canonical body is accepted;
//   2. the body is replaced in place, identity intact;
//   3. the runtime authority reader reports UNKNOWN, never ENFORCED_*;
//   4. the activation function refuses before writing anything;
//   5. UPDATE / DELETE / TRUNCATE are genuinely unguarded under the replaced
//      body, so the reader's refusal is about real exposure;
//   6. restoring the canonical body restores the boundary.
// =============================================================================
const fs = require('fs');
const path = require('path');

const BASE = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const RUN = Math.random().toString(36).slice(2, 8);
const DB = `azm_wph_trig_${RUN}`;
const PWD = 'wphpass123';
const ROLE = {
    owner: `wphtr_owner_${RUN}`,
    fnOwner: `wphtr_fnowner_${RUN}`,
    runtime: `wphtr_runtime_${RUN}`,
    operator: `wphtr_operator_${RUN}`,
    migrator: `wphtr_migrator_${RUN}`,
};
const TABLE = 'public."FiatLiquidityAuthorityActivation"';
const TRIGGER_FN = 'public.azm_authority_activation_immutable()';
const DIGEST = 'b'.repeat(64);
const TRIGGERS = [
    `${'FiatLiquidityAuthorityActivation'}_no_update`,
    `${'FiatLiquidityAuthorityActivation'}_no_delete`,
    `${'FiatLiquidityAuthorityActivation'}_no_truncate`,
];

const urlFor = (role, db) => {
    const u = new URL(BASE);
    if (role) { u.username = role; u.password = PWD; }
    u.pathname = `/${db}`;
    u.search = '';
    return u.toString();
};

const hasDb = !!BASE;
const run = hasDb ? describe : describe.skip;

// The attacker's replacement: same identity, same owner, no refusal.
const NOOP_BODY = `
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
`;

run('WP-H trigger-implementation integrity (real PostgreSQL)', () => {
    const { PrismaClient } = require('@prisma/client');
    let adminPg; let admin; let runtime; let operator;
    let setupError = null; let setupOk = false;

    const el = (name) => `"${name}"`;
    const { CANONICAL_TRIGGER_SOURCE } = require('../src/services/authorityTriggerContract');
    const enforcement = require('../src/services/authorityActivationEnforcement');
    const {
        AUTHORITY_STATE, UNKNOWN_REASON, resolveAuthorityState,
    } = require('../src/services/authorityState');

    const replaceBody = (body) => admin.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION public.azm_authority_activation_immutable()
         RETURNS trigger LANGUAGE plpgsql AS $attack$${body}$attack$`);

    const fnIdentity = async () => (await admin.$queryRawUnsafe(`
        SELECT p.oid::int AS oid, pg_get_userbyid(p.proowner) AS owner,
               l.lanname AS language, md5(p.prosrc) AS body_md5
          FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
         WHERE p.oid = '${TRIGGER_FN}'::regprocedure`))[0];

    const recordCount = async () => (await admin.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TABLE}`))[0].c;

    const activate = (client, over = {}) => client.$queryRawUnsafe(
        'SELECT public.azm_authority_activate($1,$2,$3,$4,$5) AS result',
        over.operator || ROLE.operator, 'approver-1', 'integrity rehearsal',
        'evidence://wp-h/trigger-integrity', over.digest || DIGEST);

    beforeAll(async () => {
        adminPg = new PrismaClient({ datasources: { db: { url: urlFor(null, 'postgres') } } });
        await adminPg.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${el(DB)} WITH (FORCE)`);
        await adminPg.$executeRawUnsafe(`CREATE DATABASE ${el(DB)}`);
        admin = new PrismaClient({ datasources: { db: { url: urlFor(null, DB) } } });

        for (const [key, name] of Object.entries(ROLE)) {
            const login = ['runtime', 'operator', 'migrator'].includes(key);
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
        ]) await admin.$executeRawUnsafe(ddl);

        const sql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'migrations',
            '20261110230000_p5d_enforced_authority_activation', 'migration.sql'), 'utf8');
        require('child_process').execFileSync('psql', [urlFor(null, DB), '-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], { input: sql });

        await admin.$executeRawUnsafe(`ALTER TABLE ${TABLE} OWNER TO ${el(ROLE.owner)}`);
        await admin.$executeRawUnsafe(`ALTER FUNCTION ${TRIGGER_FN} OWNER TO ${el(ROLE.owner)}`);
        await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${el(ROLE.runtime)}, ${el(ROLE.operator)}, ${el(ROLE.migrator)}`);
        await admin.$executeRawUnsafe(`INSERT INTO "GlobalSettings" ("id") VALUES (1)`);
        await admin.$executeRawUnsafe(`INSERT INTO "FiatLiquidityState" ("id", "availableGhs") VALUES (1, 5000)`);
        await admin.$executeRawUnsafe(`INSERT INTO "SystemFiatPool" ("id", "balance") VALUES (1, 42)`);

        runtime = new PrismaClient({ datasources: { db: { url: urlFor(ROLE.runtime, DB) } } });
        operator = new PrismaClient({ datasources: { db: { url: urlFor(ROLE.operator, DB) } } });

        try {
            const { installAuthorityActivationRoles } = require('../infra/install-authority-activation-roles');
            const report = await installAuthorityActivationRoles(admin, {
                owner: ROLE.owner, runtime: ROLE.runtime, operator: ROLE.operator,
                functionOwner: ROLE.fnOwner, log: () => {},
            });
            setupOk = report.ok;
            setupError = report.ok ? null : report.problems;
        } catch (err) {
            setupError = err.message;
        }
    }, 180000);

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
        expect(setupOk).toBe(true);
        await fn();
    }, ms);

    t('1. the canonical body is accepted and the enforcement inspection is satisfied', async () => {
        const identity = await fnIdentity();
        expect(identity).toBeTruthy();
        expect(identity.owner).toBe(ROLE.owner);
        expect(identity.language).toBe('plpgsql');

        const [src] = await admin.$queryRawUnsafe(
            `SELECT prosrc FROM pg_proc WHERE oid = '${TRIGGER_FN}'::regprocedure`);
        expect(src.prosrc).toBe(CANONICAL_TRIGGER_SOURCE);

        const inspection = await enforcement.inspectEnforcement(runtime);
        expect(inspection.problems).toEqual([]);
        expect(inspection.established).toBe(true);
    });

    t('2. the body is replaced in place: OID, name, owner, language and triggers all unchanged', async () => {
        const before = await fnIdentity();
        await replaceBody(NOOP_BODY);
        const after = await fnIdentity();

        expect(after.oid).toBe(before.oid);
        expect(after.owner).toBe(before.owner);
        expect(after.language).toBe(before.language);
        expect(after.body_md5).not.toBe(before.body_md5);

        const triggers = await admin.$queryRawUnsafe(`
            SELECT t.tgname, t.tgenabled, t.tgfoid = '${TRIGGER_FN}'::regprocedure AS same_fn
              FROM pg_trigger t
             WHERE t.tgrelid = '${TABLE}'::regclass AND NOT t.tgisinternal
             ORDER BY t.tgname`);
        expect(triggers.map((r) => r.tgname).sort()).toEqual([...TRIGGERS].sort());
        expect(triggers.every((r) => r.tgenabled === 'O' && r.same_fn === true)).toBe(true);
    });

    t('3. the runtime authority reader reports UNKNOWN, never ENFORCED_ACTIVE or ENFORCED_INACTIVE', async () => {
        const state = await resolveAuthorityState(runtime);
        expect(state.state).toBe(AUTHORITY_STATE.UNKNOWN);
        expect(state.reason).toBe(UNKNOWN_REASON.ENFORCEMENT_NOT_ESTABLISHED);
        expect(state.problems).toContain(enforcement.PROBLEM.TRIGGER_IMPLEMENTATION_DRIFT);

        const gate = await enforcement.readEnforcedAuthority(runtime);
        expect(gate.enforcedActive).toBe(false);
        expect(gate.enforcementEstablished).toBe(false);
        expect(gate.reason).toBe(enforcement.REASON.ENFORCEMENT_UNAVAILABLE);
        expect(gate.problems).toContain(enforcement.PROBLEM.TRIGGER_IMPLEMENTATION_DRIFT);
        await expect(enforcement.assertEnforcedAuthority(runtime)).rejects.toMatchObject({
            code: 'AUTHORITY_ENFORCEMENT_UNAVAILABLE', statusCode: 503,
        });
    });

    t('4. the activation function refuses before writing anything', async () => {
        expect(await recordCount()).toBe(0);
        await expect(activate(operator)).rejects.toThrow(/ENFORCEMENT_NOT_ESTABLISHED/);
        expect(await recordCount()).toBe(0);
        const [latch] = await admin.$queryRawUnsafe(
            `SELECT s."authorityActivatedAt" AS at, g."fiatLiquidityAuthorityEnabled" AS flag, p."balance"::text AS pool
               FROM "FiatLiquidityState" s, "GlobalSettings" g, "SystemFiatPool" p
              WHERE s."id"=1 AND g."id"=1 AND p."id"=1`);
        expect(latch.at).toBeNull();
        expect(latch.flag).toBe(false);
        expect(latch.pool).toBe('42.00');
    });

    t('5. UPDATE, DELETE and TRUNCATE are genuinely unprotected under the replaced body', async () => {
        await admin.$executeRawUnsafe(
            `INSERT INTO ${TABLE} ("id","activatedBy","approvedBy","evidenceReference","evidenceDigest")
             VALUES (1,'attacker','attacker','evidence://forged','${'c'.repeat(64)}')`);
        // The attack: the identity checks all pass, and the record mutates.
        await admin.$executeRawUnsafe(`UPDATE ${TABLE} SET "approvedBy" = 'forged-approver' WHERE "id" = 1`);
        const [row] = await admin.$queryRawUnsafe(`SELECT "approvedBy" FROM ${TABLE} WHERE "id" = 1`);
        expect(row.approvedBy).toBe('forged-approver');

        await admin.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE "id" = 1`);
        expect(await recordCount()).toBe(0);
    });

    t('6. restoring the canonical body restores the boundary and the activation succeeds', async () => {
        await replaceBody(CANONICAL_TRIGGER_SOURCE);

        const inspection = await enforcement.inspectEnforcement(runtime);
        expect(inspection.problems).toEqual([]);
        expect(inspection.established).toBe(true);

        const before = await fnIdentity();
        await admin.$executeRawUnsafe(`UPDATE ${TABLE} SET "approvedBy" = 'x' WHERE "id" = 1`).catch((err) => {
            expect(String(err.message)).toMatch(/append-only|42501/);
        });
        const after = await fnIdentity();
        expect(after.oid).toBe(before.oid);

        await activate(operator);
        expect(await recordCount()).toBe(1);

        await expect(admin.$executeRawUnsafe(`UPDATE ${TABLE} SET "approvedBy" = 'again' WHERE "id" = 1`))
            .rejects.toThrow(/append-only|insufficient_privilege|42501/i);
        await expect(admin.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE "id" = 1`))
            .rejects.toThrow(/append-only|insufficient_privilege|42501/i);
        await expect(admin.$executeRawUnsafe(`TRUNCATE ${TABLE}`))
            .rejects.toThrow(/append-only|insufficient_privilege|42501/i);

        const state = await resolveAuthorityState(runtime);
        expect(state.state).toBe(AUTHORITY_STATE.ENFORCED_ACTIVE);
    }, 60000);
});
