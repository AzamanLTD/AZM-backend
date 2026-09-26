'use strict';

const { applyTemplateSchema, revertSchema } = require('../services/validation/storefrontSchemas');

describe('storefront draft mutation request schemas', () => {
  const updatedAt = '2026-09-05T00:00:00.000Z';

  test('template requests preserve expectedUpdatedAt', () => {
    const parsed = applyTemplateSchema.safeParse({
      templateId: '8f4e8f8f-8f8f-4f8f-8f8f-8f8f8f8f8f8f',
      expectedUpdatedAt: updatedAt,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data.expectedUpdatedAt).toBe(updatedAt);
  });

  test('revert requests preserve expectedUpdatedAt', () => {
    const parsed = revertSchema.safeParse({
      versionId: '8f4e8f8f-8f8f-4f8f-8f8f-8f8f8f8f8f8f',
      expectedUpdatedAt: updatedAt,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data.expectedUpdatedAt).toBe(updatedAt);
  });
});
