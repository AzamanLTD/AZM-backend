// workers/payoutBatchWorker.js
// =============================================================================
// AZAMAN V2 — PAYOUT BATCH WORKER  (Phase Q8 — Admin Autonomous Payouts)
//
// Purpose
// -------
// Automatically processes PENDING fiat withdrawals when:
//   1. Auto-payout is ENABLED in GlobalSettings (master switch)
//   2. SystemFiatPool has sufficient liquidity (>= autoPayoutThresholdUsdc)
//   3. Individual withdrawal amount <= autoPayoutMaxAmountUsdc
//
// Withdrawals that FAIL any gate are flagged as NEEDS_MANUAL_REVIEW so
// admins can see them in a dedicated War Room section.
//
// This worker does NOT replace withdrawalReconciliationWorker — that one
// handles provider settlement status polling. This worker handles the DECISION
// of whether to auto-dispatch vs. flag for manual admin action.
//
// Flow per tick:
//   1. Read GlobalSettings for auto-payout config
//   2. If disabled, skip (log once per disable→enable transition)
//   3. Scan PENDING withdrawals (payoutMethod containing 'MOMO' or fiat)
//   4. For each:
//      a. If amount > autoPayoutMaxAmountUsdc → mark NEEDS_MANUAL_REVIEW
//      b. Resolve the canonical PENDING TransactionHistory row first.
//      c. §P.5-D PER-ROW REGIME: the recorded row decides the liquidity
//         regime — NOT the current global flag. A withdrawal with a
//         FiatLiquidityReservation for its canonical reference is an
//         authority payout (exact reserved GHS, authority headroom gate);
//         a withdrawal with NO reservation row is a legacy payout (legacy
//         SystemFiatPool projection gate) even when the flag is ON.
//      d. Atomically claim the withdrawal as PROCESSING before provider I/O.
//      e. Dispatch using that row's existing txHash as the provider
//         reference — with the EXACT GHS reserved at creation time for
//         authority rows (a later rate change must never mutate the
//         provider payout amount of an existing reservation).
//      f. Reconciliation owns the final transition.
//   5. Emit admin_alert socket events for flagged withdrawals
//
// IMPORTANT: The finance withdrawal flow already creates the canonical
// TransactionHistory row and reserves the user's funds. Auto-payout must never
// create a second financial history row or invent a second provider reference;
// doing so can make reconciliation ambiguous and can double-refund failures.
// =============================================================================

const { Prisma } = require('@prisma/client');
const logger = require('../src/config/logger');
const fiatLiquidity = require('../src/services/fiatLiquidityService'); // §P.5-D
const { canonicalProviderName, persistPayoutOwnership } = require('../services/payoutProviderOwnership');
const { recordReconciliationException } = require('../services/reconciliationExceptionService');
const restrictedObligations = require('../services/restrictedObligationService'); // r17 P0 durable identity

const DEFAULT_INTERVAL_MS = 120_000;  // 2 minutes
const MAX_BATCH_SIZE      = 25;       // Don't overwhelm the provider in one tick

class PayoutBatchWorker {
    constructor(prisma, io, mtnDisbursementService, notificationService) {
        this.prisma = prisma;
        this.io = io;
        this.mtn = mtnDisbursementService;
        this.notificationService = notificationService;
        this._timer = null;
        this._running = false;
        this._lastEnabledState = null; // Track state transitions for logging
    }

    start() {
        if (this._timer) return;
        logger.info('[PayoutBatchWorker] starting (interval configured via GlobalSettings.autoPayoutIntervalMs).');
        // Initial tick after 10s (let other services boot), then read interval from DB
        this._scheduleNext(10_000);
    }

