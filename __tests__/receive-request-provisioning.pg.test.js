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
//   3. independently REFUSE to destroy a POPULATED legacy IdempotencyKey
//      table (the installer is fail-closed on its own, so rows that appear
//      between the workflow preflight and the apply job — a TOCTOU window —
//      are still safe; the preflight is an early operator-facing refusal,
//      the installer is the hard guarantee),
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
    let writer; // second connection used to hold an uncommitted legacy insert

    beforeAll(async () => {
        db = new PrismaClient();
    });

    afterAll(async () => {
        // Self-heal: whatever happened above, leave both tables provisioned
        // for the rest of the battery (the installers are idempotent). The
        // intentional-failure tests may leave a POPULATED legacy IdempotencyKey
        // behind — the installer would (correctly) refuse to retire it, so
        // remove the test fixture first, then re-provision.
        try {
            await db.$executeRawUnsafe('DROP TABLE IF EXISTS "IdempotencyKey";');
        } catch (e) { /* fixture may already be gone */ }
        runInstallers();
        if (writer) await writer.$disconnect();
        await db.$disconnect();
    });

    // Spawns one installer and RETURNS the result without throwing, so a
    // test can assert on an intentional failure.
    function spawnInstaller(installer) {
        return spawnSync('node', [installer], {
            // LOG_LEVEL: the logger is silent under NODE_ENV=test, but the
            // workflow's apply job runs with logging enabled — assert on the
            // same refusal message the operator sees.
            env: { ...process.env, DATABASE_URL: url, LOG_LEVEL: 'debug' },
            encoding: 'utf8',
        });
    }

    function runInstallers() {
        for (const installer of [R42_INSTALLER, PR_INSTALLER]) {
            const res = spawnInstaller(installer);
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

    test('converges existing Prisma-created tables to the installer defaults without losing rows', async () => {
        const finId = 'provision-existing-financial-operation';
        const requestId = 'provision-existing-payment-request';
        const userId = 900000098;

        // Model the already-initialized production database: Prisma's
        // @default(uuid()) and @updatedAt are client-side values, so a table
        // created via db push can lack the DB-side defaults in the installer
        // contract. Keep sentinel rows in place while the overlays converge.
        try {
            await db.$executeRawUnsafe(
                'ALTER TABLE "FinancialOperation" ALTER COLUMN "id" DROP DEFAULT');
            await db.$executeRawUnsafe(
                'ALTER TABLE "FinancialOperation" ALTER COLUMN "updatedAt" DROP DEFAULT');
            await db.$executeRawUnsafe(
                'ALTER TABLE "PaymentRequest" ALTER COLUMN "id" DROP DEFAULT');

            await db.$executeRawUnsafe(`
                INSERT INTO "User" ("id", "username", "email", "password")
                VALUES (${userId}, 'prov-default-user', 'prov-default-user@example.test', 'x')`);
            await db.$executeRawUnsafe(`
                INSERT INTO "FinancialOperation"
                    ("id", "userId", "endpoint", "key", "fingerprint", "updatedAt")
                VALUES ('${finId}', 1, 'POST /api/default-proof', 'default-proof-key',
                        'default-proof-fingerprint', CURRENT_TIMESTAMP)`);
            await db.$executeRawUnsafe(`
                INSERT INTO "PaymentRequest"
                    ("id", "requesterId", "mode", "amountExact", "expiresAt", "updatedAt")
                VALUES ('${requestId}', ${userId}, 'DIRECT', '10.00',
                        CURRENT_TIMESTAMP + interval '1 day', CURRENT_TIMESTAMP)`);

            runInstallers();
            await verifyProvisionedShape();

            const finRows = await db.$queryRawUnsafe(
                'SELECT "id", "key", "fingerprint" FROM "FinancialOperation" WHERE "id" = $1',
                finId);
            expect(finRows).toEqual([{
                id: finId, key: 'default-proof-key', fingerprint: 'default-proof-fingerprint',
            }]);

            const requestRows = await db.$queryRawUnsafe(
                'SELECT "id", "requesterId", "amountExact", "status", "currency" FROM "PaymentRequest" WHERE "id" = $1',
                requestId);
            expect(requestRows).toEqual([{
                id: requestId, requesterId: userId, amountExact: '10.00',
                status: 'PENDING', currency: 'GHS',
            }]);
        } finally {
            // Remove only this test's synthetic rows and leave the overlays
            // converged even if an assertion fails.
            await db.$executeRawUnsafe(
                'DELETE FROM "PaymentRequest" WHERE "id" = $1', requestId).catch(() => {});
            await db.$executeRawUnsafe(
                'DELETE FROM "FinancialOperation" WHERE "id" = $1', finId).catch(() => {});
            await db.$executeRawUnsafe(
                'DELETE FROM "User" WHERE "id" = $1', userId).catch(() => {});
            runInstallers();
        }
    });

    test('the r42 installer REFUSES a populated legacy IdempotencyKey — rows and table survive intact', async () => {
        // The workflow preflight is a separate job that runs earlier; rows may
        // legally appear between it and the apply job. The installer itself
        // must fail closed: it exits non-zero and leaves the legacy table and
        // every row exactly as it found them.
        await createLegacyIdempotencyKey(true);
        await db.$executeRawUnsafe(
            `INSERT INTO "IdempotencyKey" ("id", "response") VALUES ('legacy-2', '{"x":1}')`);
        const before = await db.$queryRawUnsafe(`SELECT "id", "response" FROM "IdempotencyKey" ORDER BY "id"`);
        expect(before).toHaveLength(2);

        const res = spawnInstaller(R42_INSTALLER);
        expect(res.status).not.toBe(0); // intentional, fail-closed refusal
        expect(`${res.stdout}${res.stderr}`).toMatch(/IdempotencyKey is populated \(2 rows\)/);
        expect(`${res.stdout}${res.stderr}`).toMatch(/refusing to drop/i);

        // Nothing was destroyed: the table still exists, with both original
        // rows byte-identical.
        const legacyGone = await db.$queryRaw`SELECT to_regclass('public."IdempotencyKey"')::text AS oid`;
        expect(legacyGone[0].oid).toBe('"IdempotencyKey"');
        const after = await db.$queryRawUnsafe(`SELECT "id", "response" FROM "IdempotencyKey" ORDER BY "id"`);
        expect(after).toEqual(before);

        // Operator recovery path (runbook): export/migrate the rows, EMPTY the
        // table, re-run — then the retirement proceeds safely.
        await db.$executeRawUnsafe(`DELETE FROM "IdempotencyKey"`);
        runInstallers();
        const legacy = await db.$queryRaw`SELECT to_regclass('public."IdempotencyKey"')::text AS oid`;
        expect(legacy[0].oid).toBe(null); // emptied legacy cache retired safely
        await verifyProvisionedShape();
    });

    test('TOCTOU: a legacy row COMMITTED while the installer runs is still refused (lock-then-count atomicity)', async () => {
        // Reproduces the exact race from the PR review: the workflow preflight
        // saw an EMPTY table, a writer inserts+commits before the installer's
        // DROP lands. A check-then-drop split across two statements would count
        // 0, then drop the table out from under the committing writer. The
        // installer's single atomic lock-then-count DO block must serialize
        // behind the writer and see the committed row.
        //
        // The race is coordinated by an EXPLICIT HANDSHAKE, not a fixed sleep:
        // the writer transaction stays open after the insert, the installer is
        // started, and PostgreSQL's own lock state (pg_locks) is polled until
        // the installer is OBSERVED waiting for an ungranted AccessExclusiveLock
        // on IdempotencyKey. Only then is the writer permitted to commit —
        // so the interleaving under test is guaranteed to have actually
        // happened, deterministically, on every machine. Every coordination
        // phase (writer startup, insert handshake, installer startup, lock
        // polling) is bounded and covered by the finally block below, so any
        // failure path still releases the writer, kills the installer and
        // leaves the database provisioned.
        await dropProvisionedTables();
        await createLegacyIdempotencyKey(false); // empty at "preflight" time

        // Every in-flight resource is declared up here so the finally block
        // can clean up from ANY failure path — writer startup, insert
        // handshake, installer startup, lock polling, or the assertions.
        let child = null;
        let childClosed = false;
        let releaseWriter = () => {}; // resolving twice is a no-op
        let writerPromise = Promise.resolve();
        let childPromise = Promise.resolve();
        let res = null;
        let sawLockWait = false;

        try {
            // -- Writer startup + insert handshake (bounded): the writer
            //    holds the inserted row uncommitted behind a gate. If the
            //    writer fails early (connection, insert) the handshake can
            //    never arrive, so the handshake is raced against the writer
            //    promise itself and a deadline — early failure is detected,
            //    never hung on.
            writer = new PrismaClient();
            const gate = new Promise((resolve) => { releaseWriter = resolve; });
            let signalInsert;
            const insertOpen = new Promise((r) => { signalInsert = r; });
            writerPromise = writer.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(
                    `INSERT INTO "IdempotencyKey" ("id", "response") VALUES ('racer-1', '{"r":1}')`);
                signalInsert(); // the writer's ROW EXCLUSIVE is now held
                await gate; // hold the row uncommitted until the lock wait is observed
            }, { timeout: 60000 });
            const INSERT_HANDSHAKE_TIMEOUT_MS = 5000;
            const inserted = await Promise.race([
                insertOpen.then(() => true),
                writerPromise.then(() => false), // writer ended before holding — caught below
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error('writer insert handshake timed out')),
                    INSERT_HANDSHAKE_TIMEOUT_MS)),
            ]);
            expect(inserted).toBe(true); // the writer is in-flight, ROW EXCLUSIVE held

            // -- Installer startup: spawned async; its ACCESS EXCLUSIVE lock
            //    request queues behind the writer's ROW EXCLUSIVE. A spawn
            //    error resolves childPromise with status null instead of
            //    hanging the close handler.
            childPromise = new Promise((resolve) => {
                child = require('child_process').spawn('node', [R42_INSTALLER], {
                    env: { ...process.env, DATABASE_URL: url, LOG_LEVEL: 'debug' },
                });
                let out = '';
                child.stdout.on('data', (d) => { out += d; });
                child.stderr.on('data', (d) => { out += d; });
                child.on('error', (e) => {
                    childClosed = true;
                    resolve({ status: null, out: `${out}\n${e}` });
                });
                child.on('close', (code) => { childClosed = true; resolve({ status: code, out }); });
            });

            // -- pg_locks polling (bounded): poll the REAL lock state until
            //    the installer is confirmed WAITING for an ungranted
            //    AccessExclusiveLock on the legacy table. If the installer
            //    dies before blocking, the poll exits early and the
            //    assertions below surface its output.
            const LOCK_WAIT_TIMEOUT_MS = 20000;
            const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
            while (Date.now() < deadline) {
                if (childClosed) break; // installer exited before blocking — diagnosed below
                const waiting = await db.$queryRaw`
                    SELECT count(*)::int AS n FROM pg_locks
                     WHERE locktype = 'relation'
                       AND relation = to_regclass('public."IdempotencyKey"')
                       AND mode = 'AccessExclusiveLock' -- pg_locks mode spelling
                       AND NOT granted`;
                if (waiting[0].n > 0) { sawLockWait = true; break; }
                await new Promise((r) => setTimeout(r, 25));
            }
            expect(sawLockWait).toBe(true); // the race was REAL, not timed

            // -- The race itself: permit the writer to commit. The installer's
            //    lock is granted, the count runs INSIDE the lock, sees the
            //    committed racer row and the block aborts — the row is never
            //    destroyed.
            releaseWriter();
            [res] = await Promise.all([childPromise, writerPromise]);
            expect(res.status).not.toBe(0);
            expect(res.out).toMatch(/IdempotencyKey is populated \(1 rows\)/);

            // The committing writer's row survived the refused drop attempt.
            const rows = await db.$queryRawUnsafe(`SELECT "id" FROM "IdempotencyKey" ORDER BY "id"`);
            expect(rows.map((r) => r.id)).toEqual(['racer-1']);
        } finally {
            // Reliable cleanup on ANY exit path — writer startup failure,
            // insert-handshake timeout, installer spawn error, poll timeout,
            // early installer death, or a failed assertion: no stuck child,
            // no leaked writer transaction, and the database re-provisioned
            // for the suites that follow. Every step is idempotent and
            // failure-tolerant.
            releaseWriter(); // resolving twice is a no-op
            if (child && !childClosed && child.exitCode === null) child.kill('SIGKILL');
            try { await childPromise; } catch (e) { /* child already dead */ }
            try { await writerPromise; } catch (e) { /* rolled back or committed — either is clean */ }
            if (writer) { try { await writer.$disconnect(); } catch (e) { /* already gone */ } }
            writer = null;
            try { await db.$executeRawUnsafe('DROP TABLE IF EXISTS "IdempotencyKey";'); } catch (e) { /* fixture may already be gone */ }
            try { runInstallers(); } catch (e) { /* re-provision best effort */ }
            await verifyProvisionedShape();
        }
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
            VALUES (900000001, 'prov-smoke-user', 'prov-smoke@example.test', 'x')
            ON CONFLICT ("id") DO NOTHING`);
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
