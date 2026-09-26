'use strict';

const fs = require('fs');

describe('storefront draft mutation CAS route contract', () => {
  test('mounts CAS routes before legacy storefront routes', () => {
    const source = fs.readFileSync(require.resolve('../src/routes/index'), 'utf8');
    const safeIndex = source.indexOf("storefrontDraftMutationRoutes");
    const legacyIndex = source.indexOf("routes/storefrontRoutes");

    expect(safeIndex).toBeGreaterThanOrEqual(0);
    expect(legacyIndex).toBeGreaterThanOrEqual(0);
    expect(safeIndex).toBeLessThan(legacyIndex);
  });
});
