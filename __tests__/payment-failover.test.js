// __tests__/payment-failover.test.js
// Tests for PaymentFailoverService — automatic provider failover with health tracking

const { PaymentFailoverService } = require('../src/services/paymentFailoverService');

function makeMockProvider(name, { fail = false, delay = 0 } = {}) {
    return {
        name,
        _fail: fail,
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
                const err = new Error(`${name} disbursement failed`);
                err.providerOutcome = 'DEFINITIVE_REJECTION';
                throw err;
            }
            return { referenceId: payload.referenceId, status: 'PENDING', amount: payload.amountGhs };
        },
        async getTransferStatus(referenceId) {
            this._calls.push({ method: 'getTransferStatus', referenceId });
            if (this._fail) throw new Error(`${name} status check failed`);
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

    test('skips unhealthy provider after threshold failures', async () => {
        const primary = makeMockProvider('moolre', { fail: true });
        const secondary = makeMockProvider('mtn');
        const svc = new PaymentFailoverService({ primary, secondary });

        for (let i = 0; i < 3; i++) {
            await svc.initiateTransfer({
                referenceId: `test-${i}`,
                amountGhs: 50,
                recipientPhone: '0244556677',
            }).catch(() => {});
        }

        // This test previously depended on Math.random(), making CI flaky.
        // Force an exact alternating probe/skip pattern so the routing policy
        // is exercised deterministically while keeping production behavior
        // unchanged.
        const randomSpy = jest.spyOn(Math, 'random');
        randomSpy
            .mockReturnValueOnce(0.25)
            .mockReturnValueOnce(0.75)
            .mockReturnValueOnce(0.25)
            .mockReturnValueOnce(0.75)
            .mockReturnValueOnce(0.25)
            .mockReturnValueOnce(0.75)
            .mockReturnValueOnce(0.25)
            .mockReturnValueOnce(0.75)
            .mockReturnValueOnce(0.25)
            .mockReturnValueOnce(0.75)
            .mockReturnValueOnce(0.25)
            .mockReturnValueOnce(0.75)
            .mockReturnValueOnce(0.25)
            .mockReturnValueOnce(0.75)
            .mockReturnValueOnce(0.25)
            .mockReturnValueOnce(0.75)
            .mockReturnValueOnce(0.25)
            .mockReturnValueOnce(0.75)
            .mockReturnValueOnce(0.25)
            .mockReturnValueOnce(0.75);

        let primaryProbed = 0;
        let secondaryUsed = 0;
        try {
            for (let i = 0; i < 20; i++) {
                primary._calls = [];
                secondary._calls = [];
                await svc.initiateTransfer({
                    referenceId: `probe-${i}`,
                    amountGhs: 10,
                    recipientPhone: '0244556677',
                });
                if (primary._calls.length > 0) primaryProbed++;
                if (secondary._calls.length > 0) secondaryUsed++;
            }
        } finally {
            randomSpy.mockRestore();
        }

        expect(primaryProbed).toBe(10);
        expect(secondaryUsed).toBe(20);
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
