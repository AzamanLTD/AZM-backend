const logger = require('../src/config/logger');
const { rotateRefreshToken, revokeRefreshToken } = require('../services/authTokenService');

const COOKIE_NAME = 'azm_business_refresh';
const BUSINESS_CLIENT_HEADER = 'x-auth-client';
const BUSINESS_CLIENT_VALUE = 'business-portal';
const production = () => process.env.NODE_ENV === 'production';
const cookieBase = () => ({ httpOnly: true, secure: production(), sameSite: production() ? 'none' : 'lax', path: '/api/auth' });

function isBusinessPortalClient(req) {
  return String(req.headers[BUSINESS_CLIENT_HEADER] || '').trim().toLowerCase() === BUSINESS_CLIENT_VALUE;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

function setBusinessSessionCookie(res, refreshToken, expiresAt) {
  res.cookie(COOKIE_NAME, refreshToken, { ...cookieBase(), expires: expiresAt });
}

function clearBusinessSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, cookieBase());
}

exports.isBusinessPortalClient = isBusinessPortalClient;
exports.setBusinessSessionCookie = setBusinessSessionCookie;
exports.clearBusinessSessionCookie = clearBusinessSessionCookie;

// Dedicated browser login bridge. The normal /auth/login response includes a
// refresh token for native clients. Browser clients must never receive that
// credential: it is captured server-side and immediately moved into the
// HttpOnly business-session cookie.
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
    logger.error({ err }, '[business-session] login bridge error');
    return res.status(500).json({ success: false, message: 'Unable to sign in.' });
  }

  if (!sent || statusCode < 200 || statusCode >= 300 || !payload?.success) {
    return res.status(statusCode || 401).json(payload || { success: false, message: 'Invalid email or password' });
  }

  if (!payload.refreshToken || !payload.accessToken) {
    return res.status(502).json({ success: false, message: 'Authentication service returned an incomplete session.' });
  }

  setBusinessSessionCookie(res, payload.refreshToken, new Date(payload.refreshExpiresAt));
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
  const token = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : readCookie(req, COOKIE_NAME);
  if (!token) return res.status(401).json({ success: false, message: 'Business session is not available.', code: 'REFRESH_INVALID' });
  try {
    const result = await rotateRefreshToken(prisma, token, { userAgent: req.headers['user-agent'], ipAddress: req.ip });
    if (!result) {
      clearBusinessSessionCookie(res);
      return res.status(401).json({ success: false, message: 'Business session is invalid or expired.', code: 'REFRESH_INVALID' });
    }
    setBusinessSessionCookie(res, result.refreshToken, result.refreshExpiresAt);
    return res.json({ success: true, accessToken: result.accessToken, refreshExpiresAt: result.refreshExpiresAt.toISOString(), user: { id: result.user.id, username: result.user.username, role: result.user.role } });
  } catch (err) {
    logger.error({ err }, '[business-session] bootstrap error');
    return res.status(500).json({ success: false, message: 'Unable to restore business session.' });
  }
};

exports.logout = async (req, res) => {
  const prisma = req.app.get('prisma');
  const token = readCookie(req, COOKIE_NAME);
  try { if (token) await revokeRefreshToken(prisma, token); } catch (err) { logger.error({ err }, '[business-session] logout revoke error'); }
  clearBusinessSessionCookie(res);
  return res.json({ success: true, message: 'Logged out.' });
};