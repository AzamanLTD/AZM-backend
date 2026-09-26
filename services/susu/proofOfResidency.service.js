// services/susu/proofOfResidency.service.js
// =============================================================================
// ProofOfResidency_Service — Req 3
//
// Owns:
//   - File-validation (JPEG/PNG/PDF, 10 KB < size ≤ 10 MB)
//   - Cloudinary upload with 30s timeout
//   - Status transitions (NOT_SUBMITTED / PENDING_REVIEW / VERIFIED / REJECTED / EXPIRED)
//   - Re-upload guards
//   - Admin review (approve / reject with 1..500-char reason)
//
// Expiry transitions are owned by PoR_Expiry_Sweep (Phase 3) — this service
// reads the persisted column value and never computes expiry inline.
// =============================================================================

const logger = require('../../src/config/logger');
const { SusuError, ErrorCodes } = require('./errors');
const ProofOfResidencyRepo = require('../../repositories/proofOfResidencyRepo');
const SusuMemberService = require('./susuMember.service');
const { uploadToCloudinary } = require('../cloudinaryService');

const MIN_BYTES = 10 * 1024;          // strictly greater than 10 KB
const MAX_BYTES = 10 * 1024 * 1024;   // less than or equal to 10 MB
const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'application/pdf',
]);
const CLOUDINARY_TIMEOUT_MS = 30 * 1000;

class ProofOfResidencyService {
  constructor(prisma, { susuMemberService } = {}) {
    this.prisma = prisma;
    this.repo = new ProofOfResidencyRepo(prisma);
    this.susuMemberService = susuMemberService || new SusuMemberService(prisma);
  }

  async getOwnStatus(userId) {
    return this.repo.getStatus(userId);
  }

  /**
   * Multipart upload entrypoint. `multerFile` is the Express multer
   * file object: { mimetype, size, path, buffer? }.
   */
  async submitUpload(userId, multerFile) {
    if (!multerFile || !multerFile.size) {
      throw new SusuError(
        ErrorCodes.RESIDENCY_INVALID_FILE,
        'No file received.',
        400,
      );
    }
    if (!ALLOWED_MIMES.has(multerFile.mimetype)) {
      throw new SusuError(
        ErrorCodes.RESIDENCY_INVALID_FILE,
        `Unsupported file type ${multerFile.mimetype}. Only JPEG, PNG, PDF accepted.`,
        400,
      );
    }
    if (multerFile.size <= MIN_BYTES || multerFile.size > MAX_BYTES) {
      throw new SusuError(
        ErrorCodes.RESIDENCY_INVALID_FILE,
        `File size must be greater than ${MIN_BYTES} bytes and at most ${MAX_BYTES} bytes (got ${multerFile.size}).`,
        400,
      );
    }

    // Re-upload guard (Req 3.11): only NOT_SUBMITTED / REJECTED / EXPIRED may upload.
    const current = await this.repo.getStatus(userId);
    if (current && ['PENDING_REVIEW', 'VERIFIED'].includes(current.proofOfResidencyStatus)) {
      throw new SusuError(
        ErrorCodes.RESIDENCY_ALREADY_SUBMITTED,
        'A Proof of Residency document is already on file. Wait for review or expiry before re-uploading.',
        409,
      );
    }

    // Cloudinary with 30s timeout (Req 3.5).
    const uploadPromise = uploadToCloudinary(multerFile, 'proof-of-residency');
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Cloudinary timeout')), CLOUDINARY_TIMEOUT_MS),
    );
    let result;
    try {
      result = await Promise.race([uploadPromise, timeout]);
    } catch (err) {
      throw new SusuError(
        ErrorCodes.RESIDENCY_UPLOAD_FAILED,
        `Upload failed: ${err.message}`,
        502,
      );
    }
    if (!result || !result.url) {
      throw new SusuError(
        ErrorCodes.RESIDENCY_UPLOAD_FAILED,
        'Cloudinary did not return a secure URL.',
        502,
      );
    }

    return this.repo.recordSubmission(userId, { url: result.url });
  }

  async listReviewQueue(opts = {}) {
    return this.repo.listReviewQueue(opts);
  }

  /**
   * Admin review entrypoint. Decision is 'approve' or 'reject'. Reject
   * requires a 1..500-char reason (Req 3.7, 3.8).
   *
   * On approve, advances any PENDING_VOUCH SusuMember rows of this user
   * to PENDING_CONTRACT (Req 14.2) — same transaction.
   */
  async reviewSubmission({ adminUserId, targetUserId, decision, reason }) {
    if (!targetUserId) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, 'targetUserId required.', 400);
    }
    if (!['approve', 'reject'].includes(decision)) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, 'decision must be "approve" or "reject".', 400);
    }
    const current = await this.repo.getStatus(targetUserId);
    if (!current) {
      throw new SusuError(ErrorCodes.SUSU_VALIDATION_FAILED, 'User not found.', 404);
    }
    if (current.proofOfResidencyStatus !== 'PENDING_REVIEW') {
      throw new SusuError(
        ErrorCodes.SUSU_VALIDATION_FAILED,
        `User Proof of Residency is in ${current.proofOfResidencyStatus}, not PENDING_REVIEW.`,
        409,
      );
    }

    if (decision === 'reject') {
      const trimmed = (reason || '').trim();
      if (trimmed.length < 1 || trimmed.length > 500) {
        throw new SusuError(
          ErrorCodes.RESIDENCY_REASON_INVALID,
          'Rejection reason must be 1..500 characters.',
          400,
        );
      }
      return this.repo.recordRejection(targetUserId, { reason: trimmed });
    }

    // approve path — open a transaction so the User flip and any
    // SusuMember promotions land atomically.
    return this.prisma.$transaction(async (tx) => {
      const updated = await this.repo.recordApproval(targetUserId, tx);
      await this.susuMemberService.promotePendingVouchForUser(targetUserId, tx);
      return updated;
    });
  }
}

module.exports = ProofOfResidencyService;
