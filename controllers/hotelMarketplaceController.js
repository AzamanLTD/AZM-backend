'use strict';

/**
 * Customer-facing hotel marketplace adapter.
 *
 * Hotel inventory lives in HotelRoom/HotelRateOverride/HotelRoomBlock, not in
 * BusinessProduct. This controller exposes that domain without creating a
 * second reservation engine: reservation creation is delegated to the
 * canonical reservationController after authoritative room/rate validation.
 */

const { Prisma } = require('@prisma/client');
const reservationController = require('./reservationController');
// One pricing for the quote, the reservation and the paid stay.
const { startOfUtcDay, findNightlyRates } = require('../services/hotelPricingService');
const { bookingEscrowFee } = require('../services/bookingEscrowService');
const priceService = require('../services/businessPriceService');

function toPublicRoom(room) {
    return {
        id: room.id,
        businessProfileId: room.businessProfileId,
        locationId: room.locationId,
        roomNumber: room.roomNumber,
        roomType: room.roomType,
        floor: room.floor,
        capacity: room.capacity,
        bedConfig: room.bedConfig,
        status: room.status,
        basePriceUsdc: Number(room.basePriceUsdc),
        weekendPriceUsdc: room.weekendPriceUsdc == null ? null : Number(room.weekendPriceUsdc),
        amenities: room.amenities || [],
        imageUrls: room.imageUrls || [],
    };
}

function toPublicBusinessMeta(meta) {
    if (!meta || typeof meta !== 'object') return null;
    const publicMeta = {};
    if (Array.isArray(meta.showcaseUrls)) {
        publicMeta.showcaseUrls = meta.showcaseUrls.filter((url) => typeof url === 'string').slice(0, 20);
    }
    if (meta.penaltyPolicy && typeof meta.penaltyPolicy === 'object') {
        const penaltyPct = Number(meta.penaltyPolicy.penaltyPct);
        const gracePeriodMins = Number(meta.penaltyPolicy.gracePeriodMins);
        if (Number.isFinite(penaltyPct) || Number.isFinite(gracePeriodMins)) {
            publicMeta.penaltyPolicy = {
                ...(Number.isFinite(penaltyPct) ? { penaltyPct } : {}),
                ...(Number.isFinite(gracePeriodMins) ? { gracePeriodMins } : {}),
            };
        }
    }
    return Object.keys(publicMeta).length ? publicMeta : null;
}


exports.getBusinessDetail = async (req, res) => {
    const prisma = req.app.get('prisma');
    const { bizId } = req.params;

    const business = await prisma.businessProfile.findUnique({
        where: { bizId },
        select: {
            id: true,
            bizId: true,
            businessName: true,
            category: true,
            description: true,
            website: true,
            logoUrl: true,
            coverPhotoUrl: true,
            phoneNumber: true,
            contactEmail: true,
            address: true,
            country: true,
            isVerified: true,
            isSuspended: true,
            isPausedByOwner: true,
            kybStatus: true,
            totalEscrows: true,
            completedEscrows: true,
            totalVolume: true,
            averageRating: true,
            reviewCount: true,
            businessMeta: true,
            locations: {
                where: { isActive: true },
                orderBy: [{ isPrimary: 'desc' }, { label: 'asc' }],
            },
            products: {
                where: { isActive: true, isAvailable: true },
                orderBy: [{ catalogSectionId: 'asc' }, { name: 'asc' }],
            },
            hotelRooms: {
                where: { status: { not: 'MAINTENANCE' } },
                orderBy: [{ floor: 'asc' }, { roomNumber: 'asc' }],
            },
        },
    });

    if (!business || business.isSuspended) {
        return res.status(404).json({ success: false, message: 'Business not found.' });
    }

    const isHotel = business.category === 'HOSPITALITY';
    const products = business.products.map((product) => ({
        ...product,
        priceUsdc: Number(product.priceUsdc),
        totalRevenue: Number(product.totalRevenue),
        imageUrls: Array.isArray(product.imageUrls) ? product.imageUrls : [],
        variants: product.variants ?? null,
        modifierGroups: product.modifierGroups ?? null,
    }));

    // Authoritative GHS listing price on the customer-facing business-detail
    // response (review 2026-10-18): the SAME shared resolver as every other
    // product read surface (businessProductService._attachGhsPrices), so
    // /api/marketplace/business/:bizId carries the identical priceGhs
    // contract — exact 2dp string when an eligible current BusinessPrice
    // row exists, null otherwise (never a converted/relabeled priceUsdc).
    // Per-identity fail-closed semantics come from the resolver itself.
    if (products.length > 0) {
        const resolvedGhs = await priceService.resolveEffectiveGhsPrices(
            prisma,
            products.map((product) => product.id),
        );
        for (const product of products) {
            const row = resolvedGhs.get(product.id);
            product.priceGhs = row
                ? priceService.pesewasToGhsString(priceService.toPesewas(row.amountExact))
                : null;
        }
    }

    return res.json({
        success: true,
        data: {
            business: {
                ...business,
                businessMeta: toPublicBusinessMeta(business.businessMeta),
                totalVolume: Number(business.totalVolume),
                averageRating: Number(business.averageRating),
                products,
                locations: business.locations,
            },
            products,
            hotelRooms: isHotel ? business.hotelRooms.map(toPublicRoom) : [],
        },
    });
};

