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
            return 503;
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
        const beneficiary = await service.createBeneficiary(prisma, req.user.id, req.body);
        return res.status(201).json({ success: true, beneficiary });
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
