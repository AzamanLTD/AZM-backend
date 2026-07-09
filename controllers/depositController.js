// controllers/depositController.js
// =============================================================================
// AZAMAN V2 — DEPOSIT CONTROLLER
//
// Replaces the legacy "credit-on-request" fiat deposit (which trusted client
// input and used a hard-coded rate) with an Aggregator-Webhook flow:
//
//   1. POST /api/deposit/fiat/initiate (auth)
//      Creates a PENDING TransactionHistory row tagged with a unique
//      `paymentReference` (used as the idempotency key via the @unique
//      `txHash` column). Returns the reference + payment instructions for
//      the client to relay to the user (MoMo prompt, bank deposit etc.).
//
//   2. POST /api/deposit/fiat/webhook (no auth, shared-secret guarded)
//      The payment aggregator confirms settlement and posts the reference.
//      The webhook is idempotent — a duplicate POST is a no-op 200. On the

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
//      first call it converts GHS → USDC at the LIVE GlobalSettings rate,
//      credits availableBalance, and stamps the TransactionHistory COMPLETED.
//
// NOTE: The legacy `internalTransfer` handler has been removed. The canonical
// internal-transfer flow is POST /api/chat/transfer (chatTransferController).
// =============================================================================

const crypto = require('crypto');
const { audit } = require('../utils/audit');

// Constant-time string comparison — avoids leaking secret length/content via
// timing. Returns false on any type/length mismatch instead of throwing.
function _safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

// ── Constants ────────────────────────────────────────────────────────────────
const FIAT_REF_PREFIX = 'FIAT_DEPOSIT_';
const PROVIDERS       = new Set(['MTN_MOMO', 'VODAFONE_CASH', 'AIRTELTIGO', 'BANK_TRANSFER']);

