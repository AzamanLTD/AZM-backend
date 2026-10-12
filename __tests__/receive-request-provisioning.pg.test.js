// Receive/Request provisioning proof — release-chain DDL authority.
// =============================================================================
// The production deploy path (DEPLOY_RUNBOOK.md) is `npm run release` → the
// additive overlay installers; `prisma db push` / `migrate deploy` are NOT
// production paths. The guarded workflow
// .github/workflows/provision-azaman-new-receive-request.yml provisions the
// deployed Azaman-New database with EXACTLY two installers:
//   infra/install-r42-idempotency-overlay.js    (FinancialOperation + legacy
//                                                IdempotencyKey retirement)
//   infra/install-payment-requests-overlay.js   (PaymentRequest)
// This suite proves, against real PostgreSQL, that those two installers:
//   1. provision both tables FROM ABSENT with the exact reviewed DDL render
//      (columns, types, defaults, PKs, User FKs with cascade, indexes),
//   2. retire an EMPTY legacy IdempotencyKey table safely,
//   3. would silently drop a POPULATED legacy IdempotencyKey table — which is
//      precisely why the workflow preflight fails closed on populated legacy
//      data (the guard is mandatory, not paranoia),
//   4. converge a pre-review JSONB FinancialOperation.responseBody back to
//      TEXT (§r42 byte-fidelity),
//   5. replay idempotently.
//
// Note on shape: the installer render carries DB-side defaults (id →
// gen_random_uuid()::text, FinancialOperation.updatedAt → CURRENT_TIMESTAMP)
// that a `prisma db push` render does NOT create (Prisma applies those
// client-side). This suite asserts the INSTALLER render, because the
// installer is the production provisioning authority for these tables.
//
// CI runs the full battery with --runInBand, so this suite's DROP/recreate is
// serialized against the other suites; afterAll re-provisions so both tables
// always exist for any suite that follows, even if an assertion fails.

const { spawnSync } = require('child_process');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

const R42_INSTALLER = path.join(__dirname, '..', 'infra', 'install-r42-idempotency-overlay.js');
const PR_INSTALLER = path.join(__dirname, '..', 'infra', 'install-payment-requests-overlay.js');

