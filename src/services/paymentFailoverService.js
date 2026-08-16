// src/services/paymentFailoverService.js
// =============================================================================
// AZAMAN V2 — Payment Provider Failover Service
//
// Wraps multiple disbursement providers (Moolre → MTN) with automatic failover
// and health-based routing. If the primary provider fails, the secondary is
// tried before the withdrawal is reversed.
//
// Health tracking: successes/failures stored in Redis with a 10-minute TTL.
// If a provider has 3+ failures in the window, it is marked unhealthy and
// skipped until it recovers (probed on every call).
//
// Reference: Wise (payment routing with automatic failover),
//            Stripe (Smart Retries), Revolut (multi-provider routing)
// =============================================================================

const logger = require('../config/logger');

const HEALTH_WINDOW_SECONDS = 600;  // 10 minutes
const FAILURE_THRESHOLD     = 3;    // 3 failures in window → unhealthy
const RECOVERY_PROBE_RATIO  = 0.5;  // try unhealthy provider on 50% of calls

class PaymentFailoverService {
    /**
     * @param {Object} providers - { primary: MoolreDisbursementService, secondary: MtnDisbursementService }
     * @param {Object} opts - { redis?: RedisClient, providers?: [{ name, instance, priority }] }
     */
    constructor(opts = {}) {
        // Support both { primary, secondary } and { providers: [{name, instance, priority}] }
        if (opts.providers && Array.isArray(opts.providers)) {
            this.providers = opts.providers
                .sort((a, b) => (a.priority || 0) - (b.priority || 0));
        } else {
            this.providers = [
                { name: 'moolre', instance: opts.primary, priority: 1 },
                { name: 'mtn', instance: opts.secondary, priority: 2 },
            ].filter(p => p.instance);
        }

        this.redis = opts.redis || null;
        this._memoryHealth = new Map(); // fallback if no Redis

        if (this.providers.length === 0) {
            throw new Error('PaymentFailoverService requires at least one provider');
        }

        logger.info({
            providers: this.providers.map(p => p.name)
        }, '[PaymentFailover] Initialized with providers');
    }

    // ── Health tracking ─────────────────────────────────────────────────────

    async _getHealthKey(provider) {
        const key = `payment:health:${provider}`;
        if (this.redis) {
            const raw = await this.redis.get(key);
            return raw ? JSON.parse(raw) : { successes: 0, failures: 0 };
        }
        return this._memoryHealth.get(key) || { successes: 0, failures: 0 };
    }

    async _recordSuccess(provider) {
        const key = `payment:health:${provider}`;
        const health = await this._getHealthKey(provider);
        health.successes++;
        health.failures = 0; // reset failures on success
        health.lastSuccessAt = new Date().toISOString();

        if (this.redis) {
            await this.redis.set(key, JSON.stringify(health), 'EX', HEALTH_WINDOW_SECONDS);
        } else {
            this._memoryHealth.set(key, health);
        }
    }

    async _recordFailure(provider, error) {
        const key = `payment:health:${provider}`;
        const health = await this._getHealthKey(provider);
        health.failures++;
        health.lastFailureAt = new Date().toISOString();
        health.lastError = error?.message || 'Unknown error';

        if (this.redis) {
            await this.redis.set(key, JSON.stringify(health), 'EX', HEALTH_WINDOW_SECONDS);
        } else {
            this._memoryHealth.set(key, health);
        }

        logger.warn({
            provider,
            failures: health.failures,
            error: health.lastError
        }, '[PaymentFailover] Provider failure recorded');
    }

    async _isHealthy(provider) {
        const health = await this._getHealthKey(provider);
        return health.failures < FAILURE_THRESHOLD;
    }

    async _shouldProbeUnhealthy(provider) {
        // Probe unhealthy providers 50% of the time to detect recovery
        return Math.random() < RECOVERY_PROBE_RATIO;
    }

    // ── Public API (mirrors MoolreDisbursementService shape) ──────────────────

    newReferenceId() {
        // Delegate to the first provider (reference format is the same)
        return this.providers[0].instance.newReferenceId();
    }

    /**
     * Initiate a transfer with automatic failover.
     * Tries providers in priority order, skipping unhealthy ones.
     * @returns {Object} disbursement result from the first successful provider
     * @throws {Error} if ALL providers fail
     */
    async initiateTransfer(payload) {
        const triedProviders = [];
        const errors = [];

        for (const provider of this.providers) {
            const isHealthy = await this._isHealthy(provider.name);

            if (!isHealthy && !await this._shouldProbeUnhealthy(provider.name)) {
                logger.info({
                    provider: provider.name,
                    reason: 'unhealthy (skipped)'
                }, '[PaymentFailover] Skipping unhealthy provider');
                triedProviders.push(provider.name);
                continue;
            }

            triedProviders.push(provider.name);

            try {
                logger.info({
                    provider: provider.name,
                    referenceId: payload.referenceId
                }, '[PaymentFailover] Attempting transfer');

                const result = await provider.instance.initiateTransfer(payload);

                await this._recordSuccess(provider.name);

                logger.info({
                    provider: provider.name,
                    referenceId: payload.referenceId
                }, '[PaymentFailover] Transfer succeeded');

                return {
                    ...result,
                    _provider: provider.name, // tag which provider handled it
                };
            } catch (err) {
                await this._recordFailure(provider.name, err);
                errors.push({ provider: provider.name, error: err.message });

                logger.warn({
                    provider: provider.name,
                    error: err.message,
                    nextProvider: this.providers[this.providers.indexOf(provider) + 1]?.name || 'none'
                }, '[PaymentFailover] Provider failed, trying next');

                continue;
            }
        }

        // All providers failed
        const allFailed = new Error(
            `All payment providers failed: ${JSON.stringify(errors)}`
        );
        allFailed.providerErrors = errors;
        allFailed.triedProviders = triedProviders;
        throw allFailed;
    }

    /**
     * Get transfer status — tries the provider that handled the reference first.
     * Falls back to polling all providers if the tag is missing.
     */
    async getTransferStatus(referenceId, providerHint) {
        // If we know which provider handled it, check that one first
        if (providerHint) {
            const provider = this.providers.find(p => p.name === providerHint);
            if (provider) {
                try {
                    return await provider.instance.getTransferStatus(referenceId);
                } catch (err) {
                    logger.warn({
                        provider: provider.name,
                        referenceId,
                        error: err.message
                    }, '[PaymentFailover] Status check failed on hint provider, polling all');
                }
            }
        }

        // Poll all providers
        for (const provider of this.providers) {
            try {
                const status = await provider.instance.getTransferStatus(referenceId);
                if (status && status.status !== 'NOT_FOUND') {
                    return { ...status, _provider: provider.name };
                }
            } catch {
                continue;
            }
        }

        return { status: 'UNKNOWN', referenceId };
    }

    // ── Health inspection (for admin dashboard) ──────────────────────────────

    async getHealthStatus() {
        const statuses = {};
        for (const provider of this.providers) {
            const health = await this._getHealthKey(provider.name);
            statuses[provider.name] = {
                healthy: health.failures < FAILURE_THRESHOLD,
                successes: health.successes,
                failures: health.failures,
                lastSuccessAt: health.lastSuccessAt,
                lastFailureAt: health.lastFailureAt,
                lastError: health.lastError,
            };
        }
        return statuses;
    }
}

module.exports = { PaymentFailoverService };
