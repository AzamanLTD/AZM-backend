// __tests__/ewa-worker-idempotency.db.test.js
// PR #292 follow-up — EWA request identity on the REAL worker path.
//
// The service-level idempotencyKey support existed, but the worker
// self-service route (POST /api/business-os/employees/my-ewa-request) never
// supplied one, so a lost-response client retry could mint a second payout
// within remaining capacity. This suite proves the full identity chain on
// real PostgreSQL, service-level AND route-level:
//
//   1. first request with a clientRequestId succeeds (one movement)
//   2. EXACT retry (same key, same amount) replays the committed result —
//      no second movement, one history row, one ledger posting
//   3. same key + different amount = economic identity contradiction →
//      EWA_IDEMPOTENCY_CONFLICT, fail closed, no movement
//   4. concurrent identical requests produce exactly ONE payout
//   5. a failed transaction leaves the request retryable (same key works
//      once the failure cause is fixed — failed attempts never commit a
//      claim row, so they can never be replayed as false successes)
//   6. the route carries identity end-to-end: clientRequestId →
//      employeeService.requestEWA → EwaService.requestWithdrawal →
//      TransactionHistory.txHash (@unique) → ledger idempotency key;
//      a request WITHOUT a key is rejected 400 fail-closed
//
// Canonical pattern: the repo's Phase H12 `clientRequestId` convention
// (peerTransferController.sendFunds / savings deposit) — client-generated
// UUID derives a DB-unique TransactionHistory.txHash.
//
// SKIPS unless TEST_DATABASE_URL is set.

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[ewa-worker-idempotency.db.test] TEST_DATABASE_URL not set — skipping.');

const { Prisma } = require('@prisma/client');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { EwaService } = require('../services/businessOS/ewaService');

const TRUNCATE_TABLES = '"User","BusinessProfile","BusinessEmployee","Shift","PayrollRecord","BusinessLedgerEntry","TransactionHistory","SystemProfitFees","AdminProfitLog","LedgerTransaction","JournalEntry","LedgerAccount"';

const DEC = (v) => new Prisma.Decimal(v);
const D8 = (v) => new Prisma.Decimal(v).toFixed(8);

// Alpha-numeric idempotency keys only, mirroring real client UUIDs
const key = () => `k${Date.now()}${Math.floor(Math.random() * 100000)}`;

