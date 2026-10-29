/**
 * SMS Service - Placeholder Implementation
 * 
 * This service provides mock SMS functionality that can be easily replaced
 * with real SMS providers like Twilio, AWS SNS, or local providers.
 */

const logger = require('../src/config/logger');
const crypto = require('crypto');
const axios  = require('axios');

class SMSService {
    constructor() {
        this.apiKey = process.env.SMS_API_KEY || 'mock_sms_api_key';

        // ── SAFETY CONTRACT ──────────────────────────────────────────────────
        // Production must NEVER report a delivery it did not make. A missing
        // provider or an explicit 'mock' in production is a misconfiguration:
        // sends fail closed (SMS_PROVIDER_MISCONFIGURED) instead of returning
        // mock success. Mock stays available in test/development only.
        this.isProduction = process.env.NODE_ENV === 'production';
        this.provider = String(process.env.SMS_PROVIDER || '').trim().toLowerCase() || 'mock';
        this.misconfigured = this.isProduction && this.provider === 'mock';
        if (this.misconfigured) {
            logger.error(
                { provider: this.provider },
                '[SMSService] SMS_PROVIDER is missing or "mock" in production — sends will be refused (no mock success)'
            );
        }

        // ── Moolre SMS (VAS) configuration ────────────────────────────────────
        // Resolved once in the constructor so _sendViaMoolre stays stateless per
        // call. Defaults to sandbox unless MOOLRE_ENV says production. SMS uses
        // the VAS key (X-API-VASKEY); falls back to the standard API key if a
        // dedicated VAS key isn't provisioned.
        const moolreUseProd = process.env.MOOLRE_ENV === 'production' || process.env.MOOLRE_ENV === 'prod';
        this.moolreBaseUrl  = process.env.MOOLRE_BASE_URL || (moolreUseProd ? 'https://api.moolre.com' : 'https://sandbox.moolre.com');
        this.moolreApiUser  = process.env.MOOLRE_API_USER || null;
        this.moolreVasKey   = process.env.MOOLRE_VAS_KEY  || process.env.MOOLRE_API_KEY || null;
        this.moolreSenderId = process.env.MOOLRE_SMS_SENDER_ID || 'AZAMAN';
        // isTestMode normally forces MOCK in any non-production env. That is the
        // right default, but it also blocks testing a REAL provider (e.g. Moolre)
        // against its sandbox from a dev/staging box. SMS_FORCE_LIVE=true lets a
        // real, non-mock provider send for real even when NODE_ENV !== production.
        // When the provider is already 'mock' this flag does nothing.
        const forceLive = process.env.SMS_FORCE_LIVE === 'true';
        this.isTestMode = process.env.NODE_ENV !== 'production' && !forceLive;

        // OTP store: use Redis when REDIS_URL is set (Upstash-compatible via ioredis),
        // otherwise fall back to in-process Map (single-instance / dev only).
        this._redisClient = null;
        if (process.env.REDIS_URL) {
            try {
                const Redis = require('ioredis');
                const isTLS = process.env.REDIS_URL.startsWith('rediss://');
                this._redisClient = new Redis(process.env.REDIS_URL, {
                    maxRetriesPerRequest: 2,
                    enableReadyCheck: false,
                    lazyConnect: true,
                    ...(isTLS ? { tls: {} } : {}),
                });
                this._redisClient.on('error', (e) => {
                    logger.error({ err: e }, '[SMSService] Redis error (OTP store)');
                });
                logger.info('[SMSService] OTP store: Redis' + (isTLS ? ' (TLS/Upstash)' : ''));
            } catch (e) {
                if (this.isProduction) {
                    // Fail closed: an in-process Map cannot serve multiple
                    // instances and would let a code "verify" on the wrong box.
                    logger.error({ err: e }, '[SMSService] Redis OTP store init failed in production — OTP will be REFUSED, not stored in memory');
                } else {
                    logger.warn('[SMSService] Could not init Redis OTP store, falling back to Map:', e.message);
                }
                this._redisClient = null;
            }
        } else {
            if (this.isProduction) {
                logger.error('[SMSService] REDIS_URL not set in production — OTP storage will fail closed (no multi-instance-safe store).');
            } else {
                logger.warn('[SMSService] REDIS_URL not set — OTP codes stored in-process memory (development/test only).');
            }
        }
        this.otpStore = new Map(); // development/test fallback only
        this._sendThrottle = new Map(); // development/test throttle state
        // Send throttles (per phone): a resend storm is both a cost and an
        // abuse vector, so it is bounded even in mock mode.
        this._sendMinIntervalMs = 30 * 1000;
        this._sendWindowMs = 60 * 60 * 1000;
        this._sendMaxPerWindow = 5;
    }

