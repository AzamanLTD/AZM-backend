// controllers/securityLogController.js
// =============================================================================
// AZAMAN V2 — SECURITY LOG CONTROLLER
// =============================================================================

// =============================================================================
// GET SECURITY LOGS
// =============================================================================
exports.getSecurityLogs = async (req, res) => {
    const prisma = req.app.get('prisma');

    try {
        const userId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        const [logs, total] = await Promise.all([
            prisma.notification.findMany({
                where: {
                    userId,
                    category: 'SECURITY_ACCOUNT',
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma.notification.count({
                where: {
                    userId,
                    category: 'SECURITY_ACCOUNT',
                },
            }),
        ]);

        res.status(200).json({
            success: true,
            logs,
            total,
            page,
            limit,
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};
