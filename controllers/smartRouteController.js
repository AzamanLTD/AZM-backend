// controllers/smartRouteController.js
// =============================================================================
// AZAMAN — SMART ROUTE CONTROLLER  (Master Sprint, 2026-05-27)
// =============================================================================
const logger = require('../src/config/logger');

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
        logger.error(`[smartRouteController] ${fn.name || 'h'}:`, err.message);
        res.status(400).json({ success: false, message: err.message });
    }
};

exports.create = wrap(async function create(req, res) {
    const svc = req.app.get('smartRouteService');
    const route = await svc.create({ userId: req.user.id, ...req.body });
    res.status(201).json({ success: true, route });
});

exports.list = wrap(async function list(req, res) {
    const svc = req.app.get('smartRouteService');
    const routes = await svc.list(req.user.id);
    res.json({ success: true, routes });
});

exports.getDetail = wrap(async function getDetail(req, res) {
    const svc = req.app.get('smartRouteService');
    const route = await svc.getDetail(req.user.id, req.params.id);
    if (!route) return res.status(404).json({ success: false, message: 'Route not found' });
    res.json({ success: true, route });
});

exports.update = wrap(async function update(req, res) {
    const svc = req.app.get('smartRouteService');
    const route = await svc.update(req.user.id, req.params.id, req.body);
    res.json({ success: true, route });
});

exports.pause = wrap(async function pause(req, res) {
    const svc = req.app.get('smartRouteService');
    const route = await svc.setStatus(req.user.id, req.params.id, 'PAUSED');
    res.json({ success: true, route });
});

exports.resume = wrap(async function resume(req, res) {
    const svc = req.app.get('smartRouteService');
    const route = await svc.setStatus(req.user.id, req.params.id, 'ACTIVE');
    res.json({ success: true, route });
});

exports.cancel = wrap(async function cancel(req, res) {
    const svc = req.app.get('smartRouteService');
    const route = await svc.setStatus(req.user.id, req.params.id, 'CANCELLED');
    res.json({ success: true, route });
});

exports.runNow = wrap(async function runNow(req, res) {
    const svc = req.app.get('smartRouteService');
    const prisma = req.app.get('prisma');
    const route = await prisma.smartRoute.findUnique({ where: { id: req.params.id } });
    if (!route || route.userId !== req.user.id) {
        return res.status(404).json({ success: false, message: 'Route not found' });
    }
    const run = await svc.runOnce(route.id, { manual: true });
    res.json({ success: true, run });
});
