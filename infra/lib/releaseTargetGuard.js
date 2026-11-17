'use strict';

// =============================================================================
// Release target guard — decides whether a release-chain invocation may run.
//
// The release chain applies production DDL. That is only ever safe when the
// invocation is the trusted production deployment: a manual deploy of `main`
// on the Render service, against the production database. Every other context
// — a pull-request preview build, a branch deploy, a shell pointed at a local
// or disposable database — must be refused BEFORE the first installer runs.
//
// This module is pure: no I/O, no logging, no environment mutation. It never
// returns, logs or interpolates the database URL, so a refusal can never leak a
// credential into a build log. Credentials stay in the environment.
// =============================================================================

/** Hosts that are never the production database. */
const NON_PRODUCTION_HOSTS = Object.freeze([
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'host.docker.internal',
]);

/** Suffixes that denote a private, local or ephemeral target. */
const NON_PRODUCTION_SUFFIXES = Object.freeze(['.local', '.internal', '.localhost']);

/** Classify the target WITHOUT exposing it. */
function classifyTarget(databaseUrl) {
    if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') return 'missing';
    let host;
    try {
        host = new URL(databaseUrl).hostname.toLowerCase();
    } catch {
        return 'unparseable';
    }
    if (!host) return 'unparseable';
    if (NON_PRODUCTION_HOSTS.includes(host)) return 'local';
    if (NON_PRODUCTION_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'local';
    return 'remote';
}

/**
 * Is this process a Render build/pre-deploy execution environment?
 *
 * Only the RENDER marker decides. RENDER_SERVICE_ID is deliberately NOT used:
 * any shell that happens to hold Render API credentials or a service id would
 * then be mistaken for a deploy and have its release chain refused. RENDER is
 * set by Render itself only inside its own build and runtime environments.
 */
function isRenderContext(env) {
    const flag = String(env.RENDER || '').toLowerCase();
    return flag === 'true' || flag === '1';
}

/**
 * Evaluate the release target.
 *
 * Returns { allowed, code, context, reason, branch? }. The result contains no
 * connection information whatsoever — only a classification and a fixed code.
 */
function evaluateReleaseTarget(env = process.env) {
    const context = isRenderContext(env) ? 'render' : 'outside-render';

    // Outside Render (developer shell, CI runner, test process) the chain is a
    // local tool. CI applies its own schema and the tests assert on that.
    if (context !== 'render') {
        return {
            allowed: true,
            code: 'RELEASE_TARGET_LOCAL_CONTEXT',
            context,
            target: 'local-context',
            reason: 'not running on Render: the release chain is a local/dev tool here',
        };
    }

    if (String(env.IS_PULL_REQUEST || '').toLowerCase() === 'true') {
        return {
            allowed: false,
            code: 'RELEASE_REFUSED_PREVIEW',
            context,
            target: null,
            reason: 'pull-request preview builds are untrusted and must never apply production DDL',
        };
    }

    const branch = typeof env.RENDER_GIT_BRANCH === 'string' ? env.RENDER_GIT_BRANCH.trim() : '';
    if (branch && branch !== 'main') {
        return {
            allowed: false,
            code: 'RELEASE_REFUSED_BRANCH',
            context,
            branch,
            target: null,
            reason: 'only the canonical branch may apply production DDL',
        };
    }

    const target = classifyTarget(env.DATABASE_URL);
    if (target === 'missing' || target === 'unparseable') {
        return {
            allowed: false,
            code: 'RELEASE_REFUSED_NO_DATABASE',
            context,
            target,
            reason: 'no usable DATABASE_URL was provided to the build/pre-deploy environment',
        };
    }
    if (target === 'local') {
        return {
            allowed: false,
            code: 'RELEASE_REFUSED_NON_PRODUCTION_TARGET',
            context,
            target,
            reason: 'the configured database target is local or private, so a production release must not run',
        };
    }

    return {
        allowed: true,
        code: 'RELEASE_TARGET_PRODUCTION',
        context,
        branch: branch || 'main',
        target,
        reason: 'trusted production deploy: canonical branch, remote database target',
    };
}

module.exports = { evaluateReleaseTarget, classifyTarget, isRenderContext, NON_PRODUCTION_HOSTS };
