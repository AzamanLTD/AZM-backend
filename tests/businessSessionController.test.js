const businessSessionController = require('../controllers/businessSessionController');
const authController = require('../controllers/authController');
const authTokenService = require('../services/authTokenService');

jest.mock('../controllers/authController', () => ({
  login: jest.fn(),
}));

jest.mock('../services/authTokenService', () => ({
  rotateRefreshToken: jest.fn(),
  revokeRefreshToken: jest.fn(),
}));

describe('business session controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('login bridge captures refresh token in HttpOnly cookie and never returns it to browser JS', async () => {
    authController.login.mockImplementation(async (_req, res) => {
      res.status(200).json({
        success: true,
        message: 'Login successful',
        accessToken: 'access-token',
        refreshToken: 'refresh-secret',
        refreshExpiresAt: '2030-01-01T00:00:00.000Z',
        user: { id: 7, username: 'merchant', role: 'VENDOR' },
      });
    });

    const req = { headers: {}, body: { email: 'merchant@example.com', password: 'StrongPass1!' } };
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    };

    await businessSessionController.login(req, response);

    expect(response.cookie).toHaveBeenCalledWith(
      'azm_business_refresh',
      'refresh-secret',
      expect.objectContaining({ httpOnly: true })
    );
    const returnedPayload = response.json.mock.calls[0][0];
    expect(returnedPayload.accessToken).toBe('access-token');
    expect(returnedPayload.refreshToken).toBeUndefined();
  });

  test('bootstrap rotates the HttpOnly cookie and returns only a fresh access token', async () => {
    authTokenService.rotateRefreshToken.mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      refreshExpiresAt: new Date('2030-02-01T00:00:00.000Z'),
      user: { id: 7, username: 'merchant', role: 'VENDOR' },
    });

    const req = {
      app: { get: jest.fn().mockReturnValue({}) },
      headers: { cookie: 'azm_business_refresh=old-refresh' },
      body: {},
      ip: '127.0.0.1',
    };
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    };

    await businessSessionController.bootstrap(req, response);

    expect(authTokenService.rotateRefreshToken).toHaveBeenCalledWith(
      {},
      'old-refresh',
      expect.objectContaining({ ipAddress: '127.0.0.1' })
    );
    expect(response.cookie).toHaveBeenCalledWith(
      'azm_business_refresh',
      'new-refresh',
      expect.objectContaining({ httpOnly: true })
    );
    expect(response.json.mock.calls[0][0]).toEqual(expect.objectContaining({ accessToken: 'new-access' }));
    expect(response.json.mock.calls[0][0].refreshToken).toBeUndefined();
  });
});
