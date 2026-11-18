// controllers/billsSavedAccountController.js
// =============================================================================
// Saved service accounts. Read/write of member-owned references only —
// there is no endpoint here that can pay, quote or look up a bill.
// =============================================================================

const { wrap } = require('../utils/catchAsync');
const logger = require('../src/config/logger');
const { publicTemplates } = require('../services/bills/serviceRegistry');
const { createService } = require('../services/bills/savedServiceAccountService');

function serviceFor(req) {
    return createService({ prisma: req.app.get('prisma') });
}

/** Errors are mapped by code; the message is already safe to show. */
function fail(res, err) {
    const status = err && err.status;
    if (status && status >= 400 && status < 500) {
        return res.status(status).json({ success: false, code: err.code || 'REQUEST_REJECTED', message: err.message });
    }
    if (err && (err.code === 'SAVED_SERVICE_KEY_MISSING' || err.code === 'SAVED_SERVICE_KEY_INVALID')) {
        logger.error({ code: err.code }, '[bills] saved-service cryptography unavailable');
        return res.status(503).json({
            success: false,
            code: 'SAVED_ACCOUNT_STORAGE_UNAVAILABLE',
            message: 'Saved accounts are temporarily unavailable.',
        });
    }
    logger.error({ err }, '[bills] saved service account failure');
    return res.status(500).json({ success: false, code: 'SAVED_ACCOUNT_FAILED', message: 'Request failed.' });
}

exports.getServiceTemplates = wrap(async function getServiceTemplates(req, res) {
    res.status(200).json({ success: true, data: publicTemplates() });
});

exports.listSavedAccounts = wrap(async function listSavedAccounts(req, res) {
    try {
        const accounts = await serviceFor(req).listAccounts(req.user.id);
        res.status(200).json({ success: true, data: { accounts } });
    } catch (err) {
        fail(res, err);
    }
});

exports.createSavedAccount = wrap(async function createSavedAccount(req, res) {
    try {
        const body = req.body || {};
        const account = await serviceFor(req).createAccount({
            userId: req.user.id,
            serviceCode: body.serviceCode,
            providerCode: body.providerCode,
            nickname: body.nickname,
            accountFields: body.accountFields,
        });
        logger.info(
            { userId: req.user.id, serviceCode: account.serviceCode, accountId: account.id },
            '[bills] saved service account created'
        );
        res.status(201).json({ success: true, data: { account } });
    } catch (err) {
        fail(res, err);
    }
});

exports.updateSavedAccount = wrap(async function updateSavedAccount(req, res) {
    try {
        const body = req.body || {};
        const account = await serviceFor(req).updateAccount({
            userId: req.user.id,
            id: req.params.id,
            nickname: body.nickname,
            isPrimary: body.isPrimary,
        });
        res.status(200).json({ success: true, data: { account } });
    } catch (err) {
        fail(res, err);
    }
});

exports.deleteSavedAccount = wrap(async function deleteSavedAccount(req, res) {
    try {
        const result = await serviceFor(req).deleteAccount({ userId: req.user.id, id: req.params.id });
        res.status(200).json({ success: true, data: result });
    } catch (err) {
        fail(res, err);
    }
});