run('Receive/Request release-path provisioning (real PostgreSQL)', () => {
    let db;

    beforeAll(async () => {
        db = new PrismaClient();
    });

    afterAll(async () => {
        // Self-heal: whatever happened above, leave both tables provisioned
        // for the rest of the battery (the installers are idempotent).
        runInstallers();
        await db.$disconnect();
    });

    function runInstallers() {
        for (const installer of [R42_INSTALLER, PR_INSTALLER]) {
            const res = spawnSync('node', [installer], {
                env: { ...process.env, DATABASE_URL: url },
                encoding: 'utf8',
            });
            if (res.status !== 0) {
                throw new Error(
                    `installer ${path.basename(installer)} exited ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
                );
            }
        }
    }

    async function dropProvisionedTables() {
        await db.$executeRawUnsafe('DROP TABLE IF EXISTS "PaymentRequest";');
        await db.$executeRawUnsafe('DROP TABLE IF EXISTS "FinancialOperation";');
    }

    async function createLegacyIdempotencyKey(populate) {
        await db.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS "IdempotencyKey" (
                "id" TEXT NOT NULL PRIMARY KEY,
                "response" TEXT
            );`);
        if (populate) {
            await db.$executeRawUnsafe(
                `INSERT INTO "IdempotencyKey" ("id", "response") VALUES ('legacy-1', '{}')`);
        }
    }

    // The exact reviewed installer DDL render.
    // name -> [data_type, is_nullable, expected-default test]
    const FIN_COLUMNS = {
        id:            ['text', 'NO', (d) => /gen_random_uuid/.test(d || '')],
        userId:        ['integer', 'NO', (d) => d === null],
        endpoint:      ['text', 'NO', (d) => d === null],
        key:           ['text', 'NO', (d) => d === null],
        status:        ['text', 'NO', (d) => d === `'IN_PROGRESS'::text`],
        fingerprint:   ['text', 'NO', (d) => d === null],
        failurePolicy: ['text', 'NO', (d) => d === `'RETAIN'::text`],
        statusCode:    ['integer', 'YES', (d) => d === null],
        responseBody:  ['text', 'YES', (d) => d === null],
        createdAt:     ['timestamp without time zone', 'NO', (d) => /^CURRENT_TIMESTAMP/.test(d || '')],
        updatedAt:     ['timestamp without time zone', 'NO', (d) => /^CURRENT_TIMESTAMP/.test(d || '')],
    };
    const PR_COLUMNS = {
        id:          ['text', 'NO', (d) => /gen_random_uuid/.test(d || '')],
        requesterId: ['integer', 'NO', (d) => d === null],
        recipientId: ['integer', 'YES', (d) => d === null],
        mode:        ['text', 'NO', (d) => d === null],
        status:      ['text', 'NO', (d) => d === `'PENDING'::text`],
        amountExact: ['text', 'NO', (d) => d === null],
        currency:    ['text', 'NO', (d) => d === `'GHS'::text`],
        tokenHash:   ['text', 'YES', (d) => d === null],
        expiresAt:   ['timestamp without time zone', 'NO', (d) => d === null],
        resolvedAt:  ['timestamp without time zone', 'YES', (d) => d === null],
        createdAt:   ['timestamp without time zone', 'NO', (d) => /^CURRENT_TIMESTAMP/.test(d || '')],
        updatedAt:   ['timestamp without time zone', 'NO', (d) => d === null],
    };

    async function verifyColumns(table, columns) {
        const cols = await db.$queryRawUnsafe(`
            SELECT column_name, data_type, datetime_precision AS dprec,
                   is_nullable, column_default
              FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = '${table}'`);
        const colByName = new Map(cols.map((c) => [c.column_name, c]));
        expect(colByName.size).toBe(Object.keys(columns).length);
        for (const [name, [type, nullable, defaultOk]] of Object.entries(columns)) {
            const c = colByName.get(name);
            expect(c).toBeDefined();
            expect([table, name, c.data_type, c.is_nullable].join('|'))
                .toBe([table, name, type, nullable].join('|'));
            if (type === 'timestamp without time zone') expect(c.dprec).toBe(3);
            if (!defaultOk(c.column_default)) {
                throw new Error(`${table}.${name}: unexpected default ${JSON.stringify(c.column_default)}`);
            }
        }
        return cols;
    }

    async function verifyProvisionedShape() {
        // ── FinancialOperation ─────────────────────────────────────────────
        const finTable = await db.$queryRaw`SELECT to_regclass('public."FinancialOperation"')::text AS oid`;
        expect(finTable[0].oid).toBe('"FinancialOperation"');
        const finCols = await verifyColumns('FinancialOperation', FIN_COLUMNS);

        // §r42 byte-fidelity: responseBody MUST be TEXT (serialized WIRE text),
        // never JSONB — JSONB reorders keys on read and would break the
        // byte-identical committed replay.
        const rb = finCols.find((c) => c.column_name === 'responseBody');
        expect(rb.data_type).toBe('text');

        // PK
        const finPk = await db.$queryRaw`
            SELECT conname FROM pg_constraint
            WHERE conrelid = 'public."FinancialOperation"'::regclass AND contype = 'p'`;
        expect(finPk).toHaveLength(1);
        expect(finPk[0].conname).toBe('FinancialOperation_pkey');

        // Unique claim identity + createdAt cursor index
        const finIdx = await db.$queryRaw`
            SELECT indexname, indexdef FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'FinancialOperation'`;
        const finIdxByName = new Map(finIdx.map((i) => [i.indexname, i.indexdef]));
        expect(finIdxByName.has('FinancialOperation_userId_endpoint_key_key')).toBe(true);
        expect(finIdxByName.get('FinancialOperation_userId_endpoint_key_key')).toMatch(/UNIQUE/i);
        expect(finIdxByName.has('FinancialOperation_createdAt_idx')).toBe(true);

        // ── PaymentRequest ──────────────────────────────────────────────────
        const prTable = await db.$queryRaw`SELECT to_regclass('public."PaymentRequest"')::text AS oid`;
        expect(prTable[0].oid).toBe('"PaymentRequest"');
        await verifyColumns('PaymentRequest', PR_COLUMNS);

        const prPk = await db.$queryRaw`
            SELECT conname FROM pg_constraint
            WHERE conrelid = 'public."PaymentRequest"'::regclass AND contype = 'p'`;
        expect(prPk).toHaveLength(1);
        expect(prPk[0].conname).toBe('PaymentRequest_pkey');

        // Both FKs to User(id) ON UPDATE CASCADE ON DELETE CASCADE
        const prFk = await db.$queryRaw`
            SELECT conname, confupdtype, confdeltype,
                   confrelid = 'public."User"'::regclass AS refs_user
            FROM pg_constraint
            WHERE conrelid = 'public."PaymentRequest"'::regclass AND contype = 'f'`;
        const fkByName = new Map(prFk.map((f) => [f.conname, f]));
        for (const conname of ['PaymentRequest_requesterId_fkey', 'PaymentRequest_recipientId_fkey']) {
            expect(fkByName.get(conname)).toMatchObject({
                refs_user: true, confupdtype: 'c', confdeltype: 'c',
            });
        }

        // Cursor indexes, expiry sweep index, unique token hash
        const prIdx = await db.$queryRaw`
            SELECT indexname, indexdef FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'PaymentRequest'`;
        const prIdxByName = new Map(prIdx.map((i) => [i.indexname, i.indexdef]));
        for (const name of [
            'PaymentRequest_requesterId_createdAt_id_idx',
            'PaymentRequest_recipientId_createdAt_id_idx',
            'PaymentRequest_expiresAt_idx',
        ]) {
            expect(prIdxByName.has(name)).toBe(true);
        }
        expect(prIdxByName.get('PaymentRequest_tokenHash_key')).toMatch(/UNIQUE/i);
    }

    test('provisions FinancialOperation + PaymentRequest from absent via the two reviewed installers, retiring an EMPTY legacy IdempotencyKey', async () => {
        await dropProvisionedTables();
        await createLegacyIdempotencyKey(false); // empty legacy cache — safe to retire
        const finGone = await db.$queryRaw`SELECT to_regclass('public."FinancialOperation"')::text AS oid`;
        expect(finGone[0].oid).toBe(null);

        runInstallers(); // exactly what the workflow's apply job executes
        await verifyProvisionedShape();

        // The empty legacy cache is retired by the r42 overlay.
        const legacy = await db.$queryRaw`SELECT to_regclass('public."IdempotencyKey"')::text AS oid`;
        expect(legacy[0].oid).toBe(null);
    });

    test('a POPULATED legacy IdempotencyKey would be silently dropped by the r42 installer — the workflow preflight refusal is the guard', async () => {
        // This documents WHY .github/workflows/provision-azaman-new-receive-request.yml
        // fails closed when IdempotencyKey exists and is non-empty: the
        // installer itself does NOT safeguard populated legacy data.
        await createLegacyIdempotencyKey(true);
        const populated = await db.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "IdempotencyKey"`);
        expect(populated[0].n).toBe(1);

        runInstallers();
        const legacy = await db.$queryRaw`SELECT to_regclass('public."IdempotencyKey"')::text AS oid`;
        expect(legacy[0].oid).toBe(null); // gone, rows included — hence the preflight guard
        await verifyProvisionedShape();
    });

    test('converges a pre-review JSONB FinancialOperation.responseBody back to TEXT (§r42 byte-fidelity)', async () => {
        // Simulate a pre-convergence install that created the column as JSONB.
        await db.$executeRawUnsafe('ALTER TABLE "FinancialOperation" DROP COLUMN "responseBody"');
        await db.$executeRawUnsafe('ALTER TABLE "FinancialOperation" ADD COLUMN "responseBody" JSONB');
        const asJsonb = await db.$queryRawUnsafe(`
            SELECT data_type FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'FinancialOperation' AND column_name = 'responseBody'`);
        expect(asJsonb[0].data_type).toBe('jsonb');

        runInstallers();
        const rb = await db.$queryRawUnsafe(`
            SELECT data_type FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'FinancialOperation' AND column_name = 'responseBody'`);
        expect(rb[0].data_type).toBe('text');
        await verifyProvisionedShape();
    });

    test('second installer run is a successful idempotent replay (no-op)', async () => {
        const before = await db.$queryRaw`
            SELECT (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='FinancialOperation') AS fin_idx,
                   (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public."FinancialOperation"'::regclass) AS fin_cons,
                   (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='PaymentRequest') AS pr_idx,
                   (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public."PaymentRequest"'::regclass) AS pr_cons`;
        runInstallers(); // replay
        runInstallers(); // and once more for good measure
        const after = await db.$queryRaw`
            SELECT (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='FinancialOperation') AS fin_idx,
                   (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public."FinancialOperation"'::regclass) AS fin_cons,
                   (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='PaymentRequest') AS pr_idx,
                   (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public."PaymentRequest"'::regclass) AS pr_cons`;
        expect(after[0]).toEqual(before[0]);
        await verifyProvisionedShape();
    });

    test('the provisioned tables enforce the same invariants the service tests exercise', async () => {
        // Behavioural spot-checks that the freshly provisioned tables are the
        // same authority the r42/payment-request suites exercise.
        // A real requester row (FK target), removed again in cleanup below.
        await db.$executeRawUnsafe(`
            INSERT INTO "User" ("id", "username", "email", "password")
            VALUES (900000001, 'prov-smoke-user', 'prov-smoke@example.test', 'x')`);
        // FinancialOperation: unique claim identity is live.
        await expect(db.$executeRawUnsafe(`
            INSERT INTO "FinancialOperation" ("userId","endpoint","key","fingerprint")
            VALUES (1, 'POST /api/x', 'dup-key', 'fp')
        `)).resolves.toBeDefined();
        await expect(db.$executeRawUnsafe(`
            INSERT INTO "FinancialOperation" ("userId","endpoint","key","fingerprint")
            VALUES (1, 'POST /api/x', 'dup-key', 'fp')
        `)).rejects.toThrow();
        // PaymentRequest: FK to User is live (no such user id) and the token
        // hash is a unique lookup key.
        await expect(db.$executeRawUnsafe(`
            INSERT INTO "PaymentRequest" ("requesterId","mode","amountExact","expiresAt")
            VALUES (999999999, 'DIRECT', '10.00', NOW() + interval '1 day')
        `)).rejects.toThrow();
        await expect(db.$executeRawUnsafe(`
            INSERT INTO "PaymentRequest" ("requesterId","mode","amountExact","expiresAt","tokenHash","updatedAt")
            VALUES (900000001, 'LINK', '10.00', NOW() + interval '1 day', 'tok-dup', CURRENT_TIMESTAMP)
        `)).resolves.toBeDefined();
        await expect(db.$executeRawUnsafe(`
            INSERT INTO "PaymentRequest" ("requesterId","mode","amountExact","expiresAt","tokenHash","updatedAt")
            VALUES (900000001, 'LINK', '10.00', NOW() + interval '1 day', 'tok-dup', CURRENT_TIMESTAMP)
        `)).rejects.toThrow();
        // Cleanup the smoke rows so later suites start clean.
        await db.$executeRawUnsafe(`DELETE FROM "FinancialOperation" WHERE "key" = 'dup-key'`);
        await db.$executeRawUnsafe(`DELETE FROM "PaymentRequest" WHERE "tokenHash" = 'tok-dup'`);
        await db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = 900000001`);
    });
});
