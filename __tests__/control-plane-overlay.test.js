const { PERMISSIONS, DUTIES } = require('../infra/install-control-plane-overlay');

describe('control plane overlay catalog', () => {
  test('seeds a stable permission vocabulary', () => {
    const keys = PERMISSIONS.map(([, key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining([
      'platform.view',
      'finance.view',
      'finance.manage',
      'withdrawals.approve',
      'disputes.view',
      'disputes.investigate',
      'disputes.resolve',
      'access.manage_admins',
      'workforce.manage',
      'settings.manage',
    ]));
  });

  test('seeds duties across the intended operational departments', () => {
    const departments = new Set(DUTIES.map(([, , , , department]) => department));
    expect(departments).toEqual(new Set([
      'SUPPORT', 'ESCROW', 'FINANCE', 'MERCHANTS', 'COMPLIANCE', 'TECHNICAL',
    ]));
  });

  test('duty keys are stable and unique', () => {
    const keys = DUTIES.map(([, key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('escrow_disputes');
    expect(keys).toContain('withdrawals');
  });
});
