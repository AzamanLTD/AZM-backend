// services/finance.service.js
// =============================================================================
// AZAMAN V2 — FINANCE SERVICE   (Phase B v2: The Arbitrage Capture)
// Pure business-logic layer. No req/res. All multi-step DB writes are wrapped
// in a single prisma.$transaction block to guarantee ACID compliance.
// =============================================================================

const logger = require('../src/config/logger');
const { runDoubleCheck } = require('../utils/securityCheck');
const { AZM_SPEND_SOURCES } = require('./azmSpendService');
const { Prisma } = require('@prisma/client'); // §P.4 exact ledger arithmetic
const { audit } = require('../utils/audit');

const EXIT_FEE_PERCENT        = 0.02;
const FIAT_POOL_ALERT_THRESH  = 5_000;

const _ensureProfitFeesSingleton = async (tx) =>
    tx.systemProfitFees.upsert({ where: { id: 1 }, update: {}, create: { id: 1, balance: 0.0 } });

const _ensureFiatPoolSingleton = async (tx) =>
    tx.systemFiatPool.upsert({ where: { id: 1 }, update: {}, create: { id: 1, balance: 0.0 } });

const _ensureMasterCryptoSingleton = async (tx) =>
    tx.systemMasterCrypto.upsert({ where: { id: 1 }, update: {}, create: { id: 1, balance: 0.0 } });

const _resolveReferrer = async (prisma, userId) => {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { referredByCode: true } });
    if (!user?.referredByCode) return null;
    return prisma.user.findFirst({
        where: { influencerCode: user.referredByCode },
        select: { id: true, username: true }
    });
};

const _isDeferredWithdrawal = (transaction) =>
    transaction?.metadata && transaction.metadata.economicsDeferred === true;

const _resolveFiatRetailRate = (settings, opts = {}) => {
    const explicit = Number(opts.retailRate);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const canonical = Number(settings?.liveRetailRate);
    if (Number.isFinite(canonical) && canonical > 0) return canonical;
    const compatibility = Number(settings?.liveUsdToGhs);
    return Number.isFinite(compatibility) && compatibility > 0 ? compatibility : 0;
};

/**
 * Atomically reserve fiat liquidity. The conditional update is the actual
 * concurrency guard; a preflight read alone is not sufficient because two
 * withdrawals can observe the same available balance before either commits.
 */
const _reserveFiatPool = async (tx, amountFloat) => {
    const claim = await tx.systemFiatPool.updateMany({
        where: { id: 1, balance: { gte: amountFloat } },
        data: { balance: { decrement: amountFloat } },
    });

    if (claim.count !== 1) {
        const err = new Error(
            'MoMo payouts are temporarily at capacity. Your USDC has not been deducted. ' +
            'Please try again in a few minutes or contact support.'
        );
        err.code = 'FIAT_POOL_INSUFFICIENT';
        throw err;
    }
};

/**
 * Atomically debit a customer balance. The predicate makes the balance
 * reservation concurrency-safe; a stale snapshot cannot authorize a second
 * withdrawal once the first one has consumed the available funds.
 */
const _debitUserBalance = async (tx, userId, amount) => {
    const claim = await tx.user.updateMany({
        where: { id: userId, availableBalance: { gte: amount } },
        data: { availableBalance: { decrement: amount } },
    });

    if (claim.count !== 1) {
        const err = new Error('Insufficient USDC balance. Your available balance changed; please retry.');
        err.code = 'INSUFFICIENT_BALANCE';
        throw err;
    }
};

const ledger = require('./ledgerService'); // §P.4 authoritative ledger
const restrictedObligations = require('./restrictedObligationService'); // §P.4 persisted restricted obligations
const fiatLiquidity = require('../src/services/fiatLiquidityService'); // §P.5-D GHS liquidity authority

