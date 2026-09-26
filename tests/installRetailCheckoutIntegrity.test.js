const { installRetailCheckoutIntegrity } = require('../infra/install-retail-checkout-integrity');

describe('retail checkout schema convergence', () => {
  test('applies the full idempotent integrity sequence', async () => {
    const prisma = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    };

    const result = await installRetailCheckoutIntegrity(prisma);

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(12);
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(12);
    expect(prisma.$executeRawUnsafe.mock.calls[0][0]).toMatch(/DROP CONSTRAINT IF EXISTS "BusinessOrder_idempotencyKey_key"/);
    expect(prisma.$executeRawUnsafe.mock.calls[2][0]).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "BusinessOrder_businessProfileId_customerId_idempotencyKey_key"/);
    expect(prisma.$executeRawUnsafe.mock.calls[4][0]).toMatch(/BusinessOrderItem.*variants.*JSONB/);
    // Function bodies and CREATE TRIGGER statements must be SEPARATE single
    // commands: Postgres rejects multi-command prepared statements, and the
    // old bundled form meant the triggers never actually installed.
    expect(prisma.$executeRawUnsafe.mock.calls[6][0]).toMatch(/^CREATE OR REPLACE FUNCTION azaman_retail_reserve_stock/);
    expect(prisma.$executeRawUnsafe.mock.calls[7][0]).toMatch(/^CREATE OR REPLACE TRIGGER azaman_retail_reserve_stock/);
    expect(prisma.$executeRawUnsafe.mock.calls[8][0]).toMatch(/^CREATE OR REPLACE FUNCTION azaman_retail_release_stock/);
    expect(prisma.$executeRawUnsafe.mock.calls[9][0]).toMatch(/^CREATE OR REPLACE TRIGGER azaman_retail_release_stock/);
    expect(prisma.$executeRawUnsafe.mock.calls[10][0]).toMatch(/^CREATE OR REPLACE FUNCTION azm_guard_smart_escrow_funding_transition/);
    expect(prisma.$executeRawUnsafe.mock.calls[10][0]).toMatch(/PENDING_SETTLEMENT/);
    expect(prisma.$executeRawUnsafe.mock.calls[10][0]).toMatch(/SETTLED.*RELEASED.*REFUNDED.*EXPIRED/);
    expect(prisma.$executeRawUnsafe.mock.calls[11][0]).toMatch(/^CREATE OR REPLACE TRIGGER azm_guard_smart_escrow_funding_transition/);
    for (const call of prisma.$executeRawUnsafe.mock.calls) {
      // No statement may bundle two SQL commands — that is the exact failure
      // mode (42601) that silently kept the triggers off production.
      expect(call[0].match(/;\s*(DROP|CREATE) TRIGGER/)).toBeNull();
    }
  });

  test('surfaces schema convergence failure to the boot coordinator', async () => {
    const prisma = {
      $executeRawUnsafe: jest.fn().mockRejectedValue(new Error('database unavailable')),
    };

    await expect(installRetailCheckoutIntegrity(prisma)).rejects.toThrow('database unavailable');
  });
});
