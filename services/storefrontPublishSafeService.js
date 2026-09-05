'use strict';

const storefrontService = require('./storefrontService');

function makeError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * Publish a storefront draft behind the canonical business-level advisory
 * lock and a row-level compare-and-swap check.
 *
 * The advisory lock is shared with draft save/revert/template mutations, so a
 * publish cannot interleave with another draft writer for the same business.
 * The row lock then protects the exact draft snapshot being claimed.
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
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${businessProfileId}))`;

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
