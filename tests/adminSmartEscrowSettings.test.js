const controller = require('../controllers/adminSettingsController');

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function makePrisma(settings) {
  return {
    globalSettings: {
      findUnique: jest.fn().mockResolvedValue(settings),
      create: jest.fn().mockResolvedValue(settings),
      update: jest.fn().mockResolvedValue({ ...settings }),
    },
    adminSettingsAuditLog: {
      create: jest.fn().mockResolvedValue({ id: 1 }),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn().mockResolvedValue([{ ...settings }]),
  };
}

describe('Admin Smart Escrow platform settings', () => {
  const settings = {
    id: 1,
    smartEscrowFeePct: 0.005,
    escrowDraftExpiryHours: 24,
    escrowFundedExpiryDays: 30,
  };

  test('GET exposes persisted Smart Escrow policy values', async () => {
    const prisma = makePrisma(settings);
    const req = { app: { get: () => prisma } };
    const res = makeRes();

    await controller.getSettings(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.settings.smartEscrowFeePct).toBe(0.005);
    expect(payload.settings.escrowDraftExpiryHours).toBe(24);
    expect(payload.settings.escrowFundedExpiryDays).toBe(30);
  });

  // The escrow fee is a Fee Lab rate (published with a second factor and a
  // stale check): resent unchanged it is ignored, so the policy form still
  // saves its expiry windows.
  test('PUT accepts valid Smart Escrow policy values and audits the change', async () => {
    const prisma = makePrisma(settings);
    const req = {
      app: { get: () => prisma },
      user: { id: 7, username: 'admin' },
      body: {
        smartEscrowFeePct: 0.005,
        escrowDraftExpiryHours: 48,
        escrowFundedExpiryDays: 45,
      },
    };
    const res = makeRes();

    await controller.updateSettings(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.globalSettings.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        escrowDraftExpiryHours: 48,
        escrowFundedExpiryDays: 45,
      },
    });
    expect(prisma.adminSettingsAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'UPDATE_SETTINGS',
          targetType: 'GLOBAL_SETTINGS',
          targetId: '1',
        }),
      })
    );
  });

  test.each([
    ['smartEscrowFeePct', 0.0075],
    ['smartEscrowFeePct', -0.01],
    ['smartEscrowFeePct', 1.01],
    ['p2pFeePct', 0.03],
    ['susuProfitPct', 0.05],
    ['feeByPaymentMethod', { PAYPAL: 0.03 }],
    ['withdrawalFeeByRiskTier', { STANDARD: 0.01, TRUSTED: 0.005, HIGH_RISK: 0.05 }],
  ])('a changed fee rate %s=%j is refused: it is published from the Fee Lab', async (field, value) => {
    const prisma = makePrisma({
      ...settings,
      p2pFeePct: 0.02,
      susuProfitPct: 0.03,
      feeByPaymentMethod: { PAYPAL: 0.04 },
      withdrawalFeeByRiskTier: { STANDARD: 0.02, TRUSTED: 0.005, HIGH_RISK: 0.05 },
    });
    const req = { app: { get: () => prisma }, user: { id: 7, username: 'admin' }, body: { [field]: value } };
    const res = makeRes();

    await controller.updateSettings(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].code).toBe('FEE_MANAGED_IN_FEE_LAB');
    expect(res.json.mock.calls[0][0].fields[0]).toMatch(new RegExp(`^${field}`));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('a new payment method\'s rate (not a Fee Lab entry) can still be set here', async () => {
    const prisma = makePrisma({ ...settings, feeByPaymentMethod: { PAYPAL: 0.04 } });
    const req = {
      app: { get: () => prisma },
      user: { id: 7, username: 'admin' },
      body: { feeByPaymentMethod: { PAYPAL: 0.04, MOMO_P2P: 0.01 } },
    };
    const res = makeRes();
    await controller.updateSettings(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(prisma.globalSettings.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { feeByPaymentMethod: { PAYPAL: 0.04, MOMO_P2P: 0.01 } } });
  });

  test('fee rate maps resent unchanged (as JSON text or with float noise) still save', async () => {
    const prisma = makePrisma({ ...settings, feeByPaymentMethod: { PAYPAL: 0.04, ZELLE: 0.02 } });
    const req = {
      app: { get: () => prisma },
      user: { id: 7, username: 'admin' },
      body: { feeByPaymentMethod: JSON.stringify({ ZELLE: 0.020000000000000001, PAYPAL: 0.04 }), escrowDraftExpiryHours: 36 },
    };
    const res = makeRes();
    await controller.updateSettings(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(prisma.globalSettings.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 1 } }));
    expect(prisma.globalSettings.update.mock.calls[0][0].data.escrowDraftExpiryHours).toBe(36);
  });

  test.each([
    ['escrowDraftExpiryHours', 0],
    ['escrowDraftExpiryHours', 721],
    ['escrowFundedExpiryDays', 0],
    ['escrowFundedExpiryDays', 3651],
  ])('rejects invalid %s=%s', async (field, value) => {
    const prisma = makePrisma(settings);
    const req = {
      app: { get: () => prisma },
      user: { id: 7, username: 'admin' },
      body: { [field]: value },
    };
    const res = makeRes();

    await controller.updateSettings(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
