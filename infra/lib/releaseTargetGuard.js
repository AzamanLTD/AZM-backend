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
 * Independent, per-release deployment authorization.
 *
 * The Render variables (RENDER, IS_PULL_REQUEST, RENDER_GIT_BRANCH,
 * RENDER_SERVICE_ID, RENDER_GIT_COMMIT, DATABASE_URL) are IDENTITY SIGNALS, not
 * attestation: any local process can export the complete tuple. An HMAC cannot
 * fix that either — the key would sit in the same environment as the token, so
 * the same forger could mint one. A forger cannot, however, produce an Ed25519
 * signature without the private half of a keypair whose PUBLIC half is pinned in
 * this file.
 *
 * The signature covers ONE release, not a service in general:
 *
 *   payload = release:v2|<serviceId>|<branch>|<commit>|<dbHost>|<dbPort>|<dbName>|<issuedAt>|<expiresAt>
 *   token   = base64url(payload) + "." + base64url(Ed25519-sign(privateKey, payload))
 *
 * so a token minted for commit X cannot authorize commit Y, cannot be replayed
 * against another service, branch or database, and stops working after a short
 * window. RENDER_GIT_COMMIT is the commit SHA of the deploy being built (Render
 * documents it as available at build time and runtime), which is what makes the
 * binding real at the phase where `npm run release` runs.
 *
 * REPLAY SCOPE — stated, not hidden: this is NOT single-use authorization. There
 * is no nonce store, and a genuine one-use mechanism cannot be added here without
 * either new persistent state in the production database before the guard has
 * decided the target is production, or an external service the release chain
 * cannot depend on. The residual capability is therefore: the SAME signed
 * release authorization can be replayed, but only for the same service, the same
 * branch, the same commit and the same database, and only until it expires
 * (15 minutes by default, 60 at most). It cannot authorize any other release.
 *
 * The private key is held by the operator and is never committed, never in CI
 * and never in the application runtime.
 */
const DEPLOY_AUTH_TOKEN_ENV = 'AZM_DEPLOY_AUTH_TOKEN';
const DEPLOY_AUTH_CONTEXT = 'release:v2';
const DEPLOY_AUTH_MAX_WINDOW_SECONDS = 60 * 60;
const DEPLOY_AUTH_CLOCK_SKEW_SECONDS = 120;
const DEPLOY_COMMIT_ENV = 'RENDER_GIT_COMMIT';

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

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** The canonical bytes that are signed. Every bound fact is in this string. */
function deployAuthorizationPayload({
    serviceId,
    branch,
    commit,
    database,
    issuedAt,
    expiresAt,
} = {}) {
    const db = database || {
        host: APPROVED_PRODUCTION.databaseHost,
        port: APPROVED_PRODUCTION.databasePort,
        name: APPROVED_PRODUCTION.databaseName,
    };
    const fields = [
        DEPLOY_AUTH_CONTEXT,
        serviceId || APPROVED_PRODUCTION.serviceId,
        branch || APPROVED_PRODUCTION.branch,
        commit || '',
        db.host || '',
        db.port || '',
        db.name || '',
        issuedAt || '',
        expiresAt || '',
    ];
    return fields.join('|');
}

/**
 * Operator tooling: mint one release authorization.
 * Defaults are the approved service/branch/database and a 15-minute window.
 */
function computeDeployAuthorizationToken(privateKeyPem, {
    serviceId,
    branch,
    commit,
    database,
    issuedAt,
    expiresAt,
    ttlSeconds = 15 * 60,
} = {}) {
    const crypto = require('crypto');
    const now = new Date();
    const issued = issuedAt || now.toISOString();
    const expires = expiresAt || new Date(new Date(issued).getTime() + ttlSeconds * 1000).toISOString();
    const payload = deployAuthorizationPayload({ serviceId, branch, commit, database, issuedAt: issued, expiresAt: expires });
    const signature = crypto.sign(null, Buffer.from(payload), privateKeyPem);
    return `${b64url(payload)}.${b64url(signature)}`;
}

const AUTH_REFUSALS = Object.freeze({
    MISSING: 'RELEASE_REFUSED_NO_DEPLOY_AUTHORIZATION',
    INVALID: 'RELEASE_REFUSED_INVALID_DEPLOY_AUTHORIZATION',
    SERVICE: 'RELEASE_REFUSED_AUTH_SERVICE',
    BRANCH: 'RELEASE_REFUSED_AUTH_BRANCH',
    COMMIT: 'RELEASE_REFUSED_AUTH_COMMIT',
    DATABASE: 'RELEASE_REFUSED_AUTH_DATABASE',
    EXPIRED: 'RELEASE_REFUSED_AUTH_EXPIRED',
    NOT_YET_VALID: 'RELEASE_REFUSED_AUTH_NOT_YET_VALID',
    WINDOW: 'RELEASE_REFUSED_AUTH_WINDOW_TOO_LONG',
});

