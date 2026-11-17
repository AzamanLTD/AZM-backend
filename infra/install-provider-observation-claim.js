#!/usr/bin/env node
'use strict';

// =============================================================================
// §WP-I — install + backfill the provider-observation claim.
//
// WHAT COUNTS AS A GENUINE MOOLRE COLLECTION (this is the whole job)
//
// The claim table is new, so observations consumed BEFORE this release have no
// row. Backfilling wrongly is expensive in both directions:
//
//   * claim too much — an observation that was never an economic use blocks a
//     deposit that should settle, or claims money the treasury may still use;
//   * claim too little — a Moolre deposit that already settled stays claimable,
//     and the same provider money can be consumed a second time as treasury
//     funding.
//
// metadata.provider IS NOT THE PROCESSOR. Both initiation controllers write the
// CUSTOMER-SELECTED MoMo rail there ('MTN_MOMO', 'TELECEL_CASH', 'VODAFONE_CASH',
// 'AIRTELTIGO'), so filtering on metadata.provider === 'moolre' matches nothing
// the application actually writes, and reading the rail as the processor would
// classify an ordinary aggregator deposit as Moolre money.
//
// The processor identity is derived from what the settlement itself persisted:
//
//   1. the deposit is COMPLETED (an observation alone is not an economic use),
//   2. it records metadata.settlementExternalRef — the exact reference the
//      settlement ledger key was built from, and the exact reference the live
//      claim service uses (moolreDepositSettlement passes `reference: externalRef`
//      to claimProviderObservation, and externalRef IS settlementExternalRef),
//   3. a SUCCESSFUL INBOUND FiatProviderEvent with provider 'MOOLRE' ties to it
//      through one of the durable ties the writers actually create:
//        * dedupKey 'event:moolre-collection:<reference>'  (the durable Moolre
//          observation the OTP-confirmation path enriches and the recovery
//          service settles under),
//        * providerRef = <reference>,
//        * relatedReference = the deposit's txHash.
//   4. nothing contradicts: metadata.settlementProviderRef, the deposit's
//      providerRef and the event's providerRef, where present, must agree.
//
// A generic aggregator settlement writes its evidence under provider
// 'GENERIC_FIAT_WEBHOOK', so an identical MoMo rail without a Moolre event is
// never claimed.
//
// ATOMICITY CONTRACT (documented, and proved by test)
//
// The whole backfill — DDL and every claim insert — runs inside ONE database
// transaction. There is no phase that commits claims while leaving earlier
// writes behind:
//
//   * any failure (a conflicting owner, a constraint, an injected fault) aborts
//     the transaction, so NO claim row survives AND the DDL is rolled back —
//     the table itself does not exist afterwards if it did not before;
//   * the operation is therefore all-or-nothing ON A GIVEN DATABASE STATE, and
//     it is also idempotent: re-running on an installed database inserts
//     nothing and reports zero new claims;
//   * an interrupted run leaves exactly the state it started in: no partial
//     claim set, so no observation becomes consumable by exactly one path and
//     not the other. That is the property that matters — an interrupted
//     backfill can never leave a settled Moolre deposit unclaimed while its
//     witnesses are claimed.
//
// A very large history is handled by the same property rather than by batching:
// the selection is a set of reads, the writes are small rows, and a re-run is
// always safe. If the write volume ever makes one transaction impractical, the
// replacement must keep the invariant "a key is either claimed for its one
// legitimate owner, quarantined, or untouched" — never a partial claim set.
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { canonicalObservationIdentity } = require('../src/services/providerObservationIdentity');

const SQL_FILE = path.join(__dirname, 'sql', 'provider-observation-claim.sql');

/** The only provider-event status that records a settled inbound collection. */
const MOOLRE_SUCCESS_STATUS = 'SUCCESSFUL';
const MOOLRE_EVENT_PREFIX = 'event:moolre-collection:';

function referenceFromWitness(row) {
    const params = row.requestParams && typeof row.requestParams === 'object' ? row.requestParams : {};
    for (const candidate of [params.id, params.reference, params.externalref]) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    const raw = row.rawResponse;
    if (typeof raw === 'string' && raw.trim().startsWith('{')) {
        try {
            const parsed = JSON.parse(raw);
            for (const candidate of [parsed.externalref, parsed.reference, parsed.transactionid, parsed?.data?.transactionid]) {
                if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
            }
        } catch (_) { /* not JSON: no reference to derive */ }
    }
    return null;
}

const keyFor = (reference) => canonicalObservationIdentity({ provider: 'moolre', reference }).observationKey;

