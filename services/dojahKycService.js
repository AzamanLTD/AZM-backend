/**
 * Dojah KYC Service — LIVE Ghana Identity Verification Adapter
 * Phase Q6 (LIVE) — swappable adapter that mirrors services/kycService.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * services/kycService.js is the MOCK implementation. This file is a drop-in
 * replacement that talks to the real Dojah API. It exposes the EXACT same
 * public surface so server.js can bind either one with zero changes downstream:
 *
 *     async initializeSession({ userId, email, firstName, lastName, idType, idNumber, dob })
 *     async processWebhook(payload, signature, rawBody)
 *     async adminOverride({ userId, action, reason, adminId })
 *     async getStatus(userId)
 *
 * FLOW DIFFERENCE vs MOCK (important)
 * ───────────────────────────────────
 * The MOCK uses an async "widget + webhook" model. The Ghana KYC endpoints
 * (/api/v1/gh/kyc/ssnit | voter | dl | passport) are SYNCHRONOUS lookups: you
 * submit an ID number and get the verification result back in the same HTTP
 * response — no hosted widget, no callback. So here `initializeSession()`
 * performs the lookup inline and resolves the user's kycStatus immediately.
 *
 * To keep the contract identical, `initializeSession()` still returns the same
 * shape ({ success, widgetUrl, referenceId, provider, expiresAt }). Because the
 * verification already completed synchronously, `widgetUrl` is null and an extra
 * (additive, non-breaking) `kycStatus` field carries the resolved result so the
 * frontend can react without waiting for a webhook.
 *
 * `processWebhook()` is still fully implemented so the surface matches the mock
 * and so async Dojah webhooks keep working if you enable them later.
 *
 * Provider config (env):
 *   KYC_PROVIDER=LIVE | dojah   → server.js binds THIS service
 *   DOJAH_APP_ID                → sent as the `AppId` header
 *   DOJAH_PRIVATE_KEY           → sent as the `Authorization` header
 *   DOJAH_SANDBOX_BASE_URL      → defaults to https://sandbox.dojah.io
 */

const logger = require('../src/config/logger');
const axios = require('axios');
const crypto = require('crypto');
const fieldCipher = require('./crypto/fieldCipher');

// ─────────────────────────────────────────────────────────────────────────────
// GHANA KYC ENDPOINT MAP
// ─────────────────────────────────────────────────────────────────────────────
// Maps the idType we accept from the client to the Dojah GH endpoint + the
// query-parameter name that carries the ID number for that endpoint.
//
// NOTE: Dojah's public docs currently redirect to a generic quickstart, so the
// exact per-endpoint query-param names below could not be byte-verified at build
// time. They are isolated here as a single source of truth — if the sandbox
// returns a "missing parameter" error on first run, the fix is a one-line change
// to `idParam` for that row (the actual request URL is logged on every call).
const GH_KYC_ENDPOINTS = {
    ssnit: {
        path: '/api/v1/gh/kyc/ssnit',
        idParam: 'ssnit',        // the SSNIT number
        label: 'SSNIT',
    },
    voter: {
        path: '/api/v1/gh/kyc/voter',
        idParam: 'id',           // the Voter ID number
        label: 'Voter ID',
    },
    dl: {
        path: '/api/v1/gh/kyc/dl',
        idParam: 'id',           // the Driver's Licence number
        label: "Driver's Licence",
    },
    passport: {
        path: '/api/v1/gh/kyc/passport',
        idParam: 'id',           // the Passport number
        label: 'Passport',
    },
};

// Aliases so callers can pass friendlier idType strings and still resolve.
const ID_TYPE_ALIASES = {
    ssnit: 'ssnit',
    voter: 'voter',
    voter_id: 'voter',
    voters_id: 'voter',
    dl: 'dl',
    drivers_license: 'dl',
    driving_license: 'dl',
    drivers_licence: 'dl',
    passport: 'passport',
};

