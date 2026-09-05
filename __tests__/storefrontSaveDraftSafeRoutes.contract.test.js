'use strict';

const fs = require('fs');

describe('storefront draft save CAS route contract', () => {
  test('mounts the CAS draft save route before the legacy storefront router', () => {
    const source = fs.readFileSync(require.resolve('../src/routes/index'), 'utf8');
    const safeIndex = source.indexOf("storefrontSaveDraftSafeRoutes");
    const legacyIndex = source.indexOf("routes/storefrontRoutes");

    expect(safeIndex).toBeGreaterThanOrEqual(0);
    expect(legacyIndex).toBeGreaterThanOrEqual(0);
    expect(safeIndex).toBeLessThan(legacyIndex);
  });
});
