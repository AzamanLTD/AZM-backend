// __tests__/wp-h-production-topology.pg.test.js
// =============================================================================
// §WP-H — THE PRODUCTION TOPOLOGY MUST FAIL CLOSED.
//
// render.yaml runs the release chain and the application on ONE connection
// string, so in production a single role is migration authority, runtime AND the
// owner of the protected record. Every property the authority boundary depends on
// (owner separate from runtime, runtime unable to write, operator unable to write)
// is false in that shape.
//
// The dangerous outcome is not a crash: it is the gate answering "inactive" and
// every caller interpreting it as legacy USDC. This suite builds that exact
// topology and proves the answer is UNKNOWN with a typed 503, never a currency.
// =============================================================================
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const A = require('../src/services/authorityState');
const activation = require('../src/services/fiatLiquidityActivationService');

const BASE = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const RUN = Math.random().toString(36).slice(2, 8);
const DB = `azm_wph_prodtopo_${RUN}`;
const SINGLE = `wph_single_${RUN}`;
const PWD = 'wphpass123';
const MIGRATION = path.join(__dirname, '..', 'prisma', 'migrations',
    '20261110230000_p5d_enforced_authority_activation', 'migration.sql');

const urlFor = (user, db, pw) => {
    const u = new URL(BASE);
    if (user) { u.username = user; u.password = pw; }
    u.pathname = `/${db}`;
    u.search = '';
    return u.toString();
};
const psql = (url, sql) => execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });

let admin = null;
let single = null;
let ready = false;
let setupError = null;

beforeAll(async () => {
    if (!BASE) { setupError = 'no DATABASE_URL'; return; }
    try {
        admin = new PrismaClient({ datasources: { db: { url: urlFor(null, 'postgres') } } });
        await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
        await admin.$executeRawUnsafe(`CREATE DATABASE "${DB}"`);
        await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${SINGLE}"`);
        await admin.$executeRawUnsafe(`CREATE ROLE "${SINGLE}" LOGIN PASSWORD '${PWD}'`);

        const adminUrl = urlFor(null, DB);
        psql(adminUrl, `GRANT ALL ON SCHEMA public TO "${SINGLE}";
            GRANT ALL ON DATABASE "${DB}" TO "${SINGLE}";`);

        // THE PRODUCTION SHAPE: the ONE application role executes the migration,
        // so it owns the protected table and the immutability trigger function.
        execFileSync('psql', [urlFor(SINGLE, DB, PWD), '-v', 'ON_ERROR_STOP=1', '-f', MIGRATION], { stdio: 'pipe' });

        single = new PrismaClient({ datasources: { db: { url: urlFor(SINGLE, DB, PWD) } } });
        ready = true;
    } catch (err) {
        setupError = err.message;
    }
}, 180000);

afterAll(async () => {
    for (const c of [single, admin]) { if (c) { try { await c.$disconnect(); } catch (_) { /* ignore */ } } }
    try {
        if (admin) {
            await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
            await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${SINGLE}"`);
        }
    } catch (_) { /* cleanup failures surface in the residue check, not here */ }
}, 120000);

const t = (name, fn, ms) => test(name, async () => {
    if (!ready) throw new Error(`single-role topology unavailable: ${setupError}`);
    const prev = process.env.AUTHORITY_ENFORCEMENT_MODE;
    process.env.AUTHORITY_ENFORCEMENT_MODE = 'tri_state';
    try { await fn(); } finally {
        if (prev === undefined) delete process.env.AUTHORITY_ENFORCEMENT_MODE;
        else process.env.AUTHORITY_ENFORCEMENT_MODE = prev;
    }
}, ms);

describe('WP-H production topology: one role is owner, migrator and runtime', () => {
    t('the single role really does own the protected record', async () => {
        const [row] = await single.$queryRawUnsafe(`
            SELECT pg_get_userbyid(c.relowner) AS owner, current_user AS rt
              FROM pg_class c WHERE c.oid = to_regclass('public."FiatLiquidityAuthorityActivation"')`);
        expect(row.owner).toBe(row.rt);
    });

    t('the authority state is UNKNOWN, never ENFORCED_INACTIVE', async () => {
        const resolved = await A.resolveAuthorityState(single);
        expect(resolved.state).toBe(A.AUTHORITY_STATE.UNKNOWN);
        expect(resolved.state).not.toBe(A.AUTHORITY_STATE.ENFORCED_INACTIVE);
        // No currency may be read out of a refusal.
        expect(resolved.unit).toBeNull();
        expect(resolved.active).toBeNull();
        // The diagnostics must NAME the defect, so an operator can act on it.
        expect(resolved.problems).toContain('RUNTIME_OWNS_TABLE');
    });

    t('the canonical money-path reader refuses with a typed 503', async () => {
        await expect(activation.readMode(single)).rejects.toMatchObject({
            code: 'AUTHORITY_STATE_UNAVAILABLE',
            statusCode: 503,
        });
    });

    t('an economic transaction cannot obtain a shared authority snapshot', async () => {
        let caught = null;
        try {
            await single.$transaction(async (tx) => {
                await A.lockAuthorityShared(tx);
                await A.requireAuthorityState(tx);
            });
        } catch (err) { caught = err; }
        expect(caught).not.toBeNull();
        expect(caught.code).toBe('AUTHORITY_STATE_UNAVAILABLE');
        // The refusal must not leak role names or ACL detail to a caller.
        expect(String(caught.message)).not.toMatch(/wph_single_/);
    });
});
