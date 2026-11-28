// services/transitBoardingService.js
// =============================================================================
// AZAMAN — TRANSIT BOARDING: who is on a trip, and boarding by an ID check
// beside the passenger's own QR.
//
// Two ways to board a paid passenger. The release of the fare follows the
// evidence (transitBookingService.payoutReadyAt):
//
//   QR_TOKEN  The passenger's own signed, short-lived code (qrCheckInService).
//             The fare is released when the trip completes after departure.
//
//   ID_CHECK  Staff looked the passenger up by AZM-ID (manifest or search),
//             checked their photo and ID against the account, and boarded
//             them. Allowed unless the business chose "QR only". The
//             passenger is told at once and can confirm it ("That was me")
//             or report it ("Not me"). The fare is released at completion if
//             they confirmed; otherwise it waits until departure + 24 hours
//             and the hourly sweep releases it, unless they reported it (the
//             escrow is then DISPUTED and goes to dispute review).
//
// Authority is the business that owns the trip: its owner, exactly like QR
// boarding (staff roles through Business OS are a follow-up).
//
// The boarding window is the QR's: one hour either side of departure.
// =============================================================================

const { TRANSIT_WINDOW_MS, BOARDING_METHOD, _withBoarding } = require('./qrCheckInService');
const { RELEASE_CLAIMABLE } = require('./bookingEscrowService');
const { ID_CHECK_PAYOUT_HOLD_MS, _releaseHeldPayoutTx } = require('./transitBookingService');

const BOARDABLE = ['CONFIRMED', 'IN_PROGRESS'];
const MANIFEST_STATUSES = ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'NO_SHOW'];
const PASSENGER_SELECT = {
    id: true, azamanId: true, username: true, displayName: true,
    legalName: true, profilePictureUrl: true, kycStatus: true,
};

const _err = (code, message, httpStatus = 400) => Object.assign(new Error(message), { code, httpStatus });
const _obj = (m) => (m && typeof m === 'object' && !Array.isArray(m) ? m : {});

/**
 * AZM-IDs are AZM- plus nine digits. Staff may type it any way they read it
 * off a phone: "azm-000000123", "AZM 123", "123".
 */
const normalizeAzamanId = (value) => {
    if (typeof value !== 'string') return '';
    const v = value.trim().toUpperCase().replace(/\s+/g, '');
    const m = /^(?:AZM-?)?(\d{1,9})$/.exec(v);
    return m ? `AZM-${m[1].padStart(9, '0')}` : v;
};

/** The business's boarding rule. Default: ID checks allowed. */
const transitBoardingPolicy = (businessProfile) => {
    const tb = _obj(_obj(businessProfile && businessProfile.businessMeta).transitBoarding);
    return { allowIdCheck: tb.allowIdCheck !== false };
};

// Where the fare is, in words the app shows.
const paymentOf = (escrowStatus) => {
    if (!escrowStatus || escrowStatus === 'DRAFT') return 'UNPAID';
    if (RELEASE_CLAIMABLE.includes(escrowStatus)) return 'HELD';
    if (escrowStatus === 'SETTLED' || escrowStatus === 'RELEASED') return 'PAID_OUT';
    if (escrowStatus === 'DISPUTED' || escrowStatus === 'ADMIN_REVIEW') return 'REPORTED';
    return 'REFUNDED'; // REFUNDED, EXPIRED
};

/**
 * What staff see to check a passenger against their ID: the account photo,
 * AZM-ID and names. The legal name (the name on their ID) is given only for
 * a passenger who holds a booking with this business.
 */
const passengerCard = (customer, { withLegalName = false } = {}) => (customer ? {
    id: customer.id,
    azamanId: customer.azamanId || null,
    username: customer.username || null,
    displayName: customer.displayName || null,
    legalName: withLegalName ? (customer.legalName || null) : null,
    profilePictureUrl: customer.profilePictureUrl || null,
    idVerified: customer.kycStatus === 'VERIFIED',
} : null);

const _departureMs = (trip, booking) => {
    const at = (trip && trip.departureAt) || (booking && booking.scheduledAt);
    return at ? new Date(at).getTime() : null;
};

