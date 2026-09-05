const { buildDiscoverWhere } = require('../routes/storefrontDiscoverRoutes');

describe('storefront discovery visibility filter', () => {
  test('excludes storefronts disabled by administration', () => {
    expect(buildDiscoverWhere({})).toEqual({
      status: 'PUBLISHED',
      businessProfile: {
        isSuspended: false,
        isPausedByOwner: false,
        storefrontDisabled: false,
      },
    });
  });

  test('preserves visibility constraints with category and search filters', () => {
    expect(buildDiscoverWhere({ category: 'RETAIL', q: '  market  ' })).toEqual({
      status: 'PUBLISHED',
      businessProfile: {
        isSuspended: false,
        isPausedByOwner: false,
        storefrontDisabled: false,
        category: 'RETAIL',
        businessName: { contains: 'market', mode: 'insensitive' },
      },
    });
  });
});
