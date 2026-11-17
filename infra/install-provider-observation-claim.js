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
//      providerRef and the event's providerRef, where present, must agree, AND
//      every populated identity field ON THE EVENT must agree with the deposit's
//      persisted settlement identity.
//
// A generic aggregator settlement writes its evidence under provider
// 'GENERIC_FIAT_WEBHOOK', so an identical MoMo rail without a Moolre event is
// never claimed.
//
// A MATCHING TIE IS NOT ENOUGH — THE WHOLE EVENT IDENTITY MUST AGREE
// A FiatProviderEvent carries three identity fields: dedupKey, providerRef and
// relatedReference. Finding the event through one of them proves only that one
// field agrees. Accepting the event on that basis alone would let a contradicting
// event (its dedupKey names a different collection, or its relatedReference names
// a different deposit) be attached to this deposit and claim money it never
// settled. So:
//
//   * every POPULATED identity field on the event must agree with this deposit;
//   * a populated field that cannot be verified (a relatedReference when the
//     deposit records no txHash) is a contradiction, not a pass;
//   * more than one agreeing candidate is an AMBIGUITY: no candidate is chosen,
//     because the first match is not evidence and picking one would decide which
//     deposit owns a provider payment by row order;
//   * evidence that exists but contradicts, or is ambiguous, is reported as
//     unclassifiable and never claimed. Zero agreeing candidates with no
//     candidates at all stays "ordinary aggregator settlement".
//
// EXISTING CLAIMS ARE VERIFIED, NOT ASSUMED
// ON CONFLICT DO NOTHING proves only that a row exists, not that it is correct.
// Every candidate whose key is already claimed is compared field by field with
// the claim this run would insert (purpose, owner, provider, and accountKey where
// it is derivable). An exact match is an idempotent replay; any mismatch — a
// different owner, a different purpose, a malformed legacy owner — is reported
// and aborts the whole run BEFORE anything is written. A financial claim is never
// overwritten, and a conflict never becomes a "successful backfill".
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
 * Reference equality through the SAME canonical normalisation the live claim
 * uses, so 'ref' and 'REF ' are one identity — and so a comparison never invents
 * a match that the claim table would treat as a different key.
 */
function sameReference(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (!a.trim() || !b.trim()) return false;
    try {
        return keyFor(a) === keyFor(b);
    } catch (_) {
        return a.trim() === b.trim();
    }
}

const CLAIM_TABLE = 'ProviderObservationClaim';
const CLAIM_PURPOSE_CUSTOMER_DEPOSIT = 'CUSTOMER_DEPOSIT';
const CLAIM_PURPOSE_TREASURY_WITNESS = 'TREASURY_WITNESS';
const CLAIM_PURPOSE_QUARANTINE = 'QUARANTINE';

/** Existing claim rows, or an empty map when the table does not exist yet. */
async function readExistingClaims(db) {
    const reg = await db.$queryRawUnsafe(`SELECT to_regclass('"${CLAIM_TABLE}"')::text AS t`);
    if (!reg || !reg[0] || !reg[0].t) return new Map();
    const rows = await db.$queryRawUnsafe(
        `SELECT "observationKey","purpose","claimedByRef","provider","accountKey" FROM "${CLAIM_TABLE}"`,
    );
    const byKey = new Map();
    for (const r of rows) byKey.set(String(r.observationKey), r);
    return byKey;
}

/**
 * Compare a persisted claim with the claim this run would insert.
 * Empty `diffs` means the row is an exact idempotent replay.
 */
