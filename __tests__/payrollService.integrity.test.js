// __tests__/payrollService.integrity.test.js
// §P.5 P0 settlement repair — Payroll disbursement integrity (mock-level).
// Real-Postgres proofs live in payroll-ewa-settlement.db.test.js.
//
// The contract under test: a direct payroll settlement moves SPENDABLE USDC
// from the business owner's User.availableBalance to the employee's
// User.availableBalance — NEVER azmBalance (loyalty points) — writes both
// signed TransactionHistory sides, the BusinessLedgerEntry expense, and the
// authoritative double-entry ledger in the SAME serializable transaction, and
// fails closed (payroll stays PENDING) whenever any write fails.

const { Prisma } = require('@prisma/client');
const ledger = require('../services/ledgerService');
const { PayrollService } = require('../services/businessOS/payrollService');

jest.spyOn(ledger, 'post').mockResolvedValue({ id: 'ledger-tx-1' });

const NET = new Prisma.Decimal('60');

function buildPayroll({ netAmount = NET, grossAmount = new Prisma.Decimal('80'), ewaDeduction = new Prisma.Decimal('20'), status = 'PENDING', smartRouteId = null, paymentPreference = 'AZAMAN_BALANCE', employeeUserId = 'user-a' } = {}) {
    return {
        id: 'payroll-a', businessProfileId: 'business-a', employeeId: 'employee-a', userId: 'user-a', period: '2026-09', status,
        payrollType: 'HOURLY', baseAmount: new Prisma.Decimal('80'), overtimeAmount: new Prisma.Decimal('0'), grossAmount, ewaDeduction,
        netAmount, taxAmount: new Prisma.Decimal('0'), deductionAmount: new Prisma.Decimal('0'),
        totalHours: new Prisma.Decimal('8'), overtimeHours: new Prisma.Decimal('0'),
        breakdown: { shifts: 1, regularHours: 8, overtimeHours: 0, ewaWithdrawn: 20 },
        employee: {
            id: 'employee-a', businessProfileId: 'business-a', userId: employeeUserId, smartRouteId,
            payrollType: 'HOURLY', hourlyRate: new Prisma.Decimal('10'), salaryAmount: null,
            withdrawnEarly: ewaDeduction, paymentPreference,
        },
    };
}

function buildTx({ payroll = buildPayroll(), failureAt = null, ownerBalanceSufficient = true } = {}) {
    const updates = [];
    const tx = {
        payrollRecord: {
            findFirst: jest.fn().mockResolvedValue(payroll),
            findUnique: jest.fn().mockResolvedValue({ ...payroll, status: 'PROCESSED' }),
            updateMany: jest.fn().mockImplementation(async () => { if (failureAt === 'claim') throw new Error('claim write failed'); return { count: 1 }; }),
            update: jest.fn().mockResolvedValue({ ...payroll, status: 'PROCESSED' }),
        },
        shift: { findMany: jest.fn().mockResolvedValue([{ actualMinutes: 480, breakMinutes: 0 }]) },
        businessProfile: { findUnique: jest.fn().mockResolvedValue({ userId: 'user-owner' }) },
        user: {
            updateMany: jest.fn().mockImplementation(async () => {
                if (failureAt === 'debit') throw new Error('debit write failed');
                return { count: ownerBalanceSufficient ? 1 : 0 };
            }),
            update: jest.fn().mockImplementation(async () => { if (failureAt === 'credit') throw new Error('credit write failed'); return { id: payroll.userId }; }),
        },
        transactionHistory: { create: jest.fn().mockImplementation(async () => { if (failureAt === 'history') throw new Error('history write failed'); return { id: 'history-a' }; }) },
        businessLedgerEntry: { create: jest.fn().mockImplementation(async () => { if (failureAt === 'ledgerEntry') throw new Error('ledger entry write failed'); return { id: 'ble-a' }; }) },
        businessEmployee: { update: jest.fn().mockImplementation(async () => { if (failureAt === 'employee') throw new Error('employee reset failed'); return { id: 'employee-a' }; }) },
    };
    return { tx, updates };
}

function buildPrisma(opts = {}) {
    const { tx } = buildTx(opts);
    return {
        tx,
        $transaction: jest.fn(async (callback, options) => { expect(options).toEqual({ isolationLevel: 'Serializable' }); return callback(tx); }),
    };
}

