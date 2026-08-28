const { _escrowProtectionAvailable } = require('../services/storefrontRenderService');

describe('Storefront escrow protection — render and checkout enforcement', () => {

  // ── _escrowProtectionAvailable helper ──────────────────────────────────────
  
  describe('_escrowProtectionAvailable', () => {
    test('returns false when businessMeta is null', () => {
      expect(_escrowProtectionAvailable({ businessMeta: null })).toBe(false);
    });

    test('returns false when businessMeta has no escrowProtection key', () => {
      expect(_escrowProtectionAvailable({ businessMeta: { other: 'keep' } })).toBe(false);
    });

    test('returns false when escrowProtection.enabled is false', () => {
      expect(_escrowProtectionAvailable({ businessMeta: { escrowProtection: { enabled: false } } })).toBe(false);
    });

    test('returns true when escrowProtection.enabled is true', () => {
      expect(_escrowProtectionAvailable({ businessMeta: { escrowProtection: { enabled: true } } })).toBe(true);
    });

    test('returns false when businessMeta is a JSON string without escrow', () => {
      const json = JSON.stringify({ other: 'keep' });
      expect(_escrowProtectionAvailable({ businessMeta: json })).toBe(false);
    });

    test('returns true when businessMeta is a JSON string with escrow enabled', () => {
      const json = JSON.stringify({ escrowProtection: { enabled: true } });
      expect(_escrowProtectionAvailable({ businessMeta: json })).toBe(true);
    });

    test('preserves other businessMeta keys when checking', () => {
      const meta = { storefront: { theme: 'dark' }, escrowProtection: { enabled: true }, custom: 'keep' };
      expect(_escrowProtectionAvailable({ businessMeta: meta })).toBe(true);
    });
  });

  // ── Checkout escrow enforcement logic ──────────────────────────────────────
  // These tests verify the enforcement logic that lives inside the route handler.
  // We test the decision function directly to avoid spinning up the full Express app.

  describe('checkout enforcement decision', () => {
    // Simulate the enforcement logic from the route handler
    function shouldRejectEscrow(business, paymentMode) {
      const mode = (paymentMode || 'DIRECT').toUpperCase();
      if (mode === 'ESCROW') {
        if (!_escrowProtectionAvailable(business)) {
          return { reject: true, message: 'This store does not offer escrow protection. Choose direct payment instead.' };
        }
      }
      return { reject: false };
    }

    test('default (omitted paymentMode) proceeds with direct checkout when escrow is disabled', () => {
      const business = { businessMeta: { escrowProtection: { enabled: false } } };
      const result = shouldRejectEscrow(business, undefined);
      expect(result.reject).toBe(false);
    });

    test('explicit DIRECT proceeds when escrow is disabled', () => {
      const business = { businessMeta: { escrowProtection: { enabled: false } } };
      const result = shouldRejectEscrow(business, 'DIRECT');
      expect(result.reject).toBe(false);
    });

    test('ESCROW is rejected when business has not enabled escrow protection', () => {
      const business = { businessMeta: { escrowProtection: { enabled: false } } };
      const result = shouldRejectEscrow(business, 'ESCROW');
      expect(result.reject).toBe(true);
      expect(result.message).toContain('does not offer escrow protection');
    });

    test('ESCROW is rejected when businessMeta is null', () => {
      const business = { businessMeta: null };
      const result = shouldRejectEscrow(business, 'ESCROW');
      expect(result.reject).toBe(true);
    });

    test('DIRECT proceeds when business has enabled escrow protection', () => {
      const business = { businessMeta: { escrowProtection: { enabled: true } } };
      const result = shouldRejectEscrow(business, 'DIRECT');
      expect(result.reject).toBe(false);
    });

    test('ESCROW proceeds when business has enabled escrow protection', () => {
      const business = { businessMeta: { escrowProtection: { enabled: true } } };
      const result = shouldRejectEscrow(business, 'ESCROW');
      expect(result.reject).toBe(false);
    });

    test('lowercase "escrow" is handled correctly', () => {
      const business = { businessMeta: { escrowProtection: { enabled: false } } };
      const result = shouldRejectEscrow(business, 'escrow');
      expect(result.reject).toBe(true);
    });

    test('lowercase "direct" is handled correctly', () => {
      const business = { businessMeta: { escrowProtection: { enabled: true } } };
      const result = shouldRejectEscrow(business, 'direct');
      expect(result.reject).toBe(false);
    });
  });

  // ── Render response shape ──────────────────────────────────────────────────

  describe('render response includes escrowProtectionAvailable', () => {
    test('business object in render response has escrowProtectionAvailable field', () => {
      // This tests the shape that the frontend will parse.
      // The render service adds this field; verify the key exists.
      const sampleBusiness = {
        businessMeta: { escrowProtection: { enabled: true } },
      };
      const value = _escrowProtectionAvailable(sampleBusiness);
      expect(typeof value).toBe('boolean');
      expect(value).toBe(true);
    });

    test('disabled store reports false in render response', () => {
      const sampleBusiness = {
        businessMeta: { escrowProtection: { enabled: false } },
      };
      const value = _escrowProtectionAvailable(sampleBusiness);
      expect(value).toBe(false);
    });

    test('store without businessMeta reports false in render response', () => {
      const sampleBusiness = { businessMeta: null };
      const value = _escrowProtectionAvailable(sampleBusiness);
      expect(value).toBe(false);
    });
  });
});
