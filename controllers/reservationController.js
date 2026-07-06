// controllers/reservationController.js
// =============================================================================
// RESERVATION SYSTEM (2026-06-24)
// Customer-facing: create + list + cancel reservations.
// Business-facing: confirm, check-in, check-out, list incoming.
// NEVER moves USDC — escrow integration uses existing escrowService.
// =============================================================================

const crypto = require('crypto');

function genRef() {
    return 'RES-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function _getBiz(prisma, bizId) {
    const biz = await prisma.businessProfile.findUnique({ where: { bizId } });
    if (!biz || biz.isSuspended) throw Object.assign(new Error('Business not found.'), { status: 404 });
    return biz;
}

// ── POST /api/reservations — customer creates reservation ────────────────────
exports.createReservation = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const customerId = req.user.id;
        const {
            bizId, locationId, serviceItemId,
            startDatetime, endDatetime, partySize,
            amountUsdc, depositUsdc,
            cancellationPolicy, customerNotes,
        } = req.body;

        if (!bizId)          return res.status(400).json({ success: false, message: 'bizId is required.' });
        if (!startDatetime)  return res.status(400).json({ success: false, message: 'startDatetime is required.' });
        if (!endDatetime)    return res.status(400).json({ success: false, message: 'endDatetime is required.' });
        if (!amountUsdc || parseFloat(amountUsdc) <= 0)
            return res.status(400).json({ success: false, message: 'amountUsdc must be positive.' });

        const start = new Date(startDatetime);
        const end   = new Date(endDatetime);
        if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start)
            return res.status(400).json({ success: false, message: 'endDatetime must be after startDatetime.' });

        const biz = await _getBiz(prisma, bizId);

        const reservation = await prisma.reservation.create({
            data: {
                reservationRef:    genRef(),
                businessProfileId: biz.id,
                locationId:        locationId   || null,
                customerId,
                serviceItemId:     serviceItemId || null,
                startDatetime:     start,
                endDatetime:       end,
                partySize:         parseInt(partySize, 10) || 1,
                amountUsdc:        parseFloat(amountUsdc),
                depositUsdc:       parseFloat(depositUsdc || 0),
                cancellationPolicy: cancellationPolicy || null,
                customerNotes:     customerNotes || null,
                status:            'PENDING',
            },
        });
        return res.status(201).json({ success: true, reservation });
    } catch (err) {
        const code = err.status || 500;
        return res.status(code).json({ success: false, message: err.message });
    }
};

