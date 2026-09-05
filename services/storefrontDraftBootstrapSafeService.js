'use strict';

const storefrontService = require('./storefrontService');

/**
 * Serialize first-draft creation per business. The legacy service already
 * handles all defaults; this wrapper prevents concurrent GETs from racing
 * through the initial find/create sequence.
 */
async function getOrCreateDraftSafe(prisma, businessProfileId, category) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${businessProfileId}))`;
    return storefrontService.getOrCreateDraft(tx, businessProfileId, category);
  });
}

module.exports = { getOrCreateDraftSafe };
