'use strict';

// =============================================================================
// AZAMAN — single Redis connection factory (Upstash-compatible)
//
// WHY THIS EXISTS
// The backend previously created up to TEN independent ioredis clients, each
// with its own options. That caused three real problems:
//
//   1. CONNECTION PRESSURE. Upstash bills and limits by connection and
//      command. Ten clients per instance reconnect independently, and the
//      2026-09-17 quota incident turned that into a reconnect storm.
//   2. INCONSISTENT TLS. Two cache clients passed `rejectUnauthorized: false`,
//      which accepts ANY certificate — including an attacker's. Upstash serves
//      a public CA certificate, so there is never a reason to disable
//      verification.
//   3. INCONSISTENT RETRY. Some clients stopped retrying permanently after a
//      few attempts (retryStrategy returning null), leaving them dead for the
//      life of the process while callers kept believing Redis existed.
//
// This module owns ONE connection per PROFILE. Profiles exist because BullMQ
// requires maxRetriesPerRequest: null while request-scoped callers must fail
// fast; everything else shares the default profile.
// =============================================================================

const Redis = require('ioredis');
const logger = require('../config/logger');

const PROFILES = Object.freeze({
    // Shared by rate limiting, sockets, caches and the pub/sub adapter.
    default: { maxRetriesPerRequest: 3 },
    // Caches must not stall a request; they degrade to memory instead.
    cache: { maxRetriesPerRequest: 2 },
    // OTP must fail closed and fast rather than queue.
    otp: { maxRetriesPerRequest: 2 },
    // BullMQ documents this requirement explicitly.
    queue: { maxRetriesPerRequest: null },
});

const clients = new Map();

/**
 * Accept only a real Redis URL. A pasted Upstash REST URL (https://…upstash.io)
 * is a common mistake and would otherwise be handed to ioredis as a hostname.
 */
function normalizeRedisUrl(raw) {
    const url = String(raw ?? '').trim();
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) {
        throw new Error(
            '[redis] REDIS_URL looks like an Upstash REST URL (https://…). ioredis needs the Redis URL: '
            + 'rediss://default:<password>@<endpoint>:6379'
        );
    }
    if (!/^rediss?:\/\//i.test(url)) {
        throw new Error('[redis] REDIS_URL must start with redis:// or rediss://');
    }
    assertTransportSecurity(url);
    return url;
}

/**
 * Refuse an UNENCRYPTED Redis URL in production.
 *
 * Verified 2026-11-14 against Redis Cloud: the free Essentials plan cannot
 * enable TLS at all — the API answers FIXED_DATABASE_ENABLE_TLS_NOT_SUPPORTED_
 * IN_REQUESTED_PLAN. So `redis://` in production is not a hypothetical, it is
 * what a free-tier endpoint forces, and it sends the password and every key
 * over the public internet in the clear.
 *
 * Refusing here rather than accepting quietly is deliberate: the caller then
 * sees "not configured", and the OTP path fails closed with
 * OTP_STORE_UNAVAILABLE instead of writing codes through an unencrypted link.
 * The escape hatch exists for a genuinely private network and is one explicit
 * variable, never an inference from the hostname.
 */
function assertTransportSecurity(url, env = process.env) {
    if (String(env.NODE_ENV || '') !== 'production') return url;   // dev/test: unchanged
    if (/^rediss:\/\//i.test(url)) return url;                     // encrypted, fine
    if (String(env.REDIS_ALLOW_PLAINTEXT || '').toLowerCase() === 'true') {
        logger.warn(
            '[redis] REDIS_ALLOW_PLAINTEXT=true — accepting an UNENCRYPTED redis:// URL in production. '
            + 'Only correct for a private network; the password and all keys are visible on the wire.'
        );
        return url;
    }
    throw new Error(
        '[redis] refusing plaintext redis:// in production: use rediss:// so the password and keys are '
        + 'encrypted. If this endpoint really is on a private network, set REDIS_ALLOW_PLAINTEXT=true explicitly.'
    );
}

/**
 * Bounded exponential backoff. The 2026-09-17 incident was a reconnect storm:
 * ioredis' default is attempts × 100ms forever. This floors at 500ms, doubles,
 * and caps at 10s — roughly 6 attempts/min/connection instead of ~600.
 */
function retryStrategy(times) {
    if (times > 30) return null; // give up eventually rather than thrash forever
    return Math.min(500 * 2 ** Math.min(times - 1, 5), 10_000);
}

function isConfigured() {
    try {
        return normalizeRedisUrl(process.env.REDIS_URL) !== null;
    } catch (_) {
        return false;
    }
}

/**
 * Get (and lazily create) the shared client for a profile.
 * Returns null when Redis is not configured, so callers keep their existing
 * in-memory fallbacks rather than changing behaviour.
 */
function getRedis(profile = 'default') {
    const options = PROFILES[profile];
    if (!options) throw new Error(`[redis] unknown profile ${profile}`);

    let url;
    try {
        url = normalizeRedisUrl(process.env.REDIS_URL);
    } catch (e) {
        logger.error({ err: e }, '[redis] invalid REDIS_URL — running without Redis');
        return null;
    }
    if (!url) return null;

    const existing = clients.get(profile);
    if (existing) return existing;

    const client = new Redis(url, {
        ...options,
        // Upstash terminates TLS with a public certificate. ioredis enables TLS
        // for rediss:// on its own — never disable verification to "make it work".
        enableReadyCheck: false,
        lazyConnect: true,
        connectTimeout: 5000,
        retryStrategy,
    });

    let lastError = null;
    client.on('error', (err) => {
        lastError = err?.message ?? String(err);
        logger.error({ err }, `[redis:${profile}] connection error`);
    });
    client.on('ready', () => {
        lastError = null;
        logger.info(`[redis:${profile}] connected`);
    });

    // Exposed for /health without leaking the URL.
    client.__azmProfile = profile;
    client.__azmLastError = () => lastError;

    clients.set(profile, client);
    return client;
}

/** Round-trip proof that Redis is actually reachable right now. */
async function ping(profile = 'default') {
    const client = getRedis(profile);
    if (!client) return { ok: false, reason: 'not_configured' };
    try {
        const startedAt = Date.now();
        const reply = await client.ping();
        return { ok: reply === 'PONG', profile, latencyMs: Date.now() - startedAt };
    } catch (e) {
        return { ok: false, profile, reason: e?.code || e?.message || 'error' };
    }
}

/** Redacted status for /health. Never returns the URL or the password. */
function status() {
    const profiles = {};
    for (const [name, client] of clients.entries()) {
        profiles[name] = {
            status: client.status,
            lastError: client.__azmLastError?.() ?? null,
        };
    }
    return {
        configured: isConfigured(),
        profiles,
    };
}

/** Test/ops helper: close every connection. */
async function disconnectAll() {
    const closing = [...clients.values()].map((c) => c.quit().catch(() => c.disconnect()));
    clients.clear();
    await Promise.all(closing);
}

module.exports = {
    getRedis,
    ping,
    status,
    isConfigured,
    disconnectAll,
    normalizeRedisUrl,
    assertTransportSecurity,
    retryStrategy,
    PROFILES,
};
