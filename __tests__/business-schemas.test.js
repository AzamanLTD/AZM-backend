// __tests__/business-schemas.test.js
// =============================================================================
// Regression tests for services/validation/businessSchemas.js.
//
// These lock in the behaviour-preserving contract described in that file:
//   • register restricts category to the known enum (matches controller 400).
//   • update treats category as a free string (service silently ignores unknown
//     — must NOT 400, or we'd break clients).
//   • businessName 2–100 enforced on both paths; optional on update.
//   • BUSINESS_CATEGORIES stays in lock-step with businessService.VALID_CATEGORIES.
// =============================================================================
const {
  BUSINESS_CATEGORIES,
  businessRegisterSchema,
  businessUpdateSchema,
} = require('../services/validation/businessSchemas');
const businessService = require('../services/businessService');

describe('businessSchemas — category list parity', () => {
  test('BUSINESS_CATEGORIES matches service VALID_CATEGORIES exactly', () => {
    const fromService = [...businessService.VALID_CATEGORIES].sort();
    expect([...BUSINESS_CATEGORIES].sort()).toEqual(fromService);
  });
});

describe('businessRegisterSchema', () => {
  test('valid: minimal name only', () => {
    const r = businessRegisterSchema.safeParse({ businessName: 'Jo' });
    expect(r.success).toBe(true);
  });

  test('trims businessName and enforces 2–100', () => {
    expect(businessRegisterSchema.safeParse({ businessName: ' a ' }).success).toBe(false); // 1 char after trim
    expect(businessRegisterSchema.safeParse({ businessName: 'x'.repeat(101) }).success).toBe(false);
    const ok = businessRegisterSchema.safeParse({ businessName: '  Good Name  ' });
    expect(ok.success).toBe(true);
    expect(ok.data.businessName).toBe('Good Name'); // coerced/trimmed
  });

  test('missing businessName fails', () => {
    expect(businessRegisterSchema.safeParse({}).success).toBe(false);
  });

  test('register restricts category to the enum', () => {
    expect(businessRegisterSchema.safeParse({ businessName: 'Acme', category: 'RETAIL' }).success).toBe(true);
    expect(businessRegisterSchema.safeParse({ businessName: 'Acme', category: 'NOT_A_CAT' }).success).toBe(false);
  });

  test('description max 500', () => {
    expect(businessRegisterSchema.safeParse({ businessName: 'Acme', description: 'x'.repeat(501) }).success).toBe(false);
  });

  test('preserves unrelated free-string fields (merge-friendly)', () => {
    const r = businessRegisterSchema.safeParse({
      businessName: 'Acme', website: 'acme.co', phoneNumber: '+233...', country: 'GH',
    });
    expect(r.success).toBe(true);
  });
});

describe('businessUpdateSchema', () => {
  test('all fields optional', () => {
    expect(businessUpdateSchema.safeParse({}).success).toBe(true);
  });

  test('update does NOT 400 on an unknown category (free string)', () => {
    // Critical: service silently ignores unknown categories; schema must agree.
    expect(businessUpdateSchema.safeParse({ category: 'NOT_A_CAT' }).success).toBe(true);
  });

  test('businessName still 2–100 when present', () => {
    expect(businessUpdateSchema.safeParse({ businessName: 'a' }).success).toBe(false);
    expect(businessUpdateSchema.safeParse({ businessName: 'Acme' }).success).toBe(true);
  });
});