const processFiatWithdrawal = async (prisma, userId, amountFloat, opts = {}) => {
    await runDoubleCheck(prisma, userId);
    const liquidityAuthorityOn = await fiatLiquidity.isAuthorityEnabled(prisma);
    const referrer = await _resolveReferrer(prisma, userId);

    const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { withdrawalRiskTier: true } });

    let effectiveExitFeePct = EXIT_FEE_PERCENT;
    if (settings) {
        const riskTier = user?.withdrawalRiskTier || 'STANDARD';
        const riskMap = settings.withdrawalFeeByRiskTier || {};
        const parsedRiskMap = typeof riskMap === 'string' ? JSON.parse(riskMap) : riskMap;
        if (parsedRiskMap[riskTier] !== undefined) {
            effectiveExitFeePct = Number(parsedRiskMap[riskTier]);
        } else {
            effectiveExitFeePct = Number(settings.fiatWithdrawalFeePct ?? settings.baseExitFeePct ?? EXIT_FEE_PERCENT);
        }
    }

    const discountMult = Math.min(1.0, Math.max(0, Number(opts.feeDiscountMultiplier) || 0));
    const rawExitFee  = amountFloat * effectiveExitFeePct;
    const exitFee     = parseFloat((rawExitFee * (1 - discountMult)).toFixed(6));
    const halfFee     = parseFloat((exitFee / 2).toFixed(6));
    const totalDeduct = parseFloat((amountFloat + exitFee).toFixed(6));

    const reference = opts.reference || `FIAT_OUT_${userId}_${Date.now()}`;
    const retailRate = _resolveFiatRetailRate(settings, opts);
    const payoutGhs  = retailRate > 0 ? parseFloat((amountFloat * retailRate).toFixed(2)) : 0;
    const rateSource = settings?.liveRetailRate && Number(settings.liveRetailRate) > 0
        ? (settings.liveRateSource || 'KOTANI_PAY')
        : (settings?.liveRateSource || 'LEGACY_COMPATIBILITY');
    // True external observation timestamp for payout metadata (issue #271 /
    // PR 271B): prefer lastExternalSync so the recorded provenance never
    // inherits a MOCK-echo or admin-fabricated stamp.
    const rateAsOf = settings?.lastExternalSync || settings?.lastRateSync || new Date();

    if (!(retailRate > 0) || !(payoutGhs > 0)) {
        const err = new Error('Current USDC/GHS retail exchange rate is unavailable. No fiat payout was created.');
        err.code = 'FIAT_RATE_UNAVAILABLE';
        throw err;
    }

    // §P.5-D preflight split: with the liquidity authority OFF, the legacy
    // SystemFiatPool (a USDC-unit scalar in that mode) preflight stays
    // byte-identical. With the authority ON, SystemFiatPool is only a
    // derived GHS projection — comparing it against a USDC amount here is
    // unit-nonsense that could false-reject or false-admit a withdrawal on
    // stale/legacy data. The authoritative liquidity decision is the atomic
    // fiatLiquidity.reserveForPayout() claim inside the transaction below,
    // which fails closed (FIAT_POOL_INSUFFICIENT, identical user-facing
    // message) and rolls back the user debit when the exact payoutGhs
    // cannot be claimed from FiatLiquidityState.availableGhs.
    if (!liquidityAuthorityOn) {
        const fiatPool = await prisma.systemFiatPool.findUnique({ where: { id: 1 } });
        if (!fiatPool || Number(fiatPool.balance) < amountFloat) {
            const err = new Error(
                'MoMo payouts are temporarily at capacity. Your USDC has not been deducted. ' +
                'Please try again in a few minutes or contact support.'
            );
            err.code = 'FIAT_POOL_INSUFFICIENT';
            throw err;
        }
    }

    const result = await prisma.$transaction(async (tx) => {
        const liveUser = await tx.user.findUnique({ where: { id: userId } });
        if (!liveUser) throw new Error('User not found.');

        if (liveUser.availableBalance < totalDeduct) {
            const err = new Error(
                `Insufficient balance. Required: ${totalDeduct} USDC ` +
                `(amount + exit fee), available: ${liveUser.availableBalance.toFixed(6)} USDC.`
            );
            err.code = 'INSUFFICIENT_BALANCE';
            throw err;
        }

        // §P.5-D: with the liquidity authority flag ON, the withdrawal
        // reserves claimable GHS through the evidence-backed authority
        // (exact pesewas; SystemFiatPool becomes its derived projection).
        // With the flag OFF, the legacy SystemFiatPool conditional decrement
        // stays byte-identical. A claim loser rolls back this whole
        // transaction (user debit included) either way.
        if (!liquidityAuthorityOn) {
            await _reserveFiatPool(tx, amountFloat);
        }
        await _debitUserBalance(tx, userId, totalDeduct);

        // P0 atomicity: the AZM fee-discount debit runs on the SAME tx as the
        // fiat pool reservation, USDC debit and the TransactionHistory row, so
        // a failed reservation can never leave a committed AZM spend behind.
        let azmFeeDiscount = null;
        if (typeof opts.reserveFeeDiscountInTransaction === 'function') {
            const r = await opts.reserveFeeDiscountInTransaction(tx);
            azmFeeDiscount = {
                tierId: r?.tierId ?? null,
                discount: r?.discount ?? null,
                azmSpent: Number(r?.azmSpent) || 0,
                newBalance: r?.newBalance ?? null,
                debited: r?.debited !== false
            };
        }

        // A PENDING provider payout is a reservation, not realized economics.
        // Keep the principal in master crypto, but defer referral rewards,
        // platform fee recognition and profit logs until provider SUCCESS.
        await _ensureProfitFeesSingleton(tx);
        await _ensureMasterCryptoSingleton(tx);
        await tx.systemMasterCrypto.update({
            where: { id: 1 },
            data: { balance: { increment: amountFloat } }
        });

        const txRecord = await tx.transactionHistory.create({
            data: {
                userId,
                type: 'WITHDRAWAL_FIAT',
                amountUsdc: amountFloat,
                feeUsdc: exitFee,
                txHash: reference,
                status: 'PENDING',
                metadata: {
                    economicsDeferred: true,
                    referrerId: referrer?.id ?? null,
                    referrerUsername: referrer?.username ?? null,
                    referrerShareUsdc: referrer ? halfFee : 0,
                    systemFeeShareUsdc: referrer ? halfFee : exitFee,
                    retailRate,
                    payoutGhs,
                    rateSource,
                    rateAsOf,
                    ratePair: 'USDC/GHS',
                    settlementCurrency: 'USDC',
                    displayCurrency: 'GHS',
                    azmFeeDiscount: azmFeeDiscount
                        ? {
                            tierId: azmFeeDiscount.tierId,
                            discount: azmFeeDiscount.discount,
                            azmSpent: azmFeeDiscount.azmSpent,
                            dedupKey: `fee_discount_${reference}`
                        }
                        : null,
                    // §P.4 marker: this row reserved customer funds through
                    // the authoritative ledger (restricted:reserves) — the
                    // settlement/reversal paths post their ledger legs for
                    // this row. Legacy rows (false) have NO ledger truth and
                    // are never given one retroactively (no backfill).
                    ledgerReserved: true
                }
            }
        });

        // r15 hardening (audit P0, 2026-09-20): the Withdrawal reconciliation
        // record is created INSIDE the same authoritative transaction as the
        // customer debit, the fiat-pool reservation and the canonical
        // TransactionHistory row — a committed fiat withdrawal can never
        // exist without a reconciliation worker record to discover it. If the
        // callback throws, the WHOLE reservation rolls back: no debit, no
        // canonical row, no provider I/O. The controller therefore cannot
        // reach provider dispatch with a financially-committed withdrawal
        // that has no reconciliation record.
        let withdrawalRecord = null;
        if (typeof opts.createWithdrawalRecordInTransaction === 'function') {
            try {
                withdrawalRecord = await opts.createWithdrawalRecordInTransaction(tx, txRecord);
            } catch (recordErr) {
                // r15 hardening: surface the reservation-record failure
                // distinctly — the ENTIRE reservation rolled back (no
                // debit, no canonical row, no provider I/O) and the client
                // must be told this is a server-side failure, not a
                // bad-request.
                recordErr.code = 'WITHDRAWAL_RECORD_CREATION_FAILED';
                throw recordErr;
            }
        }

        // §P.5-D authority reservation (flag ON): linked to the committed
        // TransactionHistory row. Conflicting reuse of the reference fails
        // closed; insufficient GHS rolls the whole transaction back.
        if (liquidityAuthorityOn) {
            const route = opts.liquidityRoute || {};
            await fiatLiquidity.reserveForPayout(tx, {
                reference,
                amountGhs: payoutGhs,
                provider: route.provider || 'MOOLRE_DISBURSEMENT',
                rail: route.rail || 'MOMO',
                destination: route.destination || null,
                relatedTransactionId: txRecord.id,
            });
        }

        // §P.4 AUTHORITATIVE ACCOUNTING — inside the SAME reservation
        // transaction as the USDC debit, the fiat-pool reservation and the
        // TransactionHistory row:
        //   D user:{id}:liability  — customer owed less (amount + exit fee)
        //   C restricted:reserves — funds reserved for the PENDING provider
        //                           payout; released ONLY on provider SUCCESS,
        //                           cancelled on definitive reversal
        const fiatReservation = await ledger.post(tx, {
            idempotencyKey: `ledger:withdrawal:fiat:${reference}`,
            entryType: 'WITHDRAWAL',
            description: 'Fiat (MoMo) withdrawal reservation — provider settlement pending',
            reference,
            userId,
            relatedEntity: 'transactionHistory',
            relatedEntityId: (await tx.transactionHistory.findUnique({ where: { txHash: reference } }))?.id ?? null,
            metadata: { status: 'PENDING', provider: 'MOOLRE_DISBURSEMENT', deferredEconomics: true },
            lines: [
                { account: `user:${userId}:liability`, debit: new Prisma.Decimal(String(totalDeduct)) },
                { account: 'restricted:reserves', credit: new Prisma.Decimal(String(totalDeduct)) },
            ],
        });
        await restrictedObligations.createForPendingWithdrawal(tx, {
            sourceType: 'PENDING_FIAT_WITHDRAWAL',
            reference: `withdrawal:fiat:${reference}`,
            userId,
            amount: new Prisma.Decimal(String(totalDeduct)),
            asset: 'USDC',
            sourceEntity: 'transactionHistory',
            sourceEntityId: reference,
            ledgerTransactionId: fiatReservation.transaction.id,
            domainStateRef: { principalUsdc: amountFloat, exitFeeUsdc: exitFee, payoutGhs },
        });

        const [profitFees, updatedFiatPool, masterCrypto, updatedUser] = await Promise.all([
            tx.systemProfitFees.findUnique({ where: { id: 1 } }),
            tx.systemFiatPool.findUnique({ where: { id: 1 } }),
            tx.systemMasterCrypto.findUnique({ where: { id: 1 } }),
            tx.user.findUnique({ where: { id: userId }, select: { availableBalance: true } })
        ]);

        return {
            user: updatedUser,
            txRecord,
            withdrawalRecord,
            profitFees,
            fiatPool: updatedFiatPool,
            masterCrypto,
            newUserBalance: updatedUser.availableBalance,
            azmFeeDiscount
        };
    });

    return {
        reference,
        withdrawalAmount: amountFloat,
        exitFee,
        totalDeducted: totalDeduct,
        retailRate,
        payoutGhs,
        rateSource,
        rateAsOf,
        ratePair: 'USDC/GHS',
        settlementCurrency: 'USDC',
        displayCurrency: 'GHS',
        feeSplit: referrer
            ? { referrerId: referrer.id, referrerUsername: referrer.username, referrerShare: halfFee, systemShare: halfFee }
            : { referrerId: null, referrerUsername: null, referrerShare: 0, systemShare: exitFee },
        newBalance: result.newUserBalance,
        systemFiatPool: result.fiatPool.balance,
        systemProfitFees: result.profitFees.balance,
        systemMasterCrypto: result.masterCrypto.balance,
        arbitrageCapture: amountFloat,
        transaction: result.txRecord,
        withdrawalRecord: result.withdrawalRecord,
        fiatPoolLow: result.fiatPool.balance < FIAT_POOL_ALERT_THRESH,
        fiatPoolBalance: result.fiatPool.balance,
        azmFeeDiscount: result.azmFeeDiscount
    };
};

