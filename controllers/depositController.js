// controllers/depositController.js
// =============================================================================
// AZAMAN — DEPOSIT CONTROLLER (crypto deposits + MoMo name validation)
//
// Fiat deposit initiation/settlement NO LONGER lives here. The mounted,
// quote-backed fiat flows are:
//   • controllers/quoteFiatDepositController.js      (generic aggregator)
//   • controllers/moolreQuoteDepositController.js   (Moolre MoMo)
// Both honor persisted TransactionQuote fixed-price quotes (issue #271).
// The legacy re-pricing implementations that used to live in this file were
// unmounted dead code and have been removed (PR 271A).
//
// This controller retains:
//   • tatumCryptoWebhook — Polygon USDC deposit notifications (Tatum)
//   • validateMomoName    — MoMo account name lookup (Moolre adapter)
//
// NOTE: The legacy `internalTransfer` handler has been removed. The canonical
// internal-transfer flow is POST /api/chat/transfer (chatTransferController).
// =============================================================================

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
const { audit } = require('../utils/audit');
const logger = require('../src/config/logger');
const journal = require('../services/journalIntegration');

// =============================================================================
// 1. TATUM CRYPTO WEBHOOK LISTENER   (Phase C: Polygon Web3 Integration)
//
// Receives deposit notifications from Tatum when USDC lands on a user's
// derived Polygon address. The full flow:
//
//   1. Verify the webhook payload HMAC using TATUM_WEBHOOK_SECRET
//      (header: x-payload-hash, algorithm: SHA-512).
//   2. Look up the user by the deposit address (User.tatumPolygonAddress).
//   3. Inside a strict prisma.$transaction:
//      a. Credit user.availableBalance by the deposit amount (USDC).
//      b. Write a DEPOSIT_CRYPTO row to TransactionHistory (idempotent on txHash).
//      c. Credit SystemMasterCrypto (the swept funds land in the treasury).
//      d. Credit SystemHotWallet (reflects on-chain hot wallet balance).
//   4. Emit real-time balance update + notification.
//
// Idempotent: duplicate txHash → 200 OK with no mutation.
// =============================================================================
exports.tatumCryptoWebhook = async (req, res) => {
    logger.info("TATUM PAYLOAD:", JSON.stringify(req.body, null, 2));
    const prisma            = req.app.get('prisma');
    const io                = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');
    const tatumService      = req.app.get('tatumService');

    try {
        // ── Step 1: HMAC Verification ────────────────────────────────────────
        // Tatum sends the HMAC in `x-payload-hash` header (SHA-512 of the body).
        // We require TATUM_WEBHOOK_SECRET to be set; without it we refuse to
        // mutate the ledger (503).
        const webhookSecret = process.env.TATUM_WEBHOOK_SECRET;
        if (!webhookSecret) {
            logger.error('[tatumCryptoWebhook] TATUM_WEBHOOK_SECRET is not configured.');
            return res.status(503).json({
                success: false,
                message: 'Tatum webhook endpoint is not configured. Refusing to credit funds.'
            });
        }

        const signatureHeader = req.headers['x-payload-hash'];
        // req.rawBody is populated by express.json() when configured with verify,
        // but as a fallback we serialize the body. For production, configure
        // express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); }})
        const rawBody = req.rawBody || JSON.stringify(req.body);

        if (tatumService && signatureHeader) {
            const isValid = tatumService.verifyWebhookSignature(rawBody, signatureHeader);
            if (!isValid) {
                logger.warn('[tatumCryptoWebhook] HMAC verification failed.');
                return res.status(401).json({
                    success: false,
                    message: 'Invalid webhook signature (HMAC verification failed).'
                });
            }
        } else if (!signatureHeader && process.env.NODE_ENV === 'production') {
            // In production, reject unsigned webhooks
            return res.status(401).json({
                success: false,
                message: 'Missing x-payload-hash header.'
            });
        }
        // In non-production without signature, allow through (for testing)

        // ── Step 2: Extract payload ──────────────────────────────────────────
        // Tatum's ADDRESS_TRANSACTION webhook shape:
        // { address, txId, amount, asset, chain, blockNumber, ... }
        // We also accept the legacy shape: { address, txHash, amount, userId }
        const body    = req.body || {};
        const address = (body.address || '').toLowerCase().trim();
        const txHash  = body.txId || body.txHash || null;
        const amount  = parseFloat(body.amount) || 0;
        const asset   = (body.asset || body.currency || 'USDC').toUpperCase();

        if (!address) {
            return res.status(400).json({
                success: false,
                message: 'address is required in the webhook payload.'
            });
        }
        if (!txHash) {
            return res.status(400).json({
                success: false,
                message: 'txId (or txHash) is required in the webhook payload.'
            });
        }
        if (amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'amount must be a positive number.'
            });
        }

        // Only process USDC deposits (ignore native MATIC transfers etc.)
        if (asset !== 'USDC' && asset !== 'USDC.E') {
            return res.status(200).json({
                success: true,
                message: `Ignored non-USDC deposit (asset: ${asset}).`,
                data:    { txHash, asset, ignored: true }
            });
        }

        // ── Step 3: Look up user by deposit address ──────────────────────────
        let targetUserId = null;

        // If the body contains userId (legacy shape), use it directly
        if (body.userId) {
            targetUserId = parseInt(body.userId, 10);
        }

        // Otherwise (Tatum native shape), look up by address
        if (!targetUserId || isNaN(targetUserId)) {
            const user = await prisma.user.findFirst({
                where:  { tatumPolygonAddress: address },
                select: { id: true }
            });
            if (!user) {
                logger.warn(`[tatumCryptoWebhook] No user found for address ${address}. txHash: ${txHash}`);
                return res.status(200).json({
                    success: true,
                    message: 'Address not associated with any user. Possibly a treasury sweep — acknowledged.',
                    data:    { txHash, address, unmatched: true }
                });
            }
            targetUserId = user.id;
        }

        // ── Step 4: Idempotency check ────────────────────────────────────────
        const existingTx = await prisma.transactionHistory.findUnique({
            where: { txHash }
        });
        if (existingTx) {
            return res.status(200).json({
                success: true,
                message: 'Transaction already processed (idempotent).',
                data:    { txHash, alreadyProcessed: true }
            });
        }

        // ── Step 5: ACID ledger credit ───────────────────────────────────────
        const amountUsdc = parseFloat(amount.toFixed(6));

        const result = await prisma.$transaction(async (tx) => {
            const user = await tx.user.findUnique({ where: { id: targetUserId } });
            if (!user) throw new Error(`User ${targetUserId} not found for crypto deposit.`);

            // 5a. Credit user's available balance
            await tx.user.update({
                where: { id: targetUserId },
                data:  { availableBalance: { increment: amountUsdc } }
            });

            // 5b. Credit SystemMasterCrypto (swept funds land in treasury)
            await tx.systemMasterCrypto.upsert({
                where:  { id: 1 },
                update: { balance: { increment: amountUsdc } },
                create: { id: 1, balance: amountUsdc }
            });

            // 5c. Credit SystemHotWallet (on-chain hot wallet balance)
            await tx.systemHotWallet.upsert({
                where:  { id: 1 },
                update: { balance: { increment: amountUsdc } },
                create: { id: 1, balance: amountUsdc }
            });

            // 5d. Write TransactionHistory row
            const txRecord = await tx.transactionHistory.create({
                data: {
                    userId:     targetUserId,
                    type:       'DEPOSIT_CRYPTO',
                    amountUsdc: amountUsdc,
                    feeUsdc:    0,
                    txHash:     txHash,
                    status:     'COMPLETED'
                }
            });

            // 5e. Phase N: notification moved post-commit for full pipeline delivery.

            return { user, txRecord, newBalance: user.availableBalance + amountUsdc };
        });

        // ── Step 6: Post-commit side effects ─────────────────────────────────
        if (emitBalanceUpdate) await emitBalanceUpdate(targetUserId);

        // Double-entry journal recording (non-blocking, fail-safe)
        journal.recordDeposit(targetUserId, amountUsdc, txHash, { source: 'crypto', txHash }).catch(e =>
            logger.warn({ err: e.message, txHash }, '[depositController] Journal recording failed')
        );

        if (io) {
            io.to(`user_${targetUserId}`).emit('deposit_success', {
                type:       'DEPOSIT_CRYPTO',
                amount:     amountUsdc,
                txHash,
                address,
                network:    'Polygon',
                newBalance: result.newBalance,
                timestamp:  new Date().toISOString()
            });
        }

        // Phase N: deliver via notificationService (DB + socket + FCM)
        setImmediate(async () => {
            try {
                await _getNotificationService(req).sendNotification({
                    userId:        targetUserId,
                    title:         'Crypto Deposit Confirmed',
                    body:          `${amountUsdc} USDC has been credited to your account via Polygon.`,
                    category:      'GENERAL',
                    actionPayload: { action: 'OPEN_WALLET', reference: txHash, network: 'Polygon' }
                });
            } catch (err) {
                logger.error({ err: err }, '[tatumCryptoWebhook] notification non-fatal');
            }
        });

        logger.info(`[tatumCryptoWebhook] Confirmed: txHash=${txHash} userId=${targetUserId} +${amountUsdc} USDC (Polygon)`);

        await audit(prisma, {
            actorId: targetUserId, actorName: '',
            action: 'DEPOSIT_CRYPTO_COMPLETED', targetType: 'TRANSACTION', targetId: String(result.txRecord?.id || ''),
            metadata: { amountUsdc, txHash: txHash || '' }, ipAddress: req.ip,
        });

        return res.status(200).json({
            success: true,
            message: `Crypto deposit of ${amountUsdc} USDC confirmed for user ${targetUserId}.`,
            data: {
                userId:     targetUserId,
                amountUsdc,
                txHash,
                address,
                network:    'Polygon',
                newBalance: result.newBalance,
                transaction: result.txRecord
            }
        });

    } catch (error) {
        logger.error({ err: error }, '[tatumCryptoWebhook] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ── Export 2: validateMomoName ────────────────────────────────────────────────
// POST /api/deposit/validate-name  (auth)
// Body: { phoneNumber, provider }
exports.validateMomoName = async (req, res) => {
    const moolre = req.app.get('moolreCollectionService');
    if (!moolre) return res.status(503).json({ success: false, message: 'Validation service unavailable.' });

    try {
        const { phoneNumber, provider } = req.body;
        if (!phoneNumber) return res.status(400).json({ success: false, message: 'phoneNumber required.' });

        const nm = {
            MTN: 'MTN', TELECEL: 'TELECEL', VODAFONE: 'TELECEL', AIRTELTIGO: 'AIRTELTIGO',
            MTN_MOMO: 'MTN', TELECEL_CASH: 'TELECEL', VODAFONE_CASH: 'TELECEL',
        };
        const network = nm[(provider || '').toUpperCase()] || 'MTN';
        const name = await moolre.validateName({ payerPhone: phoneNumber, network });
        if (!name) return res.status(404).json({ success: false, message: 'Account not found.' });

        return res.status(200).json({ success: true, data: name });
    } catch (err) {
        logger.error('[validateMomoName]', err.message, err.raw || '');
        return res.status(500).json({ success: false, message: 'Could not verify account. Please check the number and try again.' });
    }
};
