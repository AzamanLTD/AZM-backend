// controllers/reservationController.js
// =============================================================================
// RESERVATION SYSTEM (2026-06-24)
// Customer-facing: create + list + cancel reservations.
// Business-facing: confirm, check-in, check-out, list incoming.
// NEVER moves USDC — escrow integration uses existing escrowService.
// =============================================================================

const logger = require('../src/config/logger');
const { emitWebhookEvent } = require('../services/webhookEmitter');
const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const reservationLifecycle = require('../services/reservationLifecycleService');

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
    let requestIdentity = null;
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
        let amount, deposit;
        try {
            amount = new Prisma.Decimal(amountUsdc);
            deposit = new Prisma.Decimal(depositUsdc == null ? 0 : depositUsdc);
        } catch (_) {
            return res.status(400).json({ success: false, message: 'Invalid monetary amount.' });
        }
        if (!amount.isFinite() || amount.lte(0) || amount.decimalPlaces() > 8 ||
            !deposit.isFinite() || deposit.lt(0) || deposit.decimalPlaces() > 8)
            return res.status(400).json({ success: false, message: 'Amounts must be nonnegative with at most 8 decimal places; amountUsdc must be positive.' });

        const start = new Date(startDatetime);
        const end   = new Date(endDatetime);
        if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start)
            return res.status(400).json({ success: false, message: 'endDatetime must be after startDatetime.' });

        const biz = await _getBiz(prisma, bizId);

        // Canonical payload identity is durable across request timeouts and restarts.
        // Legacy clients without a key deduplicate identical requests. To intentionally
        // rebook after cancelling an identical slot, send a fresh Idempotency-Key.
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
            businessProfileId: biz.id, customerId, locationId: locationId || null,
            serviceItemId: serviceItemId || null, start: start.toISOString(), end: end.toISOString(),
            partySize: parseInt(partySize, 10) || 1, amount: amount.toFixed(8), deposit: deposit.toFixed(8),
            cancellationPolicy: cancellationPolicy || null, customerNotes: customerNotes || null,
        })).digest('hex');
        const suppliedKey = req.headers?.['idempotency-key'] || req.get?.('Idempotency-Key');
        if (suppliedKey && (typeof suppliedKey !== 'string' || suppliedKey.length > 128))
            return res.status(400).json({ success: false, message: 'Idempotency-Key must be at most 128 characters.' });
        const clientRequestKey = suppliedKey || `auto:${fingerprint}`;
        requestIdentity = { businessProfileId: biz.id, customerId, clientRequestKey, fingerprint };
        const existing = await prisma.reservation.findUnique({ where: {
            businessProfileId_customerId_clientRequestKey: { businessProfileId: biz.id, customerId, clientRequestKey },
        } });
        if (existing) {
            if (existing.requestFingerprint !== fingerprint)
                return res.status(409).json({ success: false, message: 'Idempotency-Key was already used for a different reservation.' });
            return res.status(200).json({ success: true, reservation: existing, replayed: true });
        }

        // ── Availability conflict check (Phase 2.3) ──────────────────────────
        // Prevent double-booking: reject if an overlapping PENDING/CONFIRMED/
        // CHECKED_IN reservation exists for the same business (+ optional
        // location/service item).
        const conflictWhere = {
            businessProfileId: biz.id,
            status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] },
            OR: [
                { startDatetime: { lt: end }, endDatetime: { gt: start } },
            ],
        };
        if (locationId) conflictWhere.locationId = locationId;
        if (serviceItemId) conflictWhere.serviceItemId = serviceItemId;

        const conflict = await prisma.reservation.findFirst({ where: conflictWhere });
        if (conflict?.clientRequestKey === clientRequestKey && conflict.requestFingerprint === fingerprint &&
            conflict.customerId === customerId) {
            return res.status(200).json({ success: true, reservation: conflict, replayed: true });
        }
        if (conflict) {
            return res.status(409).json({
                success: false,
                message: 'This time slot is already booked. Please choose another time.',
                conflict: { id: conflict.id, start: conflict.startDatetime, end: conflict.endDatetime },
            });
        }

        const reservation = await prisma.reservation.create({
            data: {
                reservationRef:    genRef(),
                clientRequestKey,
                requestFingerprint: fingerprint,
                businessProfileId: biz.id,
                locationId:        locationId   || null,
                customerId,
                serviceItemId:     serviceItemId || null,
                startDatetime:     start,
                endDatetime:       end,
                partySize:         parseInt(partySize, 10) || 1,
                amountUsdc:        amount,
                depositUsdc:       deposit,
                cancellationPolicy: cancellationPolicy || null,
                customerNotes:     customerNotes || null,
                status:            'PENDING',
            },
        });

        // Fire-and-forget webhook for reservation creation
        emitWebhookEvent(biz.id, 'reservation.created', {
            reservationId: reservation.id,
            reservationRef: reservation.reservationRef,
            customerId,
            startDatetime: start.toISOString(),
            endDatetime: end.toISOString(),
            partySize: reservation.partySize,
            amountUsdc: reservation.amountUsdc,
        });

        return res.status(201).json({ success: true, reservation });
    } catch (err) {
        if (err.code === 'P2002' && requestIdentity) {
            const { businessProfileId, customerId, clientRequestKey, fingerprint } = requestIdentity;
            const existing = await prisma.reservation.findUnique({ where: {
                businessProfileId_customerId_clientRequestKey: { businessProfileId, customerId, clientRequestKey },
            } });
            if (existing) {
                if (existing.requestFingerprint !== fingerprint)
                    return res.status(409).json({ success: false, message: 'Idempotency-Key was already used for a different reservation.' });
                return res.status(200).json({ success: true, reservation: existing, replayed: true });
            }
        }
        if (err.code === 'P2002' || (err.code === 'P2004' && String(err.message).includes('reservation_'))) {
            return res.status(409).json({ success: false, message: 'This time slot is already booked. Please choose another time.' });
        }
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
                // A stay paid in the app: where its money is (held until
                // check-in, paid to the hotel, refunded) and what was paid.
                escrow: { select: { status: true, amountUsdc: true, feeUsdc: true } },
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
        const reservation = await reservationLifecycle.cancelReservation(prisma, {
            reservationId: req.params.reservationId,
            customerId: req.user.id,
        });
        return res.status(200).json({ success: true, reservation });
    } catch (err) {
        if (err.code === 'RESERVATION_NOT_FOUND') return res.status(404).json({ success: false, message: err.message });
        if (['RESERVATION_NOT_CANCELLABLE', 'RESERVATION_STATE_CONFLICT', 'ESCROW_IN_DISPUTE', 'ESCROW_ECONOMIC_CONFLICT', 'ESCROW_ALREADY_FINALIZED'].includes(err.code)) {
            return res.status(409).json({ success: false, message: err.message });
        }
        logger.error({ err }, '[reservation.cancel] atomic lifecycle failure');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── Who acts for the business ───────────────────────────────────────────────
// The owner, or staff whose permissions cover the job (services/businessActor).
// Front-desk work (confirm, decline, check in, check out, no-show) needs
// reservations.manage or hotel.front_desk.manage; the list needs any
// reservations or front-desk right. The lifecycle is called with the
// business's owner id (what it compares), so staff act for the business.
const RESERVATION_WORK = ['reservations.manage', 'hotel.front_desk.manage'];
const RESERVATION_READ = ['reservations.view', 'reservations.manage', 'hotel.front_desk.manage'];
const _reservationActor = async (prisma, req, anyOf) => {
    const { resolveBusinessActor } = require('../services/businessActor');
    return resolveBusinessActor(prisma, req.user, { anyOf });
};
const _notPermitted = (res) => res.status(403).json({ success: false, code: 'NOT_PERMITTED', message: 'You do not have permission to manage reservations for this business.' });

// ── GET /api/reservations/business/:bizId — the business sees all incoming ──
exports.listBusinessReservations = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { status, limit, cursor } = req.query;
        const take = Math.min(parseInt(limit, 10) || 20, 50);

        const actor = await _reservationActor(prisma, req, RESERVATION_READ);
        if (!actor) return _notPermitted(res);
        const profile = { id: actor.businessProfileId };

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
        const actor = await _reservationActor(prisma, req, RESERVATION_WORK);
        if (!actor) return _notPermitted(res);
        const profile = { id: actor.businessProfileId };

        const { reservationId } = req.params;
        const updated = await reservationLifecycle.confirmReservation(prisma, {
            reservationId,
            businessProfileId: profile.id,
            businessNotes: req.body.businessNotes || null,
        });

        // Fire-and-forget webhook for reservation confirmation
        emitWebhookEvent(profile.id, 'reservation.confirmed', {
            reservationId: updated.id,
            reservationRef: updated.reservationRef,
            customerId: updated.customerId,
            status: 'CONFIRMED',
            confirmedAt: updated.confirmedAt,
        });

        return res.status(200).json({ success: true, reservation: updated });
    } catch (err) {
        if (err.code === 'RESERVATION_NOT_FOUND') return res.status(404).json({ success: false, message: err.message });
        if (err.code === 'RESERVATION_CONFIRM_CONFLICT') return res.status(409).json({ success: false, message: err.message });
        logger.error({ err }, '[reservation.confirm] atomic lifecycle failure');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── PATCH /api/reservations/:reservationId/decline ───────────────────────────
// The hotel declines a request or cancels a stay it cannot honour. A stay
// paid in the app is refunded in the same transaction, the Azaman fee
// included (feeRefundPolicy: the business cancelled).
exports.declineReservation = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const actor = await _reservationActor(prisma, req, RESERVATION_WORK);
        if (!actor) return _notPermitted(res);
        const profile = { id: actor.businessProfileId };
        const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason : null;
        const reservation = await reservationLifecycle.businessCancelReservation(prisma, {
            reservationId: req.params.reservationId,
            businessProfileId: profile.id,
            reason,
        });
        try {
            const notifier = req.app.get('notificationService');
            if (notifier && typeof notifier.sendNotification === 'function') {
                const escrow = reservation.escrowId
                    ? await prisma.smartEscrow.findUnique({ where: { id: reservation.escrowId }, select: { status: true, amountUsdc: true, feeUsdc: true, refundTxHash: true } })
                    : null;
                // What came back, as the refund recorded it.
                const refundRow = escrow && escrow.status === 'REFUNDED' && escrow.refundTxHash
                    ? await prisma.transactionHistory.findUnique({ where: { txHash: escrow.refundTxHash }, select: { amountUsdc: true, metadata: true } })
                    : null;
                const meta = refundRow && refundRow.metadata && typeof refundRow.metadata === 'object' ? refundRow.metadata : {};
                // 2 to 6 decimals: a sub-cent fee is shown, not rounded away.
                const usdc = (n) => {
                    const t = Number(n).toFixed(6).replace(/0+$/, '');
                    const [w, f = ''] = t.split('.');
                    return `${w}.${f.padEnd(2, '0')} USDC`;
                };
                let refunded = 'Nothing was charged.';
                if (escrow && escrow.status === 'REFUNDED') {
                    if (Number(meta.feeRefundOwedUsdc) > 0) {
                        refunded = `The price you paid (${usdc(escrow.amountUsdc)}) is back in your wallet. `
                            + `Our team will refund the Azaman fee (${usdc(meta.feeRefundOwedUsdc)}) to you separately.`;
                    } else if (Number(meta.feeRefundedUsdc) > 0) {
                        refunded = `Everything you paid (${usdc(refundRow.amountUsdc)}, the Azaman fee included) is back in your wallet.`;
                    } else if (Number(escrow.feeUsdc) > 0) {
                        refunded = `The price you paid (${usdc(escrow.amountUsdc)}) is back in your wallet; the Azaman fee (${usdc(escrow.feeUsdc)}) is kept.`;
                    } else {
                        refunded = `The ${usdc(escrow.amountUsdc)} you paid is back in your wallet.`;
                    }
                }
                await notifier.sendNotification({
                    userId: reservation.customerId,
                    title: 'Your stay was cancelled',
                    body: `${profile.businessName} cancelled ${reservation.reservationRef}. ${refunded}`
                        + (reason ? ` Reason: ${String(reason).slice(0, 140)}` : ''),
                    category: 'MONEY',
                    actionPayload: { route: '/bookings?tab=reservations' },
                });
            }
        } catch (_) { /* the cancellation stands either way */ }
        return res.status(200).json({ success: true, reservation });
    } catch (err) {
        if (err.code === 'RESERVATION_NOT_FOUND') return res.status(404).json({ success: false, message: err.message });
        if (['RESERVATION_NOT_CANCELLABLE', 'RESERVATION_STATE_CONFLICT', 'ESCROW_IN_DISPUTE', 'ESCROW_ECONOMIC_CONFLICT', 'ESCROW_ALREADY_FINALIZED'].includes(err.code)) {
            return res.status(409).json({ success: false, code: err.code, message: err.message });
        }
        logger.error({ err }, '[reservation.decline] atomic lifecycle failure');
        return res.status(500).json({ success: false, message: 'The cancellation failed and nothing changed. Try again.' });
    }
};

