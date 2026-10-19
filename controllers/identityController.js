// controllers/identityController.js
// =============================================================================
// HTTP boundary for Phase 6 identity + discovery endpoints (mounted under
// /api/users). All routes require `protect`. Responses use the canonical
// envelope; IdentityError instances map to their httpStatus + code.
// =============================================================================

const logger = require('../src/config/logger');
const { IdentityService, IdentityError } = require('../services/identity/identity.service');

function ok(res, data, status = 200) { return res.status(status).json({ success: true, data }); }
function fail(res, err) {
  if (err instanceof IdentityError) {
    return res.status(err.httpStatus || 400).json({
      success: false, message: err.message, errorCode: err.code,
    });
  }
  logger.error('[identityController]', err);
  return res.status(500).json({ success: false, message: 'Internal server error', errorCode: 'INTERNAL' });
}
const wrap = (h) => async (req, res) => { try { await h(req, res); } catch (e) { fail(res, e); } };

// GET /api/users/lookup/:azamanId — minimal public profile by Azaman ID.
exports.lookup = wrap(async (req, res) => {
  const svc = new IdentityService(req.app.get('prisma'));
  const profile = await svc.lookupByAzamanId(req.user.id, req.params.azamanId);
  ok(res, { user: profile });
});

// POST /api/users/discover — { phones: string[] } → matched public profiles.
exports.discover = wrap(async (req, res) => {
  const svc = new IdentityService(req.app.get('prisma'));
  const phones = Array.isArray(req.body?.phones) ? req.body.phones : [];
  const matches = await svc.discoverByPhones(req.user.id, phones);
  ok(res, { matches });
});

// PUT /api/users/discoverable — { enabled: boolean }.
exports.setDiscoverable = wrap(async (req, res) => {
  const svc = new IdentityService(req.app.get('prisma'));
  const result = await svc.setDiscoverable(req.user.id, req.body?.enabled === true);
  ok(res, result);
});