// =============================================================================
// GET /api/marketplace/business/:bizId/stay-quote?checkIn&checkOut&guests
//
// Read-only. For the chosen dates and guests, every room's exact total (the
// same per-night pricing the reservation charges: overrides, weekend rate,
// base rate) and whether it can be booked, with the reason when not. The app
// showed nights x base rate, which differed from the server total whenever a
// weekend or an override fell inside the stay, and offered rooms that the
// reservation then refused (too small, blocked, already booked).
// Mirrors createHotelReservation's checks and reservationController's
// double-booking rule (active reservation on the same room overlapping).
// =============================================================================
const MAX_QUOTE_NIGHTS = 60;
const ACTIVE_RESERVATION_STATUSES = ['PENDING', 'CONFIRMED', 'CHECKED_IN'];

exports.getStayQuote = async (req, res) => {
    const prisma = req.app.get('prisma');
    try {
        const { bizId } = req.params;
        const checkInDay = startOfUtcDay(req.query.checkIn);
        const checkOutDay = startOfUtcDay(req.query.checkOut);
        if (!checkInDay || !checkOutDay || checkOutDay <= checkInDay) {
            return res.status(400).json({ success: false, code: 'DATES_INVALID', message: 'Check-out must be after check-in.' });
        }
        if (checkInDay < startOfUtcDay(Date.now())) {
            return res.status(400).json({ success: false, code: 'DATES_PAST', message: 'Check-in cannot be in the past.' });
        }
        const nightsCount = Math.round((checkOutDay - checkInDay) / 86400000);
        if (nightsCount > MAX_QUOTE_NIGHTS) {
            return res.status(400).json({ success: false, code: 'STAY_TOO_LONG', message: `A stay can be at most ${MAX_QUOTE_NIGHTS} nights.` });
        }
        const guests = Math.min(Math.max(parseInt(req.query.guests, 10) || 1, 1), 50);

        const business = await prisma.businessProfile.findUnique({
            where: { bizId },
            select: { id: true, category: true, isSuspended: true, isPausedByOwner: true },
        });
        if (!business || business.isSuspended) {
            return res.status(404).json({ success: false, message: 'Business not found.' });
        }
        if (business.category !== 'HOSPITALITY') {
            return res.status(409).json({ success: false, message: 'This business is not configured as a hotel.' });
        }

        const rooms = await prisma.hotelRoom.findMany({
            where: { businessProfileId: business.id },
            orderBy: [{ floor: 'asc' }, { roomNumber: 'asc' }],
        });
        const ids = rooms.map((r) => r.id);
        const [blocks, booked] = ids.length === 0 ? [[], []] : await Promise.all([
            prisma.hotelRoomBlock.findMany({
                where: { roomId: { in: ids }, startDate: { lt: checkOutDay }, endDate: { gt: checkInDay } },
                select: { roomId: true },
            }),
            prisma.reservation.findMany({
                where: {
                    businessProfileId: business.id,
                    serviceItemId: { in: ids },
                    status: { in: ACTIVE_RESERVATION_STATUSES },
                    startDatetime: { lt: checkOutDay },
                    endDatetime: { gt: checkInDay },
                },
                select: { serviceItemId: true },
            }),
        ]);
        const blocked = new Set(blocks.map((b) => b.roomId));
        const taken = new Set(booked.map((b) => b.serviceItemId));
        // The Azaman fee on a stay paid in the app, from the same function
        // the payment charges with.
        const settings = await prisma.globalSettings.findUnique({ where: { id: 1 } });
        const round6 = (n) => parseFloat(Number(n).toFixed(6));

        const quoted = [];
        for (const room of rooms) {
            const nightly = await findNightlyRates(prisma, room, checkInDay, checkOutDay);
            const total = nightly.reduce((sum, n) => sum.add(n.priceUsdc), new Prisma.Decimal(0));
            const reason = room.status !== 'AVAILABLE' ? 'ROOM_UNAVAILABLE'
                : guests > room.capacity ? 'TOO_SMALL'
                    : blocked.has(room.id) ? 'BLOCKED'
                        : taken.has(room.id) ? 'BOOKED'
                            : total.lte(0) ? 'NO_PRICE'
                                : null;
            quoted.push({
                roomId: room.id,
                bookable: reason === null,
                reason,
                capacity: room.capacity,
                totalUsdc: Number(total.toFixed(8)),
                // Paying in the app: the price plus the Azaman fee, held
                // until check-in. payTotalUsdc is what the guest approves.
                feeUsdc: bookingEscrowFee(settings, round6(Number(total))).feeUsdc,
                payTotalUsdc: round6(round6(Number(total)) + bookingEscrowFee(settings, round6(Number(total))).feeUsdc),
                nightly: nightly.map((n) => ({ date: n.date, priceUsdc: Number(n.priceUsdc), source: n.source })),
            });
        }

        return res.status(200).json({
            success: true,
            checkIn: checkInDay.toISOString().slice(0, 10),
            checkOut: checkOutDay.toISOString().slice(0, 10),
            nights: nightsCount,
            guests,
            // Paid in the app from the wallet and held until the guest checks
            // in with their QR (POST .../reservations with payWith WALLET).
            payAt: 'APP',
            heldUntil: 'CHECK_IN',
            rooms: quoted,
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Could not price this stay. Try again.' });
    }
};

exports.createHotelReservation = async (req, res) => {
    const prisma = req.app.get('prisma');
    const { bizId } = req.params;
    const { checkInDate, checkOutDate, roomId, productId, partySize, customerNotes, payWith, expectedTotalUsdc } = req.body || {};
    const selectedRoomId = roomId || productId;

    // Paid from the wallet, held until check-in (stayPaymentService): one
    // transaction books, pays and confirms. The route's gates (active
    // account, KYC pay, Idempotency-Key, second factor) ran before this.
    if (payWith != null) {
        if (payWith !== 'WALLET') {
            return res.status(400).json({ success: false, code: 'UNSUPPORTED_PAYMENT_METHOD', message: `Unsupported payment method: ${payWith}.` });
        }
        try {
            const { bookPaidStay } = require('../services/stayPaymentService');
            const result = await bookPaidStay(prisma, {
                bizId,
                roomId: selectedRoomId,
                customerId: req.user.id,
                checkInDate,
                checkOutDate,
                partySize,
                customerNotes,
                expectedTotalUsdc: expectedTotalUsdc ?? null,
                clientRequestKey: req.get('idempotency-key'),
                financialOperation: res.locals?.financialOperation || null,
            });
            // The hotel hears of the new stay (best effort, post-commit).
            if (!result.replayed) {
                try {
                    const notifier = req.app.get('notificationService');
                    const owner = await prisma.businessProfile.findUnique({ where: { bizId }, select: { userId: true } });
                    if (notifier && owner && typeof notifier.sendNotification === 'function') {
                        await notifier.sendNotification({
                            userId: owner.userId,
                            title: 'New paid stay',
                            body: `${result.reservation.reservationRef}: paid in Azaman and held until the guest checks in with their QR.`,
                            category: 'MONEY',
                            actionPayload: { route: '/marketplace/business/checkin', reservationId: result.reservation.id },
                        });
                    }
                } catch (_) { /* the stay stands either way */ }
            }
            return res.status(result.replayed ? 200 : 201).json(result);
        } catch (err) {
            const status = err.code === 'INSUFFICIENT_BALANCE' ? 402 : (err.httpStatus || 400);
            return res.status(status).json({
                success: false,
                ...(typeof err.code === 'string' && !/^P\d{4}$/.test(err.code) ? { code: err.code } : {}),
                message: err.message,
            });
        }
    }

    if (!selectedRoomId) {
        return res.status(400).json({ success: false, message: 'roomId is required.' });
    }

    const checkInDay = startOfUtcDay(checkInDate);
    const checkOutDay = startOfUtcDay(checkOutDate);
    if (!checkInDay || !checkOutDay || checkOutDay <= checkInDay) {
        return res.status(400).json({ success: false, message: 'Check-out must be after check-in.' });
    }

    const business = await prisma.businessProfile.findUnique({
        where: { bizId },
        select: { id: true, bizId: true, category: true, isSuspended: true, isPausedByOwner: true },
    });
    if (!business || business.isSuspended) {
        return res.status(404).json({ success: false, message: 'Business not found.' });
    }
    if (business.isPausedByOwner) {
        return res.status(409).json({ success: false, message: 'This hotel is temporarily unavailable for new bookings.' });
    }
    if (business.category !== 'HOSPITALITY') {
        return res.status(409).json({ success: false, message: 'This business is not configured as a hotel.' });
    }

    const room = await prisma.hotelRoom.findFirst({
        where: { id: selectedRoomId, businessProfileId: business.id },
    });
    if (!room) return res.status(404).json({ success: false, message: 'Room not found.' });
    if (room.status !== 'AVAILABLE') {
        return res.status(409).json({ success: false, message: `Room ${room.roomNumber} is currently ${room.status.toLowerCase()}.` });
    }

    const guests = Math.max(parseInt(partySize, 10) || 1, 1);
    if (guests > room.capacity) {
        return res.status(409).json({ success: false, message: `Room ${room.roomNumber} accommodates up to ${room.capacity} guest${room.capacity === 1 ? '' : 's'}.` });
    }

    const block = await prisma.hotelRoomBlock.findFirst({
        where: {
            roomId: room.id,
            startDate: { lt: checkOutDay },
            endDate: { gt: checkInDay },
        },
        select: { id: true, reason: true },
    });
    if (block) {
        return res.status(409).json({ success: false, message: block.reason ? `Room unavailable: ${block.reason}` : 'Room is unavailable for those dates.' });
    }

    const nightlyRates = await findNightlyRates(prisma, room, checkInDay, checkOutDay);
    const total = nightlyRates.reduce((sum, night) => sum.add(night.priceUsdc), new Prisma.Decimal(0));

    if (total.lte(0)) {
        return res.status(409).json({ success: false, message: 'Room pricing is not configured.' });
    }

    // Delegate the actual Reservation creation to the existing canonical
    // reservation controller so lifecycle/conflict semantics remain centralized.
    req.body = {
        bizId,
        locationId: room.locationId || undefined,
        serviceItemId: room.id,
        startDatetime: checkInDay.toISOString(),
        endDatetime: checkOutDay.toISOString(),
        partySize: guests,
        amountUsdc: total.toFixed(8),
        depositUsdc: '0',
        customerNotes: customerNotes || undefined,
    };

    return reservationController.createReservation(req, res);
};