// =============================================================================
// 1. INITIATE LOCAL FIAT DEPOSIT
//
//    Body: { amountGhs, provider }
//    Returns: { reference, status: 'PENDING', instructions }
// =============================================================================
exports.initiateLocalFiatDeposit = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const { amountGhs, provider } = req.body;
        const userId = req.user.id;

        if (!amountGhs || Number(amountGhs) <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid deposit amount.' });
        }
        if (!provider || !PROVIDERS.has(provider)) {
            return res.status(400).json({
                success: false,
                message: `provider must be one of: ${[...PROVIDERS].join(', ')}.`
            });
        }

        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        if (!settings) {
            return res.status(503).json({
                success: false,
                message: 'Live exchange rate is unavailable. Please retry shortly.'
            });
        }

        const amountGhsFloat   = parseFloat(amountGhs);
        const liveUsdToGhs     = settings.liveUsdToGhs;
        const usdcEquivalent   = parseFloat((amountGhsFloat / liveUsdToGhs).toFixed(6));

        // Idempotency key — uniquely identifies the off-chain payment intent.
        const reference = `${FIAT_REF_PREFIX}${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        const tx = await prisma.transactionHistory.create({
            data: {
                userId,
                type:       'DEPOSIT_FIAT',
                amountUsdc: usdcEquivalent,
                feeUsdc:    0,
                txHash:     reference,        // serves as the idempotency key
                status:     'PENDING'
            }
        });

        return res.status(201).json({
            success: true,
            message: 'Deposit initiated. Complete the payment with your provider, then await confirmation.',
            data: {
                reference,
                status:           'PENDING',
                provider,
                amountGhs:        amountGhsFloat,
                quotedRate:       liveUsdToGhs,
                usdcEquivalent,
                quoteValidUntil:  new Date(Date.now() + 10 * 60_000).toISOString(),
                instructions: [
                    `Send GHS ${amountGhsFloat.toFixed(2)} via ${provider}.`,
                    `Use reference: ${reference}`,
                    'Funds will appear in your Azaman wallet within minutes of provider confirmation.'
                ],
                transaction: tx
            }
        });
    } catch (error) {
        console.error('initiateLocalFiatDeposit error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// 2. LOCAL FIAT DEPOSIT WEBHOOK  (Payment Aggregator Confirmation)
//
//    Body: { reference, amountGhs, providerTxId, status }
//    Idempotent: a duplicate POST is silently accepted with 200 OK.
//
//    Auth: shared-secret header `X-Azaman-Webhook-Secret` MUST match
//    process.env.FIAT_WEBHOOK_SECRET. If unset, the endpoint is hard-disabled
//    (returns 503) so production never exposes an unauthenticated mutation.
// =============================================================================
exports.localFiatDepositWebhook = async (req, res) => {
    const prisma            = req.app.get('prisma');
    const io                = req.app.get('socketio');
    const emitBalanceUpdate = req.app.get('emitBalanceUpdate');

    try {
        const expectedSecret = process.env.FIAT_WEBHOOK_SECRET;
        if (!expectedSecret) {
            console.error('[localFiatDepositWebhook] FIAT_WEBHOOK_SECRET is not configured.');
            return res.status(503).json({
                success: false,
                message: 'Webhook endpoint is not configured. Refusing to credit funds.'
            });
        }

        const providedSecret = req.headers['x-azaman-webhook-secret'];
        if (providedSecret !== expectedSecret) {
            return res.status(401).json({ success: false, message: 'Invalid webhook signature.' });
        }

        const { reference, amountGhs, providerTxId, status } = req.body;
        if (!reference || !amountGhs) {
            return res.status(400).json({
                success: false,
                message: 'reference and amountGhs are required.'
            });
        }
        if (status && status !== 'SUCCESS') {
            // Provider reported a failure — mark the pending tx as FAILED.
            const failed = await prisma.transactionHistory.updateMany({
                where: { txHash: reference, status: 'PENDING' },
                data:  { status: 'FAILED' }
            });
            return res.status(200).json({
                success: true,
                message: failed.count > 0 ? 'Deposit marked as FAILED.' : 'Reference not in PENDING state.',
                data:    { reference, status: 'FAILED' }
            });
        }

        // ── Idempotency guard ────────────────────────────────────────────────
        const existing = await prisma.transactionHistory.findUnique({
            where: { txHash: reference }
        });

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: 'Unknown deposit reference.'
            });
        }

        if (existing.status === 'COMPLETED') {
            return res.status(200).json({
                success: true,
                message: 'Deposit already processed.',
                data:    { reference, alreadyProcessed: true }
            });
        }

        if (existing.status !== 'PENDING') {
            return res.status(409).json({
                success: false,
                message: `Cannot complete deposit in state ${existing.status}.`,
                data:    { reference, currentStatus: existing.status }
            });
        }

        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        if (!settings) {
            return res.status(503).json({
                success: false,
                message: 'Live exchange rate is unavailable. Webhook will retry.'
            });
        }

        // Re-quote at the LIVE rate (the rate at deposit-INITIATE time was
        // indicative; the rate at SETTLEMENT time is what we credit).
        const amountGhsFloat = parseFloat(amountGhs);
        const liveUsdToGhs   = settings.liveUsdToGhs;
        const usdcEquivalent = parseFloat((amountGhsFloat / liveUsdToGhs).toFixed(6));

        // ── ACID transition ──────────────────────────────────────────────────
        const result = await prisma.$transaction(async (tx) => {
            const user = await tx.user.findUnique({ where: { id: existing.userId } });
            if (!user) throw new Error('User no longer exists for this deposit.');

            await tx.user.update({
                where: { id: existing.userId },
                data:  { availableBalance: { increment: usdcEquivalent } }
            });

            const updatedTx = await tx.transactionHistory.update({
                where: { txHash: reference },
                data:  { amountUsdc: usdcEquivalent, status: 'COMPLETED' }
            });

            // Phase N: notification moved post-commit for full pipeline delivery.

            return { user, updatedTx };
        });

        // Side-effects (post-commit)
        if (emitBalanceUpdate) await emitBalanceUpdate(existing.userId);

        // Phase N: deliver via notificationService (DB + socket + FCM)
        setImmediate(async () => {
            try {
                await _getNotificationService(req).sendNotification({
                    userId:        existing.userId,
                    title:         'Deposit Confirmed',
                    body:          `GH₵${amountGhsFloat.toFixed(2)} deposited via MoMo — ${usdcEquivalent.toFixed(2)} USDC added to your wallet.`,
                    category:      'GENERAL',
                    actionPayload: { action: 'OPEN_WALLET', reference }
                });
            } catch (err) {
                console.error('[localFiatDepositWebhook] notification non-fatal:', err.message);
            }
        });

        if (io) {
            io.to(`user_${existing.userId}`).emit('deposit_success', {
                type:           'DEPOSIT_FIAT',
                reference,
                providerTxId:   providerTxId || null,
                amountGhs:      amountGhsFloat,
                usdcEquivalent,
                rate:           liveUsdToGhs,
                timestamp:      new Date().toISOString()
            });
        }

        console.log(`[localFiatDepositWebhook] Confirmed: ref=${reference} userId=${existing.userId} +${usdcEquivalent} USDC`);

        await audit(prisma, {
            actorId: existing.userId, actorName: '',
            action: 'DEPOSIT_FIAT_COMPLETED', targetType: 'TRANSACTION', targetId: String(existing.id),
            metadata: { amountUsdc: usdcEquivalent, provider: existing.metadata?.provider }, ipAddress: req.ip,
        });

        return res.status(200).json({
            success: true,
            message: 'Deposit confirmed and credited.',
            data: {
                reference,
                userId:         existing.userId,
                amountGhs:      amountGhsFloat,
                usdcEquivalent,
                rate:           liveUsdToGhs,
                transaction:    result.updatedTx
            }
        });
    } catch (error) {
        console.error('localFiatDepositWebhook error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// 3. TATUM CRYPTO WEBHOOK LISTENER   (Phase C: Polygon Web3 Integration)
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
    console.log("TATUM PAYLOAD:", JSON.stringify(req.body, null, 2));
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
            console.error('[tatumCryptoWebhook] TATUM_WEBHOOK_SECRET is not configured.');
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
                console.warn('[tatumCryptoWebhook] HMAC verification failed.');
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
                console.warn(`[tatumCryptoWebhook] No user found for address ${address}. txHash: ${txHash}`);
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
                console.error('[tatumCryptoWebhook] notification non-fatal:', err.message);
            }
        });

        console.log(`[tatumCryptoWebhook] Confirmed: txHash=${txHash} userId=${targetUserId} +${amountUsdc} USDC (Polygon)`);

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
        console.error('[tatumCryptoWebhook] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// MOOLRE COLLECTION ON-RAMP (2026-06-23) — in-bound GHS via PIN-push MoMo
//
// Flow mirrors the local-fiat flow: initiate creates a PENDING row keyed by a
// unique reference (TransactionHistory.txHash), the provider prompts the payer
// for their MoMo PIN, and a secret-guarded webhook credits the wallet once
// settlement lands. OTP-gated networks round-trip through confirmMoolreOtp.
//
// The collection adapter is bound under app key 'moolreCollectionService'.
// =============================================================================

// ── Export 1: initiateMoolreFiatDeposit ──────────────────────────────────────
// POST /api/deposit/fiat/initiate/moolre  (auth)
// Body: { amountGhs, provider, phoneNumber }   provider ∈ MTN_MOMO|VODAFONE_CASH|AIRTELTIGO
exports.initiateMoolreFiatDeposit = async (req, res) => {
    const prisma = req.app.get('prisma');
    const moolre = req.app.get('moolreCollectionService');
    if (!moolre) return res.status(503).json({ success: false, message: 'Deposit service unavailable.' });

    try {
        const { amountGhs, provider, phoneNumber, memo } = req.body;
        const userId = req.user.id;

        const MOMO = new Set(['MTN_MOMO', 'VODAFONE_CASH', 'AIRTELTIGO']);
        if (!amountGhs || Number(amountGhs) <= 0)
            return res.status(400).json({ success: false, message: 'Invalid deposit amount.' });
        if (!MOMO.has(provider))
            return res.status(400).json({ success: false, message: 'Use this endpoint only for MoMo providers.' });
        if (!phoneNumber || String(phoneNumber).replace(/\D/g, '').length < 9)
            return res.status(400).json({ success: false, message: 'A valid phone number is required.' });

        const networkMap = { MTN_MOMO: 'MTN', VODAFONE_CASH: 'VODAFONE', AIRTELTIGO: 'AIRTELTIGO' };
        const network    = networkMap[provider] || 'MTN';

        let settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        // Auto-bootstrap the settings row if it doesn't exist yet (first deploy, no admin visit yet).
        if (!settings) {
            try {
                settings = await prisma.globalSettings.create({ data: { id: 1 } });
            } catch (_) {
                // Race condition — another request created it between our find and create.
                settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
            }
        }
        if (!settings) return res.status(503).json({ success: false, message: 'Exchange rate unavailable. Please contact support.' });

        const ghsFloat     = parseFloat(amountGhs);
        const usdcEstimate = parseFloat((ghsFloat / Number(settings.liveUsdToGhs)).toFixed(6));
        const reference    = `MOOLRE_DEP_${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        // Create the PENDING row BEFORE calling Moolre — the webhook needs it to exist.
        const tx = await prisma.transactionHistory.create({
            data: {
                userId, type: 'DEPOSIT_FIAT', amountUsdc: usdcEstimate,
                txHash: reference, status: 'PENDING',
                initiatedByUserId: userId,
                metadata: {
                    provider, network, amountGhs: ghsFloat,
                    rateAtInitiation: Number(settings.liveUsdToGhs),
                    payerPhone: phoneNumber, channel: 'APP',
                    // Susu deposit trace (Req 12.4) — opaque memo (e.g. susu:<id>)
                    // forwarded by the app so operators can tie a deposit back to
                    // the cycle reminder that prompted it. Optional.
                    ...(memo ? { memo: String(memo) } : {}),
                },
            },
        });

        let moolreResult;
        try {
            moolreResult = await moolre.initiatePayment({
                externalRef: reference, amountGhs: ghsFloat,
                payerPhone: phoneNumber, network,
            });
        } catch (moolreErr) {
            if (moolreErr.isDuplicate)
                return res.status(409).json({ success: false, message: 'Duplicate deposit reference. Please retry.' });
            await prisma.transactionHistory.update({ where: { id: tx.id }, data: { status: 'FAILED' } });
            console.error('[initiateMoolreFiatDeposit] Moolre error:', moolreErr.message);
            // Surface the real provider message so the user knows what went wrong
            // (e.g. "Invalid account", "Network unavailable") instead of a generic blurb.
            const providerMsg = moolreErr.message?.replace(/^\[MoolreCollectionService\]\s*/, '') || 'Payment provider error. Please retry.';
            return res.status(502).json({ success: false, message: providerMsg });
        }

        if (moolreResult.providerRef) {
            await prisma.transactionHistory.update({
                where: { id: tx.id }, data: { providerRef: moolreResult.providerRef },
            });
        }

        return res.status(201).json({
            success: true, requiresOtp: moolreResult.requiresOtp,
            data: { reference, amountGhs: ghsFloat, usdcEstimate, provider, phoneNumber },
        });
    } catch (err) {
        console.error('[initiateMoolreFiatDeposit]', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
    }
};

