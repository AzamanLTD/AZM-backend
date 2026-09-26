'use strict';

const storefrontService = require('./storefrontService');
const { withDraftMutation } = require('./storefrontDraftMutationSafeService');

/**
 * Serialize first-draft creation per business through the same transaction
 * boundary used by versioned draft mutations. The legacy service retains
 * responsibility for defaults and the response contract.
 */
async function getOrCreateDraftSafe(prisma, businessProfileId, category) {
  return withDraftMutation(prisma, businessProfileId, null, (tx) =>
    storefrontService.getOrCreateDraft(tx, businessProfileId, category),
  );
}

module.exports = { getOrCreateDraftSafe };
