// __tests__/ewa-fee-enum-overlay.db.test.js
// PR #292 follow-up — EWA_FEE production schema authority.
//
// Production DDL is owned by the idempotent raw-SQL overlay installers
// (npm run release → infra/install-business-os-overlay.js), NOT by
// `prisma migrate deploy` / `prisma db push` (production has no
// _prisma_migrations table). CI databases get EWA_FEE via `prisma db push`
// from the schema, but the production database only receives it when the
// business-os overlay executes `ALTER TYPE "ProfitSource" ADD VALUE IF NOT
// EXISTS 'EWA_FEE'`.
//
// These proofs pin that chain to the overlay:
//   1. the real installer executes cleanly against the test database
//   2. the ProfitSource enum actually contains EWA_FEE afterwards
//   3. rerunning the installer is idempotent (guarded statement, 0 errors)
//   4. the application can create AdminProfitLog with source EWA_FEE and
//      upsert SystemProfitFees against that schema — the exact production
//      writes EwaService.requestWithdrawal performs for the 1% fee
//
// SKIPS unless TEST_DATABASE_URL is set.

const { spawnSync } = require('child_process');
const path = require('path');

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[ewa-fee-enum-overlay.db.test] TEST_DATABASE_URL not set — skipping.');

describeOrSkip('EWA_FEE production schema authority (business-os overlay)', () => {
    let prisma;

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    }, 30000);

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    const runInstaller = () => {
        return spawnSync(
            process.execPath,
            [path.join(__dirname, '..', 'infra', 'install-business-os-overlay.js')],
            {
                env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
                encoding: 'utf8',
                timeout: 120000,
            },
        );
    };

    const enumHasEwaFee = async () => {
        const rows = await prisma.$queryRawUnsafe(
            `SELECT e.enumlabel FROM pg_enum e
             JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'ProfitSource' AND e.enumlabel = 'EWA_FEE';`,
        );
        return rows.length === 1;
    };

    test('installer source declares the guarded additive enum statement (schema authority sanity)', () => {
        // Cheap static check: the DDL that production executes must remain in
        // the overlay (the single production schema authority). The dynamic
        // proofs below are the real gate.
        const fs = require('fs');
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'infra', 'install-business-os-overlay.js'),
            'utf8',
        );
        expect(src).toMatch(/ALTER TYPE "ProfitSource" ADD VALUE IF NOT EXISTS 'EWA_FEE'/);
    });

    test('installer executes cleanly and the enum contains exactly one EWA_FEE value', async () => {
        const res = runInstaller();
        expect(res.status).toBe(0);
        expect(String(res.stderr || '')).not.toMatch(/\[ERR\]/);
        expect(await enumHasEwaFee()).toBe(true);
    }, 120000);

    test('installer rerun is idempotent (guarded ALTER TYPE, no errors)', async () => {
        const res = runInstaller();
        expect(res.status).toBe(0);
        expect(String(res.stderr || '')).not.toMatch(/\[ERR\]/);
        expect(await enumHasEwaFee()).toBe(true); // still exactly one value
    }, 120000);

    test('application can realize the EWA fee against the production-shaped schema', async () => {
        // The exact production fee writes EwaService.requestWithdrawal performs
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "AdminProfitLog","SystemProfitFees" RESTART IDENTITY CASCADE');
        const { Prisma } = require('@prisma/client');
        const fee = new Prisma.Decimal('0.20');
        const log = await prisma.adminProfitLog.create({
            data: { source: 'EWA_FEE', amountUsdc: fee, relatedTxId: 'EWA_overlay_test_1' },
        });
        expect(log.source).toBe('EWA_FEE');
        await prisma.systemProfitFees.upsert({
            where: { id: 1 },
            update: { balance: { increment: fee } },
            create: { id: 1, balance: fee },
        });
        const rows = await prisma.systemProfitFees.findUnique({ where: { id: 1 } });
        expect(rows.balance.toString()).toBe('0.2');
    });
});