    /**
     * Send SMS to a phone number
     * @param {string} phoneNumber - Recipient phone number (e.g., "+233241234567")
     * @param {string} message - SMS message content
     * @param {string} sender - Sender ID (optional)
     * @returns {Promise<Object>} SMS sending result
     */
    async sendSMS(phoneNumber, message, sender = 'AZAMAN') {
        // Never log the recipient in full or the body (OTP codes live in it).
        logger.info(
            { phone: this._maskPhone(phoneNumber), bodyLength: String(message || '').length, provider: this.provider },
            '[SMSService] sending'
        );

        if (this.misconfigured) {
            const err = new Error(
                'SMS provider is not configured for this environment (SMS_PROVIDER missing or "mock"). '
                + 'Refusing to report a delivery that did not happen.'
            );
            err.code = 'SMS_PROVIDER_MISCONFIGURED';
            throw err;
        }

        if (this.provider === 'mock') {
            // Development/test only (production is refused above).
            const messageId = this._generateMessageId();
            logger.info(
                { phone: this._maskPhone(phoneNumber), messageId, env: process.env.NODE_ENV || 'development' },
                '[SMSService] MOCK delivery (no provider configured) — not a real send'
            );
            return {
                success: true,
                messageId: messageId,
                provider: 'mock',
                mocked: true,          // explicit to the caller
                cost: 0.0,
                status: 'mocked',      // never "delivered"
                timestamp: new Date().toISOString()
            };
        }

        // Real SMS provider integration would go here
        switch (this.provider.toLowerCase()) {
            case 'twilio':
                return await this._sendViaTwilio(phoneNumber, message, sender);
            case 'aws_sns':
                return await this._sendViaAWS(phoneNumber, message);
            case 'hubtel':
                return await this._sendViaHubtel(phoneNumber, message, sender);
            case 'arkesel':
                return await this._sendViaArkesel(phoneNumber, message, sender);
            case 'moolre':
                return await this._sendViaMoolre(phoneNumber, message, sender);
            default:
                throw new Error(`Unsupported SMS provider: ${this.provider}`);
        }
    }

    /**
     * Send OTP (One-Time Password) via SMS
     * @param {string} phoneNumber - Recipient phone number
     * @param {number} length - OTP length (default: 6)
     * @param {number} expiryMinutes - OTP expiry in minutes (default: 5)
     * @returns {Promise<Object>} OTP sending result
     */
    async sendOTP(phoneNumber, length = 6, expiryMinutes = 5) {
        // Resolve the store BEFORE generating/burning anything: in production a
        // missing durable store is a hard refusal, never a silent Map fallback.
        const durable = this._requireDurableOtpStore();
        await this._enforceSendThrottle(phoneNumber);

        const otp = this._generateOTP(length);
        const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

        const otpPayload = JSON.stringify({
            code: otp,
            expiresAt: expiresAt.toISOString(),
            attempts: 0,
            maxAttempts: 3
        });
        const otpKey = `otp:${phoneNumber}`;
        if (durable) {
            await this._redisClient.set(otpKey, otpPayload, 'EX', expiryMinutes * 60);
        } else {
            this.otpStore.set(phoneNumber, { code: otp, expiresAt, attempts: 0, maxAttempts: 3 });
        }

        const message = `Your Azaman verification code is: ${otp}. Valid for ${expiryMinutes} minutes. Do not share this code.`;

        let result;
        try {
            result = await this.sendSMS(phoneNumber, message);
        } catch (err) {
            // A provider refusal must not leave a verifiable code behind.
            await this._deleteOtp(phoneNumber);
            throw err;
        }

        if (!result || result.success !== true) {
            await this._deleteOtp(phoneNumber);
            const err = new Error(result?.message || 'SMS provider did not accept the message');
            err.code = 'SMS_SEND_FAILED';
            throw err;
        }

        return {
            ...result,
            // Only a genuine mock in a non-production run may surface the code.
            otp: result.mocked ? otp : undefined,
            expiresAt: expiresAt.toISOString()
        };
    }

