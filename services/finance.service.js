// services/finance.service.js
// =============================================================================
// AZAMAN V2 — FINANCE SERVICE   (Phase B v2: The Arbitrage Capture)
// Pure business-logic layer. No req/res. All multi-step DB writes are wrapped
// in a single prisma.$transaction block to guarantee ACID compliance.
// =============================================================================

const logger = require('../src/config/logger');
const { runDoubleCheck } = require('../utils/securityCheck');

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

const processFiatWithdrawal = async (prisma, userId, amountFloat, opts = {}) => {
    await runDoubleCheck(prisma, userId);
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
    const retailRate = Number(opts.retailRate) > 0 ? Number(opts.retailRate) : null;
    const payoutGhs  = Number(opts.payoutGhs) > 0 ? Number(opts.payoutGhs) : null;

    const fiatPool = await prisma.systemFiatPool.findUnique({ where: { id: 1 } });
    if (!fiatPool || Number(fiatPool.balance) < amountFloat) {
        const err = new Error(
            'MoMo payouts are temporarily at capacity. Your USDC has not been deducted. ' +
            'Please try again in a few minutes or contact support.'
        );
        err.code = 'FIAT_POOL_INSUFFICIENT';
        throw err;
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

        await _reserveFiatPool(tx, amountFloat);
        await _debitUserBalance(tx, userId, totalDeduct);

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
                    payoutGhs
                }
            }
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
            profitFees,
            fiatPool: updatedFiatPool,
            masterCrypto,
            newUserBalance: updatedUser.availableBalance
        };
    });

    return {
        reference,
        withdrawalAmount: amountFloat,
        exitFee,
        totalDeducted: totalDeduct,
        retailRate,
        payoutGhs,
        feeSplit: referrer
            ? { referrerId: referrer.id, referrerUsername: referrer.username, referrerShare: halfFee, systemShare: halfFee }
            : { referrerId: null, referrerUsername: null, referrerShare: 0, systemShare: exitFee },
        newBalance: result.newUserBalance,
        systemFiatPool: result.fiatPool.balance,
        systemProfitFees: result.profitFees.balance,
        systemMasterCrypto: result.masterCrypto.balance,
        arbitrageCapture: amountFloat,
        transaction: result.txRecord,
        fiatPoolLow: result.fiatPool.balance < FIAT_POOL_ALERT_THRESH,
        fiatPoolBalance: result.fiatPool.balance
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
        }

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

    const original = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
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

    const result = await prisma.$transaction(async (tx) => {
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
        await tx.systemFiatPool.update({
            where: { id: 1 },
            data: { balance: { increment: amountFloat } }
        });

        const [profitFees, updatedFiatPool, masterCrypto, user] = await Promise.all([
            tx.systemProfitFees.findUnique({ where: { id: 1 } }),
            tx.systemFiatPool.findUnique({ where: { id: 1 } }),
            tx.systemMasterCrypto.findUnique({ where: { id: 1 } }),
            tx.user.findUnique({ where: { id: userId }, select: { availableBalance: true } })
        ]);
        return { alreadyReversed: false, profitFees, fiatPool: updatedFiatPool, masterCrypto, user };
    });

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
        reason: opts.reason || null
    };
};

const liquidateProfits = async (prisma, amountFloat, adminId) => {
    const result = await prisma.$transaction(async (tx) => {
        await _ensureProfitFeesSingleton(tx);
        await _ensureFiatPoolSingleton(tx);
        const profitFees = await tx.systemProfitFees.findUnique({ where: { id: 1 } });
        if (profitFees.balance < amountFloat) {
            throw new Error(`Insufficient profit balance. Available: ${profitFees.balance.toFixed(6)} USDC, Requested: ${amountFloat.toFixed(6)} USDC.`);
        }
        await tx.systemProfitFees.update({ where: { id: 1 }, data: { balance: { decrement: amountFloat } } });
        await tx.systemFiatPool.update({ where: { id: 1 }, data: { balance: { increment: amountFloat } } });
        const profitLog = await tx.adminProfitLog.create({ data: { amountUsdc: amountFloat, source: 'ARBITRAGE_SPREAD', relatedTxId: `liquidation_admin_${adminId}_${Date.now()}` } });
        const [updatedProfitFees, updatedFiatPool] = await Promise.all([
            tx.systemProfitFees.findUnique({ where: { id: 1 } }),
            tx.systemFiatPool.findUnique({ where: { id: 1 } })
        ]);
        return { profitLog, updatedProfitFees, updatedFiatPool };
    });
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
