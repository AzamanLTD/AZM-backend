'use strict';

// =============================================================================
// Release target guard — may THIS process apply production DDL?
//
// The release chain creates money and security tables. Running it in the wrong
// place is not a warning-level event: it writes to whatever database it is
// pointed at. So the guard is an allow-list, not a deny-list, and every
// condition is fail-closed: an ABSENT identity is a refusal, never an assumed
// default. "No branch set" used to mean "effectively main"; it now means
// "identity missing".
//
// TWO LEGITIMATE CONTEXTS
//   1. The approved production deploy: Render, exact service, exact branch, and
//      the exact approved database identity.
//   2. A disposable test database, but only behind an EXPLICIT policy variable
//      naming it as disposable, and only on a local/CI host. This exists so CI
//      and local work can exercise the chain; it can never reach production,
//      because the production identity is refused outside context 1.
//
// Pure module: no I/O, no logging, no environment mutation. The verdict never
// contains a connection URL, host, port, username, password or database name —
// only fixed classifications and codes — so a refusal can never leak a
// credential into a build log.
// =============================================================================

/**
 * The approved production target.
 *
 * Verified read-only against the Render API for service "AZM-backend" on
 * 2026-11-17 (service id and the DATABASE_URL host/database only; no credential
 * was read or printed). Pinned deliberately: an exact identity cannot drift the
 * way a hostname pattern can. Update it only from a fresh read-only
 * verification, together with the runbook.
 */
const APPROVED_PRODUCTION = Object.freeze({
    serviceId: 'srv-da1pvvrncjis73fru9fg',
    serviceName: 'AZM-backend',
    branch: 'main',
    databaseHost: 'ep-crimson-cell-ab81e3bp.eu-west-2.aws.neon.tech',
    databasePort: '5432',
    databaseName: 'neondb',
});

/** The explicit policy variable that permits a disposable test target. */
const TEST_TARGET_POLICY_ENV = 'AZM_RELEASE_TARGET_POLICY';
const TEST_TARGET_POLICY_VALUE = 'disposable-postgres';

/**
 * Hosts that may carry a disposable database. Exactly these: the compose/CI
 * service name is not trusted, and no private range is accepted wholesale —
 * "172.16.0.0/12 is private" is not an identity.
 */
const DISPOSABLE_TEST_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1']);

const RENDER_MARKER = 'RENDER';

/**
 * Query parameters we understand. Anything else is refused rather than ignored:
 * a `search_path`, a pooler directive or an unknown switch can change WHERE the
 * DDL lands without changing the host, so it is part of the target identity.
 */
const ALLOWED_URL_PARAMS = Object.freeze([
    'sslmode', 'sslcert', 'sslrootcert', 'application_name', 'connect_timeout', 'schema',
]);

/**
 * Independent deployment authorization.
 *
 * The Render variables (RENDER, IS_PULL_REQUEST, RENDER_GIT_BRANCH,
 * RENDER_SERVICE_ID, DATABASE_URL) are IDENTITY SIGNALS, not attestation: any
 * local process can export the complete tuple. An HMAC would not help either —
 * the key would sit in the same environment as the token, so the same forger
 * could mint one. What a forger cannot do is produce a signature without the
 * private half of a keypair whose PUBLIC half is pinned in this file.
 *
 *   payload = "release:v1:<approvedServiceId>:<approvedBranch>"
 *   token   = base64( Ed25519-sign(privateKey, payload) )   → AZM_DEPLOY_AUTH_TOKEN
 *
 * The private key is held by the operator (and, to mint the token, by whoever
 * performs the approved deploy); it is NEVER committed, never in CI, and never
 * in this repository. This is not attestation that Render started the process —
 * that is not achievable from inside the process. It proves possession of a
 * secret that only the operator holds, and the runbook keeps independent
 * operator authorization for the deploy action itself.
 */
const DEPLOY_AUTH_TOKEN_ENV = 'AZM_DEPLOY_AUTH_TOKEN';
const DEPLOY_AUTH_CONTEXT = 'release:v1';

/**
 * Pinned verification key. Rotating it is a deliberate, reviewable code change;
 * the matching private key lives with the operator. `DEPLOY_AUTH` is exported so
 * a test can substitute its own keypair; there is no environment override, so a
 * forger cannot supply a different verification key at runtime.
 */
