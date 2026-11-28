jest.mock('../services/storefrontSchemaMigration', () => ({
  migrateLayout: (layout) => layout,
  generateEmptyLayout: () => ({}),
}));

const { saveDraft, publishLayout, generateDefaultLayout } = require('../services/storefrontService');

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

describe('a new storefront starts from its category', () => {
  const widgets = (category) => generateDefaultLayout('business-1', category).tiles.map((t) => t.widgetType);
  test('restaurants and hotels (the real BusinessCategory values) get their own layouts', () => {
    expect(widgets('FOOD_BEVERAGE')).toContain('review_carousel');
    expect(widgets('HOSPITALITY')).toEqual(expect.arrayContaining(['showcase_gallery', 'location_map', 'action_buttons']));
    expect(widgets('RETAIL')).not.toContain('showcase_gallery');
  });
});

describe('an editor save keeps the draft Experience', () => {
  const draftWith = (experience) => ({
    id: 'draft-1', updatedAt: new Date('2026-11-28T10:00:00Z'),
    layoutJson: { schemaVersion: 1, gridColumns: 4, tiles: [], ...(experience !== undefined ? { experience } : {}) },
  });
  const prismaFor = (existing) => ({
    businessStorefrontLayout: {
      findUnique: jest.fn().mockResolvedValue(existing),
      upsert: jest.fn(async ({ update }) => ({ id: 'draft-1', ...update })),
    },
  });
  const tiles = { schemaVersion: 1, gridColumns: 4, tiles: [{ id: 'tile_abcd', widgetType: 'hero_header', position: { row: 0, col: 0, rowSpan: 1, colSpan: 4 }, props: {} }] };

  test('a tile save (no experience in it) keeps the saved blueprint', async () => {
    const blueprint = { preset: 'DINING_JOURNEY', navigation: { mode: 'CONTEXTUAL' } };
    const prisma = prismaFor(draftWith(blueprint));
    const saved = await saveDraft(prisma, 'business-1', tiles, 'theme-1');
    expect(saved.layoutJson.experience).toEqual(blueprint);
    expect(saved.layoutJson.tiles).toHaveLength(1);
  });

  test('a saved Studio document is kept and still validated', async () => {
    const prisma = prismaFor(draftWith(validExperience));
    const saved = await saveDraft(prisma, 'business-1', tiles, 'theme-1');
    expect(saved.layoutJson.experience).toEqual(validExperience);
  });

  test('no experience on either side stays none', async () => {
    const prisma = prismaFor(draftWith(undefined));
    const saved = await saveDraft(prisma, 'business-1', tiles, 'theme-1');
    expect(saved.layoutJson).not.toHaveProperty('experience');
  });
});

describe('Storefront Studio server validation boundary', () => {
  // Studio V2 is parked (28 Nov): a page document is refused before anything
  // else, unsafe or not, and nothing is written.
  test('saveDraft rejects unsafe Studio experience before persistence', async () => {
    const upsert = jest.fn();
    const prisma = {
      businessStorefrontLayout: { upsert, findUnique: jest.fn().mockResolvedValue(null) },
    };

    await expect(
      saveDraft(prisma, 'business-1', { experience: invalidExperience }, 'theme-1'),
    ).rejects.toMatchObject({ statusCode: 422, code: 'STOREFRONT_STUDIO_PARKED' });
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

  test('a valid Studio V2 document is refused too: the slot belongs to Experience Studio', async () => {
    const upsert = jest.fn().mockResolvedValue({ id: 'draft-1' });
    const prisma = { businessStorefrontLayout: { upsert, findUnique: jest.fn().mockResolvedValue(null) } };

    await expect(
      saveDraft(prisma, 'business-1', { experience: validExperience }, 'theme-1'),
    ).rejects.toMatchObject({ statusCode: 422, code: 'STOREFRONT_STUDIO_PARKED' });
    expect(upsert).not.toHaveBeenCalled();
  });

  test('an Experience Studio blueprint (version 1) still saves', async () => {
    const upsert = jest.fn(async ({ update }) => ({ id: 'draft-1', ...update }));
    const prisma = { businessStorefrontLayout: { upsert, findUnique: jest.fn().mockResolvedValue(null) } };
    const blueprint = { schemaVersion: 1, preset: 'DINING_JOURNEY' };

    const saved = await saveDraft(prisma, 'business-1', { experience: blueprint }, 'theme-1');
    expect(saved.layoutJson.experience).toEqual(blueprint);
  });
});
