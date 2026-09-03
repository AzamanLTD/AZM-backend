const { PayrollService } = require('../services/businessOS/payrollService');
const { runWithRequestContext } = require('../utils/requestContext');

describe('Payroll request context', () => {
    test('resolves business profile from the authorized request context', async () => {
        const service = new PayrollService({});
        await expect(runWithRequestContext({ businessProfileId: 'business-a', user: { id: 7 } }, () =>
            service._resolveCallerBusinessProfileId())).resolves.toBe('business-a');
    });

    test('explicit business scope wins over ambient request context', async () => {
        const service = new PayrollService({});
        await expect(runWithRequestContext({ businessProfileId: 'business-a', user: { id: 7 } }, () =>
            service._resolveCallerBusinessProfileId('business-b'))).resolves.toBe('business-b');
    });

    test('no explicit scope or authorized context fails closed', async () => {
        const service = new PayrollService({});
        await expect(service._resolveCallerBusinessProfileId()).resolves.toBeNull();
    });

    test('disbursement rejects a request without business context before opening a transaction', async () => {
        const transaction = jest.fn();
        const service = new PayrollService({ $transaction: transaction });

        await expect(service.disbursePayroll('payroll-foreign')).rejects.toThrow('Business context required.');
        expect(transaction).not.toHaveBeenCalled();
    });
});
