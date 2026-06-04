// services/susu/susuMember.service.js
// =============================================================================
// SusuMember_Service — Req 14
//
// The single mutator of `SusuMember.status`. Every transition flows through
// here and is validated against the canonical state machine:
//
//   PENDING_VOUCH   → PENDING_CONTRACT     (KYC + PoR satisfied, Req 14.2)
//   PENDING_CONTRACT → ACTIVE              (Liability_Contract accepted, Req 14.3)
//   ACTIVE          → DEFAULTED            (Default_Event, Req 14.4)
//   ACTIVE          → REMOVED              (operator action)
//   ACTIVE          → PENDING_VOUCH        (KYC/PoR revoked, Req 14.5)
//
// All other transitions are forbidden (Req 14.6).
// =============================================================================

const { SusuError, ErrorCodes } = require('./errors');
const SusuMemberRepo = require('../../repositories/susuMemberRepo');
const SusuRepo = require('../../repositories/susuRepo');

class SusuMemberService {
  constructor(prisma) {
    this.prisma = prisma;
    this.memberRepo = new SusuMemberRepo(prisma);
    this.susuRepo = new SusuRepo(prisma);
  }

  // ── Internal: assert allowed transition ──────────────────────────────
  _assertAllowed(fromStatus, toStatus) {
    const ALLOWED = {
      PENDING_VOUCH:    new Set(['PENDING_CONTRACT']),
      PENDING_CONTRACT: new Set(['ACTIVE']),
      ACTIVE:           new Set(['DEFAULTED', 'REMOVED', 'PENDING_VOUCH']),
      DEFAULTED:        new Set(),
      REMOVED:          new Set(),
    };
    const allowed = ALLOWED[fromStatus];
    if (!allowed || !allowed.has(toStatus)) {
      throw new SusuError(
        ErrorCodes.SUSU_VALIDATION_FAILED,
        `Forbidden SusuMember transition: ${fromStatus} → ${toStatus}`,
        409,
      );
    }
  }

  /**
   * Promote a single SusuMember row from PENDING_VOUCH to PENDING_CONTRACT
   * iff the User's KYC + PoR are both VERIFIED. Idempotent: returns the
   * row unchanged when the gate is not yet satisfied.
   */
  async transitionToPendingContractIfReady(memberId, tx = this.prisma) {
    const member = await tx.susuMember.findUnique({
      where: { id: memberId },
      include: { user: { select: { kycStatus: true, proofOfResidencyStatus: true } } },
    });
    if (!member) return null;
    if (member.status !== 'PENDING_VOUCH') return member;
    if (member.user.kycStatus !== 'VERIFIED') return member;
    if (member.user.proofOfResidencyStatus !== 'VERIFIED') return member;
    this._assertAllowed('PENDING_VOUCH', 'PENDING_CONTRACT');
    return this.memberRepo.updateStatus(memberId, 'PENDING_CONTRACT', {}, tx);
  }

  /**
   * Walk every PENDING_VOUCH SusuMember row of `userId` and try to flip
   * them to PENDING_CONTRACT. Called from the PoR approval transaction
   * (Req 14.2 fan-out).
   */
  async promotePendingVouchForUser(userId, tx = this.prisma) {
    const rows = await tx.susuMember.findMany({
      where: { userId, status: 'PENDING_VOUCH' },
      select: { id: true },
    });
    for (const r of rows) {
      await this.transitionToPendingContractIfReady(r.id, tx);
    }
    return rows.length;
  }

  /**
   * Flip PENDING_CONTRACT → ACTIVE. Called from inside the
   * acceptContract transaction once the LiabilityAcceptance row is
   * persisted (Req 14.3). After this flip, if every member of the
   * parent Susu is ACTIVE, the caller is responsible for invoking
   * Susu_Service.activateSusuIfReady.
   */
  async transitionToActive(memberId, tx = this.prisma) {
    const member = await tx.susuMember.findUnique({
      where: { id: memberId },
    });
    if (!member) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, 'SusuMember not found.', 404);
    }
    if (member.status === 'ACTIVE') return member; // idempotent
    this._assertAllowed(member.status, 'ACTIVE');
    return this.memberRepo.updateStatus(memberId, 'ACTIVE', { contractAcceptedAt: new Date() }, tx);
  }

  /**
   * Flip ACTIVE → DEFAULTED. Idempotent on duplicate Default_Event
   * triggers (Req 11.2).
   */
  async transitionToDefaulted(memberId, tx = this.prisma) {
    const member = await tx.susuMember.findUnique({ where: { id: memberId } });
    if (!member) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, 'SusuMember not found.', 404);
    }
    if (member.status === 'DEFAULTED') return member; // idempotent — Property 13
    this._assertAllowed(member.status, 'DEFAULTED');
    return this.memberRepo.updateStatus(memberId, 'DEFAULTED', { defaultedAt: new Date() }, tx);
  }

  /**
   * Reverse-transition from ACTIVE back to PENDING_VOUCH (Req 14.5 / 2.6),
   * triggered by the PoR_Expiry_Sweep when a member's residency expires
   * mid-cycle. Caller is responsible for flipping the parent Susu back
   * to CONFIGURING (handled by Susu_Service).
   */
  async revertActiveToPendingVouch(memberId, tx = this.prisma) {
    const member = await tx.susuMember.findUnique({ where: { id: memberId } });
    if (!member) return null;
    if (member.status !== 'ACTIVE') return member;
    this._assertAllowed('ACTIVE', 'PENDING_VOUCH');
    return this.memberRepo.updateStatus(memberId, 'PENDING_VOUCH', {}, tx);
  }
}

module.exports = SusuMemberService;
