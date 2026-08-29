// Business Portal browser session bridge.
// Exchanges the Phase-K refresh token once, then keeps the rotated refresh
// token in an HttpOnly cookie so browser JavaScript never needs to persist it.
const logger = require('../src/config/logger');
const { rotateRefreshToken, revokeRefreshToken } = require('../services/authTokenService');

const COOKIE_NAME = 'azm_business_refresh';
const isProduction = () => process.env.NODE_ENV === 'production';

function cookieOptions(expiresAt) {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: isProduction() ? 'none' : 'lax',
    path: '/api/auth',
    expires: expiresAt,
  };
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

exports.bootstrap = async (req, res) => {
  const prisma = req.app.get('prisma');
  const inbound = typeof req.body?.refreshToken === 'string'
    ? req.body.refreshToken
    : readCookie(req, COOKIE_NAME);

  if (!inbound) {
    return res.status(401).json({ success: false, message: 'Business session is not available.', code: 'REFRESH_INVALID' });
  }

  try {
    const result = await rotateRefreshToken(prisma, inbound, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });

    if (!result) {
      res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: isProduction(), sameSite: isProduction() ? 'none' : 'lax', path: '/api/auth' });
      return res.status(401).json({ success: false, message: 'Business session is invalid or expired.', code: 'REFRESH_INVALID' });
    }

    res.cookie(COOKIE_NAME, result.refreshToken, cookieOptions(result.refreshExpiresAt));
    return res.status(200).json({
      success: true,
      accessToken: result.accessToken,
      refreshExpiresAt: result.refreshExpiresAt.toISOString(),
      user: { id: result.user.id, username: result.user.username, role: result.user.role },
    });
  } catch (err) {
    logger.error({ err }, '[business-session] bootstrap error');
    return res.status(500).json({ success: false, message: 'Unable to restore business session.' });
  }
};

exports.logout = async (req, res) => {
  const prisma = req.app.get('prisma');
  const token = readCookie(req, COOKIE_NAME);
  try {
    if (token) await revokeRefreshToken(prisma, token);
  } catch (err) {
    logger.error({ err }, '[business-session] logout revoke error');
  }
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: isProduction(), sameSite: isProduction() ? 'none' : 'lax', path: '/api/auth' });
  return res.status(200).json({ success: true, message: 'Logged out.' });
};
