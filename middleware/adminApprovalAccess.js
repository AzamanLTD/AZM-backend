const { checkAdminPermission } = require('../controllers/adminRbacController');

const ACTION_PERMISSIONS = Object.freeze({
    WITHDRAWAL: 'withdrawals.approve',
    SUSU_PAYOUT: 'susu.approve_payout',
    USER_BAN: 'users.ban',
    FEE_OVERRIDE: 'fees.manage',
    MANUAL_BALANCE_ADJUST: 'fees.manage',
});

function requireActionPermission(getType) {
    return async (req, res, next) => {
        try {
            const type = String(getType(req) || '').toUpperCase();
            if (type === 'VENDOR_TIER_CHANGE') {
                if (String(req.user?.role || '').toUpperCase() !== 'SUPER_ADMIN' && String(req.user?.role || '').toUpperCase() !== 'ADMIN') {
                    return res.status(403).json({ success: false, message: 'Super Admin permission required for vendor tier approvals.' });
                }
                return next();
            }

            const permission = ACTION_PERMISSIONS[type];
            if (!permission || !checkAdminPermission(req.user, permission)) {
                return res.status(403).json({
                    success: false,
                    message: permission
                        ? `Admin permission required: ${permission}`
                        : 'Unsupported or unauthorized approval action type.',
                    yourRole: req.user?.role,
                });
            }
            return next();
        } catch (err) {
            return next(err);
        }
    };
}

const requireApprovalCreatePermission = requireActionPermission((req) => req.body?.type);
const requireApprovalMutationPermission = requireActionPermission((req) => req.adminApprovalRequest?.type);

async function loadApprovalRequest(req, res, next) {
    try {
        const prisma = req.app.get('prisma');
        const requestId = parseInt(req.params.id, 10);
        if (!Number.isInteger(requestId) || requestId <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid approval request id.' });
        }
        const request = await prisma.adminApprovalRequest.findUnique({
            where: { id: requestId },
            select: { id: true, type: true },
        });
        if (!request) return res.status(404).json({ success: false, message: 'Request not found.' });
        req.adminApprovalRequest = request;
        return next();
    } catch (err) {
        return next(err);
    }
}

module.exports = {
    requireApprovalCreatePermission,
    loadApprovalRequest,
    requireApprovalMutationPermission,
};
