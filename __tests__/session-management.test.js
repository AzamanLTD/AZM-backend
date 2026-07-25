// __tests__/session-management.test.js
// =============================================================================
// Session management controller tests — list, revoke single, revoke all.
// Uses mock Prisma (no database required).
// =============================================================================

const sessionController = require('../controllers/sessionController');

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
    headers: {},
    app: { get: () => mockPrisma },
    params: {},
    ...overrides,
  };
}

const mockPrisma = {
  refreshToken: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  user: {
    update: jest.fn(),
  },
  $transaction: jest.fn(),
};

describe('Session Management: listSessions', () => {
  beforeEach(() => jest.clearAllMocks());

  test('lists active sessions with formatted device labels', async () => {
    mockPrisma.refreshToken.findMany.mockResolvedValue([
      {
        id: 'tok-1',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0',
        ipAddress: '192.168.1.1',
        createdAt: new Date('2026-07-20'),
        expiresAt: new Date('2026-08-20'),
      },
      {
        id: 'tok-2',
        userAgent: 'Dart/3.0 (flutter)',
        ipAddress: '10.0.0.5',
        createdAt: new Date('2026-07-22'),
        expiresAt: new Date('2026-08-22'),
      },
      {
        id: 'tok-3',
        userAgent: null,
        ipAddress: null,
        createdAt: new Date('2026-07-23'),
        expiresAt: new Date('2026-08-23'),
      },
    ]);

    const res = mockRes();
    await sessionController.listSessions(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(3);
    expect(res.body.sessions[0].device).toBe('Chrome on Windows');
    expect(res.body.sessions[1].device).toBe('iOS App'); // Flutter → "iOS App" since not Android
    expect(res.body.sessions[2].device).toBe('Unknown device');
  });

  test('returns empty list when no active sessions', async () => {
    mockPrisma.refreshToken.findMany.mockResolvedValue([]);
    const res = mockRes();
    await sessionController.listSessions(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.sessions).toHaveLength(0);
  });

  test('handles DB error gracefully', async () => {
    mockPrisma.refreshToken.findMany.mockRejectedValue(new Error('DB down'));
    const res = mockRes();
    await sessionController.listSessions(mockReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe('Session Management: revokeAllSessions', () => {
  beforeEach(() => jest.clearAllMocks());

  test('revokes all sessions and returns count', async () => {
    mockPrisma.$transaction.mockResolvedValue([
      { tokenVersion: 3 },
      { count: 5 },
    ]);

    const res = mockRes();
    await sessionController.revokeAllSessions(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.revokedCount).toBe(5);
  });

  test('handles DB error gracefully', async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error('DB down'));
    const res = mockRes();
    await sessionController.revokeAllSessions(mockReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe('Session Management: revokeSession', () => {
  beforeEach(() => jest.clearAllMocks());

  test('revokes a session that belongs to the user', async () => {
    mockPrisma.refreshToken.findUnique.mockResolvedValue({
      userId: 1,
      revokedAt: null,
    });
    mockPrisma.refreshToken.update.mockResolvedValue({ id: 'tok-1' });

    const res = mockRes();
    await sessionController.revokeSession(
      mockReq({ params: { id: 'tok-1' } }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Session revoked.');
  });

  test('returns 404 when session belongs to another user', async () => {
    mockPrisma.refreshToken.findUnique.mockResolvedValue({
      userId: 999, // different user
      revokedAt: null,
    });

    const res = mockRes();
    await sessionController.revokeSession(
      mockReq({ params: { id: 'tok-1' } }),
      res
    );

    expect(res.statusCode).toBe(404);
    expect(res.body.message).toBe('Session not found.');
  });

  test('returns 404 when session does not exist', async () => {
    mockPrisma.refreshToken.findUnique.mockResolvedValue(null);

    const res = mockRes();
    await sessionController.revokeSession(
      mockReq({ params: { id: 'nonexistent' } }),
      res
    );

    expect(res.statusCode).toBe(404);
  });

  test('returns success when already revoked (idempotent)', async () => {
    mockPrisma.refreshToken.findUnique.mockResolvedValue({
      userId: 1,
      revokedAt: new Date(), // already revoked
    });

    const res = mockRes();
    await sessionController.revokeSession(
      mockReq({ params: { id: 'tok-1' } }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe('Session was already revoked.');
  });

  test('does not call update when already revoked', async () => {
    mockPrisma.refreshToken.findUnique.mockResolvedValue({
      userId: 1,
      revokedAt: new Date(),
    });

    await sessionController.revokeSession(
      mockReq({ params: { id: 'tok-1' } }),
      mockRes()
    );

    expect(mockPrisma.refreshToken.update).not.toHaveBeenCalled();
  });
});

describe('Session Management: User-Agent parsing', () => {
  test('Flutter Android app', async () => {
    mockPrisma.refreshToken.findMany.mockResolvedValue([
      { id: 't1', userAgent: 'Dart VM/3.0 (flutter) Android', ipAddress: '1.2.3.4', createdAt: new Date(), expiresAt: new Date() },
    ]);
    const res = mockRes();
    await sessionController.listSessions(mockReq(), res);
    expect(res.body.sessions[0].device).toBe('Android App');
  });

  test('Firefox on macOS', async () => {
    mockPrisma.refreshToken.findMany.mockResolvedValue([
      { id: 't1', userAgent: 'Mozilla/5.0 (Macintosh; Firefox/120.0)', ipAddress: '1.2.3.4', createdAt: new Date(), expiresAt: new Date() },
    ]);
    const res = mockRes();
    await sessionController.listSessions(mockReq(), res);
    expect(res.body.sessions[0].device).toBe('Firefox on macOS');
  });

  test('Linux Chrome', async () => {
    mockPrisma.refreshToken.findMany.mockResolvedValue([
      { id: 't1', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0', ipAddress: '1.2.3.4', createdAt: new Date(), expiresAt: new Date() },
    ]);
    const res = mockRes();
    await sessionController.listSessions(mockReq(), res);
    expect(res.body.sessions[0].device).toBe('Chrome on Linux');
  });
});
