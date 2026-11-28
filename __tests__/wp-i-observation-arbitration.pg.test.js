// __tests__/wp-i-observation-arbitration.pg.test.js
// =============================================================================
// §WP-I — THE TWO REAL PRODUCTION WRITERS CANNOT RACE
//
// The earlier version of this suite proved that `pg_advisory_xact_lock` blocks a
// second session, and then INSERTed the unresolved case with raw SQL. That proved
// the lock works; it did NOT prove the product's writers contend, because neither
// real writer appeared in the interleaving.
//
// This suite drives BOTH production writers against two genuine PostgreSQL
// sessions (two PrismaClients, two connections):
//
//   * the settlement-witness writer   -> recordProviderSettlementWitness()
//   * the Case B unresolved-evidence  -> recordUnresolvedEvidenceCase()
//     writer used by the backfill        (the same function the release-chain
//                                         backfill calls; no test-only copy)
//
// and the REAL treasury promotion guard -> confirmTreasuryOpening().
//
// PROVES
//   A. Case B wins  — A records the case under the lock; B's witness writer
//                     contends on the same coordination key (observable as a
//                     statement_timeout while A is open), and once A commits B
//                     observes the open case and refuses with
//                     WITNESS_EVIDENCE_UNDER_RECONCILIATION. No spendable GHS.
//   B. Witness wins — A commits the witness; B's Case B writer still takes the
//                     same coordination key and records the unresolved case; the
//                     promotion guard then refuses to make the funds spendable
//                     with the reconciliation reason, and only an explicit
//                     operator resolution releases it.
//   C. Rollback     — a rolled-back Case B leaves no case and releases the lock,
//                     so a legitimate retry proceeds.
//
// No sleep decides any assertion: the statement_timeout is a deliberate statement
// that the lock is HELD, and every "after commit" assertion is the proof that it
// was released.
// =============================================================================
'use strict';

const { PrismaClient } = require('@prisma/client');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const describeDB = DB_URL ? describe : describe.skip;

const { coordinationKey, acquireObservationArbitration } = require('../src/services/observationArbitration');
const { recordProviderSettlementWitness } = require('../src/services/providerSettlementWitnessService');
const { recordUnresolvedEvidenceCase, readOpenUnresolvedCase } = require('../src/services/unresolvedEvidenceCaseService');
const fiatLiquidity = require('../src/services/fiatLiquidityService');

const RUN = Math.random().toString(36).slice(2, 8);
const REASON = 'PROVIDER_EVIDENCE_WITHOUT_CANONICAL_REFERENCE';
const WALLET = '0244000000';
const AMOUNT = 120;

/** The documented Moolre Payment Status shape. Fixture only: no live provider call. */
function providerPayloadFor(ref) {
    return {
        status: '1',
        data: {
            txstatus: 1,
            externalref: ref,
            accountnumber: WALLET,
            value: String(AMOUNT.toFixed(2)),
            amount: String((AMOUNT + 2).toFixed(2)),
        },
    };
}

