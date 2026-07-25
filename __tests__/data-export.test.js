// __tests__/data-export.test.js
// =============================================================================
// GDPR data export controller tests — verifies export structure + completeness.
// Uses mock Prisma (no database required).
// =============================================================================

const dataExportController = require('../controllers/dataExportController');

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
  return res;
}

function mockReq(overrides = {}) {
  return {
    user: { id: 1 },
    query: {},
    app: { get: () => mockPrisma },
    ...overrides,
  };
}

const mockPrisma = {
  user: { findUnique: jest.fn() },
  refreshToken: { findMany: jest.fn() },
  contact: { findMany: jest.fn() },
  transactionHistory: { findMany: jest.fn() },
  trade: { findMany: jest.fn() },
  savingsDeposit: { findMany: jest.fn() },
  withdrawal: { findMany: jest.fn() },
  savingsGoal: { findMany: jest.fn() },
  savedMomoAccount: { findMany: jest.fn() },
  smartEscrow: { findMany: jest.fn() },
  employeeFeedback: { findMany: jest.fn() },
  vendorAchievement: { findMany: jest.fn() },
};

describe('GDPR Data Export: exportUserData', () => {
  beforeEach(() => jest.clearAllMocks());

  test('exports all user data in structured format', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 1, username: 'testuser', email: 'test@test.com', role: 'USER',
      availableBalance: 100, azmBalance: 50,
    });
    mockPrisma.refreshToken.findMany.mockResolvedValue([
      { id: 't1', userAgent: 'Chrome', ipAddress: '1.2.3.4', createdAt: new Date(), expiresAt: new Date(), revokedAt: null },
    ]);
    mockPrisma.contact.findMany.mockResolvedValue([]);
    mockPrisma.transactionHistory.findMany.mockResolvedValue([
      { id: 1, amount: 50, type: 'DEPOSIT', createdAt: new Date() },
    ]);
    mockPrisma.trade.findMany.mockResolvedValue([]);
    mockPrisma.savingsDeposit.findMany.mockResolvedValue([{ id: 1, amount: 50, status: 'COMPLETED' }]);
    mockPrisma.withdrawal.findMany.mockResolvedValue([]);
    mockPrisma.savingsGoal.findMany.mockResolvedValue([]);
    mockPrisma.savedMomoAccount.findMany.mockResolvedValue([]);
    mockPrisma.smartEscrow.findMany.mockResolvedValue([]);
    mockPrisma.employeeFeedback.findMany.mockResolvedValue([]);
    mockPrisma.vendorAchievement.findMany.mockResolvedValue([]);
    
    const res = mockRes();
    await dataExportController.exportUserData(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.user.username).toBe('testuser');
    expect(res.body.data.transactions).toHaveLength(1);
    expect(res.body.data.summary.totalTransactions).toBe(1);
    expect(res.body.data.summary.totalDeposits).toBe(1);
    expect(res.body.data.summary.activeSessions).toBe(1);
    expect(res.body.data.exportedAt).toBeDefined();
  });

  test('returns 404 when user not found', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = mockRes();
    await dataExportController.exportUserData(mockReq(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test('handles DB error gracefully', async () => {
    mockPrisma.user.findUnique.mockRejectedValue(new Error('DB down'));
    const res = mockRes();
    await dataExportController.exportUserData(mockReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });

  test('respects limit query param (max 500)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 1 });
    mockPrisma.refreshToken.findMany.mockResolvedValue([]);
    mockPrisma.contact.findMany.mockResolvedValue([]);
    mockPrisma.transactionHistory.findMany.mockResolvedValue([]);
    mockPrisma.trade.findMany.mockResolvedValue([]);
    mockPrisma.savingsDeposit.findMany.mockResolvedValue([]);
    mockPrisma.withdrawal.findMany.mockResolvedValue([]);
    mockPrisma.savingsGoal.findMany.mockResolvedValue([]);
    mockPrisma.savedMomoAccount.findMany.mockResolvedValue([]);
    mockPrisma.smartEscrow.findMany.mockResolvedValue([]);
    mockPrisma.employeeFeedback.findMany.mockResolvedValue([]);
    mockPrisma.vendorAchievement.findMany.mockResolvedValue([]);
    
    await dataExportController.exportUserData(
      mockReq({ query: { limit: '1000' } }),
      mockRes()
    );

    // Check that findMany was called with take: 500 (capped)
    const call = mockPrisma.transactionHistory.findMany.mock.calls[0][0];
    expect(call.take).toBe(500);
  });

  test('uses default limit of 100 when not specified', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 1 });
    mockPrisma.refreshToken.findMany.mockResolvedValue([]);
    mockPrisma.contact.findMany.mockResolvedValue([]);
    mockPrisma.transactionHistory.findMany.mockResolvedValue([]);
    mockPrisma.trade.findMany.mockResolvedValue([]);
    mockPrisma.savingsDeposit.findMany.mockResolvedValue([]);
    mockPrisma.withdrawal.findMany.mockResolvedValue([]);
    mockPrisma.savingsGoal.findMany.mockResolvedValue([]);
    mockPrisma.savedMomoAccount.findMany.mockResolvedValue([]);
    mockPrisma.smartEscrow.findMany.mockResolvedValue([]);
    mockPrisma.employeeFeedback.findMany.mockResolvedValue([]);
    mockPrisma.vendorAchievement.findMany.mockResolvedValue([]);
    
    await dataExportController.exportUserData(mockReq(), mockRes());

    const call = mockPrisma.transactionHistory.findMany.mock.calls[0][0];
    expect(call.take).toBe(100);
  });
});