const _bookingView = (booking, { trip, customer, seats, escrowStatus, policy, now }) => {
    const dep = _departureMs(trip, booking);
    const meta = _obj(booking.metadata);
    const boarding = meta.boarding ? _obj(meta.boarding) : null;
    const payout = meta.payout ? _obj(meta.payout) : null;
    const inWindow = dep != null && now >= dep - TRANSIT_WINDOW_MS && now <= dep + TRANSIT_WINDOW_MS;
    const payment = paymentOf(escrowStatus);
    return {
        id: booking.id,
        bookingRef: booking.bookingRef,
        status: booking.status,
        tripId: booking.tripId || null,
        origin: (trip && trip.origin) || booking.pickupAddress || null,
        destination: (trip && trip.destination) || booking.dropoffAddress || null,
        departureAt: dep != null ? new Date(dep) : null,
        seats: (seats || []).map((s) => ({ seatId: s.seatId, passengerName: s.passengerName || null })),
        amountUsdc: Number(booking.amountUsdc),
        payment,
        paid: payment === 'HELD' || payment === 'PAID_OUT' || payment === 'REPORTED',
        passenger: passengerCard(customer, { withLegalName: true }),
        boarding: boarding ? {
            method: boarding.method || null,
            at: boarding.at || null,
            passengerConfirmedAt: boarding.passengerConfirmedAt || null,
        } : null,
        payout: payout ? { heldUntil: payout.heldUntil || null, releasedAt: payout.releasedAt || null } : null,
        boardingWindow: dep != null
            ? { opensAt: new Date(dep - TRANSIT_WINDOW_MS), closesAt: new Date(dep + TRANSIT_WINDOW_MS) }
            : null,
        canBoardById: booking.status === 'CONFIRMED' && inWindow && policy.allowIdCheck,
    };
};

// Batch the relations for a list of bookings (no N+1 per passenger).
const _views = async (prisma, bookings, { policy, now, trip: knownTrip = null }) => {
    if (bookings.length === 0) return [];
    const ids = bookings.map((b) => b.id);
    const customerIds = [...new Set(bookings.map((b) => b.customerId))];
    const escrowIds = bookings.map((b) => b.escrowId).filter(Boolean);
    const tripIds = knownTrip ? [] : [...new Set(bookings.map((b) => b.tripId).filter(Boolean))];
    const [customers, seats, escrows, trips] = await Promise.all([
        prisma.user.findMany({ where: { id: { in: customerIds } }, select: PASSENGER_SELECT }),
        prisma.transitBookingSeat.findMany({ where: { bookingId: { in: ids } }, select: { bookingId: true, seatId: true, passengerName: true } }),
        escrowIds.length
            ? prisma.smartEscrow.findMany({ where: { id: { in: escrowIds } }, select: { id: true, status: true } })
            : [],
        tripIds.length
            ? prisma.transitTrip.findMany({ where: { id: { in: tripIds } }, select: { id: true, origin: true, destination: true, departureAt: true } })
            : [],
    ]);
    const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
    const customerMap = byId(customers);
    const escrowMap = byId(escrows);
    const tripMap = byId(trips);
    return bookings.map((b) => _bookingView(b, {
        trip: knownTrip || tripMap.get(b.tripId) || null,
        customer: customerMap.get(b.customerId) || null,
        seats: seats.filter((s) => s.bookingId === b.id),
        escrowStatus: b.escrowId ? (escrowMap.get(b.escrowId) || {}).status : null,
        policy,
        now,
    }));
};

const _seatOrder = (a, b) => a.seatId.localeCompare(b.seatId, undefined, { numeric: true });

const _ownedProfile = async (prisma, businessProfileId, businessUserId) => {
    const profile = businessProfileId
        ? await prisma.businessProfile.findUnique({ where: { id: businessProfileId } })
        : null;
    if (!profile || profile.userId !== businessUserId) return null;
    return profile;
};

