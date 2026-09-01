'use strict';

const storefrontService = require('../services/storefrontService');

const DRAFT_WHERE = {
  businessProfileId_status: { businessProfileId: 'biz-1', status: 'DRAFT' },
};

function makePrisma(existingDraft) {
  return {
    businessStorefrontLayout: {
      findUnique: jest.fn().mockResolvedValue(existingDraft),
      upsert: jest.fn().mockImplementation(async ({ create, update }) => ({
        id: existingDraft?.id || 'draft-1',
        ...(existingDraft || {}),
        ...(existingDraft ? update : create),
      })),
    },
  };
}

describe('storefrontService.saveDraft Experience Blueprint preservation', () => {
  test('preserves the current experience when an incoming layout omits it', async () => {
    const experience = { preset: 'DINING_JOURNEY', navigation: { mode: 'CONTEXTUAL' } };
    const prisma = makePrisma({ id: 'draft-1', updatedAt: new Date('2026-09-01T12:00:00Z'), layoutJson: { schemaVersion: 1, tiles: [], experience } });

    const draft = await storefrontService.saveDraft(prisma, 'biz-1', { schemaVersion: 1, tiles: [{ id: 'tile-1' }] }, 'theme-1');

    expect(prisma.businessStorefrontLayout.findUnique).toHaveBeenCalledWith({ where: DRAFT_WHERE });
    expect(draft.layoutJson.experience).toEqual(experience);
  });

  test('keeps an explicitly supplied experience authoritative', async () => {
    const currentExperience = { preset: 'DINING_JOURNEY' };
    const incomingExperience = { preset: 'DINING_JOURNEY', motion: { tempo: 'QUICK' } };
    const prisma = makePrisma({ id: 'draft-1', updatedAt: new Date('2026-09-01T12:00:00Z'), layoutJson: { schemaVersion: 1, tiles: [], experience: currentExperience } });

    const draft = await storefrontService.saveDraft(prisma, 'biz-1', { schemaVersion: 1, tiles: [], experience: incomingExperience }, 'theme-1');

    expect(draft.layoutJson.experience).toEqual(incomingExperience);
  });

  test('preserves an explicit null experience instead of restoring the old snapshot', async () => {
    const currentExperience = { preset: 'DINING_JOURNEY' };
    const prisma = makePrisma({ id: 'draft-1', updatedAt: new Date('2026-09-01T12:00:00Z'), layoutJson: { schemaVersion: 1, tiles: [], experience: currentExperience } });

    const draft = await storefrontService.saveDraft(prisma, 'biz-1', { schemaVersion: 1, tiles: [], experience: null }, 'theme-1');

    expect(Object.prototype.hasOwnProperty.call(draft.layoutJson, 'experience')).toBe(true);
    expect(draft.layoutJson.experience).toBeNull();
  });

  test('retains optimistic concurrency behavior while loading the draft once', async () => {
    const updatedAt = new Date('2026-09-01T12:00:00Z');
    const prisma = makePrisma({ id: 'draft-1', updatedAt, layoutJson: { schemaVersion: 1, tiles: [], experience: { preset: 'DINING_JOURNEY' } } });

    await expect(
      storefrontService.saveDraft(prisma, 'biz-1', { schemaVersion: 1, tiles: [] }, 'theme-1', '2026-09-01T12:00:00.000Z'),
    ).resolves.toBeTruthy();

    expect(prisma.businessStorefrontLayout.findUnique).toHaveBeenCalledTimes(1);
  });
});
