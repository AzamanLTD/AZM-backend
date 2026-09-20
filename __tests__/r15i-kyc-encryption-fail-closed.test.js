// __tests__/r15i-kyc-encryption-fail-closed.test.js
// r15 follow-up: production fail-closed contract for KYC field encryption.
// A government identifier must NEVER be writable in plaintext because of a
// missing/invalid ENCRYPTION_KEY in production. Outside production the
// fail-soft passthrough is preserved for local/test ergonomics.
//
// Real PostgreSQL: the live-service guard test creates a real user row and
// proves the verification is refused BEFORE any provider I/O and before any
// status/PII mutation.

const fieldCipher = require('../services/crypto/fieldCipher');
const DojahKycService = require('../services/dojahKycService');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const saveEnv = () => ({
    NODE_ENV: process.env.NODE_ENV,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
});
const restoreEnv = (env) => {
    process.env.NODE_ENV = env.NODE_ENV;
    if (env.ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = env.ENCRYPTION_KEY;
};
const withEnv = async (patch, fn) => {
    const saved = saveEnv();
    Object.assign(process.env, patch);
    try { return await fn(); } finally { restoreEnv(saved); }
};

const VALID_KEY = 'a'.repeat(64); // 64 hex chars → 32 bytes
const INVALID_KEY = 'tooshort';

describe('r15i: KYC encryption fail-closed production contract', () => {
    afterEach(() => {
        // Non-crypto logger throttle state does not leak between tests.
    });

    test('production + missing key: encrypt() REFUSES the write', async () => {
        await withEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: undefined }, async () => {
            delete process.env.ENCRYPTION_KEY;
            expect(fieldCipher.isKeyAvailable()).toBe(false);
            expect(() => fieldCipher.encrypt('GHA-1234567890')).toThrow(/REFUSED/);
        });
    });

    test('production + INVALID key (wrong length): encrypt() REFUSES the write', async () => {
        await withEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: INVALID_KEY }, async () => {
            expect(fieldCipher.isKeyAvailable()).toBe(false);
            expect(() => fieldCipher.encrypt('GHA-1234567890')).toThrow(/REFUSED/);
        });
    });

    test('production + valid key: encrypt() returns the enc:v1 envelope and decrypts', async () => {
        await withEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: VALID_KEY }, async () => {
            expect(fieldCipher.isKeyAvailable()).toBe(true);
            const enc = fieldCipher.encrypt('GHA-1234567890');
            expect(enc.startsWith('enc:v1:')).toBe(true);
            expect(enc).not.toContain('GHA-1234567890');
            expect(fieldCipher.decrypt(enc)).toBe('GHA-1234567890');
        });
    });

    test('non-production (test/dev) + missing key: fail-soft passthrough preserved', async () => {
        await withEnv({ NODE_ENV: 'test', ENCRYPTION_KEY: undefined }, async () => {
            delete process.env.ENCRYPTION_KEY;
            expect(fieldCipher.isKeyAvailable()).toBe(false);
            expect(fieldCipher.encrypt('GHA-1234567890')).toBe('GHA-1234567890');
        });
    });

    test('idempotency never throws: an already-encrypted value passes through even without a key', async () => {
        let enc;
        await withEnv({ NODE_ENV: 'test', ENCRYPTION_KEY: VALID_KEY }, async () => {
            enc = fieldCipher.encrypt('GHA-1234567890');
        });
        await withEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: undefined }, async () => {
            delete process.env.ENCRYPTION_KEY;
            // No NEW plaintext is written — rewriting an envelope must not refuse.
            expect(fieldCipher.encrypt(enc)).toBe(enc);
        });
    });

    test('LIVE SERVICE (real PG): production + missing key refuses verification BEFORE provider I/O and leaves the user untouched', async () => {
        const user = await prisma.user.create({
            data: {
                username: `r15i-kyc-${Date.now()}`,
                email: `r15i-kyc-${Date.now()}@test.local`,
                password: 'x',
                kycStatus: 'UNVERIFIED',
            },
        });
        try {
            const svc = new DojahKycService(prisma, null);
            let ioHappened = false;
            svc.http = { get: async () => { ioHappened = true; throw new Error('provider I/O must not happen'); } };

            const result = await withEnv(
                { NODE_ENV: 'production', ENCRYPTION_KEY: undefined, DOJAH_APP_ID: 'app', DOJAH_PRIVATE_KEY: 'key' },
                async () => {
                    delete process.env.ENCRYPTION_KEY;
                    return svc.initializeSession({
                        userId: user.id,
                        idType: 'passport',
                        idNumber: 'GHA-1234567890',
                    });
                },
            );

            expect(result.success).toBe(false);
            expect(result.message).toMatch(/temporarily unavailable/i);
            expect(ioHappened).toBe(false); // no provider I/O

            const after = await prisma.user.findUnique({ where: { id: user.id }, select: { kycStatus: true, idNumber: true, idType: true } });
            expect(after.kycStatus).toBe('UNVERIFIED'); // no PENDING stamp, no mutation
            expect(after.idNumber).toBeNull();
            expect(after.idType).toBeNull();
        } finally {
            await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
        }
    });

    test('LIVE SERVICE (real PG): production + valid key verifies and stores ONLY the envelope', async () => {
        const user = await prisma.user.create({
            data: {
                username: `r15i-kyc-ok-${Date.now()}`,
                email: `r15i-kyc-ok-${Date.now()}@test.local`,
                password: 'x',
                kycStatus: 'UNVERIFIED',
            },
        });
        try {
            const svc = new DojahKycService(prisma, null);
            svc.http = {
                get: async () => ({
                    data: { entity: { first_name: 'Test', last_name: 'User', full_name: 'Test User', confidence: 99 } },
                }),
            };

            const result = await withEnv(
                { NODE_ENV: 'production', ENCRYPTION_KEY: VALID_KEY, DOJAH_APP_ID: 'app', DOJAH_PRIVATE_KEY: 'key' },
                async () => svc.initializeSession({
                    userId: user.id,
                    idType: 'passport',
                    idNumber: 'GHA-1234567890',
                }),
            );

            expect(result.success).toBe(true);
            const after = await prisma.user.findUnique({ where: { id: user.id }, select: { kycStatus: true, idNumber: true } });
            expect(after.kycStatus).toBe('VERIFIED');
            expect(after.idNumber.startsWith('enc:v1:')).toBe(true); // NEVER plaintext
            expect(after.idNumber).not.toContain('GHA-1234567890');
        } finally {
            await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
        }
    });

    afterAll(async () => { await prisma.$disconnect(); });
});