    stop() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }

    /**
     * Public method for manual trigger from admin endpoint.
     * Runs one batch cycle regardless of the autoPayoutEnabled flag.
     * Returns a summary of what was processed/flagged.
     */
    async processNow({ force = false } = {}) {
        const settings = await this._getSettings();
        if (!settings) {
            return { success: false, message: 'GlobalSettings not found.' };
        }

        if (!force && !settings.autoPayoutEnabled) {
            return {
                success: false,
                message: 'Auto-payout is disabled. Pass force=true to override.',
                autoPayoutEnabled: false
            };
        }

        return await this._processBatch(settings, { isManualTrigger: true });
    }

    _scheduleNext(delayMs) {
        this._timer = setTimeout(async () => {
            await this._tick().catch(err => {
                logger.error({ err: err }, '[PayoutBatchWorker] tick error');
            });
            const nextDelay = this._lastIntervalMs || DEFAULT_INTERVAL_MS;
            this._scheduleNext(nextDelay);
        }, delayMs);
    }

    async _tick() {
        if (this._running) return;
        this._running = true;

        try {
            const settings = await this._getSettings();
            if (!settings) return;

            this._lastIntervalMs = settings.autoPayoutIntervalMs || DEFAULT_INTERVAL_MS;

            if (!settings.autoPayoutEnabled) {
                if (this._lastEnabledState !== false) {
                    logger.info('[PayoutBatchWorker] auto-payout DISABLED — sleeping.');
                    this._lastEnabledState = false;
                }
                return;
            }

            if (this._lastEnabledState !== true) {
                logger.info('[PayoutBatchWorker] auto-payout ENABLED — processing.');
                this._lastEnabledState = true;
            }

            await this._processBatch(settings, { isManualTrigger: false });
        } finally {
            this._running = false;
        }
    }

    /**
     * Resolve the transaction already created by financeService.processFiatWithdrawal.
     * Prefer the durable Withdrawal.transactionHistoryId bridge when the additive
     * migration exists. Fall back only when exactly one PENDING fiat transaction
     * matches the withdrawal identity. Ambiguity is never auto-dispatched.
     */
    async _findCanonicalTransaction(withdrawal) {
        if (typeof this.prisma.$queryRawUnsafe === 'function') {
            try {
                const linkedRows = await this.prisma.$queryRawUnsafe(
                    'SELECT "transactionHistoryId" FROM "Withdrawal" WHERE "id" = $1 LIMIT 1',
                    withdrawal.id
                );
                const linkedId = linkedRows?.[0]?.transactionHistoryId;
                if (linkedId) {
                    const linked = await this.prisma.transactionHistory.findUnique({ where: { id: linkedId } });
                    if (linked) return { row: linked, ambiguous: false };
                }
            } catch (err) {
                logger.warn({ err, withdrawalId: withdrawal.id }, '[PayoutBatchWorker] durable transaction link unavailable');
            }
        }

        const createdAt = withdrawal.createdAt instanceof Date
            ? withdrawal.createdAt
            : new Date(withdrawal.createdAt);
        if (Number.isNaN(createdAt.getTime())) {
            return { row: null, ambiguous: false };
        }

        // r17 P0 identity guard: a withdrawal that OWNS its own obligation
        // (durable relation sourceEntity='withdrawal', e.g. the wallet
        // reservation path) has its own economic identity and must never
        // adopt — let alone dispatch — a fiat canonical reservation that
        // belongs to a different withdrawal. Refuse the guess.
        const ownObligation = await restrictedObligations.findActiveForSource(this.prisma, 'withdrawal', withdrawal.id);
        if (ownObligation) {
            return { row: null, ambiguous: false };
        }

        const txRowsRaw = await this.prisma.transactionHistory.findMany({
            where: {
                userId: withdrawal.userId,
                type: 'WITHDRAWAL_FIAT',
                amountUsdc: withdrawal.amount,
                status: 'PENDING',
                createdAt: {
                    gte: new Date(createdAt.getTime() - 5_000),
                    lte: new Date(createdAt.getTime() + 5_000)
                }
            },
            orderBy: { createdAt: 'desc' },
            take: 10
        });
        // r17 P0: the guessed match may only adopt a GENUINELY ORPHAN
        // canonical — not one durably linked to another Withdrawal row via
        // the bridge. Dispatching a linked canonical here would pay one
        // withdrawal's reservation under another withdrawal's mirror.
        const txRows = await this._excludeBridgeLinked(txRowsRaw);

        if (txRows.length !== 1 || !txRows[0]?.txHash) {
            return { row: null, ambiguous: txRows.length > 1 };
        }

        return { row: txRows[0], ambiguous: false };
    }

    /**
     * r17 P0 — drop candidate canonical rows durably linked to ANY Withdrawal
     * row via the transactionHistoryId bridge. The guessed amount±5s
     * fallback may only ever adopt an ORPHAN (pre-bridge legacy) row.
     */
    async _excludeBridgeLinked(candidates) {
        if (!Array.isArray(candidates) || candidates.length === 0) return [];
        if (typeof this.prisma.$queryRawUnsafe !== 'function') return candidates;
        const ids = candidates.map((c) => c.id);
        const linked = await this.prisma.$queryRawUnsafe(
            'SELECT "transactionHistoryId" FROM "Withdrawal" WHERE "transactionHistoryId" = ANY($1::text[])',
            ids
        );
        const linkedSet = new Set((linked || []).map((r) => r.transactionHistoryId));
        return candidates.filter((c) => !linkedSet.has(c.id));
    }

    async _processBatch(settings, { isManualTrigger = false } = {}) {
        const maxAmount = Number(settings.autoPayoutMaxAmountUsdc) || 200;
        const threshold = Number(settings.autoPayoutThresholdUsdc) || 500;

        const globalSettings = await this.prisma.globalSettings.findUnique({ where: { id: 1 } });
        const liveRate = globalSettings ? Number(globalSettings.liveRetailRate) : 12.5;

        // §P.5-D PER-ROW REGIME: the liquidity regime follows the RECORDED
        // row, never the current global flag. A FiatLiquidityReservation for
        // the withdrawal's canonical reference IS the authority regime for
        // that row; its exact reserved amountGhs is the authoritative payout
        // amount and a later rate change must not mutate it. A row without a
        // reservation predates §P.5-D and keeps the legacy SystemFiatPool
        // regime (compatibility/legacy projection ONLY — never an authority
        // input) even when the flag is ON. The flag only governs whether NEW
        // withdrawals create reservations; it never rewrites the meaning of
        // historical rows.
        //
        // The legacy pool is read LAZILY — only when the first legacy row of
        // the batch actually needs it. Authority-reserved processing never
        // reads SystemFiatPool at all.
        let runningPoolBalance = null; // legacy regime gauge (USDC projection); null = no legacy row read it yet
        const ensureLegacyPool = async () => {
            if (runningPoolBalance === null) {
                const fiatPool = await this.prisma.systemFiatPool.findUnique({ where: { id: 1 } });
                runningPoolBalance = fiatPool ? Number(fiatPool.balance) : 0;
            }
            return runningPoolBalance;
        };

        const pendingWithdrawals = await this.prisma.withdrawal.findMany({
            where: {
                status: 'PENDING',
                OR: [
                    { payoutMethod: { contains: 'MOMO' } },
                    { payoutMethod: { contains: 'momo' } },
                    { payoutMethod: 'MTN_MOMO' },
                    { payoutMethod: 'MOBILE_MONEY' },
                    { payoutMethod: 'FIAT' }
                ]
            },
            include: {
                user: {
                    select: { id: true, username: true, email: true, phoneNumber: true }
                }
            },
            orderBy: { createdAt: 'asc' },
            take: MAX_BATCH_SIZE
        });

        if (pendingWithdrawals.length === 0) {
            return {
                success: true,
                message: 'No pending fiat withdrawals to process.',
                processed: 0,
                flagged: 0,
                poolBalance: null // legacy projection unread — no rows processed
            };
        }

        const results = {
            processed: [],
            flaggedManualReview: [],
            unknownOutcome: [],
            errors: []
        };

        for (const withdrawal of pendingWithdrawals) {
            const amount = Number(withdrawal.amount);

            if (amount > maxAmount) {
                await this._flagForManualReview(withdrawal, 'AMOUNT_EXCEEDS_THRESHOLD', {
                    amount,
                    maxAmount,
                    message: `Withdrawal $${amount} exceeds auto-approve max ($${maxAmount})`
                });
                results.flaggedManualReview.push({ id: withdrawal.id, reason: 'AMOUNT_EXCEEDS_THRESHOLD', amount });
                continue;
            }

            const canonical = await this._findCanonicalTransaction(withdrawal);
            if (!canonical.row) {
                const reason = canonical.ambiguous
                    ? 'AMBIGUOUS_TRANSACTION_REFERENCE'
                    : 'MISSING_TRANSACTION_REFERENCE';
                await this._flagForManualReview(withdrawal, reason, {
                    amount,
                    message: 'Auto-payout refused because the canonical pending withdrawal transaction could not be identified uniquely.'
                });
                results.flaggedManualReview.push({ id: withdrawal.id, reason, amount });
                continue;
            }

            const recipientPhone = withdrawal.destination;
            if (!recipientPhone || recipientPhone === 'OLD_RECORD') {
                await this._flagForManualReview(withdrawal, 'MISSING_RECIPIENT_PHONE', {
                    amount,
                    message: 'No recipient phone number on withdrawal record'
                });
                results.flaggedManualReview.push({ id: withdrawal.id, reason: 'MISSING_RECIPIENT_PHONE', amount });
                continue;
            }

            // §P.5-D PER-ROW REGIME: the recorded row decides the regime.
            // The reservation committed by processFiatWithdrawal at
            // withdrawal-creation time IS the authority record; a row
            // without one is a genuine legacy payout and keeps the legacy
            // pool policy even when the flag is ON. The flag never
            // converts a historical row into an authority reservation and
            // the worker NEVER creates a reservation itself.
            const referenceId = String(canonical.row.txHash);
            const reservation = await this.prisma.fiatLiquidityReservation.findUnique({
                where: { reference: referenceId }
            });
            const authorityRecorded = reservation != null;

            if (authorityRecorded) {
                // Authority regime: the payout's exact GHS was ALREADY
                // claimed atomically from FiatLiquidityState.availableGhs at
                // reservation time, so dispatching it consumes NO further
                // available liquidity — the RESERVED → IN_TRANSIT transition
                // moves reservedGhs to inTransitGhs and never touches
                // availableGhs. This gate is therefore purely an OPERATIONAL
                // POLICY (hold back payouts once remaining headroom drops
                // below the configured floor), evaluated in GHS against
                // FiatLiquidityState — never against the legacy USDC pool.
                // It is NOT a capacity claim for this payout: a second
                // availableGhs-vs-withdrawalGhs comparison would double-count
                // the already-reserved amount and could false-hold a fully
                // reserved, fully backed payout.
                const liqState = await this.prisma.fiatLiquidityState.findUnique({ where: { id: 1 } });
                const remainingLiquidityGhs = liqState
                    ? new Prisma.Decimal(liqState.availableGhs)
                    : new Prisma.Decimal(0);
                // Exact pesewa conversion of the USDC-configured threshold.
                // The live rate is used ONLY for this operational threshold
                // comparison — it never mutates the economic amount of an
                // existing reservation.
                const thresholdGhs = fiatLiquidity.toExactGhsDecimal(
                    new Prisma.Decimal(threshold).times(liveRate).toFixed(2)
                );
                if (remainingLiquidityGhs.lt(thresholdGhs)) {
                    await this._flagForManualReview(withdrawal, 'AUTHORITY_HEADROOM_BELOW_THRESHOLD', {
                        amount,
                        availableGhs: remainingLiquidityGhs.toString(),
                        thresholdGhs: thresholdGhs.toString(),
                        message: `Operational hold: remaining authoritative GHS liquidity (${remainingLiquidityGhs.toFixed(2)}) below the configured payout floor (${thresholdGhs.toFixed(2)})`
                    });
                    results.flaggedManualReview.push({ id: withdrawal.id, reason: 'AUTHORITY_HEADROOM_BELOW_THRESHOLD', amount, availableGhs: remainingLiquidityGhs.toString() });
                    continue;
                }
            } else {
                // Legacy regime (recorded row predates §P.5-D — no
                // reservation row): preserve the historical SystemFiatPool
                // pool/threshold policy. SystemFiatPool is a compatibility /
                // legacy projection ONLY and is never an authority input.
                const poolBalanceNow = await ensureLegacyPool();
                if (poolBalanceNow < threshold || poolBalanceNow < amount) {
                    await this._flagForManualReview(withdrawal, 'INSUFFICIENT_POOL_LIQUIDITY', {
                        amount,
                        poolBalance: poolBalanceNow,
                        threshold,
                        message: `Fiat pool ($${poolBalanceNow.toFixed(2)}) below threshold ($${threshold}) or insufficient for $${amount}`
                    });
                    results.flaggedManualReview.push({ id: withdrawal.id, reason: 'INSUFFICIENT_POOL_LIQUIDITY', amount, poolBalance: poolBalanceNow });
                    continue;
                }
            }

            // Claim the withdrawal before any provider I/O. Multiple worker
            // instances may read the same PENDING row; only one can transition
            // it to PROCESSING. If the process dies after this point, the
            // reconciliation worker can safely resume from PROCESSING using the
            // canonical provider reference.
            const claim = await this.prisma.withdrawal.updateMany({
                where: { id: withdrawal.id, status: 'PENDING' },
                data: { status: 'PROCESSING' }
            });
            if (claim.count !== 1) {
                results.errors.push({ id: withdrawal.id, reason: 'WITHDRAWAL_ALREADY_CLAIMED' });
                continue;
            }

            try {
                // §P.5-D EXACT RESERVED AMOUNT: for an authority-recorded
                // withdrawal the provider is paid EXACTLY what
                // processFiatWithdrawal durably reserved at creation time —
                // the current live rate must NEVER mutate the GHS amount of
                // an existing reservation. Only genuine legacy rows convert
                // USDC → GHS at the current live rate, as they always did.
                const amountGhs = authorityRecorded
                    ? parseFloat(new Prisma.Decimal(reservation.amountGhs).toFixed(2))
                    : parseFloat((amount * liveRate).toFixed(2));

                const dispatchResult = await this.mtn.initiateTransfer({
                    referenceId,
                    amountGhs,
                    recipientPhone,
                    network: withdrawal.network || 'MTN',
                    externalId: `auto_payout_${withdrawal.id}`,
                    payerMessage: 'Azaman withdrawal',
                    payeeNote: `Payout #${withdrawal.id} (${withdrawal.network || 'MTN'})`
                });

                // §P.5-D OUTBOUND EVIDENCE + dispatch claim. The provider has
                // ACCEPTED the payout — cash is already moving. If the durable
                // evidence or the IN_TRANSIT claim fails here, the money CANNOT
                // be recalled by silently swallowing the failure, and it also
                // must NOT be auto-refunded (the provider will still pay it out
                // — a refund would double-spend). The withdrawal is flagged for
                // manual review with the failure retained as an exception row;
                // the reservation stays RESERVED (funds held, not spendable).
                // r15 follow-up (audit P0): the ACTUAL provider that accepted
                // this payout (dispatchResult._provider — the PaymentFailover
                // tag, e.g. 'mtn' after a moolre → mtn failover) is persisted
                // durably into the canonical TransactionHistory metadata
                // (payoutProvider) so the reconciliation worker queries the
                // OWNER rail only, and the evidence records name the real
                // provider, never a hardcoded rail.
                // r15 hardening (audit P0, 2026-09-20): derive the ACTUAL
                // accepting provider's identity from dispatch facts ONLY —
                // never a hardcoded rail fallback. The failover tag is the
                // authority; the accepting adapter's own self-identification
                // (dispatchResult.provider — both adapters report it) is the
                // direct-adapter identity. NO identity at all is FAIL-CLOSED.
                const actualProviderTag = dispatchResult?._provider || null;
                const tagCanonicalName = actualProviderTag ? canonicalProviderName(actualProviderTag) : null;
                const actualProviderName = tagCanonicalName
                    || (dispatchResult?.provider ? String(dispatchResult.provider).toUpperCase() : null);

                if (!actualProviderName) {
                    logger.error({ referenceId, withdrawalId: withdrawal.id },
                        '[payoutBatchWorker] CRITICAL: accepted dispatch carries NO provider identity — parking, never guessing a rail');
                    await this._flagForManualReview(withdrawal, 'DISPATCH_IDENTITY_UNKNOWN', {
                        amount, referenceId,
                        message: 'Auto-payout dispatched but the accepting provider identity could not be determined — manual review required.'
                    });
                    await this._recordDurableException(withdrawal, 'DISPATCH_IDENTITY_UNKNOWN', {
                        dispatched: true,
                        referenceId,
                        message: 'accepted dispatch carries no provider identity',
                    });
                    results.errors.push({ id: withdrawal.id, reason: 'DISPATCH_IDENTITY_UNKNOWN', referenceId });
                    continue;
                }

                if (tagCanonicalName && dispatchResult?.provider
                        && String(dispatchResult.provider).toUpperCase() !== tagCanonicalName) {
                    logger.error({ referenceId, withdrawalId: withdrawal.id, tagCanonicalName, selfIdentified: dispatchResult.provider },
                        '[payoutBatchWorker] CRITICAL: dispatch identity contradiction — parking, never guessing a rail');
                    await this._flagForManualReview(withdrawal, 'DISPATCH_IDENTITY_CONTRADICTION', {
                        amount, referenceId,
                        message: 'Auto-payout dispatched but the accepting provider identity is contradictory — manual review required.'
                    });
                    await this._recordDurableException(withdrawal, 'DISPATCH_IDENTITY_CONTRADICTION', {
                        dispatched: true,
                        referenceId,
                        failoverTag: actualProviderTag,
                        tagCanonicalName,
                        selfIdentifiedProvider: dispatchResult?.provider ? String(dispatchResult.provider) : null,
                    });
                    results.errors.push({ id: withdrawal.id, reason: 'DISPATCH_IDENTITY_CONTRADICTION', referenceId });
                    continue;
                }

                // r15 hardening (audit P0, 2026-09-20): ORDERED post-dispatch
                // bookkeeping. The durable dispatch observation is written
                // FIRST — it is the fallback authority reconciliation uses to
                // recover the owner when the canonical ownership write fails
                // after the provider already accepted the money.
                try {
                    await fiatLiquidity.recordProviderEvent(this.prisma, {
                        provider: actualProviderName,
                        rail: 'MOMO',
                        direction: 'OUTBOUND',
                        status: String(dispatchResult?.status || 'DISPATCH_ACCEPTED'),
                        providerRef: dispatchResult?.data?.reference || dispatchResult?.providerRef || null,
                        dedupKey: `event:payout-dispatch:${actualProviderName}:${referenceId}`,
                        amountGhs,
                        relatedReference: referenceId,
                        raw: { externalId: `auto_payout_${withdrawal.id}`, recipientPhone, network: withdrawal.network || 'MTN', actualProvider: actualProviderTag },
                    });
                } catch (evidenceErr) {
                    // The dispatch observation IS the fallback owner
                    // authority; its failure leaves no durable owner
                    // knowledge. Park for manual review — the payout is in
                    // flight, so NEVER auto-refund.
                    logger.error({ err: evidenceErr, referenceId },
                        '[payoutBatchWorker] §P.5-D post-dispatch dispatch evidence failed — flagging for manual review (NO auto-refund after a real dispatch)');
                    await this._flagForManualReview(withdrawal, 'POST_DISPATCH_BOOKKEEPING_FAILED', {
                        amount,
                        referenceId,
                        error: evidenceErr.message
                    });
                    await this._recordDurableException(withdrawal, 'POST_DISPATCH_BOOKKEEPING_FAILED', {
                        stage: 'DISPATCH_EVIDENCE',
                        provider: actualProviderName,
                        referenceId,
                        error: evidenceErr.message,
                    });
                    results.errors.push({ id: withdrawal.id, reason: 'POST_DISPATCH_BOOKKEEPING_FAILED', referenceId });
                    continue;
                }

                if (actualProviderTag) {
                    try {
                        await persistPayoutOwnership(this.prisma, {
                            reference: referenceId,
                            failoverTag: actualProviderTag,
                            intendedProvider: 'MOOLRE_DISBURSEMENT',
                            providerRef: dispatchResult?.data?.reference || dispatchResult?.providerRef || null,
                        });
                    } catch (ownershipErr) {
                        // The canonical ownership write failed AFTER the
                        // provider accepted. The dispatch observation above
                        // durably names the owner, so reconciliation recovers
                        // the identity from evidence and the payout stays
                        // protected. Keep the withdrawal scannable (NO
                        // NEEDS_MANUAL_REVIEW flag — that would strand it
                        // from auto-recovery); record the failure loudly as
                        // a durable exception row instead.
                        logger.error({ err: ownershipErr, referenceId, code: ownershipErr.code },
                            '[payoutBatchWorker] canonical payout ownership write failed after dispatch acceptance — evidence retains the owner, NOT flagging out of auto-recovery');
                        try {
                            await recordReconciliationException(this.prisma, {
                                entityType: 'WITHDRAWAL',
                                entityId: String(withdrawal.id),
                                reference: referenceId,
                                reason: 'POST_DISPATCH_OWNERSHIP_WRITE_FAILED',
                                details: {
                                    provider: actualProviderName,
                                    failoverTag: actualProviderTag,
                                    code: ownershipErr.code || null,
                                    error: ownershipErr.message,
                                },
                            });
                        } catch (excErr) {
                            logger.error({ err: excErr, referenceId },
                                '[payoutBatchWorker] failed to record the ownership-write-failure exception');
                        }
                    }
                }

                try {
                    await fiatLiquidity.inTransitIfRecorded(this.prisma, {
                        reference: referenceId,
                        providerRef: dispatchResult?.data?.reference || dispatchResult?.providerRef || null,
                    });
                } catch (inTransitErr) {
                    logger.error({ err: inTransitErr, referenceId },
                        '[payoutBatchWorker] §P.5-D post-dispatch IN_TRANSIT transition failed — flagging for manual review (NO auto-refund after a real dispatch)');
                    await this._flagForManualReview(withdrawal, 'POST_DISPATCH_BOOKKEEPING_FAILED', {
                        amount,
                        referenceId,
                        error: inTransitErr.message
                    });
                    await this._recordDurableException(withdrawal, 'POST_DISPATCH_BOOKKEEPING_FAILED', {
                        stage: 'IN_TRANSIT',
                        provider: actualProviderName,
                        referenceId,
                        error: inTransitErr.message,
                    });
                    results.errors.push({ id: withdrawal.id, reason: 'POST_DISPATCH_BOOKKEEPING_FAILED', referenceId });
                    continue;
                }

                // Track remaining liquidity in the row's regime unit.
                // Authority-recorded rows: NO gauge decrement — the GHS was
                // already removed from availableGhs at reservation time and
                // IN_TRANSIT moves reservedGhs → inTransitGhs without
                // touching availableGhs. Legacy rows keep the historical
                // USDC pool projection gauge.
                if (!authorityRecorded) {
                    runningPoolBalance -= amount;
                }

                results.processed.push({
                    id: withdrawal.id,
                    amount,
                    amountGhs,
                    referenceId,
                    network: withdrawal.network || 'MTN',
                    mtnStatus: dispatchResult.status,
                    provider: actualProviderName,
                    providerFailoverTag: actualProviderTag
                });

                logger.info(`[PayoutBatchWorker] dispatched withdrawal #${withdrawal.id}: $${amount} → GHS ${amountGhs} (network: ${withdrawal.network || 'MTN'}, ref: ${referenceId})`);
            } catch (dispatchErr) {
                logger.error(`[PayoutBatchWorker] provider dispatch failed for withdrawal #${withdrawal.id}:`, dispatchErr.message);

                // P0 unknown-outcome semantics: once PENDING -> PROCESSING is
                // claimed and provider I/O has begun, a thrown error is NOT
                // automatically a rejection. The request may already have
                // reached MTN (client timeout after transmission, connection
                // reset, ambiguous 5xx gateway response). Only errors the
                // adapter classifies as NOT_DISPATCHED (provider provably
                // never invoked) or DEFINITIVE_REJECTION (provider explicitly
                // refused) are safe to move out of the pipeline — anything
                // else, including UNCLASSIFIED errors from other adapters, is
                // conservatively UNKNOWN and must stay in PROCESSING, the
                // durable "provider outcome unresolved" state the
                // WithdrawalReconciliationWorker scans (PENDING+PROCESSING)
                // and settles or reverses by polling getTransferStatus(ref).
                // Blindly flagging NEEDS_MANUAL_REVIEW here would strand an
                // ambiguous live payout outside normal reconciliation.
                const outcome = dispatchErr && dispatchErr.providerOutcome;
                if (outcome === 'NOT_DISPATCHED' || outcome === 'DEFINITIVE_REJECTION') {
                    await this._flagForManualReview(withdrawal, 'DISBURSEMENT_DISPATCH_FAILED', {
                        amount,
                        error: dispatchErr.message,
                        message: `Disbursement dispatch failed: ${dispatchErr.message}`
                    });
                    results.flaggedManualReview.push({ id: withdrawal.id, reason: 'DISBURSEMENT_DISPATCH_FAILED', amount, error: dispatchErr.message });
                    continue;
                }

                // UNKNOWN provider outcome — leave the withdrawal in PROCESSING
                // (already claimed above) for the reconciliation worker. The
                // batch legacy pool gauge treats the funds as in flight, same
                // as a successful dispatch, so the rest of the batch cannot
                // over-dispatch the remaining pool headroom. Authority-
                // recorded rows have no batch gauge to decrement.
                if (!authorityRecorded) {
                    runningPoolBalance -= amount;
                }
                results.unknownOutcome.push({
                    id: withdrawal.id,
                    amount,
                    reason: 'DISBURSEMENT_OUTCOME_UNKNOWN',
                    providerOutcome: outcome || 'UNKNOWN_OUTCOME',
                    error: dispatchErr.message
                });
            }
        }

        const summary = {
            success: true,
            message: `Batch complete: ${results.processed.length} dispatched, ${results.flaggedManualReview.length} flagged for review, ${results.unknownOutcome.length} pending provider reconciliation.`,
            processed: results.processed.length,
            flagged: results.flaggedManualReview.length,
            unknownOutcome: results.unknownOutcome.length,
            // poolBalance is the LEGACY SystemFiatPool projection gauge
            // (USDC), null when no legacy row was processed. It is NOT
            // authoritative GHS liquidity — under §P.5-D the authority
            // figure lives in FiatLiquidityState and is never projected
            // here.
            poolBalance: runningPoolBalance,
            details: isManualTrigger ? results : undefined
        };

        if (results.flaggedManualReview.length > 0 && this.io) {
            this.io.emit('admin_alert', {
                type: 'PAYOUTS_NEED_MANUAL_REVIEW',
                count: results.flaggedManualReview.length,
                items: results.flaggedManualReview,
                timestamp: new Date().toISOString()
            });
        }

        // Observability for ambiguous dispatches: the funds may be in flight
        // at the provider. The withdrawal stays PROCESSING and reconciliation
        // owns the outcome — this alert only tells admins a payout is being
        // reconciled, it does NOT request manual state changes.
        if (results.unknownOutcome.length > 0 && this.io) {
            this.io.emit('admin_alert', {
                type: 'PAYOUTS_PENDING_PROVIDER_RECONCILIATION',
                count: results.unknownOutcome.length,
                items: results.unknownOutcome,
                timestamp: new Date().toISOString()
            });
        }

        return summary;
    }

    // r15 hardening: record the durable exception row that the
    // reconciliation worker's ownership guard reads to refuse cross-rail
    // guessing on a dispatched payout whose owner bookkeeping failed.
    // Best effort — the NEEDS_MANUAL_REVIEW flag from _flagForManualReview
    // keeps the payout parked even if this write fails.
    async _recordDurableException(withdrawal, reason, details = {}) {
        try {
            await recordReconciliationException(this.prisma, {
                entityType: 'WITHDRAWAL',
                entityId: String(withdrawal.id),
                reference: details.referenceId || null,
                reason,
                details,
            });
        } catch (excErr) {
            logger.error({ err: excErr, reason },
                '[payoutBatchWorker] failed to record the durable reconciliation exception');
        }
    }

    async _flagForManualReview(withdrawal, reason, metadata = {}) {
        try {
            await this.prisma.withdrawal.update({
                where: { id: withdrawal.id },
                data: { status: 'NEEDS_MANUAL_REVIEW' }
            });

            if (this.notificationService) {
                await this.notificationService.sendNotification({
                    userId: withdrawal.userId,
                    title: 'Withdrawal Under Review',
                    message: 'Your withdrawal is being reviewed by our team. This usually takes less than 24 hours.',
                    type: 'WITHDRAWAL_REVIEW',
                    category: 'GENERAL'
                }).catch(() => {});
            }

            logger.info(`[PayoutBatchWorker] flagged withdrawal #${withdrawal.id} → NEEDS_MANUAL_REVIEW (${reason})`);
        } catch (err) {
            logger.error(`[PayoutBatchWorker] failed to flag withdrawal #${withdrawal.id}:`, err.message);
        }
    }

    async _getSettings() {
        try {
            return await this.prisma.globalSettings.findUnique({ where: { id: 1 } });
        } catch (err) {
            logger.error({ err: err }, '[PayoutBatchWorker] failed to read GlobalSettings');
            return null;
        }
    }
}

module.exports = PayoutBatchWorker;
