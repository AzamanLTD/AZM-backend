// services/custodyRecoveryService.js
// =============================================================================
// r22 — CUSTODY EXECUTION RECOVERY + TERMINAL CONVERGENCE (P0)
//
// INVARIANT:
//   A customer crypto withdrawal may be in-flight, terminally successful,
//   terminally failed, or explicitly quarantined for unresolved external
//   evidence — but it may NEVER silently strand customer funds because the
//   application crashed between two durable state transitions.
//
// Every economically meaningful CustodyExecution state now has an explicit,
// durable recovery owner:
//
//   RESERVING  + PENDING approval (stale)  → the request died before the
//       four-eye approval; no submission CAS was claimed, so NO provider I/O
//       can have happened. Convergence: FAILED + exactly-once customer refund
//       (withdrawals) / FAILED (sweeps, no customer money at claim time).
//
//   RESERVING  + APPROVED (stale)          → durable authorization exists;
//       recovery RE-ENTERS the canonical submitExecution() boundary using the
//       DURABLE execution identity (no second execution, no rebuilt payload,
//       no re-pricing). The single-winner CAS inside submitExecution makes
//       concurrent recovery/submit converge on exactly one submission.
//
//   SUBMITTED  (no tatumPendingId)         → the crash-after-claim window:
//       the submission CAS was won but the provider response was never
//       recorded. Blind retry is FORBIDDEN. Recovery resolves the ambiguity
//       using Tatum's CURRENT pending-KMS contract
//       (GET /v3/kms/pending/{chain} → PendingTransaction[]):
//         id, chain, hashes[] (the KMS signature ids that must sign),
//         serializedTransaction, index?, txId?, withdrawalId?
//       A pending transaction is bound to an execution ONLY on the strongest
//       available evidence — exact chain, exact KMS signature identity
//       (+ derivation index), and the decoded ERC-20 transfer semantics
//       (exact recipient + exact base-unit amount) from the provider's own
//         serialized transaction payload. Unparseable evidence is NOT a
//         mismatch — it is unusable, and unusable means: do NOT bind.
//       Exactly one candidate → durable CAS binding; the row then continues
//       the normal SIGNING/BROADCAST lifecycle. No candidate (or an ambiguous
//       multiplicity) → honest quarantine: absence from the pending list does
//       NOT prove no broadcast (completed pendings leave the list), so no
//       refund, no retry — RECONCILIATION_REQUIRED with recorded evidence.
//
//   RECONCILIATION_REQUIRED                → classified, never a dead end:
//       • UNKNOWN_OUTCOME (ambiguous submission) → recurring pending-scan
//         recovery (same matching rules as SUBMITTED); binds when evidence
//         appears, stays quarantined while it does not.
//       • CHAIN_REVERTED (definitive on-chain revert, receipt evidence) →
//         the intended token transfer did NOT execute. Economic convergence:
//         FAILED + exactly-once refund of the customer's full debit, atomic
//         with the terminal transition. The network's gas (MATIC, paid by the
//         hot wallet operator) is an operating cost; realized network cost is
//         NEVER fabricated from the estimate (r22-Q records the P1 follow-up).
//       • CHAIN_MISMATCH / contradictory evidence → stays quarantined for
//         HUMAN reconciliation: durable exception evidence is on the row
//         (errorClass + redacted errorMessage), no accidental retry, no
//         accidental refund, and the four-eye validator refuses to sign it.
//
//   SIGNING / BROADCAST                    → already owned by
//       reconcilePendingExecutions()/advanceExecution() (unchanged authority).
//
// All recovery transitions are conditional (single-winner CAS) updates on real
// PostgreSQL: concurrent recovery workers, duplicate distributed ticks, and
// crash/retry can never double-refund, double-bind, double-fail, or re-submit.
// The customer refund is exactly-once by construction: the terminal FAILED
// transition happens conditionally from exactly one state set, and the ledger
// reversal carries the same idempotency key as the controller's pre-broadcast
// refund path (ledger:withdrawal:crypto:refund:<executionId>), so even a
// pathological double execution of the refund body converges on one posting.
// =============================================================================

const { Prisma } = require('@prisma/client');
const logger = require('../src/config/logger');
const {
    ERROR_CLASSES,
    CustodyExecutionError,
    redact,
} = require('./custodyExecutionErrors');

const custody = require('./tatumCustodyExecutionService');
const { STATUSES } = custody;

// Staleness windows. A row younger than the window may belong to a live
// request that is simply between two durable steps — recovery must not race
// it. Both are ops-tunable via env.
function reservingStaleMs() {
    const minutes = Number(process.env.TATUM_CUSTODY_RESERVING_STALE_MINUTES || 10);
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : 10) * 60 * 1000;
}
function submittedGraceMs() {
    const minutes = Number(process.env.TATUM_CUSTODY_SUBMITTED_GRACE_MINUTES || 2);
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : 2) * 60 * 1000;
}

// ── Provider-evidence decoding (no invented fields) ─────────────────────────
//
// ERC-20 transfer(address,uint256) calldata: 4-byte selector + 32-byte padded
// recipient + 32-byte big-endian amount. The Tatum PendingTransaction schema
// says serializedTransaction "can be JSON, HEX or any other representation
// based on the blockchain" — for the KMS-managed EVM flow it is a JSON tx
// object (with `data`/`to`), so JSON is decoded first; a bare hex payload is
// decoded by locating the transfer selector. Anything else is UNUSABLE
// evidence (never a mismatch, never a match).
const ERC20_TRANSFER_SELECTOR = 'a9059cbb';

function decodeErc20TransferCalldata(dataHex) {
    if (typeof dataHex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(dataHex)) return null;
    const body = dataHex.slice(2).toLowerCase();
    if (!body.startsWith(ERC20_TRANSFER_SELECTOR) || body.length < 8 + 128) return null;
    const recipient = '0x' + body.slice(8 + 24, 8 + 64); // last 20 bytes of word 1
    const amountHex = body.slice(8 + 64, 8 + 128);
    if (!/^[0-9a-f]+$/.test(recipient.slice(2)) || !/^[0-9a-f]+$/.test(amountHex)) return null;
    return { recipient: custody.normalizeAddress(recipient), amountBaseUnits: BigInt('0x' + amountHex) };
}

