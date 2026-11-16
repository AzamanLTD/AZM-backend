// §WP-H split topology (positive control).
'use strict';
process.env.AUTHORITY_ENFORCEMENT_MODE = 'tri_state';
const { PrismaClient } = require('@prisma/client');
const A = require('../src/services/authorityState');
const activation = require('../src/services/fiatLiquidityActivationService');
const { installAuthorityActivationRoles } = require('../infra/install-authority-activation-roles');
const { createDisposableDatabase } = require('./helpers/disposableDatabase');

// The mirror image of wp-h-production-topology.pg.test.js. That suite proves the
// one-role production shape is REFUSED. This one proves the destination is
// REACHABLE: once migration authority, runtime and the table owner are separate
// roles, the gate positively proves INACTIVE instead of UNKNOWN, and the money
// paths read that answer instead of refusing.

const RUN = Math.random().toString(36).slice(2, 8);
const ROLE = {
    owner: `wphsplit_o_${RUN}`,
    runtime: `wphsplit_r_${RUN}`,
    operator: `wphsplit_p_${RUN}`,
    fnOwner: `wphsplit_f_${RUN}`,
};

jest.setTimeout(180000);

let db = null;
let admin = null;
let runtime = null;
let parent = null;

const q = (n) => `"${String(n).replace(/"/g, '""')}"`;

function urlWith(user, name) {
    const u = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
    u.username = user;
    u.password = 'wphsplitpass';
    u.pathname = `/${name}`;
    u.search = '';
    return u.toString();
}

afterAll(async () => {
    for (const c of [runtime, admin]) { try { await c.$disconnect(); } catch (_) {} }
    if (parent) {
        const p = new PrismaClient({ datasources: { db: { url: parent } } });
        for (const r of [ROLE.runtime, ROLE.operator, ROLE.fnOwner, ROLE.owner]) {
            await p.$executeRawUnsafe(`DROP ROLE IF EXISTS ${q(r)}`).catch(() => {});
        }
        await p.$disconnect();
    }
    if (db) await db.drop().catch(() => {});
});

test('the split boundary positively proves ENFORCED_INACTIVE (the state production needs)', async () => {
    db = await createDisposableDatabase('wphsplit');
    parent = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL).toString();
    admin = new PrismaClient({ datasources: { db: { url: db.url } } });

    for (const [name, login] of [[ROLE.owner, false], [ROLE.runtime, true], [ROLE.operator, true]]) {
        await admin.$executeRawUnsafe(
            // PostgreSQL DEFAULTS INHERIT to true: a fixture that omits it builds a
            // boundary the contract calls unsafe, and the gate now says so.
            `CREATE ROLE ${q(name)} ${login ? `LOGIN PASSWORD 'wphsplitpass'` : 'NOLOGIN'} `
            + 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT');
    }

    const report = await installAuthorityActivationRoles(admin, {
        owner: ROLE.owner,
        runtime: ROLE.runtime,
        operator: ROLE.operator,
        functionOwner: ROLE.fnOwner,
    });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);

    // The split is not just "separate the roles": the runtime identity must also
    // be able to READ the legacy latch it reports on, or every read is
    // LEGACY_UNREADABLE and the gate answers UNKNOWN forever. This grant is a
    // documented runbook step, not an installer side effect.
    await admin.$executeRawUnsafe(
        `GRANT SELECT ON "GlobalSettings", "FiatLiquidityState" TO ${q(ROLE.runtime)}`);

    runtime = new PrismaClient({ datasources: { db: { url: urlWith(ROLE.runtime, db.name) } } });

    const resolved = await A.resolveAuthorityState(runtime);
    if (resolved.state !== A.AUTHORITY_STATE.ENFORCED_INACTIVE) {
        throw new Error(`expected ENFORCED_INACTIVE after the split, got ${resolved.state}/${resolved.reason}: ` +
            `${JSON.stringify(resolved.problems)} ${JSON.stringify(resolved.diagnostics)}`);
    }
    expect(resolved.unit).toBe('USDC');
    expect(resolved.active).toBe(false);
    expect(resolved.problems).toEqual([]);

    // And the money-path reader publishes that answer rather than refusing.
    const mode = await activation.readMode(runtime);
    expect(mode.active).toBe(false);
    expect(mode.authorityState).toBe('ENFORCED_INACTIVE');
});
