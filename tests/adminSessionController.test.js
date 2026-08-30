const adminSessionController = require('../controllers/adminSessionController');
const authController = require('../controllers/authController');
const authTokenService = require('../services/authTokenService');

jest.mock('../controllers/authController', () => ({ login: jest.fn() }));
jest.mock('../services/authTokenService', () => ({
  rotateRefreshToken: jest.fn(),
  revokeRefreshToken: jest.fn(),
}));

describe('admin session controller', () => {
  beforeEach(() => jest.clearAllMocks());

  test('admin login stores refresh token in HttpOnly cookie and never returns it', async () => {
    authController.login.mockImplementation(async (_req, res) => {
      res.status(200).json({
        success: true,
        accessToken: 'admin-access',
        refreshToken: 'admin-refresh',
        refreshExpiresAt: '2030-01-01T00:00:00.000Z',
        user: { id: 1, username: 'admin', role: 'ADMIN' },
      });
    });
    const req = { headers: {} };
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    };

    await adminSessionController.login(req, response);

    expect(response.cookie).toHaveBeenCalledWith(
      'azm_admin_refresh',
      'admin-refresh',
      expect.objectContaining({ httpOnly: true })
    );
    const payload = response.json.mock.calls[0][0];
    expect(payload.accessToken).toBe('admin-access');
    expect(payload.refreshToken).toBeUndefined();
  });

  test('non-admin login is rejected and the newly-created refresh token is revoked', async () => {
    const prisma = {};
    authController.login.mockImplementation(async (_req, res) => {
      res.status(200).json({
        success: true,
        accessToken: 'vendor-access',
        refreshToken: 'vendor-refresh',
        refreshExpiresAt: '2030-01-01T00:00:00.000Z',
        user: { id: 7, username: 'vendor', role: 'VENDOR' },
      });
    });
    const req = { headers: {}, app: { get: jest.fn().mockReturnValue(prisma) } };
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    };

    await adminSessionController.login(req, response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(authTokenService.revokeRefreshToken).toHaveBeenCalledWith(prisma, 'vendor-refresh');
    expect(response.cookie).not.toHaveBeenCalled();
  });

  test('bootstrap rotates the admin cookie and rejects a rotated non-admin session', async () => {
    const prisma = {};
    authTokenService.rotateRefreshToken.mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      refreshExpiresAt: new Date('2030-02-01T00:00:00.000Z'),
      user: { id: 1, username: 'admin', role: 'ADMIN' },
    });
    const req = {
      app: { get: jest.fn().mockReturnValue(prisma) },
      headers: { cookie: 'azm_admin_refresh=old-refresh' },
      ip: '127.0.0.1',
    };
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    };

    await adminSessionController.bootstrap(req, response);

    expect(authTokenService.rotateRefreshToken).toHaveBeenCalledWith(
      prisma,
      'old-refresh',
      expect.objectContaining({ ipAddress: '127.0.0.1' })
    );
    expect(response.cookie).toHaveBeenCalledWith(
      'azm_admin_refresh',
      'new-refresh',
      expect.objectContaining({ httpOnly: true })
    );
    expect(response.json.mock.calls[0][0]).toEqual(expect.objectContaining({ accessToken: 'new-access' }));
    expect(response.json.mock.calls[0][0].refreshToken).toBeUndefined();
  });

  test('bootstrap refuses a session whose refreshed user is no longer an admin', async () => {
    const prisma = {};
    authTokenService.rotateRefreshToken.mockResolvedValue({
      accessToken: 'vendor-access',
      refreshToken: 'rotated-vendor-refresh',
      refreshExpiresAt: new Date('2030-02-01T00:00:00.000Z'),
      user: { id: 7, username: 'vendor', role: 'VENDOR' },
    });
    const req = {
      app: { get: jest.fn().mockReturnValue(prisma) },
      headers: { cookie: 'azm_admin_refresh=old-refresh' },
      ip: '127.0.0.1',
    };
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    };

    await adminSessionController.bootstrap(req, response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(authTokenService.revokeRefreshToken).toHaveBeenCalledWith(prisma, 'rotated-vendor-refresh');
    expect(response.clearCookie).toHaveBeenCalledWith('azm_admin_refresh', expect.any(Object));
  });
});
