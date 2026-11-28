// controllers/stepUpController.js
// =============================================================================
// §WP-H G — the granting half of action-bound step-up.
//
// require2FA() proves "this user can produce a TOTP" once and then lets any
// financial mutation follow. This endpoint converts a proof into a capability
// bound to ONE canonical action, so the proof cannot be replayed against a
// different amount, recipient, currency, resource or idempotency identity.
//
// The digest is computed HERE, server-side, from the action descriptor the client
// wants authorised. A client-supplied hash is never accepted: at execution the
// live request is re-canonicalised and compared, so a grant earned for one action
// cannot authorise another.
//
// Credentials are verified, then dropped. Nothing here logs, stores or echoes a
// TOTP or a password.
// =============================================================================
'use strict';

const bcrypt = require('bcryptjs');
const logger = require('../src/config/logger');
const { canonicalAction, actionDigest } = require('../src/services/canonicalAction');
const { issueGrant, STEP_UP_TTL_SECONDS } = require('../src/services/actionStepUpService');
const {
    verifyAndClaimTotp,
    sendTotpFailure,
    sendTotpUnavailable,
    TOTP_CODES,
} = require('../src/services/totpStepClaimService');

const ACTION_DESCRIPTOR_FIELDS = ['actionType', 'routeScope', 'method', 'path'];
const ACTION_INPUT_FIELDS = ['currency', 'amount', 'destination', 'resource', 'idempotencyKey', 'params'];

function describe(body) {
    const source = (body && body.action) || body || {};
    const descriptor = {};
    for (const field of ACTION_DESCRIPTOR_FIELDS) descriptor[field] = source[field];
    for (const field of ACTION_INPUT_FIELDS) descriptor[field] = source[field];
    return descriptor;
}

async function issue(req, res) {
    const prisma = req.app.get('prisma');
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required.' });

    const body = req.body || {};
    const totpToken = body.totpToken;
    const password = body.password;

    let action;
    try {
        action = canonicalAction({
            userId,
            ...describe(body),
            method: describe(body).method || req.method,
            path: describe(body).path || '/api/step-up/grant',
        });
    } catch (err) {
        // A descriptor that cannot be canonicalised must not earn a capability.
        return res.status(400).json({
            success: false,
            code: 'STEP_UP_ACTION_INVALID',
            message: 'The action could not be described exactly. Nothing was authorised.',
        });
    }

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { password: true, isTwoFactorEnabled: true, twoFactorSecret: true },
    });
    if (!user) return res.status(401).json({ success: false, message: 'Authentication required.' });

    try {
        if (user.isTwoFactorEnabled) {
            if (!totpToken) {
                return res.status(401).json({
                    success: false, code: '2FA_REQUIRED',
                    message: 'Two-factor authentication token required for this operation.',
                });
            }
            // Globally single-use: a code claimed here is spent everywhere else.
            const verdict = await verifyAndClaimTotp({
                prisma, userId, secret: user.twoFactorSecret, token: totpToken,
            });
            if (!verdict.ok) {
                // A claim-store outage is "not verified", never "verified", and it
                // is not the same thing as a wrong code: it must surface as 503 so
                // the client retries instead of asking the user for a new TOTP.
                if (verdict.code === TOTP_CODES.UNAVAILABLE) return sendTotpUnavailable(res);
                return sendTotpFailure(res, verdict, { invalidStatus: 401, invalidMessage: 'Invalid 2FA token.' });
            }
        } else {
            if (!password) {
                return res.status(401).json({
                    success: false, code: 'PASSWORD_REQUIRED',
                    message: 'Password required to confirm this operation.',
                });
            }
            const match = await bcrypt.compare(password, user.password);
            if (!match) return res.status(401).json({ success: false, message: 'Invalid password.' });
        }

        const grant = await issueGrant(prisma, {
            userId,
            actionType: action.actionType,
            routeScope: action.routeScope,
            action,
            idempotencyKey: action.idempotencyKey,
        });

        // The plaintext token is returned exactly once and never persisted.
        return res.status(201).json({
            success: true,
            stepUpGrant: grant.token,
            actionDigest: grant.actionDigest,
            expiresAt: grant.expiresAt,
            ttlSeconds: STEP_UP_TTL_SECONDS,
        });
    } catch (err) {
        // An unverifiable proof is never a granted capability.
        if (err && err.code === TOTP_CODES.UNAVAILABLE) return sendTotpUnavailable(res);
        logger.error({ err: err && err.message }, '[stepUp] grant issuance failed');
        return res.status(503).json({
            success: false,
            code: 'STEP_UP_UNAVAILABLE',
            message: 'Step-up verification is unavailable. Nothing was authorised.',
        });
    }
}

module.exports = { issue };
