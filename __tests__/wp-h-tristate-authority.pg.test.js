// __tests__/wp-h-tristate-authority.pg.test.js
// =============================================================================
// §WP-H — the tri-state authority boundary, proved with GENUINE role logins.
//
// No `SET ROLE` simulation: four real PostgreSQL logins are created (owner is
// NOLOGIN, runtime/operator/migrator are separate LOGINs), the protected table
// is installed from the shipped migration, and every assertion runs over the
// connection belonging to the identity it is about.
//
// The activation record is APPEND-ONLY: nothing here deletes or truncates it.
// Isolation comes from a disposable database per run, which is dropped at the
// end, so cleanup can never be "reset the control record".
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const A = require('../src/services/authorityState');
const activation = require('../src/services/fiatLiquidityActivationService');

const BASE = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const RUN = Math.random().toString(36).slice(2, 8);
const DB = `azm_wph_ts_${RUN}`;
const PWD = 'wphpass123';
const ROLE = {
    owner: `wph_owner_${RUN}`,
    runtime: `wph_runtime_${RUN}`,
    operator: `wph_operator_${RUN}`,
    migrator: `wph_migrator_${RUN}`,
};
const MIGRATION = path.join(
    __dirname, '..', 'prisma', 'migrations',
    '20261110230000_p5d_enforced_authority_activation', 'migration.sql'
);

const urlFor = (role, db) => {
    const u = new URL(BASE);
    if (role) { u.username = role; u.password = PWD; }
    u.pathname = `/${db}`;
    // psql rejects Prisma's ?schema= query parameter; public is the default.
    u.search = '';
    return u.toString();
};
const q = (ident) => `"${ident}"`;

let adminPg = null;   // connection to the maintenance database
let admin = null;     // superuser on the disposable database
let runtime = null;
let operator = null;
let migrator = null;
let ready = false;
let setupError = null;

const clients = [];

/** Run one script through psql (multi-statement DDL: triggers, functions). */
function psqlFile(url, file) {
    execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file], { stdio: 'pipe' });
}
function psql(url, sql) {
    // psql -c accepts a single command string; multiple commands are allowed by
    // psql itself (unlike a prepared statement), so pass them one -c at a time.
    for (const part of sql.split(';').map((x) => x.trim()).filter(Boolean)) {
        execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', '-c', part], { stdio: 'pipe' });
    }
}

/** A refusal must be a real PostgreSQL privilege/trigger refusal. */
async function expectDenied(fn, pattern = /permission denied|42501|denied|immutable|append-only|must be owner|must be superuser/i) {
    let caught = null;
    try { await fn(); } catch (err) { caught = err; }
    expect(caught).toBeTruthy();
    const text = `${caught.code || ''} ${caught.message || ''} ${JSON.stringify(caught.meta || {})}`;
    expect(text).toMatch(pattern);
    return text;
}