/**
 * Decode a Tatum pending transaction's serialized payload into the strongest
 * usable ERC-20 transfer semantics. Returns null when the payload does not
 * carry parseable semantics — which means "unusable evidence", never
 * "mismatch".
 */
function decodePendingTransferSemantics(serializedTransaction) {
    if (typeof serializedTransaction !== 'string' || serializedTransaction.length === 0) return null;

    // r23 D4 — FAIL-CLOSED DECODING. The ONLY admissible representation is
    // the KMS EVM JSON tx object carrying BOTH the ERC-20 transfer calldata
    // AND an explicit `to` (the token contract). The previous bare-hex
    // "selector-located-inside-a-larger-payload" fallback produced a decoded
    // recipient/amount WITHOUT a contract — which matchesExecution then
    // treated as a match against ANY token contract. A shape the decoder
    // cannot strongly parse is UNUSABLE EVIDENCE (null): never a match,
    // never a definitive mismatch — the row stays quarantined for a human.
    // If Tatum ever ships a serialized-RLP EVM shape, a REAL decoder may be
    // added here; substring search is permanently prohibited.
    try {
        const tx = JSON.parse(serializedTransaction);
        if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return null;
        const calldata = decodeErc20TransferCalldata(String(tx.data || ''));
        if (!calldata) return null;
        const contract = custody.normalizeAddress(String(tx.to || ''));
        if (!custody.isValidPolygonAddress(contract)) return null; // no explicit contract → unusable
        return { contract, recipient: calldata.recipient, amountBaseUnits: calldata.amountBaseUnits };
    } catch {
        return null; // not strongly parseable JSON → unusable evidence
    }
}

/**
 * The strongest available matching of a provider PendingTransaction to a
 * local CustodyExecution, using ONLY the CURRENT documented response shape:
 *   chain     — must equal the Tatum chain id of the execution's network;
 *   hashes[]  — the KMS signature ids that must sign the pending transaction
 *               (exactly the signatureId we submitted in the transfer body);
 *   index     — for mnemonic-based signature ids, the derivation index of the
 *               exact source address (mandatory correspondence);
 *   decoded   — ERC-20 transfer semantics from the provider's own payload:
 *               exact recipient + exact base-unit amount (and contract when
//               the representation carries it).
 * A pending that decodes but DISAGREES on recipient/amount is a positive
 * NON-match (it belongs to a different intended operation), never a bind.
 */
function matchesExecution(pending, execution, { expectedSignatureId, expectedIndex }) {
    if (!pending || typeof pending !== 'object') return { usable: false, match: false };
    if (String(pending.chain || '') !== 'MATIC') return { usable: false, match: false };
    if (!Array.isArray(pending.hashes) || pending.hashes.length === 0) return { usable: false, match: false };
    if (!pending.hashes.some((h) => typeof h === 'string' && h === expectedSignatureId)) {
        return { usable: false, match: false };
    }
    const pendingIndex = pending.index == null ? null : Number(pending.index);
    const localIndex = expectedIndex == null ? null : Number(expectedIndex);
    if (pendingIndex !== localIndex) return { usable: false, match: false };

    const decoded = decodePendingTransferSemantics(pending.serializedTransaction);
    if (!decoded) return { usable: false, match: false };

    // r23 D4: the token contract must be EXPLICITLY established by the
    // payload. A decode without a contract is unusable evidence — a
    // recipient/amount collision is not a binding for a different token.
    // (decodePendingTransferSemantics now enforces this; the check is kept
    // as the belt to the decoder's braces.)
    if (decoded.contract == null) {
        return { usable: false, match: false, reason: 'CONTRACT_NOT_ESTABLISHED' };
    }
    if (custody.normalizeAddress(decoded.contract) !== custody.normalizeAddress(execution.contractAddress)) {
        return { usable: true, match: false, reason: 'CONTRACT_DIFFERS' };
    }
    if (decoded.recipient !== custody.normalizeAddress(execution.toAddress)) {
        return { usable: true, match: false, reason: 'RECIPIENT_DIFFERS' };
    }
    if (BigInt(decoded.amountBaseUnits) !== BigInt(execution.amountBaseUnits)) {
        return { usable: true, match: false, reason: 'AMOUNT_DIFFERS' };
    }
    return { usable: true, match: true };
}

/** Resolve the KMS signing identity the submission would use for this execution. */
function signerIdentityFor(prisma, execution) {
    // Same resolution as submitExecution: the signer registry is authoritative
    // for fromAddress → (signatureId, index). Deposit-address sources use the
    // derivation index recorded on the execution metadata.
    const cfg = custody.getConfig();
    const registry = custody.getSignerRegistry();
    const normalized = custody.normalizeAddress(execution.fromAddress);
    if (cfg.hotWalletAddress && normalized === custody.normalizeAddress(cfg.hotWalletAddress)) {
        return { signatureId: cfg.hotWalletSignatureId, index: cfg.hotWalletIndex };
    }
    for (const entry of registry) {
        if (custody.normalizeAddress(entry.address) === normalized) {
            const index = (execution.metadata && execution.metadata.derivationIndex != null)
                ? Number(execution.metadata.derivationIndex)
                : (entry.index ?? null);
            return { signatureId: entry.signatureId, index };
        }
    }
    return null;
}

// ── Shared exactly-once customer refund (same economic semantics as the
// controller's definitive pre-broadcast refund closure, derived ONLY from the
// durable execution identity — never re-priced, never rebuilt from mutable
// request data) ─────────────────────────────────────────────────────────────