// =============================================================================
// 1. MANIFEST — every passenger on a trip, by seat, with what staff need to
//    check them: photo, AZM-ID, names, payment, boarding.
// =============================================================================
const buildTripManifest = async (prisma, { tripId, businessUserId, now = Date.now() }) => {
    if (!tripId) throw _err('BAD_REQUEST', 'tripId is required.');
    const trip = await prisma.transitTrip.findUnique({ where: { id: tripId } });
    const profile = trip ? await _ownedProfile(prisma, trip.businessProfileId, businessUserId) : null;
    if (!profile) throw _err('NOT_FOUND', 'Trip not found.', 404);
    const policy = transitBoardingPolicy(profile);

    const bookings = await prisma.transitBooking.findMany({
        where: { tripId, status: { in: MANIFEST_STATUSES } },
        orderBy: { createdAt: 'asc' },
    });
    const passengers = await _views(prisma, bookings, { policy, now, trip });
    const seats = passengers
        .flatMap((p) => p.seats.map((s) => ({
            seatId: s.seatId,
            passengerName: s.passengerName,
            bookingId: p.id,
            bookingRef: p.bookingRef,
            status: p.status,
            azamanId: p.passenger ? p.passenger.azamanId : null,
            displayName: p.passenger ? (p.passenger.displayName || p.passenger.username) : null,
        })))
        .sort(_seatOrder);
    const count = (...st) => passengers.filter((p) => st.includes(p.status)).length;
    const dep = _departureMs(trip, null);
    return {
        trip: {
            id: trip.id,
            routeName: trip.routeName || null,
            origin: trip.origin,
            destination: trip.destination,
            departureAt: trip.departureAt,
            status: trip.status,
        },
        policy,
        boardingWindow: dep != null
            ? { opensAt: new Date(dep - TRANSIT_WINDOW_MS), closesAt: new Date(dep + TRANSIT_WINDOW_MS) }
            : null,
        counts: {
            booked: count('CONFIRMED', 'IN_PROGRESS', 'COMPLETED'),
            boarded: count('IN_PROGRESS', 'COMPLETED'),
            waiting: count('CONFIRMED'),
            noShow: count('NO_SHOW'),
        },
        passengers,
        seats,
    };
};

// =============================================================================
// 2. AZM-ID SEARCH — the passenger's upcoming bookings with this business,
//    added to the check-in search (qrCheckInService.searchByAzamanId).
// =============================================================================
const enrichAzamanIdSearch = async (prisma, { businessUserId, result, now = Date.now() }) => {
    const customer = result && result.customer;
    if (!customer) return result;
    const profile = await prisma.businessProfile.findFirst({ where: { userId: businessUserId } });
    if (!profile) return result;
    const policy = transitBoardingPolicy(profile);
    const bookings = await prisma.transitBooking.findMany({
        where: { businessProfileId: profile.id, customerId: customer.id, status: { in: BOARDABLE } },
        orderBy: { scheduledAt: 'asc' },
        take: 20,
    });
    const transitBookings = await _views(prisma, bookings, { policy, now });
    const full = await prisma.user.findUnique({ where: { id: customer.id }, select: PASSENGER_SELECT });
    const hasBooking = transitBookings.length > 0 || (result.reservations || []).length > 0;
    return {
        ...result,
        customer: { ...customer, ...passengerCard(full || customer, { withLegalName: hasBooking }) },
        transitBookings,
        boardingPolicy: policy,
    };
};

