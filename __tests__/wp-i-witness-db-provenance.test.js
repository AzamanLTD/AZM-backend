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
            await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
        }
        // The runtime identity: may READ evidence, may never author it.
        await admin.$executeRawUnsafe(`GRANT SELECT ON "ProviderSettlementWitness" TO ${RUNTIME_ROLE}`);
        await admin.$executeRawUnsafe(`GRANT SELECT, INSERT ON "ProviderSettlementWitness" TO ${RECONCILER_ROLE}`);

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

    test('the runtime process cannot write a witness even holding full DB rights', async () => {
        // Credential separation is defeated inside one process: the CODE guard is
        // what refuses there. This asserts that guard is real.
        const { assertReconcilerContext, WitnessWriterNotPermittedError } =
            require('../src/services/providerSettlementWitnessService');
        const savedMode = process.env.AZM_RECONCILER_MODE;
        const savedKey = process.env.AZM_RECONCILER_PROVIDER_KEY;
        delete process.env.AZM_RECONCILER_MODE;
        delete process.env.AZM_RECONCILER_PROVIDER_USER;
        delete process.env.AZM_RECONCILER_PROVIDER_PUBKEY;
        try {
            expect(() => assertReconcilerContext()).toThrow(WitnessWriterNotPermittedError);
        } finally {
            if (savedMode !== undefined) process.env.AZM_RECONCILER_MODE = savedMode;
            if (savedKey !== undefined) process.env.AZM_RECONCILER_PROVIDER_KEY = savedKey;
        }
    });
});