// ── GET /api/reservations/me — customer's own reservations ──────────────────
exports.listMyReservations = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const customerId = req.user.id;
        const { status, limit, cursor } = req.query;
        const take = Math.min(parseInt(limit, 10) || 20, 50);

        const where = { customerId };
        if (status) where.status = status;

        const rows = await prisma.reservation.findMany({
            where,
            take: take + 1,
            orderBy: { startDatetime: 'desc' },
            include: {
                businessProfile: {
                    select: { bizId: true, businessName: true, logoUrl: true, category: true },
                },
            },
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        const hasMore = rows.length > take;
        return res.status(200).json({
            success: true,
            reservations: hasMore ? rows.slice(0, take) : rows,
            hasMore,
            nextCursor: hasMore ? rows[take - 1].id : null,
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── DELETE /api/reservations/:reservationId — customer cancels ───────────────
exports.cancelReservation = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const customerId = req.user.id;
        const { reservationId } = req.params;

        const res_ = await prisma.reservation.findUnique({ where: { id: reservationId } });
        if (!res_ || res_.customerId !== customerId)
            return res.status(404).json({ success: false, message: 'Reservation not found.' });

        const cancellable = ['PENDING', 'CONFIRMED'];
        if (!cancellable.includes(res_.status))
            return res.status(409).json({ success: false, message: `Cannot cancel a reservation with status ${res_.status}.` });

        const updated = await prisma.reservation.update({
            where: { id: reservationId },
            data:  { status: 'CANCELLED_CUSTOMER', cancelledAt: new Date() },
        });
        return res.status(200).json({ success: true, reservation: updated });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── GET /api/reservations/business/:bizId — business owner sees all incoming ─
exports.listBusinessReservations = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId = req.user.id;
        const { status, limit, cursor } = req.query;
        const take = Math.min(parseInt(limit, 10) || 20, 50);

        const profile = await prisma.businessProfile.findUnique({ where: { userId } });
        if (!profile) return res.status(404).json({ success: false, message: 'Business profile not found.' });

        const where = { businessProfileId: profile.id };
        if (status) where.status = status;

        const rows = await prisma.reservation.findMany({
            where,
            take: take + 1,
            orderBy: { startDatetime: 'asc' },
            include: {
                customer: { select: { id: true, username: true, profilePictureUrl: true, phoneNumber: true } },
            },
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        const hasMore = rows.length > take;
        return res.status(200).json({
            success: true,
            reservations: hasMore ? rows.slice(0, take) : rows,
            hasMore,
            nextCursor: hasMore ? rows[take - 1].id : null,
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── PATCH /api/reservations/:reservationId/confirm — business confirms ───────
exports.confirmReservation = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId  = req.user.id;
        const profile = await prisma.businessProfile.findUnique({ where: { userId } });
        if (!profile) return res.status(404).json({ success: false, message: 'Business profile not found.' });

        const { reservationId } = req.params;
        const existing = await prisma.reservation.findUnique({ where: { id: reservationId } });
        if (!existing || existing.businessProfileId !== profile.id)
            return res.status(404).json({ success: false, message: 'Reservation not found.' });
        if (existing.status !== 'PENDING')
            return res.status(409).json({ success: false, message: `Reservation is already ${existing.status}.` });

        const updated = await prisma.reservation.update({
            where: { id: reservationId },
            data:  { status: 'CONFIRMED', confirmedAt: new Date(), businessNotes: req.body.businessNotes || null },
        });
        return res.status(200).json({ success: true, reservation: updated });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── PATCH /api/reservations/:reservationId/checkin ───────────────────────────
exports.checkInReservation = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId  = req.user.id;
        const profile = await prisma.businessProfile.findUnique({ where: { userId } });
        if (!profile) return res.status(403).json({ success: false, message: 'Business profile required.' });

        const { reservationId } = req.params;
        const existing = await prisma.reservation.findUnique({ where: { id: reservationId } });
        if (!existing || existing.businessProfileId !== profile.id)
            return res.status(404).json({ success: false, message: 'Reservation not found.' });
        if (existing.status !== 'CONFIRMED')
            return res.status(409).json({ success: false, message: 'Can only check-in a CONFIRMED reservation.' });

        const updated = await prisma.reservation.update({
            where: { id: reservationId },
            data:  { status: 'CHECKED_IN', checkedInAt: new Date() },
        });
        return res.status(200).json({ success: true, reservation: updated });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── PATCH /api/reservations/:reservationId/checkout ──────────────────────────

// ── PATCH /api/reservations/:reservationId/no-show ─────────────────────────
exports.markNoShowReservation = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId  = req.user.id;
        const profile = await prisma.businessProfile.findUnique({ where: { userId } });
        if (!profile) return res.status(403).json({ success: false, message: 'Business profile required.' });

        const { reservationId } = req.params;
        const existing = await prisma.reservation.findUnique({ where: { id: reservationId } });
        if (!existing || existing.businessProfileId !== profile.id)
            return res.status(404).json({ success: false, message: 'Reservation not found.' });
        if (!['CONFIRMED', 'CHECKED_IN'].includes(existing.status))
            return res.status(409).json({ success: false, message: 'Can only no-show a CONFIRMED or CHECKED_IN reservation.' });

        const updated = await prisma.reservation.update({
            where: { id: reservationId },
            data:  { status: 'NO_SHOW' },
        });
        return res.status(200).json({ success: true, reservation: updated });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

exports.checkOutReservation = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId  = req.user.id;
        const profile = await prisma.businessProfile.findUnique({ where: { userId } });
        if (!profile) return res.status(403).json({ success: false, message: 'Business profile required.' });

        const { reservationId } = req.params;
        const existing = await prisma.reservation.findUnique({ where: { id: reservationId } });
        if (!existing || existing.businessProfileId !== profile.id)
            return res.status(404).json({ success: false, message: 'Reservation not found.' });
        if (existing.status !== 'CHECKED_IN')
            return res.status(409).json({ success: false, message: 'Can only check-out a CHECKED_IN reservation.' });

        const updated = await prisma.reservation.update({
            where: { id: reservationId },
            data:  { status: 'CHECKED_OUT', checkedOutAt: new Date() },
        });
        return res.status(200).json({ success: true, reservation: updated });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── GET /api/reservations/:reservationId — single reservation detail ─────────
exports.getReservation = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const userId  = req.user.id;
        const { reservationId } = req.params;
        const r = await prisma.reservation.findUnique({
            where:   { id: reservationId },
            include: {
                businessProfile: { select: { bizId: true, businessName: true, logoUrl: true } },
                customer:        { select: { id: true, username: true } },
            },
        });
        if (!r) return res.status(404).json({ success: false, message: 'Reservation not found.' });
        const profile = await prisma.businessProfile.findUnique({ where: { userId }, select: { id: true } });
        const isOwner = profile?.id === r.businessProfileId;
        if (r.customerId !== userId && !isOwner)
            return res.status(403).json({ success: false, message: 'Forbidden.' });
        return res.status(200).json({ success: true, reservation: r });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── GET /api/reservations/availability?bizId=&date= ─────────────────────────
exports.getAvailability = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { bizId, date, locationId } = req.query;
        if (!bizId || !date) return res.status(400).json({ success: false, message: 'bizId and date are required.' });

        const d = new Date(date);
        if (isNaN(d.getTime())) return res.status(400).json({ success: false, message: 'Invalid date.' });

        const biz = await _getBiz(prisma, bizId);

        const rules = await prisma.availabilityRule.findMany({
            where: {
                businessProfileId: biz.id,
                isActive: true,
                ...(locationId ? { locationId } : {}),
            },
        });

        const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
        const dayEnd   = new Date(date); dayEnd.setHours(23, 59, 59, 999);
        const existing = await prisma.reservation.findMany({
            where: {
                businessProfileId: biz.id,
                status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] },
                startDatetime: { gte: dayStart, lte: dayEnd },
            },
            select: { startDatetime: true, endDatetime: true, serviceItemId: true },
        });

        return res.status(200).json({ success: true, rules, existingBookings: existing });
    } catch (err) {
        const code = err.status || 500;
        return res.status(code).json({ success: false, message: err.message });
    }
};

// ── counterProposeReservation ───────────────────────────────────────────
// Business proposes an alternative time for a reservation.
exports.counterProposeReservation = async (req, res) => {
    try {
        const { reservationId } = req.params;
        const { proposedStartDatetime, proposedEndDatetime, message } = req.body;

        if (!proposedStartDatetime) {
            return res.status(400).json({ success: false, message: 'proposedStartDatetime is required.' });
        }

        const reservation = await req.prisma.reservation.findUnique({
            where: { id: reservationId },
            include: { businessProfile: { select: { userId: true, businessName: true } } }
        });
        if (!reservation) return res.status(404).json({ success: false, message: 'Reservation not found.' });
        if (reservation.businessProfile.userId !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Not authorized.' });
        }
        if (reservation.status !== 'PENDING') {
            return res.status(400).json({ success: false, message: `Cannot counter-propose on a ${reservation.status} reservation.` });
        }

        // Update the reservation with the proposed alternative
        const updated = await req.prisma.reservation.update({
            where: { id: reservationId },
            data: {
                // Keep status as PENDING but store the counter-proposal
                // The customer will see the proposed alternative and can accept or decline
                proposedStartDatetime: new Date(proposedStartDatetime),
                proposedEndDatetime: proposedEndDatetime ? new Date(proposedEndDatetime) : null,
                counterProposeMessage: message || null,
                counterProposedAt: new Date(),
            }
        });

        // Notify the customer
        await req.prisma.notification.create({
            data: {
                userId: reservation.customerId,
                type: 'COUNTER_PROPOSAL',
                category: 'MARKETPLACE',
                title: `${reservation.businessProfile.businessName} proposed an alternative time`,
                body: message || `The business has proposed ${new Date(proposedStartDatetime).toLocaleString()}. Tap to review.`,
                metadata: { reservationId, proposedStartDatetime, proposedEndDatetime },
                isRead: false,
            }
        });

        // Real-time push
        if (req.app.get('io')) {
            req.app.get('io').to(`user_${reservation.customerId}`).emit('counter_proposal', {
                reservationId,
                businessName: reservation.businessProfile.businessName,
                proposedStartDatetime,
                proposedEndDatetime,
                message,
            });
        }

        res.json({ success: true, reservation: updated });
    } catch (err) {
        console.error('[counterProposeReservation]', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
};

// ── acceptCounterProposal ────────────────────────────────────────────────
// Customer accepts the business's proposed alternative time.
exports.acceptCounterProposal = async (req, res) => {
    try {
        const { reservationId } = req.params;

        const reservation = await req.prisma.reservation.findUnique({
            where: { id: reservationId }
        });
        if (!reservation) return res.status(404).json({ success: false, message: 'Reservation not found.' });
        if (reservation.customerId !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Not authorized.' });
        }
        if (!reservation.proposedStartDatetime) {
            return res.status(400).json({ success: false, message: 'No counter-proposal to accept.' });
        }

        // Apply the proposed times
        const updated = await req.prisma.reservation.update({
            where: { id: reservationId },
            data: {
                startDatetime: reservation.proposedStartDatetime,
                endDatetime: reservation.proposedEndDatetime || reservation.endDatetime,
                proposedStartDatetime: null,
                proposedEndDatetime: null,
                counterProposeMessage: null,
            }
        });

        // Notify the business
        await req.prisma.notification.create({
            data: {
                userId: (await req.prisma.businessProfile.findUnique({ where: { id: reservation.businessProfileId }, select: { userId: true } })).userId,
                type: 'COUNTER_PROPOSAL',
                category: 'MARKETPLACE',
                title: 'Counter-proposal accepted',
                body: 'The customer accepted your proposed alternative time.',
                metadata: { reservationId },
                isRead: false,
            }
        });

        res.json({ success: true, reservation: updated });
    } catch (err) {
        console.error('[acceptCounterProposal]', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
};
