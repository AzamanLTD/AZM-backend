const { hasPermission, getStaffProfile } = require('../services/platformAccessService');

/**
 * Authorization middleware for platform staff endpoints.
 *
 * `protect` should run before this middleware so req.user is populated.
 * The Prisma instance is resolved from req.app.get('prisma') when available,
 * or from req.prisma for existing test/integration harnesses.
 */
function requirePlatformPermission(permissionKey) {
  if (!permissionKey || typeof permissionKey !== 'string') {
    throw new TypeError('permissionKey is required');
  }

  return async function platformPermissionGuard(req, res, next) {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
      }

      const prisma = req.prisma || (req.app && req.app.get && req.app.get('prisma'));
      if (!prisma) {
        return res.status(500).json({ success: false, message: 'Platform access database unavailable' });
      }

      const allowed = await hasPermission(prisma, req.user.id, permissionKey);
      if (!allowed) {
        return res.status(403).json({ success: false, message: 'Insufficient platform permission' });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

async function requirePlatformStaff(req, res, next) {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const prisma = req.prisma || (req.app && req.app.get && req.app.get('prisma'));
    if (!prisma) {
      return res.status(500).json({ success: false, message: 'Platform access database unavailable' });
    }

    const profile = await getStaffProfile(prisma, req.user.id);
    if (!profile || profile.status !== 'ACTIVE') {
      return res.status(403).json({ success: false, message: 'Platform staff access required' });
    }

    req.platformStaff = profile;
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { requirePlatformPermission, requirePlatformStaff };