async function refundWithdrawalFromExecution(tx, { execution, reason }) {
    const ledger = require('./ledgerService');
    const restrictedObligations = require('./restrictedObligationService');
    const custodyAccounting = require('./custodyAccountingService');

    const userId = execution.userId;
    if (userId == null) throw new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR,
        `Refund refused: execution ${execution.id} has no customer identity.`);

    // r23 D3 — LINKED-RECORD IDENTITY PRE-FLIGHT (before ANY money movement).
    // refId is an unvalidated TEXT column: a corrupted/misbound linkage must
    // surface BEFORE the balance/ledger legs execute, so the caller's
    // quarantine conversion commits ZERO money movement. Errors thrown here
    // are marked so failWithRefund / convergeRevertedExecution convert them
    // into a RECONCILIATION_REQUIRED quarantine with the refund withheld.
    if (execution.refId && execution.kind === 'CUSTOMER_WITHDRAWAL') {
        const linked = await tx.transactionHistory.findUnique({
            where: { id: execution.refId },
            select: { status: true, userId: true, type: true },
        });
        if (linked && (Number(linked.userId) !== Number(execution.userId) || linked.type !== 'WITHDRAWAL_CRYPTO')) {
            const err = new CustodyExecutionError(ERROR_CLASSES.CHAIN_MISMATCH,
                `Refund refused: linked TransactionHistory ${execution.refId} is bound to a different customer/type (userId ${linked.userId}, type ${linked.type}) — refund withheld; human reconciliation required.`);
            err.refundMisbound = true;
            throw err;
        }
        if (linked && linked.status === 'COMPLETED') {
            const err = new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR,
                `Refund refused: linked TransactionHistory ${execution.refId} is already COMPLETED — human reconciliation required.`);
            err.refundContradiction = true;
            throw err;
        }
    }

    const fullDebit = BigInt(execution.metadata?.customerDebitBaseUnits ?? execution.amountBaseUnits);
    const netPayout = BigInt(execution.amountBaseUnits);
    const feeCharge = BigInt(execution.feeChargeBaseUnits ?? 0);
    const fullDebitExact = custodyAccounting.decimalStringFromBaseUnits(fullDebit, 6);
    const netPayoutExact = custodyAccounting.decimalStringFromBaseUnits(netPayout, 6);
    const feeExact = custodyAccounting.decimalStringFromBaseUnits(feeCharge, 6);

    // Customer projection: the debit returns.
    await tx.user.update({
        where: { id: userId },
        data: { availableBalance: { increment: new Prisma.Decimal(fullDebitExact) } },
    });

    // §P.4 authoritative reversal — applies ONLY when the reservation exists
    // (legacy executions have no ledger truth to reverse). Same idempotency
    // key family as the controller's refund path: converges on one posting.
    const reservation = await tx.restrictedObligation.findFirst({
        where: { reference: `withdrawal:crypto:${execution.id}`, status: 'ACTIVE' },
    });
    if (reservation) {
        const reversal = await ledger.post(tx, {
            idempotencyKey: `ledger:withdrawal:crypto:refund:${execution.id}`,
            entryType: 'CUSTODY_WITHDRAWAL',
            description: `Crypto withdrawal refund — ${reason}`,
            reference: `custody-exec:${execution.id}`,
            userId,
            relatedEntity: 'custodyExecution',
            relatedEntityId: execution.id,
            metadata: { status: 'REFUNDED', reason: String(reason || '').slice(0, 60) },
            lines: [
                { account: 'restricted:reserves', debit: fullDebitExact },
                { account: `user:${userId}:liability`, credit: fullDebitExact },
            ],
        });
        await restrictedObligations.cancelOnReversal(tx, {
            reference: `withdrawal:crypto:${execution.id}`,
            releaseLedgerTransactionId: reversal.transaction.id,
        });
    }

    // Treasury/fee mirrors of the original reservation-side movements.
    await tx.systemHotWallet.update({
        where: { id: 1 },
        data: { balance: { increment: new Prisma.Decimal(netPayoutExact) } },
    }).catch(() => { /* hot-wallet mirror may be absent in legacy/minimal fixtures */ });
    if (!(new Prisma.Decimal(feeExact)).isZero()) {
        await tx.systemProfitFees.update({
            where: { id: 1 },
            data: { balance: { decrement: new Prisma.Decimal(feeExact) } },
        }).catch(() => { /* fee mirror absent in minimal fixtures */ });
    }

    // Linked customer-facing record: FAILED exactly once (conditional).
    // The identity pre-flight above already verified owner+type, so this CAS
    // cannot touch ANOTHER customer's record; a missing row (the pre-flight
    // found nothing) is an integrity incident — the refund still proceeds on
    // durable execution truth, the customer's debit is not hostage to a lost
    // linkage.
    if (execution.refId && execution.kind === 'CUSTOMER_WITHDRAWAL') {
        const hist = await tx.transactionHistory.updateMany({
            where: { id: execution.refId, status: 'PENDING' },
            data: { status: 'FAILED' },
        });
        if (hist.count === 0) {
            const current = await tx.transactionHistory.findUnique({ where: { id: execution.refId }, select: { status: true } });
            if (current && current.status === 'COMPLETED') {
                // The pre-flight raced a concurrent completion: the record now
                // says the withdrawal completed. Throwing rolls back the
                // whole refund transaction (money untouched) and the caller
                // quarantines on refundContradiction.
                const err = new CustodyExecutionError(ERROR_CLASSES.CONFIGURATION_ERROR,
                    `Refund refused: linked TransactionHistory ${execution.refId} was completed concurrently — human reconciliation required.`);
                err.refundContradiction = true;
                throw err;
            }
            logger.warn({ executionId: execution.id, refId: execution.refId },
                '[custody-recovery] linked TransactionHistory missing at refund time — refund proceeds on execution truth; integrity incident recorded');
        }
    }
}

// ── r23 D5 — RECOVERY ATTEMPT SCHEDULING (fairness under load) ─────────────
// Every examined-but-unresolved row is stamped with an exponential backoff so
// a permanently-unresolvable row (or a provider outage) consumes
// progressively fewer scan slots. A NEW row is always due immediately
// (nextRecoveryAttemptAt NULL) and can therefore never be starved by a page of
// older unresolved rows: after one examination the backlog moves into its
// backoff window and the fresh row is visible on the next bounded pass.
const RECOVERY_BACKOFF_SCHEDULE_MS = [
    60 * 1000,  60 * 1000,  60 * 1000,   // first three retries: worker cadence
    300 * 1000, 300 * 1000, 300 * 1000,  // then every 5 minutes
];
const RECOVERY_BACKOFF_CAP_MS = 15 * 60 * 1000; // cap: 15 minutes

