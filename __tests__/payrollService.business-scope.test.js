const { PayrollService } = require('../services/businessOS/payrollService');

describe('PayrollService disbursement business scope', () => {
    test('does not settle a payroll belonging to another business', async () => {
        const tx = {
            payrollRecord: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
        };
        const prisma = {
            $transaction: jest.fn(async callback => callback(tx)),
        };
        const svc = new PayrollService(prisma);

        await expect(svc.disbursePayroll('payroll-other', 'business-a')).rejects.toThrow('Payroll record not found.');
        expect(tx.payrollRecord.update).not.toHaveBeenCalled();
    });

    test('requires request/business context when no explicit business scope is supplied', async () => {
        const prisma = {
            businessProfile: { findFirst: jest.fn().mockResolvedValue(null) },
            businessEmployee: { findFirst: jest.fn().mockResolvedValue(null) },
        };
        const svc = new PayrollService(prisma);
        await expect(svc.disbursePayroll('payroll-a')).rejects.toThrow('Business context required.');
    });
});
