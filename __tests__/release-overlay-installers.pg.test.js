/**
 * Release-path proof for the two money installers, on a CLEAN DISPOSABLE DATABASE.
 *
 * WHY THIS SUITE EXISTS: in this repository production DDL is deployed ONLY by the
 * overlay installers run from `npm run release`; `prisma db push` is a dev/test
 * path and creates NO CHECK constraints. A suite that merely asserts "the Prisma
 * client can create a row" therefore proves nothing about production.
 *
 * This suite builds a brand-new empty database, gives it the PRE-OVERLAY shape
 * production actually has (a legacy BusinessOrder with a NOT NULL amountUsdc and
 * no currency column at all, and NO money-settings revision table), then runs the
 * shipped installers as child processes — the same commands the release chain
 * runs — and proves what they add, that the constraints bite, and that a re-run
 * is a no-op.
 *
 * It deliberately does NOT use `prisma db push` to build the database: that would
 * create the very columns and tables under test and hide the gap this suite is
 * meant to catch.
 */
const { execFileSync } = require('child_process');
const { Prisma } = require('@prisma/client');
const path = require('path');

const BASE = process.env.TEST_DATABASE_URL;
const hasDb = !!BASE;
if (!hasDb) console.warn('[release-overlays] TEST_DATABASE_URL not set — skipping.');

const DB = `azm_release_overlay_${process.pid}_${Date.now()}`;
const ROOT = path.join(__dirname, '..');

// A disposable database of our own means one code path: one server. We cannot
// CREATE DATABASE inside the database under test, so the admin connection strips
// the pathname and points at the maintenance database.
function baseUrl() {
    const u = new URL(BASE);
    return u;
}
function urlFor(db) {
    const u = baseUrl();
    u.pathname = `/${db}`;
    u.search = '';
    return u.toString();
}
const el = (name) => `"${name}"`;

const run = hasDb ? describe : describe.skip;

