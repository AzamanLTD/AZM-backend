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

        if (process.env.NODE_ENV === 'production') {
            // Production is strictly fail-closed (§P.1): a financial webhook may
            // never reach the ledger unless signature verification ACTUALLY
            // succeeds. Missing verifier, missing secret (checked above), missing
            // signature, or an invalid signature all reject before any ledger
            // read or mutation. This closes the previous edge where an unbound
            // tatumService together with a present header passed unverified.
            if (!tatumService) {
                logger.error('[tatumCryptoWebhook] Tatum service is not bound; refusing to verify or process.');
                return res.status(503).json({
                    success: false,
                    message: 'Tatum webhook endpoint is not configured. Refusing to credit funds.'
                });
            }
            if (!signatureHeader) {
                return res.status(401).json({
                    success: false,
                    message: 'Missing x-payload-hash header.'
                });
            }
            const isValid = tatumService.verifyWebhookSignature(rawBody, signatureHeader);
            if (!isValid) {
                logger.warn('[tatumCryptoWebhook] HMAC verification failed.');
                return res.status(401).json({
                    success: false,
                    message: 'Invalid webhook signature (HMAC verification failed).'
                });
            }
        } else if (tatumService && signatureHeader) {
            // Non-production: verify whenever a verifier + signature are present
            // (existing behavior preserved), but unsigned test/local webhooks
            // remain admissible so established test flows are not weakened.
            const isValid = tatumService.verifyWebhookSignature(rawBody, signatureHeader);
            if (!isValid) {
                logger.warn('[tatumCryptoWebhook] HMAC verification failed.');
                return res.status(401).json({
                    success: false,
                    message: 'Invalid webhook signature (HMAC verification failed).'
                });
            }
        }

        // ── Step 2: Extract payload ──────────────────────────────────────────
        // Tatum's ADDRESS_TRANSACTION webhook shape:
        // { address, txId, amount, asset, chain, blockNumber, ... }
        // A legacy shape may also arrive: { address, txHash, amount, userId }.
        // The legacy userId field is IGNORED — ownership is resolved ONLY from
        // the deposit address through the WalletAddress registry (see Step 3).
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

        // Canonical §P.1 customer deposit identity: native Polygon USDC ONLY.
        // Bridged USDC.e is a DISTINCT asset (different contract,
        // 0x2791bca1f2de4661ed88a30c99a7a9449aa84174) and must never be
        // credited as canonical USDC. Explicit USDC.E is rejected BEFORE any
        // financial mutation. NOTE: the Tatum ADDRESS_TRANSACTION payload does
        // not carry the token contract address, so contract-level inbound
        // verification remains part of the later custody-inbound work; this
        // gate only enforces the logical asset label the payload does carry.
        if (asset !== 'USDC') {
            const isBridged = asset === 'USDC.E' || asset === 'USDC_E';
            return res.status(200).json({
                success: true,
                message: isBridged
                    ? 'Ignored bridged USDC.e deposit — it is a distinct asset, not canonical native Polygon USDC.'
                    : `Ignored non-USDC deposit (asset: ${asset}).`,
                data:    { txHash, asset, ignored: true }
            });
        }

        // ── Step 3: Resolve ownership from the AUTHORITATIVE WalletAddress registry ──
        // A webhook caller must NEVER be able to choose the credited user by
        // supplying a userId in the payload — body.userId is NOT an ownership
        // authority. The legacy payload shape may still carry a userId field,
        // but it is ignored for ownership: the actual deposit address + network
        // resolve the owner, full stop. The resolver grants ownership ONLY for
        // an ACTIVE canonical (native-USDC) registry row (or, during migration,
        // an address with no registry row that still matches the legacy mirror).
        const { resolveOwner } = require('../services/walletAddressService');
        const owner = await resolveOwner(prisma, { address, network: 'POLYGON' });
        if (!owner) {
            logger.warn(`[tatumCryptoWebhook] No active canonical owner for address ${address}. txHash: ${txHash}`);
            return res.status(200).json({
                success: true,
                message: 'Address not associated with any user. Possibly a treasury sweep — acknowledged.',
                data:    { txHash, address, unmatched: true }
            });
        }
        const targetUserId = owner.userId;

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

        // §P.3 exact quantity for the custody candidate: the credited amount
        // expressed as EXACT integer base units (never a float). The webhook's
        // own amount parsing is not custody evidence — the candidate must be
        // re-proven by transaction evidence before it counts anywhere.
        const candidateDecimalString = Number(amount.toFixed(6)).toFixed(6);
        const [candInt, candFrac = ''] = candidateDecimalString.split('.');
        const candidateBaseUnits = BigInt(candInt + candFrac.padEnd(6, '0'));
        const ownerWalletAddress = owner.walletAddress || null;

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

            // 5e. §P.3 custody accounting: record the deposit CANDIDATE movement
            // atomically with the credit. The webhook is an observation source
            // ONLY — this candidate is NOT a verified custody movement. It
            // contributes nothing to the evidence-linked liability subset
            // until verifyDepositMovement succeeds against transaction-
            // specific chain evidence (Tatum v4 tx-by-hash). Failure here
            // rolls the whole credit back: a credit without its custody
            // candidate would be an untracked deposit.
            const custodyAccounting = require('../services/custodyAccountingService');
            if (ownerWalletAddress) {
                await custodyAccounting.recordDepositCandidate(tx, {
                    walletAddress: ownerWalletAddress,
                    txHash,
                    amountBaseUnits: candidateBaseUnits,
                    transactionHistoryId: txRecord.id,
                    creditedAmountDecimalString: candidateDecimalString,
                });
            } else {
                // Legacy-fallback owner (§P.1 migration window): no registry
                // row, so no custody account can be derived. The credit keeps
                // its existing behavior; the deposit stays in the USDC flow
                // classification (X) but can never reach the evidence-linked
                // subset (Y) — logged, never silently presented as tracked.
                logger.warn({ txHash, userId: targetUserId }, '[depositController] deposit at non-registry address — no custody candidate recorded');
            }

            // 5f. Phase N: notification moved post-commit for full pipeline delivery.

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
