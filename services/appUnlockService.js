// services/appUnlockService.js
// =============================================================================
// MEMBER APP UNLOCK — server-managed unlock factors.
//
// A member sees the normal interface on app open without an auth prompt. To
// reveal protected balance/transaction content they tap the Home Plus lock and
// authenticate with a SERVER-MANAGED method: Azaman PIN, authenticator/TOTP, or
// SMS OTP. Device Face ID / fingerprint / passcode are performed locally by
// `local_auth` and are never represented here — a local biometric success is not
// a backend challenge and is not a transaction authorization.
//
// WHY THIS IS SEPARATE FROM THE EXISTING ENDPOINTS
//   /security/pin/verify       answers "is this pin correct" (200 + verified bool)
//                              with no attempt budget of its own.
//   /security/2fa/verify       ENROLLS the authenticator (sets isTwoFactorEnabled).
//   /security/phone/verify-otp CONFIRMS a phone and mutates phoneNumber /
//                              phoneVerified / the identity hash.
// Reusing any of those as the unlock challenge would conflate enrollment with
// unlock, or let an unlock mutate identity state. This service is purpose-built
// and must never write phone identity or TOTP enrollment state.
//
// UNLOCK GRANTS NOTHING BUT A VERDICT. No session, no token, no refresh — a
// correct PIN unlocks the local screen, not a new login.
// =============================================================================

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const logger = require('../src/config/logger');

const PURPOSES = Object.freeze({
    PHONE_VERIFICATION: 'PHONE_VERIFICATION',
    APP_UNLOCK: 'APP_UNLOCK',
});

/** Unlock attempt budgets. Deliberately stricter than a login. */
const PIN_MAX_ATTEMPTS = Number(process.env.APP_UNLOCK_PIN_MAX_ATTEMPTS || 5);
const TOTP_MAX_ATTEMPTS = Number(process.env.APP_UNLOCK_TOTP_MAX_ATTEMPTS || 5);
const TOTP_WINDOW_MS = Number(process.env.APP_UNLOCK_TOTP_WINDOW_MS || 15 * 60 * 1000);
const PIN_WINDOW_MS = Number(process.env.APP_UNLOCK_PIN_WINDOW_MS || 15 * 60 * 1000);
const TOTP_WINDOW_SECONDS = Number(process.env.APP_UNLOCK_TOTP_REPLAY_TTL || 90);

