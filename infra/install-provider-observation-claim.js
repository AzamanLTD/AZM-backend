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
//        * providerRef = the PROVIDER's own reference for that collection. The
//          adapter sends Azaman's externalRef to Moolre and receives back a
//          DIFFERENT provider reference, which the initiation controller
//          persists on TransactionHistory.providerRef. It is compared with the
//          deposit's persisted provider reference, never with the external one,
//        * relatedReference = the deposit's txHash.
//   4. TWO IDENTITY FAMILIES, EACH CHECKED AGAINST ITS OWN MEMBER. The external
//      family (settlementExternalRef, event dedupKey, event relatedReference) and
//      the provider family (TransactionHistory.providerRef,
//      metadata.settlementProviderRef, event providerRef) are never compared
//      across families. Within the provider family the deposit's two persisted
//      values must agree with each other where both exist, and the event's
//      providerRef must match the deposit's; a provider reference that cannot be
//      verified against persisted evidence is unclassifiable, never assumed.
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
//
// OPERATIONAL: THE BACKFILL BLOCKS CLAIM-TABLE WRITERS WHILE IT RUNS
//
// The overlay (infra/sql/provider-observation-claim.sql) runs inside the same
// transaction as every claim write, and it contains CREATE TABLE IF NOT EXISTS,
// CREATE UNIQUE INDEX IF NOT EXISTS and two CREATE INDEX IF NOT EXISTS.
//
// PostgreSQL takes a ShareLock for a plain CREATE INDEX, and ShareLock CONFLICTS
// with the RowExclusiveLock that INSERT, UPDATE and DELETE take. The lock is held
// until the transaction ends. Measured in this repository on 2026-11-18: with the
// index already present, `CREATE UNIQUE INDEX IF NOT EXISTS` still blocked behind
// an open writer until lock_timeout fired. IF NOT EXISTS suppresses the
// duplicate-name error; it does NOT avoid the lock. Pre-installing the overlay
// beforehand therefore does not remove the window - the statements still run here.
//
// So, while this installer is running:
//   * live provider-claim traffic (the deposit and treasury-witness claim paths)
//     WAITS on this transaction, for as long as the backfill takes;
//   * a writer already open when the installer starts blocks the installer in its
//     DDL, and the installer waits for that writer to finish;
//   * a long enough wait can surface as a statement or transaction timeout on
//     either side. Nothing is deemed to have succeeded: an interrupted run rolls
//     back to exactly its starting state, per the atomicity contract above.
//
// Nobody has measured that wait on production volumes. Until someone does, treat
// this as a MAINTENANCE-WINDOW step, not as ordinary traffic-time work, and read
// the dry-run and the operator procedure before running it against production.
//
// WHAT REMOVING THE WINDOW WOULD COST (none of this is implemented, by decision)
//   * A no-DDL fast path (skip the overlay when every table, index and constraint
//     already matches) would avoid the ShareLock, but it must PROVE the complete
//     schema contract before skipping; an index that is merely present is not
//     evidence that it is the right index.
//   * Moving the DDL out of the claims transaction weakens the atomicity
//     contract: the DDL would then survive a later claims failure. The economic
//     claim set could still be atomic, but that is a DIFFERENT guarantee and
//     needs its own failure and recovery proofs.
//   * CREATE INDEX CONCURRENTLY is not a drop-in fix: it cannot run inside a
//     transaction block and needs its own operational procedure and failure
//     handling (an invalid index must be dropped and rebuilt).
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const {
    canonicalObservationIdentityV2,
    legacyObservationKey,
} = require('../src/services/providerObservationIdentity');
const { acquireObservationArbitration } = require('../src/services/observationArbitration');
// §WP-I: the Case B writer is a PRODUCTION function, not inline backfill code.
// The backfill calls it, and the two-session concurrency proof drives the same
// function against the settlement-witness writer — so the proof exercises the
// writer the product actually runs, not a test-only duplicate of it.
const {
    recordUnresolvedEvidenceCase,
    mergeCaseDetails,
} = require('../src/services/unresolvedEvidenceCaseService');

const SQL_FILE = path.join(__dirname, 'sql', 'provider-observation-claim.sql');

