// controllers/susu/adminWarRoomController.js
// =============================================================================
// HTTP boundary for the Admin War Room alert feed.
// =============================================================================

const { SusuError } = require('../../services/susu/errors');

function ok(res, data, status = 200) { return res.status(status).json({ success: true, data }); }
function fail(res, err) {
  if (err instanceof SusuError) {
    const body = { success: false, message: err.message, errorCode: err.code };
    if (err.fields) body.fields = err.fields;
    return res.status(err.httpStatus || 400).json(body);
  }
  console.error('[adminWarRoomController]', err);
  return res.status(500).json({ success: false, message: 'Internal server error', errorCode: 'INTERNAL' });
}
const wrap = (h) => async (req, res) => { try { await h(req, res); } catch (e) { fail(res, e); } };

exports.listAlerts = wrap(async (req, res) => {
  const svc = req.app.get('adminWarRoomService');
  let acknowledged;
  if (req.query.acknowledged === 'false') acknowledged = false;
  else if (req.query.acknowledged === 'true') acknowledged = true;
  const alerts = await svc.getAlerts({
    acknowledged,
    take: parseInt(req.query.take || '50', 10),
    cursor: req.query.cursor || undefined,
  });
  ok(res, { alerts });
});

exports.acknowledgeAlert = wrap(async (req, res) => {
  const svc = req.app.get('adminWarRoomService');
  const alert = await svc.acknowledge(req.user.id, req.params.id);
  ok(res, { alert });
});