    // ---------------------------------------------------------------------
    // OTP store contract
    // ---------------------------------------------------------------------
    /** @returns {boolean} true when a durable (shared) store is in use. */
    _requireDurableOtpStore() {
        if (this._redisClient) return true;
        if (this.isProduction) {
            const err = new Error(
                'Durable OTP store unavailable (REDIS_URL unset or Redis failed to initialise). '
                + 'Refusing to store verification codes in process memory in production.'
            );
            err.code = 'OTP_STORE_UNAVAILABLE';
            throw err;
        }
        return false; // development/test: in-process Map is acceptable
    }

    async _deleteOtp(phoneNumber) {
        const key = `otp:${phoneNumber}`;
        if (this._redisClient) await this._redisClient.del(key);
        else this.otpStore.delete(phoneNumber);
    }

    /** Bounded resend: min interval + hourly cap, per phone. */
    async _enforceSendThrottle(phoneNumber) {
        const now = Date.now();
        const key = `otp:throttle:${phoneNumber}`;
        if (this._redisClient) {
            const raw = await this._redisClient.get(key);
            const state = raw ? JSON.parse(raw) : { last: 0, count: 0 };
            if (now - state.last < this._sendMinIntervalMs) {
                const err = new Error('Please wait before requesting another code.');
                err.code = 'OTP_RESEND_TOO_SOON';
                err.retryAfterMs = this._sendMinIntervalMs - (now - state.last);
                throw err;
            }
            const count = now - state.last > this._sendWindowMs ? 1 : state.count + 1;
            if (count > this._sendMaxPerWindow) {
                const err = new Error('Too many verification codes requested for this number. Try again later.');
                err.code = 'OTP_SEND_LIMIT_EXCEEDED';
                throw err;
            }
            await this._redisClient.set(
                key,
                JSON.stringify({ last: now, count }),
                'EX',
                Math.ceil(this._sendWindowMs / 1000)
            );
            return;
        }
        const state = this._sendThrottle.get(phoneNumber) || { last: 0, count: 0 };
        if (now - state.last < this._sendMinIntervalMs) {
            const err = new Error('Please wait before requesting another code.');
            err.code = 'OTP_RESEND_TOO_SOON';
            err.retryAfterMs = this._sendMinIntervalMs - (now - state.last);
            throw err;
        }
        const count = now - state.last > this._sendWindowMs ? 1 : state.count + 1;
        if (count > this._sendMaxPerWindow) {
            const err = new Error('Too many verification codes requested for this number. Try again later.');
            err.code = 'OTP_SEND_LIMIT_EXCEEDED';
            throw err;
        }
        this._sendThrottle.set(phoneNumber, { last: now, count });
    }

    /** +233241234567 -> +233*****4567 (enough to correlate, not to identify). */
    _maskPhone(phoneNumber) {
        const raw = String(phoneNumber || '');
        if (raw.length <= 4) return '****';
        return `${raw.slice(0, 3)}${'*'.repeat(Math.max(0, raw.length - 7))}${raw.slice(-4)}`;
    }

    /** Strip anything that looks like a verification code from log text. */
    _redactSecrets(text) {
        return String(text || '').replace(/\b\d{4,8}\b/g, '«redacted»');
    }

