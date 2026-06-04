// services/authTokenService.js
// =============================================================================
// AZAMAN — Phase K auth token service
//
// Single source of truth for issuing, verifying, refreshing, and revoking
// access + refresh tokens. Used by authController (login, register),
// ssoController (SSO sign-in), and the new refreshController (rotate
// + logout).
//
// Why a service?
//   - Token shape is shared across four entry points; duplicating the
//     `jwt.sign(...)` literal in each is how it drifts.
//   - Refresh-token issuance + rotation has DB side effects (insert
//     RefreshToken, mark old as revoked). One place to get that right.
//   - Token-version revocation on role change is a write that has to
//     happen in the same transaction as the role flip; exposing
//     `revokeAllForUser(prisma, userId)` keeps callers from forgetting.
//
// Token shape:
//
//   ACCESS JWT (Bearer in Authorization header):
//     payload = {
//       id: number,
//       username: string,
//       role: 'USER' | 'VENDOR' | 'ADMIN',
//       tokenVersion: number,        ← Phase K. Compared to user.tokenVersion
//                                      in protect() to reject stale claims.
//       typ: 'access',
//     }
//     expiresIn: 15 minutes (override via JWT_ACCESS_EXPIRY env var)
//
//   REFRESH TOKEN (UUID, opaque):
//     stored in RefreshToken table; the wire value IS the row's id.
//     expires in 30 days (override via JWT_REFRESH_EXPIRY_DAYS env var)
//
// Backwards compatibility:
//   - Tokens issued *before* this Phase carry no `tokenVersion` claim. The
//     protect middleware treats a missing claim as 0. As long as the user's
//     live tokenVersion stays at 0 (default), pre-Phase tokens keep
//     working until they expire naturally on day 7. Once the user's
//     tokenVersion has been bumped (e.g., KYC approved), pre-Phase tokens
//     for that user are immediately rejected — which is the correct
//     behaviour: the privilege change should propagate.
// =============================================================================

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    // authController already crashes the process at boot if this is unset,
    // but require() ordering means this file might be imported first in
    // some hot-reload scenarios. Belt-and-braces.
    console.error('[authTokenService] FATAL: JWT_SECRET is not configured.');
}

const ACCESS_EXPIRY = process.env.JWT_ACCESS_EXPIRY || '15m';
const REFRESH_EXPIRY_DAYS = parseInt(process.env.JWT_REFRESH_EXPIRY_DAYS || '30', 10);

/**
 * Sign a fresh access token for the given user.
 *
 * @param {{id:number,username:string,role:string,tokenVersion:number}} user
 * @returns {string} signed JWT
 */
function signAccessToken(user) {
    // Phase K review-pass: every callsite should pass an explicit
    // tokenVersion. Defaulting to 0 silently masks programmer error —
    // an updated user fetched without selecting tokenVersion would mint
    // a JWT with claim 0 against a live row of N>0, and protect() would
    // reject every subsequent request with TOKEN_STALE that looks like
    // a middleware bug. Better to throw here at sign-time than to debug
    // a stale-token loop later.
    if (typeof user?.tokenVersion !== 'number') {
        throw new Error(
            '[authTokenService.signAccessToken] user.tokenVersion is required ' +
            '(missing or not a number). Pass a user object that includes ' +
            'tokenVersion in its select clause.'
        );
    }
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            role: user.role,
            tokenVersion: user.tokenVersion,
            typ: 'access',
        },
        JWT_SECRET,
        { expiresIn: ACCESS_EXPIRY }
    );
}

/**
 * Issue a brand-new refresh token row for the given user. Returns the
 * wire-value (uuid).
 *
 * @param {object} prisma Prisma client (req.app.get('prisma'))
 * @param {number} userId
 * @param {{userAgent?:string, ipAddress?:string}} [meta]
 * @returns {Promise<{token:string, expiresAt:Date}>}
 */
async function issueRefreshToken(prisma, userId, meta = {}) {
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await prisma.refreshToken.create({
        data: {
            id,
            userId,
            expiresAt,
            userAgent: meta.userAgent ?? null,
            ipAddress: meta.ipAddress ?? null,
        },
    });
    return { token: id, expiresAt };
}

/**
 * Issue an access + refresh token pair. The standard "fresh login" path.
 *
 * @returns {Promise<{accessToken:string, refreshToken:string, refreshExpiresAt:Date}>}
 */
