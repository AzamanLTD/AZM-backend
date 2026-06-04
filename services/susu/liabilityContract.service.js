// services/susu/liabilityContract.service.js
// =============================================================================
// LiabilityContract_Service — Req 4
//
// Owns:
//   - Active version lookup
//   - Per-Susu pinned contract retrieval
//   - Idempotent acceptance writes (ipAddress + userAgent captured)
//   - Admin publish-new-version flow with SHA-256 hash on body
// =============================================================================

const crypto = require('crypto');
const LiabilityContractRepo = require('../../repositories/liabilityContractRepo');
const { SusuError, ErrorCodes, susuNotFound } = require('./errors');

class LiabilityContractService {
  constructor(prisma) {
    this.prisma = prisma;
    this.repo = new LiabilityContractRepo(prisma);
  }

  /**
   * Most-recently-published contract. Returned by the public endpoint
   * GET /api/liability-contract/active.
   */
  async getActiveContract() {
    const row = await this.repo.getActiveContract();
    if (!row) throw susuNotFound();
    return row;
  }

  /**
   * Resolve the contract pinned to a specific SusuGroup. Falls back to
   * the active contract when no pin has been recorded yet (the SusuGroup
   * is still in CONFIGURING and contractVersion is null).
   */
  async getContractForSusu(susuGroupId) {
    const susu = await this.prisma.susuGroup.findUnique({
      where: { id: susuGroupId },
      select: { contractVersion: true, contractHash: true },
    });
    if (!susu) throw susuNotFound();
    if (!susu.contractVersion) {
      return this.getActiveContract();
    }
    const row = await this.repo.getByVersion(susu.contractVersion);
    if (!row) throw new SusuError(
      ErrorCodes.SUSU_VALIDATION_FAILED,
      'Pinned contract version no longer exists',
      500
    );
    return row;
  }

  /**
   * Idempotent acceptance write. Re-running the same accept call returns
   * the previously-persisted row without creating a duplicate (Property
   * 12, Req 4.7).
   *
   * Caller is responsible for: (a) verifying the SusuMember row is in
   * PENDING_CONTRACT, (b) running this inside a transaction together
   * with the SusuMember status flip to ACTIVE, (c) supplying the
   * client's ip/user-agent.
   *
   * PHASE 6 / Phase 4: now also persists acknowledgedClauses (JSON array
   * of clause keys the user ticked in the Consent_Gate modal) and
   * voucherUserId (the User.id of the member who vouched for this user).
   */
  async acceptContract(
    { userId, susuGroupId, contractVersion, contractHash, agreed, ipAddress, userAgent, acknowledgedClauses, voucherUserId },
    tx = this.prisma,
  ) {
    if (agreed !== true) {
      throw new SusuError(
        ErrorCodes.CONTRACT_NOT_AGREED,
        'You must explicitly accept the liability contract.',
        400,
      );
    }

    // Version + hash mismatch guard (Req 4.5)
    const susu = await tx.susuGroup.findUnique({
      where: { id: susuGroupId },
      select: { contractVersion: true, contractHash: true },
    });
    if (!susu) throw susuNotFound();

    const expectedVersion = susu.contractVersion;
    const expectedHash    = susu.contractHash;

    // If the Susu hasn't pinned a contract yet (first acceptance kicks
    // it off), pin it on the spot from the active contract — this
    // happens for the first member to accept and is idempotent for the
    // rest because we re-read the pin on every call.
    let pinned = expectedVersion && expectedHash;
    if (!pinned) {
      const active = await this.repo.getActiveContract();
      if (!active) {
        throw new SusuError(
          ErrorCodes.SUSU_VALIDATION_FAILED,
          'No active liability contract published.',
          500,
        );
      }
      if (active.version !== contractVersion || active.contractHash !== contractHash) {
        throw new SusuError(
          ErrorCodes.CONTRACT_VERSION_MISMATCH,
          'Submitted contract version or hash does not match the active contract.',
          409,
        );
      }
      await tx.susuGroup.update({
        where: { id: susuGroupId },
        data: { contractVersion: active.version, contractHash: active.contractHash },
      });
    } else {
      if (expectedVersion !== contractVersion || expectedHash !== contractHash) {
        throw new SusuError(
          ErrorCodes.CONTRACT_VERSION_MISMATCH,
          'Submitted contract version or hash does not match this Susu pinned contract.',
          409,
        );
      }
    }

    // Idempotency (Req 4.7): if the row already exists, return it.
    const existing = await this.repo.findAcceptance(
      { userId, susuGroupId, contractVersion },
      tx,
    );
    if (existing) return existing;

    return this.repo.createAcceptance(
      {
        userId,
        susuGroupId,
        contractVersion,
        contractHash,
        ipAddress,
        userAgent,
        acknowledgedClauses,
        voucherUserId,
      },
      tx,
    );
  }

  /**
   * Admin publish flow. Hash is computed server-side from the body so
   * clients cannot lie about the SHA-256.
   */
  async publishNewVersion({ adminUserId, version, body }) {
    if (!version || typeof version !== 'string' || version.length > 32) {
      throw new SusuError(
        ErrorCodes.SUSU_VALIDATION_FAILED,
        'version is required and must be ≤32 chars.',
        400,
      );
    }
    if (!body || typeof body !== 'string' || body.length < 100) {
      throw new SusuError(
        ErrorCodes.SUSU_VALIDATION_FAILED,
        'body is required and must be at least 100 chars.',
        400,
      );
    }
    const contractHash = crypto.createHash('sha256').update(body).digest('hex');

    try {
      return await this.repo.publishVersion({ version, contractHash, body, publishedBy: adminUserId });
    } catch (err) {
      if (err.code === 'P2002') {
        throw new SusuError(
          ErrorCodes.CONTRACT_VERSION_DUPLICATE,
          `Contract version ${version} already published.`,
          409,
        );
      }
      throw err;
    }
  }
}

module.exports = LiabilityContractService;