// ── Export 2: confirmMoolreOtp ────────────────────────────────────────────────
// POST /api/deposit/fiat/initiate/moolre/otp  (auth)
// Body: { reference, otpCode }
exports.confirmMoolreOtp = async (req, res) => {
    const prisma = req.app.get('prisma');
    const moolre = req.app.get('moolreCollectionService');
    if (!moolre) return res.status(503).json({ success: false, message: 'Deposit service unavailable.' });

    try {
        const { reference, otpCode } = req.body;
        if (!reference || !otpCode)
            return res.status(400).json({ success: false, message: 'reference and otpCode are required.' });

        const tx = await prisma.transactionHistory.findUnique({ where: { txHash: reference } });
        if (!tx || tx.userId !== req.user.id)
            return res.status(404).json({ success: false, message: 'Deposit not found.' });
        if (tx.status !== 'PENDING')
            return res.status(409).json({ success: false, message: `Deposit is already ${tx.status}.` });

        const meta = tx.metadata || {};
        const moolreResult = await moolre.initiatePayment({
            externalRef: reference, amountGhs: meta.amountGhs,
            payerPhone: meta.payerPhone, network: meta.network, otpCode,
        });

        if (moolreResult.requiresOtp)
            return res.status(400).json({ success: false, message: 'OTP verification failed. Check the code and retry.' });
        if (moolreResult.providerRef)
            await prisma.transactionHistory.update({
                where: { id: tx.id }, data: { providerRef: moolreResult.providerRef },
            });

        return res.status(200).json({ success: true, requiresOtp: false, data: { reference } });
    } catch (err) {
        console.error('[confirmMoolreOtp]', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
    }
};

// ── Export 3: moolreCollectionWebhook ─────────────────────────────────────────
// POST /api/deposit/fiat/webhook/moolre  (no JWT — secret-guarded)
// Auth is signature-first: HMAC-SHA256 of the raw body in `x-moolre-signature`,
// with a constant-time plaintext `x-moolre-webhook-secret` fallback.
// ⚠️ BEFORE GOING LIVE: run a real sandbox test and log req.body verbatim to
//    confirm the field names inside `data` (externalref, payer, amount).
exports.moolreCollectionWebhook = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const expectedSecret = process.env.MOOLRE_WEBHOOK_SECRET;
        if (!expectedSecret) {
            console.error('[moolreCollectionWebhook] MOOLRE_WEBHOOK_SECRET is not configured.');
            return res.status(503).json({ success: false, message: 'Webhook endpoint not configured. Refusing to credit funds.' });
        }

        // Prefer HMAC over the raw body; fall back to a constant-time plaintext
        // secret header. Both comparisons are timing-safe.
        let authed = false;
        const rawBody = req.rawBody || JSON.stringify(req.body);
        const hmac    = req.headers['x-moolre-signature'];
        if (hmac && rawBody) {
            const expected = crypto.createHmac('sha256', expectedSecret).update(rawBody).digest('hex');
            authed = _safeEqual(hmac, expected);
        }
        if (!authed) {
            const headerSecret = req.headers['x-moolre-webhook-secret'];
            if (headerSecret) authed = _safeEqual(headerSecret, expectedSecret);
        }
        if (!authed) return res.status(401).json({ success: false, message: 'Unauthorized.' });

        const { status, code, data } = req.body;
        // Only a confirmed, successful collection (status 1 / P01) settles. Any
        // other event is acknowledged so Moolre stops retrying.
        if (Number(status) !== 1 || code !== 'P01')
            return res.status(200).json({ success: true, message: 'Event acknowledged.' });

        // ⚠️ CONFIRM these field names against a real sandbox payload:
        const externalRef = data?.externalref;
        const payerMsisdn = data?.payer;
        const amountGhsRaw = data?.amount;
        if (!externalRef) return res.status(400).json({ success: false, message: 'Missing externalref.' });

        const existing = await prisma.transactionHistory.findUnique({ where: { txHash: externalRef } });
        if (!existing) return res.status(404).json({ success: false, message: 'Unknown reference.' });
        if (existing.status === 'COMPLETED')
            return res.status(200).json({ success: true, message: 'Already processed.' });

        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        if (!settings) return res.status(503).json({ success: false, message: 'Rate unavailable.' });

        const ghsFloat   = parseFloat(amountGhsRaw || existing.metadata?.amountGhs || 0);
        const usdcCredit = parseFloat((ghsFloat / Number(settings.liveUsdToGhs)).toFixed(6));

        await prisma.$transaction([
            prisma.user.update({
                where: { id: existing.userId },
                data:  { availableBalance: { increment: usdcCredit } },
            }),
            prisma.transactionHistory.update({
                where: { id: existing.id },
                data: {
                    status: 'COMPLETED', amountUsdc: usdcCredit,
                    payerMsisdn: payerMsisdn || null,
                    metadata: {
                        ...(existing.metadata || {}),
                        settledAmountGhs: ghsFloat,
                        settledRate: Number(settings.liveUsdToGhs),
                        settledAt: new Date().toISOString(),
                        moolreData: data,
                    },
                },
            }),
        ]);

        try {
            const io = req.app.get('socketio');
            if (io) io.to(`user_${existing.userId}`).emit('deposit_success', {
                type: 'DEPOSIT_FIAT', amountGhs: ghsFloat, amountUsdc: usdcCredit,
                provider: existing.metadata?.provider || 'MOBILE_MONEY', reference: externalRef,
            });
            await _getNotificationService(req).sendNotification({
                userId:        existing.userId,
                title:         'Deposit Confirmed',
                body:          `GH₵ ${ghsFloat.toFixed(2)} has been credited to your account.`,
                category:      'GENERAL',
                actionPayload: { action: 'OPEN_WALLET', reference: externalRef },
            });
        } catch (notifErr) {
            console.error('[moolreCollectionWebhook] Notification failed:', notifErr.message);
        }

        // Append-only audit trail (fire-and-forget — never fails the request).
        await audit(prisma, {
            actorId: existing.userId, actorName: '',
            action: 'DEPOSIT_MOOLRE_COMPLETED', targetType: 'TRANSACTION', targetId: String(existing.id),
            metadata: { amountGhs: ghsFloat, amountUsdc: usdcCredit, externalRef }, ipAddress: req.ip,
        });

        return res.status(200).json({ success: true, message: 'Deposit credited.' });
    } catch (err) {
        console.error('[moolreCollectionWebhook]', err.message);
        return res.status(500).json({ success: false, message: 'Internal error.' });
    }
};

