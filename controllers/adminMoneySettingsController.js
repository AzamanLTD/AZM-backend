// controllers/adminMoneySettingsController.js
// =============================================================================
// /api/admin/money-settings
//
// Isolated on purpose from adminSettingsController (/api/admin/settings). The
// legacy surface coerces values with Number(...) and mutates the GlobalSettings
// singleton in place; this one validates exactly, stores exact strings, and
// appends revisions. Two different guarantees, so two different code paths —
// sharing one would reintroduce the float path the exact settings cannot have.
//
// Every refusal is a typed code the caller can branch on. The Admin Portal UI
// shows the backend's code, so it must never have to parse prose.
// =============================================================================

const logger = require('../src/config/logger');
const contract = require('../src/lib/moneySettingsContract');
const moneySettingsService = require('../services/moneySettingsService');

function prismaOf(req) {
    const prisma = req.app.get('prisma');
    if (!prisma) {
        // Never invent a client: an admin write without a database is a 503, not
        // a silent success.
        const err = new Error('Database client unavailable');
        err.status = 503;
        err.code = 'MONEY_SETTING_STORE_UNAVAILABLE';
        throw err;
    }
    return prisma;
}

function actorOf(req) {
    const user = req.user || {};
    return {
        adminId: Number(user.id),
        adminName: user.username || user.fullName || user.name || null,
        ipAddress: req.ip || null,
    };
}

function sendError(res, err) {
    if (err instanceof moneySettingsService.MoneySettingsError) {
        return res.status(err.status).json({
            success: false,
            code: err.code,
            message: err.message,
            detail: err.detail || null,
        });
    }
    const status = err && err.status ? err.status : 500;
    const code = (err && err.code) || 'MONEY_SETTING_INTERNAL_ERROR';
    logger.error({ err }, '[adminMoneySettings] unhandled failure');
    return res.status(status).json({
        success: false,
        code,
        // A 500 must not leak internals; it also must not claim a validation
        // problem, which would send the operator chasing their input.
        message: status === 500 ? 'Money settings could not be updated.' : err.message,
        detail: null,
    });
}

/** GET /api/admin/money-settings */
exports.getSettings = async (req, res) => {
    try {
        const snapshot = await moneySettingsService.getSnapshot(prismaOf(req));
        return res.json({ success: true, data: snapshot, ...snapshot });
    } catch (err) {
        return sendError(res, err);
    }
};

/** GET /api/admin/money-settings/:key/history */
exports.getHistory = async (req, res) => {
    try {
        const prisma = prismaOf(req);
        const key = contract.canonicalKey(req.params.key);
        if (!key) {
            return res.status(400).json({
                success: false,
                code: contract.CODES.UNKNOWN_KEY,
                message: `Unknown money setting: ${req.params.key}`,
                detail: null,
            });
        }
        const limit = req.query.limit;
        const history = await moneySettingsService.getHistory(prisma, key, { limit });
        return res.json({ success: true, key, history, data: { key, history } });
    } catch (err) {
        return sendError(res, err);
    }
};

/**
 * PUT /api/admin/money-settings/:key
 * Body: { value, note } | { value, reason, effectiveFrom|effectiveAt }
 */
exports.updateSetting = async (req, res) => {
    try {
        const prisma = prismaOf(req);
        const body = req.body && typeof req.body === 'object' ? req.body : {};

        const result = await moneySettingsService.writeSetting(prisma, {
            key: req.params.key,
            value: body.value,
            reason: body.reason,
            note: body.note,
            effectiveAt: body.effectiveAt,
            effectiveFrom: body.effectiveFrom,
            ...actorOf(req),
        });

        return res.json({
            success: true,
            data: result,
            // Flattened for callers that read the previous shape directly.
            key: result.revision.key,
            value: result.current.value,
            scheduled: result.scheduled,
        });
    } catch (err) {
        return sendError(res, err);
    }
};