/** The only provider-event status that records a settled inbound collection. */
const MOOLRE_SUCCESS_STATUS = 'SUCCESSFUL';
const MOOLRE_EVENT_PREFIX = 'event:moolre-collection:';

// Bounded so a pathological history cannot hold the claim-writer locks forever.
const STATEMENT_TIMEOUT_MS = Number(process.env.WP_I_BACKFILL_STATEMENT_TIMEOUT_MS || 900000);

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

// ── §WP-I: THE BACKFILL USES THE SAME WALLET-SCOPED IDENTITY AS THE LIVE CLAIM
// A reference alone is not an identity: Moolre externalrefs are unique per
// wallet, so the wallet is part of what the payment IS. The wallet here comes
// only from durable evidence already persisted (the provider event row or the
// witness row) — never from whatever account happens to be configured today,
// because a historical payment may have landed in a different wallet and
// guessing would be indistinguishable from fraud.
//
// When no wallet can be established the answer is NULL: the caller must treat
// that payment as unclassifiable and route it to operator review, never to a
// claim. Writing the legacy key here would hand one payment two identities.
// Neither provider reference is authoritative when the two disagree, so the case
// names both and picks no winner.
// The wallet the EVIDENCE agrees on, or null. Two events naming different wallets
// are a disagreement about where the money landed, which no key may resolve.
function agreedWallet(candidates) {
    const wallets = new Set(
        (candidates || [])
            .map((e) => (e && e.walletAccount == null ? null : String(e.walletAccount).trim()))
            .filter((w) => w),
    );
    return wallets.size === 1 ? [...wallets][0] : null;
}

// ── CASE B DETAIL MERGE ─────────────────────────────────────────────────────
// Deterministic, order-independent, and lossless:
//   * identifier arrays (evidenceIds, ties, ownerIds) are UNIONED and deduped,
//     so a later run can only ADD evidence;
//   * scalars keep the FIRST observed value, because the earliest sighting is
//     what the case was opened on and a later run must not rewrite history;
//   * a scalar that was absent is filled in when a later run learns it;
//   * every key present in either side survives.
const MERGE_UNION_KEYS = ['evidenceIds', 'ties', 'ownerIds', 'candidateReferences', 'providerEventIds'];

function depositProviderRefOrNull(a, b) {
    const x = String(a || '').trim();
    const y = String(b || '').trim();
    return x && y ? `${x} vs ${y}` : (x || y || null);
}

const keyFor = (reference, walletAccount = null) => {
    try {
        return canonicalObservationIdentityV2({
            provider: 'moolre',
            reference,
            accountNumber: walletAccount,
        }).observationKey;
    } catch (_) {
        return null;
    }
};

/**
 * Reference equality through the SAME canonical normalisation the live claim
 * uses, so 'ref' and 'REF ' are one identity — and so a comparison never invents
 * a match that the claim table would treat as a different key.
 */
