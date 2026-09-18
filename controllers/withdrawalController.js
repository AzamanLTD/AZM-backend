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

const logger = require('../src/config/logger');
const fraudService = require('../services/fraudDetectionService');
const ledger = require('../services/ledgerService'); // §P.4 authoritative ledger (shadow journalIntegration no longer used on this path)
const restrictedObligations = require('../services/restrictedObligationService');
const financeService          = require('../services/finance.service');
const { runDoubleCheck }      = require('../utils/securityCheck');
const axios                   = require('axios');
const { randomUUID }          = require('crypto');
const { audit }               = require('../utils/audit');
const { FEE_DISCOUNT_TIERS } = require('../services/azmSpendService');
const { Prisma } = require('@prisma/client');

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
    const paymentFailoverService  = req.app.get("paymentFailoverService");
    const mtnDisbursementService  = paymentFailoverService || req.app.get("mtnDisbursementService"); // failover-aware
    const emailService            = req.app.get('emailService');
    const smsService              = req.app.get('smsService');

    try {
        const { amount, payoutMethod, recipientPhone, destination } = req.body;
        const userId = req.user.id;

        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid withdrawal amount.' });
        }

        // Fraud detection check
        const accountAgeMs = Date.now() - new Date(req.user.createdAt || req.user.created_at || Date.now()).getTime();
        const accountAgeHours = accountAgeMs / (1000 * 60 * 60);
        const fraudResult = await fraudService.evaluate({
            userId: req.user.id,
            type: 'WITHDRAWAL',
            amount: parseFloat(amount),
            accountAgeHours,
        });
        if (!fraudResult.allowed) {
            logger.warn({ userId: req.user.id, rules: fraudResult.triggeredRules }, '[fiatWithdrawal] Blocked by fraud detection');
            return res.status(403).json({
                success: false,
                message: 'Transaction blocked by security checks. Please contact support.',
                code: 'FRAUD_BLOCKED',
                triggeredRules: fraudResult.triggeredRules,
            });
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
        // P0 financial integrity: if the user opts to spend AZM for a fee
        // discount, the AZM debit now runs INSIDE the canonical withdrawal
        // transaction (via the reservation callback below) on the same tx as
        // the fiat pool reservation, the USDC debit and the TransactionHistory
        // row. A failed reservation can therefore never leave a committed AZM
        // spend behind, and a provider reversal restores it exactly once.
        let feeDiscountTier = null;
        const feeDiscountTierId = req.body.feeDiscountTierId; // optional: 'tier_25' | 'tier_50' | 'tier_100'
        const azmSpendService = req.app.get('azmSpendService');
        if (feeDiscountTierId) {
            if (!azmSpendService) {
                return res.status(400).json({
                    success: false,
                    code: 'AZM_SPEND_FAILED',
                    message: 'Fee discounts are temporarily unavailable.'
                });
            }
            // Validate the tier against the existing catalog BEFORE entering
            // the transaction. The catalog stays the single source of truth;
            // the client-supplied multiplier is never trusted as authority.
            feeDiscountTier = FEE_DISCOUNT_TIERS.find(t => t.id === feeDiscountTierId) || null;
            if (!feeDiscountTier) {
                return res.status(400).json({
                    success: false,
                    code: 'AZM_SPEND_FAILED',
                    message: `Invalid fee discount tier: ${feeDiscountTierId}`
                });
            }
        }

        const data = await financeService.processFiatWithdrawal(
            prisma,
            userId,
            parseFloat(amount),
            {
                reference,
                feeDiscountMultiplier: feeDiscountTier?.discount || 0,
                reserveFeeDiscountInTransaction: feeDiscountTier && azmSpendService
                    ? (tx) => azmSpendService.applyFeeDiscountInTransaction(
                        tx, userId, feeDiscountTierId, reference
                    )
                    : null
            }
        );

        // P0: emit the AZM spend realtime update exactly once, POST-COMMIT.
        // The debit already committed inside the withdrawal transaction, so
        // this event can never surface for a rolled-back withdrawal.
        if (data.azmFeeDiscount?.debited && azmSpendService) {
            azmSpendService.emitFeeDiscountSpend(
                userId,
                data.azmFeeDiscount.newBalance,
                data.azmFeeDiscount.azmSpent,
                `${feeDiscountTier.label} fee discount on withdrawal (-${feeDiscountTier.cost} AZM)`
            );
        }

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
            logger.warn('[fiatWithdrawal] Withdrawal mirror row insert failed:', rowErr.message);
        }

        // B-11: notify admins of a large pending withdrawal (fire-and-forget,
        // never blocks the payout). Guarded by the service's own threshold.
        if (withdrawalRow) {
            const alertService = req.app.get('adminAlertService');
            if (alertService && alertService.isLargeWithdrawal(parseFloat(amount))) {
                setImmediate(() => alertService.emit('LARGE_WITHDRAWAL_PENDING', {
                    withdrawalId: withdrawalRow.id,
                    userId,
                    amount: parseFloat(amount),
                    destination: phone,
                }));
            }
        }

        // Step 3 — Dispatch payout to MTN MoMo. On synchronous failure, fully
        // reverse the ledger so the user is not silently debited.
        if (!mtnDisbursementService) {
            logger.error('[fiatWithdrawal] mtnDisbursementService is not bound to the app context.');
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
                payerMessage:   `Azaman withdrawal ref ${reference}`,
                payeeNote:      `Withdrawal ${reference}`
            });

            // Low-liquidity admin alert (post-dispatch so the user is not blocked).
            if (data.fiatPoolLow) {
                const alertMsg =
                    `AI LIQUIDITY FLAG: SYSTEM_FIAT_POOL dropped to ` +
                    `$${data.fiatPoolBalance.toFixed(2)} ` +
                    `(threshold: $${FIAT_POOL_ALERT_THRESH}). Immediate replenishment required.`;
                logger.warn(`[LIQUIDITY ALERT] ${alertMsg}`);
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
                    logger.error({ err: alertErr }, '[fiatWithdrawal] liquidity alert emit failed');
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

            await audit(prisma, {
                actorId: userId, actorName: req.user.username,
                action: 'WITHDRAWAL_FIAT_INITIATED', targetType: 'TRANSACTION',
                targetId: String(withdrawalRow?.id || reference),
                metadata: { amountGhs: amount, provider: payoutMethod, reference }, ipAddress: req.ip,
            });

            return res.status(200).json({
                success: true,
                message: `Withdrawal dispatched to MTN MoMo. Reference: ${reference}`,
                // Top-level `reference` so the Flutter WithdrawalProgressSheet can
                // open immediately and subscribe to withdrawal_progress / poll
                // GET /api/withdraw/status/:reference without parsing the message.
                reference,
                data: {
                    ...data,
                    reference,
                    withdrawalId: withdrawalRow ? withdrawalRow.id : null,
                    dispatch
                }
            });
        } catch (mtnErr) {
            logger.error({ err: mtnErr }, '[fiatWithdrawal] MTN dispatch failed — unwinding ledger');
            let reversalSucceeded = false;
            try {
                await financeService.reverseFiatWithdrawal(prisma, reference, {
                    reason: `mtn_dispatch_failed: ${mtnErr.message}`
                });
                reversalSucceeded = true;
            } catch (reverseErr) {
                // If the reversal itself fails the system is in an
                // inconsistent state — flag loudly so an admin investigates.
                logger.error({ err: reverseErr }, '[fiatWithdrawal] CRITICAL: reversal failed after MTN error');
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
        logger.error({ err: error }, '[fiatWithdrawal] error');

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
                logger.error({ err: freezeErr }, '[fiatWithdrawal] Failed to write freeze record');
            }

            return res.status(403).json({
                success: false,
                message: 'Withdrawal frozen: Ledger inconsistency detected. Your request has been flagged for review.',
                data:    { status: 'FROZEN_DISPUTE' }
            });
        }

        // P0: the AZM fee-discount debit now runs inside the withdrawal
        // transaction — surface insufficient-AZM failures with the same
        // AZM_SPEND_FAILED contract the FE already handles.
        if (error.code === 'AZM_SPEND_FAILED') {
            return res.status(400).json({
                success: false,
                code: 'AZM_SPEND_FAILED',
                message: error.message
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

    // §P.2: KMS-capable custody execution boundary. The ONLY external crypto
    // execution path — no raw Tatum payloads are constructed here, no fake tx
    // hashes exist, and the withdrawal may only reach COMPLETED on real chain
    // evidence (verified by the custody execution service, not by an HTTP 200).
    const custody = require('../services/tatumCustodyExecutionService');
    const { CustodyExecutionError } = require('../services/custodyExecutionErrors');

    try {
        const { amount, destination, network } = req.body;
        const userId = req.user.id;

        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid withdrawal amount.' });
        }
        if (!destination) {
            return res.status(400).json({ success: false, message: 'Destination wallet address is required.' });
        }
        // Strict destination validation through the custody boundary (also
        // rejects zero address / token contract / hot wallet as destinations).
        const destAddress = custody.validateDestination(String(destination));

        // EXACT monetary amounts: the authoritative representation is integer
        // base units; every customer-facing Decimal below is derived from the
        // exact base units via an exact string (never binary floating point).
        // Floats that remain (fraud heuristics, alert thresholds, messages)
        // are non-authoritative risk-scoring/display semantics only.
        const amountBase = custody.toBaseUnits(amount); // throws on >6 decimals/NaN/negative/zero
        const amountFloat = parseFloat(amount); // NON-AUTHORITATIVE: fraud scoring/alerts only
        const amountExact = custody.baseUnitsToDecimalString(amountBase); // "100.123456"

        // Fraud detection check (non-blocking for alerts, blocking for BLOCK severity)
        const accountAgeMs = Date.now() - new Date(req.user.createdAt || req.user.created_at || Date.now()).getTime();
        const accountAgeHours = accountAgeMs / (1000 * 60 * 60);
        const fraudResult = await fraudService.evaluate({
            userId: req.user.id,
            type: 'WITHDRAWAL',
            amount: amountFloat,
            accountAgeHours,
        });
        if (!fraudResult.allowed) {
            logger.warn({ userId: req.user.id, rules: fraudResult.triggeredRules }, '[cryptoWithdrawal] Blocked by fraud detection');
            return res.status(403).json({
                success: false,
                message: 'Transaction blocked by security checks. Please contact support.',
                code: 'FRAUD_BLOCKED',
                triggeredRules: fraudResult.triggeredRules,
            });
        }

        // Double-Check before touching any balances
        await runDoubleCheck(prisma, userId);

        // ── Gas fee PRODUCT POLICY (unchanged: 100% user-borne estimate) ─────
        // This is a customer CHARGE, not a realized network cost. Actual
        // on-chain gas is recorded from chain evidence only (§P.2); the
        // estimate below never becomes "realized gas revenue".
        let maticUsdcRate = 0.55; // Safe fallback
        try {
            const oracleRes = await axios.get(
                'https://api.coingecko.com/api/v3/simple/price',
                { params: { ids: 'matic-network', vs_currencies: 'usd' }, timeout: 5000 }
            );
            maticUsdcRate = oracleRes.data?.['matic-network']?.usd || 0.55;
        } catch {
            logger.warn('[cryptoWithdrawal] Oracle unreachable — using fallback MATIC rate 0.55 USD');
        }

        const gasFeeUsdc = parseFloat((POLYGON_GAS_FEE_MATIC * maticUsdcRate).toFixed(6));
        const feeBaseUnits  = custody.toBaseUnits(gasFeeUsdc.toFixed(6));
        const payoutBaseUnits = amountBase - feeBaseUnits;
        if (payoutBaseUnits <= 0n) {
            return res.status(400).json({
                success: false,
                message: `Withdrawal amount (${amountExact} USDC) is too low to cover the Polygon network gas fee (~${gasFeeUsdc} USDC).`
            });
        }
        // EXACT net payout derived from base units — no Number()/1e6, no BigInt
        // division truncation, no binary floating point anywhere authoritative.
        const netPayoutExact = custody.baseUnitsToDecimalString(payoutBaseUnits);
        const feeExact = custody.baseUnitsToDecimalString(feeBaseUnits);

        // ── §P.2 EXECUTION GATE — fail closed BEFORE any debit ───────────────
        // Real broadcasting requires TATUM_PROVIDER=LIVE + TATUM_KMS_ENABLED
        // + TATUM_CRYPTO_EXECUTION_ENABLED. Absent any flag: no broadcast, no
        // fake success, no fake tx hash, and NO customer debit.
        const gate = custody.executionGateStatus();
        if (!gate.enabled) {
            return res.status(503).json({
                success: false,
                code: 'CRYPTO_EXECUTION_NOT_ENABLED',
                message: 'On-chain crypto execution is not enabled on this deployment. No funds were debited.'
            });
        }
        // Non-destructive capability preflight (signer identity, master hot
        // wallet configuration, treasury/hot consistency, canonical asset).
        const pre = await custody.preflight(prisma);
        if (!pre.readyForLiveExecution) {
            return res.status(503).json({
                success: false,
                code: 'CRYPTO_EXECUTION_NOT_CONFIGURED',
                message: 'On-chain crypto execution is misconfigured on this deployment. No funds were debited.',
                data: { checks: pre.checks }
            });
        }

        const hotWalletAddress = custody.getConfig().hotWalletAddress;

        // ── ACID reservation: customer debit EXACTLY ONCE + durable execution ──
        // The ledger row starts PENDING with NO tx hash (hashes only ever come
        // from real provider/chain evidence). The CustodyExecution idempotency
        // key is derived from the ledger row, making the pair durable and
        // unique — a duplicate request can never double-debit.
        const result = await prisma.$transaction(async (tx) => {
            const user = await tx.user.findUnique({ where: { id: userId } });
            if (!user) throw new Error('User not found.');

            // EXACT decimal comparison/decrement — binary floating point is
            // never the authoritative financial quantity on this path.
            const requiredExact = new Prisma.Decimal(amountExact);
            if (user.availableBalance.lt(requiredExact)) {
                throw new Error(
                    `Insufficient balance. Required: ${amountExact} USDC, ` +
                    `available: ${user.availableBalance.toFixed(6)} USDC.`
                );
            }

            // Debit the FULL requested amount from the user (gas fee is internal)
            await tx.user.update({
                where: { id: userId },
                data:  { availableBalance: { decrement: requiredExact } }
            });

            // Synthetic treasury bookkeeping is intentionally unchanged (§P.3
            // will formalize custody accounting). The CustodyExecution record
            // is what later reconciles this against real chain evidence.
            await tx.systemHotWallet.upsert({
                where:  { id: 1 },
                update: { balance: { decrement: new Prisma.Decimal(netPayoutExact) } },
                create: { id: 1, balance: new Prisma.Decimal(netPayoutExact).neg() }
            });
            await tx.systemProfitFees.upsert({
                where:  { id: 1 },
                update: { balance: { increment: new Prisma.Decimal(feeExact) } },
                create: { id: 1, balance: new Prisma.Decimal(feeExact) }
            });

            // PENDING — NO txHash. COMPLETED happens only on verified chain
            // evidence via the custody execution service.
            const txRecord = await tx.transactionHistory.create({
                data: {
                    userId:     userId,
                    type:       'WITHDRAWAL_CRYPTO',
                    amountUsdc: new Prisma.Decimal(netPayoutExact), // exact, from base units
                    feeUsdc:    new Prisma.Decimal(feeExact),       // exact, from base units
                    txHash:     null,
                    status:     'PENDING'
                }
            });

            const execution = await custody.createWithdrawalExecution(tx, {
                idempotencyKey: `withdrawal:${txRecord.id}`,
                transactionHistoryId: txRecord.id,
                userId,
                fromAddress: hotWalletAddress,
                toAddress: destAddress,
                amountBaseUnits: payoutBaseUnits,
                feeChargeBaseUnits: feeBaseUnits,
                metadata: {
                    customerDebitBaseUnits: String(amountBase),
                    netPayoutBaseUnits: String(payoutBaseUnits),
                    withdrawalAmountExact: amountExact,
                    gasFeeExact: feeExact,
                    netPayoutExact,
                },
            });

            // Estimated gas charge audit trail (customer charge policy, NOT a
            // realized network cost claim).
            await tx.adminProfitLog.create({
                data: {
                    amountUsdc:  new Prisma.Decimal(feeExact),
                    source:      'GAS_FEE_REVENUE',
                    relatedTxId: `crypto_withdraw_charge_${txRecord.id}`
                }
            });

            // §P.4 AUTHORITATIVE ACCOUNTING — inside the SAME reservation
            // transaction as the customer debit, the PENDING ledger row and
            // the CustodyExecution:
            //   D user:{id}:liability  — customer owed less (full amount)
            //   C restricted:reserves  — funds reserved for the pending
            //                            external execution
            // The restricted obligation is persisted and LINKED to the
            // execution identity. It is released ONLY on verified settlement
            // (settleExecution) or definitive pre-broadcast failure refund.
            // AMBIGUOUS outcomes stay RECONCILIATION_REQUIRED — the
            // obligation is NEVER auto-refunded.
            const withdrawalReservation = await ledger.post(tx, {
                idempotencyKey: `ledger:withdrawal:crypto:execution:${execution.id}`,
                entryType: 'CUSTODY_WITHDRAWAL',
                description: 'Crypto withdrawal reservation (customer debit; external execution pending)',
                reference: `custody-exec:${execution.id}`,
                userId,
                relatedEntity: 'custodyExecution',
                relatedEntityId: execution.id,
                metadata: { status: 'PENDING', transactionHistoryId: txRecord.id },
                lines: [
                    { account: `user:${userId}:liability`, debit: amountExact },
                    { account: 'restricted:reserves', credit: amountExact },
                ],
            });
            await restrictedObligations.createForPendingWithdrawal(tx, {
                sourceType: 'PENDING_CRYPTO_WITHDRAWAL',
                reference: `withdrawal:crypto:${execution.id}`,
                userId,
                amount: amountExact,
                asset: 'USDC',
                network: 'POLYGON',
                sourceEntity: 'custodyExecution',
                sourceEntityId: execution.id,
                ledgerTransactionId: withdrawalReservation.transaction.id,
                domainStateRef: {
                    custodyExecutionId: execution.id,
                    transactionHistoryId: txRecord.id,
                    customerDebitBaseUnits: String(amountBase),
                    netPayoutBaseUnits: String(payoutBaseUnits),
                    feeChargeBaseUnits: String(feeBaseUnits),
                },
            });

            return { user, txRecord, execution };
        });

        // ── Four-eye: durable pre-validation of the EXACT intended transfer ──
        // Verifies destination, token contract, exact base-unit amount, source
        // signer, and the customer withdrawal reference against the stored
        // execution before anything can be submitted to KMS.
        await custody.approveKmsRequest(prisma, {
            executionId: result.execution.id,
            expected: {
                kind:           'CUSTOMER_WITHDRAWAL',
                refId:          String(result.txRecord.id),
                userId,
                fromAddress:    hotWalletAddress,
                toAddress:      destAddress,
                contractAddress: custody.CANONICAL.contractAddress,
                amountBaseUnits: payoutBaseUnits,
            },
        });

        // ── Async external execution via KMS ─────────────────────────────────
        try {
            const submission = await custody.submitExecution(prisma, { executionId: result.execution.id });

            if (emitBalanceUpdate) await emitBalanceUpdate(userId);

            await audit(prisma, {
                userId,
                action: 'WITHDRAWAL_CRYPTO_INITIATED',
                targetType: 'USER',
                targetId: String(userId),
                ipAddress: req.ip,
                metadata: {
                    executionId: result.execution.id,
                    destination,
                    network: network || 'Polygon',
                    amountUsdc: amountFloat,
                    status: submission.status,
                },
            });

            // NO success/completion claim here: the transfer is in flight. No
            // receipt is sent until settlement produces real chain evidence.
            return res.status(202).json({
                success: true,
                message: 'Withdrawal accepted. The on-chain transfer is being processed and will complete once confirmed on Polygon.',
                data: {
                    status:            'PENDING',
                    executionId:       result.execution.id,
                    transactionId:     result.txRecord.id,
                    withdrawalAmount:  amountExact,      // exact, from base units
                    gasFeeMatic:       POLYGON_GAS_FEE_MATIC,
                    maticUsdcRate,
                    gasFeeUsdc,
                    netPayout:         netPayoutExact,   // exact, from base units
                    gasFeePolicy:      'USER_BEARS_100_PERCENT',
                    destination,
                    network:           network || 'Polygon',
                    newBalance:        result.user.availableBalance.minus(new Prisma.Decimal(amountExact)).toFixed(6),
                }
            });
        } catch (execErr) {
            // ── Ambiguous external outcome (timeout/network/5xx/unusable
            // evidence): the service already marked the execution
            // RECONCILIATION_REQUIRED. NEVER auto-refund — reconciliation must
            // first prove no transfer happened. The customer's funds stay
            // reserved against the PENDING ledger row.
            if (!(execErr instanceof CustodyExecutionError) || !execErr.definitivePreBroadcast) {
                logger.error({ err: execErr.message, executionId: result.execution.id },
                    '[cryptoWithdrawal] AMBIGUOUS execution outcome — reconciliation required, NO auto-refund');
                if (io) {
                    io.emit('admin_alert', {
                        type: 'CRYPTO_WITHDRAWAL_RECONCILIATION_REQUIRED',
                        userId,
                        executionId: result.execution.id,
                        transactionId: result.txRecord.id,
                        detail: 'Provider outcome unknown — funds stay reserved until reconciliation proves what happened.',
                        timestamp: new Date().toISOString()
                    });
                }
                if (emitBalanceUpdate) await emitBalanceUpdate(userId);
                return res.status(202).json({
                    success: true,
                    message: 'Withdrawal accepted and is being verified with the network. You will be notified once the transfer is confirmed.',
                    data: {
                        status: 'PENDING',
                        reconciliationRequired: true,
                        transactionId: result.txRecord.id,
                        destination
                    }
                });
            }

            // ── DEFINITIVE pre-broadcast failure: exactly-once refund, atomic
            // with the execution's FAILED transition (conditional transition
            // guarantees a retry/repeat can never double-refund).
            const fail = await custody.failWithdrawalExecution(prisma, {
                executionId: result.execution.id,
                errorClass: execErr.errorClass,
                errorMessage: execErr.message,
                refund: async (tx) => {
                    // EXACT refund amounts derived from the same base units
                    // that produced the debit — no floating-point drift.
                    await tx.user.update({
                        where: { id: userId },
                        data:  { availableBalance: { increment: new Prisma.Decimal(amountExact) } }
                    });
                    // §P.4 authoritative reversal — atomic with the refund
                    // projection credit and the FAILED execution transition.
                    // Applies ONLY when the §P.4 reservation exists (legacy
                    // executions have no ledger truth to reverse):
                    //   D restricted:reserves — reservation returns
                    //   C user:{id}:liability — customer owed the refund
                    // Exactly-once: the reservation posting cannot exist
                    // twice, and the obligation cancel is a conditional
                    // single-winner claim.
                    const reservation = await tx.restrictedObligation.findFirst({
                        where: { reference: `withdrawal:crypto:${result.execution.id}`, status: 'ACTIVE' },
                    });
                    if (!reservation) return; // legacy execution — no ledger truth to reverse
                    const reversal = await ledger.post(tx, {
                        idempotencyKey: `ledger:withdrawal:crypto:refund:${result.execution.id}`,
                        entryType: 'CUSTODY_WITHDRAWAL',
                        description: 'Crypto withdrawal refund — definitive pre-broadcast failure',
                        reference: `custody-exec:${result.execution.id}`,
                        userId,
                        relatedEntity: 'custodyExecution',
                        relatedEntityId: result.execution.id,
                        metadata: { status: 'REFUNDED' },
                        lines: [
                            { account: 'restricted:reserves', debit: amountExact },
                            { account: `user:${userId}:liability`, credit: amountExact },
                        ],
                    });
                    await restrictedObligations.cancelOnReversal(tx, {
                        reference: `withdrawal:crypto:${result.execution.id}`,
                        releaseLedgerTransactionId: reversal.transaction.id,
                    });
                    await tx.systemHotWallet.update({
                        where: { id: 1 },
                        data:  { balance: { increment: new Prisma.Decimal(netPayoutExact) } }
                    });
                    await tx.systemProfitFees.update({
                        where: { id: 1 },
                        data:  { balance: { decrement: new Prisma.Decimal(feeExact) } }
                    });
                    await tx.transactionHistory.update({
                        where: { id: result.txRecord.id },
                        data:  { status: 'FAILED' }
                    });
                    await tx.adminProfitLog.create({
                        data: {
                            amountUsdc:   new Prisma.Decimal(feeExact).neg(),
                            source:       'GAS_FEE_REVENUE',
                            relatedTxId:  `crypto_withdraw_refund_${result.txRecord.id}`,
                            isSubsidized: true
                        }
                    });
                },
            });

            if (emitBalanceUpdate) await emitBalanceUpdate(userId);

            if (fail.failed && emailService && result.user && result.user.email) {
                const recipient = result.user;
                setImmediate(() => {
                    emailService.sendWithdrawalReceipt(recipient, {
                        kind:           'crypto_refund',
                        amount:         amountFloat,
                        refundedAmount: amountFloat,
                        destination,
                        network:        network || 'Polygon',
                        reason:         execErr.message || 'On-chain broadcast was rejected by the gateway.'
                    }).catch(() => { /* swallowed inside service */ });
                });
            }
            if (fail.failed && smsService && result.user && result.user.phoneNumber && result.user.phoneVerified
                && amountFloat >= SMS_LARGE_WITHDRAWAL_THRESHOLD) {
                const ph = result.user.phoneNumber;
                setImmediate(() => {
                    smsService.sendWithdrawalConfirmation(ph, {
                        kind:   'crypto_refunded',
                        amount: amountFloat,
                        reason: execErr.message || 'On-chain broadcast was rejected.'
                    }).catch(() => {});
                });
            }

            return res.status(502).json({
                success: false,
                message: 'On-chain broadcast was rejected. Your USDC has been refunded.',
                data:    { gatewayError: execErr.message, refunded: amountExact }
            });
        }

    } catch (error) {
        logger.error({ err: error }, '[cryptoWithdrawal] error');

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
                logger.error({ err: freezeErr }, '[cryptoWithdrawal] Failed to write freeze record');
            }

            return res.status(403).json({
                success: false,
                message: 'Withdrawal frozen: Ledger inconsistency detected. Your request has been flagged for review.',
                data:    { status: 'FROZEN_DISPUTE' }
            });
        }

        // Custody-boundary validation failures (destination/amount) are client
        // errors; everything else is a plain rejection.
        if (error instanceof CustodyExecutionError
            && (error.errorClass === 'INVALID_DESTINATION' || error.errorClass === 'INVALID_ASSET')) {
            return res.status(400).json({ success: false, message: error.message });
        }

        return res.status(400).json({ success: false, message: error.message });
    }
};

