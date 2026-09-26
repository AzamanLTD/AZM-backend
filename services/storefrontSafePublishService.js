'use strict';

// Transactional publish boundary for storefront editing.
// Unlike the legacy publishLayout path, this service consumes the editor's
// expectedUpdatedAt snapshot and atomically claims that exact draft before
// changing published state. A failed validation/provider-independent mutation
// rolls back the entire transaction and leaves the draft intact.

const storefrontService = require('./storefrontService');
const { validateStudioDocument } = require('./storefrontStudioValidation');

function stalePublishError() {
  const error = new Error('Storefront draft was modified by another editor. Please refresh before publishing.');
  error.code = 'STALE_STOREFRONT_DRAFT';
  error.statusCode = 409;
  return error;
}

function parseExpectedUpdatedAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw stalePublishError();
  return parsed;
}

async function publishStorefrontSafely(prisma, businessProfileId, userId, expectedUpdatedAt) {
  const expectedDate = parseExpectedUpdatedAt(expectedUpdatedAt);

  return prisma.$transaction(async (tx) => {
    const existingDraft = await tx.businessStorefrontLayout.findUnique({
      where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
      include: { theme: true },
    });
    if (!existingDraft) throw new Error('No draft layout to publish.');

    let draft = existingDraft;

    if (expectedDate) {
      // Compare-and-swap claim. This changes updatedAt through Prisma's
      // @updatedAt behavior, preventing another versioned editor write from
      // using the old snapshot while this publish transaction owns the row.
      const claim = await tx.businessStorefrontLayout.updateMany({
        where: {
          id: existingDraft.id,
          businessProfileId,
          status: 'DRAFT',
          updatedAt: expectedDate,
        },
        data: {
          layoutJson: existingDraft.layoutJson,
          themeId: existingDraft.themeId,
        },
      });
      if (claim.count !== 1) throw stalePublishError();

      draft = await tx.businessStorefrontLayout.findUnique({
        where: { id: existingDraft.id },
        include: { theme: true },
      });
      if (!draft) throw new Error('Draft disappeared during publish.');
    }

    const business = await tx.businessProfile.findUnique({
      where: { id: businessProfileId },
      select: { storefrontDisabled: true },
    });
    if (business?.storefrontDisabled) {
      throw new Error('Storefront is disabled by admin. Contact support.');
    }

    if (draft.layoutJson?.experience?.schemaVersion === 2) {
      validateStudioDocument(draft.layoutJson.experience);
    }

    const themeKey = draft.theme?.key || null;
    const eligibility = await storefrontService.validateNitroEligibility(
      tx,
      businessProfileId,
      draft.layoutJson,
      themeKey,
    );
    if (!eligibility.eligible) {
      const error = new Error('Nitro eligibility check failed. Premium features require more staked AZM.');
      error.statusCode = 402;
      error.violations = eligibility.violations;
      error.tier = eligibility.tier;
      error.stakedBalance = eligibility.stakedBalance;
      throw error;
    }

    const currentPublished = await tx.businessStorefrontLayout.findUnique({
      where: { businessProfileId_status: { businessProfileId, status: 'PUBLISHED' } },
    });

    const latestVersion = await tx.businessStorefrontLayoutVersion.aggregate({
      where: { businessProfileId },
      _max: { version: true },
    });
    let nextVersion = (latestVersion._max.version || 0) + 1;

    if (currentPublished) {
      await tx.businessStorefrontLayoutVersion.create({
        data: {
          businessProfileId,
          version: nextVersion++,
          themeId: currentPublished.themeId,
          layoutJson: currentPublished.layoutJson,
          publishedAt: currentPublished.publishedAt,
          publishedBy: currentPublished.publishedBy,
        },
      });
      await tx.businessStorefrontLayout.delete({ where: { id: currentPublished.id } });
    }

    const publishedAt = new Date();
    const published = await tx.businessStorefrontLayout.create({
      data: {
        businessProfileId,
        status: 'PUBLISHED',
        themeId: draft.themeId,
        layoutJson: draft.layoutJson,
        publishedAt,
        publishedBy: userId,
      },
      include: { theme: true },
    });

    await tx.businessStorefrontLayoutVersion.create({
      data: {
        businessProfileId,
        version: nextVersion,
        themeId: draft.themeId,
        layoutJson: draft.layoutJson,
        publishedAt,
        publishedBy: userId,
      },
    });

    await tx.businessStorefrontLayout.delete({ where: { id: draft.id } });

    return published;
  });
}

module.exports = { publishStorefrontSafely, stalePublishError };