// ── Export 4: validateMomoName ────────────────────────────────────────────────
// POST /api/deposit/validate-name  (auth)
// Body: { phoneNumber, provider }
exports.validateMomoName = async (req, res) => {
    const moolre = req.app.get('moolreCollectionService');
    if (!moolre) return res.status(503).json({ success: false, message: 'Validation service unavailable.' });

    try {
        const { phoneNumber, provider } = req.body;
        if (!phoneNumber) return res.status(400).json({ success: false, message: 'phoneNumber required.' });

        const nm = {
            MTN: 'MTN', VODAFONE: 'VODAFONE', AIRTELTIGO: 'AIRTELTIGO',
            MTN_MOMO: 'MTN', VODAFONE_CASH: 'VODAFONE',
        };
        const network = nm[(provider || '').toUpperCase()] || 'MTN';
        const name = await moolre.validateName({ payerPhone: phoneNumber, network });
        if (!name) return res.status(404).json({ success: false, message: 'Account not found.' });

        return res.status(200).json({ success: true, data: name });
    } catch (err) {
        console.error('[validateMomoName]', err.message);
        const rawInfo = err.raw ? JSON.stringify(err.raw) : err.message;
        return res.status(500).json({ success: false, message: `Moolre Error: ${rawInfo}` });
    }
};
