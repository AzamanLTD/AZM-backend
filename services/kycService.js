/**
 * KYC Service — Dojah Integration + MOCK Mode
 * Phase Q6 (2026-05-25)
 *
 * Handles the full KYC lifecycle:
 *   1. Initialize a verification session (Dojah widget URL returned to FE)
 *   2. Receive webhook callback from Dojah with verification result
 *   3. Update user kycStatus based on confidence score
 *   4. Admin manual override remains available regardless of provider
 *
 * Provider modes (env: KYC_PROVIDER):
 *   - "mock"  → deterministic test responses, no external calls
 *   - "dojah" → real Dojah API calls (https://api.dojah.io)
 */

const logger = require('../src/config/logger');
const crypto = require('crypto');
const fieldCipher = require('./crypto/fieldCipher');

class KYCService {
    constructor(prisma, notificationService) {
        this.prisma = prisma;
        this.notificationService = notificationService;

        // Provider config
        this.provider = (process.env.KYC_PROVIDER || 'mock').toLowerCase();
        this.dojahAppId = process.env.DOJAH_APP_ID || '';
        this.dojahPublicKey = process.env.DOJAH_PUBLIC_KEY || '';
        this.dojahSecretKey = process.env.DOJAH_SECRET_KEY || '';
        this.dojahWidgetId = process.env.DOJAH_WIDGET_ID || '';
        this.dojahWebhookSecret = process.env.DOJAH_WEBHOOK_SECRET || 'mock_webhook_secret';

        // Confidence threshold for auto-approval (0–100 scale from Dojah)
        this.autoApproveThreshold = Number(process.env.KYC_AUTO_APPROVE_THRESHOLD) || 70;
        // Below this → auto-reject; between reject and approve → manual review
        this.autoRejectThreshold = Number(process.env.KYC_AUTO_REJECT_THRESHOLD) || 40;

        // Base URL for Dojah API
        this.dojahBaseUrl = process.env.DOJAH_BASE_URL || 'https://api.dojah.io';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC: Initialize KYC Session
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Creates a Dojah verification session and returns widget URL + reference ID.
     * @param {Object} params
     * @param {string} params.userId - Internal user ID
     * @param {string} params.email - User email
     * @param {string} params.firstName - First name (optional)
     * @param {string} params.lastName - Last name (optional)
     * @returns {Promise<Object>} { success, widgetUrl, referenceId, expiresAt }
     */
    async initializeSession({ userId, email, firstName, lastName }) {
        // Prevent re-initialization if already verified
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { kycStatus: true }
        });

        if (!user) {
            return { success: false, message: 'User not found.' };
        }

        if (user.kycStatus === 'VERIFIED') {
            return { success: false, message: 'KYC already verified.' };
        }

        const referenceId = this._generateReferenceId(userId);

        if (this.provider === 'mock') {
            return this._mockInitializeSession({ userId, email, referenceId });
        }

