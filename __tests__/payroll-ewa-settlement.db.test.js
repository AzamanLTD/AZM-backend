// __tests__/payroll-ewa-settlement.db.test.js
// §P.5 P0 Business Payroll + EWA Financial Settlement Repair — REAL POSTGRES
// proofs for the settlement contract:
//
//   • payroll moves SPENDABLE USDC owner→employee (never azmBalance)
//   • EWA debits the business treasury (the movement that was missing),
//     credits the employee spendable balance, realizes the 1% fee exactly once
//   • every posting is atomic: a failure in ANY later write rolls the whole
//     movement back and leaves the operation unsettled
//   • concurrency: duplicate/concurrent payouts cannot pay twice, the 30% cap
//     cannot be raced, a duplicate idempotencyKey cannot mint a second payout
//   • §8 conservation: payroll after EWA pays only the remaining gross and
//     value is conserved exactly across employee, treasury and platform fee
//
// SKIPS unless TEST_DATABASE_URL is set (same harness as admin-actions.test.js).

const hasDb = !!process.env.TEST_DATABASE_URL;
const describeOrSkip = hasDb ? describe : describe.skip;
if (!hasDb) console.warn('[payroll-ewa-settlement.db.test] TEST_DATABASE_URL not set — skipping.');

const { Prisma } = require('@prisma/client');
const ledger = require('../services/ledgerService');
const { PayrollService } = require('../services/businessOS/payrollService');
const { EwaService } = require('../services/businessOS/ewaService');

const TRUNCATE_TABLES = '"User","BusinessProfile","BusinessEmployee","Shift","PayrollRecord","BusinessLedgerEntry","TransactionHistory","SystemProfitFees","AdminProfitLog","LedgerTransaction","JournalEntry","LedgerAccount"';

