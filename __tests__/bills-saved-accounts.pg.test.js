// __tests__/bills-saved-accounts.pg.test.js
// =============================================================================
// Real PostgreSQL proof for saved service accounts.
//
// `prisma db push` does not execute the handwritten migration, so it cannot
// prove the partial unique index or the CHECK constraints exist. This test
// applies the ACTUAL migration SQL to a clean database, asserts the resulting
// structure, then exercises the service against real Prisma.
//
// Runs when TEST_DATABASE_URL is set (CI provides PostgreSQL); skips loudly
// otherwise rather than pretending to have run.
// =============================================================================

const fs = require('fs');
const path = require('path');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const hasDb = Boolean(DSN && /^postgres(ql)?:\/\//.test(DSN));

const MIGRATIONS = [
    'prisma/migrations/20261030120000_saved_service_accounts/migration.sql',
    'prisma/migrations/20261030200000_saved_service_hardening/migration.sql',
];

const KEY = 'a'.repeat(64);
const FP_KEY = 'b'.repeat(64);

(hasDb ? describe : describe.skip)('saved service accounts against real PostgreSQL', () => {
    let PrismaClient;
    let prisma;
    let svc;

    beforeAll(async () => {
        process.env.SAVED_SERVICE_ENCRYPTION_KEY = KEY;
        process.env.SAVED_SERVICE_FINGERPRINT_KEY = FP_KEY;
        process.env.SAVED_SERVICE_ENCRYPTION_KEY_VERSION = '1';

        ({ PrismaClient } = require('@prisma/client'));
        prisma = new PrismaClient({ datasources: { db: { url: DSN } } });

        // Clean slate for the table under test.
        await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "SavedServiceAccount" CASCADE');

        for (const rel of MIGRATIONS) {
            const sql = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
            for (const statement of sql.split(/;\s*\n/)) {
                const trimmed = statement.trim();
                if (trimmed) await prisma.$executeRawUnsafe(trimmed);
            }
        }

        const { createService } = require('../services/bills/savedServiceAccountService');
        svc = createService({ prisma });
    }, 60000);

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    const ECG = { serviceCode: 'ECG_PREPAID', providerCode: 'ECG', nickname: 'Home', accountFields: { meterNumber: '0123456789' } };

    test('the migration created the table, indexes and constraints', async () => {
        const cols = await prisma.$queryRawUnsafe(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'SavedServiceAccount'`);
        const names = cols.map((c) => c.column_name);
        expect(names).toEqual(expect.arrayContaining([
            'accountDataCiphertext', 'accountDataKeyVersion', 'accountFingerprint',
            'accountMask', 'serviceTemplateVersion', 'verificationStatus', 'isPrimary',
        ]));

        const indexes = await prisma.$queryRawUnsafe(
            `SELECT indexname FROM pg_indexes WHERE tablename = 'SavedServiceAccount'`);
        const idx = indexes.map((i) => i.indexname);
        expect(idx).toContain('SavedServiceAccount_one_primary_per_service');
        expect(idx).toContain('SavedServiceAccount_userId_serviceCode_accountFingerprint_key');

        const checks = await prisma.$queryRawUnsafe(
            `SELECT conname FROM pg_constraint WHERE conrelid = '"SavedServiceAccount"'::regclass AND contype = 'c'`);
        expect(checks.map((c) => c.conname)).toEqual(expect.arrayContaining([
            'SavedServiceAccount_verificationStatus_check',
            'SavedServiceAccount_verifiedAt_check',
        ]));
    });

    test('create, list, rename, delete against real Prisma', async () => {
        const user = await prisma.user.create({
            data: { email: `svc-${Date.now()}@test.local`, username: `svc_${Date.now()}`,
                    password: 'x', azamanId: `AZM-SVC-${Date.now()}` },
        });

        const created = await svc.createAccount({ userId: user.id, ...ECG });
        expect(created.verificationStatus).toBe('UNVERIFIED');
        expect(created.serviceTemplateVersion).toBe('1');
        expect(JSON.stringify(created)).not.toContain('0123456789');

        const listed = await svc.listAccounts(user.id);
        expect(listed).toHaveLength(1);

        const renamed = await svc.updateAccount({ userId: user.id, id: created.id, nickname: 'Flat' });
        expect(renamed.nickname).toBe('Flat');

        await svc.deleteAccount({ userId: user.id, id: created.id });
        expect(await svc.listAccounts(user.id)).toHaveLength(0);

        await prisma.user.delete({ where: { id: user.id } });
    });

    test('the identifier is ciphertext at rest', async () => {
        const user = await prisma.user.create({
            data: { email: `ct-${Date.now()}@test.local`, username: `ct_${Date.now()}`,
                    password: 'x', azamanId: `AZM-CT-${Date.now()}` },
        });
        await svc.createAccount({ userId: user.id, ...ECG });

        const [row] = await prisma.$queryRawUnsafe(
            `SELECT "accountDataCiphertext", "accountFingerprint", "accountMask" FROM "SavedServiceAccount" WHERE "userId" = $1`, user.id);
        expect(row.accountDataCiphertext).not.toContain('0123456789');
        expect(row.accountDataCiphertext.startsWith('senc:v1:')).toBe(true);
        expect(row.accountMask).not.toContain('0123456789');

        await prisma.user.delete({ where: { id: user.id } });
    });

    test('the same identity for two members is two accounts', async () => {
        const stamp = Date.now();
        const a = await prisma.user.create({ data: { email: `a${stamp}@t.local`, username: `a${stamp}`, password: 'x', azamanId: `AZM-A${stamp}` } });
        const b = await prisma.user.create({ data: { email: `b${stamp}@t.local`, username: `b${stamp}`, password: 'x', azamanId: `AZM-B${stamp}` } });

        await svc.createAccount({ userId: a.id, ...ECG });
        await svc.createAccount({ userId: b.id, ...ECG });
        expect(await svc.listAccounts(a.id)).toHaveLength(1);
        expect(await svc.listAccounts(b.id)).toHaveLength(1);

        await prisma.user.delete({ where: { id: a.id } });
        await prisma.user.delete({ where: { id: b.id } });
    });

    test('duplicate creation is refused and concurrent duplicates collapse to one', async () => {
        const stamp = Date.now();
        const user = await prisma.user.create({ data: { email: `d${stamp}@t.local`, username: `d${stamp}`, password: 'x', azamanId: `AZM-D${stamp}` } });

        await svc.createAccount({ userId: user.id, ...ECG });
        await expect(svc.createAccount({ userId: user.id, ...ECG }))
            .rejects.toMatchObject({ code: 'SAVED_ACCOUNT_EXISTS' });

        const results = await Promise.allSettled(
            Array.from({ length: 4 }, () => svc.createAccount({
                userId: user.id, serviceCode: 'DSTV', providerCode: 'DSTV',
                nickname: 'TV', accountFields: { smartcardNumber: '1234567890' },
            })));
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rows = await prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS n FROM "SavedServiceAccount" WHERE "userId" = $1 AND "serviceCode" = 'DSTV'`, user.id);
        expect(rows[0].n).toBe(1);

        await prisma.user.delete({ where: { id: user.id } });
    });

    test('the partial index allows only one primary per service under concurrency', async () => {
        const stamp = Date.now();
        const user = await prisma.user.create({ data: { email: `p${stamp}@t.local`, username: `p${stamp}`, password: 'x', azamanId: `AZM-P${stamp}` } });

        const first = await svc.createAccount({ userId: user.id, ...ECG });
        const second = await svc.createAccount({
            userId: user.id, serviceCode: 'ECG_PREPAID', providerCode: 'ECG',
            nickname: 'Office', accountFields: { meterNumber: '9876543210' },
        });

        await Promise.allSettled([
            svc.updateAccount({ userId: user.id, id: first.id, isPrimary: true }),
            svc.updateAccount({ userId: user.id, id: second.id, isPrimary: true }),
        ]);

        const rows = await prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS n FROM "SavedServiceAccount" WHERE "userId" = $1 AND "serviceCode" = 'ECG_PREPAID' AND "isPrimary" = true`, user.id);
        expect(rows[0].n).toBeLessThanOrEqual(1);

        await prisma.user.delete({ where: { id: user.id } });
    });

    test('the database refuses a verification state outside the ladder', async () => {
        const stamp = Date.now();
        const user = await prisma.user.create({ data: { email: `v${stamp}@t.local`, username: `v${stamp}`, password: 'x', azamanId: `AZM-V${stamp}` } });
        const created = await svc.createAccount({ userId: user.id, ...ECG });

        await expect(prisma.$executeRawUnsafe(
            `UPDATE "SavedServiceAccount" SET "verificationStatus" = 'TRUST_ME' WHERE "id" = $1`, created.id))
            .rejects.toThrow();

        await prisma.user.delete({ where: { id: user.id } });
    });

    test('deleting the member cascades to their saved accounts', async () => {
        const stamp = Date.now();
        const user = await prisma.user.create({ data: { email: `c${stamp}@t.local`, username: `c${stamp}`, password: 'x', azamanId: `AZM-C${stamp}` } });
        await svc.createAccount({ userId: user.id, ...ECG });

        await prisma.user.delete({ where: { id: user.id } });
        const rows = await prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS n FROM "SavedServiceAccount" WHERE "userId" = $1`, user.id);
        expect(rows[0].n).toBe(0);
    });
});
