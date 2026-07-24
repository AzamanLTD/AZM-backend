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
// PAYOUT to the user is now dispatched through Moolre's Disbursement
// API via services/moolreDisbursementService.js (all networks: MTN ch1,
// Telecel ch6, AirtelTigo ch7). This is the architectural half of the
// fix in services/finance.service.js — Azaman now permanently retains
// the user's USDC in SYSTEM_MASTER_CRYPTO and pays them out from the
// local SYSTEM_FIAT_POOL, which lets the platform arbitrage the captured
// USDC at the OTC premium (see §1 / §4 of AZAMAN_MASTER_SOUL.md).
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
const crypto                       = require('crypto');
const logger = require('../src/config/logger');

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
    const prisma                    = req.app.get('prisma');
    const io                        = req.app.get('socketio');
    const emitBalanceUpdate         = req.app.get('emitBalanceUpdate');
    const gatewayService            = req.app.get('gatewayService');             // rate oracle only
    const moolreDisbursementService = req.app.get('moolreDisbursementService'); // off-ramp dispatch

    let reference = null;        // populated after the service debit so the
                                 // catch block can call reverseFiatWithdrawal.

    try {
        const { amount, recipientPhone, network, accountName, savedAccountId } = req.body;
        const userId = req.user.id;

        // ── Saved MoMo account verification (Task 3) ───────────────────────
        // If the client passes a savedAccountId (the saved-momo account the
        // user selected as the payout destination), verify it belongs to the
        // user AND that isVerified === true before proceeding with the payout.
        // This prevents withdrawals to unverified / name-not-resolved numbers.
        if (savedAccountId) {
            const savedAccount = await prisma.savedMomoAccount.findUnique({
                where: { id: savedAccountId },
            });
            if (!savedAccount || savedAccount.userId !== userId) {
                return res.status(404).json({
                    success: false,
                    message: 'Saved payout account not found.'
                });
            }
            if (!savedAccount.isVerified) {
                return res.status(400).json({
                    success: false,
                    code: 'ACCOUNT_NOT_VERIFIED',
                    message: 'This payout account has not been verified. Please verify the number before withdrawing.'
                });
            }
        }

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
        let networkChoice = (network || 'MTN').toString().toUpperCase();
        // Accept TELECEL (primary) and VODAFONE (legacy alias → Telecel) for backward compat.
        if (!['MTN', 'TELECEL', 'VODAFONE', 'AIRTELTIGO'].includes(networkChoice)) {
            return res.status(400).json({
                success: false,
                message: 'network must be one of: MTN, TELECEL, or AIRTELTIGO.'
            });
        }
        // Canonicalise legacy VODAFONE → TELECEL so existing saved accounts still work.
        if (networkChoice === 'VODAFONE') networkChoice = 'TELECEL';
        if (!gatewayService) {
            return res.status(503).json({
                success: false,
                message: 'Rate oracle (Kotani gateway) is not configured on this server.'
            });
        }
        if (!moolreDisbursementService) {
            return res.status(503).json({
                success: false,
                message: 'Moolre disbursement service is not configured on this server.'
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
        reference = moolreDisbursementService.newReferenceId();

        // ── Atomic debit + fee split + arbitrage capture (delegated) ─────────
        const data = await financeService.processFiatWithdrawal(
            prisma,
            userId,
            amountFloat,
            { reference, retailRate: rates.retailRate, payoutGhs }
        );

        // ── Moolre disbursement (outside the DB transaction) ────────────────
        // Routes ALL networks through Moolre: MTN=ch1, Telecel=ch6, AT=ch7.
        let disbursementResult;
        try {
            disbursementResult = await moolreDisbursementService.initiateTransfer({
                referenceId:    reference,
                amountGhs:      payoutGhs,
                recipientPhone,
                network:        networkChoice,   // MTN | TELECEL | AIRTELTIGO — Moolre maps to channel
                externalId:     `AZAMAN_${userId}_${Date.now()}`,
                payerMessage:   `Azaman withdrawal ref ${reference}`,
                payeeNote:      `Azaman MoMo payout (${networkChoice})`
            });
        } catch (gatewayErr) {
            logger.error({ err: gatewayErr }, '[fiatWithdrawal] Moolre dispatch failed');
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
                    code:    'MOOLRE_DISBURSEMENT_REJECTED',
                    message: `Payout rejected: ${gatewayErr.message}. Funds returned to your wallet.`,
                    data:    { reference, reversal }
                });
            } catch (reverseErr) {
                logger.error({ err: reverseErr }, '[fiatWithdrawal] CRITICAL reversal failure');
                return res.status(500).json({
                    success: false,
                    code:    'MOOLRE_DISBURSEMENT_REVERSAL_FAILED',
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
            logger.warn(`[LIQUIDITY ALERT] ${alertMsg}`);
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
                logger.error({ err: alertErr }, '[fiatWithdrawal] Liquidity alert emit failed');
            }
        }

        return res.status(200).json({
            success: true,
            message:
                `Fiat withdrawal of ${data.withdrawalAmount} USDC accepted. ` +
                `Exit fee: ${data.exitFee} USDC. ${data.arbitrageCapture} USDC ` +
                `captured to SystemMasterCrypto. Moolre disbursement status: ${disbursementResult.status}.`,
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
        logger.error({ err: error }, '[finance.fiatWithdrawal] error');

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
                logger.error({ err: freezeErr }, '[fiatWithdrawal] Freeze record write failed');
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
            logger.error({ err: socketErr }, '[liquidateProfits] Socket emit failed');
        }

        return res.status(200).json({
            success: true,
            message: `Liquidated ${data.amountLiquidated} USDC from SystemProfitFees to SystemFiatPool.`,
            data
        });
    } catch (error) {
        logger.error({ err: error }, '[finance.liquidateProfits] error');
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
                actionPayload: { action: 'OPEN_WALLET', reference: txHash }
            });
        } catch (notifErr) {
            logger.error({ err: notifErr }, '[cryptoDepositWebhook] Notification write failed');
        }

        return res.status(200).json({
            success: true,
            message: `Crypto deposit of ${amountUsdc} USDC confirmed for user ${targetUserId}.`,
            data:    result.data
        });
    } catch (error) {
        logger.error({ err: error }, '[finance.cryptoDepositWebhook] error');
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
            logger.error('[mtnDisbursementWebhook] MTN_WEBHOOK_SECRET is not configured.');
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
            logger.error({ err: notifErr }, '[mtnDisbursementWebhook] Notification write failed');
        }

        return res.status(200).json({
            success: true,
            message: 'Settlement failure handled — withdrawal reversed.',
            data:    reversal
        });
    } catch (error) {
        logger.error({ err: error }, '[finance.mtnDisbursementWebhook] error');
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
            logger.error('[moolreDisbursementWebhook] MOOLRE_WEBHOOK_SECRET is not configured.');
            return res.status(503).json({
                success: false,
                message: 'Webhook endpoint is not configured. Refusing to mutate ledger.'
            });
        }
        // ── Authentication: support BOTH a shared-secret header AND an HMAC ────
        // signature over the raw body. Moolre's exact scheme is unconfirmed, so
        // we accept either:
        //   1. Shared secret  → X-Moolre-Webhook-Secret === MOOLRE_WEBHOOK_SECRET
        //   2. HMAC-SHA256     → hex(HMAC(MOOLRE_WEBHOOK_SECRET, rawBody)) matches
        //      one of the common signature headers, compared in constant time.
        // req.rawBody is captured by the express.json verify hook in server.js.
        const providedSecret = req.headers['x-moolre-webhook-secret'];
        const signatureHeaderNames = ['x-moolre-signature', 'x-signature', 'x-webhook-signature'];
        const providedSignature = signatureHeaderNames
            .map((h) => req.headers[h])
            .find((v) => typeof v === 'string' && v.length > 0) || null;

        let authPassed = false;
        if (typeof providedSecret === 'string' && providedSecret.length > 0) {
            // (1) Shared-secret path (existing behaviour).
            authPassed = providedSecret === expectedSecret;
        } else if (providedSignature) {
            // (2) HMAC-SHA256 path over the raw request body.
            try {
                const expectedSig = crypto
                    .createHmac('sha256', expectedSecret)
                    .update(req.rawBody || '')
                    .digest('hex');
                const a = Buffer.from(providedSignature, 'utf8');
                const b = Buffer.from(expectedSig, 'utf8');
                // timingSafeEqual throws on length mismatch — guard first.
                authPassed = a.length === b.length && crypto.timingSafeEqual(a, b);
            } catch (sigErr) {
                logger.error({ err: sigErr }, '[moolreDisbursementWebhook] HMAC verification error');
                authPassed = false;
            }
        } else {
            // Neither a shared-secret header nor a signature header is present.
            return res.status(401).json({ success: false, message: 'Missing webhook authentication.' });
        }

        if (!authPassed) {
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

        // Normalize Moolre's status onto AZM's terminal states.
        //
        // ✅ CONFIRMED 2026-07-09 against docs.moolre.com/ai/list-account-transactions.md
        // (whose `status` filter param and `txstatus` response field share the
        // same enum): Moolre's txstatus is NUMERIC — 0=Pending, 1=Success,
        // 2=Failed. This branch previously treated '0' as FAILED and had no
        // case at all for '2' (the REAL failed code, which fell through to the
        // 400 "Unrecognized status" branch) — meaning a genuine Moolre payout
        // failure would never trigger reverseFiatWithdrawal, and a merely
        // still-processing payout (txstatus=0) would have been wrongly
        // reported/refunded as failed. Fixed: 0→PENDING, 1→SUCCESSFUL, 2→FAILED,
        // with the original word-based sentinels kept as a defensive fallback.
        const upper = String(rawStatus).toUpperCase();
        let normalized;
        if (upper === '1' || upper === 'SUCCESS' || upper === 'SUCCESSFUL' || upper === 'COMPLETED' || upper === 'PAID') {
            normalized = 'SUCCESSFUL';
        } else if (upper === '0' || upper === 'PENDING' || upper === 'PROCESSING') {
            // Emit a real-time PROCESSING tick to the user's progress popup, then
            // acknowledge without mutating the ledger (debit already committed at
            // dispatch). `original` is fetched below for SUCCESS/FAILED, but on
            // the PENDING path we only have `reference`, so look up the userId for
            // the room. Non-fatal if it can't be resolved.
            setImmediate(async () => {
                try {
                    if (!io) return;
                    const row = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
                    if (!row) return;
                    io.to(`user_${row.userId}`).emit('withdrawal_progress', {
                        reference,
                        status:    'PENDING',
                        stage:     'PROCESSING',
                        label:     'Transfer in progress...',
                        pct:       60,
                        timestamp: new Date().toISOString()
                    });
                } catch (emitErr) {
                    logger.error({ err: emitErr }, '[moolreDisbursementWebhook] Socket emit failed');
                }
            });
            return res.status(200).json({
                success: true,
                message: 'PENDING status acknowledged; no ledger mutation.',
                data:    { reference, status: 'PENDING' }
            });
        } else if (upper === '2' || upper === 'FAILED' || upper === 'REJECTED' || upper === 'REVERSED' || upper === 'CANCELLED') {
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
            // Real-time push to the user's withdrawal progress popup so it flips
            // to the success state instantly without waiting for the 5s poll.
            setImmediate(() => {
                try {
                    const userId = original.userId;
                    if (io) {
                        io.to(`user_${userId}`).emit('withdrawal_progress', {
                            reference,
                            status:       'COMPLETED',
                            stage:        'COMPLETED',
                            label:        'Money sent to your MoMo wallet!',
                            pct:          100,
                            amountGhs:    original.amountUsdc != null ? Number(original.amountUsdc) : null,
                            providerTxId: providerTxId || null,
                            timestamp:    new Date().toISOString()
                        });
                    }
                } catch (emitErr) {
                    logger.error({ err: emitErr }, '[moolreDisbursementWebhook] Socket emit failed');
                }
            });

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

        // Real-time push to the user's withdrawal progress popup so it flips to
        // the failed/refunded state instantly without waiting for the 5s poll.
        setImmediate(() => {
            try {
                if (io) {
                    io.to(`user_${original.userId}`).emit('withdrawal_progress', {
                        reference,
                        status:    'FAILED',
                        stage:     'FAILED',
                        label:     'Transfer failed. Your balance has been refunded.',
                        pct:       0,
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (emitErr) {
                logger.error({ err: emitErr }, '[moolreDisbursementWebhook] Socket emit failed');
            }
        });

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
            logger.error({ err: notifErr }, '[moolreDisbursementWebhook] Notification write failed');
        }

        return res.status(200).json({
            success: true,
            message: 'Settlement failure handled — withdrawal reversed.',
            data:    reversal
        });
    } catch (error) {
        logger.error({ err: error }, '[finance.moolreDisbursementWebhook] error');
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

        const bannerTexts = {
            HEALTHY: 'Withdrawals are operating normally.',
            LIMITED: 'Fiat withdrawal capacity is temporarily limited. Please try again later if you encounter issues.',
            CRITICAL: 'Fiat withdrawals are temporarily unavailable due to low liquidity. We are replenishing the pool.',
        };

        return res.status(200).json({
            success: true,
            data: {
                balance:    parseFloat(balance.toFixed(6)),
                threshold:  FIAT_POOL_ALERT_THRESH,
                status,                                    // 'HEALTHY' | 'LIMITED' | 'CRITICAL'
                bannerText: bannerTexts[status],
                lastUpdate: pool?.updatedAt || null
            }
        });
    } catch (error) {
        logger.error({ err: error }, '[finance.getFiatPoolStatus] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// C-4: GET /api/finance/transactions/:id/receipt — structured PDF data
// =============================================================================
exports.getTransactionReceipt = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const txn = await prisma.transactionHistory.findFirst({
            where: { id: req.params.id, userId: req.user.id },
        });
        if (!txn) {
            return res.status(404).json({ success: false, message: 'Not found.' });
        }
        const user = await prisma.user.findUnique({
            where:  { id: req.user.id },
            select: { username: true, azamanId: true, email: true },
        });
        return res.json({
            success: true,
            receipt: {
                id:           txn.id,
                type:         txn.type,
                amountUsdc:   txn.amountUsdc,
                feeUsdc:      txn.feeUsdc,
                status:       txn.status,
                createdAt:    txn.createdAt,
                providerRef:  txn.providerRef,
                metadata:     txn.metadata,
                user: {
                    username: user.username,
                    azamanId: user.azamanId,
                    email:    user.email,
                },
                generatedAt:  new Date().toISOString(),
                platform:     'Azaman',
                footerNote:   'This is an official Azaman transaction receipt.',
            }
        });
    } catch (error) {
        logger.error({ err: error }, '[finance.getTransactionReceipt] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// B-9: GET /api/finance/transactions
// Authenticated user's own transaction history with optional filters.
// Query params: type?, status?, startDate?, endDate?, filter?, cursor?, limit?
// =============================================================================
exports.getTransactionHistory = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { type, status, startDate, endDate, q, filter } = req.query;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
        const cursor = req.query.cursor || null;

        const where = { userId };

        if (filter) {
            const f = String(filter).toUpperCase();
            if (f === 'IN')       where.type = { in: ['DEPOSIT_FIAT','DEPOSIT_CRYPTO','SUSU_PAYOUT','VAULT_RELEASE','TRADE_PAYOUT'] };
            else if (f === 'OUT') where.type = { in: ['WITHDRAWAL_FIAT','WITHDRAWAL_CRYPTO','SUSU_CONTRIBUTION','VAULT_DEPOSIT'] };
            else if (f === 'INTERNAL') where.type = { in: ['INTERNAL_TRANSFER','SMART_ROUTE_RUN'] };
        }
        if (type && !filter) {
            const upper = String(type).toUpperCase();
            where.type = upper;
        }
        if (status) {
            const upper = String(status).toUpperCase();
            where.status = upper;
        }
        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate) where.createdAt.gte = new Date(startDate);
            if (endDate) where.createdAt.lte = new Date(endDate);
        }
        if (q) {
            where.OR = [
                { txHash: { contains: q, mode: 'insensitive' } },
                { providerRef: { contains: q, mode: 'insensitive' } },
            ];
        }

        const transactions = await prisma.transactionHistory.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: limit + 1,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });

        const hasMore = transactions.length > limit;
        const slice = hasMore ? transactions.slice(0, limit) : transactions;
        const nextCursor = hasMore ? slice[slice.length - 1].id : null;

        return res.status(200).json({
            success: true,
            transactions: slice,
            hasMore,
            nextCursor
        });
    } catch (error) {
        logger.error({ err: error }, '[finance.getTransactionHistory] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};
