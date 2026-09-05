'use strict';

const storefrontService = require('./storefrontService');
const { withDraftMutation } = require('./storefrontDraftMutationSafeService');

/**
 * Serialize all HTTP draft saves for a business. The underlying service keeps
 * its existing validation/migration behavior; the advisory lock closes the
 * read-then-upsert race between concurrent editor saves.
 */
async function saveDraftSafe(
  prisma,
  businessProfileId,
  layoutJson,
  themeId,
  expectedUpdatedAt,
) {
  return withDraftMutation(
    prisma,
    businessProfileId,
    expectedUpdatedAt,
    (tx) => storefrontService.saveDraft(
      tx,
      businessProfileId,
      layoutJson,
      themeId,
      expectedUpdatedAt,
    ),
  );
}

module.exports = { saveDraftSafe };
