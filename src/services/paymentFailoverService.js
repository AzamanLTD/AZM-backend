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
// skipped until it recovers. An unhealthy provider may only be probed with
// a live payout when its recorded degradation is provably money-safe; a
// provider whose window contains an AMBIGUOUS outcome is never probed
// (recovery is passive: window expiry or a recorded success).
//
// Redis health counters are mutated with MULTI/EXEC pipelines — the old
// GET→JSON.parse→SET read-modify-write lost updates between concurrent
// dispatches (and between instances sharing the same Redis), which could
// keep a degraded provider "healthy" or a recovered one "unhealthy".
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

    _emptyHealth() {
        return {
            successes: 0,
            failures: 0,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastError: null,
            lastAmbiguousFailureAt: null,
        };
    }

    async _getHealthKey(provider) {
        const key = `payment:health:${provider}`;
        if (this.redis) {
            const h = await this.redis.hgetall(key);
            if (!h || Object.keys(h).length === 0) return this._emptyHealth();
            return {
                successes:               Number(h.successes || 0),
                failures:                Number(h.failures || 0),
                lastSuccessAt:           h.lastSuccessAt || null,
                lastFailureAt:           h.lastFailureAt || null,
                lastError:               h.lastError || null,
                lastAmbiguousFailureAt:  h.lastAmbiguousFailureAt || null,
            };
        }
        return this._memoryHealth.get(key) || this._emptyHealth();
    }

    async _recordSuccess(provider) {
        const key = `payment:health:${provider}`;
        const now = new Date().toISOString();

        if (this.redis) {
            // MULTI/EXEC: ONE atomic round. With the old GET→mutate→SET, a
            // concurrent failure recorded between the read and the write was
            // silently erased by the success reset (lost update) — and two
            // dispatches could each clobber the other's counter entirely.
            // The pipeline is serialized by Redis: either order is a valid
            // serial history, and no update is ever lost.
            await this.redis.multi()
                .hincrby(key, 'successes', 1)
                .hset(key, 'failures', 0)
                .hset(key, 'lastSuccessAt', now)
                .hdel(key, 'lastError')
                // A success is an authoritative provider answer — the rail
                // demonstrably works again, so live-payout probing is safe.
                .hdel(key, 'lastAmbiguousFailureAt')
                .expire(key, HEALTH_WINDOW_SECONDS)
                .exec();
        } else {
            const health = this._memoryHealth.get(key) || this._emptyHealth();
            health.successes++;
            health.failures = 0; // reset failures on success
            health.lastSuccessAt = now;
            health.lastError = null;
            health.lastAmbiguousFailureAt = null;
            this._memoryHealth.set(key, health);
        }
    }

    async _recordFailure(provider, error) {
        // ── r15 follow-up (audit P1): health must mean PROVIDER degradation.
        // A DEFINITIVE_REJECTION or DUPLICATE_REFERENCE proves the provider
        // is reachable, authenticated and answering authoritatively — the
        // REQUEST was bad (bad beneficiary number, wrong rail, already-held
        // reference). Counting those as provider failures lets a few
        // legitimate customer-level rejections mark a HEALTHY provider
        // unhealthy and reroute unrelated customers' money. Provider health
        // counters only accumulate outcomes that indicate the provider
        // itself failed or degraded: transport errors, 5xx/ambiguous
        // (UNKNOWN_OUTCOME), NOT_DISPATCHED unreachability, or unclassified
        // errors (conservatively treated as provider-side).
        const outcome = error?.providerOutcome || null;
        const PROVIDER_IS_ANSWERING_WELL
            = outcome === 'DEFINITIVE_REJECTION' || outcome === 'DUPLICATE_REFERENCE';
        if (PROVIDER_IS_ANSWERING_WELL) {
            logger.info({
                provider,
                outcome,
                error: error?.message || 'Unknown error'
            }, '[PaymentFailover] Request-level rejection — provider answered authoritatively; NOT counted against provider health');
            return;
        }

        const key = `payment:health:${provider}`;
        const now = new Date().toISOString();
        const lastError = error?.message || 'Unknown error';
        // AMBIGUOUS degradation: the provider may be ACCEPTING payouts and
        // losing the answers (UNKNOWN_OUTCOME, or an unclassified error,
        // conservatively treated the same). Stamped on the health record so
        // _shouldProbeUnhealthy can refuse to route fresh live money into a
        // rail that may be silently swallowing payouts.
        const AMBIGUOUS = outcome === 'UNKNOWN_OUTCOME' || !outcome;

        let failures;
        if (this.redis) {
            // MULTI/EXEC — same lost-update reasoning as _recordSuccess.
            // Failure counting and the ambiguity stamp land in ONE atomic
            // round: a concurrent success reset can interleave before or
            // after, but can never erase the failure mid-write.
            const chain = this.redis.multi()
                .hincrby(key, 'failures', 1)
                .hset(key, 'lastFailureAt', now)
                .hset(key, 'lastError', lastError);
            if (AMBIGUOUS) chain.hset(key, 'lastAmbiguousFailureAt', now);
            await chain.expire(key, HEALTH_WINDOW_SECONDS).exec();
            failures = (await this._getHealthKey(provider)).failures;
        } else {
            const health = this._memoryHealth.get(key) || this._emptyHealth();
            health.failures++;
            health.lastFailureAt = now;
            health.lastError = lastError;
            if (AMBIGUOUS) health.lastAmbiguousFailureAt = now;
            this._memoryHealth.set(key, health);
            failures = health.failures;
        }

        logger.warn({
            provider,
            failures,
            outcome,
            ambiguous: AMBIGUOUS,
            error: lastError
        }, '[PaymentFailover] Provider failure recorded');
    }

    async _isHealthy(provider) {
        const health = await this._getHealthKey(provider);
        return health.failures < FAILURE_THRESHOLD;
    }

    async _shouldProbeUnhealthy(provider) {
        // A "probe" of an unhealthy DISBURSEMENT provider is a REAL customer
        // payout, not a health-check ping. Probing is only allowed when the
        // provider's recorded degradation is PROVABLY money-safe: if any
        // failure in the current window was AMBIGUOUS (UNKNOWN_OUTCOME /
        // unclassified — the provider may be accepting payouts and losing the
        // answers), routing fresh live money into it multiplies parked
        // payouts and operator reconciliation load. Such a provider recovers
        // PASSIVELY: the 10-minute health window expires, or a success is
        // recorded on a rail we still route to for other reasons. Never by
        // handing it new customer money to test with.
        const health = await this._getHealthKey(provider);
        if (health.lastAmbiguousFailureAt) {
            logger.info({
                provider,
                lastAmbiguousFailureAt: health.lastAmbiguousFailureAt,
            }, '[PaymentFailover] Not probing unhealthy provider — window contains an ambiguous outcome; recovery must be passive (window expiry or a recorded success)');
            return false;
        }
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
                errors.push({ provider: provider.name, error: err.message, providerOutcome: err.providerOutcome || null });

                // ── r15 R15-C: failover is ONLY safe on provably-unmoved money.
                // A thrown error is NOT proof the provider refused. A timeout
                // or reset can occur AFTER the provider accepted the same
                // reference — issuing the SAME payload to the next provider
                // would disburse TWICE. Only outcomes that PROVABLY left the
                // money unmoved (NOT_DISPATCHED — no bytes reached the
                // provider; DEFINITIVE_REJECTION — the provider explicitly
                // refused) may continue down the chain. UNKNOWN_OUTCOME,
                // DUPLICATE_REFERENCE and any UNCLASSIFIED error stop the
                // chain: the transfer stays pending under its reference and
                // resolves by status/callback — never a second instruction.
                const outcome = err.providerOutcome || null;
                const SAFE_TO_FAILOVER = outcome === 'NOT_DISPATCHED' || outcome === 'DEFINITIVE_REJECTION';

                if (!SAFE_TO_FAILOVER) {
                    const blocking = new Error(
                        `[PaymentFailover] ${provider.name} returned ${outcome || 'UNCLASSIFIED'} for reference ${payload.referenceId} — the outcome is not provably safe, refusing failover (the transfer stays pending under its reference)`
                    );
                    blocking.providerOutcome = outcome || 'UNKNOWN_OUTCOME';
                    blocking.provider = provider.name;
                    blocking.referenceId = payload.referenceId;
                    blocking.triedProviders = triedProviders;
                    blocking.providerErrors = errors;
                    blocking.cause = err;
                    logger.error({
                        provider: provider.name,
                        outcome,
                        referenceId: payload.referenceId,
                        triedProviders
                    }, '[PaymentFailover] NOT failing over — outcome not provably safe');
                    throw blocking;
                }

                logger.warn({
                    provider: provider.name,
                    error: err.message,
                    nextProvider: this.providers[this.providers.indexOf(provider) + 1]?.name || 'none'
                }, '[PaymentFailover] Provider failed (provably safe outcome), trying next');

                continue;
            }
        }

        // All providers failed — every one with a PROVABLY safe outcome
        // (NOT_DISPATCHED / DEFINITIVE_REJECTION; anything else threw the
        // r15 R15-C blocking error above). The aggregate is therefore safely
        // classifiable: no provider can have accepted the transfer.
        const allFailed = new Error(
            `All payment providers failed: ${JSON.stringify(errors)}`
        );
        allFailed.providerOutcome = 'DEFINITIVE_REJECTION';
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
                lastAmbiguousFailureAt: health.lastAmbiguousFailureAt,
            };
        }
        return statuses;
    }
}

module.exports = { PaymentFailoverService };