async function issueTokenPair(prisma, user, meta = {}) {
    const accessToken = signAccessToken(user);
    const { token: refreshToken, expiresAt: refreshExpiresAt } = await issueRefreshToken(
        prisma,
        user.id,
        meta
    );
    return { accessToken, refreshToken, refreshExpiresAt };
}

/**
 * Rotate a refresh token: validate the inbound token, mark it revoked,
 * issue a new pair (access + refresh) for the same user. Returns null
 * when the inbound token is invalid / expired / revoked / missing user.
 *
 * The caller (refreshController) is responsible for translating null into
 * a 401 response.
 *
 * @param {object} prisma
 * @param {string} inboundRefreshToken
 * @param {{userAgent?:string, ipAddress?:string}} [meta]
 * @returns {Promise<null|{accessToken:string, refreshToken:string, refreshExpiresAt:Date, user:object}>}
 */
async function rotateRefreshToken(prisma, inboundRefreshToken, meta = {}) {
    if (!inboundRefreshToken || typeof inboundRefreshToken !== 'string') {
        return null;
    }

    // Single round-trip: row + user joined.
    const row = await prisma.refreshToken.findUnique({
        where: { id: inboundRefreshToken },
        include: {
            user: {
                select: {
                    id: true,
                    username: true,
                    role: true,
                    tokenVersion: true,
                    isDeleted: true,
                    banStatus: true,
                },
            },
        },
    });

    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    if (!row.user || row.user.isDeleted) return null;
    // Banned users can't refresh — they'd get a fresh 15-minute window of
    // access on every refresh otherwise.
    if (row.user.banStatus && row.user.banStatus !== 'ACTIVE') return null;

    // Phase K review-pass fix: revoke ATOMICALLY with a `revokedAt IS NULL`
    // guard so concurrent /refresh calls with the same token can't both
    // succeed. Postgres Read Committed makes the bare find-then-update
    // race-prone — both calls see revokedAt=null in the find, both write
    // a fresh timestamp in the update (no conflict), both then mint
    // new pairs from the same source token. The updateMany with the
    // null-guard is a single statement that the engine evaluates against
    // the latest committed row state; only the call that flips it from
    // null to timestamp gets count=1 and proceeds. The loser sees count=0
    // and bails as if the token had been revoked elsewhere — which it has.
    const rotated = await prisma.refreshToken.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: new Date() },
    });
    if (rotated.count !== 1) return null;

    const pair = await issueTokenPair(prisma, row.user, meta);
    return { ...pair, user: row.user };
}

/**
 * Revoke a single refresh token. Used by /api/auth/logout.
 * Idempotent: returns true if the token existed and is now revoked,
 * false if no such token (or already revoked).
 */
async function revokeRefreshToken(prisma, refreshToken) {
    if (!refreshToken || typeof refreshToken !== 'string') return false;
    try {
        const row = await prisma.refreshToken.update({
            where: { id: refreshToken },
            data: { revokedAt: new Date() },
        });
        return Boolean(row);
    } catch (e) {
        // P2025 = record not found
        if (e.code === 'P2025') return false;
        throw e;
    }
}

/**
 * Revoke EVERY active refresh token for a user. Used:
 *   - On role change (USER -> VENDOR via KYC approval)
 *   - On password change (already in scope of phase F's
 *     securityController.changePassword — wired in Phase K)
 *   - On admin-initiated forced logout
 *
 * Also bumps the user's tokenVersion so any in-flight access JWT becomes
 * invalid the moment the next request hits protect().
 *
 * Pass a `prisma` instance (or a transaction client) to keep this atomic
 * with the surrounding write — for the role-flip case, both the role
 * update AND the tokenVersion bump should land in the same transaction.
 *
 * @returns {Promise<{tokenVersion:number, revokedCount:number}>}
 */
async function revokeAllForUser(prisma, userId) {
    const [user, revoked] = await prisma.$transaction([
        prisma.user.update({
            where: { id: userId },
            data: { tokenVersion: { increment: 1 } },
            select: { tokenVersion: true },
        }),
        prisma.refreshToken.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: new Date() },
        }),
    ]);
    return { tokenVersion: user.tokenVersion, revokedCount: revoked.count };
}

module.exports = {
    signAccessToken,
    issueRefreshToken,
    issueTokenPair,
    rotateRefreshToken,
    revokeRefreshToken,
    revokeAllForUser,
    ACCESS_EXPIRY,
    REFRESH_EXPIRY_DAYS,
};
