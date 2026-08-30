'use strict';

const {
  normalizeIdempotencyKey,
  canonicalizeCheckoutIntent,
  fingerprintCheckoutIntent,
} = require('./storefrontCommerceIntegrityService');

describe('storefrontCommerceIntegrityService', () => {
  test('normalizes a valid idempotency key without changing its identity', () => {
    expect(normalizeIdempotencyKey('  Checkout-ABC_123  ')).toBe('Checkout-ABC_123');
  });

  test('rejects an empty or oversized idempotency key', () => {
    expect(() => normalizeIdempotencyKey('   ')).toThrow(/must not be empty/i);
    expect(() => normalizeIdempotencyKey('x'.repeat(129))).toThrow();
  });

  test('canonicalizes equivalent item orderings identically', () => {
    const a = canonicalizeCheckoutIntent({
      businessProfileId: 'biz-1',
      customerId: 'user-1',
      paymentMode: 'ESCROW',
      customerNotes: ' deliver quickly ',
      items: [
        { productId: 'p2', quantity: 1, variantId: 'v2', modifierSelections: ['b', 'a'] },
        { productId: 'p1', quantity: 2 },
      ],
    });
    const b = canonicalizeCheckoutIntent({
      businessProfileId: 'biz-1',
      customerId: 'user-1',
      paymentMode: 'ESCROW',
      customerNotes: 'deliver quickly',
      items: [
        { productId: 'p1', quantity: 2 },
        { productId: 'p2', quantity: 1, variantId: 'v2', modifierSelections: ['a', 'b'] },
      ],
    });
    expect(a).toEqual(b);
    expect(fingerprintCheckoutIntent(a)).toBe(fingerprintCheckoutIntent(b));
  });

  test('variant or modifier changes alter the economic fingerprint', () => {
    const base = {
      businessProfileId: 'biz-1',
      customerId: 'user-1',
      paymentMode: 'DIRECT',
      items: [{ productId: 'p1', quantity: 1, variantId: 'small', modifierSelections: ['milk'] }],
    };
    expect(fingerprintCheckoutIntent(base)).not.toBe(
      fingerprintCheckoutIntent({ ...base, items: [{ ...base.items[0], variantId: 'large' }] }),
    );
    expect(fingerprintCheckoutIntent(base)).not.toBe(
      fingerprintCheckoutIntent({ ...base, items: [{ ...base.items[0], modifierSelections: ['oat'] }] }),
    );
  });

  test('changes to economic intent change the fingerprint', () => {
    const base = {
      businessProfileId: 'biz-1',
      customerId: 'user-1',
      paymentMode: 'DIRECT',
      items: [{ productId: 'p1', quantity: 1 }],
    };
    expect(fingerprintCheckoutIntent(base)).not.toBe(
      fingerprintCheckoutIntent({ ...base, items: [{ productId: 'p1', quantity: 2 }] }),
    );
    expect(fingerprintCheckoutIntent(base)).not.toBe(
      fingerprintCheckoutIntent({ ...base, paymentMode: 'ESCROW' }),
    );
  });

  test('does not let arbitrary object key ordering change the fingerprint', () => {
    const a = fingerprintCheckoutIntent({
      businessProfileId: 'biz-1',
      customerId: 'user-1',
      paymentMode: 'DIRECT',
      items: [{ productId: 'p1', quantity: 1 }],
    });
    const b = fingerprintCheckoutIntent({
      items: [{ quantity: 1, productId: 'p1' }],
      paymentMode: 'DIRECT',
      customerId: 'user-1',
      businessProfileId: 'biz-1',
    });
    expect(a).toBe(b);
  });
});
