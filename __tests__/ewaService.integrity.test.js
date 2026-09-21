// __tests__/ewaService.integrity.test.js
// §P.5 P0 settlement repair — EWA withdrawal integrity (mock-level).
// Real-Postgres proofs (concurrency, conservation, double-payout) live in
// payroll-ewa-settlement.db.test.js.
//
// The contract under test: an EWA withdrawal debits the business owner's
// User.availableBalance (the missing treasury movement), credits the
// employee's User.availableBalance — NEVER azmBalance — realizes the 1% fee
// through SystemProfitFees + AdminProfitLog + the authoritative ledger, and
// fails closed on unsupported external destinations or duplicates.

const { Prisma } = require('@prisma/client');
const ledger = require('../services/ledgerService');
const { EwaService } = require('../services/businessOS/ewaService');

jest.spyOn(ledger, 'post').mockResolvedValue({ id: 'ledger-tx-1' });

function buildTx({ accruedWages = new Prisma.Decimal('100'), withdrawnEarly = new Prisma.Decimal('0'), failureAt = null, ownerBalanceSufficient = true, duplicateExists = false } = {}) {
    const employee = {
        id: 'employee-a', businessProfileId: 'business-a', userId: 101, status: 'ACTIVE',
        ewaEligible: true, accruedWages, withdrawnEarly,
    };
    return {
        employee,
        tx: {
            businessEmployee: {
                findFirst: jest.fn().mockResolvedValue(employee),
                findUnique: jest.fn().mockResolvedValue(employee),
                updateMany: jest.fn().mockImplementation(async () => { if (failureAt === 'guard') throw new Error('guard write failed'); return { count: 1 }; }),
            },
            businessProfile: { findUnique: jest.fn().mockResolvedValue({ userId: 1 }) },
            user: {
                updateMany: jest.fn().mockImplementation(async () => {
                    if (failureAt === 'debit') throw new Error('debit write failed');
                    return { count: ownerBalanceSufficient ? 1 : 0 };
                }),
                update: jest.fn().mockImplementation(async () => { if (failureAt === 'credit') throw new Error('credit write failed'); return { id: 101 }; }),
            },
            systemProfitFees: { upsert: jest.fn().mockImplementation(async () => { if (failureAt === 'fees') throw new Error('fees write failed'); return { id: 1, balance: 0 }; }) },
            transactionHistory: {
                findFirst: jest.fn().mockResolvedValue(duplicateExists ? { id: 'prior' } : null),
                create: jest.fn().mockImplementation(async () => { if (failureAt === 'history') throw new Error('history write failed'); return { id: 'history-a' }; }),
            },
            adminProfitLog: { create: jest.fn().mockImplementation(async () => { if (failureAt === 'profitLog') throw new Error('profit log write failed'); return { id: 'log-a' }; }) },
            businessLedgerEntry: { create: jest.fn().mockImplementation(async () => { if (failureAt === 'ledgerEntry') throw new Error('ledger entry write failed'); return { id: 'ble-a' }; }) },
        },
    };
}

function buildPrisma(opts = {}) {
    const { tx } = buildTx(opts);
    return {
        tx,
        $transaction: jest.fn(async (callback, options) => { expect(options).toEqual({ isolationLevel: 'Serializable' }); return callback(tx); }),
    };
}