function recoveryBackoffMs(attemptCount) {
    const idx = Math.max(0, Number(attemptCount) || 0);
    return idx < RECOVERY_BACKOFF_SCHEDULE_MS.length ? RECOVERY_BACKOFF_SCHEDULE_MS[idx] : RECOVERY_BACKOFF_CAP_MS;
}

/**
 * Stamp an examined-but-unresolved row with its next due time. Conditional on
 * the row still being in a recovery-owned non-terminal state — if a racing
 * worker already moved it on, this is a harmless no-op (the scans filter on
 * status + due time). Two concurrent workers stamping the same row converge
 * to compatible values; the attempt counter drives the backoff growth.
 */
async function scheduleNextRecoveryAttempt(prismaOrTx, execution, now = Date.now()) {
    await prismaOrTx.custodyExecution.updateMany({
        where: {
            id: execution.id,
            status: { in: [STATUSES.REQUESTED, STATUSES.RESERVING, STATUSES.SUBMITTED, STATUSES.SIGNING, STATUSES.RECONCILIATION_REQUIRED] },
        },
        data: {
            lastRecoveryAttemptAt: new Date(now),
            nextRecoveryAttemptAt: new Date(now + recoveryBackoffMs(execution.recoveryAttemptCount ?? 0)),
            recoveryAttemptCount: { increment: 1 },
        },
    });
}

/**
 * The due-now Prisma filter: never attempted (NULL) or past its scheduled
 * backoff window. Shared by every category scan so the semantics are
 * identical everywhere.
 */
function dueNowFilter(now) {
    return { OR: [{ nextRecoveryAttemptAt: null }, { nextRecoveryAttemptAt: { lte: new Date(now) } }] };
}

// ── B. RESERVING recovery ────────────────────────────────────────────────────

/**
 * Recover stale RESERVING executions. Policy:
 *   PENDING approval   → the request died before four-eye authorization; no
 *                        submission CAS was claimed (a claimed row is
 *                        SUBMITTED), so no provider I/O can have happened.
 *                        Fail + exactly-once refund.
 *   APPROVED           → durable authorization exists; re-enter the canonical
 *                        submitExecution() boundary (single-winner CAS).
 *   DENIED             → a denied request may not be submitted; fail +
 *                        exactly-once refund (no provider I/O possible:
 *                        submitExecution refuses DENIED approvals and the
 *                        row was never claimed).
 * Never: double-debits, second executions/obligations/history rows, four-eye
 * bypass, or a second submission.
 */
