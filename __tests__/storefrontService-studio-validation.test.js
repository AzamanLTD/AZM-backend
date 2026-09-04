const { validateStudioDocument } = require('../services/storefrontStudioValidation');

describe('Storefront Studio server validation boundary', () => {
  test('accepts a valid schemaVersion 2 experience', () => {
    expect(validateStudioDocument({
      schemaVersion: 2,
      pages: [{ id: 'home', root: ['section'] }],
      nodes: { section: { id: 'section', type: 'section', children: [], props: {}, style: {}, layout: {}, responsive: {}, actions: {} } },
    }).valid).toBe(true);
  });
});
