const { isAdminRole, isAdminUser, normalizeRole } = require('../middleware/adminAccess');

describe('admin access role recognition', () => {
  test('normalizes role names safely', () => {
    expect(normalizeRole(' finance_admin ')).toBe('FINANCE_ADMIN');
    expect(normalizeRole(null)).toBe('');
  });

  test('keeps legacy ADMIN access', () => {
    expect(isAdminRole('ADMIN')).toBe(true);
    expect(isAdminUser({ role: 'admin' })).toBe(true);
  });

  test('recognizes each defined specialized admin role', () => {
    expect(isAdminRole('SUPER_ADMIN')).toBe(true);
    expect(isAdminRole('FINANCE_ADMIN')).toBe(true);
    expect(isAdminRole('SUPPORT_ADMIN')).toBe(true);
    expect(isAdminRole('COMPLIANCE_ADMIN')).toBe(true);
    expect(isAdminRole('READ_ONLY_ADMIN')).toBe(true);
  });

  test('does not grant admin access to ordinary roles', () => {
    expect(isAdminRole('USER')).toBe(false);
    expect(isAdminRole('VENDOR')).toBe(false);
    expect(isAdminUser({ role: 'USER' })).toBe(false);
    expect(isAdminUser(null)).toBe(false);
  });
});
