// controllers/finance.controller.js
// =============================================================================
// AZAMAN V2 — FINANCE CONTROLLER   (Phase B v2: Arbitrage Fix)
//
// Thin HTTP adapter. Zero business logic — everything is delegated to
// services/finance.service.js.
//
// Phase B v2 change: the off-ramp is now decoupled from Kotani Pay V3.
// Kotani is still mounted on the server (used for on-ramp / corporate
// purchases and as the live retail-rate oracle), but the actual fiat
// PAYOUT to the user is now dispatched through MTN MoMo's Disbursement
// API via services/mtnDisbursementService.js. This is the architectural
// half of the fix in services/finance.service.js — Azaman now permanently
// retains the user's USDC in SYSTEM_MASTER_CRYPTO and pays them out from
// the local SYSTEM_FIAT_POOL, which lets the platform arbitrage the
// captured USDC at the OTC premium (see §1 / §4 of AZAMAN_MASTER_SOUL.md).
//
// Routes wired in routes/financeRoutes.js:
//   POST /api/finance/withdraw/fiat                   → fiatWithdrawal          (auth + ban guard)
//   POST /api/finance/admin/liquidate-profits         → liquidateProfits        (admin only)
//   POST /api/finance/webhook/deposit                 → cryptoDepositWebhook    (public, idempotent)

/**
 * Phase N helper: retrieve the singleton NotificationService from app context.
 */
function _getNotificationService(req) {
    const svc = req.app.get('notificationService');
    if (svc) return svc;
    const NotificationService = require('../services/notificationService');
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    return new NotificationService(prisma, io);
}
//   POST /api/finance/webhook/mtn-disbursement        → mtnDisbursementWebhook  (public, X-Mtn-Webhook-Secret)
//   GET  /api/finance/fiat-pool-status                → getFiatPoolStatus       (public read-only)
// =============================================================================

const financeService               = require('../services/finance.service');
const { FIAT_POOL_ALERT_THRESH }   = financeService;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Tier the fiat pool balance for the public status endpoint. */
const _classifyFiatPool = (balance) => {
    if (balance >= FIAT_POOL_ALERT_THRESH)        return 'HEALTHY';
    if (balance >= FIAT_POOL_ALERT_THRESH / 2)    return 'LIMITED';
    return 'CRITICAL';
};

