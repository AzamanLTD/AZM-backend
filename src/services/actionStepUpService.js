// src/services/actionStepUpService.js
// =============================================================================
// §WP-H G — action-bound, single-use, short-lived step-up capability.
//
// The old flow (middleware/require2FA.js) proved "the user can produce a TOTP"
// once, before the idempotency middleware, and then let ANY financial mutation
// follow. A proof that is not bound to the action it authorises is a bearer
// credential for the whole account for as long as the request lives.
//
// Here the proof is bound to the exact economic action:
//   - user, canonical action digest (route, method, currency, exact amount,
//     destination/resource, material parameters), route scope, idempotency key;
//   - a 60 second TTL, one documented constant;
//   - consumed exactly once, by a conditional UPDATE, INSIDE the caller's
//     transaction, so a rolled-back economic write leaves the grant unspent.
//
// The plaintext token is returned to the client once and never stored: the row
// keeps only its SHA-256 hash.
// =============================================================================
'use strict';

const crypto = require('crypto');

/** The one TTL. Short enough that a stolen grant is useless, long enough for a
 *  mobile client to complete the retry it was issued for. */
const STEP_UP_TTL_SECONDS = 60;

const REASON = Object.freeze({
    MISSING: 'STEP_UP_GRANT_MISSING',
    INVALID: 'STEP_UP_GRANT_INVALID',
    EXPIRED: 'STEP_UP_GRANT_EXPIRED',
    ALREADY_USED: 'STEP_UP_GRANT_ALREADY_USED',
    WRONG_USER: 'STEP_UP_GRANT_WRONG_USER',
    ACTION_MISMATCH: 'STEP_UP_GRANT_ACTION_MISMATCH',
    UNAVAILABLE: 'STEP_UP_GRANT_STORE_UNAVAILABLE',
});

/** Money and identity fields are compared as exact strings. Anything the
 *  normaliser does not recognise is included by name so a new material field
 *  cannot silently escape the binding. */
function canonicalAction(input = {}) {
    const pick = (v) => (v === undefined || v === null ? null : String(v));
    return {
        method: pick(input.method).toUpperCase(),
        route: pick(input.route),
        operation: pick(input.operation),
        currency: pick(input.currency),
        amount: pick(input.amount),
        destination: pick(input.destination),
        resource: pick(input.resource),
        idempotencyKey: pick(input.idempotencyKey),
        parameters: input.parameters && typeof input.parameters === 'object'
            ? Object.keys(input.parameters).sort().reduce((acc, k) => {
                acc[k] = pick(input.parameters[k]);
                return acc;
            }, {})
            : {},
    };
}

/** Stable digest of the canonical form. Key order is fixed by construction. */
function actionDigest(input) {
    const canonical = canonicalAction(input);
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * Issue a grant for one action. The caller has already verified the proof
 * (TOTP or password) and globally claimed the TOTP step.
 */
async function issueGrant(prisma, {
    userId, actionType, routeScope, action, idempotencyKey = null, ttlSeconds = STEP_UP_TTL_SECONDS,
}) {
    if (!userId) throw new Error('issueGrant: userId is required');
    if (!actionType) throw new Error('issueGrant: actionType is required');
    if (!routeScope) throw new Error('issueGrant: routeScope is required');

    const token = crypto.randomBytes(32).toString('hex');
    const digest = actionDigest(action);
    const expiresAt = new Date(Date.now() + (ttlSeconds * 1000));

    await prisma.actionStepUpGrant.create({
        data: {
            id: crypto.randomUUID(),
            tokenHash: hashToken(token),
            userId: String(userId),
            actionType,
            actionDigest: digest,
            routeScope,
            idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
            expiresAt,
        },
    });

    return { token, expiresAt, actionDigest: digest, ttlSeconds };
}

/**
 * Consume a grant. MUST be called inside the same transaction as the economic
 * write: a rollback then releases the grant, because the UPDATE rolls back too.
 *
 * The conditional UPDATE is the single winner. Two concurrent consumers cannot
 * both see consumedAt IS NULL and both commit.
 */
async function consumeGrant(tx, { token, userId, action, actionType }) {
    if (!token) return { ok: false, reason: REASON.MISSING };
    if (!userId) return { ok: false, reason: REASON.WRONG_USER };

    const digest = actionDigest(action);
    let rows;
    try {
        rows = await tx.$queryRawUnsafe(
            `UPDATE "ActionStepUpGrant"
                SET "consumedAt" = NOW()
              WHERE "tokenHash" = $1
                AND "userId" = $2
                AND "actionDigest" = $3
                AND ("consumedAt" IS NULL)
                AND "expiresAt" > NOW()
          RETURNING "id"`,
            hashToken(token), String(userId), digest,
        );
    } catch (err) {
        // A store outage is never authorisation.
        return { ok: false, reason: REASON.UNAVAILABLE, error: err };
    }

    if (Array.isArray(rows) && rows.length === 1) return { ok: true, actionDigest: digest };
    if (Array.isArray(rows) && rows.length > 1) {
        // Should be impossible (tokenHash is UNIQUE); treat as refusal, not success.
        return { ok: false, reason: REASON.INVALID };
    }

    // Nothing was consumed: say why, without leaking the binding to the caller
    // beyond the reason code.
    try {
        const [row] = await tx.$queryRawUnsafe(
            `SELECT "userId", "actionDigest", "consumedAt", "expiresAt", "actionType"
               FROM "ActionStepUpGrant" WHERE "tokenHash" = $1`,
            hashToken(token),
        );
        if (!row) return { ok: false, reason: REASON.INVALID };
        if (String(row.userId) !== String(userId)) return { ok: false, reason: REASON.WRONG_USER };
        if (actionType && row.actionType !== actionType) return { ok: false, reason: REASON.ACTION_MISMATCH };
        if (row.actionDigest !== digest) return { ok: false, reason: REASON.ACTION_MISMATCH };
        if (row.consumedAt) return { ok: false, reason: REASON.ALREADY_USED };
        if (new Date(row.expiresAt).getTime() <= Date.now()) return { ok: false, reason: REASON.EXPIRED };
    } catch (err) {
        return { ok: false, reason: REASON.UNAVAILABLE, error: err };
    }
    return { ok: false, reason: REASON.INVALID };
}

module.exports = {
    STEP_UP_TTL_SECONDS,
    REASON,
    canonicalAction,
    actionDigest,
    hashToken,
    issueGrant,
    consumeGrant,
};
