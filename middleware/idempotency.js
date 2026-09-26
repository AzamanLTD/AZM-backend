// middleware/idempotency.js
// =============================================================================
// §r42 — SHARED FINANCIAL IDEMPOTENCY AUTHORITY
//
// This is NOT a response cache. The Idempotency-Key header authorizes exactly
// ONE logical economic operation per (user, endpoint, key), enforced by a
// race-proof PostgreSQL claim row in FinancialOperation — created BEFORE the
// handler executes, via the @@unique([userId, endpoint, key]) constraint.
//
// The r41-era middleware this replaces had the P0 race:
//     DB lookup → handler executes economics → response-cache INSERT
// Two concurrent identical requests both passed the lookup and both executed
// the economic operation before any row existed. It was also globally keyed
// (cross-user/cross-endpoint replay), fail-open on DB errors, and the cache
// expired after 24 hours — after which a settled financial request became
// executable again.
//
// CONTRACT (r42):
//   same user + same logical endpoint + same key  → exactly ONE logical operation
//   concurrent duplicates                         → only the claim owner executes;
//                                                   duplicates get a deterministic
//                                                   409 (never a second mutation)
//   replay after completion                       → the committed original response
//   same key + materially different payload       → deterministic 409 conflict,
//                                                   never a replay of the wrong tx
//   different users / different endpoints         → fully independent
//   crash after economic commit, before response  → the durable claim converges:
//                                                   COMMITTED rows replay the stored
//                                                   result; IN_PROGRESS rows refuse
//                                                   re-execution (409 + operationId)
//   4xx validation failure                         → claim released; the key is
//                                                   NOT poisoned (nothing committed)
//   5xx                                           → per-route failurePolicy:
//     RELEASE — the service is state-convergent or its economic transaction
//               provably rolled back; the claim is released and the client may
//               retry the same key.
//     RETAIN  — a 5xx may have been raised AFTER the economic commit; the claim
//               stays IN_PROGRESS and the same key deterministically refuses
//               (409). The client must use a NEW key. No double money, ever.
//   DB/claim failure                              → FAIL CLOSED (503). A financial
//                                                   endpoint never silently
//                                                   executes unprotected.
//
// SEPARATION OF IDENTITY FROM CACHING:
//   The FinancialOperation row IS the durable economic identity. The stored
//   responseBody is only the derived HTTP replay convenience on top of it.
//   Rows are permanent — pruning a response-cache TTL can never re-arm a
//   settled economic request. Endpoints whose services can share the
//   transaction boundary (e.g. multi-currency convert) mark the row COMMITTED
//   INSIDE their economic $transaction via res.locals.financialOperation —
//   closing the crash-after-commit window completely.
// =============================================================================

const crypto = require('crypto');
const logger = require('../src/config/logger');

const OPERATION_IN_PROGRESS = 'IN_PROGRESS';
const OPERATION_COMMITTED = 'COMMITTED';

const RETAIN = 'RETAIN';   // default: a 5xx may follow a committed mutation
const RELEASE = 'RELEASE'; // the service is provably convergent / rolled back

// ── request identity ────────────────────────────────────────────────────────

// Logical endpoint = method + router mount + route PATTERN (not the raw URL:
// query strings are cosmetic and must not fork the identity of an operation).
const endpointOf = (req) =>
    `${req.method} ${req.baseUrl || ''}${req.route?.path || req.path}`;

// Canonical stable stringify: recursively sorted keys. Money values are
// compared by their EXACT string form — "50.00" (string) and 50 (number →
// "50") are deliberately DISTINCT fingerprints (fail-closed on any material
// difference); identical payloads always produce identical fingerprints.
// No float arithmetic is performed anywhere in this identity path.
const canonical = (value) => {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
    if (typeof value === 'number') return JSON.stringify(value); // shortest roundtrip repr, deterministic
    return JSON.stringify(value);
};

const fingerprintOf = (req) => crypto
    .createHash('sha256')
    .update(canonical({ params: req.params, body: req.body }))
    .digest('hex');

const isUniqueViolation = (err) =>
    err?.code === 'P2002' || /unique constraint/i.test(err?.message || '');

// ── middleware factory ──────────────────────────────────────────────────────

/**
 * Financial idempotency authority. Apply to POST/PUT endpoints where a retry,
 * duplicate, crash or concurrent caller must never move money twice.
 *
 * @param {object}   options
 * @param {string}  [options.failurePolicy] RETAIN (default) | RELEASE — the
 *        disposition of the claim when the handler responds 5xx.
 */
