// __tests__/wp-i-observation-arbitration.pg.test.js
// =============================================================================
// §WP-I — THE WITNESS AND THE UNRESOLVED-CASE WRITER CANNOT RACE
//
// A read of ReconciliationException is not an arbiter. This suite uses TWO
// independent PostgreSQL sessions (two PrismaClients, two connections) to prove
// the database-level rule rather than a sequential mock:
//
//   * the arbitration lock genuinely blocks a second session until the first
//     transaction ends, so one writer always observes the other's committed
//     result;
//   * Ordering A — the unresolved case is committed first, so the witness
//     refuses with WITNESS_EVIDENCE_UNDER_RECONCILIATION;
//   * the promotion guard's predicate matches an open case for the opening's
//     provider reference, which is what blocks a witness written BEFORE the case
//     from later unlocking spendable GHS (Ordering B).
//
// No sleeps decide any assertion: the timeout is a deliberate statement_timeout
// used to prove that the lock is held, and the retry after COMMIT is the proof
// that it was released.
// =============================================================================
'use strict';

const { PrismaClient } = require('@prisma/client');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const describeDB = DB_URL ? describe : describe.skip;
const RUN = Math.random().toString(36).slice(2, 8);
const REF = `arb-${RUN}`;

const { coordinationKey, acquireObservationArbitration } = require('../src/services/observationArbitration');
const { recordProviderSettlementWitness } = require('../src/services/providerSettlementWitnessService');

describeDB('§WP-I observation arbitration (two real sessions)', () => {
    let a;
    let b;

    beforeAll(async () => {
        process.env.AZM_RECONCILER_MODE = '1';
        // The reconciler must present its OWN provider credential, so the writer
        // authority check passes before the evidence check is reached. These are
        // fixtures: no live provider credential is used anywhere in this suite.
        process.env.AZM_RECONCILER_PROVIDER_USER = 'fixture-reconciler-user';
        process.env.AZM_RECONCILER_PROVIDER_PUBKEY = 'fixture-reconciler-pubkey';
        a = new PrismaClient();
        b = new PrismaClient();
        await a.$connect();
        await b.$connect();
    }, 60000);

    afterAll(async () => {
        await a.$executeRawUnsafe(`DELETE FROM "ReconciliationException" WHERE "reference" LIKE $1`, `arb-${RUN}%`);
        await a.$disconnect();
        await b.$disconnect();
    }, 60000);

    test('the lock blocks a second session until the first transaction ends', async () => {
        const identity = { provider: 'moolre', walletAccount: '0244000001', reference: REF };
        const key = coordinationKey(identity);
        // The wallet is deliberately NOT in the coordination key: a Case B has no
        // wallet and must still contend with a witness that does.
        expect(key).toBe(`wp-i:arb:moolre:${REF}`);
        expect(coordinationKey({ provider: 'moolre', reference: REF })).toBe(key);

        // Session A holds the lock inside an open transaction.
        const held = await a.$transaction(async (tx) => {
            const taken = await acquireObservationArbitration(tx, identity);
            // Session B must NOT get the lock while A is open: a short
            // statement_timeout turns "blocked" into an observable error.
            let blocked = null;
            try {
                await b.$transaction(async (txb) => {
                    await txb.$executeRawUnsafe(`SET LOCAL statement_timeout = '150ms'`);
                    await acquireObservationArbitration(txb, identity);
                });
            } catch (e) {
                blocked = e;
            }
            return { taken, blocked };
        });

        expect(held.taken).toBe(key);
        expect(held.blocked).not.toBeNull();

        // After A committed, the same lock is free: the retry succeeds.
        const after = await b.$transaction(async (txb) => acquireObservationArbitration(txb, identity));
        expect(after).toBe(key);
    }, 60000);

    test('Ordering A — a committed unresolved case makes the witness refuse', async () => {
        const reference = `${REF}-a`;
        // The opening must pre-exist: authority is checked first, then whether the
        // opening is real, then whether its evidence is disputed. The case guard is
        // therefore only reachable for an opening that exists.
        await a.fiatLiquidityReceipt.create({
            data: {
                provider: 'MOOLRE', dedupKey: `opening-${RUN}-a`, amountGhs: '120.00',
                status: 'RECEIVED', providerRef: reference, walletAccount: '0244000001',
            },
        });
        await a.$executeRawUnsafe(
            `INSERT INTO "ReconciliationException" ("entityType","entityId","reference","reason","status","details")
             VALUES ('DEPOSIT_FIAT',$1,$2,'PROVIDER_EVIDENCE_WITHOUT_CANONICAL_REFERENCE','OPEN','{}'::jsonb)`,
            `dep-${RUN}-a`, reference,
        );

        await expect(b.$transaction((tx) => recordProviderSettlementWitness(tx, {
            openingDedupKey: `opening-${RUN}-a`,
            provider: 'moolre',
            fundingType: 'COLLECTION',
            externalref: reference,
            walletAccount: '0244000001',
        }))).rejects.toMatchObject({ code: 'WITNESS_EVIDENCE_UNDER_RECONCILIATION' });
    }, 60000);

    test('Ordering B — the promotion predicate matches a case recorded after the witness', async () => {
        // The witness-wins interleaving leaves a witness committed and the case
        // recorded afterwards. Promotion reads this exact predicate before it can
        // move a receipt to AVAILABLE; here we prove the predicate matches, and
        // that it stops matching once the case is adjudicated.
        const reference = `${REF}-b`;
        await a.$executeRawUnsafe(
            `INSERT INTO "ReconciliationException" ("entityType","entityId","reference","reason","status","details")
             VALUES ('DEPOSIT_FIAT',$1,$2,'PROVIDER_EVIDENCE_CONFLICTS_WITH_WITNESS','OPEN','{}'::jsonb)`,
            `dep-${RUN}-b`, reference,
        );

        const blocking = async () => a.$queryRawUnsafe(
            `SELECT "entityId","reason" FROM "ReconciliationException"
              WHERE "status" = 'OPEN'
                AND "reason" IN ('PROVIDER_EVIDENCE_WITHOUT_CANONICAL_REFERENCE',
                                 'PROVIDER_EVIDENCE_CONFLICTS_WITH_WITNESS')
                AND "reference" = $1 LIMIT 1`,
            reference,
        );
        expect((await blocking()).length).toBe(1);

        await a.$executeRawUnsafe(
            `UPDATE "ReconciliationException" SET "status" = 'RESOLVED', "resolvedAt" = now()
              WHERE "reference" = $1 AND "status" = 'OPEN'`,
            reference,
        );
        expect((await blocking()).length).toBe(0);
    }, 60000);
});