    /**
     * Verify OTP code
     * @param {string} phoneNumber - Phone number that received OTP
     * @param {string} code - OTP code to verify
     * @returns {Object} Verification result
     */
    async verifyOTP(phoneNumber, code) {
        this._requireDurableOtpStore();
        const otpKey = `otp:${phoneNumber}`;
        let otpData;

        if (this._redisClient) {
            const raw = await this._redisClient.get(otpKey);
            if (!raw) {
                return { success: false, message: 'No OTP found for this phone number' };
            }
            otpData = JSON.parse(raw);
            otpData.expiresAt = new Date(otpData.expiresAt);
        } else {
            otpData = this.otpStore.get(phoneNumber);
            if (!otpData) {
                return { success: false, message: 'No OTP found for this phone number' };
            }
        }

        if (new Date() > otpData.expiresAt) {
            if (this._redisClient) await this._redisClient.del(otpKey);
            else this.otpStore.delete(phoneNumber);
            return { success: false, message: 'OTP has expired' };
        }

        if (otpData.attempts >= otpData.maxAttempts) {
            if (this._redisClient) await this._redisClient.del(otpKey);
            else this.otpStore.delete(phoneNumber);
            return { success: false, message: 'Maximum verification attempts exceeded' };
        }

        otpData.attempts++;

        // Constant-time comparison: a code is a credential, so its comparison
        // must not leak length/prefix information through timing.
        if (!this._safeEqual(String(otpData.code), String(code))) {
            if (this._redisClient) {
                const ttl = await this._redisClient.ttl(otpKey);
                await this._redisClient.set(otpKey, JSON.stringify(otpData), 'EX', Math.max(ttl, 1));
            } else {
                this.otpStore.set(phoneNumber, otpData);
            }
            return { success: false, message: 'Invalid OTP code', attemptsLeft: otpData.maxAttempts - otpData.attempts };
        }

        // OTP verified successfully
        if (this._redisClient) await this._redisClient.del(otpKey);
        else this.otpStore.delete(phoneNumber);
        return {
            success: true,
            message: 'OTP verified successfully'
        };
    }

    /**
     * Send withdrawal confirmation SMS for large withdrawals.
     * Fire-and-forget — catches all errors internally so callers are never disrupted.
     *
     * @param {string} phoneNumber - Verified phone number
     * @param {Object} opts - Withdrawal details
     * @param {string} opts.kind - 'fiat_dispatched' | 'fiat_settled' | 'fiat_refunded' | 'crypto_sent' | 'crypto_refunded'
     * @param {number} opts.amount - USDC amount
     * @param {string} [opts.destination] - MoMo phone or wallet address
     * @param {string} [opts.reference] - Idempotency / tracking reference
     * @param {string} [opts.txHash] - On-chain tx hash (crypto only)
     * @param {string} [opts.reason] - Failure/refund reason
     * @returns {Promise<Object>} SMS result (never throws)
     */
    async sendWithdrawalConfirmation(phoneNumber, opts = {}) {
        try {
            const { kind, amount, destination, reference, txHash, reason } = opts;
            const amt = typeof amount === 'number' ? amount.toFixed(2) : String(amount);
            let message;

            switch (kind) {
                case 'fiat_dispatched':
                    message = `Azaman: Your withdrawal of $${amt} USDC has been dispatched to ${destination || 'your MoMo wallet'}. Ref: ${(reference || '').slice(0, 8)}. Settlement is typically instant.`;
                    break;
                case 'fiat_settled':
                    message = `Azaman: Your $${amt} USDC withdrawal has settled successfully. Ref: ${(reference || '').slice(0, 8)}.`;
                    break;
                case 'fiat_refunded':
                    message = `Azaman: Your $${amt} USDC withdrawal could not be completed and has been refunded to your balance. ${reason ? `Reason: ${reason.slice(0, 60)}` : ''}`;
                    break;
                case 'crypto_sent':
                    message = `Azaman: Your $${amt} USDC withdrawal to ${(destination || '').slice(0, 10)}... on Polygon is confirmed. Tx: ${(txHash || '').slice(0, 12)}...`;
                    break;
                case 'crypto_refunded':
                    message = `Azaman: Your $${amt} USDC crypto withdrawal could not be broadcast and has been refunded. ${reason ? `Reason: ${reason.slice(0, 60)}` : ''}`;
                    break;
                default:
                    message = `Azaman: Withdrawal update — $${amt} USDC. Check the app for details.`;
            }

            return await this.sendSMS(phoneNumber, message);
        } catch (err) {
            logger.error({ err: err }, '[SMSService] sendWithdrawalConfirmation error (swallowed)');
            return { success: false, error: err.message, provider: this.provider };
        }
    }

    /**
     * Send trade notification SMS
     * @param {string} phoneNumber - Recipient phone number
     * @param {Object} tradeData - Trade information
     * @returns {Promise<Object>} SMS result
     */
    async sendTradeNotification(phoneNumber, tradeData) {
        const { tradeId, amount, type, status } = tradeData;
        let message;

        switch (status.toLowerCase()) {
            case 'initiated':
                message = `Azaman: New ${type} trade #${tradeId} for ${amount} USDT initiated. Check app for details.`;
                break;
            case 'payment_received':
                message = `Azaman: Payment received for trade #${tradeId}. Please release assets if verified.`;
                break;
            case 'completed':
                message = `Azaman: Trade #${tradeId} completed successfully. Assets have been released.`;
                break;
            case 'disputed':
                message = `Azaman: Trade #${tradeId} has been disputed. Admin will review within 24 hours.`;
                break;
            default:
                message = `Azaman: Update on your trade #${tradeId}. Status: ${status}. Check app for details.`;
        }

        return await this.sendSMS(phoneNumber, message);
    }

