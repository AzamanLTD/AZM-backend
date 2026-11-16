'use strict';

/**
 * WP-I — the ACTUAL provenance installer, against genuine LOGIN roles.
 *
 * The existing provenance suite creates roles and applies grants by hand, which
 * proves the SQL works but not that the shipped installer installs it. This
 * suite runs infra/wp-i/install-witness-provenance.js as a real process and
 * then asks PostgreSQL what the roles can actually do.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const ADMIN_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;

const RUNTIME_ROLE = 'wp_i_install_runtime';
const RECONCILER_ROLE = 'wp_i_install_reconciler';
const PW = 'wp_i_install_pw';

jest.setTimeout(120000);

describeDb('the shipped witness installer (real PostgreSQL)', () => {
    let admin;
    let report = null;
    let secondRun = null;

    beforeAll(async () => {
        admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
        await admin.$executeRawUnsafe('DELETE FROM "ProviderSettlementWitness"').catch(() => {});
        for (const role of [RUNTIME_ROLE, RECONCILER_ROLE]) {
            await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`);
            await admin.$executeRawUnsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${PW}'`);
        }
        const env = {
            ...process.env,
            DATABASE_URL: ADMIN_URL,
            AZM_WITNESS_RUNTIME_ROLE: RUNTIME_ROLE,
            AZM_WITNESS_RECONCILER_ROLE: RECONCILER_ROLE,
        };
        const run = () => execFileSync(process.execPath, [path.join('infra', 'wp-i', 'install-witness-provenance.js')], { env, encoding: 'utf8' });
        report = run();
        secondRun = run(); // idempotent: a second install must also exit 0
    });

    afterAll(async () => {
        if (!admin) return;
        for (const role of [RUNTIME_ROLE, RECONCILER_ROLE]) {
            await admin.$executeRawUnsafe(`DROP OWNED BY ${role}`).catch(() => {});
            await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
        }
        await admin.$disconnect();
    });

    // Connect AS the role. A superuser session can SET ROLE into anything, which
    // would make a membership test meaningless.
    const urlFor = (role) => {
        const u = new URL(ADMIN_URL);
        u.username = role; u.password = PW;
        return u.toString();
    };
    const clientFor = (role) => new PrismaClient({ datasources: { db: { url: urlFor(role) } } });
    const as = async (role, sql) => {
        const c = clientFor(role);
        try { return await c.$queryRawUnsafe(sql); } finally { await c.$disconnect(); }
    };
    const failsAs = async (role, sql) => {
        const c = clientFor(role);
        try { await c.$executeRawUnsafe(sql); return false; }
        catch (_) { return true; } finally { await c.$disconnect(); }
    };

    test('the installer reports success and runs twice without error', () => {
        expect(report).toMatch(/provenance installed/i);
        expect(secondRun).toMatch(/provenance installed/i);
    });

    test('runtime may read the witness table but cannot append', async () => {
        await expect(as(RUNTIME_ROLE, 'SELECT count(*) FROM "ProviderSettlementWitness"')).resolves.toBeDefined();
        const denied = await failsAs(RUNTIME_ROLE,
            `INSERT INTO "ProviderSettlementWitness" ("id","openingDedupKey","provider","fundingType","witnessKind","walletAccount","currency","netPesewas","providerState","endpoint","requestParams","rawResponseDigest","rawResponse","fetchedAt")
             VALUES ('x1','x1','MOOLRE','COLLECTION','k','A','GHS',1,'SETTLED','e','{}','d','r',now())`);
        expect(denied).toBe(true);
    });

    test('runtime cannot rewrite or remove a witness', async () => {
        expect(await failsAs(RUNTIME_ROLE, `UPDATE "ProviderSettlementWitness" SET "currency"='USD'`)).toBe(true);
        expect(await failsAs(RUNTIME_ROLE, `DELETE FROM "ProviderSettlementWitness"`)).toBe(true);
        expect(await failsAs(RUNTIME_ROLE, `TRUNCATE "ProviderSettlementWitness"`)).toBe(true);
    });

    test('the reconciler can read openings and append a witness, but not rewrite one', async () => {
        await expect(as(RECONCILER_ROLE, 'SELECT count(*) FROM "FiatLiquidityReceipt"')).resolves.toBeDefined();
        await expect(as(RECONCILER_ROLE,
            `INSERT INTO "ProviderSettlementWitness" ("id","openingDedupKey","provider","fundingType","witnessKind","walletAccount","currency","netPesewas","providerState","endpoint","requestParams","rawResponseDigest","rawResponse","fetchedAt")
             VALUES ('x2','x2','MOOLRE','COLLECTION','k','A','GHS',1,'SETTLED','e','{}','d','r',now()) RETURNING id`)).resolves.toBeDefined();
        expect(await failsAs(RECONCILER_ROLE, `UPDATE "ProviderSettlementWitness" SET "currency"='USD'`)).toBe(true);
        expect(await failsAs(RECONCILER_ROLE, `DELETE FROM "ProviderSettlementWitness"`)).toBe(true);
        expect(await failsAs(RECONCILER_ROLE, `TRUNCATE "ProviderSettlementWitness"`)).toBe(true);
    });

    test('the reconciler cannot promote liquidity or touch the aggregate', async () => {
        expect(await failsAs(RECONCILER_ROLE, `UPDATE "FiatLiquidityReceipt" SET "status"='AVAILABLE'`)).toBe(true);
        expect(await failsAs(RECONCILER_ROLE, `INSERT INTO "FiatLiquidityReceipt" ("id","provider","dedupKey","amountGhs","status") VALUES ('z','MOOLRE','z',1,'AVAILABLE')`)).toBe(true);
    });

    // The installer must refuse an identifier it cannot safely quote. A role name
    // is not a value: interpolating one is how a security installer becomes the
    // vulnerability.
    test('a role name that is not a plain identifier is refused before any grant', () => {
        const env = {
            ...process.env,
            DATABASE_URL: ADMIN_URL,
            AZM_WITNESS_RUNTIME_ROLE: 'runtime; DROP TABLE "ProviderSettlementWitness"',
            AZM_WITNESS_RECONCILER_ROLE: RECONCILER_ROLE,
        };
        let out = '';
        let code = 0;
        try {
            out = execFileSync(process.execPath, [path.join('infra', 'wp-i', 'install-witness-provenance.js')],
                { env, encoding: 'utf8', stdio: 'pipe' });
        } catch (e) {
            code = e.status;
            out = `${e.stdout || ''}${e.stderr || ''}`;
        }
        expect(code).toBe(1);
        expect(out).toMatch(/refusing to use/);
    });

    // The proof must be EFFECTIVE privilege, not a list of requested grants. A
    // role that inherits authority through membership still has it, so the
    // installer must fail on membership even when every direct grant is correct.
    test('inherited authority is refused even when every direct grant is correct', async () => {
        const env = {
            ...process.env,
            DATABASE_URL: ADMIN_URL,
            AZM_WITNESS_RUNTIME_ROLE: RUNTIME_ROLE,
            AZM_WITNESS_RECONCILER_ROLE: RECONCILER_ROLE,
        };
        const run = () => {
            try {
                return { code: 0, out: execFileSync(process.execPath,
                    [path.join('infra', 'wp-i', 'install-witness-provenance.js')],
                    { env, encoding: 'utf8', stdio: 'pipe' }) };
            } catch (e) {
                return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
            }
        };
        await admin.$executeRawUnsafe(`GRANT ${RECONCILER_ROLE} TO ${RUNTIME_ROLE}`);
        try {
            const bad = run();
            expect(bad.code).toBe(1);
            expect(bad.out).toMatch(/inherits/);
        } finally {
            await admin.$executeRawUnsafe(`REVOKE ${RECONCILER_ROLE} FROM ${RUNTIME_ROLE}`);
        }
        const good = run();
        expect(good.code).toBe(0);
        expect(good.out).toMatch(/provenance installed/i);
    });

    test('neither role can become the other', async () => {
        expect(await failsAs(RUNTIME_ROLE, `SET ROLE ${RECONCILER_ROLE}`)).toBe(true);
        expect(await failsAs(RECONCILER_ROLE, `SET ROLE ${RUNTIME_ROLE}`)).toBe(true);
    });
});
