// repositories/adminWarRoomRepo.js
// =============================================================================
// Thin Prisma wrappers for AdminWarRoomAlert (Circuit Breaker / escrow
// diversion / vouch-slash failure feed for ops). The service layer is
// responsible for the FCM fanout to admin users.
// =============================================================================

class AdminWarRoomRepo {
  constructor(prisma) {
    this.prisma = prisma;
  }

  fire({ alertType, susuGroupId, cycleId = null, payload = {} }, client = this.prisma) {
    return client.adminWarRoomAlert.create({
      data: { alertType, susuGroupId, cycleId, payload },
    });
  }

  list({ acknowledged, take = 50, cursor } = {}, client = this.prisma) {
    const where = {};
    if (acknowledged === false) where.acknowledgedAt = null;
    if (acknowledged === true)  where.acknowledgedAt = { not: null };
    return client.adminWarRoomAlert.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
  }

  acknowledge(id, adminUserId, client = this.prisma) {
    return client.adminWarRoomAlert.update({
      where: { id },
      data: { acknowledgedAt: new Date(), acknowledgedBy: adminUserId },
    });
  }

  // Used by tests to assert the existence of a specific alert type for a Susu.
  findFor({ susuGroupId, alertType }, client = this.prisma) {
    return client.adminWarRoomAlert.findFirst({
      where: { susuGroupId, alertType },
      orderBy: { createdAt: 'desc' },
    });
  }
}

module.exports = AdminWarRoomRepo;
