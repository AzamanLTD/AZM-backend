const { installRetailCheckoutIntegrity } = require('../infra/install-retail-checkout-integrity');

describe('retail checkout schema convergence', () => {
  test('applies the full idempotent integrity sequence', async () => {
    const prisma = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    };

    const result = await installRetailCheckoutIntegrity(prisma);

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(9);
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(9);
    expect(prisma.$executeRawUnsafe.mock.calls[0][0]).toMatch(/DROP CONSTRAINT IF EXISTS "BusinessOrder_idempotencyKey_key"/);
    expect(prisma.$executeRawUnsafe.mock.calls[2][0]).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "BusinessOrder_businessProfileId_customerId_idempotencyKey_key"/);
    expect(prisma.$executeRawUnsafe.mock.calls[4][0]).toMatch(/BusinessOrderItem.*variants.*JSONB/);
    expect(prisma.$executeRawUnsafe.mock.calls[6][0]).toMatch(/azaman_retail_reserve_stock/);
    expect(prisma.$executeRawUnsafe.mock.calls[7][0]).toMatch(/azaman_retail_release_stock/);
    expect(prisma.$executeRawUnsafe.mock.calls[8][0]).toMatch(/azm_guard_smart_escrow_funding_transition/);
    expect(prisma.$executeRawUnsafe.mock.calls[8][0]).toMatch(/PENDING_SETTLEMENT/);
    expect(prisma.$executeRawUnsafe.mock.calls[8][0]).toMatch(/SETTLED.*RELEASED.*REFUNDED.*EXPIRED/);
  });

  test('surfaces schema convergence failure to the boot coordinator', async () => {
    const prisma = {
      $executeRawUnsafe: jest.fn().mockRejectedValue(new Error('database unavailable')),
    };

    await expect(installRetailCheckoutIntegrity(prisma)).rejects.toThrow('database unavailable');
  });
});
