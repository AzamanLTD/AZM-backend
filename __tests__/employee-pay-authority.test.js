// =============================================================================
// Pay fields decide how much of the owner's money an employee earns and can
// draw early (EWA). A manager holding employees.update could raise their own
// rate and draw it. Now:
//   • nobody but the owner changes their own pay or early-wage access;
//   • changing anyone's pay needs payroll.process;
//   • other profile fields still need only employees.update;
//   • a business payout request goes only to the OWNER's payout destination.
// =============================================================================

jest.mock('../src/config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));

const { EmployeeService } = require('../services/businessOS/employeeService');

const prismaFor = (employee) => ({
    businessEmployee: {
        findFirst: jest.fn(async () => employee),
        update: jest.fn(async ({ data }) => ({ ...employee, ...data })),
    },
});
const manager = { id: 31, permissions: ['employees.view', 'employees.update'] };
const payrollManager = { id: 31, permissions: ['employees.update', 'payroll.process'] };
const owner = { id: 20, permissions: ['*'] };

describe('changing pay', () => {
    test('a manager cannot raise their own rate, even with the payroll right', async () => {
        const prisma = prismaFor({ id: 'e-self', userId: 31 });
        const svc = new EmployeeService(prisma);
        await expect(svc.updateEmployee('e-self', 'b1', { hourlyRate: '50' }, { actor: payrollManager }))
            .rejects.toMatchObject({ statusCode: 403, code: 'OWN_PAY_LOCKED' });
        await expect(svc.updateEmployee('e-self', 'b1', { ewaEligible: true }, { actor: payrollManager }))
            .rejects.toMatchObject({ code: 'OWN_PAY_LOCKED' });
        expect(prisma.businessEmployee.update).not.toHaveBeenCalled();
    });

    test("someone else's pay needs payroll.process", async () => {
        const prisma = prismaFor({ id: 'e-2', userId: 44 });
        const svc = new EmployeeService(prisma);
        await expect(svc.updateEmployee('e-2', 'b1', { salaryAmount: '900' }, { actor: manager }))
            .rejects.toMatchObject({ statusCode: 403, code: 'PAY_AUTHORITY_REQUIRED' });
        await svc.updateEmployee('e-2', 'b1', { salaryAmount: '900' }, { actor: payrollManager });
        expect(prisma.businessEmployee.update).toHaveBeenCalledTimes(1);
    });

    test('the owner can change anyone, and a title change needs no payroll right', async () => {
        const prisma = prismaFor({ id: 'e-2', userId: 44 });
        const svc = new EmployeeService(prisma);
        await svc.updateEmployee('e-2', 'b1', { hourlyRate: '12' }, { actor: owner });
        await svc.updateEmployee('e-2', 'b1', { title: 'Head waiter' }, { actor: manager });
        // Their own title is fine too: only pay is locked.
        const self = prismaFor({ id: 'e-self', userId: 31 });
        await new EmployeeService(self).updateEmployee('e-self', 'b1', { title: 'Shift lead' }, { actor: manager });
        expect(prisma.businessEmployee.update).toHaveBeenCalledTimes(2);
        expect(self.businessEmployee.update).toHaveBeenCalledTimes(1);
    });
});

describe('the business payout route', () => {
    test('looks the destination up among the owner\'s, not the caller\'s', () => {
        const fs = require('fs');
        const src = fs.readFileSync(require.resolve('../routes/businessOSRoutes.js'), 'utf8');
        const block = src.slice(src.indexOf("router.post('/finance/payout'"), src.indexOf("router.post('/finance/payout'") + 2500);
        expect(block).toMatch(/payoutDestination\.findFirst\(\{\s*where: \{ id: destination, userId: business\.userId \}/);
        expect(block).not.toMatch(/userId: req\.user\.id \}/);
    });
});
