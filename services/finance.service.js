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
    const payoutGhs  = Number(opts.payoutGhs)  > 0 ? Number(opts.payoutGhs)  : null;

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
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) throw new Error('User not found.');

        if (user.availableBalance < totalDeduct) {
            throw new Error(
                `Insufficient balance. Required: ${totalDeduct} USDC ` +
                `(amount + exit fee), available: ${user.availableBalance.toFixed(6)} USDC.`
            );
        }

        // Reserve fiat liquidity before mutating the customer ledger. The
        // conditional UPDATE makes concurrent withdrawals serialize safely at
        // the treasury row instead of relying on a stale preflight snapshot.
        await _reserveFiatPool(tx, amountFloat);

        await tx.user.update({ where: { id: userId }, data: { availableBalance: { decrement: totalDeduct } } });

        await _ensureProfitFeesSingleton(tx);
        await _ensureMasterCryptoSingleton(tx);

        if (referrer) {
            await tx.user.update({ where: { id: referrer.id }, data: { availableBalance: { increment: halfFee } } });
            await tx.systemProfitFees.update({ where: { id: 1 }, data: { balance: { increment: halfFee } } });
            await tx.adminProfitLog.createMany({
                data: [
                    { amountUsdc: halfFee, source: 'EXIT_FEE', relatedTxId: `referral_split_system_${reference}` },
                    { amountUsdc: halfFee, source: 'EXIT_FEE', relatedTxId: `referral_split_referrer_${referrer.id}_${reference}` }
                ]
            });
        } else {
            await tx.systemProfitFees.update({ where: { id: 1 }, data: { balance: { increment: exitFee } } });
            await tx.adminProfitLog.create({ data: { amountUsdc: exitFee, source: 'EXIT_FEE', relatedTxId: `full_fee_${reference}` } });
        }

        await tx.systemMasterCrypto.update({ where: { id: 1 }, data: { balance: { increment: amountFloat } } });
        await tx.adminProfitLog.create({ data: { amountUsdc: amountFloat, source: 'ARBITRAGE_SPREAD', relatedTxId: `arbitrage_capture_${reference}` } });

        const txRecord = await tx.transactionHistory.create({
            data: {
                userId,
                type: 'WITHDRAWAL_FIAT',
                amountUsdc: amountFloat,
                feeUsdc: exitFee,
                txHash: reference,
                status: 'PENDING'
            }
        });

        const [profitFees, updatedFiatPool, masterCrypto] = await Promise.all([
            tx.systemProfitFees.findUnique({ where: { id: 1 } }),
            tx.systemFiatPool.findUnique({ where: { id: 1 } }),
            tx.systemMasterCrypto.findUnique({ where: { id: 1 } })
        ]);

        return {
            user,
            txRecord,
            profitFees,
            fiatPool: updatedFiatPool,
            masterCrypto,
            newUserBalance: user.availableBalance - totalDeduct
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

const reverseFiatWithdrawal = async (prisma, reference, opts = {}) => {
    if (!reference) throw new Error('[reverseFiatWithdrawal] reference is required.');

    const original = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
    if (!original) throw new Error(`[reverseFiatWithdrawal] No row with reference ${reference}.`);
    if (original.type !== 'WITHDRAWAL_FIAT') throw new Error(`[reverseFiatWithdrawal] Reference ${reference} is not a fiat withdrawal.`);
    if (original.status === 'FAILED') return { reference, alreadyReversed: true };
    if (original.status !== 'PENDING' && original.status !== 'COMPLETED') {
        throw new Error(`[reverseFiatWithdrawal] Cannot reverse row in state ${original.status}.`);
    }

    const userId = original.userId;
    const amountFloat = Number(original.amountUsdc);
    const exitFee = Number(original.feeUsdc);
    const halfFee = parseFloat((exitFee / 2).toFixed(6));
    const totalDeduct = parseFloat((amountFloat + exitFee).toFixed(6));
    const referrer = await _resolveReferrer(prisma, userId);

    const result = await prisma.$transaction(async (tx) => {
        const claim = await tx.transactionHistory.updateMany({
            where: { txHash: reference, status: { in: ['PENDING', 'COMPLETED'] } },
            data: { status: 'FAILED' }
        });
        if (claim.count === 0) return { alreadyReversed: true };

        await _ensureProfitFeesSingleton(tx);
        await _ensureFiatPoolSingleton(tx);
        await _ensureMasterCryptoSingleton(tx);

        await tx.user.update({ where: { id: userId }, data: { availableBalance: { increment: totalDeduct } } });

        if (referrer && halfFee > 0) {
            await tx.user.update({ where: { id: referrer.id }, data: { availableBalance: { decrement: halfFee } } });
            await tx.systemProfitFees.update({ where: { id: 1 }, data: { balance: { decrement: halfFee } } });
        } else {
            await tx.systemProfitFees.update({ where: { id: 1 }, data: { balance: { decrement: exitFee } } });
        }

        await tx.systemMasterCrypto.update({ where: { id: 1 }, data: { balance: { decrement: amountFloat } } });
        await tx.systemFiatPool.update({ where: { id: 1 }, data: { balance: { increment: amountFloat } } });

        const reversalLog = await tx.adminProfitLog.create({
            data: { amountUsdc: -exitFee, source: 'EXIT_FEE', relatedTxId: `provider_reversal_fee_${reference}_${Date.now()}`, isSubsidized: true }
        });
        await tx.adminProfitLog.create({
            data: { amountUsdc: -amountFloat, source: 'ARBITRAGE_SPREAD', relatedTxId: `provider_reversal_capture_${reference}_${Date.now()}`, isSubsidized: true }
        });

        const [profitFees, updatedFiatPool, masterCrypto, user] = await Promise.all([
            tx.systemProfitFees.findUnique({ where: { id: 1 } }),
            tx.systemFiatPool.findUnique({ where: { id: 1 } }),
            tx.systemMasterCrypto.findUnique({ where: { id: 1 } }),
            tx.user.findUnique({ where: { id: userId }, select: { availableBalance: true } })
        ]);
        return { alreadyReversed: false, reversalLog, profitFees, fiatPool: updatedFiatPool, masterCrypto, user };
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
        reason: opts.reason || null,
        reversalLog: result.reversalLog
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
    const existingTx = await prisma.transactionHistory.findUnique({ where: { txHash } });
    if (existingTx) {
        logger.info(`[Finance] Duplicate txHash ignored: ${txHash}`);
        return { alreadyProcessed: true };
    }

    const result = await prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) throw new Error(`User ${userId} not found for crypto deposit.`);
        await tx.user.update({ where: { id: userId }, data: { availableBalance: { increment: amountUsdc } } });
        await tx.systemMasterCrypto.upsert({ where: { id: 1 }, update: { balance: { increment: amountUsdc } }, create: { id: 1, balance: amountUsdc } });
        await tx.systemHotWallet.upsert({ where: { id: 1 }, update: { balance: { increment: amountUsdc } }, create: { id: 1, balance: amountUsdc } });
        const txRecord = await tx.transactionHistory.create({ data: { userId, type: 'DEPOSIT_CRYPTO', amountUsdc, feeUsdc: 0, txHash, status: 'COMPLETED' } });
        return { user, txRecord, newBalance: user.availableBalance + amountUsdc };
    });
    logger.info(`[Finance] Crypto deposit: ${amountUsdc} USDC → user ${userId} | txHash: ${txHash}`);
    return { alreadyProcessed: false, data: { userId, amountUsdc, txHash, address: address || null, newBalance: result.newBalance, transaction: result.txRecord } };
};

module.exports = {
    processFiatWithdrawal,
    reverseFiatWithdrawal,
    liquidateProfits,
    processCryptoDeposit,
    EXIT_FEE_PERCENT,
    FIAT_POOL_ALERT_THRESH
};