/**
 * Authoritatively settle a provider-successful fiat withdrawal. New withdrawals
 * carry economicsDeferred=true, so fee/referral/profit recognition occurs only
 * after this PENDING -> COMPLETED claim succeeds. Legacy PENDING rows have no
 * marker because they already recognized economics at request time; those rows
 * are only transitioned and are never credited twice.
 */
const completeFiatWithdrawal = async (prisma, reference, { providerTxId = null } = {}) => {
    if (!reference) throw new Error('[completeFiatWithdrawal] reference is required.');

    const result = await prisma.$transaction(async (tx) => {
        const pending = await tx.transactionHistory.findUnique({ where: { txHash: reference } });
        if (!pending) {
            const err = new Error(`[completeFiatWithdrawal] No row with reference ${reference}.`);
            err.code = 'UNKNOWN_REFERENCE';
            throw err;
        }
        if (pending.type !== 'WITHDRAWAL_FIAT') {
            const err = new Error(`[completeFiatWithdrawal] Reference ${reference} is not a fiat withdrawal.`);
            err.code = 'WRONG_TRANSACTION_TYPE';
            throw err;
        }

        const claim = await tx.transactionHistory.updateMany({
            where: { txHash: reference, status: 'PENDING' },
            data: {
                status: 'COMPLETED',
                ...(providerTxId ? { providerRef: String(providerTxId) } : {})
            }
        });

        if (claim.count !== 1) {
            const current = await tx.transactionHistory.findUnique({ where: { txHash: reference } });
            return { changed: false, transaction: current };
        }

        if (_isDeferredWithdrawal(pending)) {
            const amountFloat = Number(pending.amountUsdc);
            const exitFee = Number(pending.feeUsdc);
            const metadata = pending.metadata || {};
            const referrerId = Number(metadata.referrerId) > 0 ? Number(metadata.referrerId) : null;
            const referrerShare = Math.max(0, Number(metadata.referrerShareUsdc) || 0);
            const systemShare = Math.max(0, Number(metadata.systemFeeShareUsdc) || 0);

            await _ensureProfitFeesSingleton(tx);

            if (referrerId && referrerShare > 0) {
                await tx.user.update({
                    where: { id: referrerId },
                    data: { availableBalance: { increment: referrerShare } }
                });
                await tx.systemProfitFees.update({
                    where: { id: 1 },
                    data: { balance: { increment: systemShare } }
                });
                await tx.adminProfitLog.createMany({
                    data: [
                        { amountUsdc: systemShare, source: 'EXIT_FEE', relatedTxId: `referral_split_system_${reference}` },
                        { amountUsdc: referrerShare, source: 'EXIT_FEE', relatedTxId: `referral_split_referrer_${referrerId}_${reference}` }
                    ]
                });
            } else {
                const realizedFee = systemShare > 0 ? systemShare : exitFee;
                await tx.systemProfitFees.update({
                    where: { id: 1 },
                    data: { balance: { increment: realizedFee } }
                });
                if (realizedFee > 0) {
                    await tx.adminProfitLog.create({
                        data: { amountUsdc: realizedFee, source: 'EXIT_FEE', relatedTxId: `full_fee_${reference}` }
                    });
                }
            }

            await tx.adminProfitLog.create({
                data: { amountUsdc: amountFloat, source: 'ARBITRAGE_SPREAD', relatedTxId: `arbitrage_capture_${reference}` }
            });
            // §P.4 AUTHORITATIVE SETTLEMENT — inside the SAME settlement
            // transaction as the PENDING->COMPLETED claim and the deferred
            // economics realization (only for rows that carry a §P.4 ledger
            // reservation; legacy rows have no ledger truth to settle):
            //   D restricted:reserves        — the reservation is released
            //   C clearing:fiat:offramp:usdc — principal enters the GHS
            //     off-ramp settlement rail. This rail is a FIAT settlement —
            //     there is NO represented USDC transfer into provider
            //     custody here, so custody:provider:usdc is NEVER posted on
            //     this path (that account is reserved for real provider-held
            //     USDC). The §P.5 GHS-liquidity wave will reconcile this
            //     clearing balance against actual fiat asset movements.
            //   C revenue:fees               — fee realized NOW (system share)
            //   C user:{referrer}:liability   — referrer reward realized NOW
            // Provider-dependent economics are NEVER realized before this point.
            const ledgerReserved = metadata.ledgerReserved === true;
            if (ledgerReserved) {
                const principalExact = new Prisma.Decimal(String(amountFloat));
                const systemFeeExact = new Prisma.Decimal(String(referrerId && referrerShare > 0 ? systemShare : (systemShare > 0 ? systemShare : exitFee)));
                const referrerShareExact = referrerId && referrerShare > 0 ? new Prisma.Decimal(String(referrerShare)) : null;
                const totalReservedExact = principalExact.plus(systemFeeExact).plus(referrerShareExact || new Prisma.Decimal(0));
                const lines = [
                    { account: 'restricted:reserves', debit: totalReservedExact },
                    { account: 'clearing:fiat:offramp:usdc', credit: principalExact },
                ];
                if (!systemFeeExact.isZero()) lines.push({ account: 'revenue:fees', credit: systemFeeExact });
                if (referrerShareExact && !referrerShareExact.isZero()) {
                    lines.push({ account: `user:${referrerId}:liability`, credit: referrerShareExact });
                }
                const fiatSettlement = await ledger.post(tx, {
                    idempotencyKey: `ledger:withdrawal:fiat:settle:${reference}`,
                    entryType: 'WITHDRAWAL',
                    description: 'Fiat withdrawal settled on provider SUCCESS — deferred economics realized',
                    reference,
                    userId: pending.userId,
                    relatedEntity: 'transactionHistory',
                    relatedEntityId: pending.id,
                    metadata: { status: 'COMPLETED', provider: 'MOOLRE_DISBURSEMENT', providerTxId: providerTxId || null },
                    lines,
                });
                await restrictedObligations.releaseOnSettlement(tx, {
                    reference: `withdrawal:fiat:${reference}`,
                    releaseLedgerTransactionId: fiatSettlement.transaction.id,
                    settledAmount: totalReservedExact,
                });
            }
        }

        // §P.5-D: terminal GHS liquidity outcome for authority reservations
        // (IN_TRANSIT → PAID_OUT; contradictory or undelivered states
        // quarantine — never a throw on the mounted settle path, never a
        // rewrite of terminal history). Legacy withdrawals skip.
        await fiatLiquidity.settleIfRecorded(tx, {
            reference,
            outcome: 'SUCCESSFUL',
            providerTxId,
        });

        const transaction = await tx.transactionHistory.findUnique({ where: { txHash: reference } });
        return { changed: true, transaction };
    });

    return {
        reference,
        userId: result.transaction?.userId || null,
        status: result.transaction?.status || null,
        changed: result.changed,
        providerTxId: result.transaction?.providerRef || providerTxId || null,
        transaction: result.transaction
    };
};

