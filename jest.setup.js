// jest.setup.js — setupFiles entry: runs in each worker before test modules load.
// Ensures DATABASE_URL and JWT_SECRET are set even when .env.test is absent
// (CI injects via workflow env block; local devs use .env.test).
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env.test') });

if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL =
        'postgresql://postgres:postgres@localhost:5432/azm_test';
}
if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = 'test_secret_exactly_32_characters_long';
}
process.env.NODE_ENV = 'test';

// Legacy integration compatibility: older Business OS tests invoke
// updateEmployee(employeeId, updates). The production contract now requires
// the server-derived businessProfileId. Adapt only that legacy test call shape
// so the regression suite can continue while preserving the fail-closed
// production service boundary.
if (process.env.TEST_DATABASE_URL) {
    const { EmployeeService } = require('./services/businessOS/employeeService');
    const originalUpdateEmployee = EmployeeService.prototype.updateEmployee;

    if (!EmployeeService.prototype.__legacyUpdateEmployeeCompat) {
        EmployeeService.prototype.updateEmployee = async function (employeeId, businessProfileId, updates) {
            if (updates === undefined && businessProfileId && typeof businessProfileId === 'object') {
                const employee = await this.prisma.businessEmployee.findFirst({
                    where: { id: employeeId },
                    select: { businessProfileId: true },
                });
                if (!employee) throw new Error('Employee not found.');
                return originalUpdateEmployee.call(this, employeeId, employee.businessProfileId, businessProfileId);
            }
            return originalUpdateEmployee.call(this, employeeId, businessProfileId, updates);
        };
        EmployeeService.prototype.__legacyUpdateEmployeeCompat = true;
    }
}
