'use strict';

const storefrontService = require('./storefrontService');

function makeError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function parseExpectedUpdatedAt(expectedUpdatedAt) {
  if (expectedUpdatedAt === undefined || expectedUpdatedAt === null || expectedUpdatedAt === '') {
    return null;
  }
  if (typeof expectedUpdatedAt !== 'string') {
    throw makeError(
      'expectedUpdatedAt must be a valid ISO timestamp string.',
      'INVALID_EXPECTED_UPDATED_AT',
      400,
    );
  }
  const expected = new Date(expectedUpdatedAt);
  if (Number.isNaN(expected.getTime())) {
    throw makeError(
      'expectedUpdatedAt must be a valid ISO timestamp string.',
      'INVALID_EXPECTED_UPDATED_AT',
      400,
    );
  }
  return expected;
}

/**
 * Serialize draft mutations per business and, when a client snapshot is
 * supplied, enforce compare-and-swap against the exact observed updatedAt.
 * PostgreSQL advisory locks also cover the no-draft case, where a row lock
 * cannot protect two concurrent create operations.
 */
async function withDraftMutation(prisma, businessProfileId, expectedUpdatedAt, mutate) {
  const expected = parseExpectedUpdatedAt(expectedUpdatedAt);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${businessProfileId}))`;

    const draft = await tx.businessStorefrontLayout.findUnique({
      where: { businessProfileId_status: { businessProfileId, status: 'DRAFT' } },
      select: { id: true, updatedAt: true },
    });

    if (expected && (!draft || draft.updatedAt.getTime() !== expected.getTime())) {
      throw makeError(
        'Draft was modified by another editor or is no longer available. Refresh before retrying.',
        'STOREFRONT_DRAFT_STALE',
        409,
      );
    }

    return mutate(tx);
  });
}

async function revertToVersionSafe(prisma, businessProfileId, versionId, expectedUpdatedAt) {
  return withDraftMutation(prisma, businessProfileId, expectedUpdatedAt, (tx) =>
    storefrontService.revertToVersion(tx, businessProfileId, versionId),
  );
}

async function applyTemplateSafe(prisma, businessProfileId, templateId, expectedUpdatedAt) {
  return withDraftMutation(prisma, businessProfileId, expectedUpdatedAt, (tx) =>
    storefrontService.applyTemplate(tx, businessProfileId, templateId),
  );
}

module.exports = {
  parseExpectedUpdatedAt,
  withDraftMutation,
  revertToVersionSafe,
  applyTemplateSafe,
};
