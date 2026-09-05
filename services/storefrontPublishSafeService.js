'use strict';

const storefrontService = require('./storefrontService');

function makeError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * Publish a storefront draft behind a database row lock.
 * A versioned call is a compare-and-swap: only the exact draft snapshot the
 * editor observed may be claimed. The legacy /me/publish endpoint remains
 * available for compatibility while new clients use this boundary.
 */
async function publishLayoutSafe(prisma, businessProfileId, userId, expectedUpdatedAt = null) {
  let expected = null;
  if (expectedUpdatedAt) {
    expected = new Date(expectedUpdatedAt);
    if (Number.isNaN(expected.getTime())) {
      throw makeError(
        'expectedUpdatedAt must be a valid ISO timestamp.',
        'INVALID_EXPECTED_UPDATED_AT',
        400,
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const rows = expected
      ? await tx.$queryRaw`
          SELECT "id"
          FROM "BusinessStorefrontLayout"
          WHERE "businessProfileId" = ${businessProfileId}
            AND "status" = 'DRAFT'
            AND "updatedAt" = ${expected}
          FOR UPDATE
        `
      : await tx.$queryRaw`
          SELECT "id"
          FROM "BusinessStorefrontLayout"
          WHERE "businessProfileId" = ${businessProfileId}
            AND "status" = 'DRAFT'
          FOR UPDATE
        `;

    if (rows.length !== 1) {
      if (expected) {
        throw makeError(
          'Draft was modified by another editor or is no longer available. Refresh before publishing.',
          'STOREFRONT_DRAFT_STALE',
          409,
        );
      }
      throw makeError('No draft layout to publish.', 'STOREFRONT_DRAFT_NOT_FOUND', 400);
    }

    return storefrontService.publishLayout(tx, businessProfileId, userId);
  });
}

module.exports = { publishLayoutSafe };
