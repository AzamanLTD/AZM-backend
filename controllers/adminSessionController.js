const logger = require('../src/config/logger');
const { rotateRefreshToken, revokeRefreshToken } = require('../services/authTokenService');

const COOKIE_NAME = 'azm_admin_refresh';
const production = () => process.env.NODE_ENV === 'production';
const cookieBase = () => ({
  httpOnly: true,
  secure: production(),
  sameSite: production() ? 'none' : 'lax',
  path: '/api/auth',
});

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

function setAdminSessionCookie(res, refreshToken, expiresAt) {
  res.cookie(COOKIE_NAME, refreshToken, { ...cookieBase(), expires: expiresAt });
}

function clearAdminSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, cookieBase());
}

// Browser login bridge for the Admin Portal. The refresh credential is never
// returned to JavaScript and is stored only in an HttpOnly cookie. Unlike the
// generic login endpoint, this bridge is deliberately ADMIN-only.
exports.login = async (req, res) => {
  const authController = require('./authController');
  let statusCode = 200;
  let payload = null;
  let sent = false;

  const internalRes = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; sent = true; return this; },
    send(body) { payload = body; sent = true; return this; },
  };

  try {
    await authController.login(req, internalRes);
  } catch (err) {
    logger.error({ err }, '[admin-session] login bridge error');
    return res.status(500).json({ success: false, message: 'Unable to sign in.' });
  }

  if (!sent || statusCode < 200 || statusCode >= 300 || !payload?.success) {
    return res.status(statusCode || 401).json(payload || { success: false, message: 'Invalid email or password' });
  }

  if (!payload.refreshToken || !payload.accessToken) {
    return res.status(502).json({ success: false, message: 'Authentication service returned an incomplete session.' });
  }

  if (String(payload.user?.role || '').toUpperCase() !== 'ADMIN') {
    try {
      await revokeRefreshToken(req.app?.get?.('prisma'), payload.refreshToken);
    } catch (err) {
      logger.error({ err }, '[admin-session] failed to revoke non-admin login token');
    }
    return res.status(403).json({ success: false, message: 'Admin credentials required.' });
  }

  setAdminSessionCookie(res, payload.refreshToken, new Date(payload.refreshExpiresAt));
  return res.status(statusCode).json({
    success: true,
    message: payload.message || 'Login successful',
    accessToken: payload.accessToken,
    user: payload.user,
    refreshExpiresAt: payload.refreshExpiresAt,
  });
};

exports.bootstrap = async (req, res) => {
  const prisma = req.app.get('prisma');
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return res.status(401).json({ success: false, message: 'Admin session is not available.', code: 'REFRESH_INVALID' });

  try {
    const result = await rotateRefreshToken(prisma, token, { userAgent: req.headers['user-agent'], ipAddress: req.ip });
    if (!result) {
      clearAdminSessionCookie(res);
      return res.status(401).json({ success: false, message: 'Admin session is invalid or expired.', code: 'REFRESH_INVALID' });
    }
    if (String(result.user?.role || '').toUpperCase() !== 'ADMIN') {
      await revokeRefreshToken(prisma, result.refreshToken);
      clearAdminSessionCookie(res);
      return res.status(403).json({ success: false, message: 'Admin credentials required.', code: 'ADMIN_REQUIRED' });
    }
    setAdminSessionCookie(res, result.refreshToken, result.refreshExpiresAt);
    return res.json({
      success: true,
      accessToken: result.accessToken,
      refreshExpiresAt: result.refreshExpiresAt.toISOString(),
      user: { id: result.user.id, username: result.user.username, role: result.user.role },
    });
  } catch (err) {
    logger.error({ err }, '[admin-session] bootstrap error');
    return res.status(500).json({ success: false, message: 'Unable to restore admin session.' });
  }
};

exports.logout = async (req, res) => {
  const prisma = req.app.get('prisma');
  const token = readCookie(req, COOKIE_NAME);
  try {
    if (token) await revokeRefreshToken(prisma, token);
  } catch (err) {
    logger.error({ err }, '[admin-session] logout revoke error');
  }
  clearAdminSessionCookie(res);
  return res.json({ success: true, message: 'Logged out.' });
};
