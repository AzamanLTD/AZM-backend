// controllers/withdrawalController.js
// =============================================================================
// AZAMAN V2 — WITHDRAWAL CONTROLLER
// Delegates all business logic to finance.service.js.
// V2 FIX: All SystemLedger references replaced with the correct V2 singleton
// models: SystemProfitFees and SystemFiatPool.
//
// Phase A (May 2026) — Money correctness pass
//   • fiatWithdrawal now actually invokes the MTN MoMo disbursement service
//     after the ACID ledger commit. On gateway rejection the entire ledger
//     mutation is unwound via financeService.reverseFiatWithdrawal.
//   • cryptoWithdrawal now hard-fails the user request when the Tatum
//     broadcast call rejects, instead of debiting the user and pretending
//     the on-chain transfer succeeded.
// =============================================================================

const financeService          = require('../services/finance.service');
const { runDoubleCheck }      = require('../utils/securityCheck');
const axios                   = require('axios');
const { randomUUID }          = require('crypto');

const POLYGON_GAS_FEE_MATIC   = 0.05;  // V2 Blueprint: 100% of network gas is borne by user
const FIAT_POOL_ALERT_THRESH  = financeService.FIAT_POOL_ALERT_THRESH;

// Phase L2: Large-withdrawal SMS threshold (USDC). Withdrawals at or above
// this amount trigger a fire-and-forget SMS confirmation to verified phones.
const SMS_LARGE_WITHDRAWAL_THRESHOLD = parseFloat(
    process.env.SMS_LARGE_WITHDRAWAL_THRESHOLD || '100'
);

