'use strict';

/**
 * WP-I — database-enforced provenance (real PostgreSQL, real logins).
 *
 * The application-authored event row problem cannot be closed by code alone:
 * the runtime process holds a credential that can INSERT into every table it
 * owns. This suite proves the DATABASE refuses that write for the runtime
 * identity, using two genuine LOGIN roles rather than mocks.
 *
 * Roles are created by this suite (requires a superuser test connection, which
 * the CI postgres service provides) and dropped afterwards.
 */

const { PrismaClient } = require('@prisma/client');

const SUPER_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const RUNTIME_ROLE = 'azam_wp_i_runtime';
const RECONCILER_ROLE = 'azam_wp_i_reconciler';
const PASSWORD = 'wp_i_test_pw';

function urlFor(role) {
    const u = new URL(SUPER_URL);
    u.username = role;
    u.password = PASSWORD;
    return u.toString();
}

const admin = new PrismaClient({ datasources: { db: { url: SUPER_URL } } });
let runtime;
let reconciler;

const describeDb = SUPER_URL ? describe : describe.skip;

describeDb('WP-I database provenance (real PostgreSQL roles)', () => {
    beforeAll(async () => {
        for (const role of [RUNTIME_ROLE, RECONCILER_ROLE]) {
            await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`);
            await admin.$executeRawUnsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${PASSWORD}'`);
        }
        // §7 — the grants come from the INSTALLER, not from this file. A test that
        // recreates them by hand proves what the test author wrote, not what
        // deployment applies. The installer is run twice here: the second run is
        // the idempotency check, and any drift in its GRANT/REVOKE statements
        // would break the assertions below.
        process.env.WP_I_PROVISION_WITNESS_ROLES = '1';
        process.env.WP_I_RUNTIME_ROLE = RUNTIME_ROLE;
        process.env.WP_I_RECONCILER_ROLE = RECONCILER_ROLE;
        const installer = require('../infra/install-wp-i-settlement-witness.js');
        await installer.runInstaller();
        await installer.runInstaller();

        runtime = new PrismaClient({ datasources: { db: { url: urlFor(RUNTIME_ROLE) } } });
        reconciler = new PrismaClient({ datasources: { db: { url: urlFor(RECONCILER_ROLE) } } });
    }, 60000);

    afterAll(async () => {
        await runtime?.$disconnect();
        await reconciler?.$disconnect();
        await admin.$executeRawUnsafe(`DROP OWNED BY ${RUNTIME_ROLE}`);
        await admin.$executeRawUnsafe(`DROP OWNED BY ${RECONCILER_ROLE}`);
        await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RUNTIME_ROLE}`);
        await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RECONCILER_ROLE}`);
        await admin.$disconnect();
    }, 60000);

    const witnessRow = (over = {}) => ({
        openingDedupKey: `DB-WITNESS-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        provider: 'MOOLRE',
        fundingType: 'COLLECTION',
        witnessKind: 'PAYMENT_STATUS_TYPE_1',
        walletAccount: '0244000000',
        currency: 'GHS',
        netPesewas: 25000n,
        providerState: 'SETTLED',
        endpoint: 'https://api.moolre.com/open/transact/status',
        requestParams: {},
        rawResponseDigest: 'a'.repeat(64),
        rawResponse: '{"state":"SETTLED","value":"250.00"}',
        fetchedAt: new Date(),
        ...over,
    });

    test('the runtime identity CANNOT insert a witness', async () => {
        // Scope to THIS opening: other suites legitimately hold witnesses, and a
        // global count would assert their absence rather than this refusal.
        const key = `DB-WITNESS-DENIED-${Date.now()}`;
        await expect(runtime.providerSettlementWitness.create({ data: witnessRow({ openingDedupKey: key }) }))
            .rejects.toThrow(/permission denied/i);
        expect(await admin.providerSettlementWitness.count({ where: { openingDedupKey: key } })).toBe(0);
    });

    test('the reconciler identity CAN insert, and the runtime can read it', async () => {
        const row = witnessRow({ openingDedupKey: 'DB-WITNESS-READ-1' });
        const created = await reconciler.providerSettlementWitness.create({ data: row });
        const seen = await runtime.providerSettlementWitness.findUnique({
            where: { openingDedupKey: 'DB-WITNESS-READ-1' },
        });
        expect(seen).not.toBeNull();
        expect(seen.netPesewas).toBe(25000n);
        await admin.providerSettlementWitness.delete({ where: { id: created.id } });
    });

    test('the runtime identity CANNOT update a witness amount', async () => {
        const created = await reconciler.providerSettlementWitness.create({
            data: witnessRow({ openingDedupKey: 'DB-WITNESS-UPD-1' }),
        });
        await expect(runtime.providerSettlementWitness.update({
            where: { id: created.id },
            data: { netPesewas: 999999n },
        })).rejects.toThrow(/permission denied/i);
        const after = await admin.providerSettlementWitness.findUnique({ where: { id: created.id } });
        expect(after.netPesewas).toBe(25000n);
        await admin.providerSettlementWitness.delete({ where: { id: created.id } });
    });

    test('the runtime identity CANNOT delete a witness', async () => {
        const created = await reconciler.providerSettlementWitness.create({
            data: witnessRow({ openingDedupKey: 'DB-WITNESS-DEL-1' }),
        });
        await expect(runtime.providerSettlementWitness.delete({ where: { id: created.id } }))
            .rejects.toThrow(/permission denied/i);
        expect(await admin.providerSettlementWitness.count({ where: { id: created.id } })).toBe(1);
        await admin.providerSettlementWitness.delete({ where: { id: created.id } });
    });

    test('the reconciler identity cannot rewrite an existing witness either', async () => {
        const created = await reconciler.providerSettlementWitness.create({
            data: witnessRow({ openingDedupKey: 'DB-WITNESS-IMMUTABLE-1' }),
        });
        await expect(reconciler.providerSettlementWitness.update({
            where: { id: created.id },
            data: { netPesewas: 1n },
        })).rejects.toThrow(/permission denied/i);
        await admin.providerSettlementWitness.delete({ where: { id: created.id } });
    });


    // ── §7 PRIVILEGE MATRIX ──────────────────────────────────────────────────
    // The grants above are only half the claim. These prove the OTHER half: what
    // each identity must be UNABLE to do, including reaching the other's rights.

    test('the reconciler identity cannot touch customer balances, deposits or the ledger', async () => {
        for (const sql of [
            'UPDATE "User" SET "balance" = "balance" + 1',
            'UPDATE "TransactionHistory" SET "status" = \'COMPLETED\'',
            'DELETE FROM "TransactionHistory"',
            'UPDATE "FiatLiquidityState" SET "availableGhs" = 999999',
        ]) {
            await expect(reconciler.$executeRawUnsafe(sql)).rejects.toBeTruthy();
        }
    }, 60000);

    test('the reconciler identity cannot rewrite or remove a witness it created', async () => {
        const key = `DB-WITNESS-${Date.now()}-immut`;
        await reconciler.$executeRawUnsafe(
            'INSERT INTO "ProviderSettlementWitness" ("id","openingDedupKey","provider","fundingType","witnessKind","walletAccount","currency","netPesewas","providerState","endpoint","requestParams","rawResponseDigest","rawResponse","fetchedAt") '
            + "VALUES (gen_random_uuid(), $1, 'MOOLRE', 'COLLECTION', 'PAYMENT_STATUS_TYPE_1', '0244000000', 'GHS', 100, 'SETTLED', 'e', '{}'::jsonb, repeat('a',64), '{}', now())",
            key,
        );
        await expect(reconciler.$executeRawUnsafe('UPDATE "ProviderSettlementWitness" SET "netPesewas" = 999 WHERE "openingDedupKey" = $1', key)).rejects.toBeTruthy();
        await expect(reconciler.$executeRawUnsafe('DELETE FROM "ProviderSettlementWitness" WHERE "openingDedupKey" = $1', key)).rejects.toBeTruthy();
        await expect(reconciler.$executeRawUnsafe('TRUNCATE "ProviderSettlementWitness"')).rejects.toBeTruthy();
    }, 60000);

    test('the runtime identity cannot assume the reconciler rights by role switching', async () => {
        await expect(runtime.$executeRawUnsafe(`SET ROLE ${RECONCILER_ROLE}`)).rejects.toBeTruthy();
        const [who] = await runtime.$queryRawUnsafe('SELECT session_user AS s, current_user AS c');
        expect(who.s).toBe(RUNTIME_ROLE);
        expect(who.c).toBe(RUNTIME_ROLE);
    }, 60000);

    test('session_user and current_user are reported as the actual login, not the owner', async () => {
        const [asRuntime] = await runtime.$queryRawUnsafe('SELECT session_user AS s, current_user AS c, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super');
        expect(asRuntime.s).toBe(RUNTIME_ROLE);
        expect(asRuntime.c).toBe(RUNTIME_ROLE);
        expect(asRuntime.is_super).toBe(false);

        const [asReconciler] = await reconciler.$queryRawUnsafe('SELECT session_user AS s, current_user AS c, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super');
        expect(asReconciler.s).toBe(RECONCILER_ROLE);
        expect(asReconciler.c).toBe(RECONCILER_ROLE);
        expect(asReconciler.is_super).toBe(false);
    }, 60000);

    test('the runtime process cannot write a witness even holding full DB rights', async () => {
        // Credential separation is defeated inside one process: the CODE guard is
        // what refuses there. This asserts that guard is real.
        const { assertReconcilerContext, WitnessWriterNotPermittedError } =
            require('../src/services/providerSettlementWitnessService');
        const savedMode = process.env.AZM_RECONCILER_MODE;
        const savedKey = process.env.AZM_RECONCILER_PROVIDER_USER;
        delete process.env.AZM_RECONCILER_MODE;
        delete process.env.AZM_RECONCILER_PROVIDER_USER;
        delete process.env.AZM_RECONCILER_PROVIDER_PUBKEY;
        try {
            expect(() => assertReconcilerContext()).toThrow(WitnessWriterNotPermittedError);
        } finally {
            if (savedMode !== undefined) process.env.AZM_RECONCILER_MODE = savedMode;
            if (savedKey !== undefined) { process.env.AZM_RECONCILER_PROVIDER_USER = savedKey; process.env.AZM_RECONCILER_PROVIDER_PUBKEY = savedKey; }
        }
    });
});
