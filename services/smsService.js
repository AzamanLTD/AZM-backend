/**
 * SMS Service - Placeholder Implementation
 * 
 * This service provides mock SMS functionality that can be easily replaced
 * with real SMS providers like Twilio, AWS SNS, or local providers.
 */

const logger = require('../src/config/logger');
const crypto = require('crypto');
const axios  = require('axios');

// ---------------------------------------------------------------------------
// ATOMIC OTP PRIMITIVES
//
// The old flow read, decided and wrote in three separate round trips, so two
// concurrent requests could both pass a limit check or both consume one code.
// Redis executes a script as a single atomic step, so the decision and the
// mutation cannot interleave.
// ---------------------------------------------------------------------------

// Reserves a send slot: min-interval key + hourly counter, both in one step.
const OTP_RESERVE_LUA = `
local interval = tonumber(ARGV[1])
local window   = tonumber(ARGV[2])
local cap      = tonumber(ARGV[3])
local now      = tonumber(ARGV[4])
local ok = redis.call('SET', KEYS[1], now, 'PX', interval, 'NX')
if not ok then
  local last = tonumber(redis.call('GET', KEYS[1]) or '0')
  return {0, 'TOO_SOON', tostring(interval - (now - last))}
end
local count = redis.call('INCR', KEYS[2])
if count == 1 then redis.call('PEXPIRE', KEYS[2], window) end
if count > cap then
  redis.call('DEL', KEYS[1])
  return {0, 'LIMIT', '0'}
end
return {1, 'RESERVED', tostring(count)}
`;

// Verifies, counts the attempt and consumes the code in one step. Passing the
// digest (not the code) means the plaintext never reaches the store.
const OTP_VERIFY_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, 'NOTFOUND', '0'} end
local rec = cjson.decode(raw)
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then ttl = 0 end
if tonumber(rec.expiresAtMs) < tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  return {0, 'EXPIRED', '0'}
end
local max = tonumber(rec.maxAttempts)
if tonumber(rec.attempts) >= max then
  redis.call('DEL', KEYS[1])
  return {0, 'LOCKED', '0'}
end
if rec.codeHash == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return {1, 'OK', '0'}
end
rec.attempts = tonumber(rec.attempts) + 1
if rec.attempts >= max then
  redis.call('DEL', KEYS[1])
  return {0, 'LOCKED', '0'}
