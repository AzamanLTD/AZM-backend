/**
 * WP-I trusted-wallet overlay — the §5 proof requirements, on real PostgreSQL.
 *
 * The hand-off (docs/WP-I_TRUSTED_WALLET_OVERLAY_HANDOFF.md §5) asks for proof of
 * four things, not assertions:
 *   1. a clean disposable database gains the column and the index;
 *   2. a second run is a no-op;
 *   3. a database without FiatProviderEvent FAILS CLOSED and writes nothing;
 *   4. a partial failure leaves no misleading half-state.
 *
 * (3) is proved with a stub rather than by dropping a shared table, because
 * dropping FiatProviderEvent in a shared test database would damage every other
 * suite. The stub proves the ORDER OF OPERATIONS: the refusal happens before any
 * write is attempted, which is the property that matters.
 *
 * (4) is proved for real: a temporary SQL file whose second statement is invalid
 * must leave the column from the first statement ABSENT, which is only true if the
 * statements run in one transaction.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const {
    installWalletOverlay, statementsFromFile, WalletOverlayRefused, SQL_FILE, TABLE,
} = require('../infra/install-wp-i-observation-wallet-overlay');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const hasDb = Boolean(DB_URL);
const run = hasDb ? describe : describe.skip;

const columnExists = async (prisma, name) => {
    const rows = await prisma.$queryRawUnsafe(
        `SELECT 1 AS ok FROM information_schema.columns
          WHERE table_name = $1 AND column_name = $2`, TABLE, name);
    return rows.length === 1;
};

const indexExists = async (prisma, name) => {
    const rows = await prisma.$queryRawUnsafe(
        `SELECT 1 AS ok FROM pg_indexes WHERE tablename = $1 AND indexname = $2`, TABLE, name);
    return rows.length === 1;
};

run('WP-I wallet overlay installer (real PostgreSQL)', () => {
    let prisma;

    beforeAll(async () => {
        prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
        await prisma.$connect();
    }, 40000);

    afterAll(async () => {
        if (prisma) await prisma.$disconnect();
    });

    test('the SQL file is the single source of truth and is idempotent by construction', () => {
        const statements = statementsFromFile(SQL_FILE);
        expect(statements.length).toBeGreaterThanOrEqual(3);
        const joined = statements.join('; ');
        // Guarded statements only: no bare ADD COLUMN / CREATE INDEX.
        expect(joined).toContain('ADD COLUMN IF NOT EXISTS');
        expect(joined).toContain('CREATE INDEX IF NOT EXISTS');
        expect(joined).not.toMatch(/ADD COLUMN\s+"walletAccount"/);
    });

    test('a clean database gains the column and the index', async () => {
        await prisma.$executeRawUnsafe(`ALTER TABLE "${TABLE}" DROP COLUMN IF EXISTS "walletAccount"`);
        expect(await columnExists(prisma, 'walletAccount')).toBe(false);

        const result = await installWalletOverlay(prisma);
        expect(result.table).toBe(TABLE);
        expect(await columnExists(prisma, 'walletAccount')).toBe(true);
        expect(await indexExists(prisma, 'FiatProviderEvent_walletAccount_idx')).toBe(true);
    }, 60000);

    test('a second run is a no-op, not an error', async () => {
        await expect(installWalletOverlay(prisma)).resolves.toMatchObject({ table: TABLE });
        expect(await columnExists(prisma, 'walletAccount')).toBe(true);
        expect(await indexExists(prisma, 'FiatProviderEvent_walletAccount_idx')).toBe(true);
    }, 60000);

    test('the column is nullable: NULL means unknown, never a default', async () => {
        const [row] = await prisma.$queryRawUnsafe(
            `SELECT is_nullable FROM information_schema.columns
              WHERE table_name = $1 AND column_name = 'walletAccount'`, TABLE);
        expect(row.is_nullable).toBe('YES');
    }, 40000);

    test('a database without FiatProviderEvent fails closed BEFORE any write', async () => {
        const writes = [];
        const absent = {
            $queryRawUnsafe: async () => [{ reg: null }],
            $executeRawUnsafe: async (sql) => { writes.push(sql); },
            $transaction: async (fn) => fn({ $executeRawUnsafe: async (sql) => { writes.push(sql); } }),
        };
        await expect(installWalletOverlay(absent)).rejects.toBeInstanceOf(WalletOverlayRefused);
        // The decisive assertion: it refused without attempting a single write.
        expect(writes).toHaveLength(0);
    }, 40000);

    test('a partial failure leaves no half-state: the column is rolled back', async () => {
        await prisma.$executeRawUnsafe(`ALTER TABLE "${TABLE}" DROP COLUMN IF EXISTS "walletProbeTmp"`);
        const tmp = path.join(os.tmpdir(), `wallet-overlay-partial-${Date.now()}.sql`);
        fs.writeFileSync(tmp, [
            `ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "walletProbeTmp" TEXT;`,
            `CREATE INDEX IF NOT EXISTS "walletProbeTmp_idx" ON "${TABLE}" ("no_such_column_here");`,
        ].join('\n'));

        await expect(installWalletOverlay(prisma, { sqlFile: tmp })).rejects.toBeTruthy();
        // First statement would have succeeded on its own; the transaction must
        // have rolled it back.
        expect(await columnExists(prisma, 'walletProbeTmp')).toBe(false);
        fs.unlinkSync(tmp);
    }, 60000);
});
