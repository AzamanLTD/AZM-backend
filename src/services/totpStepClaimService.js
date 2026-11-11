// src/services/totpStepClaimService.js
// =============================================================================
// §WP-F — ONE SHARED TOTP VERIFICATION AND CLAIM AUTHORITY.
//
// THE RULE: one user, one ACCEPTED matched TOTP time-step, one successful use,
// across every backend path that verifies a customer's authenticator code.
//
// WHY THIS EXISTS
// Before WP-F each verification site called speakeasy's boolean `totp.verify()`
// independently: require2FA, saved-MoMo, 2FA enable, 2FA disable, payout-address
// and two admin actions. A code is valid for a whole 30s step (plus one step of
// skew either side), so the same code could be replayed against a DIFFERENT
// route — accept once to disable 2FA, again to move a payout address — because
// nothing recorded that the step had been spent. WP-D gave app-unlock a durable
// claim; this module makes that the ONLY way any path can accept a TOTP.
//
// THE PHYSICAL TABLE IS REUSED, NOT REPLACED.
// The Prisma model is now the neutral `TotpStepClaim`, mapped with
// @@map("AppUnlockTotpClaim") onto the table WP-D already shipped, so previous
// claim rows are preserved and no data migration is involved. The unique index
// on (userId, step) is the whole enforcement: INSERT is the claim, and P2002 is
// the loss. It is deliberately NOT partitioned by route, controller, endpoint,
// scope or action — a step spent anywhere is spent everywhere.
//
// MATCHED STEP, NOT CLOCK STEP
// Speakeasy 2.0.0 `totp.verifyDelta({window})` is two-sided: it searches
// current-window .. current+window and returns `{delta}` relative to the current
// counter. The claim therefore stores `currentStep + delta` — the step whose
// code ACTUALLY matched. Claiming the current clock step instead would let a
// next-step code be presented twice by moving the clock into the following
// window.
//
// WHAT IS NEVER STORED
// The code, its digest and the authenticator secret. A row is (userId, step,
// createdAt) and nothing else; logs carry a userId and a refusal reason only.
// =============================================================================
'use strict';

const speakeasy = require('speakeasy');
const logger = require('../config/logger');

/** RFC 6238 default step, matching speakeasy's own default. */
const TOTP_STEP_SECONDS = 30;
/** The existing acceptance policy at every pre-WP-F call site. Preserved. */
const DEFAULT_WINDOW = 1;
/** Claims older than this can never be matched by an in-window code again. */
const CLAIM_RETENTION_MS = 60 * 60 * 1000;

const TOTP_CODES = Object.freeze({
    INVALID: 'TOTP_INVALID',
    REPLAYED: 'TOTP_REPLAYED',
    UNAVAILABLE: 'TOTP_CLAIM_STORE_UNAVAILABLE',
});

/**
 * The claim store could not be consulted. A caller MUST treat this as "not
 * verified" and answer service-unavailable: a database problem must never look
 * like a successful verification, and never like a wrong code either.
 */
class TotpClaimStoreUnavailableError extends Error {
    constructor(cause) {
        super('Two-factor verification is temporarily unavailable.');
        this.name = 'TotpClaimStoreUnavailableError';
        this.code = TOTP_CODES.UNAVAILABLE;
        this.statusCode = 503;
        this.cause = cause || null;
    }
}

