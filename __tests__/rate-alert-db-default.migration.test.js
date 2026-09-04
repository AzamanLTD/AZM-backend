const fs = require('fs');
const path = require('path');

describe('RateAlert canonical pair migration', () => {
  test('changes only the future database default and preserves legacy rows', () => {
    const migrationPath = path.join(
      __dirname,
      '..',
      'prisma',
      'migrations',
      '20260904110000_rate_alert_canonical_pair',
      'migration.sql',
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('ALTER COLUMN "ratePair" SET DEFAULT \'USDC_GHS\'');
    expect(sql).not.toMatch(/UPDATE\s+"RateAlert"/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+"RateAlert"/i);
  });
});