const DEPLOY_AUTH = {
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA3Q9g+IPL7HAoD4AgixIBR7KGmi4MQsZoUjvspWyRkYA=
-----END PUBLIC KEY-----`,
};

function deployAuthorizationPayload({ serviceId, branch } = {}) {
    const id = serviceId || APPROVED_PRODUCTION.serviceId;
    const ref = branch || APPROVED_PRODUCTION.branch;
    return `${DEPLOY_AUTH_CONTEXT}:${id}:${ref}`;
}

/** Operator tooling: sign the payload with the private key to mint a token. */
function computeDeployAuthorizationToken(privateKeyPem, { serviceId, branch } = {}) {
    const crypto = require('crypto');
    return crypto
        .sign(null, Buffer.from(deployAuthorizationPayload({ serviceId, branch })), privateKeyPem)
        .toString('base64');
}

function deployAuthorizationValid(env) {
    const token = env[DEPLOY_AUTH_TOKEN_ENV];
    if (typeof token !== 'string' || !token.trim()) return { ok: false, reason: 'missing' };
    let signature;
    try {
        signature = Buffer.from(token.trim(), 'base64');
    } catch {
        return { ok: false, reason: 'mismatch' };
    }
    if (!signature.length) return { ok: false, reason: 'mismatch' };
    try {
        const crypto = require('crypto');
        const ok = crypto.verify(null, Buffer.from(deployAuthorizationPayload()), DEPLOY_AUTH.publicKeyPem, signature);
        return { ok, reason: 'mismatch' };
    } catch {
        return { ok: false, reason: 'mismatch' };
    }
}

function normaliseUrl(value) {
    if (typeof value !== 'string' || value.trim() === '') return null;
    try {
        return new URL(value.trim());
    } catch {
        return null;
    }
}

/**
 * Extract {host, port, database} without ever exposing credentials, or return
 * the reason the URL cannot be trusted as a target identity.
 */
function inspectTarget(databaseUrl) {
    const url = normaliseUrl(databaseUrl);
    if (!url) return { error: 'RELEASE_REFUSED_NO_DATABASE' };
    if (!/^postgres(ql)?:$/.test(url.protocol)) return { error: 'RELEASE_REFUSED_NO_DATABASE' };
    const host = (url.hostname || '').toLowerCase();
    if (!host) return { error: 'RELEASE_REFUSED_NO_DATABASE' };

    let database;
    try {
        // A malformed percent escape throws here rather than silently decoding
        // to something we would then compare against the approved name.
        database = decodeURIComponent((url.pathname || '').replace(/^\//, '')).trim();
    } catch {
        return { error: 'RELEASE_REFUSED_NO_DATABASE' };
    }
    if (!database) return { error: 'RELEASE_REFUSED_NO_DATABASE' };

    const unexpected = [...new Set(url.searchParams.keys())].filter((k) => !ALLOWED_URL_PARAMS.includes(k));
    if (unexpected.length) return { error: 'RELEASE_REFUSED_UNEXPECTED_URL_PARAMETERS' };
    if (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public') {
        return { error: 'RELEASE_REFUSED_NON_PUBLIC_SCHEMA' };
    }

    return { target: { host, port: url.port || '5432', database } };
}

function identifyTarget(databaseUrl) {
    const inspected = inspectTarget(databaseUrl);
    return inspected.target || null;
}

function matchesApprovedDatabase(target) {
    if (!target) return false;
    return target.host === APPROVED_PRODUCTION.databaseHost
        && target.port === APPROVED_PRODUCTION.databasePort
        && target.database === APPROVED_PRODUCTION.databaseName;
}

function isRenderContext(env) {
    const flag = String(env[RENDER_MARKER] || '').toLowerCase();
    return flag === 'true' || flag === '1';
}

const refuse = (code, reason, extra = {}) => ({
    allowed: false,
    code,
    context: extra.context || null,
    target: extra.target || null,
    reason,
});

const allow = (code, reason, extra = {}) => ({
    allowed: true,
    code,
    context: extra.context || null,
    target: extra.target || null,
    reason,
});

/**
 * Evaluate the release target. Fail-closed: unknown or absent is refused.
 */
function evaluateReleaseTarget(env = process.env) {
    const inspected = inspectTarget(env.DATABASE_URL);
    const target = inspected.target || null;
    const productionDatabase = matchesApprovedDatabase(target);

    if (isRenderContext(env)) {
        const context = 'render';
        const isPr = env.IS_PULL_REQUEST;
        const branch = env.RENDER_GIT_BRANCH;
        const serviceId = env.RENDER_SERVICE_ID;

        // 1. Preview builds are untrusted. Both values must be present and say
        //    "no": an absent IS_PULL_REQUEST is an unknown, not a "false".
        if (isPr === undefined || String(isPr).trim() === '') {
            return refuse('RELEASE_REFUSED_PREVIEW_IDENTITY_MISSING',
                'this is a Render build but IS_PULL_REQUEST is not set, so the build could be a preview — refusing', { context });
        }
        if (String(isPr).toLowerCase() !== 'false') {
            return refuse('RELEASE_REFUSED_PREVIEW',
                'pull-request preview builds are untrusted and must never apply production DDL', { context });
        }

        // 2. Branch identity must be present and be the canonical branch.
        if (branch === undefined || String(branch).trim() === '') {
            return refuse('RELEASE_REFUSED_BRANCH_IDENTITY_MISSING',
                'this is a Render build but RENDER_GIT_BRANCH is not set — an unknown branch is not main', { context });
        }
        if (String(branch).trim() !== APPROVED_PRODUCTION.branch) {
            return refuse('RELEASE_REFUSED_BRANCH',
                `only the canonical branch (${APPROVED_PRODUCTION.branch}) may apply production DDL`, { context });
        }

        // 3. Service identity must be present and be the approved service.
        if (serviceId === undefined || String(serviceId).trim() === '') {
            return refuse('RELEASE_REFUSED_SERVICE_IDENTITY_MISSING',
                'this is a Render build but RENDER_SERVICE_ID is not set, so the service cannot be identified', { context });
        }
        if (String(serviceId).trim() !== APPROVED_PRODUCTION.serviceId) {
            return refuse('RELEASE_REFUSED_WRONG_SERVICE',
                'this Render service is not the approved production service, so it must not apply production DDL', { context });
        }

        // 4. Database identity must be the approved one. A remote PostgreSQL
        //    host is not production merely because it answers on 5432, and a
        //    malformed or parameterised URL is refused rather than read.
        if (!target) {
            const code = inspected.error === 'RELEASE_REFUSED_NO_DATABASE'
                ? 'RELEASE_REFUSED_NO_DATABASE'
                : inspected.error;
            return refuse(code,
                'the DATABASE_URL is not a usable, unparameterised PostgreSQL target identity for this build', { context });
        }
        if (!productionDatabase) {
            return refuse('RELEASE_REFUSED_WRONG_DATABASE',
                'the configured database is not the approved production database (host, port and database name must all match)', { context });
        }

        // 5. Independent authorization. The identity tuple above is forgeable
        //    by any local process; the token is not, because it needs a secret
        //    that only the approved service environment holds.
        const auth = deployAuthorizationValid(env);
        if (!auth.ok) {
            return refuse(auth.reason === 'missing' ? 'RELEASE_REFUSED_NO_DEPLOY_AUTHORIZATION' : 'RELEASE_REFUSED_INVALID_DEPLOY_AUTHORIZATION',
                `production DDL requires a valid ${DEPLOY_AUTH_TOKEN_ENV} signature from the release key; the identity tuple alone is not authorization`,
                { context, target: 'approved-production' });
        }

        return allow('RELEASE_TARGET_PRODUCTION',
            'approved production deploy: approved Render service, canonical branch, approved database identity, deploy authorization token verified',
            { context, target: 'approved-production' });
    }

    // ── outside Render ───────────────────────────────────────────────────────
    const context = 'outside-render';

    // A developer shell or CI runner holding the production URL is the exact
    // scenario that must never run production DDL.
    if (productionDatabase) {
        return refuse('RELEASE_REFUSED_PRODUCTION_DATABASE_OUTSIDE_RENDER',
            'this process is not the approved Render deploy but points at the production database — refusing',
            { context, target: 'approved-production' });
    }
    if (!target) {
        return refuse(inspected.error || 'RELEASE_REFUSED_NO_DATABASE',
            'the DATABASE_URL is not a usable PostgreSQL target identity', { context, target: 'unidentified' });
    }
    if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
        return refuse('RELEASE_REFUSED_PRODUCTION_NODE_ENV',
            'NODE_ENV=production outside the approved Render deploy — refusing rather than guessing the target', { context });
    }
    if (String(env[TEST_TARGET_POLICY_ENV] || '').trim() !== TEST_TARGET_POLICY_VALUE) {
        return refuse('RELEASE_REFUSED_TARGET_POLICY_MISSING',
            `outside the approved deploy, remote and unidentified targets are refused by default; a disposable test target needs ${TEST_TARGET_POLICY_ENV}=${TEST_TARGET_POLICY_VALUE}`,
            { context, target: 'unlisted' });
    }
    if (!DISPOSABLE_TEST_HOSTS.includes(target.host)) {
        return refuse('RELEASE_REFUSED_NON_DISPOSABLE_TARGET',
            'the disposable-test policy is only accepted for a local/CI host; remote and private-network hosts are not disposable',
            { context, target: 'remote' });
    }

    return allow('RELEASE_TARGET_DISPOSABLE_TEST',
        'explicitly declared disposable test target on a local/CI host',
        { context, target: 'disposable-test' });
}

module.exports = {
    evaluateReleaseTarget,
    identifyTarget,
    inspectTarget,
    computeDeployAuthorizationToken,
    deployAuthorizationPayload,
    ALLOWED_URL_PARAMS,
    DEPLOY_AUTH_TOKEN_ENV,
    DEPLOY_AUTH,
    matchesApprovedDatabase,
    isRenderContext,
    APPROVED_PRODUCTION,
    DISPOSABLE_TEST_HOSTS,
    TEST_TARGET_POLICY_ENV,
    TEST_TARGET_POLICY_VALUE,
};
