// controllers/appUnlockController.js
// =============================================================================
// MEMBER APP UNLOCK — HTTP surface.
//
// Every handler resolves the account from `req.user.id` (set by `protect`).
// No handler accepts a client-supplied user id, phone number or account
// reference: an unlock challenge belongs to the authenticated member only.
//
// These endpoints grant a VERDICT, never a session. Nothing here issues a token,
// sets a cookie or refreshes a login.
// =============================================================================

const logger = require('../src/config/logger');
const { AppUnlockService } = require('../services/appUnlockService');

function _service(req) {
    const prisma = req.app.get('prisma');
    const smsService = req.app.get('smsService');
    return { prisma, service: new AppUnlockService({ prisma, smsService }) };
}

function _fail(res, verdict) {
    return res.status(verdict.status || 400).json({
        success: false,
        code: verdict.code,
        ...(verdict.attemptsLeft !== undefined ? { attemptsLeft: verdict.attemptsLeft } : {}),
    });
}

// GET /api/security/app-unlock/capabilities — read-only, no enrolment, no proof.
exports.getAppUnlockCapabilities = async (req, res) => {
    try {
        const { prisma, service } = _service(req);
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!user) {
            return res.status(404).json({ success: false, code: 'USER_NOT_FOUND' });
        }
        const data = await service.capabilities(user);
        return res.status(200).json({ success: true, data });
    } catch (error) {
        logger.error({ err: error }, '[appUnlock] capabilities failed');
        return res.status(503).json({ success: false, code: 'CAPABILITIES_UNAVAILABLE' });
    }
};

// POST /api/security/app-unlock/pin/verify
exports.verifyAppUnlockPin = async (req, res) => {
    try {
        const { prisma, service } = _service(req);
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!user) {
            return res.status(404).json({ success: false, code: 'USER_NOT_FOUND' });
        }
        const verdict = await service.verifyPin(user, req.body && req.body.pin);
        if (!verdict.ok) return _fail(res, verdict);
        return res.status(200).json({ success: true, data: { unlocked: true, method: 'pin' } });
    } catch (error) {
        logger.error({ err: error }, '[appUnlock] pin verify failed');
        return res.status(503).json({ success: false, code: 'UNLOCK_UNAVAILABLE' });
    }
};

// POST /api/security/app-unlock/totp/verify
exports.verifyAppUnlockTotp = async (req, res) => {
    try {
        const { prisma, service } = _service(req);
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!user) {
            return res.status(404).json({ success: false, code: 'USER_NOT_FOUND' });
        }
        const verdict = await service.verifyTotp(user, req.body && req.body.token);
        if (!verdict.ok) return _fail(res, verdict);
        return res.status(200).json({ success: true, data: { unlocked: true, method: 'totp' } });
    } catch (error) {
        logger.error({ err: error }, '[appUnlock] totp verify failed');
        return res.status(503).json({ success: false, code: 'UNLOCK_UNAVAILABLE' });
    }
};

// POST /api/security/app-unlock/sms/send
exports.sendAppUnlockOtp = async (req, res) => {
    try {
        const { prisma, service } = _service(req);
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!user) {
            return res.status(404).json({ success: false, code: 'USER_NOT_FOUND' });
        }
        const issued = await service.sendSmsChallenge(user);
        if (!issued.ok) return _fail(res, issued);
        // The code is never returned here — not even in development. The client
        // is told which number was masked and when the challenge dies.
        return res.status(200).json({ success: true, data: issued.data });
    } catch (error) {
        const code = error && error.code;
        const mapped = ['SMS_PROVIDER_MISCONFIGURED', 'SMS_PROVIDER_UNSUPPORTED', 'OTP_STORE_UNAVAILABLE',
            'OTP_HASH_SECRET_MISSING', 'SMS_SEND_FAILED', 'OTP_RESEND_TOO_SOON'].includes(code)
            ? code : 'UNLOCK_CHALLENGE_FAILED';
        logger.error({ code }, '[appUnlock] sms send refused');
        const status = code === 'OTP_RESEND_TOO_SOON' ? 429 : 503;
        return res.status(status).json({ success: false, code: mapped });
    }
};

// POST /api/security/app-unlock/sms/verify
exports.verifyAppUnlockOtp = async (req, res) => {
    try {
        const { prisma, service } = _service(req);
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!user) {
            return res.status(404).json({ success: false, code: 'USER_NOT_FOUND' });
        }
        const verdict = await service.verifySmsChallenge(user, req.body || {});
        if (!verdict.ok) return _fail(res, verdict);
        return res.status(200).json({ success: true, data: { unlocked: true, method: 'sms' } });
    } catch (error) {
        logger.error({ err: error }, '[appUnlock] sms verify failed');
        return res.status(503).json({ success: false, code: 'UNLOCK_UNAVAILABLE' });
    }
};

// DELETE /api/security/pin — real removal, with fresh proof.
exports.removePin = async (req, res) => {
    try {
        const { prisma, service } = _service(req);
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!user) {
            return res.status(404).json({ success: false, code: 'USER_NOT_FOUND' });
        }
        const verdict = await service.removePin(user, req.body || {});
        if (!verdict.ok) return _fail(res, verdict);
        return res.status(200).json({ success: true, data: { pinConfigured: false } });
    } catch (error) {
        logger.error({ err: error }, '[appUnlock] pin removal failed');
        return res.status(503).json({ success: false, code: 'PIN_REMOVAL_UNAVAILABLE' });
    }
};
