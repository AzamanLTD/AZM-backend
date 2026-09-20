/**
 * §R15-F follow-up — evidence-write failure inside a LIVE transaction (real PostgreSQL)
 * ====================================================================================
 *
 * The audit finding: recordReconciliationExceptionLoud(tx, ...) swallows a
 * failed evidence INSERT — but a failed SQL statement puts the WHOLE
 * PostgreSQL transaction into the ABORTED state (25P02). Swallowing the JS
 * exception without restoring the transaction leaves the caller's financial
 * path running on a poisoned transaction whose every subsequent statement
 * fails.
 *
 * These proofs run against REAL PostgreSQL and inject the failure with a
 * BEFORE INSERT trigger on ReconciliationException that RAISEs:
 *
 *   CONTROL (the defect):   a direct (unwrapped) evidence INSERT failing
 *                           poisons the transaction — the NEXT statement
 *                           fails with 25P02, proving PG abort semantics.
 *   LOUD inside a tx:       the evidence INSERT fails, the wrapper returns
 *                           null, and the FOLLOWING statements in the SAME
 *                           transaction succeed and COMMIT (savepoint
 *                           isolation works).
 *   LOUD on root client:    autocommit — failure swallowed safely, no
 *                           savepoint used, subsequent statements fine.
 *   Escalation:             the caller's escalate() fires on evidence-write
 *                           failure (and still returns null).
 *   Success path:           unchanged — row written and returned.
 *
 * Skips cleanly without TEST_DATABASE_URL.
 */

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[r15f2-evidence-write-transaction-safety] TEST_DATABASE_URL not set — skipping.');

const INJECT_FN = 'r15f2_inject_evidence_failure';
const INJECT_TRIGGER = 'r15f2_evidence_fail_trigger';

