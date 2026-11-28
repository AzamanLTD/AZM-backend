// services/stayCheckInService.js
// =============================================================================
// Checking a hotel guest in by ID check, for when the guest's QR cannot be
// scanned (a dead phone, no data). The same rule transit boarding uses:
//
//   • staff compare the guest's photo and ID with the booking and type the
//     AZM-ID the guest shows; it must be the guest's;
//   • the business may turn ID check off (businessMeta.stayCheckIn
//     .allowIdCheck; default on);
//   • a stay paid in the app is checked in, but its money stays HELD: it is
//     released to the hotel when the guest confirms "That was me" in the
//     app, or automatically once the report window has passed. If the guest
//     reports it ("Not me"), the escrow becomes a dispute and nothing is paid
//     until review decides. A QR check-in pays at once, because only the
//     guest's own phone can show that QR.
//   • a stay not paid in the app has no money to hold: it checks in as usual.
//
// The check-in window is the same as the QR's (paidStayPolicy).
// =============================================================================

const { randomUUID } = require('crypto');
const logger = require('../src/config/logger');
const { normalizeAzamanId } = require('./transitBoardingService');
const { _releaseBookingEscrowTx } = require('./bookingEscrowService');
const { checkInOpensAt, checkInClosesAt, isPaidStay } = require('./paidStayPolicy');

const HOUR_MS = 60 * 60 * 1000;
/** How long a guest has to report an ID-check check-in before the hotel is paid. */
const STAY_ID_CHECK_HOLD_MS = 24 * HOUR_MS;
const HELD = ['FUNDED', 'IN_PROGRESS', 'PENDING_SETTLEMENT'];
const ID_CHECK = 'ID_CHECK';

const _err = (code, message, httpStatus = 400) => Object.assign(new Error(message), { code, httpStatus });
const _obj = (m) => (m && typeof m === 'object' && !Array.isArray(m) ? m : {});

/** The business's check-in rule. Default: ID checks allowed. */
const stayCheckInPolicy = (businessProfile) => {
    const p = _obj(_obj(businessProfile && businessProfile.businessMeta).stayCheckIn);
    return { allowIdCheck: p.allowIdCheck !== false };
};

const _checkIn = (r) => _obj(_obj(r && r.metadata).checkIn);

/**
 * Staff check a guest in by ID. businessProfileId is the business the staff
 * member acts for (the reservation must be its own); actorUserId is who did it.
 */