beforeAll(async () => {
    if (!BASE) { setupError = 'no DATABASE_URL'; return; }
    try {
        adminPg = new PrismaClient({ datasources: { db: { url: urlFor(null, 'postgres') } } });
        clients.push(adminPg);
        await adminPg.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${q(DB)} WITH (FORCE)`);
        await adminPg.$executeRawUnsafe(`CREATE DATABASE ${q(DB)}`);

        admin = new PrismaClient({ datasources: { db: { url: urlFor(null, DB) } } });
        clients.push(admin);

        await admin.$executeRawUnsafe(`CREATE ROLE ${q(ROLE.owner)} NOLOGIN`);
        for (const r of [ROLE.runtime, ROLE.operator, ROLE.migrator]) {
            await admin.$executeRawUnsafe(`CREATE ROLE ${q(r)} LOGIN PASSWORD '${PWD}'`);
        }

        // The tables the legacy latch lives on, and the pool the mode reader uses.
        const stmts = [
            'CREATE TABLE "GlobalSettings" ("id" int PRIMARY KEY, "fiatLiquidityAuthorityEnabled" boolean DEFAULT false)',
            'CREATE TABLE "FiatLiquidityState" ("id" int PRIMARY KEY, "authorityActivatedAt" timestamp, "availableGhs" numeric)',
            'CREATE TABLE "SystemFiatPool" ("id" int PRIMARY KEY, "balance" numeric)',
            'INSERT INTO "GlobalSettings" ("id","fiatLiquidityAuthorityEnabled") VALUES (1,false)',
            'INSERT INTO "FiatLiquidityState" ("id","availableGhs") VALUES (1,0)',
            'INSERT INTO "SystemFiatPool" ("id","balance") VALUES (1,0)',
        ];
        for (const sql of stmts) await admin.$executeRawUnsafe(sql);

        // The protected record, installed from the SHIPPED migration.
        const adminUrl = urlFor(null, DB);
        psqlFile(adminUrl, MIGRATION);

        // Ownership separation: the table and its trigger function belong to a
        // NOLOGIN owner, never to the runtime and never to the migrator.
        psql(adminUrl, `ALTER TABLE "FiatLiquidityAuthorityActivation" OWNER TO ${q(ROLE.owner)};
            ALTER FUNCTION azm_authority_activation_immutable() OWNER TO ${q(ROLE.owner)};
            GRANT USAGE ON SCHEMA public TO ${q(ROLE.runtime)}, ${q(ROLE.operator)}, ${q(ROLE.migrator)};
            GRANT SELECT ON "GlobalSettings", "FiatLiquidityState", "SystemFiatPool" TO ${q(ROLE.runtime)}, ${q(ROLE.operator)};
            GRANT SELECT ON "FiatLiquidityAuthorityActivation" TO ${q(ROLE.runtime)}, ${q(ROLE.operator)};
            GRANT INSERT ON "FiatLiquidityAuthorityActivation" TO ${q(ROLE.operator)};`);

        runtime = new PrismaClient({ datasources: { db: { url: urlFor(ROLE.runtime, DB) } } });
        operator = new PrismaClient({ datasources: { db: { url: urlFor(ROLE.operator, DB) } } });
        migrator = new PrismaClient({ datasources: { db: { url: urlFor(ROLE.migrator, DB) } } });
        clients.push(runtime, operator, migrator);
        ready = true;
    } catch (err) {
        setupError = err.message;
    }
}, 120000);

afterAll(async () => {
    for (const c of clients) { try { await c.$disconnect(); } catch (_) { /* ignore */ } }
    if (!adminPg) return;
    try {
        await adminPg.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${q(DB)} WITH (FORCE)`);
        for (const r of [ROLE.runtime, ROLE.operator, ROLE.migrator, ROLE.owner]) {
            await adminPg.$executeRawUnsafe(`DROP ROLE IF EXISTS ${q(r)}`);
        }
    } catch (_) { /* best effort */ }
}, 60000);

const t = (name, fn, ms) => test(name, async () => {
    if (!ready) throw new Error(`role provisioning unavailable: ${setupError}`);
    await fn();
}, ms);

const ACTIVATION_ROW = {
    id: 1,
    activatedAt: new Date('2026-11-12T00:00:00Z'),
    activatedBy: 'operator-1',
    approvedBy: 'treasury-1',
    evidenceReference: 'TREASURY-DECISION-2026-11-12',
    evidenceDigest: 'a'.repeat(64),
};

