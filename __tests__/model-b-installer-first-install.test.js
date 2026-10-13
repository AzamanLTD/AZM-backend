/**
 * Recovery regression: production does not run Prisma db-push. The guarded
 * Model B release installer must therefore create the P5-B inventory lot
 * substrate itself when recovering an original production branch.
 *
 * This test only drops/recreates tables in disposable TEST_DATABASE_URL.
 */
const describeOrSkip = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const { PrismaClient } = require('@prisma/client');

describeOrSkip('Model B installer provisions inventory substrate on first install', () => {
  let prisma;

  beforeAll(() => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  test('creates InventoryLot and InventoryLotConsumption when both are absent', async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "InventoryLotConsumption" CASCADE');
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "InventoryLot" CASCADE');
    await prisma.$executeRawUnsafe('DROP TYPE IF EXISTS "InventoryLotStatus" CASCADE');

    const { STATEMENTS } = require('../infra/install-model-b-settlement-overlay');
    for (const statement of STATEMENTS) {
      await prisma.$executeRawUnsafe(statement);
    }

    const objects = await prisma.$queryRawUnsafe(`SELECT
      to_regclass('"InventoryLot"') IS NOT NULL AS lot_exists,
      to_regclass('"InventoryLotConsumption"') IS NOT NULL AS consumption_exists,
      to_regclass('"ModelBSettlement"') IS NOT NULL AS settlement_exists`);
    expect(objects[0]).toEqual({
      lot_exists: true,
      consumption_exists: true,
      settlement_exists: true,
    });

    const requiredIndexes = await prisma.$queryRawUnsafe(`SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'InventoryLot_acquisitionKey_key',
          'InventoryLotConsumption_consumptionKey_key',
          'InventoryLotConsumption_lotId_idx',
          'InventoryLot_eligible_status_idx'
        ) ORDER BY indexname`);
    expect(requiredIndexes.map((row) => row.indexname)).toEqual([
      'InventoryLotConsumption_consumptionKey_key',
      'InventoryLotConsumption_lotId_idx',
      'InventoryLot_acquisitionKey_key',
      'InventoryLot_eligible_status_idx',
    ].sort());

    const constraints = await prisma.$queryRawUnsafe(`SELECT conname
      FROM pg_constraint
      WHERE conrelid IN ('"InventoryLot"'::regclass, '"InventoryLotConsumption"'::regclass)
        AND conname IN (
          'InventoryLot_qty_positive_check',
          'InventoryLot_remaining_bounds_check',
          'InventoryLot_cost_positive_check',
          'InventoryLotConsumption_qty_positive_check',
          'InventoryLotConsumption_lotId_fkey'
        ) ORDER BY conname`);
    expect(constraints.map((row) => row.conname)).toEqual([
      'InventoryLotConsumption_lotId_fkey',
      'InventoryLotConsumption_qty_positive_check',
      'InventoryLot_cost_positive_check',
      'InventoryLot_qty_positive_check',
      'InventoryLot_remaining_bounds_check',
    ]);
  });
});
