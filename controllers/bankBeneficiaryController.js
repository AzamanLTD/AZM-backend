const logger = require('../src/config/logger');
const service = require('../src/services/savedBankBeneficiaryService');

const _status = (code) => {
    switch (code) {
        case 'BENEFICIARY_NOT_FOUND':
            return 404;
        case 'BENEFICIARY_DUPLICATE':
        case 'ACCOUNT_NUMBER_INVALID':
        case 'BANK_CODE_INVALID':
        case 'BANK_NAME_INVALID':
            return 400;
        case 'BENEFICIARY_KEY_UNAVAILABLE':
        case 'VALIDATION_UNAVAILABLE':
            return 503;
        case 'ACCOUNT_NOT_FOUND':
        case 'ACCOUNT_NAME_MISMATCH':
            return 422;
        case 'BANK_CODE_UNKNOWN':
            return 400;
        case 'BENEFICIARY_NOT_VERIFIED':
            return 422;
        case 'BENEFICIARY_LIMIT_REACHED':
            return 409;
        default:
            return 400;
    }
};

const _fail = (res, error, tag) => {
    const known = error instanceof service.BankBeneficiaryError;
    if (!known) logger.error({ err: error, tag }, '[bankBeneficiary] unexpected error');
    return res.status(_status(error.code)).json({
        success: false,
        code: error.code || 'SERVER_ERROR',
        message: known ? error.message : 'Bank beneficiary request failed.',
    });
};

exports.create = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        // The injected bank payout port IS the provider boundary; validation
        // goes through it and nothing else. Unbound => saved as UNVERIFIED,
        // never as verified.
        const port = req.app.get('moolreBankPayoutPort') || null;
        const { verification, ...beneficiary } = await service.createBeneficiary(prisma, req.user.id, req.body, { port });
        return res.status(201).json({ success: true, beneficiary, verification });
    } catch (error) {
        return _fail(res, error, 'create');
    }
};

exports.list = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const beneficiaries = await service.listBeneficiaries(prisma, req.user.id);
        return res.status(200).json({ success: true, beneficiaries });
    } catch (error) {
        return _fail(res, error, 'list');
    }
};

exports.remove = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const result = await service.deleteBeneficiary(prisma, req.user.id, req.params.id);
        return res.status(200).json({ success: true, ...result });
    } catch (error) {
        return _fail(res, error, 'remove');
    }
};
