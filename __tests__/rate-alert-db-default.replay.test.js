const fs = require('fs');
const path = require('path');

describe('RateAlert canonical pair migration', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'prisma', 'migrations', '20260904123000_rate_alert_canonical_pair', 'migration.sql'),
    'utf8',
  );

  test('changes only the database default to USDC_GHS', () => {
    expect(migration).toContain('ALTER TABLE "RateAlert"');
    expect(migration).toContain('ALTER COLUMN "ratePair" SET DEFAULT \'USDC_GHS\'');
    expect(migration).not.toContain('UPDATE "RateAlert"');
  });
});