describeDB('§WP-I observation arbitration — both real production writers', () => {
    let a;
    let b;

    beforeAll(async () => {
        process.env.AZM_RECONCILER_MODE = '1';
        // The reconciler must present its OWN provider credential, so the writer
        // authority check passes before the evidence check is reached. Fixtures:
        // no live provider credential is used anywhere in this suite.
        process.env.AZM_RECONCILER_PROVIDER_USER = 'fixture-reconciler-user';
        process.env.AZM_RECONCILER_PROVIDER_PUBKEY = 'fixture-reconciler-pubkey';
        a = new PrismaClient();
        b = new PrismaClient();
        await a.$connect();
        await b.$connect();
    }, 60000);

    afterAll(async () => {
        await a.$executeRawUnsafe(`DELETE FROM "ReconciliationException" WHERE "entityId" LIKE $1`, `dep-${RUN}%`);
        await a.$executeRawUnsafe(`DELETE FROM "ProviderObservationClaim" WHERE "claimedByRef" LIKE $1`, `%${RUN}%`);
        await a.providerSettlementWitness.deleteMany({ where: { openingDedupKey: { contains: RUN } } });
        await a.fiatLiquidityReceipt.deleteMany({ where: { dedupKey: { contains: RUN } } });
        await a.fiatProviderEvent.deleteMany({ where: { dedupKey: { contains: RUN } } });
        await a.$disconnect();
        await b.$disconnect();
    }, 60000);

    /**
     * Seed ONE treasury opening with a durable external observation, so the
     * promotion path can reach its evidence checks. Returns the identifiers.
     */
    async function seedOpening(tag) {
        const reference = `arb-${RUN}-${tag}`;
        const openingDedupKey = `opening-${RUN}-${tag}`;
        const eventDedupKey = `event-${RUN}-${tag}`;
        const depositId = `dep-${RUN}-${tag}`;

        await a.fiatLiquidityState.upsert({
            where: { id: 1 }, update: {}, create: { id: 1, availableGhs: 0 },
        });
        await a.$transaction((tx) => fiatLiquidity.recordReceipt(tx, {
            provider: 'AZM_TREASURY',
            rail: 'INTERNAL',
            dedupKey: openingDedupKey,
            amountGhs: AMOUNT,
            treasury: true,
            walletAccount: WALLET,
            evidence: { kind: 'AUDITED_TREASURY_OPENING' },
        }));
        await a.fiatProviderEvent.create({
            data: {
                provider: 'MOOLRE', rail: 'BANK', direction: 'INBOUND', status: 'FUNDED',
                providerRef: reference, dedupKey: eventDedupKey, amountGhs: AMOUNT,
                walletAccount: WALLET,
            },
        });
        return { reference, openingDedupKey, eventDedupKey, depositId };
    }

    /** Write the REAL witness for an opening, in its own transaction. */
    function writeWitness(client, openingDedupKey, reference) {
        const payload = providerPayloadFor(reference);
        return client.$transaction((tx) => recordProviderSettlementWitness(tx, {
            openingDedupKey,
            provider: 'MOOLRE',
            fundingType: 'COLLECTION',
            endpoint: 'https://api.moolre.com/open/transact/status',
            requestParams: { id: reference },
            rawResponse: JSON.stringify(payload),
            providerPayload: payload.data,
            fetchedAt: new Date(),
            walletAccount: WALLET,
            currencyMapping: { [WALLET]: 'GHS' },
            externalref: reference,
        }));
    }

    test('the coordination key is wallet-independent for both writers', () => {
        const reference = `arb-${RUN}-key`;
        const withWallet = coordinationKey({ provider: 'moolre', walletAccount: WALLET, reference });
        const withoutWallet = coordinationKey({ provider: 'moolre', reference });
        // A Case B has no trustworthy wallet by definition and must still contend
        // with a witness that does.
        expect(withWallet).toBe(withoutWallet);
        expect(withWallet).toBe(`wp-i:arb:moolre:${reference}`);
    });

    test('the lock is held inside the transaction and released at its end', async () => {
        const reference = `arb-${RUN}-lock`;
        const identity = { provider: 'moolre', walletAccount: WALLET, reference };
        const key = coordinationKey(identity);

        const held = await a.$transaction(async (tx) => {
            const taken = await acquireObservationArbitration(tx, identity);
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
        // Released: the same lock is free after COMMIT.
        const after = await b.$transaction((txb) => acquireObservationArbitration(txb, identity));
        expect(after).toBe(key);
    }, 60000);

    // ── ORDERING A: the unresolved Case B wins ───────────────────────────────
    test('Ordering A — the real Case B writer holds the lock, then the real witness writer refuses', async () => {
        const { reference, openingDedupKey, eventDedupKey, depositId } = await seedOpening('a');

        // Session A: the PRODUCTION Case B writer, inside an open transaction.
        const caseOutcome = await a.$transaction(async (tx) => {
            const recorded = await recordUnresolvedEvidenceCase(tx, {
                depositId,
                reason: REASON,
                ties: [`providerRef(${reference})`, 'settlementProviderRef(disagrees)'],
                providerRef: reference,
                txHash: null,
                evidenceIds: [eventDedupKey],
            });

            // Session B: the PRODUCTION witness writer for the SAME provider and
            // reference. It must contend on the same coordination key — while A is
            // open it cannot complete, which a short statement_timeout makes
            // observable without any sleep deciding the assertion.
            let contended = null;
            try {
                await b.$transaction(async (txb) => {
                    await txb.$executeRawUnsafe(`SET LOCAL statement_timeout = '250ms'`);
                    await writeWitness({ $transaction: (fn) => fn(txb) }, openingDedupKey, reference);
                });
            } catch (e) {
                contended = e;
            }
            return { recorded, contended };
        }, { timeout: 30000 });

        expect(caseOutcome.recorded.outcome).toBe('inserted');
        expect(caseOutcome.contended).not.toBeNull();

        // A committed. Session B now observes the OPEN case and refuses — a typed
        // witness refusal, not a lock timeout and not a silent success.
        await expect(writeWitness(b, openingDedupKey, reference))
            .rejects.toMatchObject({ code: 'WITNESS_EVIDENCE_UNDER_RECONCILIATION' });

        // No spendable GHS can be promoted from that observation.
        await expect(a.$transaction((tx) => fiatLiquidity.confirmTreasuryOpening(tx, {
            dedupKey: openingDedupKey, confirmedBy: 1, providerEventDedupKey: eventDedupKey,
        }))).rejects.toMatchObject({ name: 'TreasuryFundingEvidenceUnavailableError' });

        const receipt = await a.fiatLiquidityReceipt.findUnique({ where: { dedupKey: openingDedupKey } });
        expect(receipt.status).toBe('RECEIVED');
    }, 90000);

    // ── ORDERING B: the witness wins ─────────────────────────────────────────
    test('Ordering B — a committed witness, then the real Case B writer preserves the case and blocks promotion', async () => {
        const { reference, openingDedupKey, eventDedupKey, depositId } = await seedOpening('b');

        // Session A: the real witness writer, committed.
        await writeWitness(a, openingDedupKey, reference);
        expect(await a.providerSettlementWitness.count({ where: { openingDedupKey } })).toBe(1);

        // Session B: the real Case B writer for the same provider/reference. It
        // takes the same coordination key (now free) and records the unresolved
        // case rather than being lost behind the witness.
        const recorded = await b.$transaction((tx) => recordUnresolvedEvidenceCase(tx, {
            depositId,
            reason: REASON,
            ties: [`providerRef(${reference})`],
            providerRef: reference,
            txHash: null,
            evidenceIds: [eventDedupKey],
        }));
        expect(recorded.outcome).toBe('inserted');
        expect(await readOpenUnresolvedCase(a, depositId, REASON)).not.toBeNull();

        // The REAL promotion guard refuses, and it refuses for the reconciliation
        // reason — not because the witness is missing (the witness exists above).
        let guardError = null;
        try {
            await a.$transaction((tx) => fiatLiquidity.confirmTreasuryOpening(tx, {
                dedupKey: openingDedupKey, confirmedBy: 1, providerEventDedupKey: eventDedupKey,
            }));
        } catch (e) {
            guardError = e;
        }
        expect(guardError).not.toBeNull();
        expect(guardError.details && guardError.details.reason).toBe(REASON);
        expect(guardError.message).toMatch(/under operator reconciliation/i);

        const stillReceived = await a.fiatLiquidityReceipt.findUnique({ where: { dedupKey: openingDedupKey } });
        expect(stillReceived.status).toBe('RECEIVED');

        // Explicit operator resolution is the ONLY thing that releases it.
        await a.$executeRawUnsafe(
            `UPDATE "ReconciliationException" SET "status" = 'RESOLVED', "resolvedAt" = now()
              WHERE "entityType" = 'DEPOSIT_FIAT' AND "entityId" = $1 AND "reason" = $2 AND "status" = 'OPEN'`,
            depositId, REASON,
        );
        const confirmed = await a.$transaction((tx) => fiatLiquidity.confirmTreasuryOpening(tx, {
            dedupKey: openingDedupKey, confirmedBy: 1, providerEventDedupKey: eventDedupKey,
        }));
        expect(confirmed.receipt.status).toBe('AVAILABLE');
    }, 90000);

    // ── ROLLBACK: the lock is released and nothing is left behind ────────────
    test('a rolled-back Case B leaves no case and releases the lock for a legitimate retry', async () => {
        const { reference, openingDedupKey, eventDedupKey, depositId } = await seedOpening('c');

        await expect(a.$transaction(async (tx) => {
            await recordUnresolvedEvidenceCase(tx, {
                depositId,
                reason: REASON,
                ties: [`providerRef(${reference})`],
                providerRef: reference,
                txHash: null,
                evidenceIds: [eventDedupKey],
            });
            // Fail AFTER the lock and the case write: the whole transaction,
            // including the lock, must roll back.
            throw new Error('deliberate rollback after the Case B write');
        })).rejects.toThrow(/deliberate rollback/);

        // No invisible half-state: the case is gone with the transaction.
        expect(await readOpenUnresolvedCase(a, depositId, REASON)).toBeNull();

        // And the lock is free: a legitimate witness write for the same reference
        // now proceeds under the real ownership and evidence rules.
        const witness = await writeWitness(b, openingDedupKey, reference);
        expect(witness).toBeTruthy();
        expect(await a.providerSettlementWitness.count({ where: { openingDedupKey } })).toBe(1);
    }, 90000);
});