/**
 * Read-only candidate selection. Identical for a dry run and a real run, which
 * is what makes "dry-run reports exactly what it would do" a provable claim.
 */
async function selectCandidates(db) {
    const report = {
        depositOwners: new Map(),
        witnessOwners: new Map(),
        anomalies: [],
        skipped: {
            nonMoolreDeposits: 0,
            nonMoolreWitnesses: 0,
            unclassifiableDeposits: 0,
            unclassifiableWitnesses: 0,
            notCompleted: 0,
        },
    };

    const addOwner = (map, key, owner) => {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(owner);
    };
    const anomaly = (kind, observationKey, owners, detail, subject = null) => {
        report.anomalies.push({ kind, observationKey, owners, detail, subject });
    };

    // ── durable Moolre processor evidence ────────────────────────────────
    const events = await db.$queryRawUnsafe(`
        SELECT "dedupKey", "providerRef", "relatedReference"
        FROM "FiatProviderEvent"
        WHERE "provider" = 'MOOLRE' AND "direction" = 'INBOUND' AND "status" = '${MOOLRE_SUCCESS_STATUS}'
    `);
    const eventByDedupKey = new Map();
    const eventsByProviderRef = new Map();
    const eventsByRelatedReference = new Map();
    for (const e of events) {
        eventByDedupKey.set(String(e.dedupKey), e);
        if (e.providerRef) {
            const k = String(e.providerRef);
            if (!eventsByProviderRef.has(k)) eventsByProviderRef.set(k, []);
            eventsByProviderRef.get(k).push(e);
        }
        if (e.relatedReference) {
            const k = String(e.relatedReference);
            if (!eventsByRelatedReference.has(k)) eventsByRelatedReference.set(k, []);
            eventsByRelatedReference.get(k).push(e);
        }
    }
    const eventFor = (ref, txHash) => {
        const byKey = eventByDedupKey.get(`${MOOLRE_EVENT_PREFIX}${ref}`);
        if (byKey) return byKey;
        const byRef = eventsByProviderRef.get(ref);
        if (byRef && byRef.length) return byRef[0];
        const byTx = txHash ? eventsByRelatedReference.get(txHash) : null;
        return byTx && byTx.length ? byTx[0] : null;
    };

    // ── completed customer deposits ──────────────────────────────────────
    const deposits = await db.$queryRawUnsafe(`
        SELECT "id", "txHash",
               COALESCE("metadata"->>'settlementExternalRef', '')  AS ref,
               COALESCE("metadata"->>'settlementProviderRef', '')  AS settlement_provider_ref,
               COALESCE("providerRef", '')                         AS provider_ref,
               COALESCE("metadata"->>'provider', '')               AS rail
        FROM "TransactionHistory"
        WHERE "type" IN ('DEPOSIT_FIAT', 'DEPOSIT_CRYPTO') AND "status" = 'COMPLETED'
    `);

    for (const d of deposits) {
        const ref = String(d.ref || '').trim();
        const txHash = d.txHash ? String(d.txHash) : null;

        if (!ref) {
            // A Moolre observation tied to this row but no committed settlement
            // reference: we cannot name the canonical key the live path uses, so
            // this is unclassifiable, not claimable and not silently dropped.
            const tied = txHash ? eventByDedupKey.get(`${MOOLRE_EVENT_PREFIX}${txHash}`) || eventsByRelatedReference.get(txHash)?.[0] : null;
            if (tied) {
                report.skipped.unclassifiableDeposits += 1;
                anomaly('MOOLRE_EVIDENCE_WITHOUT_SETTLEMENT_REFERENCE', null, [String(d.id)],
                    'a successful MOOLRE event is tied to this completed deposit but the settlement committed no settlementExternalRef',
                    txHash);
            } else {
                report.skipped.nonMoolreDeposits += 1;
            }
            continue;
        }

        const event = eventFor(ref, txHash);
        if (!event) {
            // Completed, but no Moolre processor evidence: an ordinary aggregator
            // settlement on the same MoMo rail. Never claimed as Moolre money.
            report.skipped.nonMoolreDeposits += 1;
            continue;
        }

        const claimedRefs = [
            String(d.settlement_provider_ref || '').trim(),
            String(d.provider_ref || '').trim(),
            String(event.providerRef || '').trim(),
        ].filter(Boolean);
        if (new Set(claimedRefs).size > 1) {
            report.skipped.unclassifiableDeposits += 1;
            anomaly('CONTRADICTORY_SETTLEMENT_REFERENCE', keyFor(ref), [String(d.id)],
                `settlement/provider references disagree: ${JSON.stringify(claimedRefs)}`, ref);
            continue;
        }

        addOwner(report.depositOwners, keyFor(ref), String(d.id));
    }

    // ── existing treasury witnesses ──────────────────────────────────────
    const witnesses = await db.providerSettlementWitness.findMany({
        select: { openingDedupKey: true, requestParams: true, rawResponse: true, provider: true },
    });
    for (const w of witnesses) {
        if (String(w.provider || '').trim().toUpperCase() !== 'MOOLRE') {
            report.skipped.nonMoolreWitnesses += 1;
            continue;
        }
        const ref = referenceFromWitness(w);
        if (!ref) {
            report.skipped.unclassifiableWitnesses += 1;
            continue;
        }
        addOwner(report.witnessOwners, keyFor(ref), String(w.openingDedupKey));
    }

    // ── anomalies that must never be resolved by picking a winner ────────
    const quarantine = new Map(); // key -> {reason, owners}
    for (const [key, owners] of report.depositOwners) {
        if (owners.length > 1) {
            quarantine.set(key, { reason: 'DUPLICATE_DEPOSIT_OWNERS', owners });
        }
    }
    for (const [key, owners] of report.witnessOwners) {
        if (owners.length > 1) {
            quarantine.set(key, { reason: 'DUPLICATE_WITNESS_OWNERS', owners });
        }
    }
    for (const key of report.depositOwners.keys()) {
        if (report.witnessOwners.has(key)) {
            quarantine.set(key, {
                reason: 'CROSS_PATH_COLLISION',
                owners: [...report.depositOwners.get(key), ...report.witnessOwners.get(key)],
            });
        }
    }

    const claimDeposits = [...report.depositOwners].filter(([k]) => !quarantine.has(k));
    const claimWitnesses = [...report.witnessOwners].filter(([k]) => !quarantine.has(k));

    return {
        report,
        claimDeposits,
        claimWitnesses,
        quarantine: [...quarantine].map(([key, v]) => ({ observationKey: key, ...v })),
    };
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const asJson = process.argv.includes('--json');
    const injectAfter = Number(process.env.AZM_TEST_INJECT_FAILURE_AFTER_CLAIMS || 0);

    const prisma = new PrismaClient();
    const out = {
        installed: false,
        dryRun,
        wouldClaimDeposits: 0,
        wouldClaimWitnesses: 0,
        wouldQuarantine: 0,
        depositClaims: 0,
        witnessClaims: 0,
        quarantined: 0,
        candidates: { deposits: [], witnesses: [], quarantine: [] },
        anomalies: [],
        skipped: { deposits: 0, witnesses: 0, nonMoolreProvider: 0, unclassifiableDeposits: 0, unclassifiableWitnesses: 0 },
    };

    try {
        if (dryRun) {
            // No DDL, no writes: the same selection reads, zero mutations.
            const selection = await selectCandidates(prisma);
            out.wouldClaimDeposits = selection.claimDeposits.length;
            out.wouldClaimWitnesses = selection.claimWitnesses.length;
            out.wouldQuarantine = selection.quarantine.length;
            out.candidates.deposits = selection.claimDeposits.map(([key, owner]) => ({ observationKey: key, owner }));
            out.candidates.witnesses = selection.claimWitnesses.map(([key, owner]) => ({ observationKey: key, owner }));
            out.candidates.quarantine = selection.quarantine;
            out.anomalies = selection.report.anomalies;
            out.skipped.unclassifiableDeposits = selection.report.skipped.unclassifiableDeposits;
            out.skipped.unclassifiableWitnesses = selection.report.skipped.unclassifiableWitnesses;
            out.skipped.nonMoolreProvider = selection.report.skipped.nonMoolreDeposits + selection.report.skipped.nonMoolreWitnesses;
            out.skipped.deposits = selection.report.skipped.nonMoolreDeposits;
            out.skipped.witnesses = selection.report.skipped.nonMoolreWitnesses;
        } else {
            const sql = fs.readFileSync(SQL_FILE, 'utf8');
            const statements = sql
                .split(';')
                .map((q) => q.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
                .filter(Boolean);

            // ONE transaction: DDL, every claim, every quarantine row — or none.
            await prisma.$transaction(async (tx) => {
                for (const statement of statements) await tx.$executeRawUnsafe(statement);

                const selection = await selectCandidates(tx);
                out.wouldClaimDeposits = selection.claimDeposits.length;
                out.wouldClaimWitnesses = selection.claimWitnesses.length;
                out.wouldQuarantine = selection.quarantine.length;
                out.candidates.deposits = selection.claimDeposits.map(([key, owner]) => ({ observationKey: key, owner }));
                out.candidates.witnesses = selection.claimWitnesses.map(([key, owner]) => ({ observationKey: key, owner }));
                out.candidates.quarantine = selection.quarantine;
                out.anomalies = selection.report.anomalies;
                out.skipped.unclassifiableDeposits = selection.report.skipped.unclassifiableDeposits;
                out.skipped.unclassifiableWitnesses = selection.report.skipped.unclassifiableWitnesses;
                out.skipped.nonMoolreProvider = selection.report.skipped.nonMoolreDeposits + selection.report.skipped.nonMoolreWitnesses;
                out.skipped.deposits = selection.report.skipped.nonMoolreDeposits;
                out.skipped.witnesses = selection.report.skipped.nonMoolreWitnesses;

                let writes = 0;
                const maybeFault = () => {
                    if (injectAfter && writes >= injectAfter) {
                        throw new Error(`[test-fault] injected failure after ${injectAfter} claim write(s)`);
                    }
                };

                for (const q of selection.quarantine) {
                    const n = await tx.$executeRawUnsafe(
                        `INSERT INTO "ProviderObservationClaim" ("id","observationKey","purpose","claimedByRef","provider","accountKey","createdAt","updatedAt")
                         VALUES (gen_random_uuid()::text,$1,'QUARANTINE',NULL,'moolre',NULL, now(), now())
                         ON CONFLICT ("observationKey") DO NOTHING`, q.observationKey);
                    out.quarantined += n;
                    writes += n;
                    maybeFault();
                }
                for (const [key, owners] of selection.claimDeposits) {
                    // owners is the list used to DETECT duplicates; only a single
                    // owner survives to here (multi-owner keys are quarantined).
                    const depositId = owners[0];
                    const n = await tx.$executeRawUnsafe(
                        `INSERT INTO "ProviderObservationClaim" ("id","observationKey","purpose","claimedByRef","provider","accountKey","createdAt","updatedAt")
                         VALUES (gen_random_uuid()::text,$1,'CUSTOMER_DEPOSIT',$2,'moolre',NULL, now(), now())
                         ON CONFLICT ("observationKey") DO NOTHING`, key, depositId);
                    out.depositClaims += n;
                    writes += n;
                    maybeFault();
                }
                for (const [key, owners] of selection.claimWitnesses) {
                    const openingKey = owners[0];
                    const n = await tx.$executeRawUnsafe(
                        `INSERT INTO "ProviderObservationClaim" ("id","observationKey","purpose","claimedByRef","provider","accountKey","createdAt","updatedAt")
                         VALUES (gen_random_uuid()::text,$1,'TREASURY_WITNESS',$2,'moolre',NULL, now(), now())
                         ON CONFLICT ("observationKey") DO NOTHING`, key, openingKey);
                    out.witnessClaims += n;
                    writes += n;
                    maybeFault();
                }
                out.installed = true;
            }, { timeout: 300000, maxWait: 60000 });
        }

        const summary = `[provider-observation-claim] installed=${out.installed} dryRun=${out.dryRun} `
            + `wouldClaimDeposits=${out.wouldClaimDeposits} wouldClaimWitnesses=${out.wouldClaimWitnesses} wouldQuarantine=${out.wouldQuarantine} `
            + `depositClaims=${out.depositClaims} witnessClaims=${out.witnessClaims} quarantined=${out.quarantined} `
            + `skipped(deposits=${out.skipped.deposits},witnesses=${out.skipped.witnesses},nonMoolreProvider=${out.skipped.nonMoolreProvider},`
            + `unclassifiableDeposits=${out.skipped.unclassifiableDeposits},unclassifiableWitnesses=${out.skipped.unclassifiableWitnesses})`;
        console.log(summary);
        if (asJson) console.log(`[provider-observation-claim-json] ${JSON.stringify(out)}`);

        if (out.candidates.quarantine.length) {
            console.error(`[provider-observation-claim] ${out.candidates.quarantine.length} HISTORICAL OWNERSHIP ANOMALY(IES) — quarantined for operator review, no owner chosen:`);
            for (const q of out.candidates.quarantine) console.error('  ', JSON.stringify(q));
        }
        for (const a of out.anomalies) {
            console.error('[provider-observation-claim] ANOMALY', JSON.stringify(a));
        }
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    main().catch((e) => { console.error('[provider-observation-claim] FAILED:', e.message); process.exit(1); });
}

module.exports = { referenceFromWitness, selectCandidates, keyFor, MOOLRE_EVENT_PREFIX, MOOLRE_SUCCESS_STATUS };