function claimMismatches(existing, expected) {
    const diffs = [];
    const notes = [];

    const purpose = String(existing.purpose == null ? '' : existing.purpose);
    if (purpose !== expected.purpose) {
        diffs.push(purpose === CLAIM_PURPOSE_QUARANTINE
            ? 'purpose=QUARANTINE (a quarantine row already blocks this observation for both economic paths)'
            : `purpose=${purpose || '(empty)'}`);
    }

    const rawOwner = existing.claimedByRef == null ? '' : String(existing.claimedByRef);
    const owner = rawOwner.trim();
    const malformedOwner = rawOwner !== owner || /^\{.*\}$/.test(owner);
    if (malformedOwner) {
        // e.g. the historic '{uuid}' array binding: never silently accepted.
        diffs.push(`claimedByRef is malformed (${JSON.stringify(rawOwner)})`);
    } else if (owner !== String(expected.claimedByRef == null ? '' : expected.claimedByRef)) {
        diffs.push(`claimedByRef=${owner || '(none)'}`);
    }

    const provider = String(existing.provider == null ? '' : existing.provider).trim().toLowerCase();
    if (provider !== expected.provider) diffs.push(`provider=${provider || '(none)'}`);

    if (expected.accountKey != null) {
        const actual = existing.accountKey == null ? '' : String(existing.accountKey).trim();
        if (actual !== expected.accountKey) diffs.push(`accountKey=${actual || '(none)'}`);
    } else if (existing.accountKey != null && String(existing.accountKey).trim()) {
        // The deposit path's trusted account is not durable in a column the
        // backfill can read, so a populated accountKey here is reported and not
        // verified rather than being called a match or a conflict.
        notes.push(`accountKey=${String(existing.accountKey).trim()} not verifiable by the backfill`);
    }

    return { diffs, notes, malformedOwner };
}

class PreexistingClaimConflict extends Error {
    constructor(conflicts) {
        super(`[provider-observation-claim] ${conflicts.length} pre-existing claim(s) disagree with the expected claim; nothing was written`);
        this.name = 'PreexistingClaimConflict';
        this.code = 'PREEXISTING_CLAIM_CONFLICT';
        this.conflicts = conflicts;
    }
}


/**
 * Read-only candidate selection. Identical for a dry run and a real run, which
 * is what makes "dry-run reports exactly what it would do" a provable claim.
 */
