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

// ── claim RELEASE robustness ────────────────────────────────────────────────
//
// A release is a conditional primary-key delete (id + IN_PROGRESS) that must
// finish BEFORE the response leaves. If it fails — deadlock victim,
// serialization conflict, pool timeout, dropped connection — the row stays
// IN_PROGRESS while the client already saw its 400, so the corrected retry
// carrying the SAME key is refused with 409 by a phantom identity. That is
// exactly what made transit-booking-identity T9 flaky in CI.
//
// Only VERIFIED TRANSIENT failures are retried: a constraint/predicate error
// is not a reason to try again, and retrying everything would multiply load
// on a genuinely broken database. The budget is fixed, with a short linear
// backoff, so the client-visible cost stays in the tens of milliseconds.
// Exhausting it does NOT change the fail-closed disposition (the claim keeps
// IN_PROGRESS and replays refuse), but it is never silent.
const CLAIM_RELEASE_MAX_ATTEMPTS = 3;
const CLAIM_RELEASE_RETRY_DELAY_MS = 20;

// Prisma codes describing a RETRIABLE infrastructure condition: refused or
// closed connections, pool/transaction timeouts, transaction conflicts.
const TRANSIENT_PRISMA_CODES = new Set([
    'P1001', 'P1002', 'P1008', 'P1017',
    'P2024', 'P2028', 'P2034',
]);

// The equivalent PostgreSQL SQLSTATEs. P2010 ($queryRaw failures) carries the
// SQLSTATE inside meta.message, hence the parse in _errorCodes below.
const TRANSIENT_SQLSTATES = new Set([
    '40001',                  // serialization_failure
    '40P01',                  // deadlock_detected
    '55P03',                  // lock_not_available
    '57014',                  // query_canceled (statement_timeout)
    '57P01', '57P02', '57P03', // admin shutdown / crash / cannot connect now
    '08000', '08001', '08003', '08006', // connection exceptions
    '53300', '53301',         // too many connections (for role)
]);

// Every place a driver may hide the real code: Prisma puts it on the error,
// pg on cause, and a raw-query failure buries the SQLSTATE in the message.
const _errorCodes = (err) => {
    const codes = [];
    const push = (v) => {
        if (typeof v === 'string' && v.trim()) codes.push(v.trim().toUpperCase());
    };
    push(err?.code);
    push(err?.originalCode);
    push(err?.errno);
    push(err?.meta?.code);
    push(err?.cause?.code);
    push(err?.cause?.originalCode);
    const text = `${err?.meta?.message || ''} ${err?.message || ''}`;
    const m = text.match(/code:\s*[`'"]([0-9A-Za-z]{5})[`'"]/i);
    if (m) push(m[1]);
    return codes;
};

const isTransientDbError = (err) => {
    if (!err) return false;
    return _errorCodes(err).some((c) => TRANSIENT_SQLSTATES.has(c) || TRANSIENT_PRISMA_CODES.has(c));
};

// ── middleware factory ──────────────────────────────────────────────────────

/**
 * Financial idempotency authority. Apply to POST/PUT endpoints where a retry,
 * duplicate, crash or concurrent caller must never move money twice.
 *
 * @param {object}   options
 * @param {string}  [options.failurePolicy] RETAIN (default) | RELEASE — the
 *        disposition of the claim when the handler responds 5xx.
 * @param {string}  [options.identity] explicit CANONICAL economic identity
 *        ("METHOD /canonical/path") that OVERRIDES the route-derived endpoint.
 *        Use when two mount paths serve the SAME economic operation (a
 *        compatibility alias): the alias must share one FinancialOperation
 *        identity with the canonical route, or the same client key sent to
 *        each path would be two independent claims — the alias becomes a
 *        bypass of the authority. The fingerprint still guards the claim, so
 *        a key reuse with materially different bodies fails closed.
 */
function idempotency(options = {}) {
    const failurePolicy = options.failurePolicy === RELEASE ? RELEASE : RETAIN;
    // Release-retry policy. Production runs the bounded defaults above; tests
    // inject a fixed policy so they can prove the bound without sleeping.
    const releasePolicy = options.claimReleaseRetry || {};
    const releaseMaxAttempts = Number.isInteger(releasePolicy.attempts) && releasePolicy.attempts > 0
        ? releasePolicy.attempts
        : CLAIM_RELEASE_MAX_ATTEMPTS;
    const releaseDelayMs = Number.isFinite(releasePolicy.delayMs) && releasePolicy.delayMs >= 0
        ? releasePolicy.delayMs
        : CLAIM_RELEASE_RETRY_DELAY_MS;
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
    const identity = typeof options.identity === 'string' && options.identity.trim()
        ? options.identity.trim()
        : null;

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

        // r42 hardening: an explicit canonical identity (alias routes) wins
        // over the route-derived endpoint, so one economic operation has
        // exactly one durable identity no matter which mount path served it.
        const endpoint = identity || endpointOf(req);
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
        //
        // EXCEPTION (2026-10-11): claim RELEASES are made durable BEFORE the
        // response is sent. An unawaited, post-send release let the key be
        // briefly poisoned after a 400/500 the client had already observed —
        // a corrected retry inside that window was refused with 409
        // IN_PROGRESS (the phantom-identity window; proven flaky in CI by
        // transit-booking-identity T9). Awaiting the release costs one
        // primary-key deleteMany before the send; if the release itself
        // fails, the claim stays IN_PROGRESS and replays still refuse
        // safely — the response is delivered either way.
        // Durable, bounded release. The SAME conditional predicate runs on
        // every attempt — id + IN_PROGRESS — so a concurrent transition to
        // COMMITTED inside the service's economic transaction can never be
        // deleted: that is a no-op (count 0), not a failure.
        const releaseClaim = async () => {
            for (let attempt = 1; attempt <= releaseMaxAttempts; attempt += 1) {
                try {
                    const result = await prisma.financialOperation.deleteMany({
                        where: { id: claim.id, status: OPERATION_IN_PROGRESS },
                    });
                    if (attempt > 1) {
                        logger.info({ operationId: claim.id, attempt },
                            '[idempotency] claim release succeeded after retry');
                    }
                    return { released: (result?.count ?? 0) > 0, attempts: attempt, error: null, exhausted: false };
                } catch (err) {
                    const transient = isTransientDbError(err);
                    const lastAttempt = attempt >= releaseMaxAttempts;
                    if (transient && !lastAttempt) {
                        logger.warn(
                            { operationId: claim.id, attempt, errCode: err?.code ?? null, err: err?.message },
                            '[idempotency] claim release hit a transient database error — retrying'
                        );
                        if (releaseDelayMs > 0) {
                            await new Promise((resolve) => setTimeout(resolve, releaseDelayMs * attempt));
                        }
                        continue;
                    }
                    // Fail closed and LOUD: the claim keeps IN_PROGRESS, so
                    // replays refuse with a deterministic 409 and no second
                    // execution is possible — but the operator must see it.
                    const failure = {
                        code: 'IDEMPOTENCY_CLAIM_RELEASE_FAILED',
                        operationId: claim.id,
                        attempts: attempt,
                        transient,
                        exhausted: transient && lastAttempt,
                        errCode: err?.code ?? null,
                        message: err?.message || 'claim release failed',
                    };
                    logger.error({ ...failure, err: err?.message },
                        '[idempotency] claim release FAILED — key remains IN_PROGRESS; replays refuse safely');
                    res.locals.financialClaimReleaseFailure = failure;
                    return { released: false, attempts: attempt, error: err, exhausted: failure.exhausted };
                }
            }
            return { released: false, attempts: releaseMaxAttempts, error: null, exhausted: false };
        };

        const originalJson = res.json.bind(res);
        res.json = function (body) {
            const statusCode = res.statusCode;

            // Release dispositions — durable BEFORE the response leaves.
            // r42 review P0-1 (4xx): a 4xx NEVER implies "nothing committed";
            // release still requires an EXPLICIT disposition — either the
            // handler set res.locals.financialClaimRelease = true (provably
            // pre-economics), or the route declared releaseOn4xx (valid only
            // on wired routes: the in-tx commit means a post-response
            // IN_PROGRESS claim proves the transaction rolled back).
            if (statusCode >= 400 && statusCode < 500) {
                if (res.locals.financialClaimRelease === true || releaseOn4xx) {
                    releaseClaim().finally(() => originalJson(body));
                    return res;
                }
                // RETAIN (no explicit disposition): the key stays poisoned —
                // same-key retries get a deterministic 409 — and money can
                // never move twice on it.
            } else if (statusCode >= 500) {
                if (failurePolicy === RELEASE) {
                    // The route declared its service state-convergent /
                    // provably rolled back on 5xx: release for retry.
                    releaseClaim().finally(() => originalJson(body));
                    return res;
                }
                // RETAIN: a 5xx may follow a committed mutation. The claim
                // stays IN_PROGRESS and the same key deterministically
                // refuses. The client must use a NEW key.
            }

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
                }
            } catch (e) {
                logger.warn({ err: e.message }, '[idempotency] disposition error');
            }
            return res;
        };

        next();
    };
}