end
redis.call('SET', KEYS[1], cjson.encode(rec), 'PX', math.max(ttl, 1))
return {0, 'WRONG', tostring(max - rec.attempts)}
`;

// Provider adapters that are GENUINELY implemented against a documented
// contract. Anything else (today: twilio, aws_sns, hubtel) is a placeholder
// that must never be able to answer 'success'.
const IMPLEMENTED_SMS_PROVIDERS = new Set(['moolre', 'arkesel']);
const PLACEHOLDER_SMS_PROVIDERS = new Set(['twilio', 'aws_sns', 'hubtel']);

class SMSService {
    constructor() {
        // No placeholder fallback: a missing key must read as missing, not as
        // a literal that can be sent to a provider.
        this.apiKey = process.env.SMS_API_KEY || null;

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
        // Production must not fall back to the sandbox endpoint, and an adapter
        // with no documented-contract verification is not production-ready.
        // Both are refused at send time (SMS_PROVIDER_MISCONFIGURED) rather than
        // discovered by a customer who never receives an OTP.
        this.moolreEnvIsProd = moolreUseProd;
        this.moolreUsesSandbox = !/^https:\/\/api\.moolre\.com/i.test(this.moolreBaseUrl);
        this.moolreConfigError = null;
        if (process.env.NODE_ENV === 'production' && (process.env.SMS_PROVIDER || '').toLowerCase() === 'moolre') {
            if (!moolreUseProd) {
                this.moolreConfigError = 'MOOLRE_ENV is not set to production';
            } else if (this.moolreUsesSandbox) {
                this.moolreConfigError = 'Moolre base URL is not the production endpoint';
            } else if (!this.moolreApiUser || !this.moolreVasKey) {
                this.moolreConfigError = 'MOOLRE_API_USER / MOOLRE_VAS_KEY missing';
            }
        }
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
        this._otpMaxAttempts = Math.max(1, Number(process.env.OTP_MAX_ATTEMPTS || 3));
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

        // PLACEHOLDER REFUSAL comes before dispatch so no configured-but-unbuilt
        // adapter can ever answer success.
        if (PLACEHOLDER_SMS_PROVIDERS.has(this.provider)) {
            const err = new Error("SMS provider '" + this.provider + "' is not implemented (placeholder adapter). Configure an implemented provider: " + [...IMPLEMENTED_SMS_PROVIDERS].join(', ') + ".");
            err.code = 'SMS_PROVIDER_UNSUPPORTED';
            logger.error({ provider: this.provider, phone: this._maskPhone(phoneNumber) }, '[SMSService] refusing placeholder provider');
            throw err;
        }
        if (!IMPLEMENTED_SMS_PROVIDERS.has(this.provider)) {
            const err = new Error("SMS provider '" + this.provider + "' is not a recognised implemented adapter.");
            err.code = 'SMS_PROVIDER_UNSUPPORTED';
            throw err;
        }

        switch (this.provider.toLowerCase()) {
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

        const record = {
            codeHash: this._hashCode(phoneNumber, otp),
            expiresAtMs: expiresAt.getTime(),
            maxAttempts: this._otpMaxAttempts || 3,
            attempts: 0,
        };
        const otpKey = `otp:${phoneNumber}`;
        if (durable) {
            await this._redisClient.set(otpKey, JSON.stringify(record), 'EX', expiryMinutes * 60);
        } else {
            this.otpStore.set(phoneNumber, { ...record });
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

    /**
     * Bounded resend: min interval + hourly cap, per phone.
     *
     * Redis path is ONE atomic script, so N simultaneous requests reserve
     * exactly one slot. The Map path is synchronous JavaScript, which is also
     * uninterruptible between its check and its write — the same guarantee from
     * the same single-threaded ordering, not a weaker one.
     */
    async _enforceSendThrottle(phoneNumber) {
        const now = Date.now();
        const intervalKey = `otp:rl:i:${phoneNumber}`;
        const windowKey = `otp:rl:w:${phoneNumber}`;

        if (this._redisClient) {
            const [ok, why, detail] = await this._redisClient.eval(
                OTP_RESERVE_LUA, 2, intervalKey, windowKey,
                String(this._sendMinIntervalMs), String(this._sendWindowMs),
                String(this._sendMaxPerWindow), String(now)
            );
            if (Number(ok) !== 1) {
                if (why === 'LIMIT') {
                    const err = new Error('Too many verification codes requested for this number. Try again later.');
                    err.code = 'OTP_SEND_LIMIT_EXCEEDED';
                    throw err;
                }
                const err = new Error('Please wait before requesting another code.');
                err.code = 'OTP_RESEND_TOO_SOON';
                err.retryAfterMs = Number(detail) > 0 ? Number(detail) : this._sendMinIntervalMs;
                throw err;
            }
            return;
        }

        const state = this._sendThrottle.get(phoneNumber) || { last: 0, count: 0, windowStart: 0 };
        if (now - state.last < this._sendMinIntervalMs) {
            const err = new Error('Please wait before requesting another code.');
            err.code = 'OTP_RESEND_TOO_SOON';
            err.retryAfterMs = this._sendMinIntervalMs - (now - state.last);
            throw err;
        }
        const inWindow = now - state.windowStart < this._sendWindowMs;
        const count = inWindow ? state.count + 1 : 1;
        if (count > this._sendMaxPerWindow) {
            const err = new Error('Too many verification codes requested for this number. Try again later.');
            err.code = 'OTP_SEND_LIMIT_EXCEEDED';
            throw err;
        }
        this._sendThrottle.set(phoneNumber, {
            last: now,
            count,
            windowStart: inWindow ? state.windowStart : now,
        });
    }

    /** Keyed digest of a code. The plaintext never reaches the store. */
    _hashCode(phoneNumber, code) {
        const secret = this._otpHashSecret();
        return crypto.createHmac('sha256', secret).update(`${phoneNumber}:${code}`).digest('hex');
    }

    /**
     * The digest key is a dedicated server-side secret. Production has no
     * fallback: a missing key fails closed. Development/test derive a clearly
     * labelled key so local flows keep working (and say so, loudly, once).
     */
    _otpHashSecret() {
        const configured = process.env.OTP_HASH_SECRET;
        if (configured && configured.length >= 16) return configured;
        if (this.isProduction) {
            const err = new Error('OTP_HASH_SECRET is required in production (dedicated secret for OTP digests).');
            err.code = 'OTP_HASH_SECRET_MISSING';
            throw err;
        }
        if (!this._warnedDevSecret) {
            this._warnedDevSecret = true;
            logger.warn('[SMSService] OTP_HASH_SECRET unset — using the documented DEVELOPMENT-ONLY digest key. Never deploy this.');
        }
        return 'azaman-development-only-otp-digest-key';
    }

    /**
     * Bounded, redacted diagnostic text for provider errors. Digit runs long
     * enough to be a code or a phone number are masked, and the result is
     * capped so a provider that echoes the request cannot dump it into a log.
     */
    _scrubBody(text, maxLen = 160) {
        if (text === undefined || text === null) return '';
        let out = String(text);
        out = out.replace(/\d[\d\s-]{3,}/g, '[redacted]');
        out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]');
        return out.length > maxLen ? out.slice(0, maxLen) + '…' : out;
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
        const durable = this._requireDurableOtpStore();
        const otpKey = `otp:${phoneNumber}`;
        const digest = this._hashCode(phoneNumber, code);
        const nowMs = Date.now();

        // ONE atomic step (Redis script, or the equally uninterruptible
        // synchronous Map path). Two concurrent correct requests can therefore
        // never both succeed: the second finds the key already consumed.
        if (durable) {
            const [ok, why, detail] = await this._redisClient.eval(
                OTP_VERIFY_LUA, 1, otpKey, digest, String(nowMs)
            );
            return this._verifyOutcome(why, Number(detail));
        }

        const rec = this.otpStore.get(phoneNumber);
        if (!rec) return this._verifyOutcome('NOTFOUND', 0);

        const expired = rec.expiresAtMs !== undefined
            ? Number(rec.expiresAtMs) < nowMs
            : new Date(rec.expiresAt).getTime() < nowMs;
        if (expired) {
            this.otpStore.delete(phoneNumber);
            return this._verifyOutcome('EXPIRED', 0);
        }
        const max = Number(rec.maxAttempts || this._otpMaxAttempts);
        if (Number(rec.attempts || 0) >= max) {
            this.otpStore.delete(phoneNumber);
            return this._verifyOutcome('LOCKED', 0);
        }
        // Digest match is the contract; a planted legacy `code` is accepted for
        // test fixtures only, compared in constant time.
        const matched = rec.codeHash
            ? this._safeEqual(rec.codeHash, digest)
            : this._safeEqual(String(rec.code), String(code));
        if (matched) {
            this.otpStore.delete(phoneNumber);
            return this._verifyOutcome('OK', 0);
        }
        rec.attempts = Number(rec.attempts || 0) + 1;
        if (rec.attempts >= max) {
            this.otpStore.delete(phoneNumber);
            return this._verifyOutcome('LOCKED', 0);
        }
        this.otpStore.set(phoneNumber, rec);
        return this._verifyOutcome('WRONG', max - rec.attempts);
    }

    /** Single place where a store verdict becomes an API verdict. */
    _verifyOutcome(why, attemptsLeft) {
        switch (why) {
            case 'OK':
                return { success: true, message: 'OTP verified successfully' };
            case 'NOTFOUND':
                return { success: false, message: 'No OTP found for this phone number' };
            case 'EXPIRED':
                return { success: false, message: 'OTP has expired' };
            case 'LOCKED':
                return { success: false, message: 'Maximum verification attempts exceeded' };
            default:
                return { success: false, message: 'Invalid OTP code', attemptsLeft };
        }
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
        // A verification code is a credential: Math.random() is predictable from
        // engine state and must not generate it. crypto.randomInt is uniform and
        // CSPRNG-backed. Digits are appended one at a time so a leading zero is
        // preserved (numeric generation would drop it and shorten the code).
        let otp = '';
        for (let i = 0; i < length; i += 1) {
            otp += crypto.randomInt(0, 10).toString();
        }
        return otp;
    }

    /**
     * Constant-time string comparison. A verification code is a credential, so
     * its comparison must not leak prefix/length information through timing.
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

    // =====================================================================
    // APP-UNLOCK CHALLENGES (purpose-bound)
    //
    // These are deliberately NOT sendOTP/verifyOTP. A phone-verification OTP is
    // stored at `otp:<phone>`; an unlock challenge lives at
    // `otp:APP_UNLOCK:<userId>:<challengeId>`. Different key space, different
    // purpose, different subject in the digest, so neither can be replayed as
    // the other. Nothing here writes phoneNumber, phoneVerified or the identity
    // phone hash.
    // =====================================================================

    _unlockKey(userId, challengeId) {
        return `otp:APP_UNLOCK:${userId}:${challengeId}`;
    }

    /**
     * Can this deployment actually deliver an SMS right now?
     * @returns {{available: boolean, reason: string|null}}
     */
    /**
     * Real-credential check, per provider. Presence of a provider NAME is not
     * readiness: a placeholder key, a missing sender or a sandbox-only config
     * must all read as unavailable rather than being advertised to the client.
     * Values are never returned, only a reason code.
     */
    arkeselCredentialProblem() {
        const key = process.env.ARKESEL_API_KEY || this.apiKey;
        if (!key || key === 'mock_sms_api_key' || /^mock/i.test(String(key)) || String(key).length < 16) {
            return 'ARKESEL_KEY_MISSING';
        }
        const sender = process.env.ARKESEL_SENDER_ID || process.env.SMS_SENDER_ID;
        if (!sender || String(sender).trim().length < 2) {
            return 'ARKESEL_SENDER_MISSING';
        }
        return null;
    }

    unlockDeliverability() {
        const provider = String(this.provider || '').toLowerCase();
        if (this.misconfigured) {
            return { available: false, reason: 'SMS_PROVIDER_MISCONFIGURED' };
        }
        if (provider === 'mock' || this.isTestMode) {
            return { available: false, reason: 'MOCK_PROVIDER' };
        }
        if (!IMPLEMENTED_SMS_PROVIDERS.has(provider)) {
            return { available: false, reason: 'SMS_PROVIDER_UNSUPPORTED' };
        }
        if (provider === 'moolre' && this.moolreConfigError) {
            return { available: false, reason: 'SMS_PROVIDER_MISCONFIGURED' };
        }
        if (provider === 'arkesel') {
            const problem = this.arkeselCredentialProblem();
            if (problem) return { available: false, reason: problem };
        }
        if (this.isProduction && !this._redisClient) {
            return { available: false, reason: 'OTP_STORE_UNAVAILABLE' };
        }
        return { available: true, reason: null };
    }

    /**
     * Reserve a send slot, mint a code and store a keyed digest bound to
     * userId + challengeId + purpose. A provider failure removes the challenge
     * so nothing verifiable is left behind.
     */
    async issueUnlockChallenge({ userId, phoneNumber, purpose, ttlSeconds = 300, length = 6 }) {
        if (purpose !== 'APP_UNLOCK') {
            const err = new Error(`Unsupported challenge purpose: ${purpose}`);
            err.code = 'CHALLENGE_PURPOSE_UNSUPPORTED';
            throw err;
        }
        const durability = this._requireDurableOtpStore();
        // Per-user throttle, in its own namespace so a phone-verification
        // resend never consumes the unlock budget (or vice versa).
        await this._enforceSendThrottle(`APP_UNLOCK:${userId}`);

        const code = this._generateOTP(length);
        const challengeId = crypto.randomUUID();
        const key = this._unlockKey(userId, challengeId);
        const expiresAtMs = Date.now() + ttlSeconds * 1000;
        const record = {
            purpose,
            userId,
            challengeId,
            // Bound to the account AND the challenge: a digest from another
            // user's challenge, or from phone verification, cannot match.
            codeHash: this._hashCode(`${purpose}:${userId}:${challengeId}`, code),
            expiresAtMs,
            attempts: 0,
            maxAttempts: this._otpMaxAttempts || 3,
        };

        if (durability) {
            await this._redisClient.set(key, JSON.stringify(record), 'PX', ttlSeconds * 1000);
        } else {
            this.otpStore.set(key, record);
        }

        const body = `Your Azaman unlock code is ${code}. Valid for ${Math.round(ttlSeconds / 60)} minutes. Never share it.`;
        let result;
        try {
            result = await this.sendSMS(phoneNumber, body);
        } catch (err) {
            await this._deleteUnlockChallenge(userId, challengeId);
            throw err;
        }
        if (!result || result.success !== true) {
            await this._deleteUnlockChallenge(userId, challengeId);
            const err = new Error('SMS provider did not accept the unlock message.');
            err.code = 'SMS_SEND_FAILED';
            throw err;
        }

        return {
            challengeId,
            maskedPhone: this._maskPhone(phoneNumber),
            expiresAt: new Date(expiresAtMs).toISOString(),
            mocked: result.mocked === true,
        };
    }

    async _deleteUnlockChallenge(userId, challengeId) {
        const key = this._unlockKey(userId, challengeId);
        if (this._redisClient) await this._redisClient.del(key);
        else this.otpStore.delete(key);
    }

    /**
     * Atomically consume a challenge. Single Lua step in Redis: only one
     * concurrent correct verification can win, and the attempt budget cannot be
     * bypassed by concurrency.
     * @returns {{outcome: 'OK'|'NOTFOUND'|'EXPIRED'|'LOCKED'|'WRONG', attemptsLeft?: number}}
     */
    async consumeUnlockChallenge({ userId, phoneNumber, purpose, challengeId, code }) {
        if (purpose !== 'APP_UNLOCK') {
            return { outcome: 'NOTFOUND' };
        }
        const durable = this._requireDurableOtpStore();
        const key = this._unlockKey(userId, challengeId);
        const digest = this._hashCode(`${purpose}:${userId}:${challengeId}`, String(code));

        if (durable) {
            const [ok, outcome, left] = await this._redisClient.eval(
                OTP_VERIFY_LUA, 1, key, digest, String(Date.now()),
            );
            return {
                outcome,
                attemptsLeft: Number(ok) === 1 || outcome !== 'WRONG' ? undefined : Number(left),
            };
        }

        const rec = this.otpStore.get(key);
        if (!rec) return { outcome: 'NOTFOUND' };
        if (rec.userId !== userId || rec.purpose !== purpose) return { outcome: 'NOTFOUND' };
        if (Number(rec.expiresAtMs) < Date.now()) {
            this.otpStore.delete(key);
            return { outcome: 'EXPIRED' };
        }
        const max = Number(rec.maxAttempts || this._otpMaxAttempts || 3);
        if (Number(rec.attempts) >= max) {
            this.otpStore.delete(key);
            return { outcome: 'LOCKED' };
        }
        if (this._safeEqual(rec.codeHash, digest)) {
            this.otpStore.delete(key);
            return { outcome: 'OK' };
        }
        rec.attempts = Number(rec.attempts) + 1;
        if (rec.attempts >= max) {
            this.otpStore.delete(key);
            return { outcome: 'LOCKED' };
        }
        this.otpStore.set(key, rec);
        return { outcome: 'WRONG', attemptsLeft: max - rec.attempts };
    }

    _generateMessageId() {
        return 'msg_' + crypto.randomUUID();
    }

    // Placeholder methods for real SMS providers
    // Replace these with actual API calls

    async _sendViaTwilio() {
        // NOT IMPLEMENTED. This adapter once returned { success: true },
        // which let a configured-but-unbuilt provider report a delivery
        // that never happened. It fails with a stable code instead.
        const err = new Error('SMS provider "twilio" is not implemented; refusing to simulate a send.');
        err.code = 'SMS_PROVIDER_UNSUPPORTED';
        throw err;
    }

    async _sendViaAWS() {
        // NOT IMPLEMENTED. This adapter once returned { success: true },
        // which let a configured-but-unbuilt provider report a delivery
        // that never happened. It fails with a stable code instead.
        const err = new Error('SMS provider "aws_sns" is not implemented; refusing to simulate a send.');
        err.code = 'SMS_PROVIDER_UNSUPPORTED';
        throw err;
    }

    async _sendViaHubtel() {
        // NOT IMPLEMENTED. This adapter once returned { success: true },
        // which let a configured-but-unbuilt provider report a delivery
        // that never happened. It fails with a stable code instead.
        const err = new Error('SMS provider "hubtel" is not implemented; refusing to simulate a send.');
        err.code = 'SMS_PROVIDER_UNSUPPORTED';
        throw err;
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
                logger.info({ phone: this._maskPhone(phoneNumber), messageId, provider: 'arkesel' }, '[Arkesel] SMS accepted by provider');
                return {
                    success: true,
                    messageId,
                    provider: 'arkesel',
                    cost: data.data?.[0]?.cost || 0,
                    status: 'sent'
                };
            }

            // Never serialise the provider payload: it can echo the recipient,
            // the message body or an OTP back at us. Status + a bounded scrubbed
            // reason is enough to diagnose a failure.
            logger.error(
                {
                    status: response.status,
                    reason: this._scrubBody(data && (data.message || data.error || '')),
                },
                '[Arkesel] provider refused the send'
            );
            return {
                success: false,
                provider: 'arkesel',
                status: 'failed',
                error: data.message || 'Unknown Arkesel error'
            };
        } catch (error) {
            logger.error(
                { reason: this._scrubBody(error && error.message) },
                '[Arkesel] network error (no code/recipient logged)'
            );
            return { success: false, provider: 'arkesel', status: 'error', error: error.message };
        }
    }

    async _sendViaMoolre(phoneNumber, message, sender) {
        if (this.moolreConfigError) {
            const err = new Error('Moolre SMS is not usable in production: ' + this.moolreConfigError + '. Refusing to send.');
            err.code = 'SMS_PROVIDER_MISCONFIGURED';
            logger.error(
                { provider: 'moolre', reason: this.moolreConfigError, phone: this._maskPhone(phoneNumber) },
                '[Moolre] refusing send on unusable production configuration'
            );
            throw err;
        }

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