class DojahKYCService {
    constructor(prisma, notificationService) {
        this.prisma = prisma;
        this.notificationService = notificationService;

        this.provider = 'dojah';

        // Credentials — REQUIRED for live calls.
        this.dojahAppId = process.env.DOJAH_APP_ID || '';
        // The Authorization header value. Prefer DOJAH_PRIVATE_KEY (the name in
        // the Dojah dashboard) but fall back to the legacy DOJAH_SECRET_KEY so an
        // existing .env that only set the secret key still works.
        this.dojahPrivateKey = process.env.DOJAH_PRIVATE_KEY || process.env.DOJAH_SECRET_KEY || '';

        // Sandbox by default. Point at https://api.dojah.io for production.
        this.dojahBaseUrl = process.env.DOJAH_SANDBOX_BASE_URL
            || process.env.DOJAH_BASE_URL
            || 'https://sandbox.dojah.io';

        // Webhook HMAC secret (only used by processWebhook).
        this.dojahWebhookSecret = process.env.DOJAH_WEBHOOK_SECRET || '';

        // Confidence thresholds — identical semantics to the mock.
        this.autoApproveThreshold = Number(process.env.KYC_AUTO_APPROVE_THRESHOLD) || 70;
        this.autoRejectThreshold = Number(process.env.KYC_AUTO_REJECT_THRESHOLD) || 40;

        // Pre-built axios instance with the two mandatory Dojah headers.
        this.http = axios.create({
            baseURL: this.dojahBaseUrl,
            timeout: 20000,
            headers: {
                'Content-Type': 'application/json',
                'AppId': this.dojahAppId,
                'Authorization': this.dojahPrivateKey,
            },
        });

        if (!this.dojahAppId || !this.dojahPrivateKey) {
            logger.warn('⚠️  [KYC/Dojah] DOJAH_APP_ID and/or DOJAH_PRIVATE_KEY is not set — live calls will be rejected by Dojah until configured.');
        } else {
            logger.info(`✅ [KYC/Dojah] LIVE adapter ready → ${this.dojahBaseUrl}`);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC: Initialize KYC Session  (synchronous Ghana lookup)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Verifies a Ghana government ID via the appropriate Dojah GH endpoint and
     * resolves the user's kycStatus immediately.
     *
     * Mirrors kycService.initializeSession but additionally accepts:
     *   @param {string} params.idType   - 'ssnit' | 'voter' | 'dl' | 'passport'
     *   @param {string} params.idNumber - the government ID number to verify
     *   @param {string} [params.dob]    - date of birth (YYYY-MM-DD), if the
     *                                     chosen endpoint requires it
     * @returns {Promise<Object>} { success, widgetUrl, referenceId, provider, expiresAt, kycStatus }
     */
    async initializeSession({ userId, email, firstName, lastName, idType, idNumber, dob }) {
        const userIdInt = this._coerceUserId(userId);
        if (!userIdInt) {
            return { success: false, message: 'Invalid userId.' };
        }

        // Prevent re-verification if already verified.
        const user = await this.prisma.user.findUnique({
            where: { id: userIdInt },
            select: { kycStatus: true },
        });

        if (!user) {
            return { success: false, message: 'User not found.' };
        }
        if (user.kycStatus === 'VERIFIED') {
            return { success: false, message: 'KYC already verified.' };
        }

        // Resolve which Ghana endpoint to hit.
        const endpoint = this._resolveEndpoint(idType);
        if (!endpoint) {
            return {
                success: false,
                message: `Unsupported or missing idType. Use one of: ${Object.keys(GH_KYC_ENDPOINTS).join(', ')}.`,
            };
        }
        if (!idNumber || !String(idNumber).trim()) {
            return { success: false, message: `An ID number is required to verify a Ghana ${endpoint.label}.` };
        }

        const referenceId = this._generateReferenceId(userIdInt);

        // Mark PENDING while the lookup runs (mirrors the mock/dojah widget path).
        await this.prisma.user.update({
            where: { id: userIdInt },
            data: { kycStatus: 'PENDING' },
        }).catch(err => logger.error({ err: err }, '[KYC/Dojah] Failed to set PENDING'));

        // Build the query params: always the ID, plus DOB when supplied.
        const params = { [endpoint.idParam]: String(idNumber).trim() };
        if (dob) params.dob = dob;
        if (firstName) params.first_name = firstName;
        if (lastName) params.last_name = lastName;

        const requestUrl = `${this.dojahBaseUrl}${endpoint.path}`;
        logger.info(`➡️  [KYC/Dojah] ${endpoint.label} lookup for user ${userIdInt} → GET ${requestUrl}?${endpoint.idParam}=${this._maskIdNumber(String(idNumber))}`);

        let response;
        try {
            response = await this.http.get(endpoint.path, { params });
        } catch (error) {
            return this._handleAxiosError(error, userIdInt, referenceId, endpoint);
        }

        // ── Interpret the Dojah response ─────────────────────────────────────
        const entity = response.data && (response.data.entity || response.data.data || response.data);
        const { verificationStatus, confidence, extracted } = this._interpretGhEntity(entity);

        const newStatus = this._determineKycStatus(verificationStatus, confidence);

        // Persist result + extracted identity (encrypt the raw ID number).
        const updateData = { kycStatus: newStatus, idType: endpoint.label };
        if (extracted.fullName) updateData.legalName = extracted.fullName;
        updateData.idNumber = fieldCipher.encrypt(String(idNumber).trim());

        await this.prisma.user.update({
            where: { id: userIdInt },
            data: updateData,
        });

        logger.info(`✅ [KYC/Dojah] User ${userIdInt} → ${newStatus} (${endpoint.label}, confidence: ${confidence}, status: ${verificationStatus})`);

        // Fire the same notification the webhook path would.
        await this._sendKycResultNotification(userIdInt, newStatus);

        // Manual-review alert (same behaviour as the mock's webhook path).
        if (
            newStatus === 'PENDING' &&
            verificationStatus === 'successful' &&
            confidence >= this.autoRejectThreshold &&
            confidence < this.autoApproveThreshold &&
            this.adminAlertService
        ) {
            setImmediate(() => this.adminAlertService.emit('KYC_MANUAL_REVIEW_REQUIRED', {
                userId: userIdInt,
                score: confidence,
                message: `KYC for user ${userIdInt} needs manual review (score ${confidence}).`,
            }));
        }

        return {
            success: true,
            // No widget in the synchronous flow — verification already happened.
            widgetUrl: null,
            referenceId,
            provider: 'dojah',
            kycStatus: newStatus,
            confidence,
            providerStatus: verificationStatus,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC: Process Webhook from Dojah
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Validates the HMAC signature and processes an async Dojah webhook payload.
     * Kept fully implemented so this adapter matches the mock's public surface
     * and so async/widget verifications still resolve if enabled later.
     * Identical contract to kycService.processWebhook.
     */
    async processWebhook(payload, signature, rawBody) {
        if (!this._verifyWebhookSignature(payload, signature, rawBody)) {
            logger.error('❌ [KYC/Dojah] Webhook signature verification FAILED');
            return { success: false, message: 'Invalid webhook signature.' };
        }

        const {
            reference_id: referenceId,
            verification_status: verificationStatus,
            overall_confidence: overallConfidence,
            verification_data: verificationData,
        } = this._normalizeWebhookPayload(payload);

        if (!referenceId) {
            logger.error('❌ [KYC/Dojah] Webhook missing reference_id');
            return { success: false, message: 'Missing reference_id in webhook payload.' };
        }

        const userId = this._extractUserIdFromReference(referenceId);
        if (!userId) {
            logger.error(`❌ [KYC/Dojah] Cannot extract userId from referenceId: ${referenceId}`);
            return { success: false, message: 'Invalid reference_id format.' };
        }

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, kycStatus: true, username: true },
        });

        if (!user) {
            logger.error(`❌ [KYC/Dojah] User not found for referenceId: ${referenceId}`);
            return { success: false, message: 'User not found.' };
        }

        const newStatus = this._determineKycStatus(verificationStatus, overallConfidence);
        const updateData = { kycStatus: newStatus };

        if (verificationData) {
            if (verificationData.fullName) updateData.legalName = verificationData.fullName;
            if (verificationData.idType) updateData.idType = verificationData.idType;
            if (verificationData.idNumber) updateData.idNumber = fieldCipher.encrypt(verificationData.idNumber);
        }

        await this.prisma.user.update({
            where: { id: userId },
            data: updateData,
        });

        logger.info(`✅ [KYC/Dojah] User ${userId} → ${newStatus} (confidence: ${overallConfidence}, provider status: ${verificationStatus})`);

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

        await this._sendKycResultNotification(userId, newStatus);

        return {
            success: true,
            userId,
            newStatus,
            confidence: overallConfidence,
            providerStatus: verificationStatus,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC: Admin Manual Override
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Admin manually approves or rejects a user's KYC. Provider-agnostic —
     * identical to kycService.adminOverride.
     */
    async adminOverride({ userId, action, reason, adminId }) {
        const validActions = ['approve', 'reject'];
        if (!validActions.includes(action)) {
            return { success: false, message: `Invalid action. Must be: ${validActions.join(', ')}` };
        }

        const userIdInt = this._coerceUserId(userId);
        if (!userIdInt) {
            return { success: false, message: 'Invalid userId.' };
        }

        const user = await this.prisma.user.findUnique({
            where: { id: userIdInt },
            select: { id: true, kycStatus: true, username: true },
        });

        if (!user) {
            return { success: false, message: 'User not found.' };
        }

        const newStatus = action === 'approve' ? 'VERIFIED' : 'REJECTED';

        await this.prisma.user.update({
            where: { id: userIdInt },
            data: { kycStatus: newStatus },
        });

        logger.info(`✅ [KYC/Dojah] Admin override: user ${userIdInt} → ${newStatus} by admin ${adminId} (reason: ${reason})`);

        await this._sendKycResultNotification(userIdInt, newStatus);

        return {
            success: true,
            userId: userIdInt,
            newStatus,
            overriddenBy: adminId,
            reason,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC: Get KYC Status (enriched)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns current KYC status + re-initiation eligibility.
     * Identical contract + masking behaviour to kycService.getStatus.
     */
    async getStatus(userId) {
        const userIdInt = this._coerceUserId(userId);
        if (!userIdInt) {
            return { success: false, message: 'Invalid userId.' };
        }

        const user = await this.prisma.user.findUnique({
            where: { id: userIdInt },
            select: { kycStatus: true, legalName: true, idType: true, idNumber: true },
        });

        if (!user) {
            return { success: false, message: 'User not found.' };
        }

        return {
            success: true,
            kycStatus: user.kycStatus,
            legalName: user.legalName,
            idNumber: user.idNumber
                ? this._maskIdNumber(fieldCipher.tryDecrypt(user.idNumber) || '')
                : null,
            idType: user.idType,
            canReinitialize: ['UNVERIFIED', 'REJECTED'].includes(user.kycStatus),
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Ghana response interpretation
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Translates a Dojah GH KYC `entity` into our internal verification shape.
     * Dojah GH lookups return the matched record fields when the ID is found.
     * A populated entity ⇒ the ID exists and was "caught" by the sandbox.
     */
    _interpretGhEntity(entity) {
        if (!entity || typeof entity !== 'object' || Object.keys(entity).length === 0) {
            return { verificationStatus: 'failed', confidence: 0, extracted: {} };
        }

        // Build a display name from whatever name fields Dojah returned.
        const first = entity.first_name || entity.firstName || entity.forenames || '';
        const last = entity.last_name || entity.lastName || entity.surname || '';
        const middle = entity.middle_name || entity.middleName || '';
        const fullName = (entity.full_name || entity.fullName
            || [first, middle, last].filter(Boolean).join(' ')).trim() || null;

        // Dojah may surface an explicit confidence; otherwise a successful match
        // with a returned record is treated as high confidence.
        const confidence = Number(
            entity.confidence ?? entity.confidence_value ?? entity.match_score ?? 90
        );

        return {
            verificationStatus: 'successful',
            confidence: Number.isFinite(confidence) ? confidence : 90,
            extracted: { fullName },
        };
    }

    /**
     * Normalises an axios failure into our standard { success:false } envelope
     * and rolls the user back to REJECTED so they can re-initiate.
     */
    async _handleAxiosError(error, userIdInt, referenceId, endpoint) {
        const status = error.response?.status;
        const body = error.response?.data;

        if (status) {
            // 404 / not-found from a lookup ⇒ the ID was not caught → REJECTED.
            const notFound = status === 404
                || (body && /not\s*found|no\s*record|invalid/i.test(JSON.stringify(body)));

            logger.error(`❌ [KYC/Dojah] ${endpoint.label} lookup HTTP ${status}:`, typeof body === 'string' ? body : JSON.stringify(body));

            if (notFound) {
                await this.prisma.user.update({
                    where: { id: userIdInt },
                    data: { kycStatus: 'REJECTED' },
                }).catch(() => {});
                await this._sendKycResultNotification(userIdInt, 'REJECTED');
                return {
                    success: true,
                    widgetUrl: null,
                    referenceId,
                    provider: 'dojah',
                    kycStatus: 'REJECTED',
                    providerStatus: 'failed',
                    message: 'Identity could not be verified — no matching record found.',
                };
            }

            // Auth / credential problems are operational, not a user rejection.
            if (status === 401 || status === 403) {
                return { success: false, message: 'KYC provider rejected our credentials. Check DOJAH_APP_ID / DOJAH_PRIVATE_KEY.' };
            }

            return { success: false, message: `KYC provider error (HTTP ${status}). Please try again later.` };
        }

        // No response at all → network/timeout.
        logger.error(`❌ [KYC/Dojah] ${endpoint.label} lookup network error:`, error.message);
        return { success: false, message: 'KYC provider unavailable. Please try again later.' };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Webhook verification + normalization (mirrors the mock)
    // ─────────────────────────────────────────────────────────────────────────

    _verifyWebhookSignature(payload, signature, rawBody) {
        if (!signature) return false;
        if (!this.dojahWebhookSecret) {
            logger.error('[KYC/Dojah] DOJAH_WEBHOOK_SECRET not set — cannot verify webhook.');
            return false;
        }

        try {
            const bodyForHmac = rawBody && rawBody.length > 0 ? rawBody : JSON.stringify(payload);
            const expectedSignature = crypto
                .createHmac('sha256', this.dojahWebhookSecret)
                .update(bodyForHmac)
                .digest('hex');

            const sigClean = String(signature).toLowerCase().trim();
            const expectedClean = expectedSignature.toLowerCase();
            if (sigClean.length !== expectedClean.length) return false;

            return crypto.timingSafeEqual(
                Buffer.from(sigClean, 'hex'),
                Buffer.from(expectedClean, 'hex')
            );
        } catch (error) {
            logger.error({ err: error }, '[KYC/Dojah] Signature verification error');
            return false;
        }
    }

    _normalizeWebhookPayload(payload) {
        if (payload.event && payload.data) {
            return {
                reference_id: payload.data.reference_id || payload.data.referenceId,
                verification_status: this._mapDojahEvent(payload.event),
                overall_confidence: payload.data.overall_confidence || payload.data.confidence || 0,
                verification_data: payload.data.verification_data || payload.data.extracted_data || null,
            };
        }
        return {
            reference_id: payload.reference_id || payload.referenceId,
            verification_status: payload.verification_status || payload.status || 'unknown',
            overall_confidence: payload.overall_confidence || payload.confidence || 0,
            verification_data: payload.verification_data || null,
        };
    }

    _mapDojahEvent(event) {
        const eventMap = {
            'verification.success': 'successful',
            'verification.failed': 'failed',
            'verification.pending': 'pending',
            'verification.manual_review': 'manual_review',
            'widget.completed': 'successful',
            'widget.failed': 'failed',
        };
        return eventMap[event] || 'unknown';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Status determination (identical thresholds to the mock)
    // ─────────────────────────────────────────────────────────────────────────

    _determineKycStatus(verificationStatus, confidence) {
        if (verificationStatus === 'failed') return 'REJECTED';
        if (verificationStatus === 'manual_review' || verificationStatus === 'pending') return 'PENDING';

        if (verificationStatus === 'successful') {
            if (confidence >= this.autoApproveThreshold) return 'VERIFIED';
            if (confidence < this.autoRejectThreshold) return 'REJECTED';
            return 'PENDING';
        }
        return 'PENDING';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Notifications (identical to the mock)
    // ─────────────────────────────────────────────────────────────────────────

    async _sendKycResultNotification(userId, newStatus) {
        if (!this.notificationService) return;

        const messages = {
            VERIFIED: {
                title: 'Identity Verified ✅',
                body: 'Your identity has been verified successfully. You now have full access to all platform features.',
            },
            REJECTED: {
                title: 'Verification Unsuccessful',
                body: 'Your identity verification was unsuccessful. Please try again with a valid government-issued ID, or contact support.',
            },
            PENDING: {
                title: 'Verification Under Review',
                body: 'Your identity verification is being reviewed by our team. We\'ll notify you once a decision is made.',
            },
        };

        const msg = messages[newStatus];
        if (!msg) return;

        try {
            await this.notificationService.sendNotification({
                userId,
                title: msg.title,
                body: msg.body,
                category: 'SECURITY_ACCOUNT',
                actionPayload: { route: '/profile', action: 'OPEN_KYC' },
            });
        } catch (error) {
            logger.error(`[KYC/Dojah] Failed to send notification to user ${userId}:`, error.message);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE: Helpers (identical semantics to the mock)
    // ─────────────────────────────────────────────────────────────────────────

    _resolveEndpoint(idType) {
        if (!idType) return null;
        const key = ID_TYPE_ALIASES[String(idType).toLowerCase().trim()];
        return key ? GH_KYC_ENDPOINTS[key] : null;
    }

    _coerceUserId(userId) {
        const n = typeof userId === 'number' ? userId : parseInt(userId, 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    _generateReferenceId(userId) {
        const ts = Date.now().toString(36);
        return `kyc_${userId}_${ts}`;
    }

    _extractUserIdFromReference(referenceId) {
        if (!referenceId || !referenceId.startsWith('kyc_')) return null;
        const parts = referenceId.split('_');
        if (parts.length < 3) return null;
        const userId = parseInt(parts[1], 10);
        if (!Number.isFinite(userId) || userId <= 0) return null;
        return userId;
    }

    _maskIdNumber(idNumber) {
        if (!idNumber || idNumber.length <= 5) return '***';
        return idNumber.slice(0, 3) + '***' + idNumber.slice(-2);
    }
}

module.exports = DojahKYCService;