// =============================================================================
// 3. BOARD BY ID CHECK — staff saw the passenger and their ID.
//    The AZM-ID is sent back as the operator's confirmation that they
//    matched this person to this booking; a mismatch boards nothing.
// =============================================================================
const boardByIdCheck = async (prisma, { bookingId, businessUserId, azamanId, now = Date.now() }) => {
    if (!bookingId) throw _err('BAD_REQUEST', 'bookingId is required.');
    if (!businessUserId) throw _err('BAD_REQUEST', 'businessUserId is required.');
    const given = normalizeAzamanId(azamanId);
    if (!given) throw _err('AZAMAN_ID_REQUIRED', "Enter the passenger's AZM-ID.");

    const booking = await prisma.transitBooking.findUnique({ where: { id: bookingId } });
    if (!booking) throw _err('NOT_FOUND', 'Booking not found.', 404);
    const profile = await _ownedProfile(prisma, booking.businessProfileId, businessUserId);
    if (!profile) throw _err('FORBIDDEN', 'This booking does not belong to your business.', 403);
    if (!transitBoardingPolicy(profile).allowIdCheck) {
        throw _err('ID_CHECK_DISABLED', 'Your business boards by QR code only. You can change this in boarding settings.', 409);
    }
    const customer = await prisma.user.findUnique({ where: { id: booking.customerId }, select: { id: true, azamanId: true } });
    if (!customer || normalizeAzamanId(customer.azamanId || '') !== given) {
        throw _err('AZAMAN_ID_MISMATCH', 'That AZM-ID is not the passenger on this booking.', 409);
    }
    if (booking.status === 'IN_PROGRESS') throw _err('ALREADY_BOARDED', 'This passenger is already boarded.', 409);
    if (booking.status !== 'CONFIRMED') throw _err('NOT_BOARDABLE', `Booking is ${booking.status}, cannot board.`, 409);

    const trip = booking.tripId
        ? await prisma.transitTrip.findUnique({ where: { id: booking.tripId }, select: { departureAt: true } })
        : null;
    const dep = _departureMs(trip, booking);
    if (dep == null) throw _err('NO_BOARDING_WINDOW', 'This booking has no departure time to board against.', 409);
    if (now < dep - TRANSIT_WINDOW_MS) throw _err('BOARDING_NOT_OPEN', 'Boarding opens an hour before departure.', 409);
    if (now > dep + TRANSIT_WINDOW_MS) throw _err('BOARDING_CLOSED', 'The boarding window for this trip has closed.', 409);

    const at = new Date(now);
    const claimed = await prisma.transitBooking.updateMany({
        where: { id: booking.id, status: 'CONFIRMED', escrowId: booking.escrowId ?? null },
        data: {
            status: 'IN_PROGRESS',
            checkedInAt: at,
            pickupTime: at,
            metadata: _withBoarding(booking.metadata, {
                method: BOARDING_METHOD.ID_CHECK,
                at: at.toISOString(),
                by: businessUserId,
                azamanId: given,
            }),
        },
    });
    if (claimed.count !== 1) {
        const current = await prisma.transitBooking.findUnique({ where: { id: booking.id }, select: { status: true } });
        if (current && current.status === 'IN_PROGRESS') throw _err('ALREADY_BOARDED', 'This passenger is already boarded.', 409);
        throw _err('NOT_BOARDABLE', `Booking is ${current ? current.status : 'UNKNOWN'}, cannot board.`, 409);
    }
    const updated = await prisma.transitBooking.findUnique({ where: { id: booking.id } });
    const escrow = booking.escrowId
        ? await prisma.smartEscrow.findUnique({ where: { id: booking.escrowId }, select: { status: true } })
        : null;
    const paid = !!escrow && RELEASE_CLAIMABLE.includes(escrow.status);
    return {
        success: true,
        booking: updated,
        method: BOARDING_METHOD.ID_CHECK,
        paid,
        // Without the passenger's confirmation the fare waits this long
        // after departure before it is released.
        payoutHoldHours: paid ? ID_CHECK_PAYOUT_HOLD_MS / 3600000 : 0,
        businessName: profile.businessName || null,
        trip: trip ? { departureAt: trip.departureAt } : null,
    };
};

const _ownBooking = async (prisma, bookingId, customerId) => {
    if (!bookingId) throw _err('BAD_REQUEST', 'bookingId is required.');
    const b = await prisma.transitBooking.findUnique({ where: { id: bookingId } });
    // Someone else's booking reads as missing: no probing of booking ids.
    if (!b || b.customerId !== customerId) throw _err('NOT_FOUND', 'Booking not found.', 404);
    return b;
};

// =============================================================================
// 4. THE PASSENGER CONFIRMS — "That was me". Releases a completed trip's
//    held fare at once; otherwise the completion releases it.
//    Same escrow-first lock as completion, so neither overwrites the other.
// =============================================================================
const confirmIdCheckBoarding = async (prisma, { bookingId, customerId, now = Date.now() }) => {
    const pre = await _ownBooking(prisma, bookingId, customerId);
    return prisma.$transaction(async (tx) => {
        if (pre.escrowId) {
            await tx.$executeRaw`SELECT id FROM "SmartEscrow" WHERE "id" = ${pre.escrowId} FOR UPDATE`;
        }
        const b = await tx.transitBooking.findUnique({ where: { id: bookingId } });
        if (!b) throw _err('NOT_FOUND', 'Booking not found.', 404);
        const meta = _obj(b.metadata);
        const boarding = meta.boarding ? _obj(meta.boarding) : null;
        if (!boarding || boarding.method !== BOARDING_METHOD.ID_CHECK) {
            throw _err('NOT_ID_CHECKED', 'This trip was not boarded by an ID check.', 409);
        }
        if (!['IN_PROGRESS', 'COMPLETED'].includes(b.status)) {
            throw _err('NOT_BOARDED', `Booking is ${b.status}.`, 409);
        }
        let confirmedAt = boarding.passengerConfirmedAt || null;
        if (!confirmedAt) {
            confirmedAt = new Date(now).toISOString();
            const w = await tx.transitBooking.updateMany({
                where: { id: bookingId, status: b.status },
                data: { metadata: { ...meta, boarding: { ...boarding, passengerConfirmedAt: confirmedAt } } },
            });
            if (w.count !== 1) throw _err('CONFLICT', 'The booking just changed. Try again.', 409);
        }
        let release = null;
        if (b.status === 'COMPLETED' && pre.escrowId) {
            const r = await _releaseHeldPayoutTx(tx, { bookingId, escrowId: pre.escrowId, now });
            release = r.released ? r.release : null;
        }
        return { success: true, confirmedAt, release, booking: await tx.transitBooking.findUnique({ where: { id: bookingId } }) };
    });
};