const checkInByIdCheck = async (prisma, { reservationId, businessProfileId, actorUserId, azamanId, now = Date.now() }) => {
    if (!reservationId) throw _err('BAD_REQUEST', 'reservationId is required.');
    if (!businessProfileId) throw _err('BAD_REQUEST', 'A business is required.');
    const given = normalizeAzamanId(azamanId);
    if (!given) throw _err('AZAMAN_ID_REQUIRED', "Enter the guest's AZM-ID.");

    const pre = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { id: true, escrowId: true, businessProfileId: true } });
    // Another business's reservation reads as missing: no probing of ids.
    if (!pre || pre.businessProfileId !== businessProfileId) throw _err('NOT_FOUND', 'Reservation not found.', 404);

    return prisma.$transaction(async (tx) => {
        // Escrow first, then the reservation: the order every booking
        // money path takes, so this cannot deadlock with a cancellation.
        if (pre.escrowId) await tx.$executeRaw`SELECT id FROM "SmartEscrow" WHERE "id" = ${pre.escrowId} FOR UPDATE`;
        await tx.$executeRaw`SELECT id FROM "Reservation" WHERE "id" = ${reservationId} FOR UPDATE`;
        const r = await tx.reservation.findUnique({ where: { id: reservationId }, include: { businessProfile: true } });
        if (!r || r.businessProfileId !== businessProfileId) throw _err('NOT_FOUND', 'Reservation not found.', 404);
        if (!stayCheckInPolicy(r.businessProfile).allowIdCheck) {
            throw _err('ID_CHECK_DISABLED', 'Your business checks guests in by QR only. You can change this in check-in settings.', 409);
        }
        const guest = await tx.user.findUnique({ where: { id: r.customerId }, select: { id: true, azamanId: true } });
        if (!guest || normalizeAzamanId(guest.azamanId || '') !== given) {
            throw _err('AZAMAN_ID_MISMATCH', 'That AZM-ID is not the guest on this reservation.', 409);
        }
        if (r.status === 'CHECKED_IN') throw _err('ALREADY_CHECKED_IN', 'This guest is already checked in.', 409);
        if (r.status !== 'CONFIRMED') throw _err('NOT_CHECKIN_READY', `Reservation is ${r.status}, cannot check in.`, 409);
        const opens = checkInOpensAt(r);
        const closes = checkInClosesAt(r);
        if (opens != null && now < opens) throw _err('CHECKIN_NOT_OPEN', 'Check-in for this stay opens 24 hours before arrival.', 409);
        if (closes != null && now > closes) throw _err('CHECKIN_CLOSED', 'The check-in window for this stay has closed.', 409);

        const escrow = r.escrowId ? await tx.smartEscrow.findUnique({ where: { id: r.escrowId } }) : null;
        if (escrow && ['DISPUTED', 'ADMIN_REVIEW'].includes(escrow.status)) {
            throw _err('ESCROW_IN_DISPUTE', 'This stay\'s payment is under review.', 409);
        }
        const paid = !!escrow && HELD.includes(escrow.status);
        const at = new Date(now);
        const holdUntil = paid ? new Date(now + STAY_ID_CHECK_HOLD_MS) : null;
        const metadata = {
            ..._obj(r.metadata),
            checkIn: {
                method: ID_CHECK, at: at.toISOString(), by: actorUserId || null, azamanId: given,
                ...(holdUntil ? { holdUntil: holdUntil.toISOString() } : {}),
            },
        };
        // Not paid in the app, or a draft deposit: an ordinary check-in.
        if (escrow && escrow.status === 'DRAFT') {
            await tx.smartEscrow.updateMany({ where: { id: escrow.id, status: 'DRAFT' }, data: { status: 'EXPIRED' } });
        }
        const claimed = await tx.reservation.updateMany({
            where: { id: reservationId, status: 'CONFIRMED' },
            data: { status: 'CHECKED_IN', checkedInAt: at, metadata },
        });
        if (claimed.count !== 1) throw _err('CONFLICT', 'The reservation just changed. Try again.', 409);
        return {
            success: true,
            reservation: { ...r, status: 'CHECKED_IN', checkedInAt: at, metadata, businessProfile: undefined },
            paymentHeld: paid,
            holdUntil,
            businessName: r.businessProfile ? r.businessProfile.businessName : null,
            customerId: r.customerId,
        };
    });
};

const _ownReservation = async (prisma, reservationId, customerId) => {
    const r = await prisma.reservation.findUnique({ where: { id: reservationId } });
    if (!r || r.customerId !== customerId) throw _err('NOT_FOUND', 'Reservation not found.', 404);
    return r;
};

/** Release a held ID-check payment, once (inside a transaction). */
const _releaseHeldTx = async (tx, r, { now, guestConfirmedAt = null }) => {
    const ci = _checkIn(r);
    const escrow = r.escrowId ? await tx.smartEscrow.findUnique({ where: { id: r.escrowId } }) : null;
    if (!escrow || !HELD.includes(escrow.status)) return { released: false };
    const reference = randomUUID();
    await _releaseBookingEscrowTx(tx, { escrowId: escrow.id, reference });
    await tx.reservation.update({
        where: { id: r.id },
        data: {
            metadata: {
                ..._obj(r.metadata),
                checkIn: { ...ci, ...(guestConfirmedAt ? { guestConfirmedAt } : {}), releasedAt: new Date(now).toISOString() },
            },
        },
    });
    return { released: true, reference };
};

/** The guest: "That was me". Pays the hotel now. */
const confirmStayCheckIn = async (prisma, { reservationId, customerId, now = Date.now() }) => {
    const pre = await _ownReservation(prisma, reservationId, customerId);
    return prisma.$transaction(async (tx) => {
        if (pre.escrowId) await tx.$executeRaw`SELECT id FROM "SmartEscrow" WHERE "id" = ${pre.escrowId} FOR UPDATE`;
        const r = await tx.reservation.findUnique({ where: { id: reservationId } });
        const ci = _checkIn(r);
        if (ci.method !== ID_CHECK) throw _err('NOT_ID_CHECKED', 'This stay was not checked in by an ID check.', 409);
        if (!['CHECKED_IN', 'CHECKED_OUT', 'COMPLETED'].includes(r.status)) throw _err('NOT_CHECKED_IN', `Reservation is ${r.status}.`, 409);
        const confirmedAt = ci.guestConfirmedAt || new Date(now).toISOString();
        const out = await _releaseHeldTx(tx, r, { now, guestConfirmedAt: confirmedAt });
        if (!out.released && !ci.guestConfirmedAt) {
            await tx.reservation.update({
                where: { id: r.id },
                data: { metadata: { ..._obj(r.metadata), checkIn: { ...ci, guestConfirmedAt: confirmedAt } } },
            });
        }
        return { success: true, confirmedAt, released: out.released };
    });
};

