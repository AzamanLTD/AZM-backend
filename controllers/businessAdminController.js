// controllers/businessAdminController.js
// =============================================================================
// WS4 — ADMIN BUSINESS MANAGEMENT
//
// Admin Portal endpoints to list and moderate BusinessProfiles. Mounted under
// /api/admin (routes/adminRoutes.js), which already enforces protect + adminOnly
// globally — so these handlers do not re-check the role.
//
//   GET  /api/admin/businesses                     paginated list (+ filters)
//   POST /api/admin/businesses/:bizId/suspend      body: { reason }
//   POST /api/admin/businesses/:bizId/unsuspend
//
// :bizId is the public BIZ-XXXXXXXXX identifier (BusinessProfile.bizId), not the
// internal uuid.
// =============================================================================

// GET /api/admin/businesses?page=&limit=&kybStatus=&suspended=&q=
exports.getBusinesses = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const skip = (page - 1) * limit;

        const where = {};
        if (req.query.kybStatus) {
            const VALID = ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'];
            const upper = String(req.query.kybStatus).toUpperCase();
            if (!VALID.includes(upper)) {
                return res.status(400).json({ success: false, message: `kybStatus must be one of: ${VALID.join(', ')}` });
            }
            where.kybStatus = upper;
        }
        if (req.query.suspended != null) {
            where.isSuspended = String(req.query.suspended) === 'true';
        }
        if (req.query.q) {
            where.OR = [
                { businessName: { contains: String(req.query.q), mode: 'insensitive' } },
                { bizId: { contains: String(req.query.q), mode: 'insensitive' } },
            ];
        }

        const [rows, total] = await Promise.all([
            prisma.businessProfile.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
                select: {
                    id: true,
                    bizId: true,
                    businessName: true,
                    kybStatus: true,
                    isVerified: true,
                    isSuspended: true,
                    suspendReason: true,
                    totalEscrows: true,
                    completedEscrows: true,
                    totalVolume: true,
                    createdAt: true,
                    user: { select: { id: true, username: true, email: true } },
                },
            }),
            prisma.businessProfile.count({ where }),
        ]);

        const businesses = rows.map(({ user, ...b }) => ({ ...b, owner: user }));

        return res.status(200).json({
            success: true,
            businesses,
            total,
            page,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
    } catch (error) {
        console.error('[getBusinesses] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// POST /api/admin/businesses/:bizId/suspend  body: { reason }
exports.suspendBusiness = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    try {
        const { bizId } = req.params;
        const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 500) : null;

        const biz = await prisma.businessProfile.findUnique({ where: { bizId }, select: { id: true, userId: true, isSuspended: true } });
        if (!biz) return res.status(404).json({ success: false, message: 'Business not found.' });
        if (biz.isSuspended) {
            return res.status(409).json({ success: false, message: 'Business is already suspended.' });
        }

        const updated = await prisma.businessProfile.update({
            where: { id: biz.id },
            data: { isSuspended: true, suspendReason: reason },
            select: { id: true, bizId: true, businessName: true, isSuspended: true, suspendReason: true },
        });

        if (io) io.to(`user_${biz.userId}`).emit('business_suspended', { bizId: updated.bizId, reason });
        return res.status(200).json({ success: true, business: updated });
    } catch (error) {
        console.error('[suspendBusiness] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// POST /api/admin/businesses/:bizId/unsuspend
exports.unsuspendBusiness = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    try {
        const { bizId } = req.params;

        const biz = await prisma.businessProfile.findUnique({ where: { bizId }, select: { id: true, userId: true, isSuspended: true } });
        if (!biz) return res.status(404).json({ success: false, message: 'Business not found.' });
        if (!biz.isSuspended) {
            return res.status(409).json({ success: false, message: 'Business is not suspended.' });
        }

        const updated = await prisma.businessProfile.update({
            where: { id: biz.id },
            data: { isSuspended: false, suspendReason: null },
            select: { id: true, bizId: true, businessName: true, isSuspended: true, suspendReason: true },
        });

        if (io) io.to(`user_${biz.userId}`).emit('business_unsuspended', { bizId: updated.bizId });
        return res.status(200).json({ success: true, business: updated });
    } catch (error) {
        console.error('[unsuspendBusiness] error:', error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
};
