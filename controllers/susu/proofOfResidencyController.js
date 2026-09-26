// controllers/susu/proofOfResidencyController.js
// =============================================================================
// HTTP boundary for Proof of Residency endpoints.
// =============================================================================

const logger = require('../../src/config/logger');
const { SusuError } = require('../../services/susu/errors');

function ok(res, data, status = 200) { return res.status(status).json({ success: true, data }); }
function fail(res, err) {
  if (err instanceof SusuError) {
    const body = { success: false, message: err.message, errorCode: err.code };
    if (err.fields) body.fields = err.fields;
    return res.status(err.httpStatus || 400).json(body);
  }
  logger.error('[proofOfResidencyController]', err);
  return res.status(500).json({ success: false, message: 'Internal server error', errorCode: 'INTERNAL' });
}
const wrap = (h) => async (req, res) => { try { await h(req, res); } catch (e) { fail(res, e); } };

exports.uploadOwnPoR = wrap(async (req, res) => {
  const svc = req.app.get('proofOfResidencyService');
  const updated = await svc.submitUpload(req.user.id, req.file);
  ok(res, {
    proofOfResidencyStatus: updated.proofOfResidencyStatus,
    proofOfResidencySubmittedAt: updated.proofOfResidencySubmittedAt,
  }, 201);
});

exports.getOwnStatus = wrap(async (req, res) => {
  const svc = req.app.get('proofOfResidencyService');
  const status = await svc.getOwnStatus(req.user.id);
  // Strip proofOfResidencyUrl per Property 16
  delete status.proofOfResidencyUrl;
  ok(res, status);
});

exports.getReviewQueue = wrap(async (req, res) => {
  const svc = req.app.get('proofOfResidencyService');
  const queue = await svc.listReviewQueue({
    take: parseInt(req.query.take || '50', 10),
    cursor: req.query.cursor || undefined,
  });
  ok(res, { queue });
});

exports.reviewSubmission = wrap(async (req, res) => {
  const svc = req.app.get('proofOfResidencyService');
  const updated = await svc.reviewSubmission({
    adminUserId: req.user.id,
    targetUserId: parseInt(req.params.userId, 10),
    decision: req.body?.decision,
    reason: req.body?.reason,
  });
  ok(res, { proofOfResidencyStatus: updated.proofOfResidencyStatus });
});