function sameReference(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (!a.trim() || !b.trim()) return false;
    try {
        // Reference EQUALITY is a comparison, not an identity: it must not
        // depend on which wallet either side knows, or two spellings of the same
        // provider reference would stop comparing equal.
        return legacyObservationKey({ provider: 'moolre', reference: a })
            === legacyObservationKey({ provider: 'moolre', reference: b });
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
/**
 * Compare a pre-existing claim row with the claim this run would write.
 *
 * @param opts.strictAccountKey the claim kind owns its account key outright, so a
 *        populated one is MALFORMED rather than merely unverifiable. This is the
 *        QUARANTINE contract: every row this installer writes for it is
 *        purpose=QUARANTINE, claimedByRef=NULL, provider=moolre, accountKey=NULL.
 *        It is deliberately NOT applied to customer deposits, whose trusted
 *        account is not durable in a column the backfill can read — there a
 *        populated accountKey stays a reported note, as documented.
 */
function claimMismatches(existing, expected, opts = {}) {
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
        const actual = String(existing.accountKey).trim();
        if (opts.strictAccountKey) {
            // This claim kind never carries an account key, so a populated one is
            // a malformed row: a conflict, never an idempotent replay.
            diffs.push(`accountKey=${actual} (this claim kind is written with no account key)`);
        } else {
            // The deposit path's trusted account is not durable in a column the
            // backfill can read, so a populated accountKey here is reported and not
            // verified rather than being called a match or a conflict.
            notes.push(`accountKey=${actual} not verifiable by the backfill`);
        }
    }

    return { diffs, notes, malformedOwner };
}

/**
 * An insert lost the uniqueness race. Re-read the committed winner and compare
 * it with the claim this run would have written. Being inside one transaction is
 * NOT a serializability guarantee: with READ COMMITTED each statement takes a
 * fresh snapshot, so a competing row committed between our read and our insert is
 * invisible to the read and makes ON CONFLICT DO NOTHING return zero.
 *
 * @returns {{outcome: 'inserted'|'replay', notes: string[]}}
 * @throws {PreexistingClaimConflict} when the winner is not this claim.
 */
async function insertClaimOrVerify(tx, { key, purpose, claimedByRef, accountKey, kind }) {
    const n = await tx.$executeRawUnsafe(
        `INSERT INTO "ProviderObservationClaim" ("id","observationKey","purpose","claimedByRef","provider","accountKey","createdAt","updatedAt")
         VALUES (gen_random_uuid()::text,$1,$2,$3,'moolre',$4, now(), now())
         ON CONFLICT ("observationKey") DO NOTHING`, key, purpose, claimedByRef, accountKey ?? null);
    if (n === 1) return { outcome: 'inserted', notes: [] };

    const rows = await tx.$queryRawUnsafe(
        `SELECT "observationKey","purpose","claimedByRef","provider","accountKey"
         FROM "ProviderObservationClaim" WHERE "observationKey" = $1`, key);
    if (!rows.length) {
        // ON CONFLICT reported a conflict but no row is visible: the state cannot
        // be explained, so fail closed rather than count a phantom as success.
        throw new PreexistingClaimConflict([{
            kind,
            observationKey: key,
            expected: { purpose, claimedByRef, provider: 'moolre', accountKey: accountKey ?? null },
            existing: null,
            diffs: ['the insert conflicted but no committed claim row is visible'],
            notes: [],
            duringInsertRace: true,
        }]);
    }
    const row = rows[0];
    const { diffs, notes, malformedOwner } = claimMismatches(row, {
        purpose, claimedByRef, provider: 'moolre', accountKey: accountKey ?? null,
    }, { strictAccountKey: kind === 'quarantine' });
    if (diffs.length) {
        throw new PreexistingClaimConflict([{
            kind,
            observationKey: key,
            malformedOwner,
            expected: { purpose, claimedByRef, provider: 'moolre', accountKey: accountKey ?? null },
            existing: {
                purpose: row.purpose,
                claimedByRef: row.claimedByRef,
                provider: row.provider,
                accountKey: row.accountKey,
            },
            diffs,
            notes,
            duringInsertRace: true,
        }]);
    }
    return { outcome: 'replay', notes };
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
        quarantineAnomalies: [],
        unresolvedEvidenceCases: [],
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
        SELECT "id", "dedupKey", "providerRef", "relatedReference", "walletAccount"
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
     * Every populated identity field on the event must agree with the SAME KIND
     * of identifier persisted on the deposit. The two reference families are
     * distinct and are never compared across kinds:
     *
     *   MERCHANT identity  — the external reference Azaman issues and sends to
     *                        Moolre. Persisted as metadata.settlementExternalRef;
     *                        it is the canonical claim identity, and it is what
     *                        the event's dedupKey names.
     *   PROVIDER identity  — the reference Moolre returns for the collection.
     *                        Persisted on TransactionHistory.providerRef (stamped
     *                        at initiation from the adapter's providerRef and
     *                        reconciled from the event) and, when a settlement
     *                        recorded it, metadata.settlementProviderRef.
     *
     * The adapter sends the external reference but returns a DIFFERENT provider
     * reference (the mock returns `mock-prov-...`), so requiring
     * `event.providerRef === settlementExternalRef` would reject every genuine
     * settlement.
     *
     * @returns {string[]} contradictions — empty means a usable candidate.
     */
    const eventContradictions = (event, ref, txHash, depositProviderRef) => {
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
        if (providerRef) {
            if (!depositProviderRef) {
                // Never guessed: without a persisted provider reference there is
                // nothing this value can be checked against.
                out.push(`providerRef=${providerRef} cannot be verified (deposit records no provider reference)`);
            } else if (!sameReference(providerRef, depositProviderRef)) {
                out.push(`providerRef=${providerRef} does not match the deposit's provider reference`);
            }
        }
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
    const eventEvidence = (ref, txHash, depositProviderRef) => {
        const seen = new Map();
        const consider = (list) => { for (const e of list || []) seen.set(String(e.id), e); };
        consider(eventsByDedupKey.get(`${MOOLRE_EVENT_PREFIX}${ref}`));
        // Discovery by provider reference must use the deposit's persisted
        // PROVIDER reference (TransactionHistory.providerRef /
        // metadata.settlementProviderRef) — never the merchant external reference.
        if (depositProviderRef) consider(eventsByProviderRef.get(depositProviderRef));
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
        const contradictions = eventContradictions(only, ref, txHash, depositProviderRef);
        if (contradictions.length) {
            return { status: 'contradictory', event: null, candidates, contradictions };
        }
        return { status: 'ok', event: only, candidates, contradictions: [] };
    };

    // ── completed customer deposits ──────────────────────────────────────
    // FAIT ONLY. A crypto deposit is never a Moolre collection, so including
    // DEPOSIT_CRYPTO here could only ever misclassify a cross-rail row that
    // happens to carry a settlementExternalRef and a matching event. The claim
    // identity is about a provider collection of GHS, not about the row's shape.
    const deposits = await db.$queryRawUnsafe(`
        SELECT "id", "txHash",
               COALESCE("metadata"->>'settlementExternalRef', '')  AS ref,
               COALESCE("metadata"->>'settlementProviderRef', '')  AS settlement_provider_ref,
               COALESCE("providerRef", '')                         AS provider_ref,
               COALESCE("metadata"->>'provider', '')               AS rail
        FROM "TransactionHistory"
        WHERE "type" = 'DEPOSIT_FIAT' AND "status" = 'COMPLETED'
    `);

    for (const d of deposits) {
        const ref = String(d.ref || '').trim();
        const txHash = d.txHash ? String(d.txHash).trim() : null;
        const persistedProviderRef = String(d.provider_ref || '').trim();
        const metadataProviderRef = String(d.settlement_provider_ref || '').trim();

        // The PROVIDER identity must agree with itself before it can verify
        // anything: a column that names one provider reference while the
        // settlement metadata names another is a historical disagreement about
        // WHICH provider collection this was. Fail closed, claim nothing.
        if (persistedProviderRef && metadataProviderRef && !sameReference(persistedProviderRef, metadataProviderRef)) {
            report.skipped.unclassifiableDeposits += 1;
            // The two references disagree, but the settlement reference still
            // points at real events. If those events AGREE on the wallet, a
            // trustworthy canonical key exists and this is Case A: quarantine the
            // observation under it so neither economic path can consume it.
            // Both references are still candidates here — the disagreement is
            // exactly what is unresolved, so neither is preferred. (The single
            // depositProviderRef is only computed after this branch.)
            const cands = [
                ...((txHash && eventsByRelatedReference.get(txHash)) || []),
                ...((persistedProviderRef && eventsByProviderRef.get(persistedProviderRef)) || []),
                ...((metadataProviderRef && eventsByProviderRef.get(metadataProviderRef)) || []),
            ];
            const wallet = agreedWallet(cands);
            const key = keyFor(ref, wallet);
            // The anomaly reports the key when one exists, so an operator can find
            // the quarantined row. It is null only when no key could be trusted.
            anomaly('CONTRADICTORY_PROVIDER_REFERENCE', key, [String(d.id)],
                `the deposit's provider references disagree: TransactionHistory.providerRef=${persistedProviderRef} vs metadata.settlementProviderRef=${metadataProviderRef}`,
                ref || null);
            if (key) {
                report.quarantineAnomalies.push({
                    observationKey: key,
                    reason: 'CONTRADICTORY_PROVIDER_REFERENCE',
                    owners: [String(d.id)],
                });
            } else {
                // No agreed wallet means no key can be trusted, and inventing one
                // is exactly what this work forbids. Case B instead.
                report.unresolvedEvidenceCases.push({
                    depositId: String(d.id),
                    reason: 'CONTRADICTORY_PROVIDER_REFERENCE',
                    ties: [`providerRef(${persistedProviderRef})`, `settlementProviderRef(${metadataProviderRef})`],
                    providerRef: depositProviderRefOrNull(persistedProviderRef, metadataProviderRef),
                    txHash: txHash || null,
                    evidenceIds: cands.map((e) => String(e.id)),
                    amountMinor: null,
                });
            }
            continue;
        }
        const depositProviderRef = persistedProviderRef || metadataProviderRef || null;

        if (!ref) {
            // We cannot name the canonical key the live path uses, so this is
            // unclassifiable — but ONLY after checking every durable Moolre link,
            // including the deposit's own persisted provider reference. The
            // reference is never invented from the link.
            const ties = [];
            // A dedupKey names the MERCHANT external reference, so the txHash is
            // never used to guess one; only same-kind ties may report evidence.
            if (txHash && eventsByRelatedReference.get(txHash)) ties.push(`relatedReference(${txHash})`);
            if (depositProviderRef && eventsByProviderRef.get(depositProviderRef)) {
                ties.push(`providerRef(${depositProviderRef})`);
            }
            if (ties.length) {
                report.skipped.unclassifiableDeposits += 1;
                // CASE B: no canonical key can be established, and inventing one
                // from the txHash or a provider ref would name an observation the
                // economic paths never use — so nothing is claimed. Instead the
                // evidence becomes a durable case an operator can act on.
                report.unresolvedEvidenceCases.push({
                    depositId: String(d.id),
                    reason: 'PROVIDER_EVIDENCE_WITHOUT_CANONICAL_REFERENCE',
                    ties,
                    providerRef: depositProviderRef || null,
                    txHash: txHash || null,
                    evidenceIds: [
                        ...((txHash && eventsByRelatedReference.get(txHash)) || []).map((e) => String(e.id)),
                        ...((depositProviderRef && eventsByProviderRef.get(depositProviderRef)) || []).map((e) => String(e.id)),
                    ],
                    amountMinor: null,
                });
                anomaly('MOOLRE_EVIDENCE_WITHOUT_SETTLEMENT_REFERENCE', null, [String(d.id)],
                    `Moolre evidence is tied to this completed deposit (${ties.join(', ')}) but the settlement committed no settlementExternalRef, so the canonical claim key cannot be established`,
                    txHash || depositProviderRef || null);
            } else {
                report.skipped.nonMoolreDeposits += 1;
            }
            continue;
        }

        const evidence = eventEvidence(ref, txHash, depositProviderRef);
        if (evidence.status === 'none') {
            // Completed, but no Moolre processor evidence: an ordinary aggregator
            // settlement on the same MoMo rail. Never claimed as Moolre money.
            report.skipped.nonMoolreDeposits += 1;
            continue;
        }
        if (evidence.status === 'contradictory') {
            report.skipped.unclassifiableDeposits += 1;
            const wallet = agreedWallet(evidence.candidates);
            const key = keyFor(ref, wallet);
            anomaly('CONTRADICTORY_MOOLRE_EVIDENCE', key, [String(d.id)],
                `Moolre event(s) matched a link on this deposit but their other identity fields contradict it: ${JSON.stringify(evidence.contradictions)}`,
                ref);
            if (key) {
                // CASE A — the wallet is agreed by the evidence, so a trustworthy
                // canonical key exists and the observation is quarantined under it.
                report.quarantineAnomalies.push({
                    observationKey: key,
                    reason: 'CONTRADICTORY_MOOLRE_EVIDENCE',
                    owners: [String(d.id)],
                });
            } else {
                // CASE B — the candidates do not agree on the wallet, so no key is
                // trustworthy and none is invented.
                report.unresolvedEvidenceCases.push({
                    depositId: String(d.id),
                    reason: 'CONTRADICTORY_MOOLRE_EVIDENCE',
                    ties: ['contradictory events', ...evidence.contradictions.map(String)],
                    providerRef: depositProviderRef || null,
                    txHash: txHash || null,
                    evidenceIds: (evidence.candidates || []).map((e) => String(e.id)),
                    amountMinor: null,
                });
            }
            continue;
        }
        if (evidence.status === 'ambiguous') {
            report.skipped.unclassifiableDeposits += 1;
            const wallet = agreedWallet(evidence.candidates);
            const key = keyFor(ref, wallet);
            anomaly('AMBIGUOUS_MOOLRE_EVIDENCE', key, [String(d.id)],
                `${evidence.candidates.length} distinct Moolre events tie to this deposit (${JSON.stringify(evidence.candidates.map((e) => ({ id: e.id, dedupKey: e.dedupKey, providerRef: e.providerRef, relatedReference: e.relatedReference })))}) — a single settlement cannot have two provider observations, so no candidate is chosen`,
                ref);
            if (key) {
                report.quarantineAnomalies.push({
                    observationKey: key,
                    reason: 'AMBIGUOUS_MOOLRE_EVIDENCE',
                    owners: [String(d.id)],
                });
            } else {
                report.unresolvedEvidenceCases.push({
                    depositId: String(d.id),
                    reason: 'AMBIGUOUS_MOOLRE_EVIDENCE',
                    ties: ['ambiguous events'],
                    providerRef: depositProviderRef || null,
                    txHash: txHash || null,
                    evidenceIds: (evidence.candidates || []).map((e) => String(e.id)),
                    amountMinor: null,
                });
            }
            continue;
        }
        const event = evidence.event;

        // The event's provider reference has already been checked against the
        // deposit's provider identity by eventContradictions(); nothing here may
        // compare it to the merchant external reference.
        // §WP-I: the wallet comes from the persisted EVENT, which is the durable
        // record of where this payment landed. Without one the deposit is not
        // claimable and becomes an operator case instead of a guessed key.
        const depositKey = keyFor(ref, event ? event.walletAccount : null);
        if (!depositKey) {
            report.skipped.unclassifiableDeposits += 1;
            anomaly('MOOLRE_EVIDENCE_WITHOUT_TRUSTED_WALLET', null, [String(d.id)],
                'the matched Moolre event carries no trusted wallet, so no wallet-scoped claim identity can be established; the payment is left unclaimed for operator review',
                ref);
            report.unresolvedEvidenceCases.push({
                depositId: String(d.id),
                reason: 'MOOLRE_EVIDENCE_WITHOUT_TRUSTED_WALLET',
                ties: ['wallet missing on the provider event'],
                providerRef: depositProviderRef || null,
                txHash: txHash || null,
                evidenceIds: event ? [String(event.id)] : [],
                amountMinor: null,
            });
            continue;
        }
        addOwner(report.depositOwners, depositKey, String(d.id));
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
        // §WP-I: the witness row carries the trusted wallet the opening was
        // configured for, so the same wallet-scoped identity the live claim uses
        // can be rebuilt here. A witness without one is not claimable.
        const witnessKey = keyFor(ref, typeof w.walletAccount === 'string' ? w.walletAccount : null);
        if (!witnessKey) {
            report.skipped.unclassifiableWitnesses += 1;
            continue;
        }
        report.witnessAccountKeys.set(witnessKey, w.walletAccount ? String(w.walletAccount).trim() : null);
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

    // CASE A — quarantine keys whose evidence is trustworthy in identity but
    // contradictory or ambiguous in content. Never a winner: no owner is chosen
    // and the row is written with claimedByRef NULL.
    for (const a of report.quarantineAnomalies) {
        if (!quarantine.has(a.observationKey)) {
            quarantine.set(a.observationKey, { reason: a.reason, owners: a.owners });
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
        // CASE B — no trustworthy canonical reference exists. No key is invented;
        // the durable reconciliation case below is the only artifact, and it is
        // tied to the real deposit and the real persisted provider events.
        unresolvedEvidenceCases: report.unresolvedEvidenceCases,
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
    const alreadyCorrect = { deposits: [], witnesses: [], quarantine: [] };
    const toInsert = { deposits: [], witnesses: [], quarantine: [] };
    const conflicts = [];

    const classify = (kind, key, expected) => {
        const row = existing.get(key);
        if (!row) return false;
        const { diffs, notes, malformedOwner } = claimMismatches(row, expected, { strictAccountKey: kind === 'quarantine' });
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
            const bucket = kind === 'deposit' ? 'deposits' : (kind === 'witness' ? 'witnesses' : 'quarantine');
            alreadyCorrect[bucket].push({ observationKey: key, owner: expected.claimedByRef, notes });
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

    // A quarantine key is a claim row like any other: an existing QUARANTINE row
    // with NO owner is the idempotent replay, and anything else — a
    // CUSTOMER_DEPOSIT, a TREASURY_WITNESS, a malformed quarantine or any other
    // mismatch — is a pre-existing claim conflict, never a successful
    // quarantine. ON CONFLICT DO NOTHING must not launder that away.
    for (const q of selection.quarantine || []) {
        const expected = {
            purpose: CLAIM_PURPOSE_QUARANTINE,
            claimedByRef: null,
            provider: 'moolre',
            accountKey: null,
        };
        if (!classify('quarantine', q.observationKey, expected)) toInsert.quarantine.push(q);
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
        wouldInsertQuarantine: 0,
        alreadyClaimedDeposits: 0,
        alreadyClaimedWitnesses: 0,
        alreadyQuarantined: 0,
        unresolvedCasesEnsured: 0,
        wouldCreateUnresolvedCases: 0,
        racedReplays: 0,
        raceReplays: [],
        conflicts: [],
        candidates: { deposits: [], witnesses: [], quarantine: [] },
        anomalies: [],
        unresolvedEvidenceCases: [],
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
            out.wouldInsertQuarantine = partition.toInsert.quarantine.length;
            out.alreadyClaimedDeposits = partition.alreadyCorrect.deposits.length;
            out.alreadyClaimedWitnesses = partition.alreadyCorrect.witnesses.length;
            out.alreadyQuarantined = partition.alreadyCorrect.quarantine.length;
            out.conflicts = partition.conflicts;
            out.alreadyCorrect = partition.alreadyCorrect;
            out.wouldClaimDeposits = selection.claimDeposits.length;
            out.wouldClaimWitnesses = selection.claimWitnesses.length;
            out.wouldQuarantine = selection.quarantine.length;
            out.wouldCreateUnresolvedCases = selection.unresolvedEvidenceCases.length;
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
                await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '" + STATEMENT_TIMEOUT_MS + "ms'");
                for (const statement of statements) await tx.$executeRawUnsafe(statement);

                const selection = await selectCandidates(tx);

                // Existing claims are verified INSIDE this transaction, so the
                // comparison and the writes see one consistent database state.
                // A conflict aborts before a single row is written.
                const partition = partitionAgainstExisting(selection, await readExistingClaims(tx));
                out.wouldInsertDeposits = partition.toInsert.deposits.length;
                out.wouldInsertWitnesses = partition.toInsert.witnesses.length;
                out.wouldInsertQuarantine = partition.toInsert.quarantine.length;
                out.alreadyClaimedDeposits = partition.alreadyCorrect.deposits.length;
                out.alreadyClaimedWitnesses = partition.alreadyCorrect.witnesses.length;
                out.alreadyQuarantined = partition.alreadyCorrect.quarantine.length;
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

                for (const q of partition.toInsert.quarantine) {
                    const r = await insertClaimOrVerify(tx, {
                        key: q.observationKey,
                        purpose: CLAIM_PURPOSE_QUARANTINE,
                        claimedByRef: null,
                        accountKey: null,
                        kind: 'quarantine',
                    });
                    if (r.outcome === 'inserted') { out.quarantined += 1; writes += 1; }
                    else { out.racedReplays += 1; out.raceReplays.push({ kind: 'quarantine', observationKey: q.observationKey, notes: r.notes }); }
                    maybeFault();
                }
                // ── CASE B: durable unresolved-evidence cases ────────────────
                // No claim key is invented here. Each case names the REAL
                // completed deposit and the REAL persisted provider-event ids, so
                // an operator can investigate, and so the witness path can refuse
                // this payment rather than treat the evidence as free money.
                // The case table is created earlier in the release chain
                // (install-payout-reconciliation-infra.js) and is deliberately NOT
                // duplicated here. A database without it cannot hold the case, so
                // the count is reported instead of silently pretending the
                // evidence was recorded.
                if (selection.unresolvedEvidenceCases.length > 0) {
                    const probe = await tx.$queryRawUnsafe(`SELECT to_regclass('"ReconciliationException"')::text AS t`);
                    const caseTablePresent = !!(Array.isArray(probe) && probe[0] && probe[0].t);
                    if (!caseTablePresent) {
                        // A REAL run that cannot persist a required case must abort
                        // and roll back. An observation left "reported" but
                        // unrecorded is the invisible state this work exists to
                        // close, so a skipped counter is not an acceptable outcome.
                        throw new Error(
                            'CASE_TABLE_MISSING: the backfill must record '
                            + `${selection.unresolvedEvidenceCases.length} unresolved-evidence case(s) but `
                            + '"ReconciliationException" does not exist. Run infra/install-payout-reconciliation-infra.js first; refusing to leave evidence invisible.'
                        );
                    }
                }
                for (const c of selection.unresolvedEvidenceCases) {
                    // The production Case B writer takes the wallet-independent
                    // arbitration lock BEFORE reading or writing the case, so this
                    // serializes against the settlement-witness writer instead of
                    // letting both observe "nothing yet" and both commit. It also
                    // accumulates evidence rather than replacing it.
                    await recordUnresolvedEvidenceCase(tx, {
                        depositId: c.depositId,
                        reason: c.reason,
                        ties: c.ties,
                        providerRef: c.providerRef,
                        txHash: c.txHash,
                        evidenceIds: c.evidenceIds,
                    });
                    out.unresolvedCasesEnsured += 1;
                }

                for (const [key, owners] of partition.toInsert.deposits) {
                    // owners is the list used to DETECT duplicates; only a single
                    // owner survives to here (multi-owner keys are quarantined).
                    const depositId = owners[0];
                    const r = await insertClaimOrVerify(tx, {
                        key, purpose: CLAIM_PURPOSE_CUSTOMER_DEPOSIT, claimedByRef: depositId, accountKey: null, kind: 'deposit',
                    });
                    if (r.outcome === 'inserted') { out.depositClaims += 1; writes += 1; }
                    else { out.racedReplays += 1; out.raceReplays.push({ kind: 'deposit', observationKey: key, notes: r.notes }); }
                    maybeFault();
                }
                for (const [key, owners] of partition.toInsert.witnesses) {
                    const openingKey = owners[0];
                    // The opening's trusted wallet account IS durable, so the
                    // witness claim records the same account identity the runtime
                    // claim does instead of leaving it null.
                    const accountKey = selection.witnessAccountKeys.get(key) ?? null;
                    const r = await insertClaimOrVerify(tx, {
                        key, purpose: CLAIM_PURPOSE_TREASURY_WITNESS, claimedByRef: openingKey, accountKey, kind: 'witness',
                    });
                    if (r.outcome === 'inserted') { out.witnessClaims += 1; writes += 1; }
                    else { out.racedReplays += 1; out.raceReplays.push({ kind: 'witness', observationKey: key, notes: r.notes }); }
                    maybeFault();
                }
                out.installed = true;
            }, { timeout: 300000, maxWait: 60000 });
        }

        const summary = `[provider-observation-claim] installed=${out.installed} dryRun=${out.dryRun} `
            + `wouldClaimDeposits=${out.wouldClaimDeposits} wouldClaimWitnesses=${out.wouldClaimWitnesses} wouldQuarantine=${out.wouldQuarantine} `
            + `candidates(deposits=${out.wouldClaimDeposits},witnesses=${out.wouldClaimWitnesses}) `
            + `wouldInsert(deposits=${out.wouldInsertDeposits},witnesses=${out.wouldInsertWitnesses},quarantine=${out.wouldInsertQuarantine}) `
            + `alreadyClaimed(deposits=${out.alreadyClaimedDeposits},witnesses=${out.alreadyClaimedWitnesses},quarantine=${out.alreadyQuarantined}) `
            + `racedReplays=${out.racedReplays} `
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
    insertClaimOrVerify,
    PreexistingClaimConflict,
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
