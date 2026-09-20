// __tests__/payment-failover.test.js
// Tests for PaymentFailoverService — automatic provider failover with health tracking

const { PaymentFailoverService } = require('../src/services/paymentFailoverService');

function makeMockProvider(name, { fail = false, delay = 0, outcome = 'DEFINITIVE_REJECTION' } = {}) {
    return {
        name,
        _fail: fail,
        _failOutcome: outcome,
        _delay: delay,
        _calls: [],
        newReferenceId() {
            return `ref-${name}-${Date.now()}`;
        },
        async initiateTransfer(payload) {
            this._calls.push({ method: 'initiateTransfer', payload });
            if (this._delay) await new Promise(r => setTimeout(r, this._delay));
            if (this._fail) {
                // r15 R15-C: mock provider failures carry a typed outcome.
                // DEFAULT is DEFINITIVE_REJECTION (a request-level refusal —
                // safe to fail over, and since the r15 health fix, NOT
                // counted against provider health). Provider-level outages
                // are modeled with NOT_DISPATCHED (nothing reached the
                // provider), which both fails over safely AND degrades
                // health — mirroring real transport failures.
                const err = new Error(`${name} disbursement failed`);
                err.providerOutcome = this._failOutcome;
                throw err;
            }
            return { referenceId: payload.referenceId, status: 'PENDING', amount: payload.amountGhs };
        },
        _statusFail: false,
        _statusOutcome: 'NOT_DISPATCHED',
        async getTransferStatus(referenceId) {
            this._calls.push({ method: 'getTransferStatus', referenceId });
            if (this._fail || this._statusFail) {
                const err = new Error(`${name} status check failed`);
                err.providerOutcome = this._statusOutcome;
                throw err;
            }
            return { status: 'PENDING', referenceId };
        },
    };
}