/** The guest: "Not me". Opens a dispute on the stay's escrow; nothing is paid until review. */
const reportStayCheckIn = async (prisma, { reservationId, customerId, reason }) => {
    const r = await _ownReservation(prisma, reservationId, customerId);
    if (_checkIn(r).method !== ID_CHECK) throw _err('NOT_ID_CHECKED', 'This stay was not checked in by an ID check.', 409);
    if (!r.escrowId) throw _err('NOT_PAID', 'This stay was not paid in Azaman, so there is no payment to hold. Contact the hotel.', 409);
    const note = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
    const escrowService = require('./escrowService');
    try {
        const out = await escrowService.raiseDispute(prisma, {
            escrowId: r.escrowId,
            raisedById: customerId,
            reason: `Guest reports an ID-check check-in on reservation ${r.reservationRef}: ${note || 'I was not checked in at this hotel.'}`,
            evidenceUrls: [],
        });
        return { success: true, alreadyReported: false, disputeId: out && out.dispute ? out.dispute.id : null };
    } catch (err) {
        const msg = (err && err.message) || '';
        if (msg === 'ESCROW_ALREADY_DISPUTED') return { success: true, alreadyReported: true, disputeId: null };
        if (/in status (SETTLED|RELEASED)/.test(msg)) {
            throw _err('ALREADY_PAID_OUT', 'The payment already went to the hotel. Contact support to report this stay.', 409);
        }
        if (/Cannot dispute an escrow in status|^Escrow not found|^Only a participant/.test(msg)) {
            throw _err('NOT_REPORTABLE', 'This stay cannot be reported here. Contact support.', 409);
        }
        throw err;
    }
};

/**
 * The worker: pay hotels for ID-check check-ins whose report window has
 * passed without a report (a reported one is DISPUTED and is not claimable).
 */
const sweepHeldStayPayouts = async (prisma, { now = Date.now(), limit = 100 } = {}) => {
    const out = { checked: 0, released: 0, failed: 0 };
    const due = await prisma.reservation.findMany({
        where: {
            status: { in: ['CHECKED_IN', 'CHECKED_OUT', 'COMPLETED'] },
            escrowId: { not: null },
            checkedInAt: { lte: new Date(now - STAY_ID_CHECK_HOLD_MS) },
        },
        select: { id: true, escrowId: true, metadata: true },
        orderBy: { checkedInAt: 'asc' },
        take: limit,
    });
    for (const row of due) {
        const ci = _checkIn(row);
        if (ci.method !== ID_CHECK || ci.releasedAt) continue;
        if (ci.holdUntil && new Date(ci.holdUntil).getTime() > now) continue;
        out.checked += 1;
        try {
            const r = await prisma.$transaction(async (tx) => {
                await tx.$executeRaw`SELECT id FROM "SmartEscrow" WHERE "id" = ${row.escrowId} FOR UPDATE`;
                const fresh = await tx.reservation.findUnique({ where: { id: row.id } });
                return _releaseHeldTx(tx, fresh, { now });
            });
            if (r.released) out.released += 1;
        } catch (err) {
            out.failed += 1;
            logger.error({ err: err.message, reservationId: row.id }, '[stayCheckIn] held payout release failed');
        }
    }
    return out;
};

/** Owner setting: may staff check guests in by ID? */
const setStayCheckInPolicy = async (prisma, { businessProfileId, allowIdCheck }) => {
    if (typeof allowIdCheck !== 'boolean') throw _err('BAD_REQUEST', 'allowIdCheck must be true or false.');
    return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM "BusinessProfile" WHERE "id" = ${businessProfileId} FOR UPDATE`;
        const fresh = await tx.businessProfile.findUnique({ where: { id: businessProfileId } });
        if (!fresh) throw _err('NOT_FOUND', 'Business profile not found.', 404);
        const meta = _obj(fresh.businessMeta);
        await tx.businessProfile.update({
            where: { id: businessProfileId },
            data: { businessMeta: { ...meta, stayCheckIn: { ..._obj(meta.stayCheckIn), allowIdCheck, updatedAt: new Date().toISOString() } } },
        });
        return { allowIdCheck };
    });
};

module.exports = {
    STAY_ID_CHECK_HOLD_MS, stayCheckInPolicy, checkInByIdCheck, confirmStayCheckIn, reportStayCheckIn,
    sweepHeldStayPayouts, setStayCheckInPolicy, isPaidStay,
};
