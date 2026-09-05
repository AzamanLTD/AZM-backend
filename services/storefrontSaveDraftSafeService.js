'use strict';

const storefrontService = require('./storefrontService');
const { withDraftMutation } = require('./storefrontDraftMutationSafeService');

async function saveDraftSafe(prisma, businessProfileId, layoutJson, themeId, expectedUpdatedAt) {
  return withDraftMutation(prisma, businessProfileId, expectedUpdatedAt, (tx) =>
    storefrontService.saveDraft(tx, businessProfileId, layoutJson, themeId, expectedUpdatedAt),
  );
}

module.exports = { saveDraftSafe };
