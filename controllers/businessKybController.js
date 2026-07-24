// controllers/businessKybController.js
// =============================================================================
// AZAMAN — BUSINESS KYB CONTROLLER (2026-06-16)
//
// HTTP layer for Know-Your-Business document submission and admin review.
// Mirrors vendorApplicationController.js. KYB document URLs are PRE-UPLOADED
// Cloudinary URLs sent from the frontend — this controller does NOT handle
// file uploads directly.
//
//   prisma = req.app.get('prisma'); userId = req.user.id;
//   success → { success: true, ... }; error → { success: false, message }.
// =============================================================================

const logger = require('../src/config/logger');
const bizNotificationService = require('../services/bizNotificationService');

const VALID_KYB_DOC_TYPES = new Set([
    'BUSINESS_REGISTRATION_CERT',
    'DIRECTOR_ID_FRONT',
    'DIRECTOR_ID_BACK',
    'TAX_IDENTIFICATION',
    'PROOF_OF_ADDRESS',
    'SELFIE_WITH_ID',
    'OTHER'
]);

// ── helpers ───────────────────────────────────────────────────────────────────

/** Load the BusinessProfile owned by the calling user (null if none). */
async function _ownedProfile(prisma, userId) {
    return prisma.businessProfile.findUnique({
        where: { userId },
        select: { id: true, businessName: true, kybStatus: true }
    });
}

// =============================================================================
// 1. POST /api/business/kyb/submit — submit/replace KYB documents (owner only).
// =============================================================================
exports.submitKybDocuments = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const profile = await _ownedProfile(prisma, userId);
        if (!profile) {
            return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        }
        if (profile.kybStatus === 'VERIFIED') {
            return res.status(400).json({ success: false, message: 'KYB already approved.' });
        }

        const { documents } = req.body;
        if (!Array.isArray(documents) || documents.length === 0) {
            return res.status(400).json({ success: false, message: 'documents must be a non-empty array.' });
        }
        if (documents.length > 10) {
            return res.status(400).json({ success: false, message: 'A maximum of 10 documents may be submitted at once.' });
        }
        for (const doc of documents) {
            if (!doc || !VALID_KYB_DOC_TYPES.has(doc.documentType)) {
                return res.status(400).json({
                    success: false,
                    message: `Each document needs a valid documentType. Valid: ${[...VALID_KYB_DOC_TYPES].join(', ')}`
                });
            }
            if (!doc.documentUrl || typeof doc.documentUrl !== 'string' || doc.documentUrl.trim().length === 0) {
                return res.status(400).json({ success: false, message: 'Each document needs a non-empty documentUrl.' });
            }
        }

        const savedDocs = [];
        const skipped = [];
        for (const doc of documents) {
            // Skip documents already approved — don't overwrite a verified doc.
            const existing = await prisma.businessVerificationDocument.findUnique({
                where: {
                    businessProfileId_documentType: {
                        businessProfileId: profile.id,
                        documentType: doc.documentType
                    }
                },
                select: { id: true, status: true }
            });
            if (existing && existing.status === 'APPROVED') {
                skipped.push(doc.documentType);
                continue;
            }

            const saved = await prisma.businessVerificationDocument.upsert({
                where: {
                    businessProfileId_documentType: {
                        businessProfileId: profile.id,
                        documentType: doc.documentType
                    }
                },
                create: {
                    businessProfileId: profile.id,
                    documentType: doc.documentType,
                    documentUrl: doc.documentUrl.trim(),
                    status: 'PENDING'
                },
                update: {
                    documentUrl: doc.documentUrl.trim(),
                    status: 'PENDING',
                    reviewedById: null,
                    reviewNotes: null,
                    reviewedAt: null
                }
            });
            savedDocs.push(saved);
        }

        // Bump profile to PENDING if it was UNVERIFIED or REJECTED.
        let kybStatus = profile.kybStatus;
        if (profile.kybStatus === 'UNVERIFIED' || profile.kybStatus === 'REJECTED') {
            const updated = await prisma.businessProfile.update({
                where: { id: profile.id },
                data: { kybStatus: 'PENDING' },
                select: { kybStatus: true }
            });
            kybStatus = updated.kybStatus;
        }

        return res.status(201).json({ success: true, documents: savedDocs, skipped, kybStatus });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 2. GET /api/business/kyb/status — caller's KYB status + documents (owner only).
// =============================================================================
exports.getKybStatus = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const profile = await _ownedProfile(prisma, userId);
        if (!profile) {
            return res.status(403).json({ success: false, message: 'You do not own a business profile.' });
        }

        const documents = await prisma.businessVerificationDocument.findMany({
            where: { businessProfileId: profile.id },
            orderBy: { createdAt: 'desc' }
        });

        return res.status(200).json({ success: true, kybStatus: profile.kybStatus, documents });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 3. GET /api/admin/business-kyb — admin KYB review queue (FIFO, oldest first).
