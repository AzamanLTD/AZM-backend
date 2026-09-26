const { buildDiscoverWhere } = require('../routes/storefrontDiscoverRoutes');

describe('buildDiscoverWhere', () => {
  test('filters published storefronts by direct business category', () => {
    expect(buildDiscoverWhere({ category: 'RESTAURANT' })).toEqual({
      status: 'PUBLISHED',
      businessProfile: {
        isSuspended: false,
        isPausedByOwner: false,
        storefrontDisabled: false,
        category: 'RESTAURANT',
      },
    });
  });

  test('combines category and case-insensitive merchant name search', () => {
    expect(buildDiscoverWhere({ category: 'RETAIL', q: '  Acme  ' })).toEqual({
      status: 'PUBLISHED',
      businessProfile: {
        isSuspended: false,
        isPausedByOwner: false,
        storefrontDisabled: false,
        category: 'RETAIL',
        businessName: {
          contains: 'Acme',
          mode: 'insensitive',
        },
      },
    });
  });

  test('does not create an invalid nested businessProfile predicate', () => {
    const where = buildDiscoverWhere({ category: 'HOTEL' });
    expect(where.businessProfile.businessProfile).toBeUndefined();
  });
});
