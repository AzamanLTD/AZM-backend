// __tests__/ewa-withdrawal-intent-reconciliation.db.test.js
// Issue #330 — server-owned EWA withdrawal intent lifecycle, cross-device
// reconciliation. Real PostgreSQL (SKIPS unless TEST_DATABASE_URL is set).
//
// Contract under test (services/businessOS/ewaService.js + the routes in
// routes/businessOSRoutes.js):
//
//   STATE MACHINE   PENDING → COMMITTED | REFUSED
//     PENDING   — durably registered BEFORE any economics (claim phase);
//                 in-flight or crashed; always discoverable and reconcilable.
//     COMMITTED — transitioned INSIDE the same Serializable $transaction as
//                 the money; committedTxHash anchors the authoritative
//                 TransactionHistory row.
//     REFUSED   — an authoritative pre-commit refusal, recorded after
//                 rollback; a same-key retry re-evaluates fresh (the
//                 existing "never replay a failure" contract is preserved).
//
//   PROOFS
//     1.  a committed withdrawal atomically records a COMMITTED intent
//     2.  lost response after commit → second device recovers the ORIGINAL
//         key and outcome via the recovery list; retry replays, no second
//         payout
//     3.  concurrent same-key requests (two "devices") → exactly one
//         movement; the loser replays the committed truth
//     4.  changed-parameter reuse of a key fails closed
//         (EWA_IDEMPOTENCY_CONFLICT); the original intent is untouched
//     5.  a crashed attempt (PENDING intent, nothing committed) is
//         discoverable on another device; retrying the recovered key
//         commits exactly once
//     6.  a transient NON-refusal failure leaves the intent PENDING
//         (never misclassified); after restart the retry settles it
//     7.  an authoritative pre-commit refusal records REFUSED + message;
//         the same-key retry re-evaluates fresh once the cause is fixed
//     8.  keyless (legacy) attempts register no intent — unchanged behavior
//     9.  cross-tenant isolation: a foreign/absent business context is
//         disclosed nothing
//     10. route level: operator recovery endpoint, worker self-service
//         endpoint, and the withdraw route carry the contract end-to-end

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[ewa-withdrawal-intent-reconciliation.db.test] TEST_DATABASE_URL not set — skipping.');

const { Prisma } = require('@prisma/client');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { EwaService } = require('../services/businessOS/ewaService');
const { runWithBusinessRequestContext } = require('../src/lib/businessRequestContext');

const TRUNCATE_TABLES = '"User","BusinessProfile","BusinessEmployee","Shift","PayrollRecord","BusinessLedgerEntry","TransactionHistory","SystemProfitFees","AdminProfitLog","LedgerTransaction","JournalEntry","LedgerAccount","EwaWithdrawalIntent"';

const DEC = (v) => new Prisma.Decimal(v);
const D8 = (v) => new Prisma.Decimal(v).toFixed(8);
const key = () => `k${Date.now()}${Math.floor(Math.random() * 100000)}`;