describeOrSkip('Business Payroll + EWA settlement (real Postgres)', () => {
    let prisma;
    const DEC = (v) => new Prisma.Decimal(v);
    // normalize every stored Decimal to the canonical 8-dp form
    const D8 = (v) => new Prisma.Decimal(v).toFixed(8);

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

    async function seedShiftedPayroll({ business, employee, employeeUser, hours = 8, gross = '80', ewaDeduction = '0', base = gross, overtime = '0', overtimeHours = '0', overrides = {} }) {
        const period = '2026-09';
        if (hours > 0) {
            await prisma.shift.create({ data: {
                employeeId: employee.id, businessProfileId: business.id, userId: employeeUser.id,
                shiftDate: new Date('2026-09-15T00:00:00Z'),
                startTime: new Date('2026-09-15T08:00:00Z'), endTime: new Date('2026-09-15T17:00:00Z'),
                status: 'CLOCKED_OUT', actualMinutes: hours * 60, breakMinutes: 0,
                clockInTime: new Date('2026-09-15T08:00:00Z'), clockOutTime: new Date('2026-09-15T17:00:00Z'),
            }});
        }
        return prisma.payrollRecord.create({ data: {
            businessProfileId: business.id, employeeId: employee.id, userId: employeeUser.id,
            period, payrollType: 'HOURLY',
            grossAmount: gross, netAmount: DEC(gross).minus(DEC(ewaDeduction)),
            baseAmount: base, overtimeAmount: overtime,
            ewaDeduction, taxAmount: '0', deductionAmount: '0',
            totalHours: String(hours), overtimeHours,
            status: 'PENDING',
            breakdown: { shifts: hours > 0 ? 1 : 0, regularHours: hours, overtimeHours: Number(overtimeHours), ewaWithdrawn: Number(ewaDeduction) },
            ...overrides,
        }});
    }

    async function ledgerResidual(idempotencyKey) {
        const tx = await prisma.ledgerTransaction.findUnique({ where: { idempotencyKey }, include: { journalEntries: true } });
        if (!tx) return { exists: false };
        const residual = tx.journalEntries.reduce((s, e) => s.plus(new Prisma.Decimal(e.debit)).minus(new Prisma.Decimal(e.credit)), DEC(0));
        return { exists: true, residual, lines: tx.journalEntries.map(e => ({ account: e.account, debit: D8(e.debit), credit: D8(e.credit) })) };
    }

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

    // ── PAYROLL ──────────────────────────────────────────────────────────────

    describe('payroll settlement', () => {
        test('moves spendable USDC owner→employee, keeps azmBalance untouched, and writes every accounting side', async () => {
            const world = await seedWorld();
            const payroll = await seedShiftedPayroll(world);
            const result = await new PayrollService(prisma).disbursePayroll(payroll.id, world.business.id);

            expect(result.status).toBe('PROCESSED');
            const [owner, employeeUser] = await Promise.all([
                prisma.user.findUnique({ where: { id: world.owner.id } }),
                prisma.user.findUnique({ where: { id: world.employeeUser.id } }),
            ]);
            expect(D8(owner.availableBalance)).toBe('420.00000000'); // 500 - 80
            expect(D8(employeeUser.availableBalance)).toBe('80.00000000');
            expect(D8(owner.azmBalance)).toBe('77.00000000');        // loyalty points untouched
            expect(D8(employeeUser.azmBalance)).toBe('33.00000000');

            // both signed TransactionHistory sides
            const history = await prisma.transactionHistory.findMany({ orderBy: { createdAt: 'asc' } });
            expect(history).toHaveLength(2);
            expect(history.map(h => D8(h.amountUsdc)).sort()).toEqual(['-80.00000000', '80.00000000']);
            expect(new Set(history.map(h => h.userId))).toEqual(new Set([world.owner.id, world.employeeUser.id]));

            // business expense ledger entry
            const entry = await prisma.businessLedgerEntry.findFirstOrThrow({ where: { sourceType: 'PAYROLL', sourceId: payroll.id } });
            expect(D8(entry.amount)).toBe('-80.00000000');

            // authoritative ledger balances exactly: D owner 80 = C employee 80
            const posted = await ledgerResidual(`ledger:payroll:disburse:${payroll.id}`);
            expect(posted.exists).toBe(true);
            expect(String(posted.residual)).toBe('0');
            expect(posted.lines).toEqual([
                { account: `user:${world.owner.id}:liability`, debit: '80.00000000', credit: '0.00000000' },
                { account: `user:${world.employeeUser.id}:liability`, debit: '0.00000000', credit: '80.00000000' },
            ]);

            // liability projections equal the posted settlements (the seeded
            // starting balances are not ledger rows; only posted movements count)
            const ownerLiability = await ledger.userLiabilityBalance(prisma, world.owner.id);
            const employeeLiability = await ledger.userLiabilityBalance(prisma, world.employeeUser.id);
            expect(D8(ownerLiability)).toBe('-80.00000000'); // payroll debit
            expect(D8(employeeLiability)).toBe('80.00000000'); // payroll credit

            // counters reset exactly once
            const emp = await prisma.businessEmployee.findUnique({ where: { id: world.employee.id } });
            expect(D8(emp.accruedWages)).toBe('0.00000000');
            expect(D8(emp.withdrawnEarly)).toBe('0.00000000');
        });

        test('insufficient business treasury fails closed and the payroll stays PENDING', async () => {
            const world = await seedWorld({ ownerBalance: '50' }); // net 80 > 50
            const payroll = await seedShiftedPayroll(world);
            await expect(new PayrollService(prisma).disbursePayroll(payroll.id, world.business.id))
                .rejects.toMatchObject({ code: 'PAYROLL_INSUFFICIENT_BUSINESS_FUNDS' });
            const [record, owner, employeeUser] = await Promise.all([
                prisma.payrollRecord.findUnique({ where: { id: payroll.id } }),
                prisma.user.findUnique({ where: { id: world.owner.id } }),
                prisma.user.findUnique({ where: { id: world.employeeUser.id } }),
            ]);
            expect(record.status).toBe('PENDING');
            expect(D8(owner.availableBalance)).toBe('50.00000000');
            expect(D8(employeeUser.availableBalance)).toBe('0.00000000');
            expect(await prisma.transactionHistory.count()).toBe(0);
        });

        test('a ledger failure rolls the complete settlement back and the payroll stays PENDING', async () => {
            const world = await seedWorld();
            const payroll = await seedShiftedPayroll(world);
            const spy = jest.spyOn(ledger, 'post').mockImplementation(() => { throw new Error('ledger down'); });
            await expect(new PayrollService(prisma).disbursePayroll(payroll.id, world.business.id)).rejects.toThrow('ledger down');
            expect(spy).toHaveBeenCalledTimes(1);

            const [record, owner, employeeUser, emp] = await Promise.all([
                prisma.payrollRecord.findUnique({ where: { id: payroll.id } }),
                prisma.user.findUnique({ where: { id: world.owner.id } }),
                prisma.user.findUnique({ where: { id: world.employeeUser.id } }),
                prisma.businessEmployee.findUnique({ where: { id: world.employee.id } }),
            ]);
            expect(record.status).toBe('PENDING');
            expect(D8(owner.availableBalance)).toBe('500.00000000');
            expect(D8(employeeUser.availableBalance)).toBe('0.00000000');
            expect(D8(emp.withdrawnEarly)).toBe('0.00000000'); // counters untouched
            expect(await prisma.transactionHistory.count()).toBe(0);   // both sides rolled back
            expect(await prisma.businessLedgerEntry.count()).toBe(0);
        });

        test('a negative net fails closed with PAYROLL_NEGATIVE_NET and is not erased as processed', async () => {
            const world = await seedWorld();
            // consistent snapshot: 85 already withdrawn against 80 gross → net -5
            await prisma.businessEmployee.update({ where: { id: world.employee.id }, data: { withdrawnEarly: '85' } });
            const payroll = await seedShiftedPayroll({ ...world, gross: '80', ewaDeduction: '85' });
            await expect(new PayrollService(prisma).disbursePayroll(payroll.id, world.business.id))
                .rejects.toMatchObject({ code: 'PAYROLL_NEGATIVE_NET' });
            const record = await prisma.payrollRecord.findUnique({ where: { id: payroll.id } });
            expect(record.status).toBe('PENDING');
            expect(D8(record.netAmount)).toBe('-5.00000000'); // debt state preserved
            expect(await prisma.transactionHistory.count()).toBe(0);
        });

        test('Smart Route payroll stays unclaimed by the direct settlement path', async () => {
            const world = await seedWorld();
            const payroll = await seedShiftedPayroll(world);
            await prisma.businessEmployee.update({ where: { id: world.employee.id }, data: { smartRouteId: 'route-x' } });
            await expect(new PayrollService(prisma).disbursePayroll(payroll.id, world.business.id)).rejects.toThrow('Smart Route');
            expect((await prisma.payrollRecord.findUnique({ where: { id: payroll.id } })).status).toBe('PENDING');
            expect(D8((await prisma.user.findUnique({ where: { id: world.employeeUser.id } })).availableBalance)).toBe('0.00000000');
        });

        test('unsupported external payment preference stays unclaimed', async () => {
            const world = await seedWorld();
            const payroll = await seedShiftedPayroll(world);
            await prisma.businessEmployee.update({ where: { id: world.employee.id }, data: { paymentPreference: 'MOMO' } });
            await expect(new PayrollService(prisma).disbursePayroll(payroll.id, world.business.id))
                .rejects.toMatchObject({ code: 'PAYROLL_EXTERNAL_PREFERENCE_UNSUPPORTED' });
            expect((await prisma.payrollRecord.findUnique({ where: { id: payroll.id } })).status).toBe('PENDING');
        });

        test('two concurrent disbursements pay exactly once', async () => {
            const world = await seedWorld();
            const payroll = await seedShiftedPayroll(world);
            const svc = new PayrollService(prisma);
            const outcomes = await Promise.allSettled([
                svc.disbursePayroll(payroll.id, world.business.id),
                svc.disbursePayroll(payroll.id, world.business.id),
            ]);
            const fulfilled = outcomes.filter(o => o.status === 'fulfilled');
            const rejected = outcomes.filter(o => o.status === 'rejected');
            expect(fulfilled).toHaveLength(1);
            expect(rejected).toHaveLength(1);

            const [owner, employeeUser] = await Promise.all([
                prisma.user.findUnique({ where: { id: world.owner.id } }),
                prisma.user.findUnique({ where: { id: world.employeeUser.id } }),
            ]);
            expect(D8(owner.availableBalance)).toBe('420.00000000'); // debited exactly once
            expect(D8(employeeUser.availableBalance)).toBe('80.00000000'); // credited exactly once
            expect(await prisma.ledgerTransaction.count({ where: { idempotencyKey: { startsWith: 'ledger:payroll:disburse:' } } })).toBe(1);
        });
    });

    // ── EWA ──────────────────────────────────────────────────────────────────

    describe('EWA settlement', () => {
        test('debits the treasury once, credits the exact net, realizes the fee once, balances the ledger, and never touches azmBalance', async () => {
            const world = await seedWorld();
            const result = await new EwaService(prisma).requestWithdrawal({ employeeId: world.employee.id, amount: 20 });

            expect(result).toMatchObject({ success: true, grossAmount: 20, fee: 0.2, netToEmployee: 19.8 });
            const [owner, employeeUser, fees, logs, emp] = await Promise.all([
                prisma.user.findUnique({ where: { id: world.owner.id } }),
                prisma.user.findUnique({ where: { id: world.employeeUser.id } }),
                prisma.systemProfitFees.findUnique({ where: { id: 1 } }),
                prisma.adminProfitLog.findMany(),
                prisma.businessEmployee.findUnique({ where: { id: world.employee.id } }),
            ]);
            expect(D8(owner.availableBalance)).toBe('480.00000000'); // 500 - 20 gross
            expect(D8(employeeUser.availableBalance)).toBe('19.80000000');
            expect(D8(owner.azmBalance)).toBe('77.00000000');
            expect(D8(employeeUser.azmBalance)).toBe('33.00000000');
            expect(D8(emp.withdrawnEarly)).toBe('20.00000000');
            expect(D8(fees.balance)).toBe('0.20000000');
            expect(logs).toHaveLength(1);
            expect(logs[0].source).toBe('EWA_FEE');
            expect(D8(logs[0].amountUsdc)).toBe('0.20000000');

            // ledger: D owner 20 = C employee 19.8 + C treasury 0.2
            const posted = await ledgerResidual(`ledger:ewa:EWA_${world.employee.id}_undefined`);
            // no idempotency key supplied — locate by entry type + employee line
            const txs = await prisma.ledgerTransaction.findMany({ include: { journalEntries: true } });
            expect(txs).toHaveLength(1);
            const residual = txs[0].journalEntries.reduce((s, e) => s.plus(new Prisma.Decimal(e.debit)).minus(new Prisma.Decimal(e.credit)), DEC(0));
            expect(String(residual)).toBe('0');
            expect(txs[0].journalEntries.map(e => `${e.account}:${D8(e.debit)}:${D8(e.credit)}`)).toEqual([
                `user:${world.owner.id}:liability:20.00000000:0.00000000`,
                `user:${world.employeeUser.id}:liability:0.00000000:19.80000000`,
                `equity:treasury:0.00000000:0.20000000`,
            ]);
        });

        test('a duplicate idempotencyKey cannot mint a second payout (sequential + concurrent)', async () => {
            const world = await seedWorld({ accruedWages: '1000' }); // cap 300: capacity remains for a true duplicate
            const svc = new EwaService(prisma);
            const key = 'retry-1';
            const first = await svc.requestWithdrawal({ employeeId: world.employee.id, amount: 20, idempotencyKey: key });
            expect(first.success).toBe(true);

            // sequential duplicate: typed rejection
            await expect(svc.requestWithdrawal({ employeeId: world.employee.id, amount: 20, idempotencyKey: key }))
                .rejects.toMatchObject({ code: 'EWA_DUPLICATE_REQUEST' });

            // concurrent duplicates: exactly one of the pair wins; both total payouts stay 1+1
            const outcomes = await Promise.allSettled([
                svc.requestWithdrawal({ employeeId: world.employee.id, amount: 30, idempotencyKey: 'race-1' }),
                svc.requestWithdrawal({ employeeId: world.employee.id, amount: 30, idempotencyKey: 'race-1' }),
            ]);
            expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);

            const [owner, employeeUser, emp] = await Promise.all([
                prisma.user.findUnique({ where: { id: world.owner.id } }),
                prisma.user.findUnique({ where: { id: world.employeeUser.id } }),
                prisma.businessEmployee.findUnique({ where: { id: world.employee.id } }),
            ]);
            // 500 - 20 (first) - 30 (race winner) = 450; withdrawnEarly = 50
            expect(D8(owner.availableBalance)).toBe('450.00000000');
            expect(D8(employeeUser.availableBalance)).toBe('49.50000000'); // 19.8 + 29.7
            expect(D8(emp.withdrawnEarly)).toBe('50.00000000');
            expect(await prisma.ledgerTransaction.count()).toBe(2);
        });

        test('the 30% cap cannot be raced: two concurrent withdrawals cannot exceed it', async () => {
            const world = await seedWorld({ accruedWages: '100' }); // cap 30
            const svc = new EwaService(prisma);
            const outcomes = await Promise.allSettled([
                svc.requestWithdrawal({ employeeId: world.employee.id, amount: 20 }),
                svc.requestWithdrawal({ employeeId: world.employee.id, amount: 20 }),
            ]);
            expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
            expect(outcomes.filter(o => o.status === 'rejected')).toHaveLength(1);

            const emp = await prisma.businessEmployee.findUnique({ where: { id: world.employee.id } });
            expect(D8(emp.withdrawnEarly)).toBe('20.00000000'); // never 40: cap held
            const owner = await prisma.user.findUnique({ where: { id: world.owner.id } });
            expect(D8(owner.availableBalance)).toBe('480.00000000'); // one debit only
        });

        test('a history/ledger failure rolls back the complete movement including the capacity claim', async () => {
            const world = await seedWorld();
            const spy = jest.spyOn(ledger, 'post').mockImplementation(() => { throw new Error('ledger down'); });
            await expect(new EwaService(prisma).requestWithdrawal({ employeeId: world.employee.id, amount: 20 })).rejects.toThrow('ledger down');
            expect(spy).toHaveBeenCalledTimes(1);

            const [owner, employeeUser, emp, fees] = await Promise.all([
                prisma.user.findUnique({ where: { id: world.owner.id } }),
                prisma.user.findUnique({ where: { id: world.employeeUser.id } }),
                prisma.businessEmployee.findUnique({ where: { id: world.employee.id } }),
                prisma.systemProfitFees.findUnique({ where: { id: 1 } }),
            ]);
            expect(D8(owner.availableBalance)).toBe('500.00000000');
            expect(D8(employeeUser.availableBalance)).toBe('0.00000000');
            expect(D8(emp.withdrawnEarly)).toBe('0.00000000'); // capacity claim rolled back
            expect(fees).toBeNull(); // fee realization rolled back
            expect(await prisma.adminProfitLog.count()).toBe(0);
        });

        test('unsupported external destinations fail closed and record nothing', async () => {
            const world = await seedWorld();
            for (const destination of ['MOMO', 'WALLET', 'SPLIT']) {
                await expect(new EwaService(prisma).requestWithdrawal({ employeeId: world.employee.id, amount: 10, destination }))
                    .rejects.toMatchObject({ code: 'EWA_EXTERNAL_DESTINATION_UNSUPPORTED' });
            }
            expect(await prisma.transactionHistory.count()).toBe(0);
            expect(await prisma.businessLedgerEntry.count()).toBe(0);
            expect(D8((await prisma.businessEmployee.findUnique({ where: { id: world.employee.id } })).withdrawnEarly)).toBe('0.00000000');
        });

        test('insufficient business treasury fails closed and the capacity claim rolls back', async () => {
            const world = await seedWorld({ ownerBalance: '10', accruedWages: '1000' });
            await expect(new EwaService(prisma).requestWithdrawal({ employeeId: world.employee.id, amount: 20 }))
                .rejects.toMatchObject({ code: 'EWA_INSUFFICIENT_BUSINESS_FUNDS' });
            const emp = await prisma.businessEmployee.findUnique({ where: { id: world.employee.id } });
            expect(D8(emp.withdrawnEarly)).toBe('0.00000000'); // the claim was part of the rolled-back transaction
        });

        test('§8 conservation: payroll after EWA pays only the remaining gross and value is conserved exactly', async () => {
            // 10h @ 10/h = base 100 + 2h overtime ×5/h = gross 110; EWA already
            // paid out gross 20 (fee 0.20, employee received 19.80), so payroll
            // nets 90. Employee total 109.80 + fee 0.20 = business outflow 110.
            const world = await seedWorld({ accruedWages: '100' });
            const ewa = await new EwaService(prisma).requestWithdrawal({ employeeId: world.employee.id, amount: 20 });
            expect(ewa.netToEmployee).toBeCloseTo(19.8, 8);

            const payroll = await seedShiftedPayroll({ ...world, hours: 10, gross: '110', base: '100', overtime: '10', overtimeHours: '2', ewaDeduction: '20' });
            const result = await new PayrollService(prisma).disbursePayroll(payroll.id, world.business.id);
            expect(result.status).toBe('PROCESSED');
            expect(D8(result.netAmount)).toBe('90.00000000');

            const [owner, employeeUser] = await Promise.all([
                prisma.user.findUnique({ where: { id: world.owner.id } }),
                prisma.user.findUnique({ where: { id: world.employeeUser.id } }),
            ]);
            // business outflow: 20 (EWA) + 90 (payroll) = 110 exactly
            expect(D8(owner.availableBalance)).toBe('390.00000000');
            // employee received: 19.80 + 90 = 109.80 exactly
            expect(D8(employeeUser.availableBalance)).toBe('109.80000000');
            expect(D8(employeeUser.azmBalance)).toBe('33.00000000'); // no AZM mutation, ever
            expect(D8(owner.azmBalance)).toBe('77.00000000');

            // platform fee realized exactly once, exactly 0.20
            expect(D8((await prisma.systemProfitFees.findUniqueOrThrow({ where: { id: 1 } })).balance)).toBe('0.20000000');

            // accrued/withdrawn reset exactly once on final settlement
            const emp = await prisma.businessEmployee.findUnique({ where: { id: world.employee.id } });
            expect(D8(emp.accruedWages)).toBe('0.00000000');
            expect(D8(emp.withdrawnEarly)).toBe('0.00000000');

            // authoritative ledger conserves value across both events
            const txs = await prisma.ledgerTransaction.findMany({ include: { journalEntries: true } });
            expect(txs).toHaveLength(2);
            for (const t of txs) {
                const residual = t.journalEntries.reduce((s, e) => s.plus(new Prisma.Decimal(e.debit)).minus(new Prisma.Decimal(e.credit)), DEC(0));
                expect(String(residual)).toBe('0');
            }
            // liability projections equal the balance columns after both events
            const ownerLiability = await ledger.userLiabilityBalance(prisma, world.owner.id);
            expect(D8(ownerLiability)).toBe('-110.00000000'); // business outflow 110
            const employeeLiability = await ledger.userLiabilityBalance(prisma, world.employeeUser.id);
            expect(D8(employeeLiability)).toBe('109.80000000');
        });
    });
});