run('money installers on a clean disposable database (the release path)', () => {
    const { PrismaClient } = require('@prisma/client');
    let adminPg;
    let db;
    let runtime;
    const ROLE = 'azm_release_runtime';
    const RPW = 'release-runtime-pw';
    const urlForRole = (role, password) => {
        const u = baseUrl();
        u.username = role;
        u.password = password;
        u.pathname = `/${DB}`;
        u.search = '';
        return u.toString();
    };

    const psql = async (sql) => db.$executeRawUnsafe(sql);

    const runInstaller = (script) => execFileSync(process.execPath, [path.join('infra', script)], {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: urlFor(DB) },
        stdio: 'pipe',
    });

    const constraintNames = async (table) => {
        const rows = await db.$queryRawUnsafe(
            `SELECT conname FROM pg_constraint WHERE conrelid = '"${table}"'::regclass AND contype = 'c' ORDER BY 1`
        );
        return rows.map((r) => r.conname);
    };

    beforeAll(async () => {
        adminPg = new PrismaClient({ datasources: { db: { url: urlFor('postgres') } } });
        await adminPg.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${el(DB)} WITH (FORCE)`);
        await adminPg.$executeRawUnsafe(`CREATE DATABASE ${el(DB)}`);
        db = new PrismaClient({ datasources: { db: { url: urlFor(DB) } } });

        // Pre-overlay production shape: no currency, no amountGhs, amountUsdc NOT
        // NULL. This is what the historical db-push path left behind.
        await psql(`CREATE TABLE "BusinessOrder" (
            "id" TEXT PRIMARY KEY,
            "businessProfileId" TEXT NOT NULL,
            "customerId" TEXT NOT NULL,
            "orderRef" TEXT NOT NULL UNIQUE,
            "title" TEXT NOT NULL,
            "amountUsdc" DECIMAL(20,8) NOT NULL,
            "status" TEXT,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        // A legacy order written before the currency contract existed.
        await psql(`INSERT INTO "BusinessOrder" ("id","businessProfileId","customerId","orderRef","title","amountUsdc","status")
            VALUES ('legacy-1','biz-1','cust-1','REF-1','Jollof',12.50000000,'PAID')`);

        // AdminMoneySettingRevision is deliberately NOT created: the #404 gap was a
        // Prisma model with nothing in production to back it.

        // A restricted RUNTIME identity, holding ordinary DML rights including
        // TRUNCATE, proves the append-only guard is the trigger and not merely a
        // missing privilege. Note it must NOT be the table owner: the owner keeps
        // administrative capability by design (see the installer's boundary note).
        await db.$executeRawUnsafe(`DROP ROLE IF EXISTS ${ROLE}`);
        await db.$executeRawUnsafe(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${RPW}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
        await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
        runtime = new PrismaClient({ datasources: { db: { url: urlForRole(ROLE, RPW) } } });
    }, 60000);

    afterAll(async () => {
        await runtime?.$disconnect().catch(() => {});
        await db?.$disconnect().catch(() => {});
        if (adminPg) {
            await adminPg.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${el(DB)} WITH (FORCE)`).catch(() => {});
            await adminPg.$disconnect().catch(() => {});
        }
    }, 60000);

    describe('before the release installers run', () => {
        test('the legacy order table has no currency representation and a NOT NULL USDC amount', async () => {
            const cols = await db.$queryRawUnsafe(
                `SELECT column_name, is_nullable FROM information_schema.columns
                 WHERE table_name = 'BusinessOrder' AND column_name IN ('currency','amountGhs','amountUsdc')`
            );
            const byName = Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]));
            expect(byName.currency).toBeUndefined();
            expect(byName.amountGhs).toBeUndefined();
            expect(byName.amountUsdc).toBe('NO');
        });

        test('the money-settings revision table does not exist at all', async () => {
            const rows = await db.$queryRawUnsafe(
                `SELECT to_regclass('"AdminMoneySettingRevision"')::text AS t`
            );
            expect(rows[0].t).toBeNull();
        });
    });

    describe('after the release installers run', () => {
        beforeAll(async () => {
            runInstaller('install-business-currency-overlay.js');
            runInstaller('install-admin-money-settings-overlay.js');
            // Rights are granted only once the tables exist.
            await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON "AdminMoneySettingRevision" TO ${ROLE}`);
        }, 120000);

        test('the currency columns are added with the declared precision', async () => {
            const cols = await db.$queryRawUnsafe(
                `SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable
                 FROM information_schema.columns
                 WHERE table_name = 'BusinessOrder' AND column_name IN ('currency','amountGhs')`
            );
            const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
            expect(byName.currency.character_maximum_length).toBe(8);
            expect(byName.amountGhs.numeric_precision).toBe(20);
            expect(byName.amountGhs.numeric_scale).toBe(2);
            expect(byName.amountGhs.is_nullable).toBe('YES');
        });

        test('the legacy NOT NULL on amountUsdc is relaxed for GHS-only orders', async () => {
            const [col] = await db.$queryRawUnsafe(
                `SELECT is_nullable FROM information_schema.columns
                 WHERE table_name = 'BusinessOrder' AND column_name = 'amountUsdc'`
            );
            expect(col.is_nullable).toBe('YES');
        });

        test('exactly the three contract CHECKs are installed by the shared SQL file', async () => {
            expect(await constraintNames('BusinessOrder')).toEqual([
                'ck_businessorder_amount_present',
                'ck_businessorder_currency_allowed',
                'ck_businessorder_currency_shape',
            ]);
        });

        test('the legacy row survives untouched and is not relabelled as native GHS', async () => {
            const [row] = await db.$queryRawUnsafe(
                `SELECT "currency", "amountGhs", "amountUsdc" FROM "BusinessOrder" WHERE id = 'legacy-1'`
            );
            expect(row.currency).toBeNull();
            expect(row.amountGhs).toBeNull();
            // Prisma renders the canonical Decimal (12.5); psql would print
            // 12.50000000 for the same value. Compare the value, not the padding.
            expect(new Prisma.Decimal(row.amountUsdc).equals(12.5)).toBe(true);
        });

        test('a native GHS order needs no USDC amount at all', async () => {
            await psql(`INSERT INTO "BusinessOrder" ("id","businessProfileId","customerId","orderRef","title","currency","amountGhs")
                VALUES ('ghs-1','biz-1','cust-1','REF-GHS-1','Waakye','GHS',25.00)`);
            const [row] = await db.$queryRawUnsafe(
                `SELECT "amountUsdc","amountGhs" FROM "BusinessOrder" WHERE id = 'ghs-1'`
            );
            expect(row.amountUsdc).toBeNull();
            expect(new Prisma.Decimal(row.amountGhs).equals(25)).toBe(true);
        });

        test('cedis can never be written into the USDC column or vice versa', async () => {
            // GHS-tagged row carrying a USDC amount.
            await expect(psql(`INSERT INTO "BusinessOrder" ("id","businessProfileId","customerId","orderRef","title","currency","amountUsdc")
                VALUES ('bad-1','biz-1','cust-1','REF-BAD-1','x','GHS',10)`)).rejects.toThrow(/ck_businessorder_currency_shape/);
            // Untagged row carrying a GHS amount.
            await expect(psql(`INSERT INTO "BusinessOrder" ("id","businessProfileId","customerId","orderRef","title","amountGhs")
                VALUES ('bad-2','biz-1','cust-1','REF-BAD-2','x',10)`)).rejects.toThrow(/ck_businessorder_currency_shape/);
            // Both amounts at once.
            await expect(psql(`INSERT INTO "BusinessOrder" ("id","businessProfileId","customerId","orderRef","title","currency","amountUsdc","amountGhs")
                VALUES ('bad-3','biz-1','cust-1','REF-BAD-3','x','GHS',10,10)`)).rejects.toThrow(/ck_businessorder_currency_shape/);
            // No money at all.
            await expect(psql(`INSERT INTO "BusinessOrder" ("id","businessProfileId","customerId","orderRef","title")
                VALUES ('bad-4','biz-1','cust-1','REF-BAD-4','x')`)).rejects.toThrow(/ck_businessorder_amount_present/);
            // A currency the platform cannot settle.
            await expect(psql(`INSERT INTO "BusinessOrder" ("id","businessProfileId","customerId","orderRef","title","currency","amountUsdc")
                VALUES ('bad-5','biz-1','cust-1','REF-BAD-5','x','USD',10)`)).rejects.toThrow(/ck_businessorder_currency_allowed/);
        });

        test('a USDC order is still expressible, tagged explicitly', async () => {
            await psql(`INSERT INTO "BusinessOrder" ("id","businessProfileId","customerId","orderRef","title","currency","amountUsdc")
                VALUES ('usdc-1','biz-1','cust-1','REF-USDC-1','x','USDC',10.00000000)`);
            const [row] = await db.$queryRawUnsafe(
                `SELECT "amountGhs" FROM "BusinessOrder" WHERE id = 'usdc-1'`
            );
            expect(row.amountGhs).toBeNull();
        });
    });

    describe('the money-settings revision log the installer creates', () => {
        test('the table, both indexes and the append-only trigger exist', async () => {
            const [t] = await db.$queryRawUnsafe(
                `SELECT to_regclass('"AdminMoneySettingRevision"')::text AS t`
            );
            expect(t.t).toBe('"AdminMoneySettingRevision"');
            const idx = await db.$queryRawUnsafe(
                `SELECT indexname FROM pg_indexes WHERE tablename = 'AdminMoneySettingRevision' ORDER BY 1`
            );
            expect(idx.map((r) => r.indexname)).toEqual(expect.arrayContaining([
                'AdminMoneySettingRevision_key_effectiveAt_createdAt_idx',
                'AdminMoneySettingRevision_createdAt_idx',
            ]));
            const [trg] = await db.$queryRawUnsafe(
                `SELECT tgname FROM pg_trigger WHERE tgname = 'admin_money_setting_revision_no_update'`
            );
            expect(trg.tgname).toBe('admin_money_setting_revision_no_update');
        });

        test('an integer revision is accepted and a GHS revision is stored as exact text', async () => {
            await psql(`INSERT INTO "AdminMoneySettingRevision" ("id","key","kind","valueInt","effectiveAt","adminId","reason")
                VALUES ('rev-int','payout.ttlSeconds','int',900,'2026-01-01T00:00:00Z',1,'initial')`);
            await psql(`INSERT INTO "AdminMoneySettingRevision" ("id","key","kind","valueText","effectiveAt","adminId","reason")
                VALUES ('rev-ghs','payout.minGhs','ghs','25.01','2026-01-01T00:00:00Z',1,'initial')`);
            const [row] = await db.$queryRawUnsafe(
                `SELECT "valueText" FROM "AdminMoneySettingRevision" WHERE id = 'rev-ghs'`
            );
            expect(row.valueText).toBe('25.01');
        });

        test('a row can never carry two value representations at once', async () => {
            await expect(psql(`INSERT INTO "AdminMoneySettingRevision" ("id","key","kind","valueInt","valueText","effectiveAt","adminId","reason")
                VALUES ('rev-both','x','int',1,'1.00','2026-01-01T00:00:00Z',1,'bad')`))
                .rejects.toThrow(/admin_money_setting_value_carrier_check/);
        });

        test('a GHS setting must already be canonical 2dp, because Postgres would silently round it', async () => {
            await expect(psql(`INSERT INTO "AdminMoneySettingRevision" ("id","key","kind","valueText","effectiveAt","adminId","reason")
                VALUES ('rev-sub','x','ghs','25.005','2026-01-01T00:00:00Z',1,'bad')`))
                .rejects.toThrow(/admin_money_setting_ghs_canonical_check/);
        });

        test('an existing revision cannot be rewritten in place', async () => {
            // Through the RUNTIME identity: the owner keeps administrative
            // capability by design, so the owner's own connection is not the
            // identity this invariant is about.
            await expect(runtime.$executeRawUnsafe(`UPDATE "AdminMoneySettingRevision" SET "valueInt" = 3600 WHERE id = 'rev-int'`))
                .rejects.toThrow(/append-only/);
            // The correction path is a new revision, and the history is still there.
            await psql(`INSERT INTO "AdminMoneySettingRevision" ("id","key","kind","valueInt","effectiveAt","adminId","reason")
                VALUES ('rev-int-2','payout.ttlSeconds','int',3600,'2026-02-01T00:00:00Z',1,'correction')`);
            const rows = await db.$queryRawUnsafe(
                `SELECT "valueInt" FROM "AdminMoneySettingRevision" WHERE "key" = 'payout.ttlSeconds' ORDER BY "effectiveAt"`
            );
            expect(rows.map((r) => r.valueInt)).toEqual([900, 3600]);
        });
    });

    describe('re-running the release chain', () => {
        test('both installers are no-ops on a database where they already ran', async () => {
            expect(() => runInstaller('install-business-currency-overlay.js')).not.toThrow();
            expect(() => runInstaller('install-admin-money-settings-overlay.js')).not.toThrow();
            expect(await constraintNames('BusinessOrder')).toEqual([
                'ck_businessorder_amount_present',
                'ck_businessorder_currency_allowed',
                'ck_businessorder_currency_shape',
            ]);
            const [row] = await db.$queryRawUnsafe(
                `SELECT count(*)::int AS n FROM "AdminMoneySettingRevision"`
            );
            expect(row.n).toBe(3);
        }, 120000);
    });

    describe('money-settings database hardening', () => {
        // A restricted RUNTIME identity, holding ordinary DML rights including
        // TRUNCATE, proves the append-only guard is the trigger and not merely a
        // missing privilege.
        test('a GHS value must be canonical two decimals: integer and one-decimal forms are refused', async () => {
            const insert = (id, valueText) => psql(`INSERT INTO "AdminMoneySettingRevision" ("id","key","kind","valueText","effectiveAt","adminId","reason")
                VALUES ('${id}','hardening.ghs','ghs','${valueText}','2026-01-01T00:00:00Z',1,'probe')`);

            for (const bad of ['25', '25.1', '25.005', '25.010', '.50', '25,00', ' 25.00']) {
                await expect(insert(`bad-${bad.replace(/\W/g, 'x')}`, bad))
                    .rejects.toThrow(/admin_money_setting_ghs_canonical_check/);
            }
            await expect(insert('good-ghs', '25.00')).resolves.toBeGreaterThan(0);
            const [row] = await db.$queryRawUnsafe(
                `SELECT "valueText" FROM "AdminMoneySettingRevision" WHERE id = 'good-ghs'`);
            expect(row.valueText).toBe('25.00');
        });

        test('the runtime identity can append but cannot delete or truncate history', async () => {
            // Appending is what the service does, and it works.
            await expect(runtime.$executeRawUnsafe(
                `INSERT INTO "AdminMoneySettingRevision" ("id","key","kind","valueInt","effectiveAt","adminId","reason")
                 VALUES ('runtime-ok','hardening.int','int',5,'2026-01-01T00:00:00Z',1,'runtime append')`
            )).resolves.toBeGreaterThan(0);

            // Every destructive path is refused by the trigger, even though the
            // role holds DELETE and TRUNCATE privileges.
            await expect(runtime.$executeRawUnsafe(
                `DELETE FROM "AdminMoneySettingRevision" WHERE id = 'runtime-ok'`)).rejects.toThrow(/append-only/);
            await expect(runtime.$executeRawUnsafe(
                `UPDATE "AdminMoneySettingRevision" SET "valueInt" = 9 WHERE id = 'runtime-ok'`)).rejects.toThrow(/append-only/);
            await expect(runtime.$executeRawUnsafe('TRUNCATE "AdminMoneySettingRevision"')).rejects.toThrow(/append-only/);

            // History survived every attempt.
            const [row] = await db.$queryRawUnsafe(
                `SELECT "valueInt" FROM "AdminMoneySettingRevision" WHERE id = 'runtime-ok'`);
            expect(row.valueInt).toBe(5);
        });

        test('re-running the installer keeps the STRICTER constraint, it does not silently keep a looser one', async () => {
            runInstaller('install-admin-money-settings-overlay.js');
            await expect(psql(`INSERT INTO "AdminMoneySettingRevision" ("id","key","kind","valueText","effectiveAt","adminId","reason")
                VALUES ('post-rerun','hardening.ghs2','ghs','25','2026-01-01T00:00:00Z',1,'probe')`))
                .rejects.toThrow(/admin_money_setting_ghs_canonical_check/);
            const triggers = await db.$queryRawUnsafe(
                `SELECT tgname FROM pg_trigger WHERE tgrelid = '"AdminMoneySettingRevision"'::regclass AND NOT tgisinternal ORDER BY 1`);
            expect(triggers.map((t) => t.tgname)).toEqual([
                'admin_money_setting_revision_no_delete',
                'admin_money_setting_revision_no_truncate',
                'admin_money_setting_revision_no_update',
            ]);
        }, 120000);
    });
});