// ── Check-in by ID check (stayCheckInService) ───────────────────────────────
const _stayFail = (res, err, tag) => {
    if (err && err.httpStatus) return res.status(err.httpStatus).json({ success: false, code: err.code, message: err.message });
    logger.error({ err: err && err.message }, tag);
    return res.status(500).json({ success: false, message: 'Something went wrong. Try again.' });
};
const FRONT_DESK = ['reservations.manage', 'hotel.front_desk.manage'];

// POST /api/reservations/:reservationId/checkin-by-id  { azamanId }
// The owner, or staff with reservations.manage or hotel.front_desk.manage.
exports.checkInById = async (req, res) => {
    const prisma = req.app.get('prisma');
    let result;
    try {
        const { resolveBusinessActor } = require('../services/businessActor');
        const actor = await resolveBusinessActor(prisma, req.user, { anyOf: FRONT_DESK });
        if (!actor) return res.status(403).json({ success: false, code: 'NOT_PERMITTED', message: 'You cannot check guests in for this business.' });
        const { checkInByIdCheck } = require('../services/stayCheckInService');
        result = await checkInByIdCheck(prisma, {
            reservationId: req.params.reservationId,
            businessProfileId: actor.businessProfileId,
            actorUserId: actor.actorUserId,
            azamanId: req.body && req.body.azamanId,
        });
    } catch (err) {
        return _stayFail(res, err, '[reservation.checkInById] error');
    }
    // The guest hears at once (best effort): a check-in that was not them is
    // reported before the money is released.
    try {
        const notifier = req.app.get('notificationService');
        if (notifier && typeof notifier.sendNotification === 'function') {
            await notifier.sendNotification({
                userId: result.customerId,
                title: 'You were checked in by ID check',
                body: (result.businessName || 'Your hotel') + ' checked your ID and checked you in. '
                    + (result.paymentHeld ? 'Was this you? Confirm it or report it in Orders & bookings.' : 'Enjoy your stay.'),
                category: 'MARKETPLACE',
                actionPayload: { route: '/bookings?tab=reservations', reservationId: result.reservation.id },
            });
        }
    } catch (err) {
        logger.error({ err: err && err.message, reservationId: result.reservation.id }, '[reservation.checkInById] guest notice failed');
    }
    return res.status(200).json({
        success: true,
        reservation: result.reservation,
        paymentHeld: result.paymentHeld,
        holdUntil: result.holdUntil,
    });
};

