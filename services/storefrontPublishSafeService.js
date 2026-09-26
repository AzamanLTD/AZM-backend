'use strict';

const storefrontService = require('./storefrontService');
const { withDraftMutation } = require('./storefrontDraftMutationSafeService');

/**
 * Publish a storefront draft through the canonical business-level draft
 * mutation boundary. This shares the same PostgreSQL advisory lock used by
 * draft save/revert/template mutations and retains their exact CAS semantics.
 */
async function publishLayoutSafe(prisma, businessProfileId, userId, expectedUpdatedAt = null) {
  return withDraftMutation(
    prisma,
    businessProfileId,
    expectedUpdatedAt,
    (tx) => storefrontService.publishLayout(tx, businessProfileId, userId),
  );
}

module.exports = { publishLayoutSafe };
