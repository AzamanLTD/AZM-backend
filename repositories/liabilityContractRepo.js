// repositories/liabilityContractRepo.js
// =============================================================================
// Thin Prisma wrappers for LiabilityContractVersion + LiabilityAcceptance.
// =============================================================================

class LiabilityContractRepo {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Latest published contract version (Req 4.1 fallback when no Susu is
   * pinned yet, e.g. /api/liability-contract/active public endpoint).
   */
  getActiveContract(client = this.prisma) {
    return client.liabilityContractVersion.findFirst({
      orderBy: { publishedAt: 'desc' },
    });
  }

  getByVersion(version, client = this.prisma) {
    return client.liabilityContractVersion.findUnique({ where: { version } });
  }

  getByHash(contractHash, client = this.prisma) {
    return client.liabilityContractVersion.findUnique({ where: { contractHash } });
  }

  publishVersion({ version, contractHash, body, publishedBy }, client = this.prisma) {
    return client.liabilityContractVersion.create({
      data: { version, contractHash, body, publishedBy },
    });
  }

  // ── LiabilityAcceptance ─────────────────────────────────────────────────

  /**
   * Idempotent insert: if a row already exists for
   * (userId, susuGroupId, contractVersion) the unique constraint forces the
   * caller to use findExistingAcceptance first. The service layer wraps
   * this in a try/catch on P2002.
   */
  createAcceptance(
    { userId, susuGroupId, contractVersion, contractHash, ipAddress, userAgent, acknowledgedClauses, voucherUserId },
    client = this.prisma,
  ) {
    return client.liabilityAcceptance.create({
      data: {
        userId,
        susuGroupId,
        contractVersion,
        contractHash,
        ipAddress,
        userAgent,
        acknowledgedClauses,
        voucherUserId,
      },
    });
  }

  findAcceptance({ userId, susuGroupId, contractVersion }, client = this.prisma) {
    return client.liabilityAcceptance.findUnique({
      where: {
        userId_susuGroupId_contractVersion: { userId, susuGroupId, contractVersion },
      },
    });
  }

  listAcceptancesForSusu(susuGroupId, client = this.prisma) {
    return client.liabilityAcceptance.findMany({
      where: { susuGroupId },
      orderBy: { acceptedAt: 'asc' },
    });
  }

  /**
   * Used by Susu cancellation (Req 8.5) to void the acceptance audit. We
   * simply delete here — the acceptance row's purpose is to evidence active
   * consent, and a cancelled Susu has no live consent to evidence. Note:
   * if you ever need to preserve the trail post-cancellation, replace this
   * with a soft-flag column.
   */
  deleteForSusu(susuGroupId, client = this.prisma) {
    return client.liabilityAcceptance.deleteMany({
      where: { susuGroupId },
    });
  }
}

module.exports = LiabilityContractRepo;
