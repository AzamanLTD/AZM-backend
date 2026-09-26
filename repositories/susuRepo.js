// repositories/susuRepo.js
// =============================================================================
// Thin Prisma wrappers for SusuGroup. NO business logic — pure persistence.
// Service layer composes these helpers. Maps to the deployed `SusuGroup`
// model (the design doc refers to this as "Susu" interchangeably).
// =============================================================================

class SusuRepo {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Read by id without privacy gating (caller is responsible for any 404).
   * @param {string} susuGroupId
   * @param {object} client - optional Prisma transaction client
   */
  findById(susuGroupId, client = this.prisma) {
    return client.susuGroup.findUnique({
      where: { id: susuGroupId },
    });
  }

  /**
   * Read with members + cycles + groupChat eager-loaded.
   */
  findByIdWithRelations(susuGroupId, client = this.prisma) {
    return client.susuGroup.findUnique({
      where: { id: susuGroupId },
      include: {
        members: { orderBy: { cycleSlot: 'asc' } },
        cycles:  { orderBy: { cycleNumber: 'asc' } },
        groupChat: true,
      },
    });
  }

  /**
   * List Susus where the given user is a member, optionally filtered by
   * SusuStatus or SusuMemberStatus.
   */
  listForUser({ userId, susuStatus, memberStatus, take = 20, cursor }) {
    const where = {
      members: {
        some: {
          userId,
          ...(memberStatus && { status: memberStatus }),
        },
      },
      ...(susuStatus && { status: susuStatus }),
    };
    return this.prisma.susuGroup.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      include: {
        members: { where: { userId } },
        cycles: {
          where: { status: 'PENDING' },
          orderBy: { cycleNumber: 'asc' },
          take: 1,
        },
      },
    });
  }

  setActivation(susuGroupId, { activatedAt, contractVersion, contractHash }, client = this.prisma) {
    return client.susuGroup.update({
      where: { id: susuGroupId },
      data: { status: 'ACTIVE', activatedAt, contractVersion, contractHash },
    });
  }

  freezeForDispute(susuGroupId, { reason }, client = this.prisma) {
    return client.susuGroup.update({
      where: { id: susuGroupId },
      data: { status: 'FROZEN_DISPUTE', frozenAt: new Date(), frozenReason: reason },
    });
  }

  cancel(susuGroupId, client = this.prisma) {
    return client.susuGroup.update({
      where: { id: susuGroupId },
      data: { status: 'CANCELLED' },
    });
  }

  markCompleted(susuGroupId, client = this.prisma) {
    return client.susuGroup.update({
      where: { id: susuGroupId },
      data: { status: 'COMPLETED' },
    });
  }
}

module.exports = SusuRepo;