describe('WP-H tri-state authority (real PostgreSQL logins)', () => {
    t('the regime lock identity is shared with the activation sequence', async () => {
        expect(A.AUTHORITY_LOCK_KEY).toBe(activation.ACTIVATION_LOCK_KEY);
    });

    t('ENFORCED_INACTIVE is positively verified: no record, enforcement proven, unit USDC', async () => {
        const resolved = await A.resolveAuthorityState(runtime);
        if (resolved.state !== A.AUTHORITY_STATE.ENFORCED_INACTIVE) {
            throw new Error(`expected ENFORCED_INACTIVE, got ${resolved.state}/${resolved.reason}: ${JSON.stringify(resolved.problems)} ${JSON.stringify(resolved.diagnostics)}`);
        }
        expect(resolved.unit).toBe('USDC');
        expect(resolved.active).toBe(false);
        expect(resolved.problems).toEqual([]);
    });

    t('a legacy latch with no protected record is UNKNOWN, never inactive', async () => {
        await admin.$executeRawUnsafe('UPDATE "GlobalSettings" SET "fiatLiquidityAuthorityEnabled" = true WHERE "id" = 1');
        try {
            const resolved = await A.resolveAuthorityState(runtime);
            expect(resolved.state).toBe(A.AUTHORITY_STATE.UNKNOWN);
            expect(resolved.reason).toBe(A.UNKNOWN_REASON.LEGACY_CONTRADICTS_INACTIVE);
            expect(resolved.unit).toBeNull();
            expect(resolved.active).toBeNull();
            await expect(A.requireAuthorityState(runtime)).rejects.toMatchObject({
                code: 'AUTHORITY_STATE_UNAVAILABLE',
                statusCode: 503,
            });
        } finally {
            await admin.$executeRawUnsafe('UPDATE "GlobalSettings" SET "fiatLiquidityAuthorityEnabled" = false WHERE "id" = 1');
        }
    });

    t('runtime cannot insert, update, delete or truncate the protected record', async () => {
        await expectDenied(() => runtime.$executeRawUnsafe(
            `INSERT INTO "FiatLiquidityAuthorityActivation" ("id","activatedBy","approvedBy","evidenceReference","evidenceDigest")
             VALUES (1,'x','y','z','${'b'.repeat(64)}')`));
        await expectDenied(() => runtime.$executeRawUnsafe('UPDATE "FiatLiquidityAuthorityActivation" SET "activatedBy" = \'x\' WHERE "id" = 1'));
        await expectDenied(() => runtime.$executeRawUnsafe('DELETE FROM "FiatLiquidityAuthorityActivation" WHERE "id" = 1'));
        await expectDenied(() => runtime.$executeRawUnsafe('TRUNCATE TABLE "FiatLiquidityAuthorityActivation"'));
    });

    t('runtime cannot alter, drop or disable the protection triggers', async () => {
        await expectDenied(() => runtime.$executeRawUnsafe('ALTER TABLE "FiatLiquidityAuthorityActivation" DISABLE TRIGGER ALL'));
        await expectDenied(() => runtime.$executeRawUnsafe('DROP TABLE "FiatLiquidityAuthorityActivation"'));
        await expectDenied(() => runtime.$executeRawUnsafe('ALTER TABLE "FiatLiquidityAuthorityActivation" OWNER TO CURRENT_USER'));
    });

    t('the owner is genuinely NOLOGIN and is not the runtime role', async () => {
        const rows = await admin.$queryRawUnsafe(
            'SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[])', [ROLE.owner, ROLE.runtime]);
        const owner = rows.find((r) => r.rolname === ROLE.owner);
        const rt = rows.find((r) => r.rolname === ROLE.runtime);
        expect(owner.rolcanlogin).toBe(false);
        expect(rt.rolcanlogin).toBe(true);
        expect(rows.filter((r) => r.rolcanlogin).length).toBeGreaterThan(0);
    });

    t('the migrator cannot take ownership of, drop or rewrite the record', async () => {
        await expectDenied(() => migrator.$executeRawUnsafe('ALTER TABLE "FiatLiquidityAuthorityActivation" OWNER TO CURRENT_USER'));
        await expectDenied(() => migrator.$executeRawUnsafe('DROP TABLE "FiatLiquidityAuthorityActivation"'));
        await expectDenied(() => migrator.$executeRawUnsafe('UPDATE "FiatLiquidityAuthorityActivation" SET "activatedBy" = \'m\' WHERE "id" = 1'));
    });

    t('the narrow operator inserts the activation; the state becomes ENFORCED_ACTIVE with unit GHS', async () => {
        await operator.$executeRawUnsafe(
            `INSERT INTO "FiatLiquidityAuthorityActivation"
               ("id","activatedAt","activatedBy","approvedBy","evidenceReference","evidenceDigest")
             VALUES (1,$1,$2,$3,$4,$5)`,
            ACTIVATION_ROW.activatedAt, ACTIVATION_ROW.activatedBy, ACTIVATION_ROW.approvedBy,
            ACTIVATION_ROW.evidenceReference, ACTIVATION_ROW.evidenceDigest);

        const resolved = await A.resolveAuthorityState(runtime);
        expect(resolved.state).toBe(A.AUTHORITY_STATE.ENFORCED_ACTIVE);
        expect(resolved.unit).toBe('GHS');
        expect(resolved.active).toBe(true);
        expect(resolved.activation.evidenceReference).toBe(ACTIVATION_ROW.evidenceReference);
    });

    t('append-only: the operator cannot rewrite or delete the record it inserted', async () => {
        await expectDenied(() => operator.$executeRawUnsafe(
            'UPDATE "FiatLiquidityAuthorityActivation" SET "evidenceReference" = \'rewritten\' WHERE "id" = 1'));
        await expectDenied(() => operator.$executeRawUnsafe(
            'DELETE FROM "FiatLiquidityAuthorityActivation" WHERE "id" = 1'));
        const still = await admin.$queryRawUnsafe(
            'SELECT "evidenceReference" FROM "FiatLiquidityAuthorityActivation" WHERE "id" = 1');
        expect(still[0].evidenceReference).toBe(ACTIVATION_ROW.evidenceReference);
    });

    t('a blank-evidence record is rejected by the database, so activation cannot be an anonymous flag flip', async () => {
        await expectDenied(() => operator.$executeRawUnsafe(
            `INSERT INTO "FiatLiquidityAuthorityActivation" ("id","activatedBy","approvedBy","evidenceReference","evidenceDigest")
             VALUES (2,' ',' ',' ','${'c'.repeat(64)}')`), /check|constraint|denied|immutable/i);
    });

    t('a disabled or missing trigger makes the state UNKNOWN', async () => {
        await admin.$executeRawUnsafe('ALTER TABLE "FiatLiquidityAuthorityActivation" DISABLE TRIGGER ALL');
        try {
            const resolved = await A.resolveAuthorityState(runtime);
            expect(resolved.state).toBe(A.AUTHORITY_STATE.UNKNOWN);
            expect(resolved.unit).toBeNull();
            expect(resolved.problems.join(',')).toMatch(/TRIGGER/);
        } finally {
            await admin.$executeRawUnsafe('ALTER TABLE "FiatLiquidityAuthorityActivation" ENABLE TRIGGER ALL');
        }
        const restored = await A.resolveAuthorityState(runtime);
        expect(restored.state).toBe(A.AUTHORITY_STATE.ENFORCED_ACTIVE);
    }, 30000);

    t('a missing protected table is UNKNOWN, not inactive', async () => {
        const bareDb = `${DB}_bare`;
        await adminPg.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${q(bareDb)} WITH (FORCE)`);
        await adminPg.$executeRawUnsafe(`CREATE DATABASE ${q(bareDb)}`);
        const bare = new PrismaClient({ datasources: { db: { url: urlFor(null, bareDb) } } });
        try {
            // The legacy latch tables exist and say "not activated", which is the
            // dangerous case: without the protected table this must NOT read as
            // inactive-USDC.
            await bare.$executeRawUnsafe('CREATE TABLE "GlobalSettings" ("id" int PRIMARY KEY, "fiatLiquidityAuthorityEnabled" boolean DEFAULT false)');
            await bare.$executeRawUnsafe('CREATE TABLE "FiatLiquidityState" ("id" int PRIMARY KEY, "authorityActivatedAt" timestamp, "availableGhs" numeric)');
            await bare.$executeRawUnsafe('INSERT INTO "GlobalSettings" ("id","fiatLiquidityAuthorityEnabled") VALUES (1,false)');
            await bare.$executeRawUnsafe('INSERT INTO "FiatLiquidityState" ("id","availableGhs") VALUES (1,0)');
            const resolved = await A.resolveAuthorityState(bare);
            expect(resolved.state).toBe(A.AUTHORITY_STATE.UNKNOWN);
            expect(resolved.reason).toBe(A.UNKNOWN_REASON.TABLE_MISSING);
            expect(resolved.unit).toBeNull();
        } finally {
            await bare.$disconnect();
            await adminPg.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${q(bareDb)} WITH (FORCE)`);
        }
    }, 60000);

    t('an inspection that throws is UNKNOWN, never inactive', async () => {
        const broken = { $queryRawUnsafe: async () => { throw new Error('probe exploded'); } };
        const resolved = await A.resolveAuthorityState(broken);
        expect(resolved.state).toBe(A.AUTHORITY_STATE.UNKNOWN);
        // Either the probe threw (INSPECTION_FAILED) or the inspector reported
        // the probe failure as a problem (ENFORCEMENT_NOT_ESTABLISHED). Both are
        // an incomplete inspection, and neither may be read as "inactive".
        expect([A.UNKNOWN_REASON.INSPECTION_FAILED, A.UNKNOWN_REASON.ENFORCEMENT_NOT_ESTABLISHED])
            .toContain(resolved.reason);
        expect(resolved.unit).toBeNull();
        expect(resolved.active).toBeNull();
    });

    t('the shared/exclusive advisory protocol serialises activation against economic readers', async () => {
        // A held SHARED lock blocks activation's EXCLUSIVE lock ...
        await expect(runtime.$transaction(async (tx) => {
            expect(await A.tryLockAuthorityShared(tx)).toBe(true);
            // ... and a second shared lock is still admitted (readers do not block readers).
            await operator.$transaction(async (tx2) => {
                expect(await A.tryLockAuthorityShared(tx2)).toBe(true);
            });
            const blocked = await migrator.$transaction(async (tx3) => {
                const ok = await A.tryLockAuthorityExclusive(tx3);
                return ok;
            });
            expect(blocked).toBe(false);
        }, { timeout: 20000 })).resolves.toBeUndefined();

        // With no shared holder, activation's exclusive lock is granted.
        const after = await migrator.$transaction(async (tx) => A.tryLockAuthorityExclusive(tx));
        expect(after).toBe(true);
    }, 40000);

    t('the economic wrapper takes the lock BEFORE reading the state and refuses UNKNOWN', async () => {
        const seen = await runtime.$transaction(async (tx) => A.withAuthoritySnapshot(tx, (state) => state.state));
        expect(seen).toBe(A.AUTHORITY_STATE.ENFORCED_ACTIVE);

        const broken = { $queryRawUnsafe: async () => { throw new Error('down'); } };
        await expect(A.requireAuthorityState(broken)).rejects.toMatchObject({ code: 'AUTHORITY_STATE_UNAVAILABLE' });
    }, 30000);
});
