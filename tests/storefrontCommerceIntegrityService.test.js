'use strict';

const {
  canonicalizeCheckoutIntent,
  fingerprintCheckoutIntent,
  normalizeIdempotencyKey,
} = require('../services/storefrontCommerceIntegrityService');

describe('storefrontCommerceIntegrityService', () => {
  test('normalizes an idempotency key and rejects oversized keys', () => {
    expect(normalizeIdempotencyKey('  checkout-123  ')).toBe('checkout-123');
    expect(normalizeIdempotencyKey('   ')).toBeNull();
    expect(() => normalizeIdempotencyKey('x'.repeat(129))).toThrow(/128/);
  });

  test('canonicalizes cart ordering without changing economic intent', () => {
    const a = canonicalizeCheckoutIntent({
      businessProfileId: 'business-1',
      customerId: 'customer-1',
      items: [
        { productId: 'p2', quantity: 2, notes: 'no onions' },
        { productId: 'p1', quantity: 1 },
      ],
      paymentMode: 'direct',
    });
    const b = canonicalizeCheckoutIntent({
      businessProfileId: 'business-1',
      customerId: 'customer-1',
      items: [
        { productId: 'p1', quantity: 1 },
        { productId: 'p2', quantity: 2, notes: 'no onions' },
      ],
      paymentMode: 'DIRECT',
    });

    expect(a).toEqual(b);
    expect(fingerprintCheckoutIntent(a)).toBe(fingerprintCheckoutIntent(b));
  });

  test('changes the fingerprint when economic intent changes', () => {
    const base = {
      businessProfileId: 'business-1',
      customerId: 'customer-1',
      items: [{ productId: 'p1', quantity: 1 }],
      paymentMode: 'DIRECT',
    };

    expect(fingerprintCheckoutIntent(base)).not.toBe(
      fingerprintCheckoutIntent({ ...base, items: [{ productId: 'p1', quantity: 2 }] }),
    );
    expect(fingerprintCheckoutIntent(base)).not.toBe(
      fingerprintCheckoutIntent({ ...base, paymentMode: 'ESCROW' }),
    );
  });
});