async function selectCandidates(db) {
    const report = {
        depositOwners: new Map(),
        witnessOwners: new Map(),
        witnessAccountKeys: new Map(),
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
        SELECT "id", "dedupKey", "providerRef", "relatedReference"
        FROM "FiatProviderEvent"
        WHERE "provider" = 'MOOLRE' AND "direction" = 'INBOUND' AND "status" = '${MOOLRE_SUCCESS_STATUS}'
    `);
    // Every index holds EVERY matching event. Collapsing to one value per key
    // would silently discard the second candidate that makes a case ambiguous.
    const push = (map, k, e) => {
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(e);
    };
    const eventsByDedupKey = new Map();
    const eventsByProviderRef = new Map();
    const eventsByRelatedReference = new Map();
    for (const e of events) {
        const dedup = String(e.dedupKey || '').trim();
        if (dedup) push(eventsByDedupKey, dedup, e);
        const pr = String(e.providerRef || '').trim();
        if (pr) push(eventsByProviderRef, pr, e);
        const rr = String(e.relatedReference || '').trim();
        if (rr) push(eventsByRelatedReference, rr, e);
    }

    /**
     * Every populated identity field on the event must agree with this deposit's
     * persisted settlement identity. Returns the list of contradictions (empty
     * means the event is a usable candidate).
     */
    const eventContradictions = (event, ref, txHash) => {
        const out = [];
        const dedup = String(event.dedupKey || '').trim();
        if (dedup) {
            if (!dedup.startsWith(MOOLRE_EVENT_PREFIX)) {
                out.push(`dedupKey=${dedup} is not a Moolre collection key`);
            } else {
                const suffix = dedup.slice(MOOLRE_EVENT_PREFIX.length);
                if (!sameReference(suffix, ref)) out.push(`dedupKey names ${suffix}`);
            }
        }
        const providerRef = String(event.providerRef || '').trim();
        if (providerRef && !sameReference(providerRef, ref)) out.push(`providerRef=${providerRef}`);
        const related = String(event.relatedReference || '').trim();
        if (related) {
            if (!txHash) out.push(`relatedReference=${related} cannot be verified (deposit records no txHash)`);
            else if (!sameReference(related, txHash)) out.push(`relatedReference=${related}`);
        }
        return out;
    };

    /**
     * Candidate events for one deposit, gathered through every durable tie, then
     * ALL required to agree on their full identity.
     *
     * @returns {{status: 'none'|'ok'|'contradictory'|'ambiguous', event: object|null,
     *            candidates: object[], contradictions: string[]}}
     */
    const eventEvidence = (ref, txHash) => {
        const seen = new Map();
        const consider = (list) => { for (const e of list || []) seen.set(String(e.id), e); };
        consider(eventsByDedupKey.get(`${MOOLRE_EVENT_PREFIX}${ref}`));
        consider(eventsByProviderRef.get(ref));
        if (txHash) consider(eventsByRelatedReference.get(txHash));

        const candidates = [...seen.values()];
        if (candidates.length === 0) return { status: 'none', event: null, candidates: [], contradictions: [] };

        // MORE THAN ONE candidate is an ambiguity, even if several of them
        // appear to agree: two distinct provider observations cannot both be the
        // settlement of one deposit, and choosing one would decide an ownership
        // question by row order. Only a single candidate is ever usable.
        if (candidates.length > 1) {
            return { status: 'ambiguous', event: null, candidates, contradictions: [] };
        }
        const only = candidates[0];
        const contradictions = eventContradictions(only, ref, txHash);
        if (contradictions.length) {
            return { status: 'contradictory', event: null, candidates, contradictions };
        }
        return { status: 'ok', event: only, candidates, contradictions: [] };
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
        const txHash = d.txHash ? String(d.txHash).trim() : null;
        const depositProviderRef = String(d.provider_ref || '').trim();

        if (!ref) {
            // We cannot name the canonical key the live path uses, so this is
            // unclassifiable — but ONLY after checking every durable Moolre link,
            // including the deposit's own persisted provider reference. The
            // reference is never invented from the link.
            const ties = [];
            if (txHash) {
                if (eventsByDedupKey.get(`${MOOLRE_EVENT_PREFIX}${txHash}`)) ties.push(`dedupKey(${MOOLRE_EVENT_PREFIX}${txHash})`);
                if (eventsByRelatedReference.get(txHash)) ties.push(`relatedReference(${txHash})`);
            }
            if (depositProviderRef && eventsByProviderRef.get(depositProviderRef)) {
                ties.push(`providerRef(${depositProviderRef})`);
            }
            if (ties.length) {
                report.skipped.unclassifiableDeposits += 1;
                anomaly('MOOLRE_EVIDENCE_WITHOUT_SETTLEMENT_REFERENCE', null, [String(d.id)],
                    `Moolre evidence is tied to this completed deposit (${ties.join(', ')}) but the settlement committed no settlementExternalRef, so the canonical claim key cannot be established`,
                    txHash || depositProviderRef || null);
            } else {
                report.skipped.nonMoolreDeposits += 1;
            }
            continue;
        }

        const evidence = eventEvidence(ref, txHash);
        if (evidence.status === 'none') {
            // Completed, but no Moolre processor evidence: an ordinary aggregator
            // settlement on the same MoMo rail. Never claimed as Moolre money.
            report.skipped.nonMoolreDeposits += 1;
            continue;
        }
        if (evidence.status === 'contradictory') {
            report.skipped.unclassifiableDeposits += 1;
            anomaly('CONTRADICTORY_MOOLRE_EVIDENCE', keyFor(ref), [String(d.id)],
                `Moolre event(s) matched a link on this deposit but their other identity fields contradict it: ${JSON.stringify(evidence.contradictions)}`,
                ref);
            continue;
        }
        if (evidence.status === 'ambiguous') {
            report.skipped.unclassifiableDeposits += 1;
            anomaly('AMBIGUOUS_MOOLRE_EVIDENCE', keyFor(ref), [String(d.id)],
                `${evidence.candidates.length} distinct Moolre events tie to this deposit (${JSON.stringify(evidence.candidates.map((e) => ({ id: e.id, dedupKey: e.dedupKey, providerRef: e.providerRef, relatedReference: e.relatedReference })))}) — a single settlement cannot have two provider observations, so no candidate is chosen`,
                ref);
            continue;
        }
        const event = evidence.event;

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
        select: { openingDedupKey: true, requestParams: true, rawResponse: true, provider: true, walletAccount: true },
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
        const witnessKey = keyFor(ref);
        // The trusted account the witness was fetched for, through the same
        // canonical identity the runtime claim uses. This is what lets a
        // pre-existing witness claim be compared rather than assumed.
        let accountKey = null;
        try {
            accountKey = canonicalObservationIdentity({
                provider: 'moolre',
                reference: ref,
                accountNumber: typeof w.walletAccount === 'string' ? w.walletAccount : null,
            }).accountKey;
        } catch (_) { accountKey = null; }
        report.witnessAccountKeys.set(witnessKey, accountKey);
        addOwner(report.witnessOwners, witnessKey, String(w.openingDedupKey));
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
        witnessAccountKeys: report.witnessAccountKeys,
        quarantine: [...quarantine].map(([key, v]) => ({ observationKey: key, ...v })),
    };
}

/**
 * Split the surviving candidates against the claims that already exist.
 *
 *  - alreadyCorrect: an exact idempotent replay (purpose, owner, provider and,
 *    where derivable, accountKey all match);
 *  - toInsert:       the key is unclaimed, so this run would create it;
 *  - conflicts:      the key is claimed by something that is NOT this claim. A
 *    conflict is never overwritten and never counted as a successful backfill.
 */
function partitionAgainstExisting(selection, existing) {
    const alreadyCorrect = { deposits: [], witnesses: [] };
    const toInsert = { deposits: [], witnesses: [] };
    const conflicts = [];

    const classify = (kind, key, expected) => {
        const row = existing.get(key);
        if (!row) return false;
        const { diffs, notes, malformedOwner } = claimMismatches(row, expected);
        if (diffs.length) {
            conflicts.push({
                kind,
                observationKey: key,
                malformedOwner,
                expected,
                existing: {
                    purpose: row.purpose,
                    claimedByRef: row.claimedByRef,
                    provider: row.provider,
                    accountKey: row.accountKey,
                },
                diffs,
                notes,
            });
        } else {
            alreadyCorrect[kind === 'deposit' ? 'deposits' : 'witnesses'].push({ observationKey: key, owner: expected.claimedByRef, notes });
        }
        return true;
    };

    for (const [key, owners] of selection.claimDeposits) {
        const expected = {
            purpose: CLAIM_PURPOSE_CUSTOMER_DEPOSIT,
            claimedByRef: owners[0],
            provider: 'moolre',
            accountKey: null,
        };
        if (!classify('deposit', key, expected)) toInsert.deposits.push([key, owners]);
    }
    for (const [key, owners] of selection.claimWitnesses) {
        const expected = {
            purpose: CLAIM_PURPOSE_TREASURY_WITNESS,
            claimedByRef: owners[0],
            provider: 'moolre',
            accountKey: selection.witnessAccountKeys ? (selection.witnessAccountKeys.get(key) ?? null) : null,
        };
        if (!classify('witness', key, expected)) toInsert.witnesses.push([key, owners]);
    }

    return { alreadyCorrect, toInsert, conflicts };
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
        wouldInsertDeposits: 0,
        wouldInsertWitnesses: 0,
        alreadyClaimedDeposits: 0,
        alreadyClaimedWitnesses: 0,
        conflicts: [],
        candidates: { deposits: [], witnesses: [], quarantine: [] },
        anomalies: [],
        skipped: { deposits: 0, witnesses: 0, nonMoolreProvider: 0, unclassifiableDeposits: 0, unclassifiableWitnesses: 0 },
    };

    try {
        if (dryRun) {
            // No DDL, no writes: the same selection reads, zero mutations.
            const selection = await selectCandidates(prisma);
            const existing = await readExistingClaims(prisma);
            const partition = partitionAgainstExisting(selection, existing);
            out.wouldInsertDeposits = partition.toInsert.deposits.length;
            out.wouldInsertWitnesses = partition.toInsert.witnesses.length;
            out.alreadyClaimedDeposits = partition.alreadyCorrect.deposits.length;
            out.alreadyClaimedWitnesses = partition.alreadyCorrect.witnesses.length;
            out.conflicts = partition.conflicts;
            out.alreadyCorrect = partition.alreadyCorrect;
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

                // Existing claims are verified INSIDE this transaction, so the
                // comparison and the writes see one consistent database state.
                // A conflict aborts before a single row is written.
                const partition = partitionAgainstExisting(selection, await readExistingClaims(tx));
                out.wouldInsertDeposits = partition.toInsert.deposits.length;
                out.wouldInsertWitnesses = partition.toInsert.witnesses.length;
                out.alreadyClaimedDeposits = partition.alreadyCorrect.deposits.length;
                out.alreadyClaimedWitnesses = partition.alreadyCorrect.witnesses.length;
                out.alreadyCorrect = partition.alreadyCorrect;
                if (partition.conflicts.length) throw new PreexistingClaimConflict(partition.conflicts);

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
                for (const [key, owners] of partition.toInsert.deposits) {
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
                for (const [key, owners] of partition.toInsert.witnesses) {
                    const openingKey = owners[0];
                    // The opening's trusted wallet account IS durable, so the
                    // witness claim records the same account identity the runtime
                    // claim does instead of leaving it null.
                    const accountKey = selection.witnessAccountKeys.get(key) ?? null;
                    const n = await tx.$executeRawUnsafe(
                        `INSERT INTO "ProviderObservationClaim" ("id","observationKey","purpose","claimedByRef","provider","accountKey","createdAt","updatedAt")
                         VALUES (gen_random_uuid()::text,$1,'TREASURY_WITNESS',$2,'moolre',$3, now(), now())
                         ON CONFLICT ("observationKey") DO NOTHING`, key, openingKey, accountKey);
                    out.witnessClaims += n;
                    writes += n;
                    maybeFault();
                }
                out.installed = true;
            }, { timeout: 300000, maxWait: 60000 });
        }

        const summary = `[provider-observation-claim] installed=${out.installed} dryRun=${out.dryRun} `
            + `wouldClaimDeposits=${out.wouldClaimDeposits} wouldClaimWitnesses=${out.wouldClaimWitnesses} wouldQuarantine=${out.wouldQuarantine} `
            + `candidates(deposits=${out.wouldClaimDeposits},witnesses=${out.wouldClaimWitnesses}) `
            + `wouldInsert(deposits=${out.wouldInsertDeposits},witnesses=${out.wouldInsertWitnesses}) `
            + `alreadyClaimed(deposits=${out.alreadyClaimedDeposits},witnesses=${out.alreadyClaimedWitnesses}) `
            + `conflicts=${out.conflicts.length} `
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
        for (const c of out.conflicts) {
            console.error('[provider-observation-claim] PRE-EXISTING CLAIM CONFLICT — operator review required, nothing overwritten:', JSON.stringify(c));
        }
        if (out.conflicts.length && dryRun) {
            console.error('[provider-observation-claim] a REAL run would refuse and write nothing while these conflicts exist');
        }
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    main().catch((e) => {
        if (e && e.code === 'PREEXISTING_CLAIM_CONFLICT') {
            console.error('[provider-observation-claim] REFUSED — PRE-EXISTING CLAIM CONFLICT:', e.message);
            for (const c of e.conflicts || []) console.error('[provider-observation-claim] PRE-EXISTING CLAIM CONFLICT', JSON.stringify(c));
            process.exit(2);
        }
        console.error('[provider-observation-claim] FAILED:', e.message);
        process.exit(1);
    });
}

module.exports = {
    referenceFromWitness,
    selectCandidates,
    keyFor,
    sameReference,
    claimMismatches,
    partitionAgainstExisting,
    readExistingClaims,
    MOOLRE_EVENT_PREFIX,
    MOOLRE_SUCCESS_STATUS,
};