// POST /api/reservations/:reservationId/checkin/confirm — the guest: "That was me".
exports.confirmIdCheckIn = async (req, res) => {
    try {
        const { confirmStayCheckIn } = require('../services/stayCheckInService');
        const out = await confirmStayCheckIn(req.app.get('prisma'), { reservationId: req.params.reservationId, customerId: req.user.id });
        return res.status(200).json(out);
    } catch (err) {
        return _stayFail(res, err, '[reservation.confirmIdCheckIn] error');
    }
};

// POST /api/reservations/:reservationId/checkin/report  { reason } — the guest: "Not me".
exports.reportIdCheckIn = async (req, res) => {
    try {
        const { reportStayCheckIn } = require('../services/stayCheckInService');
        const out = await reportStayCheckIn(req.app.get('prisma'), {
            reservationId: req.params.reservationId, customerId: req.user.id, reason: req.body && req.body.reason,
        });
        return res.status(200).json(out);
    } catch (err) {
        return _stayFail(res, err, '[reservation.reportIdCheckIn] error');
    }
};

// GET/PUT /api/reservations/policy/checkin — may staff check guests in by ID?
// Read: anyone acting for the business. Change: the owner or settings.manage.
exports.getCheckInPolicy = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { resolveBusinessActor } = require('../services/businessActor');
        const actor = await resolveBusinessActor(prisma, req.user);
        if (!actor) return res.status(404).json({ success: false, message: 'Business profile not found.' });
        const profile = await prisma.businessProfile.findUnique({ where: { id: actor.businessProfileId } });
        const { stayCheckInPolicy } = require('../services/stayCheckInService');
        return res.status(200).json({ success: true, policy: stayCheckInPolicy(profile) });
    } catch (err) {
        return _stayFail(res, err, '[reservation.getCheckInPolicy] error');
    }
};
exports.setCheckInPolicy = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');
        const { resolveBusinessActor } = require('../services/businessActor');
        const actor = await resolveBusinessActor(prisma, req.user, { anyOf: ['settings.manage'] });
        if (!actor) return res.status(403).json({ success: false, code: 'NOT_PERMITTED', message: 'Only the owner or a manager with settings rights can change this.' });
        const { setStayCheckInPolicy } = require('../services/stayCheckInService');
        const policy = await setStayCheckInPolicy(prisma, { businessProfileId: actor.businessProfileId, allowIdCheck: req.body && req.body.allowIdCheck });
        return res.status(200).json({ success: true, policy });
    } catch (err) {
        return _stayFail(res, err, '[reservation.setCheckInPolicy] error');
    }
};

