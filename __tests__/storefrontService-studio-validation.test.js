jest.mock('../services/storefrontSchemaMigration', () => ({
  migrateLayout: (layout) => layout,
  generateEmptyLayout: () => ({}),
}));

const { saveDraft, publishLayout } = require('../services/storefrontService');

const invalidExperience = {
  schemaVersion: 2,
  pages: [{ id: 'home', root: ['button'] }],
  nodes: {
    button: {
      id: 'button',
      type: 'button',
      children: [],
      props: { innerHTML: '<script>alert(1)</script>' },
      style: {},
      layout: {},
      responsive: {},
      actions: {},
    },
  },
};

const validExperience = {
  schemaVersion: 2,
  pages: [{ id: 'home', root: ['section'] }],
  nodes: {
    section: {
      id: 'section',
      type: 'section',
      children: [],
      props: {},
      style: {},
      layout: {},
      responsive: {},
      actions: {},
    },
  },
};

describe('Storefront Studio server validation boundary', () => {
  test('saveDraft rejects unsafe Studio experience before persistence', async () => {
    const upsert = jest.fn();
    const prisma = {
      businessStorefrontLayout: { upsert },
    };

    await expect(
      saveDraft(prisma, 'business-1', { experience: invalidExperience }, 'theme-1'),
    ).rejects.toMatchObject({ statusCode: 422, code: 'STOREFRONT_UNSAFE_FIELD' });
    expect(upsert).not.toHaveBeenCalled();
  });

  test('publishLayout rejects unsafe Studio experience before Nitro or mutation', async () => {
    const prisma = {
      businessStorefrontLayout: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'draft-1',
          businessProfileId: 'business-1',
          status: 'DRAFT',
          themeId: 'theme-1',
          layoutJson: { experience: invalidExperience },
          theme: { key: 'classic_light' },
        }),
        create: jest.fn(),
        delete: jest.fn(),
      },
      businessProfile: { findUnique: jest.fn().mockResolvedValue({ storefrontDisabled: false }) },
    };

    await expect(publishLayout(prisma, 'business-1', 'user-1')).rejects.toMatchObject({
      statusCode: 422,
      code: 'STOREFRONT_UNSAFE_FIELD',
    });
    expect(prisma.businessProfile.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.businessStorefrontLayout.create).not.toHaveBeenCalled();
  });

  test('valid schemaVersion 2 experience continues through save validation', async () => {
    const upsert = jest.fn().mockResolvedValue({ id: 'draft-1' });
    const prisma = { businessStorefrontLayout: { upsert } };

    await expect(
      saveDraft(prisma, 'business-1', { experience: validExperience }, 'theme-1'),
    ).resolves.toEqual({ id: 'draft-1' });
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