function idempotency(options = {}) {
    const failurePolicy = options.failurePolicy === RELEASE ? RELEASE : RETAIN;
    // r42 review P0-2: a financial mutation mounted under this authority
    // REQUIRES a client Idempotency-Key. Without one, every network retry is a
    // brand-new operation and can move money twice. Opt out ONLY where an
    // independent durable exactly-once identity already protects the route
    // (required: false, with the evidence named at the mount site).
    const required = options.required !== false;
    // r42 review P0-1: the authority NEVER infers economic rollback from an
    // HTTP status alone. releaseOn4xx is a route-level declaration valid ONLY
    // for endpoints whose claim is committed INSIDE their economic transaction
    // (the wired pattern): there, a post-response IN_PROGRESS claim is itself
    // durable proof the transaction rolled back, so the key is reusable.
    // Every other route RETAINS on 4xx unless the handler explicitly marked a
    // provably pre-economics failure (res.locals.financialClaimRelease = true).
    const releaseOn4xx = options.releaseOn4xx === true;

    return async (req, res, next) => {
        const key = req.headers['idempotency-key'];

        if (!key) {
            if (required) {
                // Deterministic client refusal BEFORE any economics execute:
                // the request was NOT executed and no claim was created.
                return res.status(400).json({
                    success: false,
                    code: 'IDEMPOTENCY_KEY_REQUIRED',
                    message: 'This endpoint requires an Idempotency-Key header. Retries without a key can execute twice.',
                });
            }
            return next();
        }

        const prisma = req.app.get('prisma');
        const userId = req.user?.id;

        // Fail CLOSED. A misconfigured route (no auth before this middleware)
        // or a missing model must never let a financial endpoint run with its
        // duplicate protection silently absent.
        if (!userId) {
            return res.status(401).json({
                success: false,
                code: 'IDEMPOTENCY_CONTEXT_MISSING',
                message: 'Idempotency authority requires an authenticated caller.',
            });
        }
        if (!prisma?.financialOperation) {
            return res.status(503).json({
                success: false,
                code: 'IDEMPOTENCY_UNAVAILABLE',
                message: 'Idempotency authority is unavailable. The request was NOT executed.',
            });
        }

        const endpoint = endpointOf(req);
        const fingerprint = fingerprintOf(req);

        let claim;
        try {
            // THE authoritative claim: a unique INSERT. Under concurrency,
            // PostgreSQL's constraint is the single arbiter — exactly one of
            // the racing requests can insert; there is no check-then-act gap.
            claim = await prisma.financialOperation.create({
                data: {
                    userId,
                    endpoint,
                    key,
                    status: OPERATION_IN_PROGRESS,
                    fingerprint,
                    failurePolicy,
                },
            });
        } catch (err) {
            if (isUniqueViolation(err)) {
                // Someone owns this (userId, endpoint, key) already.
                let existing;
                try {
                    existing = await prisma.financialOperation.findUnique({
                        where: { userId_endpoint_key: { userId, endpoint, key } },
                    });
                } catch (readErr) {
                    return res.status(503).json({
                        success: false,
                        code: 'IDEMPOTENCY_UNAVAILABLE',
                        message: 'Idempotency authority is unavailable. The request was NOT executed.',
                    });
                }
                if (!existing) {
                    // The conflicting row vanished (released claim raced our
                    // insert). Deterministically refuse — never fall through.
                    return res.status(503).json({
                        success: false,
                        code: 'IDEMPOTENCY_UNAVAILABLE',
                        message: 'Idempotency claim raced a release. Retry the request.',
                    });
                }
                if (existing.status === OPERATION_COMMITTED) {
                    if (existing.fingerprint !== fingerprint) {
                        // Same key, materially different request → deterministic
                        // conflict. NEVER replay a response for a different tx.
                        return res.status(409).json({
                            success: false,
                            code: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
                            message: 'This idempotency key was already used with a different payload.',
                        });
                    }
                    // Committed replay: the derived response convenience.
                    return res.status(existing.statusCode)
                        // responseBody is stored as the serialized WIRE
                        // text; parse + re-stringify inside res.json
                        // reproduces the original response bytes exactly
                        // (key order included — the reason the column is
                        // TEXT, not key-reordering JSONB).
                        .json(existing.responseBody == null
                            ? existing.responseBody
                            : JSON.parse(existing.responseBody));
                }
                // IN_PROGRESS: another caller owns the operation right now, or
                // the owner crashed after claiming (possibly after committing —
                // the claim is the durable fact that prevents a second mutation).
                // Either way this duplicate does NOT execute.
                return res.status(409).json({
                    success: false,
                    code: 'IDEMPOTENCY_IN_PROGRESS',
                    operationId: existing.id,
                    message: 'An operation with this key is already in flight or awaiting resolution. It was NOT executed again. Retry with the same key to obtain the committed result, or use a new key for a new operation.',
                });
            }
            // DB unavailable → fail closed. Financial operations never fall
            // through into unprotected execution.
            logger.error({ err: err.message }, '[idempotency] claim failed — refusing to execute');
            return res.status(503).json({
                success: false,
                code: 'IDEMPOTENCY_UNAVAILABLE',
                message: 'Idempotency authority is unavailable. The request was NOT executed.',
            });
        }

        // Hand the durable claim to wired services: they update this exact row
        // to COMMITTED inside their economic $transaction, closing the
        // crash-after-commit window (retry replays the committed result).
        res.locals.financialOperation = claim;

        // Post-response disposition. Bookkeeping happens AFTER the response is
        // delivered — a bookkeeping crash only degrades replays to the safe
        // 409 IN_PROGRESS refusal, never to a wrong replay or re-execution.
        const originalJson = res.json.bind(res);
        res.json = function (body) {
            const statusCode = res.statusCode;
            originalJson(body);

            try {
                if (statusCode >= 200 && statusCode < 300) {
                    // Guarded: a wired service may have already committed the
                    // row inside its transaction — never overwrite that.
                    prisma.financialOperation.updateMany({
                        where: { id: claim.id, status: OPERATION_IN_PROGRESS },
                        data: {
                            status: OPERATION_COMMITTED,
                            statusCode,
                            // Store the WIRE text, not the raw object:
                            // res.json(body) serializes Prisma Decimal via
                            // toJSON → "50" (string), while a raw-object
                            // store would lose that string form. The claim
                            // column is TEXT, so the replay re-emits the
                            // exact original response bytes — key order
                            // included (a JSONB column would reorder keys
                            // and break byte-identical replay).
                            responseBody: JSON.stringify(body),
                        },
                    }).catch((e) => logger.warn(
                        { err: e.message, operationId: claim.id },
                        '[idempotency] commit bookkeeping failed — replays refuse safely (IN_PROGRESS)'
                    ));
                } else if (statusCode >= 400 && statusCode < 500) {
                    // r42 review P0-1: a 4xx NEVER implies "nothing committed".
                    // Post-commit controller work can fail and be converted to
                    // a 4xx by an outer catch (withdrawalController is the
                    // concrete in-repo example) — releasing on that signal
                    // would re-arm a committed financial operation for
                    // duplicate execution. Release requires an EXPLICIT,
                    // durable disposition instead:
                    //   1. res.locals.financialClaimRelease === true — the
                    //      handler itself marked the failure as provably
                    //      pre-economics (e.g. schema validation, pre-tx
                    //      guards), or
                    //   2. policy releaseOn4xx — the route declared its claim
                    //      commits inside the economic transaction (wired),
                    //      so IN_PROGRESS after the response proves rollback.
                    // Otherwise the claim is RETAINED: the key stays poisoned
                    // (same-key retries get a deterministic 409) and money can
                    // never move twice on it.
                    if (res.locals.financialClaimRelease === true || releaseOn4xx) {
                        prisma.financialOperation.deleteMany({
                            where: { id: claim.id, status: OPERATION_IN_PROGRESS },
                        }).catch((e) => logger.warn(
                            { err: e.message, operationId: claim.id },
                            '[idempotency] claim release failed — replays refuse safely (IN_PROGRESS)'
                        ));
                    }
                    // No explicit disposition → RETAIN. Safe by construction:
                    // the worst case is a poisoned key, never duplicate money.
                } else if (statusCode >= 500) {
                    if (failurePolicy === RELEASE) {
                        // The route declared its service state-convergent /
                        // provably rolled back on 5xx: release for retry.
                        prisma.financialOperation.deleteMany({
                            where: { id: claim.id, status: OPERATION_IN_PROGRESS },
                        }).catch((e) => logger.warn(
                            { err: e.message, operationId: claim.id },
                            '[idempotency] claim release failed — replays refuse safely (IN_PROGRESS)'
                        ));
                    }
                    // RETAIN: a 5xx may follow a committed mutation. The claim
                    // stays IN_PROGRESS and the same key deterministically
                    // refuses. The client must use a NEW key.
                }
            } catch (e) {
                logger.warn({ err: e.message }, '[idempotency] disposition error');
            }
            return res;
        };

        next();
    };
}

module.exports = {
    idempotency,
    IDEMPOTENCY_FAILURE_POLICY: { RETAIN, RELEASE },
    endpointOf,
    fingerprintOf,
    canonical,
};