async function recoverReservingExecutions(prisma, { provider = null, limit = 25, now = Date.now() } = {}) {
    custody.requireExecutionEnabled();
    const staleBefore = new Date(now - reservingStaleMs());
    // r23 D5: due-scheduled bounded selection — rows in a backoff window are
    // invisible, so a permanently-unresolvable row can never starve newer
    // ones. r23 D6: REQUESTED rows are owned here too (today's creators start
    // at RESERVING, but REQUESTED is a legal transient entry state and the
    // state machine refuses unowned states).
    const rows = await prisma.custodyExecution.findMany({
        where: {
            status: { in: [STATUSES.REQUESTED, STATUSES.RESERVING] },
            createdAt: { lt: staleBefore },
            ...dueNowFilter(now),
        },
        orderBy: [{ nextRecoveryAttemptAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
        take: limit,
    });
    const results = [];
    for (const execution of rows) {
        try {
            if (execution.approvalStatus === 'APPROVED') {
                // Re-enter the canonical boundary. The CAS inside
                // submitExecution guarantees exactly one submission across
                // every racing submitter/recovery worker.
                const submission = await custody.submitExecution(prisma, { executionId: execution.id }, provider ? { provider } : {});
                results.push({ executionId: execution.id, action: 'RESUBMITTED', status: submission.status });
            } else if (execution.approvalStatus === 'PENDING' || execution.approvalStatus === 'DENIED') {
                const outcome = await failWithRefund(prisma, {
                    execution,
                    errorClass: execution.approvalStatus === 'DENIED'
                        ? ERROR_CLASSES.CONFIGURATION_ERROR
                        : ERROR_CLASSES.PROVIDER_REJECTED,
                    errorMessage: execution.approvalStatus === 'DENIED'
                        ? 'Recovery: withdrawal was denied before submission — refunded (no provider I/O possible).'
                        : 'Recovery: withdrawal request stranded before KMS approval (crash window) — refunded; no provider I/O occurred.',
                });
                if (outcome.quarantined) {
                    results.push({ executionId: execution.id, action: 'QUARANTINED_REFUND_WITHHELD', status: STATUSES.RECONCILIATION_REQUIRED, detail: outcome.reason });
                } else {
                    results.push({ executionId: execution.id, action: outcome.failed ? 'FAILED_REFUNDED' : 'SKIPPED', status: outcome.failed ? STATUSES.FAILED : STATUSES.RESERVING });
                }
            } else {
                // Unrecognized approval status: unresolved — reschedule with
                // backoff so it cannot monopolize the scan page (r23 D5).
                await scheduleNextRecoveryAttempt(prisma, execution, now);
                results.push({ executionId: execution.id, action: 'SKIPPED', status: STATUSES.RESERVING });
            }
        } catch (err) {
            logger.warn({ err: redact(err.message), executionId: execution.id }, '[custody-recovery] RESERVING recovery failed');
            // The row stays in its state: reschedule with backoff (r23 D5).
            await scheduleNextRecoveryAttempt(prisma, execution, now);
            results.push({ executionId: execution.id, action: 'ERROR', detail: redact(err.message) });
        }
    }
    return results;
}

/**
 * Exactly-once terminal failure WITH the customer refund, from
 * PRE-SUBMISSION states only (REQUESTED/RESERVING). r23 D1: SUBMITTED/SIGNING
 * were removed — from those states NO caller can prove "no broadcast
 * possible" from DB state alone (the submission CAS means a provider call
 * may be or have been in flight; a provider cancel success is not broadcast
 * proof). Post-CAS failures route to quarantine, never here.
 *
 * The conditional transition IS the single-winner claim: a concurrent
 * duplicate converges without a second refund. The ledger idempotency key
 * converges on retry even if the transaction is interrupted after commit.
 *
 * `transitionData` merges additional CAS-transition fields (e.g. the denial
 * path's approvalStatus: 'DENIED') so the caller never needs a second,
 * unconditional write after the money move.
 *
 * If the refund itself discovers a MISBOUND linked history row (refId
 * pointing at another customer's record), the refund is WITHHELD and the
 * row is quarantined in the SAME transaction — { quarantined: true }.
 */
async function failWithRefund(prisma, { execution, errorClass, errorMessage, reason = 'definitive failure', transitionData = {} }) {
    return prisma.$transaction(async (tx) => {
        const res = await tx.custodyExecution.updateMany({
            where: { id: execution.id, status: { in: [STATUSES.REQUESTED, STATUSES.RESERVING] } },
            data: { status: STATUSES.FAILED, errorClass: errorClass || ERROR_CLASSES.PROVIDER_REJECTED, errorMessage: redact(errorMessage), ...transitionData },
        });
        if (res.count !== 1) return { failed: false, reason: 'EXECUTION_NOT_IN_PRE_SUBMISSION_STATE' };

        if (execution.kind === 'CUSTOMER_WITHDRAWAL') {
            try {
                await refundWithdrawalFromExecution(tx, { execution, reason });
            } catch (err) {
                if (err && err.refundMisbound) {
                    // Convert the definitive failure into a quarantine in the
                    // SAME transaction: the refund was withheld, no money
                    // moved, and the misbound linkage needs a human.
                    await tx.custodyExecution.updateMany({
                        where: { id: execution.id, status: STATUSES.FAILED },
                        data: {
                            status: STATUSES.RECONCILIATION_REQUIRED,
                            errorClass: ERROR_CLASSES.CHAIN_MISMATCH,
                            errorMessage: redact(`${err.message} [refund withheld — failWithRefund converted the failure into a quarantine]`).slice(0, 500),
                            ...transitionData,
                        },
                    });
                    return { failed: false, quarantined: true, reason: 'REFUND_MISBOUND_HISTORY_QUARANTINED' };
                }
                if (err && err.refundContradiction) {
                    // Linked record claims the withdrawal COMPLETED — the
                    // money state is genuinely contradictory. Quarantine
                    // atomically; a human decides.
                    await tx.custodyExecution.updateMany({
                        where: { id: execution.id, status: STATUSES.FAILED },
                        data: {
                            status: STATUSES.RECONCILIATION_REQUIRED,
                            errorClass: ERROR_CLASSES.CHAIN_MISMATCH,
                            errorMessage: redact(`${err.message} [refund withheld — human reconciliation required]`).slice(0, 500),
                            ...transitionData,
                        },
                    });
                    return { failed: false, quarantined: true, reason: 'REFUND_CONTRADICTION_QUARANTINED' };
                }
                throw err;
            }
        }
        if (execution.kind === 'DEPOSIT_SWEEP' && execution.refId) {
            // Audit-row convergence (never blocks the money path).
            await tx.onchainSweep.updateMany({
                where: { id: execution.refId },
                data: { status: 'FAILED' },
            }).catch(() => {});
        }
        return { failed: true };
    });
}

// ── C. SUBMITTED recovery (the crash-after-claim window) ─────────────────────

/**
 * Resolve a SUBMITTED execution using Tatum's pending-KMS contract — WITHOUT
 * ever issuing a second transfer.
 *
 *   tatumPendingId present  → the claim recorded the provider's pending id but
 *                              died before the SIGNING transition: inspect the
 *                              pending directly and converge (SIGNING or
 *                              BROADCAST when already signed).
 *   tatumPendingId absent   → crash-after-CAS before the response was
 *                              recorded: list ALL pending KMS transactions for
 *                              the chain and bind ONLY on the strongest
 *                              evidence (exact signature identity + exact
 *                              decoded transfer semantics), exactly once, via a
 *                              conditional update. No match (or ambiguous
 *                              evidence) → honest quarantine; NEVER a blind
 *                              retry, NEVER a refund.
 */
async function recoverSubmittedExecutions(prisma, { provider = null, limit = 25, now = Date.now() } = {}) {
    custody.requireExecutionEnabled();
    const prov = provider || custody.__getProviderForRecovery();
    const graceBefore = new Date(now - submittedGraceMs());
    // r23 D5: due-scheduled bounded selection (see recoverReservingExecutions).
    const rows = await prisma.custodyExecution.findMany({
        where: {
            status: STATUSES.SUBMITTED,
            OR: [{ submittedAt: { lt: graceBefore } }, { submittedAt: null }],
            ...dueNowFilter(now),
        },
        orderBy: [{ nextRecoveryAttemptAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
        take: limit,
    });
    const results = [];
    for (const execution of rows) {
        try {
            const outcome = await resolveSubmittedExecution(prisma, { execution, provider: prov, now });
            // Unresolved outcomes keep the row SUBMITTED — reschedule with
            // backoff so a provider outage (or any permanently-unresolvable
            // row) cannot monopolize the scan page (r23 D5).
            if (outcome.action === 'PROVIDER_UNAVAILABLE' || outcome.action === 'ERROR') {
                await scheduleNextRecoveryAttempt(prisma, execution, now);
            }
            results.push({ executionId: execution.id, ...outcome });
        } catch (err) {
            logger.warn({ err: redact(err.message), executionId: execution.id }, '[custody-recovery] SUBMITTED recovery failed');
            await scheduleNextRecoveryAttempt(prisma, execution, now);
            results.push({ executionId: execution.id, action: 'ERROR', detail: redact(err.message) });
        }
    }
    return results;
}

async function resolveSubmittedExecution(prisma, { execution, provider, now = Date.now() }) {
    // r23 D1: a DENIED execution must never return to life. The four-eye
    // validator refuses to sign DENIED rows, so no future broadcast can
    // follow — but a denial observed after the submission CAS could not
    // prove none happened. Fail closed: quarantine as HUMAN-owned (the
    // automatic reconciliation pass skips DENIED rows).
    if (execution.approvalStatus === 'DENIED') {
        await custody.transitionExecutionForRecovery(prisma, execution.id, [STATUSES.SUBMITTED], {
            status: STATUSES.RECONCILIATION_REQUIRED,
            errorClass: ERROR_CLASSES.CONFIGURATION_ERROR,
            errorMessage: redact('Execution was denied after the submission claim — human reconciliation required (automatic recovery refuses DENIED executions).').slice(0, 500),
        });
        return { action: 'QUARANTINED_DENIED', status: STATUSES.RECONCILIATION_REQUIRED };
    }
    // Crash after the provider returned a pending id but before the SIGNING
    // transition committed: converge directly on the pending's real state.
    if (execution.tatumPendingId) {
        const kms = await provider.getKmsRequest(execution.tatumPendingId);
        if (kms && kms.txHash) {
            if (!custody.isValidTxHash(kms.txHash)) {
                await quarantine(prisma, execution, ERROR_CLASSES.CHAIN_MISMATCH,
                    'KMS pending carries a malformed tx hash — human reconciliation required.');
                return { action: 'QUARANTINED', status: STATUSES.RECONCILIATION_REQUIRED };
            }
            const moved = await custody.transitionExecutionForRecovery(prisma, execution.id, [STATUSES.SUBMITTED], {
                status: STATUSES.BROADCAST, txHash: kms.txHash, broadcastAt: new Date(now),
            });
            if (moved) return { action: 'BOUND_BROADCAST', status: STATUSES.BROADCAST, txHash: kms.txHash };
            return { action: 'CONVERGED', status: await currentStatus(prisma, execution.id) };
        }
        const moved = await custody.transitionExecutionForRecovery(prisma, execution.id, [STATUSES.SUBMITTED], {
            status: STATUSES.SIGNING,
        });
        if (moved) return { action: 'BOUND_SIGNING', status: STATUSES.SIGNING };
        return { action: 'CONVERGED', status: await currentStatus(prisma, execution.id) };
    }

    // Crash-after-CAS with NO recorded pending id. Resolve with the provider's
    // pending list — the ONLY admissible evidence. Never resubmit.
    const signer = signerIdentityFor(prisma, execution);
    if (!signer || !signer.signatureId) {
        await quarantine(prisma, execution, ERROR_CLASSES.CONFIGURATION_ERROR,
            'Recovery cannot resolve the KMS signing identity for the source address — human reconciliation required.');
        return { action: 'QUARANTINED', status: STATUSES.RECONCILIATION_REQUIRED };
    }

    let pendings;
    try {
        pendings = await provider.listPendingRequests('MATIC');
    } catch (err) {
        // Provider unavailable: leave the row for the next pass. NO state
        // change, NO retry, NO refund.
        return { action: 'PROVIDER_UNAVAILABLE', detail: redact(err.message) };
    }
    if (!Array.isArray(pendings)) pendings = [];

    const candidates = [];
    for (const pending of pendings) {
        const verdict = matchesExecution(pending, execution, { expectedSignatureId: signer.signatureId, expectedIndex: signer.index });
        if (verdict.usable && verdict.match) candidates.push(pending);
    }

    // Exclude a pending that is already durably bound to a DIFFERENT execution.
    const bindable = [];
    for (const candidate of candidates) {
        const owner = await prisma.custodyExecution.findFirst({
            where: { tatumPendingId: candidate.id, id: { not: execution.id } },
            select: { id: true },
        });
        if (!owner) bindable.push(candidate);
    }

    if (bindable.length === 1) {
        const pending = bindable[0];
        const pendingTxId = (pending.txId && custody.isValidTxHash(pending.txId)) ? pending.txId : null;
        if (pending.txId && !pendingTxId) {
            await quarantine(prisma, execution, ERROR_CLASSES.CHAIN_MISMATCH,
                'Provider pending transaction carries a malformed tx hash — human reconciliation required.');
            return { action: 'QUARANTINED', status: STATUSES.RECONCILIATION_REQUIRED };
        }
        const moved = pendingTxId
            ? await custody.transitionExecutionForRecovery(prisma, execution.id, [STATUSES.SUBMITTED], {
                status: STATUSES.BROADCAST, tatumPendingId: pending.id, txHash: pendingTxId, broadcastAt: new Date(now),
            })
            : await custody.transitionExecutionForRecovery(prisma, execution.id, [STATUSES.SUBMITTED], {
                status: STATUSES.SIGNING, tatumPendingId: pending.id,
            });
        if (moved) {
            return pendingTxId
                ? { action: 'BOUND_BROADCAST', status: STATUSES.BROADCAST, txHash: pendingTxId, pendingId: pending.id }
                : { action: 'BOUND_SIGNING', status: STATUSES.SIGNING, pendingId: pending.id };
        }
        return { action: 'CONVERGED', status: await currentStatus(prisma, execution.id) };
    }

    if (bindable.length > 1) {
        // Multiple indistinguishable candidates: NO probabilistic binding.
        await quarantine(prisma, execution, ERROR_CLASSES.UNKNOWN_OUTCOME,
            'Provider pending scan found multiple matching pending transactions — binding is ambiguous; human reconciliation required (no retry).');
        return { action: 'QUARANTINED_AMBIGUOUS', status: STATUSES.RECONCILIATION_REQUIRED };
    }

    // No candidate. HONEST LIMIT (documented, not guessed): a completed/
    // canceled pending LEAVES the list, so absence does NOT prove no
    // broadcast. This is quarantined with evidence — never auto-refunded.
    await quarantine(prisma, execution, ERROR_CLASSES.UNKNOWN_OUTCOME,
        'Provider pending scan found no matching pending transaction; absence does not prove no broadcast — human reconciliation required before any refund.');
    return { action: 'QUARANTINED_NO_MATCH', status: STATUSES.RECONCILIATION_REQUIRED };
}

// ── D/E. RECONCILIATION_REQUIRED convergence ─────────────────────────────────

/**
 * Every quarantined execution is classified and given a recurring owner:
 *   UNKNOWN_OUTCOME  → keep resolving with provider pending evidence (binds
 *                       when it appears; stays quarantined while it does not).
 *   CHAIN_REVERTED    → definitive revert: terminal FAILED + exactly-once
 *                       customer refund (withdrawals), atomic.
 *   anything else     → genuinely contradictory: remains quarantined for human
 *                       reconciliation (durable evidence on the row; the
 *                       four-eye validator refuses to sign; no retry/refund).
 */
async function convergeReconciliationRequired(prisma, { provider = null, limit = 25, now = Date.now() } = {}) {
    custody.requireExecutionEnabled();
    const prov = provider || custody.__getProviderForRecovery();
    // r23 D5: the automatic pass processes ONLY the automatically-actionable
    // classes (UNKNOWN_OUTCOME pending-scan resolution, CHAIN_REVERTED
    // exactly-once refund convergence). Genuinely contradictory rows
    // (CHAIN_MISMATCH, CONFIGURATION_ERROR, DENIED post-submission denials,
    // …) are HUMAN-OWNED: they are excluded from the bounded page entirely so
    // a permanent human case can never consume the scan slots that
    // actionable unknown-outcome cases need. Human-owned rows remain fully
    // visible to admin tooling — this is a scan-scope decision, not a
    // data-visibility decision.
    // r23 D5: due-scheduled bounded selection (see recoverReservingExecutions).
    const rows = await prisma.custodyExecution.findMany({
        where: {
            status: STATUSES.RECONCILIATION_REQUIRED,
            errorClass: { in: [ERROR_CLASSES.UNKNOWN_OUTCOME, ERROR_CLASSES.CHAIN_REVERTED] },
            approvalStatus: { not: 'DENIED' },
            ...dueNowFilter(now),
        },
        orderBy: [{ nextRecoveryAttemptAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
        take: limit,
    });
    const results = [];
    for (const execution of rows) {
        try {
            if (execution.errorClass === ERROR_CLASSES.UNKNOWN_OUTCOME && !execution.tatumPendingId) {
                // The same evidence-driven resolution as SUBMITTED — but from
                // quarantine. Any binding is a durable CAS; a no-match result
                // is a no-op (already quarantined, evidence already recorded).
                const fresh = await prisma.custodyExecution.findUnique({ where: { id: execution.id } });
                if (fresh && fresh.status === STATUSES.RECONCILIATION_REQUIRED && !fresh.tatumPendingId) {
                    const outcome = await resolveQuarantinedSubmission(prisma, { execution: fresh, provider: prov, now });
                    // STILL_QUARANTINED_* / PROVIDER_UNAVAILABLE keep the row
                    // quarantined — reschedule with backoff (r23 D5).
                    if (String(outcome.action).startsWith('STILL_QUARANTINED') || outcome.action === 'PROVIDER_UNAVAILABLE' || outcome.action === 'ERROR') {
                        await scheduleNextRecoveryAttempt(prisma, fresh, now);
                    }
                    results.push({ executionId: execution.id, ...outcome });
                    continue;
                }
                results.push({ executionId: execution.id, action: 'CONVERGED', status: await currentStatus(prisma, execution.id) });
                continue;
            }
            if (execution.errorClass === ERROR_CLASSES.CHAIN_REVERTED) {
                const outcome = await convergeRevertedExecution(prisma, { execution, now });
                results.push({ executionId: execution.id, ...outcome });
                continue;
            }
            // CHAIN_MISMATCH / contradictory evidence: human reconciliation.
            results.push({ executionId: execution.id, action: 'HUMAN_RECONCILIATION', errorClass: execution.errorClass });
        } catch (err) {
            logger.warn({ err: redact(err.message), executionId: execution.id }, '[custody-recovery] reconciliation convergence failed');
            await scheduleNextRecoveryAttempt(prisma, execution, now);
            results.push({ executionId: execution.id, action: 'ERROR', detail: redact(err.message) });
        }
    }
    return results;
}

/** Quarantined ambiguous submission: same pending-scan resolution as C, but a
 *  no-match outcome leaves the quarantine in place (idempotent). */
async function resolveQuarantinedSubmission(prisma, { execution, provider, now = Date.now() }) {
    // r23 D1: a DENIED execution must never return to life — never bind a
    // provider pending to it, never resurrect it into SIGNING/BROADCAST.
    if (execution.approvalStatus === 'DENIED') {
        return { action: 'HUMAN_RECONCILIATION', errorClass: execution.errorClass, detail: 'DENIED — a human must verify whether the unavoidable external race broadcast before the denial' };
    }
    const signer = signerIdentityFor(prisma, execution);
    if (!signer || !signer.signatureId) {
        return { action: 'HUMAN_RECONCILIATION', errorClass: execution.errorClass };
    }
    let pendings;
    try {
        pendings = await provider.listPendingRequests('MATIC');
    } catch (err) {
        return { action: 'PROVIDER_UNAVAILABLE', detail: redact(err.message) };
    }
    if (!Array.isArray(pendings)) pendings = [];
    const bindable = [];
    for (const pending of pendings) {
        const verdict = matchesExecution(pending, execution, { expectedSignatureId: signer.signatureId, expectedIndex: signer.index });
        if (!verdict.usable || !verdict.match) continue;
        const owner = await prisma.custodyExecution.findFirst({
            where: { tatumPendingId: pending.id, id: { not: execution.id } },
            select: { id: true },
        });
        if (!owner) bindable.push(pending);
    }
    if (bindable.length !== 1) {
        // Still unresolved: the quarantine stays (evidence already recorded).
        return { action: bindable.length > 1 ? 'STILL_QUARANTINED_AMBIGUOUS' : 'STILL_QUARANTINED_NO_MATCH', status: STATUSES.RECONCILIATION_REQUIRED };
    }
    const pending = bindable[0];
    const pendingTxId = (pending.txId && custody.isValidTxHash(pending.txId)) ? pending.txId : null;
    const moved = pendingTxId
        ? await custody.transitionExecutionForRecovery(prisma, execution.id, [STATUSES.RECONCILIATION_REQUIRED], {
            status: STATUSES.BROADCAST, tatumPendingId: pending.id, txHash: pendingTxId, broadcastAt: new Date(now),
        })
        : await custody.transitionExecutionForRecovery(prisma, execution.id, [STATUSES.RECONCILIATION_REQUIRED], {
            status: STATUSES.SIGNING, tatumPendingId: pending.id,
        });
    if (moved) {
        return pendingTxId
            ? { action: 'BOUND_BROADCAST', status: STATUSES.BROADCAST, txHash: pendingTxId, pendingId: pending.id }
            : { action: 'BOUND_SIGNING', status: STATUSES.SIGNING, pendingId: pending.id };
    }
    return { action: 'CONVERGED', status: await currentStatus(prisma, execution.id) };
}

/**
 * Definitive chain revert (E): the receipt proved the intended transfer did
 * NOT execute. The customer's debit converges back — exactly once, atomic
 * with the terminal FAILED transition. The execution's txHash is PRESERVED as
 * the durable revert evidence. Network gas (paid by the hot wallet operator
 * in MATIC) is an operating cost — realizedNetworkCostBaseUnits is NEVER
 * fabricated from the estimate (r22-Q: P1 follow-up with exact evidence).
 */
async function convergeRevertedExecution(prisma, { execution, now = Date.now() }) {
    return prisma.$transaction(async (tx) => {
        const res = await tx.custodyExecution.updateMany({
            where: {
                id: execution.id,
                status: STATUSES.RECONCILIATION_REQUIRED,
                errorClass: ERROR_CLASSES.CHAIN_REVERTED,
            },
            data: {
                status: STATUSES.FAILED,
                errorMessage: redact(`${execution.errorMessage || ''} [converged: verified chain revert — refund executed]`.trim()),
            },
        });
        if (res.count !== 1) {
            return { action: 'CONVERGED', status: await currentStatus(tx, execution.id) };
        }

        if (execution.kind === 'CUSTOMER_WITHDRAWAL') {
            try {
                await refundWithdrawalFromExecution(tx, {
                    execution,
                    reason: 'verified chain revert',
                });
            } catch (err) {
                if (err && (err.refundMisbound || err.refundContradiction)) {
                    // The revert is definitive but the refund's linkage is
                    // misbound/contradictory: the refund is WITHHELD and the
                    // row is re-classified as human-owned (CHAIN_MISMATCH) in
                    // the same transaction — no money moved, no silent
                    // divergence, and the automatic pass stops touching it.
                    await tx.custodyExecution.updateMany({
                        where: { id: execution.id, status: STATUSES.FAILED },
                        data: {
                            status: STATUSES.RECONCILIATION_REQUIRED,
                            errorClass: ERROR_CLASSES.CHAIN_MISMATCH,
                            errorMessage: redact(`${err.message} [chain revert was verified; refund withheld — human reconciliation required]`).slice(0, 500),
                        },
                    });
                    return { action: 'REVERT_REFUND_WITHHELD_QUARANTINED', status: STATUSES.RECONCILIATION_REQUIRED };
                }
                throw err;
            }
        }
        if (execution.kind === 'DEPOSIT_SWEEP' && execution.refId) {
            await tx.onchainSweep.updateMany({
                where: { id: execution.refId },
                data: { status: 'FAILED' },
            }).catch(() => {});
        }
        return { action: 'REVERT_REFUNDED', status: STATUSES.FAILED };
    });
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function quarantine(prisma, execution, errorClass, message) {
    await custody.transitionExecutionForRecovery(prisma, execution.id, [STATUSES.SUBMITTED], {
        status: STATUSES.RECONCILIATION_REQUIRED,
        errorClass,
        errorMessage: redact(message).slice(0, 500),
    });
}

async function currentStatus(prismaOrTx, executionId) {
    const row = await prismaOrTx.custodyExecution.findUnique({ where: { id: executionId }, select: { status: true } });
    return row ? row.status : 'NOT_FOUND';
}

// ── Orchestration (the recovery pass the worker drives) ──────────────────────

/**
 * One bounded, idempotent, concurrency-safe recovery pass. Safe to run from
 * multiple workers / duplicate distributed ticks: every transition is a
 * conditional single-winner CAS on real PostgreSQL, and the money paths are
 * exactly-once by construction (conditional terminal transition + ledger
 * idempotency keys).
 */
async function runRecoveryPass(prisma, { provider = null, limit = 25, now = Date.now() } = {}) {
    const [reserving, submitted, reconciliations, advanced] = await Promise.all([
        recoverReservingExecutions(prisma, { provider, limit, now }).catch((err) => [{ action: 'PASS_ERROR', detail: redact(err.message) }]),
        recoverSubmittedExecutions(prisma, { provider, limit, now }).catch((err) => [{ action: 'PASS_ERROR', detail: redact(err.message) }]),
        convergeReconciliationRequired(prisma, { provider, limit, now }).catch((err) => [{ action: 'PASS_ERROR', detail: redact(err.message) }]),
        // Existing authority for SIGNING/BROADCAST advancement.
        custody.reconcilePendingExecutions(prisma, provider ? { provider, limit } : { limit }).catch((err) => [{ action: 'PASS_ERROR', detail: redact(err.message) }]),
    ]);
    return { reserving, submitted, reconciliations, advanced };
}

module.exports = {
    // state-machine and evidence helpers (exported for focused tests)
    decodeErc20TransferCalldata,
    decodePendingTransferSemantics,
    matchesExecution,
    signerIdentityFor,
    reservingStaleMs,
    submittedGraceMs,
    recoveryBackoffMs,
    scheduleNextRecoveryAttempt,
    // recovery owners
    recoverReservingExecutions,
    recoverSubmittedExecutions,
    convergeReconciliationRequired,
    failWithRefund,
    refundWithdrawalFromExecution,
    runRecoveryPass,
};
