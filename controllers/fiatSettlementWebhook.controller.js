// =============================================================================
// AZAMAN — FIAT SETTLEMENT WEBHOOK ADAPTER
//
// Thin provider adapter. It authenticates/normalizes the provider callback and
// delegates the ledger transition to fiatSettlementService. The service owns
// idempotency and canonical TransactionHistory state; this controller owns only
// transport, notifications and realtime projections.
// =============================================================================

const crypto = require('crypto');
const logger = require('../src/config/logger');
const { settleFiatWithdrawal } = require('../services/fiatSettlementService');
const { recordProviderSettlementAttempt } = require('../services/providerSettlementAttemptService');

const notificationService = (req) => {
    const existing = req.app.get('notificationService');
    if (existing) return existing;
    const NotificationService = require('../services/notificationService');
    return new NotificationService(req.app.get('prisma'), req.app.get('socketio'));
};

const constantTimeEqual = (left, right) => {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const a = Buffer.from(left, 'utf8');
    const b = Buffer.from(right, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const authenticateMoolre = (req) => {
    const secret = process.env.MOOLRE_WEBHOOK_SECRET;
    if (!secret) return { ok: false, code: 503, message: 'Webhook endpoint is not configured.' };

    const suppliedSecret = req.headers['x-moolre-webhook-secret'];
    if (typeof suppliedSecret === 'string' && constantTimeEqual(suppliedSecret, secret)) {
        return { ok: true };
    }

    const signature = ['x-moolre-signature', 'x-signature', 'x-webhook-signature']
        .map((header) => req.headers[header])
        .find((value) => typeof value === 'string' && value.length > 0);
    if (!signature) return { ok: false, code: 401, message: 'Missing webhook authentication.' };

    const expected = crypto
        .createHmac('sha256', secret)
        .update(req.rawBody || '')
        .digest('hex');
    return constantTimeEqual(signature, expected)
        ? { ok: true }
        : { ok: false, code: 401, message: 'Invalid webhook signature.' };
};

const authenticateMtn = (req) => {
    const secret = process.env.MTN_WEBHOOK_SECRET;
    if (!secret) return { ok: false, code: 503, message: 'Webhook endpoint is not configured.' };
    return constantTimeEqual(req.headers['x-mtn-webhook-secret'], secret)
        ? { ok: true }
        : { ok: false, code: 401, message: 'Invalid webhook signature.' };
};

const normalizeMoolre = (body) => {
    const payload = body?.data && typeof body.data === 'object' ? body.data : (body || {});
    const rawStatus = payload.txstatus ?? payload.status;
    const upper = String(rawStatus ?? '').toUpperCase();
    let status;
    if (upper === '1' || ['SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'PAID'].includes(upper)) status = 'SUCCESSFUL';
    else if (upper === '2' || ['FAILED', 'REJECTED', 'REVERSED', 'CANCELLED'].includes(upper)) status = 'FAILED';
    else if (upper === '0' || ['PENDING', 'PROCESSING'].includes(upper)) status = 'PENDING';
    else status = null;

    return {
        reference: payload.externalref || payload.reference || payload.externalId || null,
        status,
        providerTxId: payload.transactionid || payload.txid || payload.id || null,
        reason: payload.reason || body?.message || null
    };
};

const normalizeMtn = (body) => {
    const payload = body || {};
    const upper = String(payload.status || '').toUpperCase();
    let status;
    if (['SUCCESS', 'SUCCESSFUL'].includes(upper)) status = 'SUCCESSFUL';
    else if (upper === 'FAILED') status = 'FAILED';
    else if (upper === 'PENDING') status = 'PENDING';
    else status = null;
    return {
        reference: payload.reference || payload.referenceId || null,
        status,
        providerTxId: payload.providerTxId || payload.financialTransactionId || null,
        reason: payload.message || payload.reason || null
    };
};

const handleSettlement = (provider, authenticate, normalize) => async (req, res) => {
    const auth = authenticate(req);
    if (!auth.ok) return res.status(auth.code).json({ success: false, message: auth.message });

    const normalized = normalize(req.body || {});
    if (!normalized.reference || !normalized.status) {
        return res.status(400).json({
            success: false,
            message: provider === 'MOOLRE'
                ? 'reference (externalref) and a recognized status are required.'
                : 'reference (or referenceId) and a recognized status are required.'
        });
    }

    if (normalized.status === 'PENDING') {
        const prisma = req.app.get('prisma');
        const io = req.app.get('socketio');
        const row = await prisma.transactionHistory.findUnique({ where: { txHash: normalized.reference } });
        if (row) {
            await recordProviderSettlementAttempt(prisma, {
                reference: normalized.reference,
                provider,
                providerReference: normalized.reference,
                providerTransactionId: normalized.providerTxId,
                status: 'PENDING'
            });
        }
        if (row && io) {
            io.to(`user_${row.userId}`).emit('withdrawal_progress', {
                reference: normalized.reference,
                status: 'PENDING',
                stage: 'PROCESSING',
                label: 'Transfer in progress...',
                pct: 60,
                timestamp: new Date().toISOString()
            });
        }
        return res.status(200).json({ success: true, message: 'PENDING status acknowledged; no ledger mutation.' });
    }

    try {
        const prisma = req.app.get('prisma');
        const io = req.app.get('socketio');
        const emitBalanceUpdate = req.app.get('emitBalanceUpdate');
        const result = await settleFiatWithdrawal(prisma, { ...normalized, provider });

        if (result.changed && emitBalanceUpdate) {
            await emitBalanceUpdate(result.userId);
        }

        if (io) {
            io.to(`user_${result.userId}`).emit('withdrawal_progress', {
                reference: result.reference,
                status: result.status,
                stage: result.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
                label: result.status === 'COMPLETED'
                    ? 'Money sent to your MoMo wallet!'
                    : 'Transfer failed. Your balance has been refunded.',
                pct: result.status === 'COMPLETED' ? 100 : 0,
                providerTxId: result.providerTxId || null,
                timestamp: new Date().toISOString()
            });
            io.to(`user_${result.userId}`).emit('withdrawal_settled', {
                reference: result.reference,
                status: result.status,
                providerTxId: result.providerTxId || null,
                changed: result.changed,
                timestamp: new Date().toISOString()
            });

            // Admin is a projection of the same canonical settlement. Publish a
            // small invalidation signal to the admin room; the portal refetches
            // authoritative data instead of trusting this payload as ledger truth.
            io.to('admin_spy').emit('admin_alert', {
                type: result.status === 'COMPLETED' ? 'WITHDRAWAL_SETTLED' : 'WITHDRAWAL_FAILED',
                reference: result.reference,
                status: result.status,
                providerTxId: result.providerTxId || null,
                changed: result.changed,
                timestamp: new Date().toISOString()
            });
        }

        if (result.status === 'FAILED' && result.changed) {
            try {
                await notificationService(req).sendNotification({
                    userId: result.userId,
                    title: 'Withdrawal Reversed',
                    body: `The mobile-money payout for reference ${result.reference} could not be completed. Your funds have been returned to your wallet.`,
                    category: 'GENERAL',
                    actionPayload: { action: 'OPEN_WALLET', reference: result.reference }
                });
            } catch (notificationError) {
                logger.error({ err: notificationError }, `[${provider}] settlement notification failed`);
            }
        }

        return res.status(200).json({
            success: true,
            message: result.status === 'COMPLETED' ? 'Settlement confirmed.' : 'Settlement failure handled.',
            data: {
                reference: result.reference,
                status: result.status,
                changed: result.changed,
                providerTxId: result.providerTxId || null,
                alreadyReversed: result.alreadyReversed || false,
                conflictingTerminalCallback: result.conflictingTerminalCallback || false
            }
        });
    } catch (error) {
        logger.error({ err: error, provider, reference: normalized.reference }, '[fiatSettlementWebhook] processing failed');
        const status = error.code === 'UNKNOWN_REFERENCE' ? 404 : error.code === 'WRONG_TRANSACTION_TYPE' ? 409 : 500;
        return res.status(status).json({ success: false, message: error.message });
    }
};

module.exports = {
    moolreDisbursementWebhook: handleSettlement('MOOLRE', authenticateMoolre, normalizeMoolre),
    mtnDisbursementWebhook: handleSettlement('MTN_MOMO_DISBURSEMENT', authenticateMtn, normalizeMtn)
};
