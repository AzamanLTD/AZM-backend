// controllers/susu/adminSusuMonitorController.js
// =============================================================================
// HTTP boundary for the Admin Portal Susu monitoring surface (Workstream E).
// All routes are adminOnly (mounted under /api/admin/susu).
// =============================================================================

const { SusuError } = require('../../services/susu/errors');

function ok(res, data, status = 200) { return res.status(status).json({ success: true, data }); }
function fail(res, err) {
  if (err instanceof SusuError) {
    const body = { success: false, message: err.message, errorCode: err.code };
    if (err.fields) body.fields = err.fields;
    return res.status(err.httpStatus || 400).json(body);
  }
  console.error('[adminSusuMonitorController]', err);
  return res.status(500).json({ success: false, message: 'Internal server error', errorCode: 'INTERNAL' });
}
const wrap = (h) => async (req, res) => { try { await h(req, res); } catch (e) { fail(res, e); } };

exports.listSusus = wrap(async (req, res) => {
  const svc = req.app.get('adminSusuMonitorService');
  const susus = await svc.listSusus({
    status: req.query.status || undefined,
    take: parseInt(req.query.take || '50', 10),
    cursor: req.query.cursor || undefined,
  });
  ok(res, { susus });
});

exports.getSusuDetail = wrap(async (req, res) => {
  const svc = req.app.get('adminSusuMonitorService');
  const susu = await svc.getSusuDetail(req.params.id);
  ok(res, { susu });
});

exports.getMemberDetail = wrap(async (req, res) => {
  const svc = req.app.get('adminSusuMonitorService');
  const detail = await svc.getMemberDetail(req.params.userId);
  ok(res, detail);
});

exports.resolveSusu = wrap(async (req, res) => {
  const svc = req.app.get('adminSusuMonitorService');
  const result = await svc.resolveFrozenSusu({
    adminUserId: req.user.id,
    susuGroupId: req.params.id,
    action: req.body?.action,
    notes: req.body?.notes,
    alertId: req.body?.alertId,
  });
  ok(res, result);
});