describe('EwaService withdrawal integrity (P0 settlement repair)', () => {
    beforeEach(() => { ledger.post.mockClear(); });

    test('debits the business treasury, credits employee spendable balance, realizes the fee, and never touches azmBalance', async () => {
        const prisma = buildPrisma();
        const result = await new EwaService(prisma).requestWithdrawal({ employeeId: 'employee-a', amount: 20, idempotencyKey: 'k-1' });

        // gross 20, fee 0.20, net 19.80 — exact
        expect(result).toMatchObject({ success: true, grossAmount: 20, fee: 0.2, netToEmployee: 19.8 });

        // guarded treasury debit of the GROSS (the movement that was missing)
        expect(prisma.tx.user.updateMany).toHaveBeenCalledWith({
            where: { id: 1, availableBalance: { gte: new Prisma.Decimal('20') } },
            data: { availableBalance: { decrement: new Prisma.Decimal('20') } },
        });
        // employee spendable credit of the NET — azmBalance never appears
        expect(prisma.tx.user.update).toHaveBeenCalledWith({ where: { id: 101 }, data: { availableBalance: { increment: new Prisma.Decimal('19.8') } } });
        const allUserCalls = JSON.stringify(prisma.tx.user.updateMany.mock.calls) + JSON.stringify(prisma.tx.user.update.mock.calls);
        expect(allUserCalls).not.toContain('azmBalance');

        // capacity claim
        expect(prisma.tx.businessEmployee.updateMany).toHaveBeenCalledWith({
            where: { id: 'employee-a', status: 'ACTIVE', ewaEligible: true, withdrawnEarly: { lte: new Prisma.Decimal('10') } },
            data: { withdrawnEarly: { increment: new Prisma.Decimal('20') } },
        });

        // fee realized exactly once through the platform fee mechanism
        expect(prisma.tx.systemProfitFees.upsert).toHaveBeenCalledTimes(1);
        expect(prisma.tx.adminProfitLog.create).toHaveBeenCalledTimes(1);
        expect(prisma.tx.adminProfitLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ source: 'EWA_FEE', amountUsdc: new Prisma.Decimal('0.2'), relatedTxId: 'EWA_employee-a_k-1' }) });

        // history + business expense at GROSS
        expect(prisma.tx.transactionHistory.create).toHaveBeenCalledTimes(1);
        expect(prisma.tx.businessLedgerEntry.create).toHaveBeenCalledWith({ data: expect.objectContaining({
            businessProfileId: 'business-a', sourceType: 'EWA', amount: new Prisma.Decimal('-20'),
        })});

        // authoritative ledger balances: D owner 20 = C employee 19.8 + C treasury 0.2
        expect(ledger.post).toHaveBeenCalledTimes(1);
        const post = ledger.post.mock.calls[0];
        expect(post[1]).toMatchObject({
            idempotencyKey: 'ledger:ewa:EWA_employee-a_k-1',
            entryType: 'BUSINESS_PAYMENT',
        });
        expect(post[1].lines).toEqual([
            { account: 'user:1:liability', debit: '20.00000000' },
            { account: 'user:101:liability', credit: '19.80000000' },
            { account: 'equity:treasury', credit: '0.20000000' },
        ]);
    });

    test('insufficient business treasury fails closed and moves nothing', async () => {
        const prisma = buildPrisma({ ownerBalanceSufficient: false });
        await expect(new EwaService(prisma).requestWithdrawal({ employeeId: 'employee-a', amount: 20 }))
            .rejects.toMatchObject({ code: 'EWA_INSUFFICIENT_BUSINESS_FUNDS' });
        expect(prisma.tx.user.update).not.toHaveBeenCalled();
        expect(prisma.tx.systemProfitFees.upsert).not.toHaveBeenCalled();
        expect(ledger.post).not.toHaveBeenCalled();
        // the capacity claim rolled back with the whole transaction
        expect(prisma.tx.businessEmployee.updateMany).toHaveBeenCalledTimes(1);
    });

    test.each(['MOMO', 'WALLET', 'SPLIT', 'BANK'])(
        'external destination %s fails closed before any read or mutation',
        async (destination) => {
            const prisma = buildPrisma();
            await expect(new EwaService(prisma).requestWithdrawal({ employeeId: 'employee-a', amount: 10, destination }))
                .rejects.toMatchObject({ code: 'EWA_EXTERNAL_DESTINATION_UNSUPPORTED' });
            expect(prisma.$transaction).not.toHaveBeenCalled();
        });

    test('the legacy self-service destination alias (AZM_BALANCE) still settles internally', async () => {
        const prisma = buildPrisma();
        const result = await new EwaService(prisma).requestWithdrawal({ employeeId: 'employee-a', amount: 10, destination: 'AZM_BALANCE' });
        expect(result.success).toBe(true);
        expect(prisma.tx.user.updateMany).toHaveBeenCalledTimes(1);
    });

    test('a duplicate idempotencyKey claim fails closed and mints nothing', async () => {
        const prisma = buildPrisma({ duplicateExists: true });
        await expect(new EwaService(prisma).requestWithdrawal({ employeeId: 'employee-a', amount: 10, idempotencyKey: 'k-1' }))
            .rejects.toMatchObject({ code: 'EWA_DUPLICATE_REQUEST' });
        expect(prisma.tx.businessEmployee.updateMany).not.toHaveBeenCalled();
        expect(prisma.tx.user.updateMany).not.toHaveBeenCalled();
        expect(ledger.post).not.toHaveBeenCalled();
    });

    test('the 30% cap rejects an over-cap withdrawal before any mutation', async () => {
        const prisma = buildPrisma({ accruedWages: new Prisma.Decimal('10'), withdrawnEarly: new Prisma.Decimal('0') });
        await expect(new EwaService(prisma).requestWithdrawal({ employeeId: 'employee-a', amount: 4 })) // cap is 3
            .rejects.toThrow('Amount exceeds available EWA balance. Max: 3.00 AZM');
        expect(prisma.tx.businessEmployee.updateMany).not.toHaveBeenCalled();
    });

    test('rejects float-precision abuse and non-numeric amounts', async () => {
        const prisma = buildPrisma();
        await expect(new EwaService(prisma).requestWithdrawal({ employeeId: 'employee-a', amount: '10.123456789' })).rejects.toThrow('8 decimal places');
        await expect(new EwaService(prisma).requestWithdrawal({ employeeId: 'employee-a', amount: 'not-a-number' })).rejects.toThrow('valid number');
        await expect(new EwaService(prisma).requestWithdrawal({ employeeId: 'employee-a', amount: 0.5 })).rejects.toThrow('Minimum withdrawal');
    });

    test.each(['debit', 'credit', 'fees', 'history', 'profitLog', 'ledgerEntry'])(
        'a failure at %s aborts the complete movement (no partial payout survives)',
        async (stage) => {
            const prisma = buildPrisma({ failureAt: stage });
            await expect(new EwaService(prisma).requestWithdrawal({ employeeId: 'employee-a', amount: 10 })).rejects.toThrow();
            // nothing that proves a completed payout was allowed to stand alone
            if (stage !== 'ledgerEntry') expect(ledger.post).not.toHaveBeenCalled();
        });
});
