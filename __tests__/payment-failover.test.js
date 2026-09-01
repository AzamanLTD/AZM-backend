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
            if (this._fail) throw new Error(`${name} disbursement failed`);
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