/**
 * Verify one release authorization against the environment.
 * Fails closed on every malformed, expired, future-dated or mismatched input.
 *
 * @returns {{ok: boolean, code: string|null, detail: object}}
 */
function deployAuthorizationVerdict(env) {
    const deny = (code, detail = {}) => ({ ok: false, code, detail });
    const token = env[DEPLOY_AUTH_TOKEN_ENV];
    if (typeof token !== 'string' || !token.trim()) return deny(AUTH_REFUSALS.MISSING, { reason: 'absent' });

    const parts = token.trim().split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return deny(AUTH_REFUSALS.INVALID, { reason: 'malformed token' });

    let payload;
    let signature;
    try {
        payload = Buffer.from(parts[0], 'base64url').toString('utf8');
        signature = Buffer.from(parts[1], 'base64url');
    } catch {
        return deny(AUTH_REFUSALS.INVALID, { reason: 'undecodable token' });
    }
    if (!signature.length || !payload) return deny(AUTH_REFUSALS.INVALID, { reason: 'empty token part' });

    const crypto = require('crypto');
    let verified = false;
    try {
        verified = crypto.verify(null, Buffer.from(payload), DEPLOY_AUTH.publicKeyPem, signature);
    } catch {
        verified = false;
    }
    if (!verified) return deny(AUTH_REFUSALS.INVALID, { reason: 'signature does not verify against the pinned release key' });

    const f = payload.split('|');
    if (f.length !== 9 || f[0] !== DEPLOY_AUTH_CONTEXT) return deny(AUTH_REFUSALS.INVALID, { reason: 'payload is not a supported release authorization' });
    const [, serviceId, branch, commit, dbHost, dbPort, dbName, issuedAt, expiresAt] = f;

    const commitEnv = String(env[DEPLOY_COMMIT_ENV] || '').trim();
    if (!commitEnv) return deny(AUTH_REFUSALS.COMMIT, { reason: `${DEPLOY_COMMIT_ENV} is not set, so the authorization cannot be bound to this deploy` });
    if (commit !== commitEnv) return deny(AUTH_REFUSALS.COMMIT, { reason: 'the authorization is for a different commit' });

    if (serviceId !== APPROVED_PRODUCTION.serviceId) return deny(AUTH_REFUSALS.SERVICE, { reason: 'the authorization is for a different service' });
    if (branch !== APPROVED_PRODUCTION.branch) return deny(AUTH_REFUSALS.BRANCH, { reason: 'the authorization is for a different branch' });
    if (dbHost !== APPROVED_PRODUCTION.databaseHost
        || dbPort !== APPROVED_PRODUCTION.databasePort
        || dbName !== APPROVED_PRODUCTION.databaseName) {
        return deny(AUTH_REFUSALS.DATABASE, { reason: 'the authorization is for a different database identity' });
    }

    const issued = Date.parse(issuedAt);
    const expires = Date.parse(expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) {
        return deny(AUTH_REFUSALS.INVALID, { reason: 'issuance or expiry time is malformed' });
    }
    const windowSeconds = (expires - issued) / 1000;
    if (windowSeconds > DEPLOY_AUTH_MAX_WINDOW_SECONDS) {
        return deny(AUTH_REFUSALS.WINDOW, { reason: `the validity window exceeds ${DEPLOY_AUTH_MAX_WINDOW_SECONDS}s` });
    }
    const now = Date.now();
    if (issued > now + DEPLOY_AUTH_CLOCK_SKEW_SECONDS * 1000) {
        return deny(AUTH_REFUSALS.NOT_YET_VALID, { reason: 'the authorization is issued in the future' });
    }
    if (now >= expires) return deny(AUTH_REFUSALS.EXPIRED, { reason: 'the authorization has expired' });

    return { ok: true, code: null, detail: { commit, expiresAt } };
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

        // 5. Independent authorization for THIS release. The identity tuple
        //    above is forgeable by any local process; a signature that binds the
        //    service, branch, commit, database and a short validity window is
        //    not, because it needs a private key only the operator holds.
        const auth = deployAuthorizationVerdict(env);
        if (!auth.ok) {
            return refuse(auth.code,
                `production DDL requires a valid per-release ${DEPLOY_AUTH_TOKEN_ENV} for this commit; the identity tuple alone is not authorization (${auth.detail.reason})`,
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
    DEPLOY_COMMIT_ENV,
    DEPLOY_AUTH_MAX_WINDOW_SECONDS,
    DEPLOY_AUTH,
    deployAuthorizationVerdict,
    AUTH_REFUSALS,
    matchesApprovedDatabase,
    isRenderContext,
    APPROVED_PRODUCTION,
    DISPOSABLE_TEST_HOSTS,
    TEST_TARGET_POLICY_ENV,
    TEST_TARGET_POLICY_VALUE,
};
