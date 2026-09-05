'use strict';

const fs = require('fs');

describe('storefront draft bootstrap route contract', () => {
  test('mounts serialized draft bootstrap before legacy route', () => {
    const source = fs.readFileSync(require.resolve('../src/routes/index'), 'utf8');
    const safeIndex = source.indexOf("storefrontDraftBootstrapSafeRoutes");
    const legacyIndex = source.indexOf("routes/storefrontRoutes");

    expect(safeIndex).toBeGreaterThanOrEqual(0);
    expect(legacyIndex).toBeGreaterThanOrEqual(0);
    expect(safeIndex).toBeLessThan(legacyIndex);
  });
});
