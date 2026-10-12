// GHS price provisioning proof — release-chain DDL authority (PR #334).
// =============================================================================
// The production deploy path (DEPLOY_RUNBOOK.md) is `npm run release` → the
// additive overlay installers; `prisma db push` / `migrate deploy` are NOT
// production paths. This suite proves infra/install-business-price-overlay.js
// provisions the "BusinessPrice" table FROM ABSENT through that same release
// provisioning command, converges on the prisma/schema.prisma (db push) shape
// exactly, and that a second run is a successful idempotent replay.
//
// CI runs the full battery with --runInBand, so this suite's DROP/recreate is
// serialized against the other GHS suites; afterAll re-provisions so the table
// always exists for any suite that follows, even if an assertion fails.

const { spawnSync } = require('child_process');
const path = require('path');
const { PrismaClient, Prisma } = require('@prisma/client');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

const INSTALLER = path.join(__dirname, '..', 'infra', 'install-business-price-overlay.js');

run('BusinessPrice release-path provisioning (real PostgreSQL)', () => {
    let db;

    beforeAll(async () => {
        db = new PrismaClient();
    });

    afterAll(async () => {
        // Self-heal: whatever happened above, leave the table provisioned for
        // the rest of the battery (the installer is idempotent by design).
        runInstaller();
        await db.$disconnect();
    });

    function runInstaller() {
        const res = spawnSync('node', [INSTALLER], {
            env: { ...process.env, DATABASE_URL: url },
            encoding: 'utf8',
        });
        if (res.status !== 0) {
            throw new Error(
                `installer exited ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
            );
        }
        return res;
    }

    async function dropPriceTable() {
        await db.$executeRawUnsafe('DROP TABLE IF EXISTS "BusinessPrice";');
    }

    // The exact prisma/schema.prisma render (what `prisma db push` creates).
    // name -> [data_type, datetime_precision, is_nullable, expected-default test]
    const EXPECTED_COLUMNS = {
        id: ['text', null, 'NO', (d) => d === null],
        businessProductId: ['text', null, 'NO', (d) => d === null],
        currency: ['character varying', 3, 'NO', (d) => d === null],
        amountExact: ['numeric', 20, 'NO', (d) => d === null],
        scope: ['text', null, 'NO', (d) => d === `'DEFAULT'::text`],
        locationId: ['text', null, 'YES', (d) => d === null],
        status: ['text', null, 'NO', (d) => d === `'ACTIVE'::text`],
        confirmedByType: ['text', null, 'NO', (d) => d === `'BUSINESS'::text`],
        confirmedById: ['text', null, 'YES', (d) => d === null],
        confirmedAt: ['timestamp without time zone', 3, 'YES', (d) => d === null],
        note: ['text', null, 'YES', (d) => d === null],
        effectiveFrom: ['timestamp without time zone', 3, 'NO', (d) => /^CURRENT_TIMESTAMP/.test(d || '')],
        effectiveTo: ['timestamp without time zone', 3, 'YES', (d) => d === null],
    };

    const CHECK_CONSTRAINTS = [
        'business_price_effective_window_check',
        'business_price_scope_location_check',
        'business_price_amount_positive',
        'business_price_scope_check',
        'business_price_status_check',
        'business_price_confirmed_by_check',
        'business_price_currency_check',
    ];

    async function verifyProvisionedShape() {
        // Table exists
        const table = await db.$queryRaw`
            SELECT to_regclass('public."BusinessPrice"')::text AS oid`;
        expect(table[0].oid).toBe('"BusinessPrice"');

        // Column inventory + types + nullability + defaults (schema.prisma render)
        const cols = await db.$queryRaw`
            SELECT column_name, data_type, character_maximum_length AS charlen,
                   numeric_precision AS nprec, numeric_scale AS nscale,
                   datetime_precision AS dprec, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'BusinessPrice'`;
        const colByName = new Map(cols.map((c) => [c.column_name, c]));
        expect(colByName.size).toBe(Object.keys(EXPECTED_COLUMNS).length);
        for (const [name, [type, prec, nullable, defaultOk]] of Object.entries(EXPECTED_COLUMNS)) {
            const c = colByName.get(name);
            expect(c).toBeDefined();
            expect([name, c.data_type, c.is_nullable].join('|')).toBe([name, type, nullable].join('|'));
            if (type === 'character varying') expect(c.charlen).toBe(prec);
            if (type === 'numeric') {
                expect(c.nprec).toBe(prec);
                expect(c.nscale).toBe(2);
            }
            if (type === 'timestamp without time zone') expect(c.dprec).toBe(prec);
            if (!defaultOk(c.column_default)) {
                throw new Error(`column ${name}: unexpected default ${JSON.stringify(c.column_default)}`);
            }
        }

        // Primary key
        const pk = await db.$queryRaw`
            SELECT conname, contype FROM pg_constraint
            WHERE conrelid = 'public."BusinessPrice"'::regclass AND contype = 'p'`;
        expect(pk).toHaveLength(1);
        expect(pk[0].conname).toBe('BusinessPrice_pkey');

        // BusinessProduct FK with the intended cascade behavior (db push renders
        // ON UPDATE CASCADE ON DELETE CASCADE for this relation)
        const fk = await db.$queryRaw`
            SELECT conname, confupdtype, confdeltype,
                   confrelid = 'public."BusinessProduct"'::regclass AS refs_product
            FROM pg_constraint
            WHERE conrelid = 'public."BusinessPrice"'::regclass AND contype = 'f'`;
        expect(fk).toHaveLength(1);
        expect(fk[0]).toMatchObject({
            conname: 'BusinessPrice_businessProductId_fkey',
            confupdtype: 'c',
            confdeltype: 'c',
            refs_product: true,
        });

        // Prisma-declared @@index + the DB-authority partial unique index
        const idx = await db.$queryRaw`
            SELECT indexname, indexdef FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'BusinessPrice'`;
        const idxByName = new Map(idx.map((i) => [i.indexname, i.indexdef]));
        expect(idxByName.has('BusinessPrice_businessProductId_currency_status_effectiveTo_idx')).toBe(true);
        expect(idxByName.has('business_price_current_unique')).toBe(true);
        expect(idxByName.get('business_price_current_unique')).toContain('WHERE');
        expect(idxByName.get('business_price_current_unique')).toContain('UNIQUE');

        // All contract CHECK constraints present and fully validated
        const cks = await db.$queryRaw`
            SELECT conname, convalidated FROM pg_constraint
            WHERE conrelid = 'public."BusinessPrice"'::regclass AND contype = 'c'`;
        const ckByName = new Map(cks.map((c) => [c.conname, c.convalidated]));
        expect(cks).toHaveLength(CHECK_CONSTRAINTS.length);
        for (const name of CHECK_CONSTRAINTS) {
            expect(ckByName.get(name)).toBe(true);
        }
    }

    test('provisions BusinessPrice from absent via the release-chain installer', async () => {
        await dropPriceTable();
        const gone = await db.$queryRaw`SELECT to_regclass('public."BusinessPrice"')::text AS oid`;
        expect(gone[0].oid).toBe(null);

        runInstaller(); // exactly what `npm run release` executes
        await verifyProvisionedShape();
    });

    test('second installer run is a successful idempotent replay (no-op)', async () => {
        const before = await db.$queryRaw`
            SELECT (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='BusinessPrice') AS idx,
                   (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public."BusinessPrice"'::regclass) AS cons`;
        runInstaller(); // replay
        runInstaller(); // and once more for good measure
        const after = await db.$queryRaw`
            SELECT (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='BusinessPrice') AS idx,
                   (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public."BusinessPrice"'::regclass) AS cons`;
        expect(after[0].idx).toBe(before[0].idx);
        expect(after[0].cons).toBe(before[0].cons);
        await verifyProvisionedShape();
    });

    test('provisioned table rejects the same contract violations as the db-push shape', async () => {
        // A quick behavioural spot-check that the freshly provisioned table is
        // the same authority the service tests exercise (constraint set live).
        await expect(db.$executeRawUnsafe(`
            INSERT INTO "BusinessPrice" ("id","businessProductId","currency","amountExact")
            VALUES ('prov-smoke','no-such-product','GHS', -1)
        `)).rejects.toThrow();
    });
});
