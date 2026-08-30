'use strict';

// Authoritative storefront state-transition boundary.
//
// All draft mutations and publication transitions acquire a row lock on the
// owning BusinessProfile before reading/writing storefront state. This closes
// the read/check/write race in the legacy service without changing its public
// data model or history semantics.

const storefrontService = require('./storefrontService');
const { migrateLayout } = require('./storefrontSchemaMigration');

async function lockBusinessProfile(tx, businessProfileId) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT "id" FROM "BusinessProfile" WHERE "id" = $1 FOR UPDATE',
    businessProfileId,
  );
  if (!rows.length) throw new Error('Business not found.');
}

async function withBusinessLock(prisma, businessProfileId, work) {
  return prisma.$transaction(async (tx) => {
    await lockBusinessProfile(tx, businessProfileId);
    return work(tx);
  });
}

async function saveDraft(prisma, businessProfileId, layoutJson, themeId, expectedUpdatedAt) {
  return withBusinessLock(prisma, businessProfileId, async (tx) => {
    const existing = await tx.businessStorefrontLayout.findUnique({
      where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
    });

    if (existing && expectedUpdatedAt && existing.updatedAt.toISOString() !== expectedUpdatedAt) {
      const error = new Error('Draft was modified by another editor. Please refresh.');
      error.statusCode = 409;
      error.code = 'STOREFRONT_DRAFT_CONFLICT';
      throw error;
    }

    const migratedLayout = migrateLayout(layoutJson);
    return tx.businessStorefrontLayout.upsert({
      where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
      create: { businessProfileId, status: 'DRAFT', themeId, layoutJson: migratedLayout },
      update: { themeId, layoutJson: migratedLayout },
      include: { theme: true },
    });
  });
}

async function revertToVersion(prisma, businessProfileId, versionId, expectedUpdatedAt) {
  return withBusinessLock(prisma, businessProfileId, async (tx) => {
    const version = await tx.businessStorefrontLayoutVersion.findUnique({ where: { id: versionId } });
    if (!version || version.businessProfileId !== businessProfileId) throw new Error('Version not found.');

    const existingDraft = await tx.businessStorefrontLayout.findUnique({
      where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
    });
    if (existingDraft && expectedUpdatedAt && existingDraft.updatedAt.toISOString() !== expectedUpdatedAt) {
      const error = new Error('Draft was modified by another editor. Please refresh.');
      error.statusCode = 409;
      error.code = 'STOREFRONT_DRAFT_CONFLICT';
      throw error;
    }

    const migratedLayout = migrateLayout(version.layoutJson);
    if (existingDraft) {
      return tx.businessStorefrontLayout.update({
        where: { id: existingDraft.id },
        data: { themeId: version.themeId, layoutJson: migratedLayout },
        include: { theme: true },
      });
    }
    return tx.businessStorefrontLayout.create({
      data: { businessProfileId, status: 'DRAFT', themeId: version.themeId, layoutJson: migratedLayout },
      include: { theme: true },
    });
  });
}

async function applyTemplate(prisma, businessProfileId, templateId, expectedUpdatedAt) {
  return withBusinessLock(prisma, businessProfileId, async (tx) => {
    const template = await tx.businessStorefrontLayoutTemplate.findUnique({ where: { id: templateId } });
    if (!template || !template.isActive) throw new Error('Template not found or inactive.');
    if (!template.themeId) throw new Error('Template has no theme assigned.');

    const existingDraft = await tx.businessStorefrontLayout.findUnique({
      where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
    });
    if (existingDraft && expectedUpdatedAt && existingDraft.updatedAt.toISOString() !== expectedUpdatedAt) {
      const error = new Error('Draft was modified by another editor. Please refresh.');
      error.statusCode = 409;
      error.code = 'STOREFRONT_DRAFT_CONFLICT';
      throw error;
    }

    const migratedLayout = migrateLayout(template.layoutJson);
    if (existingDraft) {
      return tx.businessStorefrontLayout.update({
        where: { id: existingDraft.id },
        data: { themeId: template.themeId, layoutJson: migratedLayout },
        include: { theme: true },
      });
    }
    return tx.businessStorefrontLayout.create({
      data: { businessProfileId, status: 'DRAFT', themeId: template.themeId, layoutJson: migratedLayout },
      include: { theme: true },
    });
  });
}

async function publishLayout(prisma, businessProfileId, userId, expectedUpdatedAt) {
  return withBusinessLock(prisma, businessProfileId, async (tx) => {
    const draft = await tx.businessStorefrontLayout.findUnique({
      where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
      include: { theme: true },
    });
    if (!draft) throw new Error('No draft layout to publish.');

    if (expectedUpdatedAt && draft.updatedAt.toISOString() !== expectedUpdatedAt) {
      const error = new Error('Draft was modified by another editor. Please refresh.');
      error.statusCode = 409;
      error.code = 'STOREFRONT_DRAFT_CONFLICT';
      throw error;
    }

    const business = await tx.businessProfile.findUnique({
      where: { id: businessProfileId },
      select: { storefrontDisabled: true },
    });
    if (business?.storefrontDisabled) throw new Error('Storefront is disabled by admin. Contact support.');

    const eligibility = await storefrontService.validateNitroEligibility(
      tx, businessProfileId, draft.layoutJson, draft.theme?.key || null,
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

    if (currentPublished) {
      const maxVersion = await tx.businessStorefrontLayoutVersion.aggregate({
        where: { businessProfileId }, _max: { version: true },
      });
      await tx.businessStorefrontLayoutVersion.create({
        data: {
          businessProfileId,
          version: (maxVersion._max.version || 0) + 1,
          themeId: currentPublished.themeId,
          layoutJson: currentPublished.layoutJson,
          publishedAt: currentPublished.publishedAt,
          publishedBy: currentPublished.publishedBy,
        },
      });
      await tx.businessStorefrontLayout.delete({ where: { id: currentPublished.id } });
    }

    const published = await tx.businessStorefrontLayout.create({
      data: {
        businessProfileId,
        status: 'PUBLISHED',
        themeId: draft.themeId,
        layoutJson: draft.layoutJson,
        publishedAt: new Date(),
        publishedBy: userId,
      },
      include: { theme: true },
    });

    const maxVersion2 = await tx.businessStorefrontLayoutVersion.aggregate({
      where: { businessProfileId }, _max: { version: true },
    });
    await tx.businessStorefrontLayoutVersion.create({
      data: {
        businessProfileId,
        version: (maxVersion2._max.version || 0) + 1,
        themeId: draft.themeId,
        layoutJson: draft.layoutJson,
        publishedAt: published.publishedAt,
        publishedBy: userId,
      },
    });

    await tx.businessStorefrontLayout.delete({ where: { id: draft.id } });
    return published;
  });
}

module.exports = {
  saveDraft,
  revertToVersion,
  applyTemplate,
  publishLayout,
};