const reverseFiatWithdrawal = async (prisma, reference, opts = {}) => {
    if (!reference) throw new Error('[reverseFiatWithdrawal] reference is required.');

    // r16 P0-C: callers that must coordinate the canonical reversal with
    // their own claims (admin rejection: mirror claim + canonical reversal
    // in ONE transaction) pass their open transaction via opts.tx.
    const db = opts.tx || prisma;
    const original = await db.transactionHistory.findUnique({ where: { txHash: reference } });
    if (!original) throw new Error(`[reverseFiatWithdrawal] No row with reference ${reference}.`);
    if (original.type !== 'WITHDRAWAL_FIAT') throw new Error(`[reverseFiatWithdrawal] Reference ${reference} is not a fiat withdrawal.`);
    if (original.status === 'FAILED') return { reference, alreadyReversed: true };

    if (original.status !== 'PENDING') {
        return { reference, alreadyReversed: true, notReversible: true, status: original.status };
    }

    const userId = original.userId;
    const amountFloat = Number(original.amountUsdc);
    const exitFee = Number(original.feeUsdc);
    const halfFee = parseFloat((exitFee / 2).toFixed(6));
    const totalDeduct = parseFloat((amountFloat + exitFee).toFixed(6));
    const economicsDeferred = _isDeferredWithdrawal(original);
    const referrer = economicsDeferred ? null : await _resolveReferrer(prisma, userId);

    const runReversal = async (tx) => {
        const claim = await tx.transactionHistory.updateMany({
            where: { txHash: reference, status: 'PENDING' },
            data: { status: 'FAILED' }
        });
        if (claim.count === 0) return { alreadyReversed: true };

        await _ensureProfitFeesSingleton(tx);
        await _ensureFiatPoolSingleton(tx);
        await _ensureMasterCryptoSingleton(tx);

        await tx.user.update({
            where: { id: userId },
            data: { availableBalance: { increment: totalDeduct } }
        });

        // §P.4 AUTHORITATIVE REVERSAL — inside the SAME reversal transaction
        // as the FAILED claim and the customer refund projection credit (only
        // for rows that carry a §P.4 ledger reservation; legacy rows have no
        // ledger truth to reverse):
        //   D restricted:reserves — reservation returns
        //   C user:{id}:liability — customer owed the refund (principal+fee)
        const ledgerReservedReverse = (original.metadata || {}).ledgerReserved === true;
        if (ledgerReservedReverse) {
            const reversalPost = await ledger.post(tx, {
                idempotencyKey: `ledger:withdrawal:fiat:reverse:${reference}`,
                entryType: 'WITHDRAWAL',
                description: 'Fiat withdrawal reversed — provider dispatch definitively failed',
                reference,
                userId,
                relatedEntity: 'transactionHistory',
                relatedEntityId: original.id,
                metadata: { status: 'FAILED', provider: 'MOOLRE_DISBURSEMENT' },
                lines: [
                    { account: 'restricted:reserves', debit: new Prisma.Decimal(String(totalDeduct)) },
                    { account: `user:${userId}:liability`, credit: new Prisma.Decimal(String(totalDeduct)) },
                ],
            });
            await restrictedObligations.cancelOnReversal(tx, {
                reference: `withdrawal:fiat:${reference}`,
                releaseLedgerTransactionId: reversalPost.transaction.id,
            });
        }

        // Legacy rows recognized fees before provider settlement. Unwind those
        // exact economics without inserting negative AdminProfitLog amounts,
        // which are prohibited by the database. New deferred rows skip this
        // block entirely because no fee/referral economics exist yet.
        if (!economicsDeferred) {
            if (referrer && halfFee > 0) {
                const referralDebit = await tx.user.updateMany({
                    where: { id: referrer.id, availableBalance: { gte: halfFee } },
                    data: { availableBalance: { decrement: halfFee } }
                });
                if (referralDebit.count !== 1) {
                    const err = new Error('Legacy referral reward can no longer be clawed back automatically; manual reconciliation is required.');
                    err.code = 'LEGACY_REFERRAL_REVERSAL_REQUIRES_RECONCILIATION';
                    throw err;
                }
                await tx.systemProfitFees.update({
                    where: { id: 1 },
                    data: { balance: { decrement: halfFee } }
                });
            } else if (exitFee > 0) {
                await tx.systemProfitFees.update({
                    where: { id: 1 },
                    data: { balance: { decrement: exitFee } }
                });
            }

            await tx.adminProfitLog.deleteMany({
                where: { relatedTxId: { endsWith: reference } }
            });
        }

        await tx.systemMasterCrypto.update({
            where: { id: 1 },
            data: { balance: { decrement: amountFloat } }
        });
        // §P.5-D: the reversal releases GHS through the SAME regime that
        // reserved it. A provider-terminal FAILED observation (opts.providerTerminal)
        // is DURABLE evidence the cash never left custody — the authority
        // settles the reservation with that evidence (IN_TRANSIT funds
        // return to available; contradictory terminal observations
        // quarantine through the same path). An INTERNAL reversal (no
        // provider evidence) releases conservatively: IN_TRANSIT cash
        // positions are quarantined, never auto-released. A legacy
        // withdrawal (no reservation row) keeps the legacy SystemFiatPool
        // re-credit.
        const liquidityRelease = opts.providerTerminal
            ? await fiatLiquidity.settleIfRecorded(tx, {
                reference,
                outcome: 'FAILED',
                providerTxId: opts.providerTxId ?? null,
                reason: opts.reason || 'provider reported FAILED settlement',
            })
            : await fiatLiquidity.releaseIfRecorded(tx, {
                reference,
                reason: opts.reason || 'reversal',
            });
        if (liquidityRelease.skipped) {
            await _ensureFiatPoolSingleton(tx);
            await tx.systemFiatPool.update({
                where: { id: 1 },
                data: { balance: { increment: amountFloat } }
            });
        }

        // P0: restore the AZM fee-discount spend INSIDE this same reversal
        // transaction. The PENDING -> FAILED claim above is the one-winner
        // gate, so only this transaction may restore AZM. The spend log is
        // found by its deterministic dedup identity (never a fresh refund
        // guess), and the metadata.reversedAt marker makes the restore
        // idempotent. No negative AzmSpendLog rows are ever created.
        let azmFeeDiscount = null;
        const feeDiscountSpend = await tx.azmSpendLog.findFirst({
            where: {
                userId,
                source: AZM_SPEND_SOURCES.FEE_DISCOUNT,
                metadata: { path: ['dedupKey'], equals: `fee_discount_${reference}` }
            },
            orderBy: { createdAt: 'asc' }
        });

        if (feeDiscountSpend) {
            const spendMeta = feeDiscountSpend.metadata || {};
            if (!spendMeta.reversedAt) {
                const restored = await tx.user.update({
                    where: { id: userId },
                    data: { azmBalance: { increment: feeDiscountSpend.amount } },
                    select: { azmBalance: true }
                });
                await tx.azmSpendLog.update({
                    where: { id: feeDiscountSpend.id },
                    data: {
                        metadata: {
                            ...spendMeta,
                            reversedAt: new Date().toISOString(),
                            reversalReference: reference
                        }
                    }
                });
                azmFeeDiscount = {
                    restored: true,
                    amount: Number(feeDiscountSpend.amount),
                    newAzmBalance: restored.azmBalance,
                    logId: feeDiscountSpend.id
                };
            } else {
                azmFeeDiscount = {
                    restored: false,
                    alreadyReversed: true,
                    amount: Number(feeDiscountSpend.amount),
                    logId: feeDiscountSpend.id
                };
            }
        } else if (_isDeferredWithdrawal(original) && original.metadata?.azmFeeDiscount) {
            // The withdrawal claims a fee discount but its AZM spend log is
            // missing. NEVER fabricate a refund — surface the anomaly so
            // reconciliation can see it.
            azmFeeDiscount = { restored: false, missing: true };
        }

        const [profitFees, updatedFiatPool, masterCrypto, user] = await Promise.all([
            tx.systemProfitFees.findUnique({ where: { id: 1 } }),
            tx.systemFiatPool.findUnique({ where: { id: 1 } }),
            tx.systemMasterCrypto.findUnique({ where: { id: 1 } }),
            tx.user.findUnique({ where: { id: userId }, select: { availableBalance: true } })
        ]);
        return { alreadyReversed: false, profitFees, fiatPool: updatedFiatPool, masterCrypto, user, azmFeeDiscount };
    };

    // r16 P0-C: run inside the caller's transaction when coordinated claims
    // are required (admin rejection), otherwise in a fresh one.
    const result = opts.tx ? await runReversal(opts.tx) : await prisma.$transaction(runReversal);

    if (result.alreadyReversed) return { reference, alreadyReversed: true };
    return {
        reference,
        alreadyReversed: false,
        refundedAmount: totalDeduct,
        userId,
        newUserBalance: result.user.availableBalance,
        systemProfitFees: result.profitFees.balance,
        systemFiatPool: result.fiatPool.balance,
        systemMasterCrypto: result.masterCrypto.balance,
        unwoundCapture: amountFloat,
        azmFeeDiscount: result.azmFeeDiscount,
        reason: opts.reason || null
    };
};