describe('PaymentFailoverService', () => {
    test('uses primary provider when healthy', async () => {
        const primary = makeMockProvider('moolre');
        const secondary = makeMockProvider('mtn');
        const svc = new PaymentFailoverService({ primary, secondary });

        const result = await svc.initiateTransfer({
            referenceId: 'test-1',
            amountGhs: 100,
            recipientPhone: '0244556677',
        });

        expect(result.status).toBe('PENDING');
        expect(result._provider).toBe('moolre');
        expect(primary._calls).toHaveLength(1);
        expect(secondary._calls).toHaveLength(0);
    });

    test('falls back to secondary when primary fails', async () => {
        const primary = makeMockProvider('moolre', { fail: true });
        const secondary = makeMockProvider('mtn');
        const svc = new PaymentFailoverService({ primary, secondary });

        const result = await svc.initiateTransfer({
            referenceId: 'test-2',
            amountGhs: 200,
            recipientPhone: '0244556677',
        });

        expect(result.status).toBe('PENDING');
        expect(result._provider).toBe('mtn');
        expect(primary._calls).toHaveLength(1);
        expect(secondary._calls).toHaveLength(1);
    });

    test('throws when all providers fail', async () => {
        const primary = makeMockProvider('moolre', { fail: true });
        const secondary = makeMockProvider('mtn', { fail: true });
        const svc = new PaymentFailoverService({ primary, secondary });

        await expect(svc.initiateTransfer({
            referenceId: 'test-3',
            amountGhs: 300,
            recipientPhone: '0244556677',
        })).rejects.toThrow('All payment providers failed');

        const err = await svc.initiateTransfer({
            referenceId: 'test-4',
            amountGhs: 400,
            recipientPhone: '0244556677',
        }).catch(e => e);

        expect(err.providerErrors).toHaveLength(2);
        expect(err.triedProviders).toContain('moolre');
        expect(err.triedProviders).toContain('mtn');
    });

    // ── r15 R15-C: failover is gated on PROVABLY SAFE outcomes ──────────────
    function makeOutcomeProvider(name, outcome) {
        return {
            name,
            _calls: [],
            newReferenceId: () => `ref-${name}`,
            async initiateTransfer(payload) {
                this._calls.push(payload);
                const err = new Error(`${name} failed (${outcome})`);
                err.providerOutcome = outcome;
                throw err;
            },
            async getTransferStatus() { return { status: 'PENDING' }; },
        };
    }

    test('R15-C: UNKNOWN_OUTCOME on the primary NEVER re-instructs the secondary (no double disbursement)', async () => {
        const primary   = makeOutcomeProvider('moolre', 'UNKNOWN_OUTCOME');
        const secondary = makeOutcomeProvider('mtn', null);
        secondary.initiateTransfer = async function (payload) { this._calls.push(payload); return { status: 'PENDING', _ok: true }; };
        const svc = new PaymentFailoverService({ primary, secondary });

        const err = await svc.initiateTransfer({
            referenceId: 'r15c-1', amountGhs: 100, recipientPhone: '0244556677',
        }).catch(e => e);

        expect(err).toBeInstanceOf(Error);
        expect(err.providerOutcome).toBe('UNKNOWN_OUTCOME');
        expect(err.message).toMatch(/refusing failover/);
        // THE invariant: the secondary provider was never instructed.
        expect(secondary._calls).toHaveLength(0);
        expect(primary._calls).toHaveLength(1);
    });

    test('R15-C: DUPLICATE_REFERENCE blocks the chain — the reference is already held by the provider', async () => {
        const primary   = makeOutcomeProvider('moolre', 'DUPLICATE_REFERENCE');
        const secondary = makeOutcomeProvider('mtn', null);
        secondary.initiateTransfer = async function (payload) { this._calls.push(payload); return { status: 'PENDING' }; };
        const svc = new PaymentFailoverService({ primary, secondary });

        const err = await svc.initiateTransfer({
            referenceId: 'r15c-2', amountGhs: 100, recipientPhone: '0244556677',
        }).catch(e => e);

        expect(err.providerOutcome).toBe('DUPLICATE_REFERENCE');
        expect(secondary._calls).toHaveLength(0);
    });

    test('R15-C: an UNCLASSIFIED provider error is conservatively treated as UNKNOWN — no failover', async () => {
        const primary = {
            name: 'legacy',
            _calls: [],
            newReferenceId: () => 'x',
            async initiateTransfer(payload) {
                this._calls.push(payload);
                throw new Error('boom'); // no providerOutcome tag at all
            },
            async getTransferStatus() { return { status: 'PENDING' }; },
        };
        const secondary = makeOutcomeProvider('mtn', null);
        secondary.initiateTransfer = async function (payload) { this._calls.push(payload); return { status: 'PENDING' }; };
        const svc = new PaymentFailoverService({ primary, secondary });

        const err = await svc.initiateTransfer({
            referenceId: 'r15c-3', amountGhs: 100, recipientPhone: '0244556677',
        }).catch(e => e);

        expect(err.providerOutcome).toBe('UNKNOWN_OUTCOME');
        expect(secondary._calls).toHaveLength(0);
    });

    test('R15-C: all providers PROVABLY refuse → aggregate is safely classifiable DEFINITIVE_REJECTION', async () => {
        const primary   = makeOutcomeProvider('moolre', 'DEFINITIVE_REJECTION');
        const secondary = makeOutcomeProvider('mtn', 'NOT_DISPATCHED');
        const svc = new PaymentFailoverService({ primary, secondary });

        const err = await svc.initiateTransfer({
            referenceId: 'r15c-6', amountGhs: 100, recipientPhone: '0244556677',
        }).catch(e => e);

        expect(err.message).toMatch(/All payment providers failed/);
        expect(err.providerOutcome).toBe('DEFINITIVE_REJECTION');
    });

    // ── r15 follow-up: non-economic recovery probes ───────────────────────
    function countStatusCalls(provider) {
        return provider._calls.filter(c => c.method === 'getTransferStatus').length;
    }
    function countInitiateCalls(provider) {
        return provider._calls.filter(c => c.method === 'initiateTransfer').length;
    }

    test('r15 follow-up: an unhealthy provider NEVER receives customer payout traffic; recovery is a rate-limited non-economic status probe', async () => {
        const primary   = makeMockProvider('moolre', { fail: true, outcome: 'NOT_DISPATCHED' });
        const secondary = makeMockProvider('mtn');
        const svc = new PaymentFailoverService({ primary, secondary }); // default 60s probe interval

        // Degrade: 3 NOT_DISPATCHED failures → unhealthy.
        for (let i = 0; i < 3; i++) {
            await svc.initiateTransfer({ referenceId: `d-${i}`, amountGhs: 10, recipientPhone: '0244556677' }).catch(() => {});
        }
        expect(await svc._isHealthy('moolre')).toBe(false);

        // The rail is still down: the status probe also fails (transport).
        primary._statusFail = true;

        const initBefore = countInitiateCalls(primary);
        const statusBefore = countStatusCalls(primary);
        secondary._calls = [];
        for (let i = 0; i < 20; i++) {
            await svc.initiateTransfer({ referenceId: `q-${i}`, amountGhs: 10, recipientPhone: '0244556677' }).catch(() => {});
        }

        // THE invariant: zero customer payout traffic to the degraded rail.
        expect(countInitiateCalls(primary)).toBe(initBefore);
        // The ONLY provider I/O it received: at most ONE read-only status
        // probe (rate-limited — 20 transfers inside the interval window).
        expect(countStatusCalls(primary) - statusBefore).toBeLessThanOrEqual(1);
        // The healthy secondary handled everything.
        expect(secondary._calls.filter(c => c.method === 'initiateTransfer').length).toBe(20);
    });

    test('r15 follow-up: a successful non-economic probe re-admits the provider to normal routing', async () => {
        const primary   = makeMockProvider('moolre', { fail: true, outcome: 'NOT_DISPATCHED' });
        const secondary = makeMockProvider('mtn');
        const svc = new PaymentFailoverService({ primary, secondary, probeMinIntervalMs: 0 });

        for (let i = 0; i < 3; i++) {
            await svc.initiateTransfer({ referenceId: `r-${i}`, amountGhs: 10, recipientPhone: '0244556677' }).catch(() => {});
        }
        expect(await svc._isHealthy('moolre')).toBe(false);

        // The rail recovers: the payout AND the status probe both work now.
        primary._fail = false;
        primary._statusFail = false;

        // First transfer after recovery: the probe succeeds → the provider is
        // re-admitted → THIS transfer routes to it again (it is priority 1).
        primary._calls = [];
        const result = await svc.initiateTransfer({ referenceId: `recovered`, amountGhs: 10, recipientPhone: '0244556677' });
        expect(result._provider).toBe('moolre');
        expect(countInitiateCalls(primary)).toBe(1);
        expect(countStatusCalls(primary)).toBe(1); // the non-economic probe
    });

    test('r15 follow-up: a definitive rejection answering the probe counts as recovery (the rail is alive)', async () => {
        const primary   = makeMockProvider('moolre', { fail: true, outcome: 'NOT_DISPATCHED' });
        const secondary = makeMockProvider('mtn');
        const svc = new PaymentFailoverService({ primary, secondary, probeMinIntervalMs: 0 });

        for (let i = 0; i < 3; i++) {
            await svc.initiateTransfer({ referenceId: `dr-${i}`, amountGhs: 10, recipientPhone: '0244556677' }).catch(() => {});
        }
        expect(await svc._isHealthy('moolre')).toBe(false);

        // Probe answers "unknown reference" — a DEFINITIVE_REJECTION envelope.
        // That is an authoritative answer from a live rail → recovery.
        primary._statusFail = true;
        primary._statusOutcome = 'DEFINITIVE_REJECTION';
        primary._fail = false; // and payouts work again

        primary._calls = [];
        const result = await svc.initiateTransfer({ referenceId: `dr-ok`, amountGhs: 10, recipientPhone: '0244556677' });
        expect(result._provider).toBe('moolre');
        expect(await svc._isHealthy('moolre')).toBe(true);
    });

    test('r15 follow-up: an AMBIGUOUSLY-degraded provider is probed non-economically and never with live money', async () => {
        const primary   = makeMockProvider('moolre', { fail: true, outcome: 'UNKNOWN_OUTCOME' });
        const secondary = makeMockProvider('mtn');
        const svc = new PaymentFailoverService({ primary, secondary });

        for (let i = 0; i < 3; i++) {
            await svc.initiateTransfer({ referenceId: `amb-${i}`, amountGhs: 10, recipientPhone: '0244556677' }).catch(() => {});
        }
        expect(await svc._isHealthy('moolre')).toBe(false);
        expect((await svc._getHealthKey('moolre')).lastAmbiguousFailureAt).toBeTruthy();

        // Still degraded: probe (status lookup) times out → stays unhealthy.
        primary._statusFail = true;
        primary._statusOutcome = 'UNKNOWN_OUTCOME';

        const initBefore = countInitiateCalls(primary);
        secondary._calls = [];
        for (let i = 0; i < 10; i++) {
            await svc.initiateTransfer({ referenceId: `amb-q-${i}`, amountGhs: 10, recipientPhone: '0244556677' }).catch(() => {});
        }
        expect(countInitiateCalls(primary)).toBe(initBefore); // never live money
        expect(secondary._calls.filter(c => c.method === 'initiateTransfer').length).toBe(10);
        // The ambiguity stamp stays visible for operators.
        expect((await svc._getHealthKey('moolre')).lastAmbiguousFailureAt).toBeTruthy();
    });

    // ── r15 follow-up: provider-capacity vs request-level rejection split ──
    test('r15 follow-up: PROVIDER_CAPACITY rejections degrade health — request-level rejections never do', async () => {
        const capacity = {
            name: 'moolre', _calls: [],
            newReferenceId: () => 'ref-cap',
            async initiateTransfer(payload) {
                this._calls.push({ method: 'initiateTransfer', payload });
                const err = new Error('Insufficient float');
                err.providerOutcome = 'DEFINITIVE_REJECTION';
                err.providerRejectionClass = 'PROVIDER_CAPACITY';
                throw err;
            },
            async getTransferStatus(referenceId) { return { status: 'PENDING', referenceId }; },
        };
        const requestLevel = {
            name: 'moolre', _calls: [],
            newReferenceId: () => 'ref-req',
            async initiateTransfer(payload) {
                this._calls.push({ method: 'initiateTransfer', payload });
                const err = new Error('Invalid beneficiary number');
                err.providerOutcome = 'DEFINITIVE_REJECTION';
                err.providerRejectionClass = 'REQUEST_LEVEL';
                throw err;
            },
            async getTransferStatus(referenceId) { return { status: 'PENDING', referenceId }; },
        };
        const secondary = makeMockProvider('mtn');

        const svcCap = new PaymentFailoverService({ primary: capacity, secondary });
        for (let i = 0; i < 3; i++) {
            await svcCap.initiateTransfer({ referenceId: `cap-${i}`, amountGhs: 10, recipientPhone: '0244556677' }).catch(() => {});
        }
        // The provider itself cannot serve (insufficient float) → unhealthy.
        expect(await svcCap._isHealthy('moolre')).toBe(false);

        const svcReq = new PaymentFailoverService({ primary: requestLevel, secondary });
        for (let i = 0; i < 5; i++) {
            await svcReq.initiateTransfer({ referenceId: `req-${i}`, amountGhs: 10, recipientPhone: '0244556677' }).catch(() => {});
        }
        // Customer-level rejections → the provider is answering and healthy.
        expect(await svcReq._isHealthy('moolre')).toBe(true);
    });

    test('r15 follow-up: PROVIDER_CAPACITY rejections remain failover-ELIGIBLE (the transfer was provably not accepted)', async () => {
        const primary = {
            name: 'moolre', _calls: [],
            newReferenceId: () => 'ref-cap2',
            async initiateTransfer(payload) {
                this._calls.push({ method: 'initiateTransfer', payload });
                const err = new Error('Insufficient float');
                err.providerOutcome = 'DEFINITIVE_REJECTION';
                err.providerRejectionClass = 'PROVIDER_CAPACITY';
                throw err;
            },
            async getTransferStatus(referenceId) { return { status: 'PENDING', referenceId }; },
        };
        const secondary = makeMockProvider('mtn');
        const svc = new PaymentFailoverService({ primary, secondary });

        const result = await svc.initiateTransfer({ referenceId: 'cap-fo', amountGhs: 10, recipientPhone: '0244556677' });
        expect(result._provider).toBe('mtn'); // failed over safely
    });

    test('r15 follow-up: customer-level DEFINITIVE_REJECTIONs never mark a healthy provider unhealthy', async () => {
        // A provider answering authoritatively (bad beneficiary number,
        // wrong rail, insufficient float) is REACHABLE and HEALTHY — three
        // rejected withdrawals must not reroute other customers' money.
        const primary = makeMockProvider('moolre', { fail: true }); // DEFINITIVE_REJECTION (default)
        const secondary = makeMockProvider('mtn');
        const svc = new PaymentFailoverService({ primary, secondary });

        for (let i = 0; i < 5; i++) {
            await svc.initiateTransfer({
                referenceId: `rej-${i}`,
                amountGhs: 10,
                recipientPhone: '0244556677',
            }).catch(() => {}); // all-providers-failed aggregate is fine
        }

        // Health never degraded: provider is still healthy and still FIRST in
        // the chain — every subsequent attempt tries it before the secondary.
        expect(await svc._isHealthy('moolre')).toBe(true);
        primary._calls = [];
        await svc.initiateTransfer({ referenceId: 'after', amountGhs: 10, recipientPhone: '0244556677' }).catch(() => {});
        expect(primary._calls.length).toBe(1); // still tried first — not skipped as unhealthy
    });

    test('r15 follow-up: UNKNOWN_OUTCOME failures DO degrade provider health (ambiguous provider behavior is degradation)', async () => {
        const primary = makeMockProvider('moolre', { fail: true, outcome: 'UNKNOWN_OUTCOME' });
        const secondary = makeMockProvider('mtn');
        const svc = new PaymentFailoverService({ primary, secondary });

        for (let i = 0; i < 3; i++) {
            await svc.initiateTransfer({
                referenceId: `unk-${i}`,
                amountGhs: 10,
                recipientPhone: '0244556677',
            }).catch(() => {}); // blocking outcome — chain stops at primary
        }

        // 3 ambiguous outcomes → provider marked unhealthy (conservative).
        expect(await svc._isHealthy('moolre')).toBe(false);
    });

    // ── r15 follow-up: probe safety ──────────────────────────────────────────
    test('r15 follow-up: a recorded success clears the ambiguity stamp (authoritative answer → probes safe again)', async () => {
        const primary = {
            name: 'moolre',
            _calls: [],
            newReferenceId: () => 'ref-moolre',
            async initiateTransfer(payload) {
                this._calls.push(payload);
                if (this._calls.length <= 3) {
                    const err = new Error('ambiguous');
                    err.providerOutcome = 'UNKNOWN_OUTCOME';
                    throw err;
                }
                return { status: 'PENDING', referenceId: payload.referenceId };
            },
            async getTransferStatus() { return { status: 'PENDING' }; },
        };
        const secondary = makeMockProvider('mtn');
        const svc = new PaymentFailoverService({ primary, secondary });

        for (let i = 0; i < 3; i++) {
            await svc.initiateTransfer({
                referenceId: `cl-${i}`, amountGhs: 10, recipientPhone: '0244556677',
            }).catch(() => {});
        }
        expect((await svc._getHealthKey('moolre')).lastAmbiguousFailureAt).toBeTruthy();

        // A success on the primary clears both the failure count and the
        // ambiguity stamp — the rail demonstrably answers authoritatively
        // again, so probe-with-live-money is back to being safe.
        await svc._recordSuccess('moolre');
        expect((await svc._getHealthKey('moolre')).lastAmbiguousFailureAt).toBeNull();
        expect(await svc._isHealthy('moolre')).toBe(true);
    });

    // ── r15 follow-up: Redis health-counter atomicity ──────────────────────
    function makeMockRedis() {
        const hashes = new Map();
        const execBatches = [];
        const forbidden = () => { throw new Error('non-atomic GET/SET must never be used for health counters'); };
        return {
            hashes, execBatches,
            get: forbidden, set: forbidden,
            async hgetall(k) { return { ...(hashes.get(k) || {}) }; },
            multi() {
                const cmds = [];
                const chain = {
                    hincrby: (k, f, n) => { cmds.push(['hincrby', k, f, n]); return chain; },
                    hset:    (k, f, v) => { cmds.push(['hset', k, f, v]);    return chain; },
                    hdel:    (k, f)    => { cmds.push(['hdel', k, f]);       return chain; },
                    expire:  (k, t)    => { cmds.push(['expire', k, t]);    return chain; },
                    exec: async () => {
                        // Applied with NO await inside — a serial history,
                        // exactly as Redis serializes MULTI/EXEC batches.
                        execBatches.push(cmds.slice());
                        for (const [c, k, f, v] of cmds) {
                            const h = hashes.get(k) || {};
                            if (c === 'hincrby') h[f] = String((Number(h[f] || 0)) + v);
                            else if (c === 'hset') h[f] = String(v);
                            else if (c === 'hdel') delete h[f];
                            else if (c === 'expire') { /* TTL tracked elsewhere */ }
                            hashes.set(k, h);
                        }
                        return cmds.map(() => [null, 1]);
                    },
                };
                return chain;
            },
        };
    }

    test('r15 follow-up: Redis health mutations are atomic pipelines — never a read-modify-write GET/SET', async () => {
        const redis = makeMockRedis();
        const primary = makeMockProvider('moolre', { fail: true, outcome: 'NOT_DISPATCHED' });
        const svc = new PaymentFailoverService({ primary, secondary: makeMockProvider('mtn'), redis });

        await svc.initiateTransfer({ referenceId: 'atomic-1', amountGhs: 10, recipientPhone: '0244556677' });

        // The GET/SET spies threw on any use — reaching here proves the
        // whole path went through MULTI/EXEC batches.
        expect(redis.execBatches.length).toBeGreaterThanOrEqual(1);
        const everyBatch = redis.execBatches.flat();
        expect(everyBatch.some(c => c[0] === 'hincrby' && c[2] === 'failures')).toBe(true);
        expect(everyBatch.some(c => c[0] === 'hset' && c[2] === 'lastError')).toBe(true);
        expect(everyBatch.every(c => ['hincrby', 'hset', 'hdel', 'expire'].includes(c[0]))).toBe(true);
        expect(Number(redis.hashes.get('payment:health:moolre').failures)).toBe(1);
    });

    test('r15 follow-up: concurrent failure and success records lose no updates (serializable batches)', async () => {
        const redis = makeMockRedis();
        const primary = makeMockProvider('moolre');
        const svc = new PaymentFailoverService({ primary, secondary: makeMockProvider('mtn'), redis });

        // Fire 5 failures and 5 successes at once. With the old GET→SET
        // read-modify-write this interleaving lost updates wholesale; with
        // serialized MULTI/EXEC batches EVERY increment survives — the final
        // counters are exactly (successes=5, failures=0): each success resets
        // failures, and the last batch in any serial order ends failures=0.
        await Promise.all([
            ...Array.from({ length: 5 }, () =>
                svc._recordFailure('moolre', (() => { const e = new Error('transport'); e.providerOutcome = 'NOT_DISPATCHED'; return e; })())),
            ...Array.from({ length: 5 }, () => svc._recordSuccess('moolre')),
        ]);

        const health = await svc._getHealthKey('moolre');
        expect(health.successes).toBe(5);
        expect(health.failures).toBe(0); // every success batch resets failures — no lost reset survives
        expect(redis.execBatches.length).toBe(10); // all ten batches landed
    });

    test('r15 follow-up: Redis path stamps ambiguous failures and success clears them', async () => {
        const redis = makeMockRedis();
        const primary = makeMockProvider('moolre', { fail: true, outcome: 'UNKNOWN_OUTCOME' });
        const svc = new PaymentFailoverService({ primary, secondary: makeMockProvider('mtn'), redis });

        await svc.initiateTransfer({ referenceId: 'amb-redis-1', amountGhs: 10, recipientPhone: '0244556677' }).catch(() => {});
        expect((await svc._getHealthKey('moolre')).lastAmbiguousFailureAt).toBeTruthy();

        await svc._recordSuccess('moolre');
        expect((await svc._getHealthKey('moolre')).lastAmbiguousFailureAt).toBeNull();
    });

    test('health resets after success', async () => {
        const primary = makeMockProvider('moolre');
        const svc = new PaymentFailoverService({
            primary,
            secondary: makeMockProvider('mtn'),
        });

        await svc.initiateTransfer({
            referenceId: 'test-success',
            amountGhs: 100,
            recipientPhone: '0244556677',
        });

        const health = await svc.getHealthStatus();
        expect(health.moolre.healthy).toBe(true);
        expect(health.moolre.successes).toBe(1);
        expect(health.moolre.failures).toBe(0);
    });

    test('newReferenceId delegates to first provider', () => {
        const primary = makeMockProvider('moolre');
        const secondary = makeMockProvider('mtn');
        const svc = new PaymentFailoverService({ primary, secondary });

        const ref = svc.newReferenceId();
        expect(ref).toContain('moolre');
    });

    test('getTransferStatus uses provider hint first', async () => {
        const primary = makeMockProvider('moolre');
        const secondary = makeMockProvider('mtn');
        const svc = new PaymentFailoverService({ primary, secondary });

        await svc.getTransferStatus('ref-123', 'mtn');

        expect(primary._calls).toHaveLength(0);
        expect(secondary._calls).toHaveLength(1);
    });

    test('getTransferStatus polls all providers when hint fails', async () => {
        const primary = makeMockProvider('moolre', { fail: true });
        const secondary = makeMockProvider('mtn');
        const svc = new PaymentFailoverService({ primary, secondary });

        await svc.getTransferStatus('ref-456', 'moolre');
        expect(secondary._calls).toHaveLength(1);
    });

    test('getHealthStatus returns health for all providers', async () => {
        const primary = makeMockProvider('moolre');
        const secondary = makeMockProvider('mtn');
        const svc = new PaymentFailoverService({ primary, secondary });

        await svc.initiateTransfer({
            referenceId: 'test-health',
            amountGhs: 100,
            recipientPhone: '0244556677',
        });

        const health = await svc.getHealthStatus();
        expect(health).toHaveProperty('moolre');
        expect(health).toHaveProperty('mtn');
        expect(health.moolre.healthy).toBe(true);
        expect(health.moolre.successes).toBe(1);
    });

    test('accepts providers array format', async () => {
        const primary = makeMockProvider('moolre');
        const secondary = makeMockProvider('mtn');
        const svc = new PaymentFailoverService({
            providers: [
                { name: 'mtn', instance: secondary, priority: 1 },
                { name: 'moolre', instance: primary, priority: 2 },
            ]
        });

        const result = await svc.initiateTransfer({
            referenceId: 'test-priority',
            amountGhs: 100,
            recipientPhone: '0244556677',
        });

        expect(result._provider).toBe('mtn');
    });

    test('throws if no providers provided', () => {
        expect(() => new PaymentFailoverService({})).toThrow('at least one provider');
    });
});
