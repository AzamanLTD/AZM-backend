'use strict';

const fs = require('fs');


describe('storefront publish-safe route contract', () => {
  test('mounts the transactional publish-safe endpoint', () => {
    const source = fs.readFileSync(
      require.resolve('../routes/storefrontRoutes'),
      'utf8',
    );

    expect(source).toContain("require('../services/storefrontPublishSafeService')");
    expect(source).toContain("router.post('/me/publish-safe'");
    expect(source).toContain('publishLayoutSafe');
    expect(source).toContain('status(409)');
  });
});