const PIN_ATTEMPT_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`;

const PIN_RESET_LUA = `return redis.call('DEL', KEYS[1])`;

/** Attempt counter: Redis when present, synchronous Map otherwise (dev/test). */
const _memoryCounters = new Map();

class AppUnlockService {
    /**
     * @param {object} deps
     * @param {object} deps.prisma       request-scoped Prisma client
     * @param {object} deps.smsService   the SMS/OTP service (purpose-aware)
     */
    constructor({ prisma, smsService }) {
        this.prisma = prisma;
        this.smsService = smsService;
        this._redis = smsService && smsService._redisClient ? smsService._redisClient : null;
    }

    // ---------------------------------------------------------------- budgets
    async _bumpAttempts(userId) {
        const key = `appunlock:pin:attempts:${userId}`;
        if (this._redis) {
            const n = await this._redis.eval(PIN_ATTEMPT_LUA, 1, key, String(PIN_WINDOW_MS));
            return Number(n);
        }
        const now = Date.now();
        const rec = _memoryCounters.get(key) || { n: 0, resetAt: now + PIN_WINDOW_MS };
        if (now >= rec.resetAt) {
            rec.n = 0;
            rec.resetAt = now + PIN_WINDOW_MS;
        }
        rec.n += 1;
        _memoryCounters.set(key, rec);
        return rec.n;
    }

    async _clearAttempts(userId) {
        const key = `appunlock:pin:attempts:${userId}`;
        if (this._redis) {
            await this._redis.eval(PIN_RESET_LUA, 1, key);
        } else {
            _memoryCounters.delete(key);
        }
    }

    async _attemptsLeft(userId) {
        const key = `appunlock:pin:attempts:${userId}`;
        if (this._redis) {
            const raw = await this._redis.get(key);
            return Math.max(0, PIN_MAX_ATTEMPTS - Number(raw || 0));
        }
        const rec = _memoryCounters.get(key);
        if (!rec || Date.now() >= rec.resetAt) return PIN_MAX_ATTEMPTS;
        return Math.max(0, PIN_MAX_ATTEMPTS - rec.n);
    }

    // ----------------------------------------------------------- capabilities
    /**
     * Read-only. Never returns a hash, secret, code or raw phone number, and
     * never claims SMS is usable because SMS_PROVIDER merely has a value.
     */
    async capabilities(user) {
        const pinConfigured = typeof user.pinHash === 'string' && user.pinHash.length > 0;
        const authenticatorConfigured = user.isTwoFactorEnabled === true
            && typeof user.twoFactorSecret === 'string'
            && user.twoFactorSecret.length > 0;
        const phoneVerified = user.phoneVerified === true;

        let smsUnlockAvailable = false;
        let smsReason = 'PHONE_UNVERIFIED';
        if (phoneVerified && this.smsService && typeof this.smsService.unlockDeliverability === 'function') {
            const d = this.smsService.unlockDeliverability();
            smsUnlockAvailable = d.available === true;
            smsReason = d.reason;
        } else if (phoneVerified) {
            smsReason = 'SMS_SERVICE_UNAVAILABLE';
        }

        return {
            pinConfigured,
            authenticatorConfigured,
            phoneVerified,
            smsUnlockAvailable,
            // Diagnostics for the client, never a secret: why SMS is unavailable.
            smsUnavailableReason: smsUnlockAvailable ? null : smsReason,
        };
    }

    // -------------------------------------------------------------------- PIN
    async verifyPin(user, pin) {
        if (typeof pin !== 'string' || pin.length === 0) {
            return { ok: false, code: 'PIN_REQUIRED', status: 400 };
        }
        if (!user.pinHash) {
            // Same shape as a wrong PIN to a caller that only reads `code`;
            // the typed code tells the client the truth without revealing
            // anything about another account.
            return { ok: false, code: 'PIN_NOT_CONFIGURED', status: 409 };
        }

        const left = await this._attemptsLeft(user.id);
        if (left <= 0) {
            return { ok: false, code: 'PIN_LOCKED', status: 429, attemptsLeft: 0 };
        }

        const match = await bcrypt.compare(pin, user.pinHash);
        if (!match) {
            const used = await this._bumpAttempts(user.id);
            const remaining = Math.max(0, PIN_MAX_ATTEMPTS - used);
            logger.warn({ userId: user.id, attemptsLeft: remaining }, '[appUnlock] PIN refused');
            return {
                ok: false,
                code: remaining > 0 ? 'PIN_INVALID' : 'PIN_LOCKED',
                status: remaining > 0 ? 401 : 429,
                attemptsLeft: remaining,
            };
        }

        await this._clearAttempts(user.id);
        return { ok: true, code: 'PIN_OK', status: 200 };
    }

    /** Setting a PIN when one already exists requires proof of the current PIN. */
    async setPin(user, { newPin, currentPin }) {
        if (typeof newPin !== 'string' || !/^\d{4,8}$/.test(newPin)) {
            return { ok: false, code: 'PIN_FORMAT_INVALID', status: 400 };
        }
        if (user.pinHash) {
            const proof = await this.verifyPin(user, currentPin);
            if (!proof.ok) return proof;
        }
        const pinHash = await bcrypt.hash(newPin, 10);
        await this.prisma.user.update({ where: { id: user.id }, data: { pinHash } });
        return { ok: true, code: 'PIN_SET', status: 200 };
    }

    /** Removal requires fresh proof of an already-enrolled factor. */
    async removePin(user, { currentPin, totpCode }) {
        if (!user.pinHash) {
            return { ok: false, code: 'PIN_NOT_CONFIGURED', status: 409 };
        }

        let proof;
        if (typeof currentPin === 'string' && currentPin.length > 0) {
            proof = await this.verifyPin(user, currentPin);
        } else if (typeof totpCode === 'string' && totpCode.length > 0) {
            proof = await this.verifyTotp(user, totpCode);
        } else {
            return { ok: false, code: 'PROOF_REQUIRED', status: 400 };
        }
        if (!proof.ok) return proof;

        // Only this user's hash, and only after the proof passed. The write must
        // commit before we report success: the client is told "removed" only
        // when the database says it is gone.
        await this.prisma.user.update({ where: { id: user.id }, data: { pinHash: null } });
        return { ok: true, code: 'PIN_REMOVED', status: 200 };
    }

    // ------------------------------------------------------------------- TOTP
    /**
     * Unlock with the authenticator. Requires enrollment, never touches
     * enrollment state, and refuses a code that has already been used for an
     * unlock inside its validity window (replay guard).
     */
    /**
     * Per-user TOTP attempt budget. A global IP limiter does not stop targeted
     * abuse of one account, so this is its own counter in the shared store with
     * the same atomic INCR+PEXPIRE script the PIN path uses.
     */
    async _totpAttemptsLeft(userId) {
        const key = `appunlock:totp:attempts:${userId}`;
        if (this._redis) {
            const raw = await this._redis.get(key);
            return Math.max(0, TOTP_MAX_ATTEMPTS - Number(raw || 0));
        }
        const rec = _memoryCounters.get(key);
        if (!rec || Date.now() >= rec.resetAt) return TOTP_MAX_ATTEMPTS;
        return Math.max(0, TOTP_MAX_ATTEMPTS - rec.n);
    }

    async _bumpTotpAttempts(userId) {
        const key = `appunlock:totp:attempts:${userId}`;
        if (this._redis) {
            return Number(await this._redis.eval(PIN_ATTEMPT_LUA, 1, key, String(TOTP_WINDOW_MS)));
        }
        const now = Date.now();
        const rec = _memoryCounters.get(key);
        if (!rec || now >= rec.resetAt) {
            const fresh = { n: 1, resetAt: now + TOTP_WINDOW_MS };
            _memoryCounters.set(key, fresh);
            return 1;
        }
        rec.n += 1;
        return rec.n;
    }

    async _clearTotpAttempts(userId) {
        const key = `appunlock:totp:attempts:${userId}`;
        if (this._redis) await this._redis.eval(PIN_RESET_LUA, 1, key);
        else _memoryCounters.delete(key);
    }

    async verifyTotp(user, token) {
        if (typeof token !== 'string' || token.trim().length === 0) {
            return { ok: false, code: 'TOTP_REQUIRED', status: 400 };
        }
        if (user.isTwoFactorEnabled !== true || !user.twoFactorSecret) {
            return { ok: false, code: 'TOTP_NOT_CONFIGURED', status: 409 };
        }

        const left = await this._totpAttemptsLeft(user.id);
        if (left <= 0) {
            return { ok: false, code: 'TOTP_LOCKED', status: 429, attemptsLeft: 0 };
        }

        const valid = speakeasy.totp.verify({
            secret: user.twoFactorSecret,
            encoding: 'base32',
            token: token.trim(),
            window: 1,
        });
        if (!valid) {
            const used = await this._bumpTotpAttempts(user.id);
            const remaining = Math.max(0, TOTP_MAX_ATTEMPTS - used);
            logger.warn({ userId: user.id, attemptsLeft: remaining }, '[appUnlock] TOTP refused');
            return {
                ok: false,
                code: remaining > 0 ? 'TOTP_INVALID' : 'TOTP_LOCKED',
                status: remaining > 0 ? 401 : 429,
                attemptsLeft: remaining,
            };
        }

        await this._clearTotpAttempts(user.id);

        const claimed = await this._claimTotpCode(user.id, token.trim());
        if (!claimed) {
            return { ok: false, code: 'TOTP_REPLAYED', status: 409 };
        }
        return { ok: true, code: 'TOTP_OK', status: 200 };
    }

    /**
     * Atomic single-use claim for a TOTP value. Redis SET NX is the atomic
     * primitive; without Redis the platform is single-process (dev/test) and the
     * Map check is equivalent.
     */
    async _claimTotpCode(userId, token) {
        const digest = crypto.createHash('sha256').update(`${userId}:${token}`).digest('hex');
        const key = `appunlock:totp:used:${userId}:${digest}`;
        if (this._redis) {
            const res = await this._redis.set(key, '1', 'EX', TOTP_WINDOW_SECONDS, 'NX');
            return res === 'OK';
        }
        if (_memoryCounters.has(key)) return false;
        _memoryCounters.set(key, { n: 1, resetAt: Date.now() + TOTP_WINDOW_SECONDS * 1000 });
        return true;
    }

    // -------------------------------------------------------------------- SMS
    /**
     * Issue an APP_UNLOCK challenge to the ALREADY VERIFIED phone on the
     * authenticated account. No destination is accepted from the request.
     */
    async sendSmsChallenge(user) {
        if (user.phoneVerified !== true || !user.phoneNumber) {
            return { ok: false, code: 'PHONE_UNVERIFIED', status: 409 };
        }
        if (!this.smsService) {
            return { ok: false, code: 'SMS_SERVICE_UNAVAILABLE', status: 503 };
        }

        const issued = await this.smsService.issueUnlockChallenge({
            userId: user.id,
            phoneNumber: user.phoneNumber,
            purpose: PURPOSES.APP_UNLOCK,
        });

        return {
            ok: true,
            code: 'CHALLENGE_SENT',
            status: 200,
            data: {
                challengeId: issued.challengeId,
                maskedPhone: issued.maskedPhone,
                expiresAt: issued.expiresAt,
                mocked: issued.mocked === true,
            },
        };
    }

    async verifySmsChallenge(user, { challengeId, code }) {
        if (typeof challengeId !== 'string' || challengeId.length === 0) {
            return { ok: false, code: 'CHALLENGE_REQUIRED', status: 400 };
        }
        if (typeof code !== 'string' || code.length === 0) {
            return { ok: false, code: 'CODE_REQUIRED', status: 400 };
        }
        if (user.phoneVerified !== true || !user.phoneNumber) {
            return { ok: false, code: 'PHONE_UNVERIFIED', status: 409 };
        }

        const verdict = await this.smsService.consumeUnlockChallenge({
            userId: user.id,
            phoneNumber: user.phoneNumber,
            purpose: PURPOSES.APP_UNLOCK,
            challengeId,
            code,
        });

        const map = {
            OK: { ok: true, code: 'UNLOCK_OK', status: 200 },
            NOTFOUND: { ok: false, code: 'CHALLENGE_INVALID', status: 404 },
            EXPIRED: { ok: false, code: 'CHALLENGE_EXPIRED', status: 410 },
            LOCKED: { ok: false, code: 'CHALLENGE_LOCKED', status: 429 },
            WRONG: { ok: false, code: 'CODE_INVALID', status: 401, attemptsLeft: verdict.attemptsLeft },
        };
        return map[verdict.outcome] || { ok: false, code: 'CHALLENGE_INVALID', status: 404 };
    }
}

// Test seam: the in-process counters are process-global by design (dev/test
// only). Tests clear them between cases; production uses Redis.
AppUnlockService._resetMemoryState = () => { _memoryCounters.clear(); };

module.exports = { AppUnlockService, PURPOSES, PIN_MAX_ATTEMPTS };