        // ── DOJAH REAL CALL ──────────────────────────────────────────────────
        return await this._dojahInitializeSession({ userId, email, firstName, lastName, referenceId });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC: Process Webhook from Dojah
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Validates HMAC signature and processes the Dojah webhook payload.
     * Updates user kycStatus based on verification result.
     * @param {Object} payload - Parsed webhook body (req.body)
     * @param {string} signature - HMAC signature from x-dojah-signature header
     * @param {string} [rawBody] - Raw request body bytes (req.rawBody) — REQUIRED
     *                             for production HMAC verification because
     *                             JSON.stringify(payload) does not always
     *                             reproduce the sender's exact byte sequence.
     * @returns {Promise<Object>} { success, userId, newStatus }
     */
    async processWebhook(payload, signature, rawBody) {
        // 1. Verify HMAC signature
        if (!this._verifyWebhookSignature(payload, signature, rawBody)) {
            logger.error('❌ [KYC] Webhook signature verification FAILED');
            return { success: false, message: 'Invalid webhook signature.' };
        }

        // 2. Extract relevant fields from Dojah webhook
        const {
            reference_id: referenceId,
            verification_status: verificationStatus,
            overall_confidence: overallConfidence,
            verification_data: verificationData
        } = this._normalizeWebhookPayload(payload);

        if (!referenceId) {
            logger.error('❌ [KYC] Webhook missing reference_id');
            return { success: false, message: 'Missing reference_id in webhook payload.' };
        }

        // 3. Look up user by reference ID pattern: kyc_{userId}_{timestamp}
        // BUGFIX (Phase H12, 2026-05-27): the previous version returned
        // userId as a string and passed it directly to
        // `prisma.user.findUnique({ where: { id: userId } })`. User.id
        // is `Int @id @default(autoincrement())` in the Prisma schema,
        // so a string match throws a P2009 type-coercion error and the
        // entire Dojah webhook flow was broken in production. The mock
        // path didn't trigger this because tests POSTed userIds that
        // got string-equal-checked elsewhere. Fix: parse the extracted
        // userId to Int and validate.
        const userId = this._extractUserIdFromReference(referenceId);
        if (!userId) {
            logger.error(`❌ [KYC] Cannot extract userId from referenceId: ${referenceId}`);
            return { success: false, message: 'Invalid reference_id format.' };
        }

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, kycStatus: true, username: true }
        });

        if (!user) {
            logger.error(`❌ [KYC] User not found for referenceId: ${referenceId}`);
            return { success: false, message: 'User not found.' };
        }

        // 4. Determine new KYC status based on confidence score
        const newStatus = this._determineKycStatus(verificationStatus, overallConfidence);

        // 5. Update user record
        const updateData = { kycStatus: newStatus };

        // If we got extracted identity data from Dojah, persist it.
        // The government ID number is sensitive — encrypt it at rest
        // (AES-256-GCM) so a DB leak does not expose raw identity numbers.
        // legalName / idType stay plaintext (needed for display + search).
        if (verificationData) {
            if (verificationData.fullName) updateData.legalName = verificationData.fullName;
            if (verificationData.idType) updateData.idType = verificationData.idType;
            if (verificationData.idNumber) updateData.idNumber = fieldCipher.encrypt(verificationData.idNumber);
        }

        await this.prisma.user.update({
            where: { id: userId },
            data: updateData
        });

        logger.info(`✅ [KYC] User ${userId} → ${newStatus} (confidence: ${overallConfidence}, provider status: ${verificationStatus})`);

        // B-11: when the provider succeeded but the confidence score landed
        // BETWEEN the auto-reject and auto-approve thresholds, the result needs
        // a human decision. Alert admins (fire-and-forget; never affects the
        // webhook response, which must always 200 to Dojah).
        if (
            newStatus === 'PENDING' &&
            verificationStatus === 'successful' &&
            overallConfidence >= this.autoRejectThreshold &&
            overallConfidence < this.autoApproveThreshold &&
            this.adminAlertService
        ) {
            setImmediate(() => this.adminAlertService.emit('KYC_MANUAL_REVIEW_REQUIRED', {
                userId,
                score: overallConfidence,
                message: `KYC for @${user.username || userId} needs manual review (score ${overallConfidence}).`,
            }));
        }

        // 6. Send notification to user
        await this._sendKycResultNotification(userId, newStatus);

        return {
            success: true,
            userId,
            newStatus,
            confidence: overallConfidence,
            providerStatus: verificationStatus
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC: Admin Manual Override
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Admin manually approves or rejects a user's KYC.
     * Works regardless of provider — always available as fallback.
     * @param {Object} params
     * @param {string} params.userId - Target user ID
     * @param {string} params.action - 'approve' | 'reject'
     * @param {string} params.reason - Admin reason (for audit trail)
     * @param {string} params.adminId - Who performed the action
     * @returns {Promise<Object>}
     */
    async adminOverride({ userId, action, reason, adminId }) {
        const validActions = ['approve', 'reject'];
        if (!validActions.includes(action)) {
            return { success: false, message: `Invalid action. Must be: ${validActions.join(', ')}` };
        }

        // BUGFIX (Phase H12, 2026-05-27): coerce userId to Int. Comes
        // through req.body.userId from the admin override endpoint as a
        // JSON number OR string depending on FE serialization. Prisma
        // throws P2009 on a string.
        const userIdInt = typeof userId === 'number' ? userId : parseInt(userId, 10);
        if (!Number.isFinite(userIdInt) || userIdInt <= 0) {
            return { success: false, message: 'Invalid userId.' };
        }

        const user = await this.prisma.user.findUnique({
            where: { id: userIdInt },
            select: { id: true, kycStatus: true, username: true }
        });

        if (!user) {
            return { success: false, message: 'User not found.' };
        }

        const newStatus = action === 'approve' ? 'VERIFIED' : 'REJECTED';

        await this.prisma.user.update({
            where: { id: userIdInt },
            data: { kycStatus: newStatus }
        });

        logger.info(`✅ [KYC] Admin override: user ${userIdInt} → ${newStatus} by admin ${adminId} (reason: ${reason})`);

        // Send notification
        await this._sendKycResultNotification(userIdInt, newStatus);

        return {
            success: true,
            userId: userIdInt,
            newStatus,
            overriddenBy: adminId,
            reason
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC: Get KYC Status (enriched)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns current KYC status + whether the user can re-initiate.
     * @param {string} userId
     * @returns {Promise<Object>}
     */
    async getStatus(userId) {
        // BUGFIX (Phase H12, 2026-05-27): coerce to Int for Prisma.
        const userIdInt = typeof userId === 'number' ? userId : parseInt(userId, 10);
        if (!Number.isFinite(userIdInt) || userIdInt <= 0) {
            return { success: false, message: 'Invalid userId.' };
        }

        const user = await this.prisma.user.findUnique({
            where: { id: userIdInt },
            select: {
                kycStatus: true,
                legalName: true,
                idType: true,
                idNumber: true
            }
        });

        if (!user) {
            return { success: false, message: 'User not found.' };
        }

        return {
            success: true,
            kycStatus: user.kycStatus,
            legalName: user.legalName,
            // Decrypt (if encrypted) then mask — never return the raw or
            // full ID number to the owning user. Admins get the full value
            // via the admin KYC queue read path.
            idNumber: user.idNumber
                ? this._maskIdNumber(fieldCipher.tryDecrypt(user.idNumber) || '')
                : null,
            idType: user.idType,
            canReinitialize: ['UNVERIFIED', 'REJECTED'].includes(user.kycStatus)
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Dojah API Calls
    // ─────────────────────────────────────────────────────────────────────────

    async _dojahInitializeSession({ userId, email, firstName, lastName, referenceId }) {
        try {
            const response = await fetch(`${this.dojahBaseUrl}/api/v1/kyc/widget/initialize`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'AppId': this.dojahAppId,
                    'Authorization': this.dojahSecretKey
                },
                body: JSON.stringify({
                    widget_id: this.dojahWidgetId,
                    reference_id: referenceId,
                    email: email,
                    first_name: firstName || undefined,
                    last_name: lastName || undefined,
                    // Ghana-specific config
                    config: {
                        widget_type: 'custom',
                        country: 'GH',
                        document_type: ['passport', 'national_id', 'drivers_license'],
                        selfie: true,
                        liveness: true
                    }
                })
            });

            if (!response.ok) {
                const errorBody = await response.text();
                logger.error(`❌ [KYC/Dojah] Initialize failed (${response.status}): ${errorBody}`);
                return {
                    success: false,
                    message: 'Failed to initialize KYC session with provider.'
                };
            }

            const data = await response.json();

            // Mark user as PENDING while they complete the widget
            await this.prisma.user.update({
                where: { id: userId },
                data: { kycStatus: 'PENDING' }
            });

            logger.info(`✅ [KYC/Dojah] Session initialized for user ${userId}, ref: ${referenceId}`);

            return {
                success: true,
                widgetUrl: data.entity?.url || data.widget_url || data.url,
                referenceId,
                provider: 'dojah',
                expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 min session
            };
        } catch (error) {
            logger.error({ err: error }, '❌ [KYC/Dojah] Initialize error');
            return {
                success: false,
                message: 'KYC provider unavailable. Please try again later.'
            };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: MOCK Provider
    // ─────────────────────────────────────────────────────────────────────────

    _mockInitializeSession({ userId, email, referenceId }) {
        logger.info(`✅ [KYC/MOCK] Session initialized for user ${userId}, ref: ${referenceId}`);

        // In MOCK mode, mark as PENDING immediately
        // (the mock webhook can be triggered manually or auto-fires in test)
        this.prisma.user.update({
            where: { id: userId },
            data: { kycStatus: 'PENDING' }
        }).catch(err => logger.error({ err: err }, '[KYC/MOCK] Failed to set PENDING'));

        return {
            success: true,
            widgetUrl: `https://mock-kyc.azaman.dev/verify?ref=${referenceId}`,
            referenceId,
            provider: 'mock',
            expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            // MOCK-only: return a simulated webhook payload the FE/tester can POST back
            _mockHint: {
                message: 'In MOCK mode, POST the following to /api/kyc/webhook/dojah to simulate completion:',
                samplePayload: {
                    reference_id: referenceId,
                    verification_status: 'successful',
                    overall_confidence: 85,
                    verification_data: {
                        fullName: 'Mock User',
                        idType: 'national_id',
                        idNumber: 'GHA-000000001-0'
                    }
                }
            }
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Webhook Verification
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Verifies HMAC-SHA256 signature from Dojah webhook.
     * In MOCK mode, accepts any signature for easy testing.
     *
     * BUGFIX (Phase H12, 2026-05-27): the previous version computed the
     * expected signature against `JSON.stringify(payload)` — i.e. the
     * RE-stringified parsed body. Real webhook providers sign the
     * exact RAW request bytes that came over the wire; re-stringifying
     * a parsed object produces a different byte sequence whenever key
     * ordering, whitespace, or escape rules differ between the sender's
     * JSON encoder and Node's `JSON.stringify`. Production Dojah
     * webhooks would have failed verification consistently.
     *
     * Fix: use `req.rawBody` (captured by the `express.json` `verify`
     * hook in `server.js`) when available, fall back to
     * JSON.stringify in MOCK / test paths so the existing mock harness
     * keeps working.
     */
    _verifyWebhookSignature(payload, signature, rawBody) {
        if (this.provider === 'mock') {
            // In mock mode, accept if signature matches secret OR is 'mock_signature'
            if (signature === 'mock_signature' || signature === this.dojahWebhookSecret) {
                return true;
            }
        }

        if (!signature) return false;

        try {
            const bodyForHmac = rawBody && rawBody.length > 0
                ? rawBody
                : JSON.stringify(payload);

            const expectedSignature = crypto
                .createHmac('sha256', this.dojahWebhookSecret)
                .update(bodyForHmac)
                .digest('hex');

            // Both buffers must be equal length for timingSafeEqual.
            // Both signatures are hex strings; encode as hex so byte
            // length is the same regardless of input case.
            const sigClean = String(signature).toLowerCase().trim();
            const expectedClean = expectedSignature.toLowerCase();
            if (sigClean.length !== expectedClean.length) return false;

            return crypto.timingSafeEqual(
                Buffer.from(sigClean, 'hex'),
                Buffer.from(expectedClean, 'hex')
            );
        } catch (error) {
            logger.error({ err: error }, '[KYC] Signature verification error');
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Webhook Payload Normalization
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Normalizes Dojah webhook payload to a consistent internal shape.
     * Dojah sends different structures depending on verification type.
     */
    _normalizeWebhookPayload(payload) {
        // Dojah standard webhook structure
        if (payload.event && payload.data) {
            // Event-based format: { event: 'verification.success', data: { ... } }
            return {
                reference_id: payload.data.reference_id || payload.data.referenceId,
                verification_status: this._mapDojahEvent(payload.event),
                overall_confidence: payload.data.overall_confidence || payload.data.confidence || 0,
                verification_data: payload.data.verification_data || payload.data.extracted_data || null
            };
        }

        // Direct format (some Dojah webhook versions)
        return {
            reference_id: payload.reference_id || payload.referenceId,
            verification_status: payload.verification_status || payload.status || 'unknown',
            overall_confidence: payload.overall_confidence || payload.confidence || 0,
            verification_data: payload.verification_data || null
        };
    }

    /**
     * Maps Dojah event names to our internal status vocabulary.
     */
    _mapDojahEvent(event) {
        const eventMap = {
            'verification.success': 'successful',
            'verification.failed': 'failed',
            'verification.pending': 'pending',
            'verification.manual_review': 'manual_review',
            'widget.completed': 'successful',
            'widget.failed': 'failed'
        };
        return eventMap[event] || 'unknown';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Status Determination
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Determines the KYC status based on provider result + confidence score.
     * @param {string} verificationStatus - 'successful' | 'failed' | 'pending' | 'manual_review'
     * @param {number} confidence - 0–100 confidence score
     * @returns {'VERIFIED'|'REJECTED'|'PENDING'}
     */
    _determineKycStatus(verificationStatus, confidence) {
        // Provider explicitly says failed → reject
        if (verificationStatus === 'failed') {
            return 'REJECTED';
        }

        // Provider says manual review needed → keep pending for admin
        if (verificationStatus === 'manual_review' || verificationStatus === 'pending') {
            return 'PENDING';
        }

        // Provider says successful → apply confidence thresholds
        if (verificationStatus === 'successful') {
            if (confidence >= this.autoApproveThreshold) {
                return 'VERIFIED';
            }
            if (confidence < this.autoRejectThreshold) {
                return 'REJECTED';
            }
            // Between thresholds → needs manual admin review
            return 'PENDING';
        }

        // Unknown status → keep pending for admin review
        return 'PENDING';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Notifications
    // ─────────────────────────────────────────────────────────────────────────

    async _sendKycResultNotification(userId, newStatus) {
        if (!this.notificationService) return;

        const messages = {
            VERIFIED: {
                title: 'Identity Verified ✅',
                body: 'Your identity has been verified successfully. You now have full access to all platform features.'
            },
            REJECTED: {
                title: 'Verification Unsuccessful',
                body: 'Your identity verification was unsuccessful. Please try again with a valid government-issued ID, or contact support.'
            },
            PENDING: {
                title: 'Verification Under Review',
                body: 'Your identity verification is being reviewed by our team. We\'ll notify you once a decision is made.'
            }
        };

        const msg = messages[newStatus];
        if (!msg) return;

        try {
            // BUGFIX (Phase H12, 2026-05-27): notificationService.sendNotification
            // expects `body` (and `category`), not `message`/`type`. The previous
            // version sent the wrong keys so every KYC result notification
            // landed with an empty body and no FCM push body text. Fixed by
            // matching the canonical signature documented in
            // services/notificationService.js.
            await this.notificationService.sendNotification({
                userId,
                title: msg.title,
                body: msg.body,
                category: 'SECURITY_ACCOUNT',
                actionPayload: { route: '/profile', action: 'OPEN_KYC' }
            });
        } catch (error) {
            logger.error(`[KYC] Failed to send notification to user ${userId}:`, error.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Generates a reference ID that encodes the userId for webhook lookup.
     * Format: kyc_{userId}_{timestamp}
     */
    _generateReferenceId(userId) {
        const ts = Date.now().toString(36);
        return `kyc_${userId}_${ts}`;
    }

    /**
     * Extracts userId from our reference ID format.
     * Reference format: kyc_{userId}_{timestamp}
     *
     * BUGFIX (Phase H12, 2026-05-27): the previous version returned the
     * userId as a STRING via `userIdParts.join('_')`. Prisma's User.id
     * is `Int @id @default(autoincrement())`, so passing a string to
     * `findUnique({ where: { id: userId } })` triggered a P2009
     * type-coercion error and the entire Dojah webhook flow rejected
     * every callback in production. Fix: parse to Int and reject any
     * non-numeric reference (defence in depth — the reference id is
     * server-generated so it should always be numeric, but a malicious
     * client controlling the webhook URL could try to inject a
     * non-numeric segment).
     */
    _extractUserIdFromReference(referenceId) {
        if (!referenceId || !referenceId.startsWith('kyc_')) return null;

        const parts = referenceId.split('_');
        if (parts.length < 3) return null;

        // Format is `kyc_{userId}_{timestamp}`. Our user ids are integers
        // (auto-increment Int) — they never contain underscores. Take
        // index 1 directly.
        const userIdRaw = parts[1];
        const userId = parseInt(userIdRaw, 10);
        if (!Number.isFinite(userId) || userId <= 0) return null;
        return userId;
    }

    /**
     * Masks an ID number for privacy (show first 3 and last 2 chars).
     */
    _maskIdNumber(idNumber) {
        if (!idNumber || idNumber.length <= 5) return '***';
        return idNumber.slice(0, 3) + '***' + idNumber.slice(-2);
    }
}

module.exports = KYCService;
