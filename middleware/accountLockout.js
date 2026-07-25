// middleware/accountLockout.js
// =============================================================================
// Account lockout after consecutive failed login attempts (Phase 2 Security).
//
// Strategy: DB-backed (failedLoginAttempts + lockedUntil columns on User).
// After MAX_FAILED_ATTEMPTS consecutive failures the account is locked for
// LOCKOUT_DURATION_MINUTES. The counter resets on successful login.
//
// Usage in authController.login:
//   1. checkLockout(prisma, email)  → throws if locked, returns user
//   2. on failed password: recordFailedAttempt(prisma, user)
//   3. on success: resetFailedAttempts(prisma, user.id)
// =============================================================================

const logger = require('../src/config/logger');

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Check if the user's account is currently locked. Returns the user record
 * (or null if not found) so the caller can proceed with password verification.
 *
 * @throws {Error} with .status = 423 and .isLocked = true if the account is locked
 */
async function checkLockout(prisma, normalizedEmail) {
    const user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true, password: true, lockedUntil: true, failedLoginAttempts: true },
    });

    if (!user) return null;

    if (user.lockedUntil && user.lockedUntil > new Date()) {
        const remainingMs = user.lockedUntil.getTime() - Date.now();
        const remainingMin = Math.ceil(remainingMs / 60000);
        const err = new Error(`Account temporarily locked. Try again in ${remainingMin} minute(s).`);
        err.status = 423;
        err.isLocked = true;
        err.remainingMinutes = remainingMin;
        throw err;
    }

    // If the lockout period has expired, reset the counter silently
    if (user.lockedUntil && user.lockedUntil <= new Date()) {
        await prisma.user.update({
            where: { id: user.id },
            data: { failedLoginAttempts: 0, lockedUntil: null },
        });
    }

    return user;
}

/**
 * Record a failed login attempt. If the counter reaches MAX_FAILED_ATTEMPTS,
 * set lockedUntil to now + LOCKOUT_DURATION_MS.
 */
async function recordFailedAttempt(prisma, userId) {
    const user = await prisma.user.update({
        where: { id: userId },
        data: { failedLoginAttempts: { increment: 1 } },
        select: { failedLoginAttempts: true },
    });

    if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
        await prisma.user.update({
            where: { id: userId },
            data: { lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) },
        });
        logger.warn({ userId }, `Account locked after ${MAX_FAILED_ATTEMPTS} failed login attempts`);
    }
}

/**
 * Reset the failed attempt counter after a successful login.
 */
async function resetFailedAttempts(prisma, userId) {
    await prisma.user.update({
        where: { id: userId },
        data: { failedLoginAttempts: 0, lockedUntil: null },
    });
}

module.exports = {
    checkLockout,
    recordFailedAttempt,
    resetFailedAttempts,
    MAX_FAILED_ATTEMPTS,
    LOCKOUT_DURATION_MS,
};