// =============================================================================
// GET /api/withdraw/status/:reference   (auth — owner only)
// Backend half of the real-time withdrawal progress popup. The Flutter
// WithdrawalProgressSheet polls this every 5s as a fallback for when the
// Socket.IO `withdrawal_progress` event is missed (Moolre down / network blip).
//
// `reference` is the canonical idempotency UUID minted in fiatWithdrawal and
// stored as TransactionHistory.txHash. We map the TransactionHistory.status
// onto a user-facing {stage,label,pct} triple. We additionally try to locate
// the mirror Withdrawal row (correlated by userId + amount + ±5s window, the
// same correlation the reconciliation worker uses) for admin/provider context.
// =============================================================================
exports.getWithdrawalStatus = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { reference } = req.params;
        if (!reference) {
            return res.status(400).json({ success: false, code: 'BAD_REQUEST', message: 'reference is required.' });
        }

        // Only return status for a withdrawal that belongs to the requester.
        const tx = await prisma.transactionHistory.findFirst({
            where: {
                txHash: reference,
                userId: req.user.id,
                type:   'WITHDRAWAL_FIAT'
            }
        });

        if (!tx) {
            return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'No withdrawal found for that reference.' });
        }

        // Try to locate the mirror Withdrawal row for the destination phone and
        // any provider tracking the reconciliation worker may have stored. The
        // Withdrawal model has no `reference`/`providerTxId` column, so we
        // correlate on userId + amount within the same wall-clock window — the
        // exact heuristic withdrawalReconciliationWorker uses. Non-fatal.
        let withdrawalRow = null;
        try {
            withdrawalRow = await prisma.withdrawal.findFirst({
                where: {
                    userId: req.user.id,
                    amount: tx.amountUsdc,
                    createdAt: {
                        gte: new Date(tx.createdAt.getTime() - 5_000),
                        lte: new Date(tx.createdAt.getTime() + 5_000)
                    }
                },
                orderBy: { createdAt: 'desc' }
            });
        } catch (_) { /* non-fatal — provider context simply omitted */ }

        // Map TransactionHistory.status → user-facing progress triple.
        const STAGE_MAP = {
            PENDING:   { stage: 'PROCESSING', label: 'Sending to your MoMo wallet...', pct: 40 },
            COMPLETED: { stage: 'COMPLETED',  label: 'Money sent successfully!',       pct: 100 },
            FAILED:    { stage: 'FAILED',     label: 'Transfer failed. Refund issued.', pct: 0 },
        };
        const mapped = STAGE_MAP[tx.status] || { stage: 'PROCESSING', label: 'Processing...', pct: 20 };

        // The Withdrawal model stores no providerTxId column today; expose it as
        // null until reconciliation persists it, so the Flutter contract is stable.
        const providerTxId = (withdrawalRow && withdrawalRow.providerTxId) || null;

        return res.status(200).json({
            success:      true,
            reference,
            status:       tx.status,
            stage:        mapped.stage,
            label:        mapped.label,
            pct:          mapped.pct,
            amountGhs:    tx.amountUsdc != null ? Number(tx.amountUsdc) : null,
            recipient:    withdrawalRow ? withdrawalRow.destination : null,
            providerTxId,
            updatedAt:    tx.createdAt ? tx.createdAt.toISOString() : null
        });
    } catch (error) {
        logger.error({ err: error }, '[getWithdrawalStatus] error');
        return res.status(500).json({ success: false, code: 'SERVER_ERROR', message: error.message });
    }
};
