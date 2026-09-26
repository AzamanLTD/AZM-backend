// repositories/susuMemberRepo.js
// =============================================================================
// Thin Prisma wrappers for SusuMember. The state machine itself lives in
// services/susu/susuMember.service.js — this repo is pure persistence.
// =============================================================================

class SusuMemberRepo {
  constructor(prisma) {
    this.prisma = prisma;
  }

  findById(id, client = this.prisma) {
    return client.susuMember.findUnique({ where: { id } });
  }

  findByUserAndSusu({ userId, susuGroupId }, client = this.prisma) {
    return client.susuMember.findUnique({
      where: { susuGroupId_userId: { susuGroupId, userId } },
    });
  }

  listActiveForCycle(susuGroupId, client = this.prisma) {
    return client.susuMember.findMany({
      where: { susuGroupId, status: 'ACTIVE' },
      orderBy: [{ cycleSlot: 'asc' }],
    });
  }

  listMembers(susuGroupId, client = this.prisma) {
    return client.susuMember.findMany({
      where: { susuGroupId },
      orderBy: [{ cycleSlot: 'asc' }],
    });
  }

  countByStatus(susuGroupId, status, client = this.prisma) {
    return client.susuMember.count({
      where: { susuGroupId, status },
    });
  }

  updateStatus(memberId, status, extra = {}, client = this.prisma) {
    return client.susuMember.update({
      where: { id: memberId },
      data: { status, ...extra },
    });
  }
}

module.exports = SusuMemberRepo;
