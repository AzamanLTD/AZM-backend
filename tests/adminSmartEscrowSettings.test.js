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

  test('PUT accepts valid Smart Escrow policy values and audits the change', async () => {
    const prisma = makePrisma(settings);
    const req = {
      app: { get: () => prisma },
      user: { id: 7, username: 'admin' },
      body: {
        smartEscrowFeePct: 0.0075,
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
        smartEscrowFeePct: 0.0075,
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
    ['smartEscrowFeePct', -0.01],
    ['smartEscrowFeePct', 1.01],
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
