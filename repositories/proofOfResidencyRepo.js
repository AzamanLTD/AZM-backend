// repositories/proofOfResidencyRepo.js
// =============================================================================
// Thin Prisma wrappers for the Proof of Residency columns on User and the
// associated admin-review queue. Pure persistence — no validation here, no
// Cloudinary calls, no expiry math. Service layer owns those.
// =============================================================================

class ProofOfResidencyRepo {
  constructor(prisma) {
    this.prisma = prisma;
  }

  getStatus(userId, client = this.prisma) {
    return client.user.findUnique({
      where: { id: userId },
      select: {
        proofOfResidencyStatus: true,
        proofOfResidencyUrl: true,
        proofOfResidencySubmittedAt: true,
        proofOfResidencyVerifiedAt: true,
        proofOfResidencyRejectionReason: true,
      },
    });
  }

  recordSubmission(userId, { url }, client = this.prisma) {
    return client.user.update({
      where: { id: userId },
      data: {
        proofOfResidencyUrl: url,
        proofOfResidencyStatus: 'PENDING_REVIEW',
        proofOfResidencySubmittedAt: new Date(),
        proofOfResidencyRejectionReason: null,
      },
    });
  }

  recordApproval(userId, client = this.prisma) {
    return client.user.update({
      where: { id: userId },
      data: {
        proofOfResidencyStatus: 'VERIFIED',
        proofOfResidencyVerifiedAt: new Date(),
        proofOfResidencyRejectionReason: null,
      },
    });
  }

  recordRejection(userId, { reason }, client = this.prisma) {
    return client.user.update({
      where: { id: userId },
      data: {
        proofOfResidencyStatus: 'REJECTED',
        proofOfResidencyRejectionReason: reason,
      },
    });
  }

  /**
   * Daily PoR_Expiry_Sweep cron entrypoint. Uses updateMany for a
   * single-statement bulk transition; returns the count of affected rows.
   */
  sweepExpired(thresholdDate, client = this.prisma) {
    return client.user.updateMany({
      where: {
        proofOfResidencyStatus: 'VERIFIED',
        proofOfResidencyVerifiedAt: { lt: thresholdDate },
      },
      data: { proofOfResidencyStatus: 'EXPIRED' },
    });
  }

  listJustExpired(thresholdDate, client = this.prisma) {
    return client.user.findMany({
      where: {
        proofOfResidencyStatus: 'EXPIRED',
        proofOfResidencyVerifiedAt: { lt: thresholdDate },
      },
      select: { id: true, fcmToken: true },
    });
  }

  listReviewQueue({ take = 50, cursor } = {}, client = this.prisma) {
    return client.user.findMany({
      where: { proofOfResidencyStatus: 'PENDING_REVIEW' },
      orderBy: { proofOfResidencySubmittedAt: 'asc' },
      take,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      select: {
        id: true,
        username: true,
        email: true,
        proofOfResidencyUrl: true,
        proofOfResidencyStatus: true,
        proofOfResidencySubmittedAt: true,
      },
    });
  }
}

module.exports = ProofOfResidencyRepo;