// =============================================================================
// POST /api/finance/withdraw/fiat
// Authenticated user requests a fiat payout via the MTN MoMo Disbursement API.
// The user's USDC is permanently captured into SYSTEM_MASTER_CRYPTO; the
// equivalent GHS is debited from SYSTEM_FIAT_POOL and disbursed via MTN.
// =============================================================================
exports.fiatWithdrawal = async (req, res) => {
    const prisma                  = req.app.get('prisma');
    const io                      = req.app.get('socketio');
    const emitBalanceUpdate       = req.app.get('emitBalanceUpdate');
    const gatewayService          = req.app.get('gatewayService');           // rate oracle only
    const mtnDisbursementService  = req.app.get('mtnDisbursementService');   // off-ramp dispatch

    let reference = null;        // populated after the service debit so the
                                 // catch block can call reverseFiatWithdrawal.

    try {
        const { amount, recipientPhone, network, accountName } = req.body;
        const userId = req.user.id;

        // ── Validation ───────────────────────────────────────────────────────
        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid withdrawal amount.' });
        }
        if (!recipientPhone || typeof recipientPhone !== 'string' || recipientPhone.length < 9) {
            return res.status(400).json({
                success: false,
                message: 'recipientPhone is required (E.164 or local format, min 9 digits).'
            });
        }
        const networkChoice = (network || 'MTN').toString().toUpperCase();
        if (!['MTN', 'VODAFONE', 'AIRTELTIGO'].includes(networkChoice)) {
            return res.status(400).json({
                success: false,
                message: 'network must be one of: MTN, VODAFONE, AIRTELTIGO.'
            });
        }
        if (!gatewayService) {
            return res.status(503).json({
                success: false,
                message: 'Rate oracle (Kotani gateway) is not configured on this server.'
            });
        }
        if (!mtnDisbursementService) {
            return res.status(503).json({
                success: false,
                message: 'MTN MoMo disbursement service is not configured on this server.'
            });
        }

        const amountFloat = parseFloat(amount);

        // ── Pre-flight: pull live off-ramp rate from the oracle ──────────────
        // (Kotani Pay still serves the rate; only the disbursement is moved.)
        const rates     = await gatewayService.fetchOfframpRates();
        const payoutGhs = parseFloat((amountFloat * rates.retailRate).toFixed(2));

        // X-Reference-Id MUST be a UUID v4 — the MTN MoMo Disbursement API
        // uses it as the strict idempotency key for POST /v1_0/transfer.
        // We reuse the same UUID as TransactionHistory.txHash so the upstream
        // ledger and the downstream MoMo transfer share a single correlation.
        reference = mtnDisbursementService.newReferenceId();

        // ── Atomic debit + fee split + arbitrage capture (delegated) ─────────
        const data = await financeService.processFiatWithdrawal(
            prisma,
            userId,
            amountFloat,
            { reference, retailRate: rates.retailRate, payoutGhs }
        );

        // ── MTN MoMo disbursement (outside the DB transaction) ───────────────
        let disbursementResult;
        try {
            disbursementResult = await mtnDisbursementService.initiateTransfer({
                referenceId:    reference,
                amountGhs:      payoutGhs,
                recipientPhone,
                externalId:     `AZAMAN_${userId}_${Date.now()}`,
                payerMessage:   `Azaman fiat withdrawal #${data.transaction.id}`,
                payeeNote:      `Azaman MoMo payout (${networkChoice})`
            });
        } catch (gatewayErr) {
            console.error('[fiatWithdrawal] MTN MoMo dispatch failed:', gatewayErr.message);
            // Roll back the debit + the SystemMasterCrypto capture so the
            // user is not stuck and Azaman is not double-credited.
            try {
                const reversal = await financeService.reverseFiatWithdrawal(
                    prisma,
                    reference,
                    { reason: gatewayErr.message }
                );
                if (emitBalanceUpdate) await emitBalanceUpdate(userId);
                return res.status(502).json({
                    success: false,
                    code:    'MTN_DISBURSEMENT_REJECTED',
                    message: `MTN MoMo rejected the payout: ${gatewayErr.message}. Funds returned to your wallet.`,
                    data:    { reference, reversal }
                });
            } catch (reverseErr) {
                console.error('[fiatWithdrawal] CRITICAL reversal failure:', reverseErr.message);
                return res.status(500).json({
                    success: false,
                    code:    'MTN_DISBURSEMENT_REVERSAL_FAILED',
                    message:
                        `MTN MoMo rejected the payout AND reversal failed. ` +
                        `An admin has been notified. Reference: ${reference}.`,
                    data:    { reference }
                });
            }
        }

        // ── Real-time balance push ───────────────────────────────────────────
        if (emitBalanceUpdate) await emitBalanceUpdate(userId);

        // ── Liquidity alert if pool dropped below threshold ──────────────────
        if (data.fiatPoolLow) {
            const alertMsg =
                `AI LIQUIDITY FLAG: SYSTEM_FIAT_POOL dropped to ` +
                `$${data.fiatPoolBalance.toFixed(2)} ` +
                `(threshold: $${FIAT_POOL_ALERT_THRESH}). Immediate replenishment required.`;
            console.warn(`[LIQUIDITY ALERT] ${alertMsg}`);
            try {
                await _getNotificationService(req).sendNotification({
                    userId,
                    title:         'Liquidity Alert',
                    body:          alertMsg,
                    category:      'ADMIN_SYSTEM',
                    actionPayload: { action: 'OPEN_WAR_ROOM', fiatPool: data.fiatPoolBalance }
                });
                io.emit('admin_alert', {
                    type:      'LIQUIDITY_LOW',
                    fiatPool:  data.fiatPoolBalance,
                    threshold: FIAT_POOL_ALERT_THRESH,
                    timestamp: new Date().toISOString()
                });
            } catch (alertErr) {
                console.error('[fiatWithdrawal] Liquidity alert emit failed:', alertErr.message);
            }
        }

        return res.status(200).json({
            success: true,
            message:
                `Fiat withdrawal of ${data.withdrawalAmount} USDC accepted. ` +
                `Exit fee: ${data.exitFee} USDC. ${data.arbitrageCapture} USDC ` +
                `captured to SystemMasterCrypto. MTN MoMo status: ${disbursementResult.status}.`,
            data: {
                ...data,
                disbursement: {
                    provider:       disbursementResult.provider,
                    referenceId:    disbursementResult.referenceId,
                    externalId:     disbursementResult.externalId,
                    status:         disbursementResult.status,
                    amountGhs:      disbursementResult.amountGhs,
                    recipientPhone: disbursementResult.recipientPhone,
                    network:        networkChoice,
                    source:         disbursementResult.source
                }
            }
        });

    } catch (error) {
        console.error('[finance.fiatWithdrawal] error:', error.message);

        // Phase ADMIN-CONTROL-2 FIX 5: Fiat pool insufficient liquidity
        if (error.code === 'FIAT_POOL_INSUFFICIENT') {
            return res.status(503).json({
                success: false,
                code: 'FIAT_POOL_INSUFFICIENT',
                message: error.message
            });
        }

        // Double-Check failure → freeze record + 403
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
                console.error('[fiatWithdrawal] Freeze record write failed:', freezeErr.message);
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
// POST /api/finance/admin/liquidate-profits
// Admin moves funds from SystemProfitFees → SystemFiatPool.
// =============================================================================
exports.liquidateProfits = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io     = req.app.get('socketio');

    try {
        const { amountUsdc } = req.body;
        if (!amountUsdc || Number(amountUsdc) <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid liquidation amount.' });
        }

        const data = await financeService.liquidateProfits(prisma, parseFloat(amountUsdc), req.user.id);

        try {
            io.emit('admin_alert', {
                type:             'PROFIT_LIQUIDATION',
                amountLiquidated: data.amountLiquidated,
                newProfitFees:    data.newProfitFees,
                newFiatPool:      data.newFiatPool,
                timestamp:        new Date().toISOString()
            });
        } catch (socketErr) {
            console.error('[liquidateProfits] Socket emit failed:', socketErr.message);
        }

        return res.status(200).json({
            success: true,
            message: `Liquidated ${data.amountLiquidated} USDC from SystemProfitFees to SystemFiatPool.`,
            data
        });
    } catch (error) {
        console.error('[finance.liquidateProfits] error:', error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
};

// =============================================================================
// POST /api/finance/webhook/deposit  — crypto deposit listener (Tatum/Alchemy)
// =============================================================================
exports.cryptoDepositWebhook = async (req, res) => {
    const prisma            = req.app.get('prisma');
    const io                = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const { amount, txHash, address, userId } = req.body;
        if (!amount || !txHash) {
            return res.status(400).json({ success: false, message: 'Missing required fields: amount, txHash.' });
        }
        const amountUsdc   = parseFloat(amount);
        const targetUserId = parseInt(userId, 10);
        if (isNaN(amountUsdc) || amountUsdc <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid USDC amount.' });
        }
        if (!targetUserId || isNaN(targetUserId)) {
            return res.status(400).json({ success: false, message: 'userId is required in the webhook payload.' });
        }

        const result = await financeService.processCryptoDeposit(prisma, {
            userId:     targetUserId,
            amountUsdc,
            txHash,
            address
        });

        if (result.alreadyProcessed) {
            return res.status(200).json({
                success: true,
                message: 'Transaction already processed.',
                data:    { txHash, alreadyProcessed: true }
            });
        }

        await emitBalanceUpdate(targetUserId);
        io.to(`user_${targetUserId}`).emit('deposit_success', {
            type:       'DEPOSIT_CRYPTO',
            amount:     amountUsdc,
            txHash,
            newBalance: result.data.newBalance,
            timestamp:  new Date().toISOString()
        });

        try {
            await _getNotificationService(req).sendNotification({
                userId:        targetUserId,
                title:         '💰 Deposit Confirmed',
                body:          `${amountUsdc} USDC has been credited to your account.`,
                category:      'GENERAL',
                actionPayload: { action: 'OPEN_WALLET', txHash }
            });
        } catch (notifErr) {
            console.error('[cryptoDepositWebhook] Notification write failed:', notifErr.message);
        }

        return res.status(200).json({
            success: true,
            message: `Crypto deposit of ${amountUsdc} USDC confirmed for user ${targetUserId}.`,
            data:    result.data
        });
    } catch (error) {
        console.error('[finance.cryptoDepositWebhook] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// POST /api/finance/webhook/mtn-disbursement
// MTN MoMo Disbursement settlement webhook. Public route — secured by a
// shared secret. Idempotent: SUCCESSFUL on a COMPLETED row is a no-op;
// FAILED on a COMPLETED row triggers a reversal (which also unwinds the
// SystemMasterCrypto capture); either action on an already-FAILED row
// returns 200.
// =============================================================================
exports.mtnDisbursementWebhook = async (req, res) => {
    const prisma            = req.app.get('prisma');
    const io                = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const expectedSecret = process.env.MTN_WEBHOOK_SECRET;
        if (!expectedSecret) {
            console.error('[mtnDisbursementWebhook] MTN_WEBHOOK_SECRET is not configured.');
            return res.status(503).json({
                success: false,
                message: 'Webhook endpoint is not configured. Refusing to mutate ledger.'
            });
        }
        const providedSecret = req.headers['x-mtn-webhook-secret'];
        if (providedSecret !== expectedSecret) {
            return res.status(401).json({ success: false, message: 'Invalid webhook signature.' });
        }

        // Accept either MTN MoMo's native shape ({ referenceId, status, reason })
        // or our internal normalized shape ({ reference, status, message }).
        const body         = req.body || {};
        const reference    = body.reference   || body.referenceId  || null;
        const rawStatus    = body.status      || null;
        const providerTxId = body.providerTxId || body.financialTransactionId || null;
        const reasonText   = body.message     || body.reason || null;

        if (!reference || !rawStatus) {
            return res.status(400).json({
                success: false,
                message: 'reference (or referenceId) and status are required.'
            });
        }

        // Normalize MTN's terminal states. MTN sends 'SUCCESSFUL'|'FAILED'|
        // 'PENDING'; we also accept legacy 'SUCCESS' for compatibility.
        const upper = String(rawStatus).toUpperCase();
        let normalized;
        if (upper === 'SUCCESSFUL' || upper === 'SUCCESS') normalized = 'SUCCESSFUL';
        else if (upper === 'FAILED')                       normalized = 'FAILED';
        else if (upper === 'PENDING') {
            return res.status(200).json({
                success: true,
                message: 'PENDING status acknowledged; no ledger mutation.',
                data:    { reference, status: 'PENDING' }
            });
        } else {
            return res.status(400).json({
                success: false,
                message: 'status must be SUCCESSFUL, FAILED, or PENDING.'
            });
        }

        const original = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        if (!original) {
            return res.status(404).json({ success: false, message: 'Unknown reference.' });
        }
        if (original.type !== 'WITHDRAWAL_FIAT') {
            return res.status(409).json({
                success: false,
                message: `Reference ${reference} is not a fiat withdrawal.`
            });
        }

        // SUCCESSFUL on a COMPLETED row = no-op (the controller already wrote
        // the row COMPLETED at debit time; MTN is just confirming the GHS
        // landed in the user's MoMo wallet).
        if (normalized === 'SUCCESSFUL') {
            return res.status(200).json({
                success: true,
                message: 'Settlement confirmed.',
                data:    { reference, status: original.status, providerTxId: providerTxId || null }
            });
        }

        // FAILED — trigger atomic reversal (also unwinds SystemMasterCrypto).
        if (original.status === 'FAILED') {
            return res.status(200).json({
                success: true,
                message: 'Reference already in FAILED state. No-op.',
                data:    { reference, status: 'FAILED', alreadyReversed: true }
            });
        }

        const reversal = await financeService.reverseFiatWithdrawal(prisma, reference, {
            reason: reasonText || 'MTN MoMo reported FAILED via webhook.'
        });

        if (emitBalanceUpdate) await emitBalanceUpdate(reversal.userId);
        try {
            await _getNotificationService(req).sendNotification({
                userId:        reversal.userId,
                title:         'Withdrawal Reversed',
                body:
                    `The MTN MoMo payout for reference ${reference} could not be ` +
                    `completed. Funds (${reversal.refundedAmount} USDC) have been ` +
                    `returned to your wallet.`,
                category:      'GENERAL',
                actionPayload: { action: 'OPEN_WALLET', reference }
            });
        } catch (notifErr) {
            console.error('[mtnDisbursementWebhook] Notification write failed:', notifErr.message);
        }

        return res.status(200).json({
            success: true,
            message: 'Settlement failure handled — withdrawal reversed.',
            data:    reversal
        });
    } catch (error) {
        console.error('[finance.mtnDisbursementWebhook] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// POST /api/finance/webhook/moolre-disbursement
// Moolre Disbursement settlement webhook. Public route — secured by a shared
// secret header (X-Moolre-Webhook-Secret). This is the Moolre-shaped twin of
// mtnDisbursementWebhook above and reuses the EXACT same ledger semantics:
//   • SUCCESSFUL on a COMPLETED row  → no-op (debit already committed at dispatch)
//   • PENDING                        → 200, no ledger mutation
//   • FAILED                         → atomic reverseFiatWithdrawal (also unwinds
//                                      the SystemMasterCrypto capture)
//   • FAILED on an already-FAILED row → 200 no-op (idempotent)
//
// Accepts BOTH Moolre's universal envelope { status, code, message, data, go }
// (in which case the real fields live inside `data`) AND a flat normalized
// shape, so it works whether Moolre POSTs the raw envelope or you pre-flatten
// it at an edge. The transaction reference is matched against
// TransactionHistory.txHash — the same idempotency key dispatched in
// fiatWithdrawal — so upstream and downstream stay correlated.
// =============================================================================
exports.moolreDisbursementWebhook = async (req, res) => {
    const prisma            = req.app.get('prisma');
    const io                = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const expectedSecret = process.env.MOOLRE_WEBHOOK_SECRET;
        if (!expectedSecret) {
            console.error('[moolreDisbursementWebhook] MOOLRE_WEBHOOK_SECRET is not configured.');
            return res.status(503).json({
                success: false,
                message: 'Webhook endpoint is not configured. Refusing to mutate ledger.'
            });
        }
        // ⚠️ VERIFY: Moolre's callback authentication header name + scheme.
        // Defaulting to a shared-secret header (mirrors the MTN webhook). If
        // Moolre instead signs the body with an HMAC, swap this constant-time
        // compare for an HMAC verification over req.rawBody (already captured by
        // the express.json verify hook in server.js).
        const providedSecret = req.headers['x-moolre-webhook-secret'];
        if (providedSecret !== expectedSecret) {
            return res.status(401).json({ success: false, message: 'Invalid webhook signature.' });
        }

        // Moolre wraps payloads in { status, code, message, data, go }. When the
        // envelope is present, the transaction fields live inside `data`. Fall
        // back to the top-level body if it's already flattened.
        const body    = req.body || {};
        const payload = (body.data && typeof body.data === 'object') ? body.data : body;

        // ⚠️ VERIFY: the field names Moolre uses for the reference + status in
        // the callback. We check the common candidates so the handler is robust
        // to the exact key once confirmed.
        const reference    = payload.externalref || payload.reference || payload.externalId || null;
        const rawStatus    = payload.status || payload.txstatus || null;
        const providerTxId = payload.transactionid || payload.txid || payload.id || null;
        const reasonText   = payload.reason || body.message || null;

        if (!reference || rawStatus === null || rawStatus === undefined) {
            return res.status(400).json({
                success: false,
                message: 'reference (externalref) and status are required.'
            });
        }

        // Normalize Moolre's status onto AZM's terminal states. Moolre's success
        // sentinel may arrive as the integer 1 / string "1" (envelope-style) or
        // as a word ("SUCCESS"/"FAILED"/"PENDING"). Handle all three.
        const upper = String(rawStatus).toUpperCase();
        let normalized;
        if (upper === '1' || upper === 'SUCCESS' || upper === 'SUCCESSFUL' || upper === 'COMPLETED' || upper === 'PAID') {
            normalized = 'SUCCESSFUL';
        } else if (upper === 'PENDING' || upper === 'PROCESSING') {
            return res.status(200).json({
                success: true,
                message: 'PENDING status acknowledged; no ledger mutation.',
                data:    { reference, status: 'PENDING' }
            });
        } else if (upper === '0' || upper === 'FAILED' || upper === 'REJECTED' || upper === 'REVERSED' || upper === 'CANCELLED') {
            normalized = 'FAILED';
        } else {
            return res.status(400).json({
                success: false,
                message: `Unrecognized Moolre status: ${rawStatus}.`
            });
        }

        const original = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        if (!original) {
            return res.status(404).json({ success: false, message: 'Unknown reference.' });
        }
        if (original.type !== 'WITHDRAWAL_FIAT') {
            return res.status(409).json({
                success: false,
                message: `Reference ${reference} is not a fiat withdrawal.`
            });
        }

        // SUCCESSFUL on a COMPLETED row = no-op (the debit was already committed
        // at dispatch time; Moolre is just confirming the GHS landed).
        if (normalized === 'SUCCESSFUL') {
            return res.status(200).json({
                success: true,
                message: 'Settlement confirmed.',
                data:    { reference, status: original.status, providerTxId: providerTxId || null }
            });
        }

        // FAILED — trigger atomic reversal (also unwinds SystemMasterCrypto).
        if (original.status === 'FAILED') {
            return res.status(200).json({
                success: true,
                message: 'Reference already in FAILED state. No-op.',
                data:    { reference, status: 'FAILED', alreadyReversed: true }
            });
        }

        const reversal = await financeService.reverseFiatWithdrawal(prisma, reference, {
            reason: reasonText || 'Moolre reported FAILED via webhook.'
        });

        if (emitBalanceUpdate) await emitBalanceUpdate(reversal.userId);
        try {
            await _getNotificationService(req).sendNotification({
                userId:        reversal.userId,
                title:         'Withdrawal Reversed',
                body:
                    `The mobile-money payout for reference ${reference} could not be ` +
                    `completed. Funds (${reversal.refundedAmount} USDC) have been ` +
                    `returned to your wallet.`,
                category:      'GENERAL',
                actionPayload: { action: 'OPEN_WALLET', reference }
            });
        } catch (notifErr) {
            console.error('[moolreDisbursementWebhook] Notification write failed:', notifErr.message);
        }

        return res.status(200).json({
            success: true,
            message: 'Settlement failure handled — withdrawal reversed.',
            data:    reversal
        });
    } catch (error) {
        console.error('[finance.moolreDisbursementWebhook] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// GET /api/finance/fiat-pool-status   — public read-only
// Frontend uses this to render the "limited fiat" tag in the withdrawal UI.
// =============================================================================
exports.getFiatPoolStatus = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const pool = await prisma.systemFiatPool.findUnique({ where: { id: 1 } });
        const balance = pool?.balance ?? 0;
        const status  = _classifyFiatPool(balance);
        return res.status(200).json({
            success: true,
            data: {
                balance:    parseFloat(balance.toFixed(6)),
                threshold:  FIAT_POOL_ALERT_THRESH,
                status,                                    // 'HEALTHY' | 'LIMITED' | 'CRITICAL'
                lastUpdate: pool?.updatedAt || null
            }
        });
    } catch (error) {
        console.error('[finance.getFiatPoolStatus] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};
