'use strict';

describe('DineInService transactional settlement contract', () => {
  test('the source service exposes a transaction-safe settlement path', () => {
    const fs = require('fs');
    const source = fs.readFileSync(require.resolve('./dineInService'), 'utf8');
    expect(source).toContain('this.prisma.$transaction');
    expect(source).toContain("'dine_in_tab_paid'");
  });
});