describeOrSkip('EWA worker request identity (real Postgres)', () => {
    let prisma;

    async function seedWorld({ ownerBalance = '500', accruedWages = '100' } = {}) {
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
            accruedWages, ewaEligible: true,
        }});
        return { owner, employeeUser, business, employee };
    }

    const balances = async (world) => {
        const [owner, employeeUser] = await Promise.all([
            prisma.user.findUnique({ where: { id: world.owner.id } }),
            prisma.user.findUnique({ where: { id: world.employeeUser.id } }),
        ]);
        return { owner: D8(owner.availableBalance), employee: D8(employeeUser.availableBalance) };
    };

    const movements = async (world) => ({
        history: await prisma.transactionHistory.count(),
        ledger: await prisma.ledgerTransaction.count(),
        profitLog: await prisma.adminProfitLog.count(),
        withdrawn: (await prisma.businessEmployee.findUnique({ where: { id: world.employee.id } })).withdrawnEarly,
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

    // ── SERVICE LEVEL ─────────────────────────────────────────────────────

    test('1. first request with a clientRequestId succeeds with exactly one movement', async () => {
        const world = await seedWorld();
        const svc = new EwaService(prisma);
        const k = key();

        const result = await svc.requestWithdrawal({
            employeeId: world.employee.id, amount: '20', idempotencyKey: k, destination: 'AZAMAN_BALANCE',
        });

        expect(result.success).toBe(true);
        expect(result.replayed).toBeUndefined();
        const bal = await balances(world);
        expect(bal.owner).toBe('480.00000000');   // treasury debited gross
        expect(bal.employee).toBe('19.80000000'); // net of 1% fee
        const mv = await movements(world);
        expect(mv.history).toBe(1);
        expect(mv.ledger).toBe(1);
        expect(mv.profitLog).toBe(1);
        expect(D8(mv.withdrawn)).toBe('20.00000000');
        // DB-enforced identity: the committed row carries the unique txHash
        const hist = await prisma.transactionHistory.findFirstOrThrow({ where: { txHash: `EWA_${world.employee.id}_${k}` } });
        expect(hist.status).toBe('COMPLETED');
    });

    test('2. exact retry replays the committed result and moves nothing', async () => {
        const world = await seedWorld();
        const svc = new EwaService(prisma);
        const k = key();

        const first = await svc.requestWithdrawal({
            employeeId: world.employee.id, amount: '20', idempotencyKey: k, destination: 'AZAMAN_BALANCE',
        });
        const afterFirst = await balances(world);
        const mvFirst = await movements(world);

        const retry = await svc.requestWithdrawal({
            employeeId: world.employee.id, amount: '20', idempotencyKey: k, destination: 'AZAMAN_BALANCE',
        });

        expect(retry.success).toBe(true);
        expect(retry.replayed).toBe(true);
        expect(D8(String(retry.grossAmount))).toBe(D8('20'));
        expect(D8(String(retry.fee))).toBe(D8('0.2'));
        expect(D8(String(retry.netToEmployee))).toBe(D8('19.8'));
        // zero second movement
        expect(await balances(world)).toEqual(afterFirst);
        const mvRetry = await movements(world);
        expect(mvRetry).toEqual(mvFirst);
    });

    test('3. same key + different amount fails closed as an economic identity conflict', async () => {
        const world = await seedWorld();
        const svc = new EwaService(prisma);
        const k = key();

        await svc.requestWithdrawal({
            employeeId: world.employee.id, amount: '20', idempotencyKey: k, destination: 'AZAMAN_BALANCE',
        });
        const afterFirst = await balances(world);
        const mvFirst = await movements(world);

        await expect(svc.requestWithdrawal({
            employeeId: world.employee.id, amount: '25', idempotencyKey: k, destination: 'AZAMAN_BALANCE',
        })).rejects.toMatchObject({ code: 'EWA_IDEMPOTENCY_CONFLICT' });

        expect(await balances(world)).toEqual(afterFirst);
        expect(await movements(world)).toEqual(mvFirst);
    });

    test('4. concurrent identical requests produce exactly one payout', async () => {
        const world = await seedWorld();
        const svc = new EwaService(prisma);
        const k = key();

        const outcomes = await Promise.allSettled([
            svc.requestWithdrawal({ employeeId: world.employee.id, amount: '20', idempotencyKey: k, destination: 'AZAMAN_BALANCE' }),
            svc.requestWithdrawal({ employeeId: world.employee.id, amount: '20', idempotencyKey: k, destination: 'AZAMAN_BALANCE' }),
        ]);

        const succeeded = outcomes.filter(o => o.status === 'fulfilled' && o.value.success);
        expect(succeeded.length).toBeGreaterThanOrEqual(1);
        // Every request either fulfilled the payout exactly once or failed
        // safely (serialization retry / replay). Whatever the interleave,
        // total economic movement is EXACTLY one withdrawal of 20 gross.
        const bal = await balances(world);
        expect(bal.owner).toBe('480.00000000');
        expect(bal.employee).toBe('19.80000000');
        const mv = await movements(world);
        expect(mv.history).toBe(1);  // one committed payout row
        expect(mv.ledger).toBe(1);
        expect(mv.profitLog).toBe(1);
        expect(D8(mv.withdrawn)).toBe('20.00000000');
        // And every rejected one must have failed for a safety reason
        for (const o of outcomes) {
            if (o.status === 'rejected') {
                const msg = String(o.reason?.message || '');
                expect(
                    msg.includes('concurrent withdrawal')
                    || msg.includes('serialization')
                    || o.reason?.code === 'EWA_IDEMPOTENCY_CONFLICT'
                    || o.reason?.code === 'EWA_DUPLICATE_REQUEST',
                ).toBe(true);
            }
        }
    });

    test('5. a failed transaction leaves the request retryable with the SAME key', async () => {
        // Insufficient treasury: the whole movement rolls back and NO claim
        // row is committed — so the same key can be retried once the
        // failure cause is fixed. A failed attempt can never be replayed
        // as a false success.
        const world = await seedWorld({ ownerBalance: '5' }); // treasury too low for 20 gross
        const svc = new EwaService(prisma);
        const k = key();

        await expect(svc.requestWithdrawal({
            employeeId: world.employee.id, amount: '20', idempotencyKey: k, destination: 'AZAMAN_BALANCE',
        })).rejects.toMatchObject({ code: 'EWA_INSUFFICIENT_BUSINESS_FUNDS' });

        // no trace: no history, no ledger, capacity unclaimed
        const mv = await movements(world);
        expect(mv.history).toBe(0);
        expect(mv.ledger).toBe(0);
        expect(D8(mv.withdrawn)).toBe('0.00000000');

        // fund the treasury, retry the SAME logical request
        await prisma.user.update({ where: { id: world.owner.id }, data: { availableBalance: '500' } });
        const retry = await svc.requestWithdrawal({
            employeeId: world.employee.id, amount: '20', idempotencyKey: k, destination: 'AZAMAN_BALANCE',
        });
        expect(retry.success).toBe(true);
        expect(retry.replayed).toBeUndefined(); // a genuinely fresh execution, not a replay
        const bal = await balances(world);
        expect(bal.owner).toBe('480.00000000');
        expect(bal.employee).toBe('19.80000000');
    });

    // ── ROUTE LEVEL (end-to-end through the real router + auth) ──────────

    const mkApp = () => {
        const app = express();
        app.use(express.json());
        app.set('prisma', prisma);
        app.use('/api/business-os', require('../routes/businessOSRoutes'));
        return app;
    };
    const tokenFor = (userId) => `Bearer ${jwt.sign({ id: userId }, process.env.JWT_SECRET)}`;

    test('6a. route requires a client request identity (fail-closed 400 without one)', async () => {
        const world = await seedWorld();
        const app = mkApp();

        const res = await request(app)
            .post('/api/business-os/employees/my-ewa-request')
            .set('Authorization', tokenFor(world.employeeUser.id))
            .send({ amount: 20 });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('EWA_IDEMPOTENCY_KEY_REQUIRED');
        expect(await movements(world)).toEqual({ history: 0, ledger: 0, profitLog: 0, withdrawn: DEC(0) });
    });

    test('6b. route carries identity end-to-end; exact retry replays without a second payout', async () => {
        const world = await seedWorld();
        const app = mkApp();
        const k = key();
        const payload = { amount: 20, clientRequestId: k };

        const res1 = await request(app)
            .post('/api/business-os/employees/my-ewa-request')
            .set('Authorization', tokenFor(world.employeeUser.id))
            .send(payload);
        expect(res1.status).toBe(200);
        expect(res1.body.success).toBe(true);
        expect(res1.body.withdrawn).toBe(20); // legacy worker contract preserved
        expect(res1.body.remainingEwa).toBe(10);
        const afterFirst = await balances(world);
        const mvFirst = await movements(world);

        // lost-response retry of the SAME user action
        const res2 = await request(app)
            .post('/api/business-os/employees/my-ewa-request')
            .set('Authorization', tokenFor(world.employeeUser.id))
            .send(payload);
        expect(res2.status).toBe(200);
        expect(res2.body.success).toBe(true);
        expect(res2.body.result ? res2.body.result.replayed : res2.body.replayed).toBe(true);

        expect(await balances(world)).toEqual(afterFirst);
        expect(await movements(world)).toEqual(mvFirst);

        // worker self-service cannot target another employee: the route
        // resolves the employee from the AUTH USER only
        const otherWorld = await seedWorld();
        await prisma.businessEmployee.update({
            where: { id: world.employee.id },
            data: { businessProfileId: otherWorld.business.id },
        });
        const res3 = await request(app)
            .post('/api/business-os/employees/my-ewa-request')
            .set('Authorization', tokenFor(world.employeeUser.id))
            .send({ amount: 5, clientRequestId: key() });
        expect(res3.status).toBe(200); // still scoped to the authenticated user's own employee record
        const hist = await prisma.transactionHistory.findFirstOrThrow({
            where: { userId: world.employeeUser.id },
            orderBy: { createdAt: 'desc' },
        });
        expect(hist.metadata.employeeId).toBe(world.employee.id); // never otherWorld.employee.id
    });

    test('6c. same key + different amount through the route fails closed', async () => {
        const world = await seedWorld();
        const app = mkApp();
        const k = key();

        const res1 = await request(app)
            .post('/api/business-os/employees/my-ewa-request')
            .set('Authorization', tokenFor(world.employeeUser.id))
            .send({ amount: 20, clientRequestId: k });
        expect(res1.status).toBe(200);
        const afterFirst = await balances(world);
        const mvFirst = await movements(world);

        const res2 = await request(app)
            .post('/api/business-os/employees/my-ewa-request')
            .set('Authorization', tokenFor(world.employeeUser.id))
            .send({ amount: 25, clientRequestId: k });
        expect(res2.status).toBe(400);
        expect(res2.body.message).toMatch(/different parameters/i);
        expect(await balances(world)).toEqual(afterFirst);
        expect(await movements(world)).toEqual(mvFirst);
    });
});