// ── PATCH /api/reservations/:reservationId/checkin ───────────────────────────
// A stay paid in the app checks in only by the guest's QR (that is what
// releases the money to the hotel); staff cannot check it in by hand.
exports.checkInReservation = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const actor = await _reservationActor(prisma, req, RESERVATION_WORK);
        if (!actor) return _notPermitted(res);
        const { isPaidReservation, qrCheckInRequiredError } = require('../services/stayPaymentService');
        if (await isPaidReservation(prisma, req.params.reservationId)) {
            const e = qrCheckInRequiredError();
            return res.status(e.httpStatus).json({ success: false, code: e.code, message: e.message });
        }
        const reservation = await reservationLifecycle.checkInReservation(prisma, {
            reservationId: req.params.reservationId,
            businessUserId: actor.ownerUserId,
        });
        return res.status(200).json({ success: true, reservation });
    } catch (err) {
        if (err.code === 'RESERVATION_NOT_FOUND') return res.status(404).json({ success: false, message: err.message });
        if (['RESERVATION_NOT_CHECKIN_READY', 'RESERVATION_STATE_CONFLICT', 'ESCROW_IN_DISPUTE', 'ESCROW_ECONOMIC_CONFLICT', 'ESCROW_ALREADY_FINALIZED', 'QR_CHECKIN_REQUIRED'].includes(err.code)) {
            return res.status(409).json({ success: false, code: err.code, message: err.message });
        }
        logger.error({ err }, '[reservation.checkin] atomic lifecycle failure');
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ── PATCH /api/reservations/:reservationId/checkout ──────────────────────────

// ── PATCH /api/reservations/:reservationId/no-show ─────────────────────────
exports.markNoShowReservation = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const actor = await _reservationActor(prisma, req, RESERVATION_WORK);
        if (!actor) return _notPermitted(res);
        const reservation = await reservationLifecycle.markNoShowReservation(prisma, {
            reservationId: req.params.reservationId,
            businessUserId: actor.ownerUserId,
        });
        return res.status(200).json({ success: true, reservation });
    } catch (err) {
        if (err.code === 'RESERVATION_NOT_FOUND') return res.status(404).json({ success: false, message: err.message });
        if (['RESERVATION_NOT_NO_SHOW_READY', 'RESERVATION_STATE_CONFLICT', 'BOOKING_NO_LONGER_CONFIRMED', 'ESCROW_IN_DISPUTE', 'ESCROW_ECONOMIC_CONFLICT', 'ESCROW_ALREADY_FINALIZED'].includes(err.code)) {
            return res.status(409).json({ success: false, message: err.message });
        }
        logger.error({ err }, '[reservation.no-show] atomic lifecycle failure');
        return res.status(500).json({ success: false, message: err.message });
    }
};