// =============================================================================
// POST /api/withdraw/fiat
// Authenticated user requests a fiat withdrawal.
//
// Flow:
//   1. financeService.processFiatWithdrawal — debits the user, captures the
//      arbitrage spread, splits the exit fee, debits SystemFiatPool, writes
//      a TransactionHistory row stamped with `reference` (UUID v4 used as
//      the MTN MoMo X-Reference-Id idempotency key).
//   2. mtnDisbursementService.initiateTransfer — dispatches the GHS payout to
//      the user's MoMo wallet using the same `reference`. The call is async
//      from MTN's side (202 Accepted; settlement webhook arrives later).
//   3. On synchronous rejection from MTN, financeService.reverseFiatWithdrawal
//      atomically refunds the user, unwinds SystemMasterCrypto / SystemFiatPool,
//      and marks the TransactionHistory row FAILED.
// =============================================================================
exports.fiatWithdrawal = async (req, res) => {
    const prisma                  = req.app.get('prisma');
    const io                      = req.app.get('socketio');
    const emitBalanceUpdate       = req.app.get('emitBalanceUpdate');
    const mtnDisbursementService  = req.app.get('mtnDisbursementService');
    const emailService            = req.app.get('emailService');
    const smsService              = req.app.get('smsService');

    try {
        const { amount, payoutMethod, recipientPhone, destination } = req.body;
        const userId = req.user.id;

        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid withdrawal amount.' });
        }

        // recipientPhone is required for MTN MoMo dispatch — fall back to the
        // legacy `destination` field if older clients are still sending it.
        const phone = recipientPhone || destination;
        if (!phone || typeof phone !== 'string' || phone.length < 9) {
            return res.status(400).json({
                success: false,
                message: 'recipientPhone is required for MoMo withdrawal.'
            });
        }

        // Pre-allocate a UUID that will serve as the canonical idempotency
        // key across (a) the TransactionHistory row, (b) the MTN MoMo
        // X-Reference-Id, and (c) any reversal lookups.
        const reference = randomUUID();

        // Phase L1: pre-fetch recipient identity once so any synchronous
        // reversal branch below can fire a refund-notice receipt without a
        // second DB hit. The fiat-success path doesn't email here — that
        // happens from withdrawalReconciliationWorker once MoMo settles.
        let recipient = null;
        try {
            recipient = await prisma.user.findUnique({
                where:  { id: userId },
                select: { id: true, email: true, username: true, phoneNumber: true, phoneVerified: true }
            });
        } catch (_) { /* non-fatal — receipt simply won't fire */ }

        // Step 1 — Debit user + ledger writes (ACID).
        // Phase E2: If user opts to spend AZM for a fee discount, apply it
        // BEFORE the withdrawal so the reduced fee is used in settlement.
        let feeDiscountMultiplier = 0;
        const feeDiscountTierId = req.body.feeDiscountTierId; // optional: 'tier_25' | 'tier_50' | 'tier_100'
        if (feeDiscountTierId) {
            const azmSpendService = req.app.get('azmSpendService');
            if (azmSpendService) {
                try {
                    const discountResult = await azmSpendService.applyFeeDiscount(
                        userId,
                        feeDiscountTierId,
                        reference
                    );
                    feeDiscountMultiplier = discountResult.discount;
                } catch (azmErr) {
                    // AZM spend failed (insufficient balance or invalid tier)
                    return res.status(400).json({
                        success: false,
                        code: 'AZM_SPEND_FAILED',
                        message: azmErr.message
                    });
                }
            }
        }

        const data = await financeService.processFiatWithdrawal(
            prisma,
            userId,
            parseFloat(amount),
            { reference, feeDiscountMultiplier }
        );

        // Real-time balance push — user's UI updates while MTN settles async.
        if (emitBalanceUpdate) await emitBalanceUpdate(userId);

        // Step 2 — Persist Withdrawal row for admin visibility / reconciliation.
        // The Withdrawal model does NOT have a unique idempotency column;
        // the TransactionHistory.txHash IS the idempotency key. The Withdrawal
        // row mirrors that for the admin UI.
        let withdrawalRow = null;
        try {
            withdrawalRow = await prisma.withdrawal.create({
                data: {
                    userId,
                    amount:        parseFloat(amount),
                    payoutMethod:  payoutMethod || 'MTN_MOMO',
                    network:       'MOMO',
                    destination:   phone,
                    status:        'PENDING'
                }
            });
        } catch (rowErr) {
            // Non-fatal: the canonical record is the TransactionHistory row.
            console.warn('[fiatWithdrawal] Withdrawal mirror row insert failed:', rowErr.message);
        }

        // Step 3 — Dispatch payout to MTN MoMo. On synchronous failure, fully
        // reverse the ledger so the user is not silently debited.
        if (!mtnDisbursementService) {
            console.error('[fiatWithdrawal] mtnDisbursementService is not bound to the app context.');
            await financeService.reverseFiatWithdrawal(prisma, reference, {
                reason: 'mtn_service_unavailable'
            });
            if (emitBalanceUpdate) await emitBalanceUpdate(userId);

            // Phase L1: refund-notice receipt (fire-and-forget).
            if (emailService && recipient && recipient.email) {
                const r = recipient;
                const amt = parseFloat(amount);
                setImmediate(() => {
                    emailService.sendWithdrawalReceipt(r, {
                        kind:           'fiat_failure',
                        amount:         amt,
                        currency:       'USDC',
                        reference,
                        refundedAmount: amt,
                        reason:         'Payout gateway is currently unavailable.'
                    }).catch(() => { /* swallowed inside service */ });
                });
            }

            // Phase L2: refund SMS (fire-and-forget, only for verified phones + large amounts).
            if (smsService && recipient && recipient.phoneNumber && recipient.phoneVerified
                && parseFloat(amount) >= SMS_LARGE_WITHDRAWAL_THRESHOLD) {
                const ph = recipient.phoneNumber;
                const amt = parseFloat(amount);
                setImmediate(() => {
                    smsService.sendWithdrawalConfirmation(ph, {
                        kind:   'fiat_refunded',
                        amount: amt,
                        reason: 'Payout gateway is currently unavailable.'
                    }).catch(() => {});
                });
            }

            return res.status(503).json({
                success: false,
                message: 'Payout gateway is unavailable. Your balance has been restored.'
            });
        }

        try {
            const dispatch = await mtnDisbursementService.initiateTransfer({
                referenceId:    reference,
                amountGhs:      data.payoutGhs || data.withdrawalAmount,  // GHS amount derived by service if available
                recipientPhone: phone,
                externalId:     reference,
                payerMessage:   'Azaman fiat withdrawal',
                payeeNote:      `Withdrawal ${reference}`
            });

            // Low-liquidity admin alert (post-dispatch so the user is not blocked).
            if (data.fiatPoolLow) {
                const alertMsg =
                    `AI LIQUIDITY FLAG: SYSTEM_FIAT_POOL dropped to ` +
                    `$${data.fiatPoolBalance.toFixed(2)} ` +
                    `(threshold: $${FIAT_POOL_ALERT_THRESH}). Immediate replenishment required.`;
                console.warn(`[LIQUIDITY ALERT] ${alertMsg}`);
                try {
                    // Phase N2: route through notificationService for DB + socket + FCM
                    const NotificationService = require('../services/notificationService');
                    const notifSvc = new NotificationService(prisma, io);
                    await notifSvc.sendNotification({
                        userId,
                        title: 'Liquidity Alert',
                        body: alertMsg,
                        category: 'ADMIN_SYSTEM',
                        actionPayload: { action: 'OPEN_WAR_ROOM', fiatPool: data.fiatPoolBalance }
                    });
                    if (io) {
                        io.emit('admin_alert', {
                            type:      'LIQUIDITY_LOW',
                            fiatPool:  data.fiatPoolBalance,
                            threshold: FIAT_POOL_ALERT_THRESH,
                            timestamp: new Date().toISOString()
                        });
                    }
                } catch (alertErr) {
                    console.error('[fiatWithdrawal] liquidity alert emit failed:', alertErr.message);
                }
            }

            // Phase L2: large-withdrawal SMS confirmation (fire-and-forget).
            // Only fires if recipient has a verified phone and amount meets threshold.
            if (smsService && recipient && recipient.phoneNumber && recipient.phoneVerified
                && parseFloat(amount) >= SMS_LARGE_WITHDRAWAL_THRESHOLD) {
                const ph = recipient.phoneNumber;
                const amt = parseFloat(amount);
                setImmediate(() => {
                    smsService.sendWithdrawalConfirmation(ph, {
                        kind:        'fiat_dispatched',
                        amount:      amt,
                        destination: phone,
                        reference
                    }).catch(() => {});
                });
            }

            return res.status(200).json({
                success: true,
                message: `Withdrawal dispatched to MTN MoMo. Reference: ${reference}`,
                data: {
                    ...data,
                    withdrawalId: withdrawalRow ? withdrawalRow.id : null,
                    dispatch
                }
            });
        } catch (mtnErr) {
            console.error('[fiatWithdrawal] MTN dispatch failed — unwinding ledger:', mtnErr.message);
            let reversalSucceeded = false;
            try {
                await financeService.reverseFiatWithdrawal(prisma, reference, {
                    reason: `mtn_dispatch_failed: ${mtnErr.message}`
                });
                reversalSucceeded = true;
            } catch (reverseErr) {
                // If the reversal itself fails the system is in an
                // inconsistent state — flag loudly so an admin investigates.
                console.error('[fiatWithdrawal] CRITICAL: reversal failed after MTN error:', reverseErr.message);
                if (io) {
                    io.emit('admin_alert', {
                        type:       'WITHDRAWAL_REVERSAL_FAILED',
                        reference,
                        userId,
                        mtnError:   mtnErr.message,
                        reverseError: reverseErr.message,
                        timestamp:  new Date().toISOString()
                    });
                }
            }

            // Mark mirror row FAILED for admin visibility.
            if (withdrawalRow) {
                try {
                    await prisma.withdrawal.update({
                        where: { id: withdrawalRow.id },
                        data:  { status: 'FAILED' }
                    });
                } catch (_) {/* non-fatal */}
            }

            if (emitBalanceUpdate) await emitBalanceUpdate(userId);

            // Phase L1: refund-notice receipt (fire-and-forget). Only fired
            // on the success-of-reversal path. If the reversal itself
            // failed (caught above) the admin alert takes over because the
            // system is in an inconsistent state.
            if (reversalSucceeded && emailService && recipient && recipient.email) {
                const r = recipient;
                const amt = parseFloat(amount);
                const errMsg = mtnErr.message;
                setImmediate(() => {
                    emailService.sendWithdrawalReceipt(r, {
                        kind:           'fiat_failure',
                        amount:         amt,
                        currency:       'USDC',
                        reference,
                        refundedAmount: amt,
                        reason:         `The MoMo gateway rejected the disbursement: ${errMsg}`
                    }).catch(() => { /* swallowed inside service */ });
                });
            }

            // Phase L2: refund SMS (fire-and-forget, gated on reversal success + verified phone + threshold).
            if (reversalSucceeded && smsService && recipient && recipient.phoneNumber && recipient.phoneVerified
                && parseFloat(amount) >= SMS_LARGE_WITHDRAWAL_THRESHOLD) {
                const ph = recipient.phoneNumber;
                const amt = parseFloat(amount);
                const errMsg = mtnErr.message;
                setImmediate(() => {
                    smsService.sendWithdrawalConfirmation(ph, {
                        kind:   'fiat_refunded',
                        amount: amt,
                        reason: errMsg
                    }).catch(() => {});
                });
            }

            return res.status(502).json({
                success: false,
                message: 'Payout gateway rejected the withdrawal. Your balance has been restored.',
                data:    { reference, gatewayError: mtnErr.message }
            });
        }

    } catch (error) {
        console.error('[fiatWithdrawal] error:', error.message);

        // If the Double-Check threw, freeze the transaction record and return 403.
        if (error.message.includes('[DoubleCheck]')) {
            try {
                await prisma.transactionHistory.create({
                    data: {
                        userId:     req.user.id,
                        type:       'WITHDRAWAL_FIAT',
                        amountUsdc: parseFloat(req.body.amount) || 0,
                        feeUsdc:    0,
                        status:     'FROZEN_DISPUTE'
                    }
                });
            } catch (freezeErr) {
                console.error('[fiatWithdrawal] Failed to write freeze record:', freezeErr.message);
            }

            return res.status(403).json({
                success: false,
                message: 'Withdrawal frozen: Ledger inconsistency detected. Your request has been flagged for review.',
                data:    { status: 'FROZEN_DISPUTE' }
            });
        }

        return res.status(400).json({ success: false, message: error.message });
    }
};

