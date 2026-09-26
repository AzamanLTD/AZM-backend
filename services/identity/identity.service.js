// services/identity/identity.service.js
// =============================================================================
// IdentityService — Phase 6 / Social & Vouching Evolution
//
// Owns the Azaman_ID lifecycle and the privacy-preserving "find people"
// surface:
//
//   • generateUniqueAzamanId(tx) — mint a unique 'AZM-#########' id (literal
//     prefix + exactly 9 random digits), retrying on collision. Accepts an
//     optional transaction client so it can run inside the user-create txn.
//   • lookupByAzamanId(callerId, azamanId) — resolve a well-formed Azaman_ID
//     to a minimal public profile, rejecting malformed input and self-lookup.
//   • discoverByPhones(callerId, e164List) — match a batch of normalized phone
//     numbers against verified + discoverable users, projecting only the
//     public fields. Submitted numbers are NEVER persisted; they are hashed
//     in-memory only to compare without holding raw values longer than the
//     request, and the response never reveals which specific numbers matched
//     beyond returning the matched public profiles.
//
// Privacy contract (Requirement 18): every projection here is exactly
// { azamanId, displayName, avatar } — no User.id, email, balances, raw phone,
// or KYC fields ever leave this service.
// =============================================================================

const logger = require('../../src/config/logger');
const crypto = require('crypto');
const { hashPhone } = require('./phoneHash');

const AZAMAN_ID_RE = /^AZM-\d{9}$/;
const MAX_DISCOVER_PHONES = 1000; // hard cap per call (Requirement 4.6)

class IdentityError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

class IdentityService {
  constructor(prisma) {
    if (!prisma) throw new Error('IdentityService: prisma required');
    this.prisma = prisma;
  }

  // ── Generation ────────────────────────────────────────────────────────
  // Crypto-random 9-digit suffix. Uniqueness is enforced both by retry-on-
  // lookup here and by the DB unique index as the ultimate guard.
  _randomAzamanId() {
    // 9 digits: 0..999999999, zero-padded. crypto.randomInt is unbiased.
    const n = crypto.randomInt(0, 1_000_000_000);
    return `AZM-${String(n).padStart(9, '0')}`;
  }

  /**
   * Generate an Azaman_ID guaranteed unique against the DB. Pass `client`
   * (a tx) to run inside an existing transaction.
   * @returns {Promise<string>}
   */
  async generateUniqueAzamanId(client = this.prisma) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidate = this._randomAzamanId();
      const existing = await client.user.findUnique({
        where: { azamanId: candidate },
        select: { id: true },
      });
      if (!existing) return candidate;
    }
    // Astronomically unlikely with a 1-in-a-billion space at low volume;
    // surface loudly rather than loop forever.
    throw new IdentityError(
      'AZAMAN_ID_EXHAUSTED',
      'Could not generate a unique Azaman ID after multiple attempts.',
      500,
    );
  }

  // ── Lookup by Azaman ID ───────────────────────────────────────────────
  /**
   * @param {number} callerId
   * @param {string} azamanId
   * @returns {Promise<{azamanId, displayName, avatar}>}
   */
  async lookupByAzamanId(callerId, azamanId) {
    const value = (azamanId || '').trim();
    if (!AZAMAN_ID_RE.test(value)) {
      throw new IdentityError(
        'AZAMAN_ID_INVALID',
        'Azaman ID must look like AZM- followed by 9 digits.',
        400,
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { azamanId: value },
      select: {
        id: true,
        azamanId: true,
        username: true,
        displayName: true,
        profilePictureUrl: true,
        isDeleted: true,
      },
    });
    if (!user || user.isDeleted) {
      throw new IdentityError('USER_NOT_FOUND', 'No user with that Azaman ID.', 404);
    }
    if (callerId != null && user.id === callerId) {
      throw new IdentityError(
        'AZAMAN_ID_SELF',
        "That's your own Azaman ID.",
        400,
      );
    }
    return this._project(user);
  }

  // ── Contact discovery ─────────────────────────────────────────────────
  /**
   * Match a list of E.164 phone numbers against verified + discoverable
   * users, hash-to-hash. Submitted numbers are hashed in-memory and never
   * persisted; the only stored derivative is `User.phoneHash` (set at phone
   * verification). Returns only the matched public profiles (caller cannot
   * tell which specific numbers matched beyond receiving the profile rows).
   *
   * @param {number} callerId
   * @param {string[]} e164List
   * @returns {Promise<Array<{azamanId, displayName, avatar}>>}
   */
  async discoverByPhones(callerId, e164List) {
    if (!Array.isArray(e164List)) {
      throw new IdentityError('DISCOVERY_INVALID', 'phones must be an array.', 400);
    }
    if (e164List.length > MAX_DISCOVER_PHONES) {
      throw new IdentityError(
        'DISCOVERY_TOO_MANY',
        `At most ${MAX_DISCOVER_PHONES} numbers per request.`,
        400,
      );
    }

    // Hash + de-dupe in memory. We keep ONLY the hashed set for the duration
    // of this call; neither the raw numbers nor the hashes are written to the
    // DB. Raw numbers never reach the query — we match hash-to-hash.
    const hashes = new Set();
    for (const raw of e164List) {
      const h = hashPhone(raw);
      if (h) hashes.add(h);
    }
    if (hashes.size === 0) return [];

    const matches = await this.prisma.user.findMany({
      where: {
        phoneHash: { in: Array.from(hashes) },
        phoneVerified: true,
        discoverable: true,
        isDeleted: false,
        ...(callerId != null ? { id: { not: callerId } } : {}),
      },
      select: {
        id: true,
        azamanId: true,
        username: true,
        displayName: true,
        profilePictureUrl: true,
      },
    });
    // Only return users who have an azamanId (always true post-backfill).
    return matches.filter((m) => m.azamanId).map((m) => this._project(m));
  }

  // ── Discoverability toggle ────────────────────────────────────────────
  async setDiscoverable(userId, enabled) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { discoverable: enabled === true },
      select: { discoverable: true },
    });
    return updated;
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  _project(user) {
    return {
      azamanId: user.azamanId,
      displayName: user.displayName || user.username,
      avatar: user.profilePictureUrl || null,
    };
  }
}

module.exports = { IdentityService, IdentityError, AZAMAN_ID_RE };
