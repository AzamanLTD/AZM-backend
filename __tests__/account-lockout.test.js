// __tests__/account-lockout.test.js
// Unit tests for the account lockout middleware (Phase 2 Security).
// Pure logic tests — no database required.

const {
    MAX_FAILED_ATTEMPTS,
    LOCKOUT_DURATION_MS,
} = require('../middleware/accountLockout');

describe('Account Lockout — configuration', () => {
    test('MAX_FAILED_ATTEMPTS is 5', () => {
        expect(MAX_FAILED_ATTEMPTS).toBe(5);
    });

    test('LOCKOUT_DURATION_MS is 15 minutes', () => {
        expect(LOCKOUT_DURATION_MS).toBe(15 * 60 * 1000);
    });
});

describe('Account Lockout — checkLockout logic', () => {
    // Mock prisma that returns a user with a future lockedUntil
    const makeMockPrisma = (user) => ({
        user: {
            findUnique: async () => user,
            update: async ({ data }) => ({ ...user, ...data }),
        },
    });

    test('throws 423 when account is locked', async () => {
        const { checkLockout } = require('../middleware/accountLockout');
        const future = new Date(Date.now() + 10 * 60 * 1000); // 10 min from now
        const mockUser = { id: 1, password: 'hash', lockedUntil: future, failedLoginAttempts: 5 };
        const prisma = makeMockPrisma(mockUser);

        await expect(checkLockout(prisma, 'test@test.com')).rejects.toThrow(/Account temporarily locked/);
    });

    test('resets expired lockout and returns user', async () => {
        const { checkLockout } = require('../middleware/accountLockout');
        const past = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
        const mockUser = { id: 1, password: 'hash', lockedUntil: past, failedLoginAttempts: 5 };
        let updateCalled = false;
        const prisma = {
            user: {
                findUnique: async () => mockUser,
                update: async ({ data }) => { updateCalled = true; return { ...mockUser, ...data }; },
            },
        };

        const result = await checkLockout(prisma, 'test@test.com');
        expect(result).toBeTruthy();
        expect(result.id).toBe(1);
        expect(updateCalled).toBe(true);
    });

    test('returns null for unknown email', async () => {
        const { checkLockout } = require('../middleware/accountLockout');
        const prisma = {
            user: {
                findUnique: async () => null,
                update: async () => null,
            },
        };

        const result = await checkLockout(prisma, 'nonexistent@test.com');
        expect(result).toBeNull();
    });
});

describe('Account Lockout — recordFailedAttempt logic', () => {
    test('locks account when reaching MAX_FAILED_ATTEMPTS', async () => {
        const { recordFailedAttempt } = require('../middleware/accountLockout');
        let updates = [];
        const prisma = {
            user: {
                update: async ({ data }) => {
                    updates.push(data);
                    // Simulate increment: first update returns count = 5
                    if (data.failedLoginAttempts && data.failedLoginAttempts.increment) {
                        return { failedLoginAttempts: 5 };
                    }
                    return { lockedUntil: data.lockedUntil };
                },
            },
        };

        await recordFailedAttempt(prisma, 1);
        // Second update should have set lockedUntil
        expect(updates).toHaveLength(2);
        expect(updates[0].failedLoginAttempts.increment).toBe(1);
        expect(updates[1].lockedUntil).toBeTruthy();
    });

    test('does not lock when below threshold', async () => {
        const { recordFailedAttempt } = require('../middleware/accountLockout');
        let updateCount = 0;
        const prisma = {
            user: {
                update: async ({ data }) => {
                    updateCount++;
                    if (data.failedLoginAttempts && data.failedLoginAttempts.increment) {
                        return { failedLoginAttempts: 3 }; // Below threshold
                    }
                    return { lockedUntil: data.lockedUntil };
                },
            },
        };

        await recordFailedAttempt(prisma, 1);
        // Only one update (the increment), no lockout update
        expect(updateCount).toBe(1);
    });
});

describe('Account Lockout — resetFailedAttempts', () => {
    test('resets counter and lockedUntil', async () => {
        const { resetFailedAttempts } = require('../middleware/accountLockout');
        let lastUpdate = null;
        const prisma = {
            user: {
                update: async ({ data }) => { lastUpdate = data; return data; },
            },
        };

        await resetFailedAttempts(prisma, 1);
        expect(lastUpdate.failedLoginAttempts).toBe(0);
        expect(lastUpdate.lockedUntil).toBeNull();
    });
});
