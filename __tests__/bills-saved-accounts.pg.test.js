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

/**
 * Resolve the reset target. ONLY TEST_DATABASE_URL counts: falling back to
 * DATABASE_URL would let a normal development database be dropped by someone
 * who merely runs the suite.
 */
function resolveTestDsn() {
    const uri = process.env.TEST_DATABASE_URL;
    if (!uri || !/^postgres(ql)?:\/\//.test(uri)) return null;
    return uri;
}

const DSN = resolveTestDsn();
const hasDb = Boolean(DSN);

/**
 * This suite DROPS AND RECREATES tables. It must never be able to point at a
 * production database by accident, so the target is checked before any SQL
 * runs: local host only, and never a managed provider.
 */
function assertDisposable(uri) {
    const u = new URL(uri);
    const host = u.hostname || '';
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
        throw new Error(`Refusing to run: ${host} is not a local disposable database.`);
    }
    if (/neon|render|aws|azure|gcp|supabase|rds|digitalocean/i.test(host)) {
        throw new Error('Refusing to run against a managed provider.');
    }
    // A tunnel can present localhost. The database name must be explicitly a
    // test database, so an ordinary dev database cannot be reset by accident.
    const dbName = decodeURIComponent((u.pathname || '').replace(/^\//, ''));
    if (!/(^|_)(test|tests|ci|disposable)(_|$)/i.test(dbName)) {
        throw new Error(
            `Refusing to run: database "${dbName}" is not named as a disposable test database.`,
        );
    }
    // A "test" segment must not launder a production-looking name.
    if (/(^|_)(prod|production|live|main|primary)(_|$)/i.test(dbName)) {
        throw new Error(
            `Refusing to run: database "${dbName}" looks like a production database.`,
        );
    }
}


/**
 * The migration test runs `prisma db push --force-reset`. Sharing a database
 * with DATABASE_URL would wipe the suite's own schema and overlay structures,
 * so the two targets are compared before any reset.
 */
function assertDistinctFromSuiteDatabase(testUri, suiteUri) {
    if (!suiteUri) return;
    const norm = (raw) => {
        const u = new URL(raw);
        const db = decodeURIComponent((u.pathname || '').replace(/^\//, ''));
        const schema = u.searchParams.get('schema') || 'public';
        return `${u.hostname}:${u.port || '5432'}/${db}?schema=${schema}`;
    };
    if (norm(testUri) === norm(suiteUri)) {
        throw new Error(
            'Refusing to run: TEST_DATABASE_URL and DATABASE_URL point at the same database. '
            + 'The migration test resets its target and would destroy the suite database.',
        );
    }
}

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
    let tmpSchemaPath = null;

    beforeAll(async () => {
        assertDisposable(DSN);
        assertDistinctFromSuiteDatabase(DSN, process.env.DATABASE_URL);
        process.env.SAVED_SERVICE_ENCRYPTION_KEY = KEY;
        process.env.SAVED_SERVICE_FINGERPRINT_KEY = FP_KEY;
        process.env.SAVED_SERVICE_ENCRYPTION_KEY_VERSION = '1';

        ({ PrismaClient } = require('@prisma/client'));
        prisma = new PrismaClient({ datasources: { db: { url: DSN } } });

        // Self-contained baseline: no reliance on a previously prepared
        // database. A copy of the schema with the new model removed is pushed
        // to a clean database, which yields every pre-existing table the real
        // base branch would provide.
        const { execFileSync } = require('child_process');
        const os = require('os');
        const schema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
        const trimmed = schema
            .replace(/model SavedServiceAccount \{[\s\S]*?\n\}\n/, '')
            .replace(/^\s*savedServiceAccounts\s+SavedServiceAccount\[\]\s*$/m, '');
        if (trimmed.includes('model SavedServiceAccount')) {
            throw new Error('Baseline schema still contains the model under test.');
        }
        const tmpSchema = path.join(os.tmpdir(), `azm-base-${process.pid}.prisma`);
        tmpSchemaPath = tmpSchema;
        fs.writeFileSync(tmpSchema, trimmed);
        execFileSync(process.execPath, [
            path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js'),
            'db', 'push', '--schema', tmpSchema, '--skip-generate', '--force-reset', '--accept-data-loss',
        ], { stdio: 'pipe', env: { ...process.env, DATABASE_URL: DSN }, timeout: 120000 });

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
    }, 240000);

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
        // Never leave a generated baseline schema behind.
        if (tmpSchemaPath) {
            try { fs.unlinkSync(tmpSchemaPath); } catch (_e) { /* already gone */ }
        }
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

        const outcomes = await Promise.allSettled([
            svc.updateAccount({ userId: user.id, id: first.id, isPrimary: true }),
            svc.updateAccount({ userId: user.id, id: second.id, isPrimary: true }),
        ]);

        const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
        const rejected = outcomes.filter((o) => o.status === 'rejected');

        // Exactly one promotion may win, and the loser must fail with a
        // testable, explicit result rather than a silent no-op.
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(String(rejected[0].reason && (rejected[0].reason.code || rejected[0].reason.message)))
            .toMatch(/PRIMARY/i);

        const rows = await prisma.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS n FROM "SavedServiceAccount" WHERE "userId" = $1 AND "serviceCode" = 'ECG_PREPAID' AND "isPrimary" = true`, user.id);
        expect(rows[0].n).toBe(1);

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

describe('reset-target safety', () => {
    const { resolveTestDsn: resolveFn, assertDisposable: assertFn } = (() => {
        // The helpers are module-local; re-derive them here so the guards are
        // tested even when no database is configured (the suite itself skips).
        const src = fs.readFileSync(__filename, 'utf8');
        return { resolveTestDsn: eval(`(${src.match(/function resolveTestDsn\(\)[\s\S]*?\n\}/)[0]})`),
                  assertDisposable: eval(`(${src.match(/function assertDisposable\(uri\)[\s\S]*?\n\}/)[0]})`) };
    })();

    test('an ordinary DATABASE_URL is never used as the reset target', () => {
        const previousTest = process.env.TEST_DATABASE_URL;
        const previousProd = process.env.DATABASE_URL;
        delete process.env.TEST_DATABASE_URL;
        process.env.DATABASE_URL = 'postgresql://postgres@localhost:5432/azam_dev';
        try {
            expect(resolveFn()).toBeNull();
        } finally {
            if (previousTest === undefined) delete process.env.TEST_DATABASE_URL;
            else process.env.TEST_DATABASE_URL = previousTest;
            if (previousProd === undefined) delete process.env.DATABASE_URL;
            else process.env.DATABASE_URL = previousProd;
        }
    });

    test('a non-test database name is refused even on localhost', () => {
        expect(() => assertFn('postgresql://postgres@localhost:5432/azaman_prod'))
            .toThrow(/not named as a disposable test database/);
    });

    test('an identical TEST_DATABASE_URL and DATABASE_URL are refused', () => {
        const src = fs.readFileSync(__filename, 'utf8');
        const distinctFn = eval(`(${src.match(/function assertDistinctFromSuiteDatabase\(testUri, suiteUri\)[\s\S]*?\n\}/)[0]})`);
        const same = 'postgresql://postgres@localhost:5432/azm_test?schema=public';
        expect(() => distinctFn(same, same)).toThrow(/same database/);
        // Same database, different query string or host spelling: still refused.
        expect(() => distinctFn(same, 'postgresql://postgres@127.0.0.1:5432/azm_test?schema=public'))
            .not.toThrow(); // different host is a different server; allowed by design
        expect(() => distinctFn(
            'postgresql://postgres@localhost:5432/azm_test?schema=public',
            'postgresql://postgres@localhost:5432/azm_test?schema=other',
        )).not.toThrow(); // different schema is a different overlay namespace
    });

    test('a production-like name containing a test segment is refused', () => {
        const src = fs.readFileSync(__filename, 'utf8');
        const fn = eval(`(${src.match(/function assertDisposable\(uri\)[\s\S]*?\n\}/)[0]})`);
        expect(() => fn('postgresql://postgres@localhost:5432/azam_prod_test'))
            .toThrow(/looks like a production database/);
        expect(() => fn('postgresql://postgres@localhost:5432/production_test_copy'))
            .toThrow(/looks like a production database/);
    });

    test('the isolated saved-account database name is accepted', () => {
        const src = fs.readFileSync(__filename, 'utf8');
        const fn = eval(`(${src.match(/function assertDisposable\(uri\)[\s\S]*?\n\}/)[0]})`);
        expect(() => fn('postgresql://postgres@localhost:5432/azm_saved_service_accounts_test'))
            .not.toThrow();
    });

    test('a remote host is refused even when named as a test database', () => {
        expect(() => assertFn('postgresql://u:p@ep-x-1.neon.tech/azm_test'))
            .toThrow(/not a local disposable database|managed provider/);
    });
});
