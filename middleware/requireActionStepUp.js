// §WP-H G — action-bound step-up gate.
'use strict';
const { canonicalAction, actionDigest } = require('../src/services/canonicalAction');
const { consumeGrant } = require('../src/services/actionStepUpService');
const GRANT_HEADER = 'x-step-up-grant';

// require2FA() proves a user can produce one TOTP, unbound to anything. Replay it
// at a different amount, recipient or route and it still passes. This gate binds
// the proof to ONE canonical action and refuses everything else.
//
// The middleware never consumes: consumption must be atomic with the economic
// write, so the handler spends it inside its own transaction.

const CHALLENGE_STATUS = 401;

function actionForRequest(req, spec) {
    const body = req.body || {};
    const params = spec.params ? spec.params(req) : {};
    return canonicalAction({
        userId: String(req.user && req.user.id),
        actionType: spec.actionType,
        routeScope: spec.routeScope || `${req.method} ${req.baseUrl || ''}${req.path}`,
        method: req.method,
        path: req.originalUrl ? req.originalUrl.split('?')[0] : req.path,
        currency: spec.currency ? spec.currency(req) : body.currency,
        amount: spec.amount ? spec.amount(req) : body.amount,
        destination: spec.destination ? spec.destination(req) : (body.destination || body.recipient || body.phone),
        resource: spec.resource ? spec.resource(req) : (body.resourceId || body.withdrawalId || null),
        idempotencyKey: req.get('idempotency-key') || req.get('x-idempotency-key') || body.idempotencyKey || null,
        params,
    });
}

function requireActionStepUp(spec) {
    if (!spec || !spec.actionType) throw new Error('requireActionStepUp needs an actionType');
    return (req, res, next) => {
        try {
            const action = actionForRequest(req, spec);
            const digest = actionDigest(action);
            const token = req.get(GRANT_HEADER) || (req.body && req.body.stepUpGrant) || null;
            req.stepUp = { action, digest, token, actionType: spec.actionType };
            if (!token) {
                // The digest tells the client exactly what to earn a grant for.
                // It is the server's digest, never a client-supplied one.
                // `action` is the server's own canonical descriptor. The client
                // echoes it back verbatim to earn the grant, so it never has to
                // reconstruct routeScope/path/params by guessing: a guess produces a
                // different digest and the grant would authorise nothing. Echoing it
                // is not a weakening - the grant is still bound to exactly these
                // values, so a client that alters any of them fails on consume.
                return res.status(CHALLENGE_STATUS).json({
                    success: false,
                    code: 'STEP_UP_REQUIRED',
                    message: 'This action needs a fresh verification bound to it.',
                    actionType: spec.actionType,
                    actionDigest: digest,
                    action,
                });
            }
            return next();
        } catch (err) {
            // A gate that cannot compute what it is authorising must not proceed.
            return res.status(503).json({
                success: false,
                code: 'STEP_UP_UNAVAILABLE',
                message: 'Step-up verification is unavailable. Nothing was executed.',
            });
        }
    };
}

async function consumeStepUp(tx, req) {
    const stepUp = req && req.stepUp;
    if (!stepUp || !stepUp.token) return { ok: false, reason: 'MISSING_GRANT' };
    return consumeGrant(tx, {
        token: stepUp.token,
        userId: String(req.user.id),
        actionType: stepUp.actionType,
        actionDigest: stepUp.digest,
    });
}

// Enforcement is a deliberate, single-source switch. Default OFF keeps today's
// behaviour exactly: require2FA() governs the route and nothing changes for
// clients that have not shipped the challenge flow yet. Turning it ON swaps the
// proof mechanism for that route rather than stacking two of them.
function isStepUpEnforced() {
    return String(process.env.STEP_UP_ENFORCEMENT || '').toLowerCase() === 'on';
}

function whenStepUpEnforced(middleware) {
    return (req, res, next) => (isStepUpEnforced() ? middleware(req, res, next) : next());
}

module.exports = { requireActionStepUp, consumeStepUp, actionForRequest, isStepUpEnforced, whenStepUpEnforced, GRANT_HEADER };