// =============================================================================
// POST /api/withdraw/crypto
// Authenticated user withdraws USDC to an on-chain Polygon address.
//
// V2 Blueprint Mandate: The user bears 100% of the MATIC/POL network gas fee.
// The fee is deducted FROM the withdrawal amount so the user's availableBalance
// is debited by the full requested `amount`, but only `amount - gasFeeUsdc` is
// actually sent on-chain. The fee equivalent in USDC is computed using a live
// MATIC/USDC oracle rate (CoinGecko) with a safe fallback.
//
// V2 FIX: uses SystemHotWallet singleton instead of the removed SystemLedger.
// =============================================================================
exports.cryptoWithdrawal = async (req, res) => {
    const prisma             = req.app.get('prisma');
    const io                 = req.app.get('socketio');
    const emitBalanceUpdate  = req.app.get('emitBalanceUpdate');
    const emailService       = req.app.get('emailService');
    const smsService         = req.app.get('smsService');

    try {
        const { amount, destination, network } = req.body;
        const userId = req.user.id;

        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid withdrawal amount.' });
        }
        if (!destination) {
            return res.status(400).json({ success: false, message: 'Destination wallet address is required.' });
        }
        if (!destination.startsWith('0x') || destination.length !== 42) {
            return res.status(400).json({ success: false, message: 'Invalid Polygon address format (must be 0x + 40 hex chars).' });
        }

        const amountFloat = parseFloat(amount);

        // Double-Check before touching any balances
        await runDoubleCheck(prisma, userId);

        // ── Fetch live MATIC/USDC rate for gas fee conversion ────────────────
        let maticUsdcRate = 0.55; // Safe fallback
        try {
            const oracleRes = await axios.get(
                'https://api.coingecko.com/api/v3/simple/price',
                { params: { ids: 'matic-network', vs_currencies: 'usd' }, timeout: 5000 }
            );
            maticUsdcRate = oracleRes.data?.['matic-network']?.usd || 0.55;
        } catch {
            console.warn('[cryptoWithdrawal] Oracle unreachable — using fallback MATIC rate 0.55 USD');
        }

        // V2 Blueprint: 100% of gas fee is deducted from user's withdrawal.
        // POLYGON_GAS_FEE_MATIC is the estimated gas cost in MATIC/POL.
        // We convert it to USDC equivalent and subtract from the payout.
        const gasFeeUsdc = parseFloat((POLYGON_GAS_FEE_MATIC * maticUsdcRate).toFixed(6));
        const netPayout  = parseFloat((amountFloat - gasFeeUsdc).toFixed(6));

        if (netPayout <= 0) {
            return res.status(400).json({
                success: false,
                message: `Withdrawal amount (${amountFloat} USDC) is too low to cover the Polygon network gas fee (~${gasFeeUsdc} USDC).`
            });
        }

        // ── ACID transaction ─────────────────────────────────────────────────
        const result = await prisma.$transaction(async (tx) => {
            const user = await tx.user.findUnique({ where: { id: userId } });
            if (!user) throw new Error('User not found.');

            if (user.availableBalance < amountFloat) {
                throw new Error(
                    `Insufficient balance. Required: ${amountFloat} USDC, ` +
                    `available: ${user.availableBalance.toFixed(6)} USDC.`
                );
            }

            // Debit the FULL requested amount from user (gas fee is internal)
            await tx.user.update({
                where: { id: userId },
                data:  { availableBalance: { decrement: amountFloat } }
            });

            // Debit SystemHotWallet by the net payout only (gas fee stays)
            await tx.systemHotWallet.upsert({
                where:  { id: 1 },
                update: { balance: { decrement: netPayout } },
                create: { id: 1, balance: -netPayout }
            });

            // The gas fee portion goes to SystemProfitFees as operational revenue
            await tx.systemProfitFees.upsert({
                where:  { id: 1 },
                update: { balance: { increment: gasFeeUsdc } },
                create: { id: 1, balance: gasFeeUsdc }
            });

            // Generate a mock txHash (in production Tatum broadcasts the real tx)
            const txHashHex = '0x' + Array.from({ length: 64 }, () =>
                Math.floor(Math.random() * 16).toString(16)
            ).join('');

            const txRecord = await tx.transactionHistory.create({
                data: {
                    userId:     userId,
                    type:       'WITHDRAWAL_CRYPTO',
                    amountUsdc: netPayout,
                    feeUsdc:    gasFeeUsdc,
                    txHash:     txHashHex,
                    status:     'COMPLETED'
                }
            });

            // Audit trail for gas fee revenue
            await tx.adminProfitLog.create({
                data: {
                    amountUsdc:  gasFeeUsdc,
                    source:      'GAS_FEE_REVENUE',
                    relatedTxId: `crypto_withdraw_gas_${txHashHex}`
                }
            });

            return { user, txRecord, txHash: txHashHex };
        });

        // ── Live Tatum broadcast — REQUIRED. If this fails the user has
        // already been debited but no on-chain transfer happened. We must
        // either succeed the broadcast OR refund and FAIL the request.
        // ──────────────────────────────────────────────────────────────────
        try {
            await axios.post(
                'https://api.tatum.io/v3/polygon/transaction',
                {
                    chain:    'polygon',
                    to:       destination,
                    amount:   netPayout.toString(),
                    currency: 'USDC'
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key':    process.env.TATUM_API_KEY || 'mock-tatum-api-key'
                    },
                    timeout: 10000
                }
            );
            console.log(`[Tatum] Crypto withdrawal broadcast: ${result.txHash} → ${destination} (${netPayout} USDC)`);
        } catch (tatumErr) {
            console.error(`[Tatum] Broadcast FAILED for ${result.txHash}: ${tatumErr.message} — refunding user.`);

            // Refund: re-credit the user, debit back the gas-fee profit row,
            // re-credit SystemHotWallet, and mark TransactionHistory FAILED.
            let refundSucceeded = false;
            try {
                await prisma.$transaction(async (tx) => {
                    await tx.user.update({
                        where: { id: userId },
                        data:  { availableBalance: { increment: amountFloat } }
                    });
                    await tx.systemHotWallet.update({
                        where: { id: 1 },
                        data:  { balance: { increment: netPayout } }
                    });
                    await tx.systemProfitFees.update({
                        where: { id: 1 },
                        data:  { balance: { decrement: gasFeeUsdc } }
                    });
                    await tx.transactionHistory.update({
                        where: { id: result.txRecord.id },
                        data:  { status: 'FAILED' }
                    });
                    await tx.adminProfitLog.create({
                        data: {
                            amountUsdc:   -gasFeeUsdc,
                            source:       'GAS_FEE_REVENUE',
                            relatedTxId:  `crypto_withdraw_refund_${result.txHash}`,
                            isSubsidized: true
                        }
                    });
                });
                refundSucceeded = true;
            } catch (refundErr) {
                console.error('[cryptoWithdrawal] CRITICAL: refund failed after Tatum error:', refundErr.message);
                if (io) {
                    io.emit('admin_alert', {
                        type:        'CRYPTO_WITHDRAWAL_REFUND_FAILED',
                        userId,
                        txHash:      result.txHash,
                        tatumError:  tatumErr.message,
                        refundError: refundErr.message,
                        timestamp:   new Date().toISOString()
                    });
                }
            }

            if (emitBalanceUpdate) await emitBalanceUpdate(userId);

            // Phase L1: refund-notice receipt (fire-and-forget). Only fired
            // on the success-of-refund path; if the inner refund itself
            // failed (caught above) the admin alert takes over because the
            // system is in an inconsistent state and a human must resolve.
            if (refundSucceeded && emailService && result.user && result.user.email) {
                const recipient = result.user;
                setImmediate(() => {
                    emailService.sendWithdrawalReceipt(recipient, {
                        kind:           'crypto_refund',
                        amount:         amountFloat,
                        refundedAmount: amountFloat,
                        destination,
                        network:        network || 'Polygon',
                        reason:         tatumErr.message || 'On-chain broadcast was rejected by the gateway.'
                    }).catch(() => { /* swallowed inside service */ });
                });
            }

            // Phase L2: refund SMS (fire-and-forget, gated on refund success + verified phone + threshold).
            if (refundSucceeded && smsService && result.user && result.user.phoneNumber && result.user.phoneVerified
                && amountFloat >= SMS_LARGE_WITHDRAWAL_THRESHOLD) {
                const ph = result.user.phoneNumber;
                setImmediate(() => {
                    smsService.sendWithdrawalConfirmation(ph, {
                        kind:   'crypto_refunded',
                        amount: amountFloat,
                        reason: tatumErr.message || 'On-chain broadcast was rejected.'
                    }).catch(() => {});
                });
            }

            return res.status(502).json({
                success: false,
                message: 'On-chain broadcast failed. Your USDC has been refunded.',
                data:    { gatewayError: tatumErr.message, refunded: amountFloat }
            });
        }

        await emitBalanceUpdate(userId);

        // Phase L1: transactional receipt (fire-and-forget). Detached via
        // setImmediate so the response flushes immediately; emailService
        // catches all errors internally so the request is never disrupted.
        if (emailService && result.user && result.user.email) {
            const recipient = result.user;
            setImmediate(() => {
                emailService.sendWithdrawalReceipt(recipient, {
                    kind:        'crypto_success',
                    amount:      amountFloat,
                    gasFeeUsdc,
                    netPayout,
                    destination,
                    network:     network || 'Polygon',
                    txHash:      result.txHash
                }).catch(() => { /* swallowed inside service */ });
            });
        }

        // Phase L2: large-withdrawal SMS (fire-and-forget, verified phone + threshold).
        if (smsService && result.user && result.user.phoneNumber && result.user.phoneVerified
            && amountFloat >= SMS_LARGE_WITHDRAWAL_THRESHOLD) {
            const ph = result.user.phoneNumber;
            setImmediate(() => {
                smsService.sendWithdrawalConfirmation(ph, {
                    kind:        'crypto_sent',
                    amount:      amountFloat,
                    destination,
                    txHash:      result.txHash
                }).catch(() => {});
            });
        }

        return res.status(200).json({
            success: true,
            message: `Crypto withdrawal of ${amountFloat} USDC to ${destination} on Polygon. Gas fee: ${gasFeeUsdc} USDC (100% user-borne). Net payout: ${netPayout} USDC.`,
            data: {
                withdrawalAmount:  amountFloat,
                gasFeeMatic:       POLYGON_GAS_FEE_MATIC,
                maticUsdcRate,
                gasFeeUsdc,
                netPayout,
                gasFeePolicy:      'USER_BEARS_100_PERCENT',
                destination,
                network:           network || 'Polygon',
                txHash:            result.txHash,
                newBalance:        result.user.availableBalance - amountFloat,
                transaction:       result.txRecord
            }
        });

    } catch (error) {
        console.error('[cryptoWithdrawal] error:', error.message);

        if (error.message.includes('[DoubleCheck]')) {
            try {
                await prisma.transactionHistory.create({
                    data: {
                        userId:     req.user.id,
                        type:       'WITHDRAWAL_CRYPTO',
                        amountUsdc: parseFloat(req.body.amount) || 0,
                        feeUsdc:    0,
                        status:     'FROZEN_DISPUTE'
                    }
                });
            } catch (freezeErr) {
                console.error('[cryptoWithdrawal] Failed to write freeze record:', freezeErr.message);
            }

            return res.status(403).json({
                success: false,
                message: 'Withdrawal frozen: Ledger inconsistency detected. Your request has been flagged for review.',
                data:    { status: 'FROZEN_DISPUTE' }
            });
        }

        return res.status(400).json({ success: false, message: error.message });
    }
};
