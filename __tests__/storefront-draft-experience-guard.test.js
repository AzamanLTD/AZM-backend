'use strict';

const {
  hasOwnExperience,
  preserveDraftExperience,
} = require('../services/storefrontDraftExperienceGuard');

describe('storefront draft Experience Blueprint guard', () => {
  test('preserves the current snapshot when the incoming layout omits experience', () => {
    const current = { preset: 'DINING_JOURNEY', motion: { tempo: 'BALANCED' } };
    const incoming = { schemaVersion: 1, tiles: [] };

    expect(preserveDraftExperience(incoming, { experience: current })).toEqual({
      schemaVersion: 1,
      tiles: [],
      experience: current,
    });
  });

  test('explicit incoming experience remains authoritative', () => {
    const current = { preset: 'DINING_JOURNEY' };
    const incoming = { schemaVersion: 1, tiles: [], experience: { preset: 'SHOP_FLOOR' } };

    expect(preserveDraftExperience(incoming, { experience: current }).experience).toEqual(incoming.experience);
  });

  test('explicit null is preserved and is not treated as omission', () => {
    const incoming = { schemaVersion: 1, tiles: [], experience: null };

    expect(hasOwnExperience(incoming)).toBe(true);
    expect(preserveDraftExperience(incoming, { experience: { preset: 'DINING_JOURNEY' } }).experience).toBeNull();
  });

  test('does not invent experience for a draft that has never had one', () => {
    const incoming = { schemaVersion: 1, tiles: [] };

    expect(preserveDraftExperience(incoming, { schemaVersion: 1, tiles: [] })).toEqual(incoming);
  });
});