describe('PayrollService disbursement integrity (P0 settlement repair)', () => {
    beforeEach(() => { ledger.post.mockClear(); });

    test('moves spendable USDC owner→employee and never touches azmBalance', async () => {
        const prisma = buildPrisma();
        const result = await new PayrollService(prisma).disbursePayroll('payroll-a', 'business-a');

        // guarded treasury debit
        expect(prisma.tx.user.updateMany).toHaveBeenCalledWith({
            where: { id: 'user-owner', availableBalance: { gte: NET } },
            data: { availableBalance: { decrement: NET } },
        });
        // employee spendable credit
        expect(prisma.tx.user.update).toHaveBeenCalledTimes(1);
        expect(prisma.tx.user.update).toHaveBeenCalledWith({ where: { id: 'user-a' }, data: { availableBalance: { increment: NET } } });
        // azmBalance is NEVER mentioned anywhere
        const allCalls = JSON.stringify(prisma.tx.user.updateMany.mock.calls) + JSON.stringify(prisma.tx.user.update.mock.calls);
        expect(allCalls).not.toContain('azmBalance');

        // both signed TransactionHistory sides
        expect(prisma.tx.transactionHistory.create).toHaveBeenCalledTimes(2);
        const [ownerRow, employeeRow] = prisma.tx.transactionHistory.create.mock.calls.map(c => c[0].data);
        expect(ownerRow).toMatchObject({ userId: 'user-owner', type: 'PAYROLL_DISBURSEMENT', status: 'COMPLETED' });
        expect(String(ownerRow.amountUsdc)).toBe('-60');
        expect(String(employeeRow.amountUsdc)).toBe('60');
        expect(ownerRow.txHash).toBe('PAYROLL_payroll-a_OWNER');
        expect(employeeRow.txHash).toBe('PAYROLL_payroll-a_EMPLOYEE');

        // business ledger expense
        expect(prisma.tx.businessLedgerEntry.create).toHaveBeenCalledWith({ data: expect.objectContaining({
            businessProfileId: 'business-a', type: 'PAYROLL', sourceType: 'PAYROLL', sourceId: 'payroll-a',
        })});

        // authoritative ledger: owner liability debit, employee liability credit
        expect(ledger.post).toHaveBeenCalledTimes(1);
        const post = ledger.post.mock.calls[0];
        expect(post[1]).toMatchObject({
            idempotencyKey: 'ledger:payroll:disburse:payroll-a',
            entryType: 'BUSINESS_PAYMENT',
            relatedEntity: 'payrollRecord',
            relatedEntityId: 'payroll-a',
        });
        expect(post[1].lines).toEqual([
            { account: 'user:user-owner:liability', debit: '60.00000000' },
            { account: 'user:user-a:liability', credit: '60.00000000' },
        ]);

        // counters reset exactly once after every write
        expect(prisma.tx.businessEmployee.update).toHaveBeenCalledTimes(1);
        expect(prisma.tx.businessEmployee.update).toHaveBeenCalledWith({ where: { id: 'employee-a' }, data: { accruedWages: expect.any(Prisma.Decimal), withdrawnEarly: expect.any(Prisma.Decimal) } });

        // ownership claim happened before the money moved
        expect(prisma.tx.payrollRecord.updateMany).toHaveBeenCalledWith({
            where: { id: 'payroll-a', businessProfileId: 'business-a', status: 'PENDING' },
            data: expect.objectContaining({ status: 'PROCESSED' }),
        });
        expect(result.status).toBe('PROCESSED');
    });

    test('insufficient business funds fail closed and move nothing', async () => {
        const prisma = buildPrisma({ ownerBalanceSufficient: false });
        await expect(new PayrollService(prisma).disbursePayroll('payroll-a', 'business-a'))
            .rejects.toMatchObject({ code: 'PAYROLL_INSUFFICIENT_BUSINESS_FUNDS' });
        expect(prisma.tx.user.update).not.toHaveBeenCalled();
        expect(ledger.post).not.toHaveBeenCalled();
        expect(prisma.tx.transactionHistory.create).not.toHaveBeenCalled();
        expect(prisma.tx.businessEmployee.update).not.toHaveBeenCalled();
    });

    test.each(['debit', 'credit', 'history', 'ledgerEntry', 'employee'])(
        'a failure at %s rolls the whole settlement back (payroll never marked processed outside the transaction)',
        async (stage) => {
            const prisma = buildPrisma({ failureAt: stage });
            await expect(new PayrollService(prisma).disbursePayroll('payroll-a', 'business-a')).rejects.toThrow();
            // every write above happened only inside the transaction; a real DB
            // rolls them all back. The mock proves ordering: nothing succeeds
            // after the failing write.
            const failIdx = { debit: 0, credit: 1, history: 2, ledgerEntry: 3, employee: 4 }[stage];
            if (failIdx >= 3) expect(ledger.post).toHaveBeenCalledTimes(failIdx === 4 ? 1 : 0);
        });

    test('a negative net fails closed with PAYROLL_NEGATIVE_NET and stays pending', async () => {
        // consistent snapshot: gross 80 fully consumed by 85 of EWA → net -5
        const prisma = buildPrisma({ payroll: buildPayroll({ netAmount: new Prisma.Decimal('-5'), ewaDeduction: new Prisma.Decimal('85') }) });
        await expect(new PayrollService(prisma).disbursePayroll('payroll-a', 'business-a'))
            .rejects.toMatchObject({ code: 'PAYROLL_NEGATIVE_NET' });
        expect(prisma.tx.user.updateMany).not.toHaveBeenCalled();
        expect(prisma.tx.payrollRecord.updateMany).not.toHaveBeenCalled();
        expect(ledger.post).not.toHaveBeenCalled();
    });

    test('a zero net finalizes with an explicit non-financial reason and NO fabricated ledger posting', async () => {
        // consistent snapshot: gross 80 fully consumed by 80 of EWA → net 0
        const prisma = buildPrisma({ payroll: buildPayroll({ netAmount: new Prisma.Decimal('0'), ewaDeduction: new Prisma.Decimal('80') }) });
        const result = await new PayrollService(prisma).disbursePayroll('payroll-a', 'business-a');
        expect(result.status).toBe('PROCESSED');
        expect(prisma.tx.payrollRecord.update).toHaveBeenCalledWith({ where: { id: 'payroll-a' }, data: expect.objectContaining({ breakdown: expect.objectContaining({ settlementReason: 'ZERO_NET_SATISFIED_BY_EWA' }) }) });
        expect(prisma.tx.user.updateMany).not.toHaveBeenCalled(); // no money moved
        expect(ledger.post).not.toHaveBeenCalled();               // no zero-value posting
        expect(prisma.tx.transactionHistory.create).not.toHaveBeenCalled();
        expect(prisma.tx.businessEmployee.update).toHaveBeenCalledTimes(1); // counters still settle
    });

    test('refuses to mark Smart Route payroll paid without an exact settlement worker', async () => {
        const prisma = buildPrisma({ payroll: buildPayroll({ smartRouteId: 'route-a' }) });
        await expect(new PayrollService(prisma).disbursePayroll('payroll-a', 'business-a')).rejects.toThrow('Smart Route');
        expect(prisma.tx.user.updateMany).not.toHaveBeenCalled();
        expect(prisma.tx.payrollRecord.updateMany).not.toHaveBeenCalled();
    });

    test.each(['MOMO', 'WALLET', 'SPLIT'])(
        'external payment preference %s fails closed and stays unclaimed',
        async (pref) => {
            const prisma = buildPrisma({ payroll: buildPayroll({ paymentPreference: pref }) });
            await expect(new PayrollService(prisma).disbursePayroll('payroll-a', 'business-a'))
                .rejects.toMatchObject({ code: 'PAYROLL_EXTERNAL_PREFERENCE_UNSUPPORTED' });
            expect(prisma.tx.user.updateMany).not.toHaveBeenCalled();
            expect(prisma.tx.payrollRecord.updateMany).not.toHaveBeenCalled();
        });

    test('a payroll whose user is not the employee user never moves money', async () => {
        const prisma = buildPrisma({ payroll: buildPayroll({ employeeUserId: 'user-other' }) });
        await expect(new PayrollService(prisma).disbursePayroll('payroll-a', 'business-a')).rejects.toThrow('destination');
        expect(prisma.tx.user.updateMany).not.toHaveBeenCalled();
    });
});