exports.checkOutReservation = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const actor = await _reservationActor(prisma, req, RESERVATION_WORK);
        if (!actor) return _notPermitted(res);
        const updated = await reservationLifecycle.checkOutReservation(prisma, {
            reservationId: req.params.reservationId,
            businessUserId: actor.ownerUserId,
        });
        return res.status(200).json({ success: true, reservation: updated });
    } catch (err) {
        if (err.code === 'RESERVATION_NOT_FOUND') return res.status(404).json({ success: false, message: err.message });
        if (['RESERVATION_NOT_CHECKOUT_READY', 'RESERVATION_STATE_CONFLICT'].includes(err.code)) {
            return res.status(409).json({ success: false, message: err.message });
        }
        logger.error({ err }, '[reservation.checkout] atomic lifecycle failure');
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
        const profile = await prisma.businessProfile.findFirst({ where: { userId }, select: { id: true } });
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

        // Update the reservation with the proposed alternative. A booking
        // paid in Azaman keeps its dates (PAID_DATES_FIXED), checked under
        // the reservation's row lock.
        const { assertDatesMovableTx } = require('../services/stayPaymentService');
        const updated = await req.prisma.$transaction(async (tx) => {
            await assertDatesMovableTx(tx, reservation.id);
            return tx.reservation.update({
                where: { id: reservation.id },
                data: {
                    // Keep status as PENDING but store the counter-proposal
                    // The customer will see the proposed alternative and can accept or decline
                    proposedStartDatetime: new Date(proposedStartDatetime),
                    proposedEndDatetime: proposedEndDatetime ? new Date(proposedEndDatetime) : null,
                    counterProposeMessage: message || null,
                    counterProposedAt: new Date(),
                }
            });
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
        if (err && err.code === 'PAID_DATES_FIXED') return res.status(409).json({ success: false, code: err.code, message: err.message });
        logger.error({ err: err }, '[counterProposeReservation]');
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

        // Apply the proposed times. A booking paid in Azaman keeps its dates
        // (PAID_DATES_FIXED), checked under the reservation's row lock.
        const { assertDatesMovableTx } = require('../services/stayPaymentService');
        const updated = await req.prisma.$transaction(async (tx) => {
            await assertDatesMovableTx(tx, reservation.id);
            return tx.reservation.update({
                where: { id: reservation.id },
                data: {
                    startDatetime: reservation.proposedStartDatetime,
                    endDatetime: reservation.proposedEndDatetime || reservation.endDatetime,
                    proposedStartDatetime: null,
                    proposedEndDatetime: null,
                    counterProposeMessage: null,
                }
            });
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
        if (err && err.code === 'PAID_DATES_FIXED') return res.status(409).json({ success: false, code: err.code, message: err.message });
        logger.error({ err: err }, '[acceptCounterProposal]');
        if (err.code === 'P2002' && err.meta?.target === null)
            return res.status(409).json({ success: false, message: 'The proposed time is no longer available.' });
        res.status(500).json({ success: false, message: err.message });
    }
};