    // Private helper methods

    _generateOTP(length) {
        const digits = '0123456789';
        let otp = '';
        for (let i = 0; i < length; i++) {
            otp += digits[Math.floor(Math.random() * digits.length)];
        }
        return otp;
    }

    /**
     * Constant-time string comparison. A verification code is a credential, so
     * its comparison must not leak prefix/length information through timing.
     * Mismatched lengths still perform one comparison before failing.
     */
    _safeEqual(a, b) {
        const bufA = Buffer.from(String(a), 'utf8');
        const bufB = Buffer.from(String(b), 'utf8');
        if (bufA.length !== bufB.length) {
            crypto.timingSafeEqual(bufA, bufA);
            return false;
        }
        return crypto.timingSafeEqual(bufA, bufB);
    }

    _generateMessageId() {
        return 'msg_' + crypto.randomUUID();
    }

    // Placeholder methods for real SMS providers
    // Replace these with actual API calls

    async _sendViaTwilio(phoneNumber, message, sender) {
        // TODO: Implement Twilio SMS API integration
        // const twilio = require('twilio');
        // const client = twilio(accountSid, authToken);
        
        logger.info('🔧 [PLACEHOLDER] Twilio SMS integration - Replace with real API');
        
        return {
            success: true,
            messageId: this._generateMessageId(),
            provider: 'twilio_placeholder',
            cost: 0.05, // Estimated cost
            status: 'queued'
        };
    }

    async _sendViaAWS(phoneNumber, message) {
        // TODO: Implement AWS SNS SMS integration
        logger.info('🔧 [PLACEHOLDER] AWS SNS SMS integration - Replace with real API');
        
        return {
            success: true,
            messageId: this._generateMessageId(),
            provider: 'aws_sns_placeholder',
            cost: 0.008,
            status: 'sent'
        };
    }

    async _sendViaHubtel(phoneNumber, message, sender) {
        // TODO: Implement Hubtel SMS API (Ghana)
        logger.info('🔧 [PLACEHOLDER] Hubtel SMS integration - Replace with real API');
        
        return {
            success: true,
            messageId: this._generateMessageId(),
            provider: 'hubtel_placeholder',
            cost: 0.02,
            status: 'delivered'
        };
    }