const liquidateProfits = async (prisma, amountFloat, adminId, auditContext = {}) => {
    const liquidityAuthorityOn = await fiatLiquidity.isAuthorityEnabled(prisma);
    let treasuryRate = null;
    let treasuryRateSource = null;
    let treasuryRateAsOf = null;
    if (liquidityAuthorityOn) {
        // §P.5-D / NO-SYNTHETIC-GHS: liquidateProfits is an INTERNAL USDC
        // profit-account operation. It is NOT evidence that GHS cash entered
        // custody — no bank transfer, no MoMo collection happened. With the
        // authority ON the liquidation is recorded as an AUDITED, NON-AVAILABLE
        // treasury opening priced at the canonical retail rate (provider
        // AZM_TREASURY, status RECEIVED). It CANNOT become AVAILABLE GHS from
        // here: only fiatLiquidity.confirmTreasuryOpening with a durable
        // external GHS funding observation (bank/MoMo transfer evidence)
        // can unlock it — a separate, explicitly human-attested step.
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        treasuryRate = Number(settings?.liveRetailRate);
        if (!(treasuryRate > 0)) {
            const err = new Error('Treasury liquidation requires a canonical retail rate (liveRetailRate unavailable).');
            err.code = 'TREASURY_RATE_UNAVAILABLE';
            throw err;
        }
        treasuryRateSource = settings?.liveRateSource || null;
        treasuryRateAsOf = settings?.lastExternalSync || settings?.lastRateSync || new Date();
    }
    const result = await prisma.$transaction(async (tx) => {
        await _ensureProfitFeesSingleton(tx);
        if (!liquidityAuthorityOn) await _ensureFiatPoolSingleton(tx);

        const claim = await tx.systemProfitFees.updateMany({
            where: { id: 1, balance: { gte: amountFloat } },
            data: { balance: { decrement: amountFloat } }
        });

        if (claim.count !== 1) {
            const err = new Error(`Insufficient profit balance. Requested: ${amountFloat.toFixed(6)} USDC.`);
            err.code = 'INSUFFICIENT_PROFIT_BALANCE';
            throw err;
        }

        const profitLog = await tx.adminProfitLog.create({ data: { amountUsdc: amountFloat, source: 'ARBITRAGE_SPREAD', relatedTxId: `liquidation_admin_${adminId}_${Date.now()}` } });
        if (liquidityAuthorityOn) {
            // Audited, NON-AVAILABLE treasury opening only. The internal USDC
            // move itself creates NO spendable GHS — see the header comment.
            const amountGhs = parseFloat((amountFloat * treasuryRate).toFixed(2));
            await fiatLiquidity.recordReceipt(tx, {
                provider: 'AZM_TREASURY',
                rail: 'INTERNAL',
                dedupKey: `treasury:liquidation:${profitLog.relatedTxId}`,
                amountGhs,
                treasury: true,
                evidence: {
                    kind: 'AUDITED_TREASURY_OPENING',
                    amountUsdc: amountFloat,
                    adminId,
                    adminProfitLogId: profitLog.id,
                    retailRate: treasuryRate,
                    rateSource: treasuryRateSource,
                    rateAsOf: treasuryRateAsOf instanceof Date ? treasuryRateAsOf.toISOString() : treasuryRateAsOf,
                    availability: 'NONE — an external GHS funding event is required before this opening can be confirmed',
                },
            });
        } else {
            await tx.systemFiatPool.update({
                where: { id: 1 },
                data: { balance: { increment: amountFloat } }
            });
        }

        await audit(tx, {
            actorId: auditContext.actorId ?? adminId,
            actorName: auditContext.actorName || null,
            action: 'LIQUIDATE_PROFITS',
            targetType: 'SYSTEM',
            targetId: null,
            metadata: {
                amountUsdc: amountFloat,
                amountLiquidated: amountFloat,
                relatedTxId: profitLog.relatedTxId
            },
            ipAddress: auditContext.ipAddress || null,
        }, { throwOnError: true });
        const [updatedProfitFees, updatedFiatPool] = await Promise.all([
            tx.systemProfitFees.findUnique({ where: { id: 1 } }),
            tx.systemFiatPool.findUnique({ where: { id: 1 } })
        ]);
        return { profitLog, updatedProfitFees, updatedFiatPool };
    });
    if (liquidityAuthorityOn) {
        // NO-SYNTHETIC-GHS: the response explicitly does NOT report spendable
        // GHS creation — an internal USDC liquidation created a NON-AVAILABLE
        // treasury opening only (requires external GHS funding evidence to
        // become AVAILABLE via the treasury confirmation boundary).
        return {
            amountLiquidated: amountFloat,
            newProfitFees: result.updatedProfitFees.balance,
            newFiatPool: result.updatedFiatPool.balance,
            profitLog: result.profitLog,
            treasuryOpeningRecorded: true,
            ghsAvailableCreated: '0.00',
            ghsAvailabilityNote: 'Internal USDC liquidation records a non-available treasury opening only; confirming it requires an external GHS funding event (confirmTreasuryOpening).'
        };
    }
    return { amountLiquidated: amountFloat, newProfitFees: result.updatedProfitFees.balance, newFiatPool: result.updatedFiatPool.balance, profitLog: result.profitLog };
};