// =============================================================================
// 5. THE PASSENGER REPORTS IT — "Not me". Opens a dispute on the fare's
//    escrow (escrowService.raiseDispute): the escrow becomes DISPUTED, which
//    no release path can claim, and dispute review decides it.
// =============================================================================
const reportIdCheckBoarding = async (prisma, { bookingId, customerId, reason }) => {
    const b = await _ownBooking(prisma, bookingId, customerId);
    const boarding = _obj(_obj(b.metadata).boarding);
    if (boarding.method !== BOARDING_METHOD.ID_CHECK) {
        throw _err('NOT_ID_CHECKED', 'This trip was not boarded by an ID check.', 409);
    }
    if (!b.escrowId) {
        throw _err('NOT_PAID', 'This trip was not paid in Azaman, so there is no fare to hold. Contact the operator.', 409);
    }
    const note = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
    const escrowService = require('./escrowService');
    try {
        const out = await escrowService.raiseDispute(prisma, {
            escrowId: b.escrowId,
            raisedById: customerId,
            reason: `Passenger reports an ID-check boarding on booking ${b.bookingRef}: `
                + (note || 'I was not boarded on this trip.'),
            evidenceUrls: [],
        });
        return { success: true, alreadyReported: false, disputeId: out && out.dispute ? out.dispute.id : null };
    } catch (err) {
        const msg = (err && err.message) || '';
        if (msg === 'ESCROW_ALREADY_DISPUTED') return { success: true, alreadyReported: true, disputeId: null };
        if (/in status (SETTLED|RELEASED)/.test(msg)) {
            throw _err('ALREADY_PAID_OUT', 'The fare was already paid to the operator. Contact support to report this trip.', 409);
        }
        if (/Cannot dispute an escrow in status/.test(msg)) throw _err('NOT_REPORTABLE', msg, 409);
        throw err;
    }
};

// =============================================================================
// 6. POLICY — the owner chooses whether staff may board by ID check.
// =============================================================================
const getTransitBoardingPolicy = async (prisma, { businessUserId }) => {
    const profile = await prisma.businessProfile.findFirst({ where: { userId: businessUserId } });
    if (!profile) throw _err('NOT_FOUND', 'Business profile not found.', 404);
    return transitBoardingPolicy(profile);
};

const setTransitBoardingPolicy = async (prisma, { businessUserId, allowIdCheck }) => {
    if (typeof allowIdCheck !== 'boolean') throw _err('BAD_REQUEST', 'allowIdCheck must be true or false.');
    const profile = await prisma.businessProfile.findFirst({ where: { userId: businessUserId } });
    if (!profile) throw _err('NOT_FOUND', 'Business profile not found.', 404);
    return prisma.$transaction(async (tx) => {
        // businessMeta holds other settings too: lock, re-read, merge.
        await tx.$executeRaw`SELECT id FROM "BusinessProfile" WHERE "id" = ${profile.id} FOR UPDATE`;
        const fresh = await tx.businessProfile.findUnique({ where: { id: profile.id } });
        const meta = _obj(fresh && fresh.businessMeta);
        await tx.businessProfile.update({
            where: { id: profile.id },
            data: {
                businessMeta: {
                    ...meta,
                    transitBoarding: { ..._obj(meta.transitBoarding), allowIdCheck, updatedAt: new Date().toISOString() },
                },
            },
        });
        return { allowIdCheck };
    });
};

module.exports = {
    normalizeAzamanId,
    transitBoardingPolicy,
    paymentOf,
    passengerCard,
    buildTripManifest,
    enrichAzamanIdSearch,
    boardByIdCheck,
    confirmIdCheckBoarding,
    reportIdCheckBoarding,
    getTransitBoardingPolicy,
    setTransitBoardingPolicy,
};
