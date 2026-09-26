const { normalizeProvider } = require('../services/providerSettlementAttemptService');

describe('provider settlement provider normalization', () => {
  test('maps DISBURSEMENT to the existing MTN identity', () => {
    expect(normalizeProvider('DISBURSEMENT')).toBe('MTN_MOMO_DISBURSEMENT');
  });

  test('preserves supported provider identities', () => {
    expect(normalizeProvider('MTN_MOMO_DISBURSEMENT')).toBe('MTN_MOMO_DISBURSEMENT');
    expect(normalizeProvider('MOOLRE')).toBe('MOOLRE');
  });
});