const processCryptoDeposit = async (prisma, { userId, amountUsdc, txHash, address }) => {
    try {
        const result = await prisma.$transaction(async (tx) => {
            const existingTx = await tx.transactionHistory.findUnique({ where: { txHash } });
            if (existingTx) return { alreadyProcessed: true };

            const user = await tx.user.findUnique({ where: { id: userId } });
            if (!user) throw new Error(`User ${userId} not found for crypto deposit.`);
            await tx.user.update({ where: { id: userId }, data: { availableBalance: { increment: amountUsdc } } });
            await tx.systemMasterCrypto.upsert({ where: { id: 1 }, update: { balance: { increment: amountUsdc } }, create: { id: 1, balance: amountUsdc } });
            await tx.systemHotWallet.upsert({ where: { id: 1 }, update: { balance: { increment: amountUsdc } }, create: { id: 1, balance: amountUsdc } });
            const txRecord = await tx.transactionHistory.create({ data: { userId, type: 'DEPOSIT_CRYPTO', amountUsdc, feeUsdc: 0, txHash, status: 'COMPLETED' } });

            // §P.4 AUTHORITATIVE LEDGER — same transaction as the credit and
            // the TransactionHistory row, idempotent on the same txHash
            // identity the txHash unique constraint already enforces:
            //   D clearing:custody:unverified:usdc — PROVISIONAL custody:
            //     the legacy webhook is an observation source with NO
            //     independent chain evidence; this clearing account is NOT
            //     a PoR reserve asset. (SystemMasterCrypto/SystemHotWallet
            //     remain non-authoritative display mirrors only.)
            //   C user:{id}:liability — customer liability increases.
            // An unrepresentable float amount (over-precision) is rejected
            // by toExactDecimal and rolls the whole credit back — the
            // legacy route can no longer mint value the authoritative books
            // cannot express.
            await ledger.post(tx, {
                idempotencyKey: `ledger:deposit:crypto:${txHash}`,
                entryType: 'CUSTODY_DEPOSIT',
                description: 'Crypto deposit observed by legacy finance webhook — provisional custody clearing credit',
                userId,
                relatedEntity: 'transactionHistory',
                relatedEntityId: txRecord.id,
                metadata: { source: 'legacy-finance-webhook', address: address || null },
                lines: [
                    { account: 'clearing:custody:unverified:usdc', debit: amountUsdc },
                    { account: `user:${userId}:liability`, credit: amountUsdc },
                ],
            });

            return { alreadyProcessed: false, user, txRecord, newBalance: user.availableBalance + amountUsdc };
        });

        if (result.alreadyProcessed) {
            logger.info(`[Finance] Duplicate txHash ignored: ${txHash}`);
            return { alreadyProcessed: true };
        }

        logger.info(`[Finance] Crypto deposit: ${amountUsdc} USDC → user ${userId} | txHash: ${txHash}`);
        return { alreadyProcessed: false, data: { userId, amountUsdc, txHash, address: address || null, newBalance: result.newBalance, transaction: result.txRecord } };
    } catch (error) {
        if (error?.code === 'P2002') {
            logger.info(`[Finance] Duplicate txHash ignored after unique constraint: ${txHash}`);
            return { alreadyProcessed: true };
        }
        throw error;
    }
};

module.exports = {
    processFiatWithdrawal,
    completeFiatWithdrawal,
    reverseFiatWithdrawal,
    liquidateProfits,
    processCryptoDeposit,
    EXIT_FEE_PERCENT,
    FIAT_POOL_ALERT_THRESH
};