// =============================================================================
exports.getKybQueue = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const status = req.query.status || 'PENDING';
        const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
        const cursor = req.query.cursor;

        const rows = await prisma.businessProfile.findMany({
            where: { kybStatus: status },
            take: take + 1,
            orderBy: { updatedAt: 'asc' },
            include: {
                verificationDocuments: true,
                user: { select: { id: true, username: true, email: true } }
            },
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });

        const hasMore = rows.length > take;
        const businesses = hasMore ? rows.slice(0, take) : rows;
        const nextCursor = hasMore ? businesses[businesses.length - 1].id : null;

        return res.status(200).json({ success: true, businesses, hasMore, nextCursor });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 4. POST /api/admin/business-kyb/:documentId/review — review one document.
// =============================================================================
exports.reviewKybDocument = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { documentId } = req.params;
        const { status, reviewNotes } = req.body;

        if (status !== 'APPROVED' && status !== 'REJECTED') {
            return res.status(400).json({ success: false, message: 'status must be APPROVED or REJECTED.' });
        }

        const existing = await prisma.businessVerificationDocument.findUnique({
            where: { id: documentId },
            select: { id: true }
        });
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Document not found.' });
        }

        const document = await prisma.businessVerificationDocument.update({
            where: { id: documentId },
            data: {
                status,
                reviewedById: req.user.id,
                reviewNotes: reviewNotes ? String(reviewNotes).slice(0, 500) : null,
                reviewedAt: new Date()
            }
        });

        return res.status(200).json({ success: true, document });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 5. POST /api/admin/business-kyb/:bizId/approve — approve the whole business.
// =============================================================================
exports.approveBusinessKyb = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { bizId } = req.params;

        const profile = await prisma.businessProfile.findUnique({
            where: { bizId },
            include: { verificationDocuments: true }
        });
        if (!profile) {
            return res.status(404).json({ success: false, message: 'Business not found.' });
        }

        const unresolved = profile.verificationDocuments.filter(
            (d) => d.status === 'PENDING' || d.status === 'REJECTED'
        );
        if (unresolved.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'All documents must be APPROVED before the business can be verified.',
                unresolved: unresolved.map((d) => ({ documentType: d.documentType, status: d.status }))
            });
        }

        const updated = await prisma.businessProfile.update({
            where: { id: profile.id },
            data: { kybStatus: 'VERIFIED', isVerified: true, verifiedAt: new Date() }
        });

        const notificationService = req.app.get('notificationService');
        if (notificationService) {
            setImmediate(() => {
                notificationService.sendNotification({
                    userId: profile.userId,
                    title: 'Business Verified!',
                    body: 'Your KYB documents have been approved. Your business is now publicly visible and can receive orders.',
                    category: 'GENERAL',
                    actionPayload: { action: 'BUSINESS_KYB_RESULT', decision: 'APPROVED' }
                }).catch((e) => logger.error({ err: e }, '[approveBusinessKyb] notification'));
            });
        }

        // Persistent owner-facing feed entry.
        setImmediate(() => {
            bizNotificationService.createNotification(prisma, {
                businessProfileId: profile.id,
                type: 'KYB_STATUS_CHANGED',
                title: 'Business Verified',
                body: 'Your KYB documents were approved — your business is now verified and publicly visible.',
                metadata: { decision: 'APPROVED', kybStatus: 'VERIFIED' }
            });
        });
        const io = req.app.get('socketio');
        if (io) io.to(`user_${profile.userId}`).emit('biz_notification', { type: 'KYB_STATUS_CHANGED' });

        return res.status(200).json({ success: true, business: updated });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};

// =============================================================================
// 6. POST /api/admin/business-kyb/:bizId/reject — reject the business.
// =============================================================================
exports.rejectBusinessKyb = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { bizId } = req.params;
        const { reason } = req.body;

        if (!reason || String(reason).trim().length === 0) {
            return res.status(400).json({ success: false, message: 'reason is required.' });
        }

        const profile = await prisma.businessProfile.findUnique({
            where: { bizId },
            select: { id: true, userId: true }
        });
        if (!profile) {
            return res.status(404).json({ success: false, message: 'Business not found.' });
        }

        await prisma.$transaction([
            prisma.businessProfile.update({
                where: { id: profile.id },
                data: { kybStatus: 'REJECTED' }
            }),
            prisma.businessVerificationDocument.updateMany({
                where: { businessProfileId: profile.id, status: 'PENDING' },
                data: { status: 'REJECTED' }
            })
        ]);

        const notificationService = req.app.get('notificationService');
        if (notificationService) {
            setImmediate(() => {
                notificationService.sendNotification({
                    userId: profile.userId,
                    title: 'KYB Documents Rejected',
                    body: String(reason).slice(0, 100),
                    category: 'GENERAL',
                    actionPayload: { action: 'BUSINESS_KYB_RESULT', decision: 'REJECTED' }
                }).catch((e) => logger.error({ err: e }, '[rejectBusinessKyb] notification'));
            });
        }

        // Persistent owner-facing feed entry.
        setImmediate(() => {
            bizNotificationService.createNotification(prisma, {
                businessProfileId: profile.id,
                type: 'KYB_STATUS_CHANGED',
                title: 'KYB Documents Rejected',
                body: String(reason).slice(0, 480),
                metadata: { decision: 'REJECTED', kybStatus: 'REJECTED' }
            });
        });
        const io = req.app.get('socketio');
        if (io) io.to(`user_${profile.userId}`).emit('biz_notification', { type: 'KYB_STATUS_CHANGED' });

        return res.status(200).json({ success: true });
    } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
    }
};