describeOrSkip('§R15-F evidence-write transaction safety (real PostgreSQL)', () => {
    let prisma;
    let recordReconciliationExceptionLoud;
    let logger;

    const EVIDENCE_ARGS = {
        entityType: 'TRANSACTION',
        entityId: 'r15f2-inject-tx',
        reference: 'ref-r15f2',
        reason: 'R15F2_INJECTED_EVIDENCE_FAILURE',
        details: { injection: 'trigger' },
    };

    beforeAll(async () => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
        ({ recordReconciliationExceptionLoud } = require('../services/reconciliationExceptionService'));
        logger = require('../src/config/logger');
    });

    const cleanupUsers = () => prisma.$executeRawUnsafe(
        `DELETE FROM "TransactionHistory" WHERE "userId" IN (SELECT "id" FROM "User" WHERE "username" LIKE 'r15f2_user_%')`
    ).then(() => prisma.$executeRawUnsafe(
        `DELETE FROM "User" WHERE "username" LIKE 'r15f2_user_%'`
    ));


    afterAll(async () => {
        if (prisma) {
            await prisma.$executeRawUnsafe('DELETE FROM "ReconciliationException" WHERE "reason" LIKE \'R15F2_%\' OR "entityId" LIKE \'r15f2-%\'');
            await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${INJECT_TRIGGER}" ON "ReconciliationException"`);
            await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${INJECT_FN}"()`);
            await prisma.$disconnect();
        }
    });

    const installFailureInjection = async () =>
        prisma.$executeRawUnsafe(`
            CREATE OR REPLACE FUNCTION "${INJECT_FN}"() RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'r15f2 injected evidence-write failure';
            END;
            $$ LANGUAGE plpgsql;
        `).then(() =>
            prisma.$executeRawUnsafe(`CREATE TRIGGER "${INJECT_TRIGGER}"
                BEFORE INSERT ON "ReconciliationException"
                FOR EACH ROW EXECUTE FUNCTION "${INJECT_FN}"()`)
        );

    const removeFailureInjection = async () =>
        prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${INJECT_TRIGGER}" ON "ReconciliationException"`)
            .then(() => prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${INJECT_FN}"()`));

    const seedUser = async (client, tag) => {
        const { seedUser: factorySeed } = require('./helpers/factories');
        return factorySeed(client, {
            username: `r15f2_user_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
            email: `r15f2_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@test.com`,
        });
    };

    beforeEach(async () => {
        await removeFailureInjection();
        jest.clearAllMocks();
    });
    afterEach(async () => {
        await removeFailureInjection();
        await cleanupUsers();
    });

    test('CONTROL — a failed evidence INSERT poisons the transaction: the NEXT statement fails with 25P02 (PG abort semantics are real)', async () => {
        await installFailureInjection();
        // A deliberate, unwrapped failure: prove PostgreSQL really does move
        // the transaction into the aborted state — this is the hazard the
        // savepoint isolation must neutralize.
        const control = await prisma.$transaction(async (tx) => {
            const sentinel = await seedUser(tx, 'control');
            const directInsert = await tx.$queryRawUnsafe(
                `INSERT INTO "ReconciliationException" ("entityType","entityId","reference","reason","status","details")
                 VALUES ('TRANSACTION','r15f2-control','ref','R15F2_CONTROL','OPEN','{}'::jsonb)`
            ).catch(e => e);
            expect(String(directInsert.message)).toMatch(/injected evidence-write failure/);
            const nextStatement = await tx.user.count().catch(e => e);
            return { sentinel, nextStatement };
        }).catch(e => e); // the transaction must ultimately fail/rollback

        // The NEXT statement failed with the aborted-transaction error code.
        expect(String(control.nextStatement?.message)).toMatch(/current transaction is aborted|25P02/i);
        // And the sentinel never committed.
        const found = await prisma.user.findUnique({ where: { id: control.sentinel?.id || 'none' } });
        expect(found).toBeNull();
    });

    test('LOUD inside a transaction — evidence INSERT fails, returns null, and the SAME transaction stays usable and COMMITS', async () => {
        await installFailureInjection();
        const committed = await prisma.$transaction(async (tx) => {
            // 1. Financial work in the transaction.
            const sentinel = await seedUser(tx, 'txsafe');
            expect(sentinel.id).toBeTruthy();

            // 2. The evidence write fails (injected) — loudly swallowed.
            const result = await recordReconciliationExceptionLoud(tx, EVIDENCE_ARGS);
            expect(result).toBeNull();

            // 3. THE PROOF: the very next statements on the SAME transaction
            //    still work — the savepoint rolled back the aborted statement.
            const count = await tx.user.count();
            const sentinel2 = await seedUser(tx, 'txsafe2');

            return { sentinelId: sentinel.id, sentinel2Id: sentinel2.id, count };
        });

        // 4. The transaction COMMITTED with all its financial work.
        const u1 = await prisma.user.findUnique({ where: { id: committed.sentinelId } });
        const u2 = await prisma.user.findUnique({ where: { id: committed.sentinel2Id } });
        expect(u1).not.toBeNull();
        expect(u2).not.toBeNull();
        expect(committed.count).toBeGreaterThan(0);

        // 5. The failed evidence row did NOT write.
        const evidence = (await prisma.$queryRawUnsafe(
            `SELECT "id" FROM "ReconciliationException" WHERE "entityId" = $1 LIMIT 1`, EVIDENCE_ARGS.entityId
        ))[0] || null;
        expect(evidence).toBeNull();

        // 6. The loud marker was logged.
        const markers = logger.error.mock.calls.map(c => JSON.stringify(c[0]));
        expect(markers.some(m => m.includes('RECONCILIATION_EVIDENCE_WRITE_FAILED'))).toBe(true);
    });

    test('LOUD on the ROOT client (autocommit) — failure swallowed safely, no savepoint residue, subsequent statements fine', async () => {
        await installFailureInjection();
        const result = await recordReconciliationExceptionLoud(prisma, { ...EVIDENCE_ARGS, entityId: 'r15f2-root-client' });
        expect(result).toBeNull();
        // Root client still fully usable.
        const count = await prisma.user.count();
        expect(typeof count).toBe('number');
    });

    test('escalate() fires on evidence-write failure and the wrapper still returns null', async () => {
        await installFailureInjection();
        let escalated = null;
        const result = await prisma.$transaction(async (tx) => {
            const r = await recordReconciliationExceptionLoud(tx, { ...EVIDENCE_ARGS, entityId: 'r15f2-escalate' }, {
                escalate: (err) => { escalated = err; },
            });
            // Transaction must remain usable after escalation.
            await tx.user.count();
            return r;
        });
        expect(result).toBeNull();
        expect(escalated).toBeTruthy();
        expect(String(escalated.message)).toMatch(/injected evidence-write failure/);
    });

    test('SUCCESS path unchanged — evidence row written and returned, transaction commits cleanly', async () => {
        const result = await prisma.$transaction(async (tx) => {
            const sentinel = await seedUser(tx, 'success');
            const written = await recordReconciliationExceptionLoud(tx, {
                ...EVIDENCE_ARGS,
                entityId: 'r15f2-success',
                reason: 'R15F2_SUCCESS_PATH',
            });
            // Transaction usable after a successful evidence write too.
            await tx.user.count();
            return { written, sentinelId: sentinel.id };
        });
        expect(result.written).toMatchObject({
            entityType: 'TRANSACTION',
            entityId: 'r15f2-success',
            reason: 'R15F2_SUCCESS_PATH',
            status: 'OPEN',
        });
        const persisted = (await prisma.$queryRawUnsafe(
            `SELECT "id", "entityId", "reason", "status" FROM "ReconciliationException" WHERE "entityId" = $1 LIMIT 1`, 'r15f2-success'
        ))[0] || null;
        expect(persisted).not.toBeNull();
        expect(await prisma.user.findUnique({ where: { id: result.sentinelId } })).not.toBeNull();
    });
});
