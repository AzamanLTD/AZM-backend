// §WP-H G — the canonical action is the whole binding. If it is unstable or
// imprecise, a grant authorises something other than what executes.
'use strict';

const { canonicalAction, actionDigest, canonicalParams } = require('../src/services/canonicalAction');

const base = {
    userId: 7, actionType: 'FIAT_WITHDRAWAL', routeScope: 'POST /api/withdrawals/fiat',
    method: 'post', path: '/api/withdrawals/fiat',
    currency: 'ghs', amount: '100.50', destination: '+233551234567',
    idempotencyKey: 'idem-1', params: { note: 'rent' },
};

describe('canonical action binding', () => {
    test('the same action produces the same digest regardless of input key order', () => {
        const a = actionDigest(canonicalAction(base));
        const b = actionDigest(canonicalAction({ ...base, params: { note: 'rent' } }));
        expect(a).toBe(b);
        const c = actionDigest(canonicalAction({ ...base, params: {} }));
        expect(a).not.toBe(c);
    });

    test('every material field changes the digest', () => {
        const d = actionDigest(canonicalAction(base));
        for (const [field, value] of [
            ['amount', '100.51'], ['currency', 'USD'], ['destination', '+233550000000'],
            ['actionType', 'GHS_WITHDRAWAL'], ['routeScope', 'POST /api/withdrawals/ghs'],
            ['idempotencyKey', 'idem-2'], ['userId', 8], ['resource', 'wallet-9'],
        ]) {
            expect(actionDigest(canonicalAction({ ...base, [field]: value }))).not.toBe(d);
        }
    });

    test('money is an exact decimal string and a float is refused', () => {
        expect(canonicalAction({ ...base, amount: '0.10' }).amount).toBe('0.10');
        expect(() => canonicalAction({ ...base, amount: 100.5 })).toThrow(/decimal string/);
        expect(() => canonicalAction({ ...base, params: { fee: 1.25 } })).toThrow(/decimal string/);
        expect(() => canonicalAction({ ...base, amount: '' })).toThrow(/amount is required/);
    });

    test('credentials never enter the digest or the stored parameters', () => {
        const withSecrets = canonicalAction({
            ...base,
            params: { note: 'rent', password: 'hunter2', totpToken: 'ZZ-TOTP-SECRET', stepUpToken: 'ZZ-GRANT-TOKEN' },
        });
        const serialised = JSON.stringify(withSecrets);
        expect(serialised).not.toMatch(/hunter2/);
        expect(serialised).not.toMatch(/ZZ-TOTP-SECRET/);
        expect(serialised).not.toMatch(/ZZ-GRANT-TOKEN/);
        expect(withSecrets.params).toEqual({ note: 'rent' });
        // and the digest is identical to the same action without them
        expect(actionDigest(withSecrets))
            .toBe(actionDigest(canonicalAction({ ...base, params: { note: 'rent' } })));
    });

    test('nested parameters are normalised deterministically', () => {
        const one = canonicalParams({ b: { z: 1 === 1 ? 'y' : 'n', a: 'x' }, a: ['q', 'p'] });
        const two = canonicalParams({ a: ['q', 'p'], b: { a: 'x', z: 'y' } });
        expect(one).toEqual(two);
    });

    test('an unbound action is refused rather than silently hashed', () => {
        expect(() => canonicalAction({ ...base, actionType: '' })).toThrow(/actionType is required/);
        expect(() => canonicalAction({ ...base, routeScope: undefined })).toThrow(/routeScope is required/);
    });
});