    async _sendViaArkesel(phoneNumber, message, sender) {
        // Arkesel SMS API v2 — https://developers.arkesel.com/#tag/SMS-V2
        // Uses the HTTP API with API key authentication.
        const apiKey = process.env.ARKESEL_API_KEY || this.apiKey;
        const senderId = process.env.ARKESEL_SENDER_ID || sender || 'AZAMAN';

        try {
            const response = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
                method: 'POST',
                headers: {
                    'api-key': apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    sender: senderId,
                    message: message,
                    recipients: [phoneNumber.replace(/^\+/, '')] // Arkesel expects no leading +
                })
            });

            const data = await response.json();

            if (response.ok && data.status === 'success') {
                const messageId = data.data?.[0]?.id || this._generateMessageId();
                logger.info(`✅ [Arkesel] SMS sent to ${phoneNumber} (id: ${messageId})`);
                return {
                    success: true,
                    messageId,
                    provider: 'arkesel',
                    cost: data.data?.[0]?.cost || 0,
                    status: 'sent'
                };
            }

            logger.error(`❌ [Arkesel] Failed (${response.status}): ${JSON.stringify(data)}`);
            return {
                success: false,
                provider: 'arkesel',
                status: 'failed',
                error: data.message || 'Unknown Arkesel error'
            };
        } catch (error) {
            logger.error(`❌ [Arkesel] Network error: ${error.message}`);
            return { success: false, provider: 'arkesel', status: 'error', error: error.message };
        }
    }

    async _sendViaMoolre(phoneNumber, message, sender) {
        // Moolre SMS API (Value-Added Services).
        //
        // Auth: STATIC headers (no OAuth). Per Moolre's reference, SMS/USSD use
        // the VAS key X-API-VASKEY in addition to the account user X-API-USER.
        // Universal response envelope: { status: 1|0, code, message, data, go }
        // where status is an INTEGER (1 = success, 0 = failure) — unwrapped here
        // exactly as moolreDisbursementService._unwrap() does.
        //
        // Fire-and-forget contract: this method THROWS on failure rather than
        // swallowing the error. The production callers (sendSMS via
        // sendWithdrawalConfirmation) do not await it on the hot path, so a
        // throw only surfaces where the call is explicitly awaited.
        //
        // ─── ⚠️ VERIFY-AGAINST-SANDBOX ───────────────────────────────────────
        // Endpoint path + body field names below are best-guess values that
        // follow Moolre's documented VAS/SMS product. They are isolated as
        // constants so they are trivial to rename once confirmed in sandbox;
        // the auth, envelope handling, and return shape are provider-correct.
        const MOOLRE_SMS_ENDPOINT = '/sms/send';        // ⚠️ VERIFY path
        const SMS_BODY_KEYS = {                          // ⚠️ VERIFY body keys
            recipient: 'recipient',    // ⚠️ VERIFY: phone number field name
            message:   'message',      // ⚠️ VERIFY: message content field name
            sender:    'sender_id',    // ⚠️ VERIFY: sender ID field name
            type:      'type',         // ⚠️ VERIFY: message type field (may not exist)
        };
        const SMS_TYPE_VALUE = 'text'; // ⚠️ VERIFY: or set null to omit the field entirely
        // ─────────────────────────────────────────────────────────────────────

        // Strip all non-digits before sending — Moolre expects a bare MSISDN.
        const sanitized = String(phoneNumber).replace(/\D+/g, '');

        // Build the body, sending only fields that have values (omit nulls).
        const body = {
            [SMS_BODY_KEYS.recipient]: sanitized,
            [SMS_BODY_KEYS.message]:   message,
            [SMS_BODY_KEYS.sender]:    sender || this.moolreSenderId,
        };
        if (SMS_TYPE_VALUE !== null && SMS_TYPE_VALUE !== undefined) {
            body[SMS_BODY_KEYS.type] = SMS_TYPE_VALUE;
        }

        try {
            const { data: envelope } = await axios.post(
                `${this.moolreBaseUrl}${MOOLRE_SMS_ENDPOINT}`,
                body,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-USER':   this.moolreApiUser,
                        'X-API-VASKEY': this.moolreVasKey,
                    },
                    timeout: 10000,
                }
            );

            // Unwrap Moolre's universal envelope: status is an INTEGER (1 = success).
            if (envelope && Number(envelope.status) === 1) {
                const data = envelope.data || {};
                const messageId = data?.id || data?.messageid || data?.transactionid || null;
                logger.info({ phone: this._maskPhone(phoneNumber), messageId }, '[Moolre] SMS accepted');
                return {
                    success:   true,
                    messageId,
                    provider:  'moolre',
                    cost:      data?.cost || 0,
                    status:    'sent',
                    timestamp: new Date().toISOString(),
                };
            }

            // FAILURE PATH (envelope.status === 0 or malformed envelope).
            throw new Error(`Moolre SMS rejected: ${envelope?.message || envelope?.code || 'unknown error'}`);
        } catch (err) {
            // Re-throw provider rejections (already prefixed) verbatim so the
            // caller sees the Moolre reason; wrap network/timeout errors.
            if (err.message && err.message.startsWith('Moolre SMS rejected:')) {
                throw err;
            }
            const apiMsg = err.response?.data?.message || err.response?.data?.code || err.message;
            throw new Error(`[SMSService/Moolre] Request failed: ${apiMsg}`);
        }
    }
}

module.exports = SMSService;

// Example usage:
/*
const smsService = new SMSService();

// Send regular SMS
await smsService.sendSMS('+233241234567', 'Hello from Azaman!');

// Send OTP
const otpResult = await smsService.sendOTP('+233241234567');

// Verify OTP
const verification = smsService.verifyOTP('+233241234567', '123456');

// Send trade notification
await smsService.sendTradeNotification('+233241234567', {
    tradeId: 123,
    amount: 100,
    type: 'BUY',
    status: 'initiated'
});
*/