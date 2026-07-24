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
const logger = require('../src/config/logger');
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
        logger.error({ err: error }, '[getBusinesses] error');
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
        logger.error({ err: error }, '[suspendBusiness] error');
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
        logger.error({ err: error }, '[unsuspendBusiness] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// DELETE /api/admin/businesses/:bizId
//
// Hard-deletes a BusinessProfile by its BIZ-XXXXXXXXX public identifier.
// This cascades to all child records via Prisma's onDelete: Cascade relations
// (products, orders, locations, invoices, reviews, ad posts, etc.).
//
// Guards:
//   - 404 if bizId not found
//   - 409 if the business has any PENDING / IN_PROGRESS / ESCROW / DISPUTED
//     escrow tickets — admin must resolve those before deleting to avoid
//     orphaning funds.
// =============================================================================
exports.deleteBusiness = async (req, res) => {
    const prisma = req.app.get('prisma');
    const io = req.app.get('socketio');
    try {
        const { bizId } = req.params;

        const biz = await prisma.businessProfile.findUnique({
            where: { bizId },
            select: { id: true, userId: true, businessName: true },
        });
        if (!biz) return res.status(404).json({ success: false, message: 'Business not found.' });

        // Guard: open tickets with active funds. TicketStatus enum only has
        // OPEN / CLOSED / CANCELLED — so we block on OPEN only.
        const openTickets = await prisma.ticket.count({
            where: {
                businessProfileId: biz.id,
                status: 'OPEN',
            },
        });
        if (openTickets > 0) {
            return res.status(409).json({
                success: false,
                message: `Cannot delete: ${openTickets} active ticket(s) still open on this business. Resolve them first.`,
            });
        }

        // Hard delete — all cascade relations handle child records automatically
        await prisma.businessProfile.delete({ where: { id: biz.id } });

        if (io) io.to(`user_${biz.userId}`).emit('business_deleted', { bizId });

        return res.status(200).json({
            success: true,
            message: `Business "${biz.businessName}" (${bizId}) permanently deleted.`,
        });
    } catch (error) {
        logger.error({ err: error }, '[deleteBusiness] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};

// =============================================================================
// DELETE /api/admin/ad-posts/:id
//
// Admin-level hard delete of a BusinessAdPost by UUID. Bypasses the
// normal ownership check (which requires the caller to have a business profile).
//
// Guards:
//   - 404 if not found
// =============================================================================
exports.deleteAdPost = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { id } = req.params;

        const post = await prisma.businessAdPost.findUnique({
            where: { id },
            select: { id: true, title: true, businessProfileId: true },
        });
        if (!post) return res.status(404).json({ success: false, message: 'Ad post not found.' });

        await prisma.businessAdPost.delete({ where: { id } });

        return res.status(200).json({
            success: true,
            message: `Ad post "${post.title}" deleted.`,
        });
    } catch (error) {
        logger.error({ err: error }, '[deleteAdPost] error');
        return res.status(500).json({ success: false, message: error.message });
    }
};
