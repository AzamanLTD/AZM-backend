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
// skipped until it recovers. Recovery is detected by a NON-ECONOMIC probe:
// a rate-limited transfer-STATUS lookup (read-only provider I/O), never
// real customer payout traffic. A definitive answer to a probe — even a
// rejection — proves the rail is alive and re-admits the provider.
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
// Minimum spacing between non-economic recovery probes of the same provider.
// An unhealthy provider can receive at most one read-only status probe per
// interval per instance — never ordinary customer payout traffic.
const DEFAULT_PROBE_INTERVAL_MS = 60 * 1000;

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
        this._probeIntervalMs = Number.isFinite(opts.probeMinIntervalMs)
            ? Math.max(0, opts.probeMinIntervalMs)
            : DEFAULT_PROBE_INTERVAL_MS;
        this._lastProbeAt = new Map(); // provider → last probe timestamp (ms)

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
        // The adapter carries a rejection CLASS on every DEFINITIVE_REJECTION:
        //   REQUEST_LEVEL     — bad beneficiary number, wrong rail, already-
        //                       held reference. OUR request was wrong; the
        //                       provider is reachable and healthy. Never
        //                       counted: a few legitimate customer-level
        //                       rejections must not reroute other customers'
        //                       money away from a healthy provider.
        //   PROVIDER_CAPACITY — insufficient float, limits, operational or
        //                       maintenance refusal. The provider itself
        //                       cannot serve right now. Counted: the routing
        //                       tier SHOULD prefer the other rail until it
        //                       recovers.
        // DUPLICATE_REFERENCE is always request-level. Transport errors,
        // NOT_DISPATCHED unreachability, UNKNOWN_OUTCOME and unclassified
        // errors are conservatively provider-side and always counted.
        const outcome = error?.providerOutcome || null;
        const rejectionClass = error?.providerRejectionClass || null;
        const REQUEST_LEVEL = outcome === 'DUPLICATE_REFERENCE'
            || (outcome === 'DEFINITIVE_REJECTION' && rejectionClass !== 'PROVIDER_CAPACITY');
        if (REQUEST_LEVEL) {
            logger.info({
                provider,
                outcome,
                rejectionClass,
                error: error?.message || 'Unknown error'
            }, '[PaymentFailover] Request-level rejection — provider answered authoritatively; NOT counted against provider health');
            return;
        }

        const key = `payment:health:${provider}`;
        const now = new Date().toISOString();
        const lastError = error?.message || 'Unknown error';
        // AMBIGUOUS degradation: the provider may be ACCEPTING payouts and
        // losing the answers (UNKNOWN_OUTCOME, or an unclassified error,
        // conservatively treated the same). Stamped on the health record for
        // operator visibility (getHealthStatus) — with NON-ECONOMIC recovery
        // probes an ambiguous provider is safely probeable (the probe is a
        // read-only status lookup, not a payout).
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

    /**
     * NON-ECONOMIC recovery probe. Called only for an UNHEALTHY provider
     * before routing decides to skip it. Never sends money: it performs a
     * read-only transfer-STATUS lookup against a synthetic reference. Any
     * definitive answer — including a rejection for the unknown reference —
     * proves the rail is alive, records a success (restoring health), and
     * re-admits the provider to normal routing. A transport-level failure
     * keeps it unhealthy and records further degradation evidence.
     *
     * Rate-limited per provider (min interval per instance), so a downed
     * provider receives at most a couple of read-only probes per minute
     * across instances — never uncontrolled or random CUSTOMER traffic.
     */
    async _attemptRecoveryProbe(provider) {
        const now = Date.now();
        const last = this._lastProbeAt.get(provider.name) || 0;
        if (now - last < this._probeIntervalMs) return false;
        this._lastProbeAt.set(provider.name, now);

        const probeReference = (() => {
            try { return provider.instance.newReferenceId(); } catch { return `probe-${provider.name}-${now}`; }
        })();

        try {
            const answer = await provider.instance.getTransferStatus(probeReference);
            // r15 follow-up (audit P1): a non-throwing response is only proof
            // of a LIVE rail if it is an AUTHORITATIVE status answer. A rail
            // that answers UNKNOWN/malformed for a synthetic reference proves
            // its status contract is broken — re-admitting it on that answer
            // would route customer payouts to a provider whose settlements we
            // cannot query. NOT_FOUND (and any concrete status) IS
            // authoritative: it proves the rail looked the reference up.
            const answerStatus = answer ? String(answer.status || '').toUpperCase() : '';
            if (!answerStatus || answerStatus === 'UNKNOWN') {
                await this._recordFailure(provider.name, {
                    message: `recovery probe returned non-authoritative status: ${answerStatus || 'EMPTY'}`,
                    code: 'PROBE_NON_AUTHORITATIVE',
                });
                logger.info({
                    provider: provider.name,
                    probeReference,
                    answerStatus: answerStatus || 'EMPTY',
                }, '[PaymentFailover] Recovery probe answered non-authoritatively — provider stays unhealthy (skipped)');
                return false;
            }
            await this._recordSuccess(provider.name);
            logger.info({
                provider: provider.name,
                probeReference,
            }, '[PaymentFailover] Non-economic recovery probe SUCCEEDED — provider re-admitted to routing');
            return true;
        } catch (err) {
            const outcome = err?.providerOutcome || null;
            // A definitive rejection (e.g. "unknown reference") is still an
            // authoritative answer from a LIVE rail — the provider recovered.
            if (outcome === 'DEFINITIVE_REJECTION' || outcome === 'DUPLICATE_REFERENCE') {
                await this._recordSuccess(provider.name);
                logger.info({
                    provider: provider.name,
                    probeReference,
                    outcome,
                }, '[PaymentFailover] Recovery probe answered authoritatively — provider re-admitted to routing');
                return true;
            }
            await this._recordFailure(provider.name, err);
            logger.info({
                provider: provider.name,
                probeReference,
                outcome,
            }, '[PaymentFailover] Recovery probe failed — provider stays unhealthy (skipped)');
            return false;
        }
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
            let isHealthy = await this._isHealthy(provider.name);

            if (!isHealthy) {
                // Recovery is detected by a rate-limited NON-ECONOMIC status
                // probe (never real customer money). If the probe succeeds the
                // provider is re-admitted and this transfer routes to it.
                isHealthy = await this._attemptRecoveryProbe(provider);
                if (!isHealthy) {
                    logger.info({
                        provider: provider.name,
                        reason: 'unhealthy (skipped)'
                    }, '[PaymentFailover] Skipping unhealthy provider');
                    triedProviders.push(provider.name);
                    continue;
                }
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
     * Get transfer status — the ownership contract (r15 follow-up, audit P0).
     *
     * KNOWN OWNER (providerHint, from the persisted actual-provider
     * metadata written at dispatch acceptance):
     *   The owner is AUTHORITATIVE for this payout. Query ONLY the owner:
     *   - a concrete answer (PENDING/SUCCESSFUL/FAILED/...) is returned with
     *     the owner's identity, including NOT_FOUND — an authoritative
     *     absence that the caller records as an ownership conflict, never
     *     resolves by asking another rail;
     *   - a transport failure or an application-level unresolved answer is
     *     UNRESOLVED ({ status: 'UNKNOWN', unresolved: true }) — the payout
     *     stays parked. The owner rail being down is NEVER permission to
     *     let ANOTHER provider's answer settle or reverse this provider's
     *     payout (a healthy secondary cannot know what the owner did).
     *
     * UNKNOWN OWNER (no hint — legacy rows without persisted ownership):
     *   Poll providers in priority order. A concrete answer is
     *   authoritative and returns immediately; NOT_FOUND (authoritative
     *   absence on one rail) CONTINUES the search — the dispatch may have
     *   landed on any rail. An unresolved/UNKNOWN answer or an error on one
     *   rail also continues (ownership is genuinely unknown, so other rails
     *   remain legitimate candidates). If EVERY polled rail authoritatively
     *   answers absence, the aggregate is NOT_FOUND; otherwise UNKNOWN.
     */
    async getTransferStatus(referenceId, providerHint) {
        if (providerHint) {
            const provider = this.providers.find(p => p.name === providerHint);
            if (provider) {
                try {
                    const status = await provider.instance.getTransferStatus(referenceId);
                    const answerStatus = status ? String(status.status || '').toUpperCase() : '';
                    if (!answerStatus || answerStatus === 'UNKNOWN') {
                        return {
                            status: 'UNKNOWN',
                            referenceId,
                            _provider: provider.name,
                            unresolved: true,
                            unresolvedReason: 'PROVIDER_RETURNED_UNKNOWN',
                        };
                    }
                    return { ...status, _provider: provider.name };
                } catch (err) {
                    return {
                        status: 'UNKNOWN',
                        referenceId,
                        _provider: provider.name,
                        unresolved: true,
                        unresolvedReason: 'PROVIDER_STATUS_ERROR',
                        error: err.message,
                    };
                }
            }
            // A hint that maps to no configured provider is still a recorded
            // owner: NEVER fall through to cross-provider polling (the owner
            // identity came from this reference's dispatch evidence).
            return {
                status: 'UNKNOWN',
                referenceId,
                _provider: providerHint,
                unresolved: true,
                unresolvedReason: 'UNKNOWN_PROVIDER_HINT',
            };
        }

        // No hint: genuinely-unknown ownership — poll in priority order.
        let authoritativeAbsenceCount = 0;
        for (const provider of this.providers) {
            try {
                const status = await provider.instance.getTransferStatus(referenceId);
                if (!status) continue;
                const answerStatus = String(status.status || '').toUpperCase();
                if (answerStatus === 'NOT_FOUND') {
                    authoritativeAbsenceCount += 1;
                    continue; // absent on THIS rail — the dispatch may have landed on another
                }
                if (!answerStatus || answerStatus === 'UNKNOWN') {
                    continue; // unresolved on this rail — not absence, keep searching
                }
                return { ...status, _provider: provider.name };
            } catch {
                continue;
            }
        }
        if (this.providers.length > 0 && authoritativeAbsenceCount === this.providers.length) {
            // Every configured rail authoritatively answers absence.
            return {
                status: 'NOT_FOUND',
                referenceId,
                allProvidersPolled: true,
            };
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
