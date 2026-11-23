// §WP-H 1.4 + 1.5 — DEFAULT ACLs ARE A FUTURE-OBJECT GRANT PATH.
//
// The claim under test is not "a REVOKE statement ran". It is: after the
// normaliser runs, objects created LATER by the function-owner role carry no
// PUBLIC and no named-role privilege. So the test poisons pg_default_acl in
// every category (TABLES, SEQUENCES, FUNCTIONS, TYPES; global and
// schema-specific; PUBLIC and a named role with GRANT OPTION), runs the real
// normaliser, then CREATES new objects as that role and reads their actual
// ACLs out of pg_class / pg_proc / pg_type.
//
// PostgreSQL's built-in defaults differ per category, which is why the
// assertions differ: tables and sequences default to owner-only (NULL acl),
// functions default to EXECUTE for PUBLIC. A function whose proacl is still
// NULL after normalisation has NOT been protected.
'use strict';

const { PrismaClient } = require('@prisma/client');
const {
    revokeDefaultPrivileges,
    inspectDefaultPrivileges,
} = require('../infra/lib/authority-default-acl');
const { resolveAuthorityRoles, assertDistinctRoles } = require('../infra/lib/authority-roles');

const RUN = Math.random().toString(36).slice(2, 8);
const FN_OWNER = `wpacl_fn_${RUN}`;
const POISON = `wpacl_poison_${RUN}`;
const q = (n) => '"' + String(n).replace(/"/g, '""') + '"';

let prisma;

beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL } } });
    await prisma.$executeRawUnsafe(`CREATE ROLE ${q(FN_OWNER)} NOLOGIN`);
    await prisma.$executeRawUnsafe(`CREATE ROLE ${q(POISON)} NOLOGIN`);
    await prisma.$executeRawUnsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${q(FN_OWNER)}`);
});

afterAll(async () => {
    // DROP OWNED removes everything the disposable roles own (tables, sequences,
    // types, functions and their default ACLs) in one statement, so cleanup
    // cannot fail on an ordering detail after the assertions have passed.
    const attempt = async (sql) => { try { await prisma.$executeRawUnsafe(sql); } catch (_) { /* best effort */ } };
    try {
        await attempt(`DROP OWNED BY ${q(FN_OWNER)}`);
        await attempt(`DROP OWNED BY ${q(POISON)}`);
        await attempt(`DROP ROLE IF EXISTS ${q(FN_OWNER)}`);
        await attempt(`DROP ROLE IF EXISTS ${q(POISON)}`);
    } finally {
        await prisma.$disconnect();
    }
});

async function poisonDefaults() {
    const statements = [
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${q(FN_OWNER)} GRANT ALL ON TABLES TO PUBLIC`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${q(FN_OWNER)} GRANT ALL ON SEQUENCES TO PUBLIC`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${q(FN_OWNER)} GRANT ALL ON FUNCTIONS TO PUBLIC`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${q(FN_OWNER)} GRANT ALL ON TYPES TO PUBLIC`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${q(FN_OWNER)} IN SCHEMA public GRANT ALL ON TABLES TO ${q(POISON)} WITH GRANT OPTION`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${q(FN_OWNER)} IN SCHEMA public GRANT ALL ON SEQUENCES TO ${q(POISON)} WITH GRANT OPTION`,
    ];
    for (const sql of statements) await prisma.$executeRawUnsafe(sql);
}

async function createFutureObjects() {
    // Objects created BY the function owner, exactly as a later installer would.
    await prisma.$executeRawUnsafe(`SET ROLE ${q(FN_OWNER)}`);
    try {
        await prisma.$executeRawUnsafe(`CREATE TABLE public.acl_probe_table_${RUN} (id int)`);
        await prisma.$executeRawUnsafe(`CREATE SEQUENCE public.acl_probe_seq_${RUN}`);
        await prisma.$executeRawUnsafe(`CREATE TYPE public.acl_probe_type_${RUN} AS ENUM ('a')`);
        await prisma.$executeRawUnsafe(`CREATE FUNCTION public.acl_probe_fn_${RUN}() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`);
    } finally {
        await prisma.$executeRawUnsafe('RESET ROLE');
    }
}

const aclOf = async (sql) => {
    const rows = await prisma.$queryRawUnsafe(sql);
    const row = rows && rows[0];
    return row ? row.acl : null;
};

describe('§WP-H 1.4 default privileges do not leak onto future objects', () => {
    test('poisoned defaults are visible, revoked, and then absent', async () => {
        await poisonDefaults();

        const before = [];
        const inspected = await inspectDefaultPrivileges(prisma, FN_OWNER, before);
        expect(inspected.entries.length).toBeGreaterThan(0);
        expect(before.length).toBeGreaterThan(0);
        // Both PUBLIC and the named grantee must be reported, not just one.
        expect(before.some((p) => p.includes('PUBLIC'))).toBe(true);
        expect(before.some((p) => p.includes(POISON))).toBe(true);

        const applied = [];
        const revoked = await revokeDefaultPrivileges(prisma, FN_OWNER, applied);
        expect(revoked).toBeGreaterThan(0);
        expect(applied.length).toBeGreaterThanOrEqual(revoked);
        expect(applied.some((a) => a.includes('FUNCTIONS without PUBLIC execute'))).toBe(true);

        const after = [];
        const clean = await inspectDefaultPrivileges(prisma, FN_OWNER, after);
        expect(after).toEqual([]);
        expect(clean.entries).toEqual([]);
    });

    test('objects created after normalisation carry no PUBLIC or named-role privilege', async () => {
        await createFutureObjects();

        const tableAcl = await aclOf(`SELECT relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND c.relname='acl_probe_table_${RUN}'`);
        const seqAcl = await aclOf(`SELECT relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND c.relname='acl_probe_seq_${RUN}'`);
        const fnAcl = await aclOf(`SELECT proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public' AND p.proname='acl_probe_fn_${RUN}'`);
        const typeAcl = await aclOf(`SELECT typacl::text AS acl FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname='public' AND t.typname='acl_probe_type_${RUN}'`);

        // The objects must exist; a vacuous test proves nothing.
        expect(await prisma.$queryRawUnsafe(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='acl_probe_table_${RUN}'`)).toHaveLength(1);

        // A PUBLIC grant is the ACL item that starts with '=' (no grantee name).
        // 'owner=r/owner' contains '=r/' too, so matching that substring would
        // flag the owner's own grant — the item boundary is what matters.
        const PUBLIC_ITEM = /(^|,)=[a-zA-Z*]/;
        for (const [kind, acl] of [['table', tableAcl], ['sequence', seqAcl], ['type', typeAcl]]) {
            if (acl === null) continue; // owner-only default: nothing granted
            expect(`${kind}:${acl}`).not.toMatch(PUBLIC_ITEM);
            expect(`${kind}:${acl}`).not.toContain(POISON);
        }

        // A function is the category with a real built-in PUBLIC grant, so NULL
        // here would mean the poison survived rather than that it was removed.
        expect(fnAcl).not.toBeNull();
        expect(fnAcl).not.toMatch(PUBLIC_ITEM);
        expect(fnAcl).not.toContain(POISON);
    });
});

describe('§WP-H 1.5 one resolver, distinct identities', () => {
    test('option beats environment beats canonical default', () => {
        const env = { AUTHORITY_OWNER_ROLE: 'env_owner', AUTHORITY_RUNTIME_ROLE: 'env_runtime' };
        const fromEnv = resolveAuthorityRoles({}, env);
        expect(fromEnv.owner).toBe('env_owner');
        expect(fromEnv.runtime).toBe('env_runtime');
        expect(fromEnv.operator).toBe('azm_authority_operator'); // canonical default
        expect(fromEnv.functionOwner).toBe('env_owner_fn');       // derived, never separately defaulted

        const fromOption = resolveAuthorityRoles({ owner: 'opt_owner', functionOwner: 'opt_fn' }, env);
        expect(fromOption.owner).toBe('opt_owner');
        expect(fromOption.functionOwner).toBe('opt_fn');
        expect(fromOption.sources.owner).toBe('option');
    });

    test('colliding identities are refused', () => {
        expect(() => assertDistinctRoles({ owner: 'x', runtime: 'x', operator: 'o', functionOwner: 'f' })).toThrow(/distinct/);
        expect(() => assertDistinctRoles({ owner: 'x', runtime: 'r', operator: 'o', functionOwner: 'x' })).toThrow(/distinct/);
        expect(() => assertDistinctRoles({ owner: 'x', runtime: 'r', operator: 'o', functionOwner: 'f' })).not.toThrow();
    });
});
