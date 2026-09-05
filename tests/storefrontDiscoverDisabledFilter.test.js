const { buildDiscoverWhere } = require('../routes/storefrontDiscoverRoutes');

describe('storefront discovery availability filter', () => {
  test('always excludes administratively disabled storefronts', () => {
    const where = buildDiscoverWhere();

    expect(where).toMatchObject({
      status: 'PUBLISHED',
      businessProfile: {
        storefrontDisabled: false,
        isSuspended: false,
        isPausedByOwner: false,
      },
    });
  });

  test('retains category and search filters alongside availability', () => {
    const where = buildDiscoverWhere({ category: 'RETAIL', q: '  Acme  ' });

    expect(where.businessProfile).toMatchObject({
      storefrontDisabled: false,
      isSuspended: false,
      isPausedByOwner: false,
      category: 'RETAIL',
      businessName: { contains: 'Acme', mode: 'insensitive' },
    });
  });
});