/** The counter value for `now` — the same arithmetic speakeasy uses. */
function currentStep(now = new Date()) {
    return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** The step whose code matched, given a speakeasy delta. */
function matchedStep(now, delta) {
    return currentStep(now) + (Number.isInteger(delta) ? delta : 0);
}

/**
 * Verify a TOTP and atomically claim its matched step.
 *
 * @param {object}  args
 * @param {object}  args.prisma  request-scoped (or transaction) Prisma client
 * @param {number}  args.userId  the authenticated user whose secret is used
 * @param {string}  args.secret  base32 authenticator secret
 * @param {string}  args.token   the submitted code
 * @param {number} [args.window] accepted skew in steps (default 1)
 * @param {Date}   [args.now]    injectable clock for boundary tests
 * @returns {Promise<{ok:true, step:number}|{ok:false, code:string, step?:number}>}
 * @throws  {TotpClaimStoreUnavailableError} when the claim cannot be recorded
 */
async function verifyAndClaimTotp({ prisma, userId, secret, token, window = DEFAULT_WINDOW, now = new Date() }) {
    if (!prisma || typeof prisma.totpStepClaim?.create !== 'function') {
        throw new TotpClaimStoreUnavailableError(new Error('claim model unavailable on this client'));
    }
    if (!Number.isInteger(userId) || userId <= 0) {
        return { ok: false, code: TOTP_CODES.INVALID };
    }
    if (typeof secret !== 'string' || secret.length === 0) {
        return { ok: false, code: TOTP_CODES.INVALID };
    }
    if (typeof token !== 'string' || token.trim().length === 0) {
        return { ok: false, code: TOTP_CODES.INVALID };
    }

    // verifyDelta, never verify: the boolean API cannot tell us WHICH step
    // matched, and claiming the wrong step re-opens adjacent-window replay.
    let matched;
    try {
        matched = speakeasy.totp.verifyDelta({
            secret,
            encoding: 'base32',
            token: token.trim(),
            window,
        });
    } catch (err) {
        // A malformed secret is a refusal, not an infrastructure failure.
        logger.warn({ userId }, '[totp] code could not be evaluated');
        return { ok: false, code: TOTP_CODES.INVALID };
    }
    if (!matched || !Number.isInteger(matched.delta)) {
        return { ok: false, code: TOTP_CODES.INVALID };
    }

    const step = matchedStep(now, matched.delta);

    try {
        // Bounded cleanup only touches claims that can no longer be matched by
        // any in-window code; live claims are never removed.
        await prisma.totpStepClaim.deleteMany({
            where: { userId, createdAt: { lt: new Date(now.getTime() - CLAIM_RETENTION_MS) } },
        });
        await prisma.totpStepClaim.create({ data: { userId, step } });
        return { ok: true, step };
    } catch (err) {
        if (err && err.code === 'P2002') {
            logger.warn({ userId }, '[totp] replay refused: matched step already claimed');
            return { ok: false, code: TOTP_CODES.REPLAYED, step };
        }
        logger.error({ userId, err: err && err.message }, '[totp] claim store unavailable');
        throw new TotpClaimStoreUnavailableError(err);
    }
}

/**
 * Uniform refusal responses. The INVALID body is byte-identical to what each
 * site returned before WP-F (callers pass their own status/message), so no
 * existing client contract moves; only the two NEW outcomes carry a code.
 */
function sendTotpFailure(res, verdict, { invalidStatus = 401, invalidMessage = 'Invalid 2FA token.' } = {}) {
    if (verdict && verdict.code === TOTP_CODES.REPLAYED) {
        return res.status(409).json({
            success: false,
            code: TOTP_CODES.REPLAYED,
            message: 'This authenticator code has already been used. Wait for the next code and try again.',
        });
    }
    return res.status(invalidStatus).json({ success: false, message: invalidMessage });
}

/** Service-unavailable response for a claim-store failure. */
function sendTotpUnavailable(res) {
    return res.status(503).json({
        success: false,
        code: TOTP_CODES.UNAVAILABLE,
        message: 'Two-factor verification is temporarily unavailable. Please try again shortly.',
    });
}

module.exports = {
    verifyAndClaimTotp,
    sendTotpFailure,
    sendTotpUnavailable,
    currentStep,
    matchedStep,
    TotpClaimStoreUnavailableError,
    TOTP_CODES,
    TOTP_STEP_SECONDS,
    DEFAULT_WINDOW,
    CLAIM_RETENTION_MS,
};