// ── in-transaction claim commit (the "wired" pattern) ───────────────────────
//
// §r42.1 — shared helper for endpoints whose FinancialOperation claim commits
// INSIDE their economic $transaction. The service calls this at the point the
// exact wire response is fully known. The economic mutations and the claim
// COMMITTED transition then commit or roll back TOGETHER:
//
//   • tx commits  → the money moved AND the committed response is durable;
//     a crash before the HTTP response still replays byte-identically.
//   • tx rolls back → no money moved AND the claim stays IN_PROGRESS, so
//     releaseOn4xx (valid ONLY on wired routes) can safely release the key.
//
// The CAS (`status: 'IN_PROGRESS'`) guards against a claim that was already
// completed by another execution path; losing it aborts the whole economic
// transaction — never a committed mutation without its committed response.
async function commitOperation(tx, operation, statusCode, body) {
    if (!operation) return; // route not mounted under the authority — no-op
    const committed = await tx.financialOperation.updateMany({
        where: { id: operation.id, status: OPERATION_IN_PROGRESS },
        data: {
            status: OPERATION_COMMITTED,
            statusCode,
            // Store the exact WIRE text (JSON.stringify of the response
            // object the handler will res.json) — same byte-fidelity rule as
            // the middleware's post-response bookkeeping: TEXT, not JSONB,
            // so the replay re-emits the original response bytes exactly
            // (key order preserved; Prisma Decimal via toJSON → string).
            responseBody: JSON.stringify(body),
        },
    });
    if (committed.count !== 1) {
        const err = new Error('Idempotency operation state conflict.');
        err.code = 'IDEMPOTENCY_STATE_CONFLICT';
        throw err;
    }
}

module.exports = {
    idempotency,
    commitOperation,
    IDEMPOTENCY_FAILURE_POLICY: { RETAIN, RELEASE },
    endpointOf,
    fingerprintOf,
    canonical,
    isTransientDbError,
    CLAIM_RELEASE_MAX_ATTEMPTS,
    CLAIM_RELEASE_RETRY_DELAY_MS,
};