describeOrSkip('EWA server-owned withdrawal intent lifecycle (real Postgres)', () => {
    let prisma;

    async function seedWorld({ ownerBalance = '500', accruedWages = '100', ewaEligible = true } = {}) {
        const id = Date.now() + Math.floor(Math.random() * 100000);
        const owner = await prisma.user.create({ data: {
            username: `own_${id}`, email: `own_${id}@t.co`, password: 'x',
            availableBalance: ownerBalance, azmBalance: '77',
        }});
        const employeeUser = await prisma.user.create({ data: {
            username: `emp_${id}`, email: `emp_${id}@t.co`, password: 'x',
            availableBalance: '0', azmBalance: '33',
        }});
        const business = await prisma.businessProfile.create({ data: {
            userId: owner.id, bizId: `BIZ-${String(id).slice(-9).padStart(9, '0')}`, businessName: `Biz ${id}`,
        }});
        const employee = await prisma.businessEmployee.create({ data: {
            businessProfileId: business.id, userId: employeeUser.id,
            payrollType: 'HOURLY', hourlyRate: '10',
            accruedWages, ewaEligible,
        }});
        return { owner, employeeUser, business, employee };
    }

    const movements = async () => ({
        history: await prisma.transactionHistory.count(),
        ledger: await prisma.ledgerTransaction.count(),
    });

    const intentOf = async (employeeId, idempotencyKey) => prisma.ewaWithdrawalIntent.findUnique({
        where: { employeeId_idempotencyKey: { employeeId, idempotencyKey } },
    });

    beforeAll(() => {
        process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_at_least_32_chars_long_xxxxx';
        const { PrismaClient } = require('@prisma/client');
        prisma = new PrismaClient();
    });

    afterAll(async () => { if (prisma) await prisma.$disconnect(); });

    beforeEach(async () => {
        await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TRUNCATE_TABLES} RESTART IDENTITY CASCADE`);
        jest.restoreAllMocks();
    }, 15000);

    afterEach(() => { jest.restoreAllMocks(); }, 15000);

    // ── 1. atomic COMMITTED record ────────────────────────────────────────

    test('1. a committed withdrawal atomically records a COMMITTED intent anchored to the history row', async () => {
        const world = await seedWorld();
        const svc = new EwaService(prisma);
        const k = key();

        const result = await svc.requestWithdrawal({
            employeeId: world.employee.id, amount: '20', idempotencyKey: k, destination: 'AZAMAN_BALANCE',
        });

        expect(result.success).toBe(true);
        const intent = await intentOf(world.employee.id, k);
        expect(intent).not.toBeNull();
        expect(intent.status).toBe('COMMITTED');
        expect(intent.amountExact).toBe('20.00000000');
        expect(intent.committedTxHash).toBe(`EWA_${world.employee.id}_${k}`);
        expect(intent.resolvedAt).not.toBeNull();
        // The anchor resolves to the authoritative history row
        const hist = await prisma.transactionHistory.findUnique({ where: { txHash: intent.committedTxHash } });
        expect(hist).not.toBeNull();
        expect(hist.status).toBe('COMPLETED');
        expect((await movements()).history).toBe(1);
    });

    // ── 2. lost response after commit → second-device recovery ───────────

    test('2. after a lost response the COMMITTED intent is recoverable on a second device; retry replays', async () => {
        const world = await seedWorld();
        const deviceA = new EwaService(prisma);
        const k = key();

        // Device A submits; the HTTP response is lost after commit.
        await deviceA.requestWithdrawal({
            employeeId: world.employee.id, amount: '20', idempotencyKey: k,
        });

        // Device B (a fresh service instance) never saw the response and does
        // NOT possess the key — it lists the intents in the business context.
        const deviceB = new EwaService(prisma);
        const intents = await runWithBusinessRequestContext(
            { businessProfileId: world.business.id, isBusinessOwner: true, user: { id: world.owner.id } },
            () => deviceB.getWithdrawalIntents(world.employee.id),
        );

        expect(intents).toHaveLength(1);
        expect(intents[0].status).toBe('COMMITTED');
        expect(intents[0].idempotencyKey).toBe(k);       // original identity recovered
        expect(intents[0].amount).toBe('20.00000000');
        expect(intents[0].committedTxHash).toBe(`EWA_${world.employee.id}_${k}`);

        // Device B retries the SAME recovered identity → replay, no second payout
        const replay = await runWithBusinessRequestContext(
            { businessProfileId: world.business.id, isBusinessOwner: true, user: { id: world.owner.id } },
            () => deviceB.requestWithdrawal({
                employeeId: world.employee.id, amount: '20', idempotencyKey: intents[0].idempotencyKey,
            }),
        );
        expect(replay.replayed).toBe(true);
        expect((await movements()).history).toBe(1);
        const emp = await prisma.businessEmployee.findUnique({ where: { id: world.employee.id } });
        expect(D8(emp.withdrawnEarly)).toBe('20.00000000');
    });

    // ── 3. concurrent same-key from two devices ────────────────────────────

    test('3. concurrent same-key requests from two devices move the money exactly once', async () => {
        const world = await seedWorld();
        const k = key();

        const results = await Promise.allSettled([
            new EwaService(prisma).requestWithdrawal({
                employeeId: world.employee.id, amount: '20', idempotencyKey: k,
            }),
            new EwaService(prisma).requestWithdrawal({
                employeeId: world.employee.id, amount: '20', idempotencyKey: k,
            }),
        ]);

        const ok = results.filter((r) => r.status === 'fulfilled' && r.value?.success);
        expect(ok.length).toBe(2); // loser replays the committed truth
        const replays = ok.filter((r) => r.value.replayed === true);
        expect(replays.length).toBe(1);
        expect((await movements()).history).toBe(1); // exactly one payout
        const emp = await prisma.businessEmployee.findUnique({ where: { id: world.employee.id } });
        expect(D8(emp.withdrawnEarly)).toBe('20.00000000');
        const intent = await intentOf(world.employee.id, k);
        expect(intent.status).toBe('COMMITTED');
    });

    // ── 4. changed-parameter reuse fails closed ────────────────────────────

    test('4. changed-parameter reuse of the same key fails closed and leaves the original intent intact', async () => {
        const world = await seedWorld();
        const svc = new EwaService(prisma);
        const k = key();

        await svc.requestWithdrawal({
            employeeId: world.employee.id, amount: '20', idempotencyKey: k,
        });

        await expect(svc.requestWithdrawal({
            employeeId: world.employee.id, amount: '40', idempotencyKey: k,
        })).rejects.toMatchObject({
            code: 'EWA_IDEMPOTENCY_CONFLICT',
            message: expect.stringMatching(/already used with different parameters \(differing: amount\)/),
        });

        expect((await movements()).history).toBe(1); // no second movement
        const intent = await intentOf(world.employee.id, k);
        expect(intent.status).toBe('COMMITTED');     // original intent untouched
    });

    // ── 5. crashed attempt (PENDING) recovered on another device ──────────

    test('5. a crashed attempt leaves a discoverable PENDING intent; the recovered key commits exactly once', async () => {
        const world = await seedWorld();
        const k = key();

        // Simulate a process that died between the durable claim and the
        // withdrawal transaction: the intent is PENDING, nothing committed.
        await prisma.ewaWithdrawalIntent.create({ data: {
            employeeId: world.employee.id,
            businessProfileId: world.business.id,
            idempotencyKey: k,
            amountExact: '20.00000000',
            destination: 'AZAMAN_BALANCE',
            status: 'PENDING',
        }});

        // A second device discovers it (unresolved first) WITH the key
        const svcB = new EwaService(prisma);
        const intents = await runWithBusinessRequestContext(
            { businessProfileId: world.business.id, isBusinessOwner: true, user: { id: world.owner.id } },
            () => svcB.getWithdrawalIntents(world.employee.id),
        );
        expect(intents).toHaveLength(1);
        expect(intents[0].status).toBe('PENDING');
        expect(intents[0].idempotencyKey).toBe(k);

        // Retrying the recovered identity completes the withdrawal ONCE
        const result = await runWithBusinessRequestContext(
            { businessProfileId: world.business.id, isBusinessOwner: true, user: { id: world.owner.id } },
            () => svcB.requestWithdrawal({
                employeeId: world.employee.id, amount: '20', idempotencyKey: k,
            }),
        );
        expect(result.success).toBe(true);
        expect(result.replayed).toBeUndefined(); // a fresh commit, not a replay
        expect((await movements()).history).toBe(1);
        const intent = await intentOf(world.employee.id, k);
        expect(intent.status).toBe('COMMITTED');
        // ...and a subsequent identical retry replays (no double payout)
        const replay = await svcB.requestWithdrawal({
            employeeId: world.employee.id, amount: '20', idempotencyKey: k,
        });
        expect(replay.replayed).toBe(true);
        expect((await movements()).history).toBe(1);
    });

    // ── 6. transient failure → PENDING, never misclassified ────────────────

    test('6. a transient non-refusal failure leaves the intent PENDING and reconcilable after restart', async () => {
        const world = await seedWorld();
        const k = key();
        const svc = new EwaService(prisma);

        // The connection is lost between the durable claim and the economics:
        // NOT a pre-commit refusal — the attempt must stay reconcilable.
        const txSpy = jest.spyOn(svc.prisma, '$transaction').mockRejectedValueOnce(
            new Error('db connection lost mid-flight'),
        );
        await expect(svc.requestWithdrawal({
            employeeId: world.employee.id, amount: '20', idempotencyKey: k,
        })).rejects.toThrow('db connection lost mid-flight');
        txSpy.mockRestore();

        let intent = await intentOf(world.employee.id, k);
        expect(intent.status).toBe('PENDING'); // never REFUSED, never COMMITTED
        expect(intent.refusalMessage).toBeNull();
        expect((await movements()).history).toBe(0);

        // "Restart": a fresh service instance settles the same identity
        const svcRestarted = new EwaService(prisma);
        const result = await svcRestarted.requestWithdrawal({
            employeeId: world.employee.id, amount: '20', idempotencyKey: k,
        });
        expect(result.success).toBe(true);
        intent = await intentOf(world.employee.id, k);
        expect(intent.status).toBe('COMMITTED');
        expect((await movements()).history).toBe(1);
    });

    // ── 7. authoritative refusal recorded; retry re-evaluates fresh ────────

    test('7. a documented pre-commit refusal records REFUSED; a same-key retry re-evaluates fresh', async () => {
        const world = await seedWorld({ ewaEligible: false });
        const svc = new EwaService(prisma);
        const k = key();

        await expect(svc.requestWithdrawal({
            employeeId: world.employee.id, amount: '20', idempotencyKey: k,
        })).rejects.toThrow('EWA is not available for this employee.');

        let intent = await intentOf(world.employee.id, k);
        expect(intent.status).toBe('REFUSED');
        expect(intent.refusalMessage).toBe('EWA is not available for this employee.');
        expect(intent.resolvedAt).not.toBeNull();
        expect((await movements()).history).toBe(0);

        // The refusal is authoritative for THAT attempt only: fixing the
        // cause and retrying the same identity re-evaluates fresh (the
        // existing "never replay a failure" contract).
        await prisma.businessEmployee.update({
            where: { id: world.employee.id },
            data: { ewaEligible: true },
        });
        const result = await svc.requestWithdrawal({
            employeeId: world.employee.id, amount: '20', idempotencyKey: k,
        });
        expect(result.success).toBe(true);
        intent = await intentOf(world.employee.id, k);
        expect(intent.status).toBe('COMMITTED');
        expect(intent.refusalMessage).toBeNull();
        expect((await movements()).history).toBe(1);
    });

    // ── 8. keyless legacy behavior preserved ───────────────────────────────

    test('8. a keyless (legacy) withdrawal registers no intent — unchanged behavior', async () => {
        const world = await seedWorld();
        const svc = new EwaService(prisma);

        const result = await svc.requestWithdrawal({
            employeeId: world.employee.id, amount: '20',
        });
        expect(result.success).toBe(true);
        expect(await prisma.ewaWithdrawalIntent.count()).toBe(0);
        expect((await movements()).history).toBe(1);
    });

    // ── 9. cross-tenant isolation ─────────────────────────────────────────

    test('9. a foreign business context (or none) is disclosed nothing', async () => {
        const world = await seedWorld();
        const svc = new EwaService(prisma);
        const k = key();
        await svc.requestWithdrawal({
            employeeId: world.employee.id, amount: '20', idempotencyKey: k,
        });

        const foreign = await seedWorld(); // a second, unrelated business
        const out = [];

        // foreign business context
        out.push(await runWithBusinessRequestContext(
            { businessProfileId: foreign.business.id, isBusinessOwner: true, user: { id: foreign.owner.id } },
            () => svc.getWithdrawalIntents(world.employee.id),
        ));
        // no context at all
        out.push(await svc.getWithdrawalIntents(world.employee.id));
        // nonexistent employee
        out.push(await runWithBusinessRequestContext(
            { businessProfileId: world.business.id, isBusinessOwner: true, user: { id: world.owner.id } },
            () => svc.getWithdrawalIntents('no-such-employee'),
        ));

        expect(out).toEqual([[], [], []]);
    });

    // ── 10. route level ────────────────────────────────────────────────────

    const mkApp = () => {
        const app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.use('/api/business-os', require('../routes/businessOSRoutes'));
        return app;
    };
    const tokenFor = (userId) => `Bearer ${jwt.sign({ id: userId }, process.env.JWT_SECRET)}`;

    test('10a. operator recovery route lists intents scoped to the caller\'s own business', async () => {
        const world = await seedWorld();
        const k = key();
        const app = mkApp();

        // A keyed withdrawal through the real route (lost response afterwards)
        const res1 = await request(app)
            .post('/api/business-os/ewa/withdraw')
            .set('Authorization', tokenFor(world.owner.id))
            .send({ employeeId: world.employee.id, amount: 20, idempotencyKey: k });
        expect(res1.status).toBe(200);
        expect(res1.body.success).toBe(true);

        // The operator reopens the EWA portal on ANOTHER device:
        const res2 = await request(app)
            .get(`/api/business-os/ewa/intents/${world.employee.id}`)
            .set('Authorization', tokenFor(world.owner.id));
        expect(res2.status).toBe(200);
        expect(res2.body.intents).toHaveLength(1);
        expect(res2.body.intents[0]).toMatchObject({
            status: 'COMMITTED',
            idempotencyKey: k,
            amount: '20.00000000',
        });
    });

    test('10b. a foreign business owner is disclosed nothing by the recovery route', async () => {
        const world = await seedWorld();
        const foreign = await seedWorld();
        const app = mkApp();

        const res = await request(app)
            .get(`/api/business-os/ewa/intents/${world.employee.id}`)
            .set('Authorization', tokenFor(foreign.owner.id));
        expect(res.status).toBe(200);
        expect(res.body.intents).toEqual([]);
    });

    test('10c. worker self-service recovery returns the employee\'s own intents; unauthenticated is refused', async () => {
        const world = await seedWorld();
        const app = mkApp();

        const anon = await request(app)
            .get('/api/business-os/employees/my-ewa-intents');
        expect(anon.status).toBe(401);

        // A PENDING intent (crashed attempt) for this employee
        const k = key();
        await prisma.ewaWithdrawalIntent.create({ data: {
            employeeId: world.employee.id,
            businessProfileId: world.business.id,
            idempotencyKey: k,
            amountExact: '20.00000000',
            destination: 'AZAMAN_BALANCE',
            status: 'PENDING',
        }});

        const res = await request(app)
            .get('/api/business-os/employees/my-ewa-intents')
            .set('Authorization', tokenFor(world.employeeUser.id));
        expect(res.status).toBe(200);
        expect(res.body.intents).toHaveLength(1);
        expect(res.body.intents[0]).toMatchObject({
            status: 'PENDING',
            idempotencyKey: k,   // the worker recovers their own original key
        });
    });

    test('10d. the withdraw route carries the full recovery loop end-to-end', async () => {
        const world = await seedWorld();
        const k = key();
        const app = mkApp();

        // Device A: keyed withdrawal, response lost
        await request(app)
            .post('/api/business-os/ewa/withdraw')
            .set('Authorization', tokenFor(world.owner.id))
            .send({ employeeId: world.employee.id, amount: 20, idempotencyKey: k });

        // Device B: recovers the identity and retries the SAME key via the route
        const list = await request(app)
            .get(`/api/business-os/ewa/intents/${world.employee.id}`)
            .set('Authorization', tokenFor(world.owner.id));
        const recovered = list.body.intents[0].idempotencyKey;

        const retry = await request(app)
            .post('/api/business-os/ewa/withdraw')
            .set('Authorization', tokenFor(world.owner.id))
            .send({ employeeId: world.employee.id, amount: 20, idempotencyKey: recovered });
        expect(retry.status).toBe(200);
        expect(retry.body.result.replayed).toBe(true);
        expect((await movements()).history).toBe(1);
    });
});
